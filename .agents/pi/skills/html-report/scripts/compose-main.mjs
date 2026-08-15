#!/usr/bin/env node
/**
 * Compose the first analysis/main.md from Writer entry tables.
 *
 * Usage:
 *   node compose-main.mjs --result <result.json>
 *   node compose-main.mjs --session-dir <SESSION>
 *
 * Reads result.json card order, each data/cards/<id>/entry.json, and
 * caption.md, verifies entry.meta.json, then atomically writes analysis/main.md.
 * Does not invent analysis, read the user question, or call a CLI.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRows, rowsToMarkdown } from "./assemble-report.mjs";
import { rowsSha256 } from "./fetch-entry.mjs";
import { metricQueryFromCard } from "./metric-query-contract.mjs";
import { sanitizeCardId, writerReturnPaths } from "./writer-return.mjs";

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function titleForCard(card, cardId) {
  return String(card?.title || card?.id || cardId || "数据明细").trim();
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw new Error(`cannot read ${label}: ${error.message || error}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message || error}`);
  }
}

async function loadConfirmedResult(sessionDir) {
  const resultPath = join(sessionDir, "result.json");
  const result = await readJson(resultPath, "result.json");
  if (!isPlainObject(result) || result.status !== "confirmed") {
    throw new Error(`result.status must be confirmed, got ${JSON.stringify(result?.status)}`);
  }
  if (!Array.isArray(result.cards) || result.cards.length === 0) {
    throw new Error("result.json must contain a non-empty cards[]");
  }
  return result;
}

async function loadVerifiedCardTable(sessionDir, card, index) {
  if (!isPlainObject(card) || typeof card.id !== "string" || !card.id.trim()) {
    throw new Error(`result.cards[${index}] is missing a non-empty id`);
  }
  const cardId = sanitizeCardId(card.id);
  const paths = writerReturnPaths({ sessionDir, cardId: card.id });
  const payload = await readJson(paths.dataPath, `entry.json for card ${cardId}`);
  const meta = await readJson(paths.metaPath, `entry.meta.json for card ${cardId}`);
  const rows = extractRows(payload);
  if (!isPlainObject(meta) || Array.isArray(meta)) {
    throw new Error(`entry.meta.json for card ${cardId} must be an object`);
  }
  if (!Number.isSafeInteger(meta.rowCount) || meta.rowCount < 0) {
    throw new Error(`entry.meta.json for card ${cardId} is missing a valid rowCount`);
  }
  if (meta.rowCount !== rows.length) {
    throw new Error(`entry.meta.json rowCount does not match entry.json for card ${cardId}`);
  }
  if (typeof meta.rowsSha256 !== "string" || !/^[a-f0-9]{64}$/.test(meta.rowsSha256)) {
    throw new Error(`entry.meta.json for card ${cardId} is missing a valid rowsSha256`);
  }
  const computed = rowsSha256(rows);
  if (meta.rowsSha256 !== computed) {
    throw new Error(`entry.meta.json rowsSha256 does not match entry.json for card ${cardId}`);
  }
  let columnLabels = {};
  try {
    columnLabels = await readJson(paths.columnMetaPath, `entry.column-meta.json for card ${cardId}`);
    if (!isPlainObject(columnLabels)) columnLabels = {};
  } catch { /* optional */ }
  let cardDimensions = [];
  try { cardDimensions = metricQueryFromCard(card).dimensions || []; } catch { /* card query unreadable */ }
  const table = rowsToMarkdown(rows, { columnLabels, dimensions: cardDimensions });
  let caption = "";
  try {
    caption = (await readFile(paths.captionPath, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`caption.md for card ${cardId} is missing: ${paths.captionPath}`);
    }
    throw new Error(`cannot read caption.md for card ${cardId}: ${error.message || error}`);
  }
  if (!caption) {
    throw new Error(`caption.md for card ${cardId} is empty`);
  }
  return {
    cardId,
    title: titleForCard(card, cardId),
    rowCount: rows.length,
    markdown: table.markdown || "_本次查询返回 0 行明细。_",
    caption,
  };
}

export function renderFirstMain(result, tables) {
  const title = String(result?.title || "分析报告").trim() || "分析报告";
  const sections = tables.map((table) => [
    `## ${table.title}`,
    "",
    `<!-- html-report:full-table card="${table.cardId}" rows="${table.rowCount}" -->`,
    "",
    table.markdown,
    "",
    "### 分析",
    "",
    table.caption,
  ].join("\n"));
  return [`# ${title}`, "", ...sections].join("\n\n") + "\n";
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function composeMain(sessionDir) {
  const abs = resolve(String(sessionDir || ""));
  const result = await loadConfirmedResult(abs);
  const tables = [];
  for (const [index, card] of result.cards.entries()) {
    tables.push(await loadVerifiedCardTable(abs, card, index));
  }
  const mainPath = join(abs, "analysis", "main.md");
  await atomicWrite(mainPath, renderFirstMain(result, tables));
  return {
    ok: true,
    producer: "compose-main.mjs",
    sessionDir: abs,
    mainPath,
    cardIds: tables.map((table) => table.cardId),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir || argv.length > 2) {
    process.stderr.write("usage: compose-main.mjs --result <result.json> | --session-dir <SESSION>\n");
    process.exit(2);
  }
  try {
    const output = await composeMain(sessionDir);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
