#!/usr/bin/env node
/**
 * Deterministic B3 Editor finalization after all Researcher tasks returned ok.
 * Researcher owns business prose; this script only validates and assembles it:
 *   pending -> done, main summary block, report assembly, explore layout.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleReport } from "./assemble-report.mjs";
import { checkSessionLayout } from "./check-session-layout.mjs";
import {
  researcherReturnPaths,
  validateResearcherArtifacts,
} from "./researcher-return.mjs";

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function isObject(candidate) {
  return Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate);
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/**
 * Build an answer-first executive summary without repeating every detailed
 * Researcher finding. Current-contract R1 findings directly answer the user;
 * the assembled Researcher section remains the complete evidence narrative.
 * Legacy summaries keep their historical shape.
 */
export function executiveSummaryForTask(task, summary) {
  const findings = Array.isArray(summary?.findings) ? summary.findings : [];
  const requirements = new Map(
    (Array.isArray(task?.analysisRequirements) ? task.analysisRequirements : [])
      .filter((requirement) => isObject(requirement) && typeof requirement.id === "string")
      .map((requirement) => [requirement.id, requirement])
  );
  if (!findings.length || !requirements.size) {
    return {
      summary: compactText(summary?.summary),
      evidencePointers: Array.isArray(summary?.evidencePointers) ? summary.evidencePointers : [],
    };
  }
  const answerFindings = findings.filter((finding) => {
    const requirement = requirements.get(finding?.requirementId);
    return Array.isArray(requirement?.targetRubric) && requirement.targetRubric.includes("R1");
  });
  const selected = answerFindings.length ? answerFindings : findings.slice(0, 1);
  return {
    summary: selected.map((finding) => compactText(finding?.claim)).filter(Boolean).join(" "),
    evidencePointers: [...new Set(selected.flatMap((finding) =>
      Array.isArray(finding?.evidencePointers) ? finding.evidencePointers : []
    ))],
  };
}

export function researchSummaryBlock(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return [
      "## 核心结论",
      "",
      "<!-- html-report:research-summary:start -->",
      "_本次没有需要额外下钻的任务。_",
      "<!-- html-report:research-summary:end -->",
    ].join("\n");
  }
  const lines = [
    "## 核心结论",
    "",
    "<!-- html-report:research-summary:start -->",
  ];
  for (const item of items) {
    const goal = compactText(item.goal) || item.taskId;
    const summary = compactText(item.summary);
    const pointers = item.evidencePointers.map((pointer) => `\`${pointer}\``).join("、");
    lines.push(`- **${goal}**：${summary}`, `  证据：${pointers}`);
  }
  lines.push("<!-- html-report:research-summary:end -->");
  return lines.join("\n");
}

/** Remove Editor-only planning prose before assembling the user-facing report. */
export function removeInternalPlanningSections(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const output = [];
  let skipping = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (heading) {
      if (["待加深分析", "待加深"].includes(heading[1])) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) output.push(line);
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function replaceResearchSummary(main, items) {
  const source = String(main || "");
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## (?:待 B3 Researcher 结论|深度分析结论|核心结论)\s*$/.test(line.trim()));
  if (start < 0) {
    throw new Error("analysis/main.md missing exact B3 conclusion heading");
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const replacement = researchSummaryBlock(items).split("\n");
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

async function readJson(path, label) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(parsed)) throw new Error("must be one JSON object");
    return parsed;
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message || error}`);
  }
}

export async function finalizeResearchDocuments(sessionDir) {
  const session = resolve(sessionDir);
  const tasksPath = join(session, "analysis", "tasks.json");
  const mainPath = join(session, "analysis", "main.md");
  const document = await readJson(tasksPath, "analysis/tasks.json");
  if (Number(document.version) !== 2 || !Array.isArray(document.tasks)) {
    throw new Error("analysis/tasks.json must be a version 2 document with tasks[]");
  }
  const completed = [];
  for (const task of document.tasks) {
    const status = String(task?.status || "");
    if (!["pending", "done", "failed", "skipped"].includes(status)) {
      throw new Error(`task ${String(task?.id || "<missing>")} has unsupported status ${JSON.stringify(status)}`);
    }
    if (status === "failed" || status === "skipped") continue;
    const taskId = String(task?.id || "");
    const mode = String(task?.evidencePlan?.mode || "");
    const paths = researcherReturnPaths({ sessionDir: session, taskId });
    const summary = await readJson(paths.summaryPath, `Researcher summary for ${taskId}`);
    const checked = validateResearcherArtifacts(summary, { ...paths, mode, task });
    if (!checked.ok) {
      throw new Error(`Researcher artifacts for ${taskId} are invalid: ${checked.errors.join("; ")}`);
    }
    const executive = executiveSummaryForTask(task, summary);
    completed.push({
      taskId,
      goal: task.goal,
      summary: executive.summary,
      evidencePointers: executive.evidencePointers,
    });
    task.status = "done";
  }
  if (document.tasks.some((task) => task.status === "pending" || task.status === "running")) {
    throw new Error("all Researcher tasks must be terminal before finalization");
  }
  const round = Number.isSafeInteger(document.round) ? document.round : 0;
  const maxRounds = Number.isSafeInteger(document.maxRounds) ? document.maxRounds : 2;
  if (completed.length) document.round = Math.min(maxRounds, round + 1);

  const main = await readFile(mainPath, "utf8");
  const nextMain = replaceResearchSummary(removeInternalPlanningSections(main), completed);
  await writeFile(tasksPath, `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(mainPath, nextMain);
  return { tasksPath, mainPath, taskIds: completed.map((item) => item.taskId), round: document.round };
}

export async function finalizeResearchStage(resultPath) {
  const absResult = resolve(resultPath);
  const sessionDir = dirname(absResult);
  const result = await readJson(absResult, "result.json");
  if (result.status !== "confirmed") {
    throw new Error(`result.status must be confirmed, got ${JSON.stringify(result.status)}`);
  }
  const documents = await finalizeResearchDocuments(sessionDir);
  const assembled = await assembleReport(sessionDir);
  const layout = await checkSessionLayout(sessionDir, { phase: "explore" });
  if (!layout.ok) throw new Error(`explore layout failed: ${layout.errors.join("; ")}`);
  return {
    ok: true,
    producer: "finalize-research-stage.mjs",
    sessionDir,
    taskIds: documents.taskIds,
    round: documents.round,
    reportPath: assembled.reportPath,
    manifestPath: assembled.manifestPath,
    layout: { ok: true, phase: layout.phase, warnings: layout.warnings },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultPath = value("--result");
  if (!resultPath) {
    process.stderr.write("usage: finalize-research-stage.mjs --result <result.json>\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(await finalizeResearchStage(resultPath), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
