#!/usr/bin/env node
/**
 * Deterministic B2.5 Editor finalizer.
 *
 * The typed Editor Planner owns semantic decisions; editor-plan.mjs compiles
 * tasks.json/main.md before calling this script. This script performs the fixed
 * post-write sequence once:
 *   pending reuse evidence -> report assembly -> B2 layout.
 * qdm-harness owns the subsequent B25 stage-gate finish.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleReport } from "./assemble-report.mjs";
import { checkSessionLayout } from "./check-session-layout.mjs";
import { preparePendingReuseEvidence } from "./prepare-research-evidence.mjs";
import {
  ANALYSIS_CONTRACT_VERSION,
  validateResearcherAnalysisRequirements,
} from "./researcher-return.mjs";
import { readPipelineState } from "./stage-gate.mjs";

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function dependency(overrides, name, fallback) {
  return typeof overrides?.[name] === "function" ? overrides[name] : fallback;
}

function assertRunningEditorGate(state) {
  const stage = state?.stages?.B25_EDITOR;
  if (
    state?.currentStage !== "B25_EDITOR" ||
    state?.status !== "running" ||
    stage?.status !== "running"
  ) {
    throw new Error(
      `B25_EDITOR must be running before finalization; current=${String(state?.currentStage || "<missing>")} ` +
      `pipeline=${String(state?.status || "<missing>")} stage=${String(stage?.status || "<missing>")}`
    );
  }
}

/**
 * Mark tasks materialized in the current B2.5 run as the structured analysis
 * contract. Missing markers remain meaningful only for already-persisted
 * legacy Sessions that do not re-enter this finalizer.
 */
export function stampAnalysisContractDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      Number(document.version) !== 2 || !Array.isArray(document.tasks)) {
    throw new Error("analysis/tasks.json must be a version 2 document with tasks[]");
  }
  const tasks = document.tasks.map((task, index) => {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new Error(`analysis/tasks.json tasks[${index}] must be an object`);
    }
    const stamped = { ...task, analysisContractVersion: ANALYSIS_CONTRACT_VERSION };
    const checked = validateResearcherAnalysisRequirements(stamped);
    if (!checked.ok) {
      throw new Error(
        `task ${String(task.id || `<index:${index}>`)} analysis contract is invalid: ${checked.errors.join("; ")}`
      );
    }
    return stamped;
  });
  return { ...document, tasks };
}

export async function stampAnalysisContractTasks(sessionDir) {
  const tasksPath = join(resolve(sessionDir), "analysis", "tasks.json");
  let document;
  try {
    document = JSON.parse(await readFile(tasksPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read valid analysis/tasks.json: ${error.message || error}`);
  }
  const stamped = stampAnalysisContractDocument(document);
  await writeFile(tasksPath, `${JSON.stringify(stamped, null, 2)}\n`);
  return {
    tasksPath,
    analysisContractVersion: ANALYSIS_CONTRACT_VERSION,
    taskCount: stamped.tasks.length,
  };
}

export async function finalizeEditorStage(resultPath, overrides = {}) {
  const absResult = resolve(String(resultPath || ""));
  const sessionDir = dirname(absResult);
  const readState = dependency(overrides, "readPipelineState", readPipelineState);
  const prepareEvidence = dependency(
    overrides,
    "preparePendingReuseEvidence",
    preparePendingReuseEvidence
  );
  const assemble = dependency(overrides, "assembleReport", assembleReport);
  const checkLayout = dependency(overrides, "checkSessionLayout", checkSessionLayout);
  const stampContract = dependency(
    overrides,
    "stampAnalysisContractTasks",
    stampAnalysisContractTasks
  );

  assertRunningEditorGate(await readState(sessionDir));
  const analysisContract = await stampContract(sessionDir);
  const evidence = await prepareEvidence(absResult);
  const assembled = await assemble(sessionDir);
  const layout = await checkLayout(sessionDir, { phase: "b2" });
  if (layout?.ok !== true) {
    const errors = Array.isArray(layout?.errors) && layout.errors.length
      ? layout.errors.join("; ")
      : "unknown layout failure";
    throw new Error(`b2 layout failed: ${errors}`);
  }

  return {
    ok: true,
    producer: "finalize-editor-stage.mjs",
    sessionDir,
    analysisContract,
    evidence,
    reportPath: assembled.reportPath,
    manifestPath: assembled.manifestPath,
    layout: {
      ok: true,
      phase: layout.phase,
      warnings: Array.isArray(layout.warnings) ? layout.warnings : [],
    },
    nextAction: "stage_gate_finish_B25_EDITOR",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultPath = value("--result");
  if (!resultPath || argv.length !== 2) {
    process.stderr.write("usage: finalize-editor-stage.mjs --result <result.json>\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(await finalizeEditorStage(resultPath), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
