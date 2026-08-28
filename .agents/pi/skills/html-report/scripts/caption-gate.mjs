#!/usr/bin/env node
/**
 * Caption gate lifecycle manager.
 *
 * After all Report Writers complete, this script scans per-card violation
 * files, aggregates them into caption-gate.json, and supports an interactive
 * waive/revalidate loop before finishing B2_WRITER and starting B2_MAIN.
 *
 * Usage:
 *   node caption-gate.mjs --check      --session-dir <SESSION>
 *   node caption-gate.mjs --waive      --session-dir <SESSION> --card-id <ID>
 *   node caption-gate.mjs --revalidate --session-dir <SESSION> --card-id <ID>
 *   node caption-gate.mjs --status    --session-dir <SESSION>
 *   node caption-gate.mjs --finish     --session-dir <SESSION>
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  sanitizeCardId,
  writerReturnPathsForResult,
} from "./writer-return.mjs";
import {
  violationsPathFor,
  loadCaptionEvidence,
  revalidateCaptionMarkdown,
} from "./submit-card-caption.mjs";

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)));
const stageGateScript = join(scriptDir, "stage-gate.mjs");
const composeMainScript = join(scriptDir, "compose-main.mjs");

const GATE_PRODUCER = "caption-gate.mjs";
const GATE_FILENAME = "caption-gate.json";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`cannot read ${label}: ${error.message || error}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message || error}`);
  }
}

async function loadConfirmedResult(sessionDir) {
  const resultPath = join(resolve(sessionDir), "result.json");
  const result = await readJson(resultPath, "result.json");
  if (!result || result.status !== "confirmed" || !Array.isArray(result.cards) || !result.cards.length) {
    throw new Error("result.json must be confirmed and contain a non-empty cards[]");
  }
  return { result, resultPath };
}

function cardDirsFromResult(result, resultPath) {
  const sessionDir = dirname(resolve(resultPath));
  const dirs = [];
  for (const card of result.cards) {
    if (!isPlainObject(card) || typeof card.id !== "string" || !card.id.trim()) continue;
    const paths = writerReturnPathsForResult({ resultPath, cardId: card.id });
    dirs.push({
      cardId: card.id,
      cardDir: dirname(paths.dataPath),
      captionPath: paths.captionPath,
      evidencePath: paths.evidencePath,
      violationsPath: violationsPathFor(paths.captionPath),
    });
  }
  return dirs;
}

function gateFilePath(sessionDir) {
  return join(resolve(sessionDir), "data", GATE_FILENAME);
}

async function loadGateFile(sessionDir) {
  return readJson(gateFilePath(sessionDir), "caption-gate.json");
}

async function writeGateFile(sessionDir, data) {
  const path = gateFilePath(sessionDir);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temp, path);
}

function nowIso() {
  return new Date().toISOString();
}

async function readViolationsForCard(cardInfo) {
  if (!existsSync(cardInfo.violationsPath)) return [];
  const data = await readJson(cardInfo.violationsPath, `violations for ${cardInfo.cardId}`);
  if (!data || !Array.isArray(data.violations)) return [];
  return data.violations;
}

/** --check: scan all cards, write caption-gate.json, print summary. */
async function cmdCheck(sessionDir) {
  const { result, resultPath } = await loadConfirmedResult(sessionDir);
  const cardDirs = cardDirsFromResult(result, resultPath);
  const cards = [];
  let totalViolations = 0;
  for (const cd of cardDirs) {
    const violations = await readViolationsForCard(cd);
    totalViolations += violations.length;
    cards.push({
      cardId: cd.cardId,
      status: violations.length === 0 ? "resolved" : "pending",
      violationCount: violations.length,
      violations,
      captionPath: cd.captionPath,
      evidencePath: cd.evidencePath,
    });
  }
  const gateData = {
    producer: GATE_PRODUCER,
    sessionDir: resolve(sessionDir),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    totalViolations,
    cards,
  };
  await writeGateFile(sessionDir, gateData);
  return gateData;
}

/** --waive: mark a card's violations as waived. */
async function cmdWaive(sessionDir, cardId) {
  const gate = await loadGateFile(sessionDir);
  if (!gate) throw new Error("caption-gate.json not found; run --check first");
  const card = gate.cards.find((c) => c.cardId === cardId);
  if (!card) throw new Error(`cardId ${cardId} not found in caption-gate.json`);
  card.status = "waived";
  card.waivedAt = nowIso();
  gate.updatedAt = nowIso();
  await writeGateFile(sessionDir, gate);
  return gate;
}

/** --revalidate: re-read caption.md, re-validate against evidence, update gate. */
async function cmdRevalidate(sessionDir, cardId) {
  const gate = await loadGateFile(sessionDir);
  if (!gate) throw new Error("caption-gate.json not found; run --check first");
  const card = gate.cards.find((c) => c.cardId === cardId);
  if (!card) throw new Error(`cardId ${cardId} not found in caption-gate.json`);
  const evidence = await loadCaptionEvidence(card.evidencePath);
  let markdown = "";
  try {
    markdown = await readFile(card.captionPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read caption.md for ${cardId}: ${error.message || error}`);
  }
  const result = revalidateCaptionMarkdown(markdown, evidence);
  card.violations = result.violations;
  card.violationCount = result.violations.length;
  card.status = result.violations.length === 0 ? "resolved" : "pending";
  if (card.status === "resolved") card.resolvedAt = nowIso();
  gate.updatedAt = nowIso();
  gate.totalViolations = gate.cards.reduce((sum, c) => sum + (c.violationCount || 0), 0);
  await writeGateFile(sessionDir, gate);
  return gate;
}

/** --status: print unresolved violations. */
async function cmdStatus(sessionDir) {
  const gate = await loadGateFile(sessionDir);
  if (!gate) {
    return { exists: false, message: "caption-gate.json 不存在；请先运行 --check" };
  }
  const pending = gate.cards.filter((c) => c.status === "pending");
  const waived = gate.cards.filter((c) => c.status === "waived");
  const resolved = gate.cards.filter((c) => c.status === "resolved");
  return {
    exists: true,
    totalCards: gate.cards.length,
    pending: pending.length,
    waived: waived.length,
    resolved: resolved.length,
    totalViolations: gate.totalViolations,
    pendingCards: pending.map((c) => ({ cardId: c.cardId, violationCount: c.violationCount })),
  };
}

function runStageGate(sessionDir, operation, extraArgs = []) {
  const result = spawnSync(process.execPath, [
    stageGateScript, operation,
    "--session-dir", resolve(sessionDir),
    ...extraArgs,
  ], { encoding: "utf8", cwd: resolve(sessionDir) });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`stage-gate ${operation} failed: ${stderr}`);
  }
  try {
    return JSON.parse(result.stdout || "null");
  } catch {
    return { ok: true, message: (result.stdout || "").trim() };
  }
}

function runComposeMain(sessionDir) {
  const result = spawnSync(process.execPath, [
    composeMainScript, "--session-dir", resolve(sessionDir),
  ], { encoding: "utf8", cwd: resolve(sessionDir) });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`compose-main.mjs failed: ${stderr}`);
  }
}

/** --finish: check all resolved, then finish B2_WRITER + compose-main + finish B2_MAIN. */
async function cmdFinish(sessionDir) {
  const gate = await loadGateFile(sessionDir);
  if (!gate) throw new Error("caption-gate.json not found; run --check first");
  const unresolved = gate.cards.filter((c) => c.status === "pending");
  if (unresolved.length > 0) {
    const ids = unresolved.map((c) => c.cardId).join(", ");
    throw new Error(`仍有 ${unresolved.length} 张卡未处理（${ids}）；请先 --waive 或 --revalidate`);
  }
  const step1 = runStageGate(sessionDir, "finish", ["--stage", "B2_WRITER", "--format", "text"]);
  runComposeMain(sessionDir);
  const step3 = runStageGate(sessionDir, "finish", ["--stage", "B2_MAIN", "--format", "text"]);
  const message = step3?.message || step3?.state?.message || "B2_MAIN completed";
  return { finished: true, message };
}

function formatCheckOutput(gate) {
  if (gate.totalViolations === 0) {
    return "caption gate: 全部卡片校验通过，无违规。";
  }
  const lines = [`B2 caption gate: ${gate.totalViolations} 条违规 / ${gate.cards.filter((c) => c.violationCount > 0).length} 张卡`];
  for (const card of gate.cards) {
    if (!card.violations?.length) continue;
    lines.push(`\nCard "${card.cardId}" (${card.violations.length} 条违规):`);
    card.violations.forEach((v, i) => {
      const num = `${i + 1}`;
      lines.push(`  ${num}. ${v.rule} — ${v.ruleName}`);
      lines.push(`     触发值: "${v.trigger}"`);
      if (v.paragraphIndex >= 0) {
        lines.push(`     出处: paragraphs[${v.paragraphIndex}]${v.paragraphSnippet ? ` "${v.paragraphSnippet}"` : ""}`);
      }
    });
  }
  lines.push("\n请逐卡审查以上违规，告知哪些可以放行、哪些需要修改。");
  lines.push("- 放行：回复卡 ID");
  lines.push("- 修改：直接告知修改内容，我会编辑 caption.md 并重新校验");
  lines.push("全部处理完毕后，我会执行 caption-gate --finish 继续 B2_MAIN。");
  return lines.join("\n");
}

function formatStatusOutput(status) {
  if (!status.exists) return status.message;
  const lines = [
    `caption gate 状态：${status.totalCards} 张卡，${status.totalViolations} 条违规`,
    `  pending: ${status.pending}  waived: ${status.waived}  resolved: ${status.resolved}`,
  ];
  if (status.pendingCards?.length) {
    lines.push("  未处理卡：" + status.pendingCards.map((c) => `${c.cardId}(${c.violationCount})`).join(", "));
  }
  return lines.join("\n");
}

async function runCli() {
  const sessionDir = value("--session-dir") || value("--result");
  if (!sessionDir) {
    process.stderr.write("usage: caption-gate.mjs <command> --session-dir <SESSION>\n");
    process.stderr.write("commands: --check | --waive --card-id <ID> | --revalidate --card-id <ID> | --status | --finish\n");
    process.exit(2);
  }
  const absSession = resolve(sessionDir.replace(/result\.json$/, ""));
  try {
    if (argv.includes("--check")) {
      const gate = await cmdCheck(absSession);
      process.stdout.write(`${formatCheckOutput(gate)}\n`);
    } else if (argv.includes("--waive")) {
      const cardId = value("--card-id");
      if (!cardId) throw new Error("--card-id is required for --waive");
      const gate = await cmdWaive(absSession, cardId);
      process.stdout.write(`已放行 cardId=${cardId}（${gate.cards.find((c) => c.cardId === cardId)?.violationCount || 0} 条违规）\n`);
    } else if (argv.includes("--revalidate")) {
      const cardId = value("--card-id");
      if (!cardId) throw new Error("--card-id is required for --revalidate");
      const gate = await cmdRevalidate(absSession, cardId);
      const card = gate.cards.find((c) => c.cardId === cardId);
      if (card.status === "resolved") {
        process.stdout.write(`cardId=${cardId} 重新校验通过，${card.violationCount} 条违规\n`);
      } else {
        process.stdout.write(`cardId=${cardId} 仍有 ${card.violationCount} 条违规：\n`);
        for (const v of card.violations) {
          process.stdout.write(`  ${v.rule} — ${v.ruleName}  触发值: "${v.trigger}"\n`);
        }
      }
    } else if (argv.includes("--status")) {
      const status = await cmdStatus(absSession);
      process.stdout.write(`${formatStatusOutput(status)}\n`);
    } else if (argv.includes("--finish")) {
      const result = await cmdFinish(absSession);
      process.stdout.write(`${result.message}\n`);
    } else {
      process.stderr.write("unknown command; use --check | --waive | --revalidate | --status | --finish\n");
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}

export { cmdCheck, cmdWaive, cmdRevalidate, cmdStatus, cmdFinish };
