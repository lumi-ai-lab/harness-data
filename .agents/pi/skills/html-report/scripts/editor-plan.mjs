#!/usr/bin/env node
/** Deterministically materialize a validated B2.5 semantic plan and finalize it. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileEditorArtifacts,
  loadEditorPlannerInput,
  normalizeEditorPlan,
  validateEditorPlan,
} from "./editor-plan-contract.mjs";
import { finalizeEditorStage } from "./finalize-editor-stage.mjs";

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function dependency(overrides, name, fallback) {
  return typeof overrides?.[name] === "function" ? overrides[name] : fallback;
}

function buildResearchTasks(tasks, evidence, sessionDir) {
  const prepared = new Map(
    (Array.isArray(evidence?.prepared) ? evidence.prepared : [])
      .map((item) => [String(item?.taskId || ""), item])
  );
  const deferred = new Set(
    (Array.isArray(evidence?.deferred) ? evidence.deferred : [])
      .map((item) => String(item?.taskId || ""))
  );
  return tasks
    .filter((task) => task?.status === "pending")
    .map((task) => {
      const mode = String(task?.evidencePlan?.mode || "");
      if (mode === "reuse_entry") {
        const item = prepared.get(String(task.id));
        if (!item || typeof item.evidencePath !== "string" || !item.evidencePath) {
          throw new Error(`finalizer did not return prepared evidence for reuse task ${String(task.id)}`);
        }
        return { task, evidencePath: item.evidencePath };
      }
      if (mode === "new_query") {
        if (!deferred.has(String(task.id))) {
          throw new Error(`finalizer did not defer new-query task ${String(task.id)}`);
        }
        return {
          task,
          evidencePath: join(sessionDir, "analysis", "evidence", `${task.id}.json`),
        };
      }
      throw new Error(`materialized task ${String(task?.id || "<missing>")} has invalid evidence mode`);
    });
}

/**
 * Validate before the first write, compile both artifacts in memory, commit
 * them atomically per file, then reuse the existing deterministic finalizer.
 */
export async function materializeEditorPlan(resultPath, plan, overrides = {}) {
  const absResult = resolve(String(resultPath || ""));
  const sessionDir = dirname(absResult);
  const loadInput = dependency(overrides, "loadEditorPlannerInput", loadEditorPlannerInput);
  const finalize = dependency(overrides, "finalizeEditorStage", finalizeEditorStage);
  const writeArtifact = dependency(overrides, "atomicWrite", atomicWrite);
  const input = overrides.input || loadInput(absResult);
  const canonicalPlan = normalizeEditorPlan(plan);
  const checked = validateEditorPlan(canonicalPlan, input);
  if (!checked.ok) {
    throw new Error(`Editor Planner return is invalid: ${checked.errors.join("; ")}`);
  }
  const artifacts = compileEditorArtifacts(canonicalPlan, input);
  const analysisDir = join(sessionDir, "analysis");
  const tasksPath = join(analysisDir, "tasks.json");
  const mainPath = join(analysisDir, "main.md");
  await mkdir(analysisDir, { recursive: true });
  await Promise.all([
    writeArtifact(tasksPath, `${JSON.stringify(artifacts.tasks, null, 2)}\n`),
    writeArtifact(mainPath, artifacts.main),
  ]);
  const finalized = await finalize(absResult, overrides.finalizerOverrides || {});
  // The finalizer stamps the persisted tasks with the current Researcher
  // analysis contract. Build the parent handoff from those canonical bytes,
  // never from the pre-stamp in-memory compiler result: B3 compares the full
  // task object against tasks.json before dispatch.
  let persistedTasks;
  try {
    const persisted = JSON.parse(await readFile(tasksPath, "utf8"));
    if (!persisted || typeof persisted !== "object" || Array.isArray(persisted) ||
        Number(persisted.version) !== 2 || !Array.isArray(persisted.tasks)) {
      throw new Error("expected a version 2 document with tasks[]");
    }
    persistedTasks = persisted.tasks;
  } catch (error) {
    throw new Error(`cannot load canonical finalized tasks: ${error.message || error}`);
  }
  const researchTasks = buildResearchTasks(persistedTasks, finalized?.evidence, sessionDir);
  return {
    ok: true,
    producer: "editor-plan.mjs",
    sessionDir,
    tasksPath,
    mainPath,
    taskCount: persistedTasks.length,
    researchTasks,
    finalized,
  };
}

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const resultPath = value(argv, "--result");
  const planFile = value(argv, "--plan-file");
  if (!resultPath || !planFile || argv.length !== 4) {
    process.stderr.write("usage: editor-plan.mjs --result <result.json> --plan-file <editor-plan.json>\n");
    process.exit(2);
  }
  try {
    const plan = JSON.parse(await readFile(resolve(planFile), "utf8"));
    process.stdout.write(`${JSON.stringify(await materializeEditorPlan(resultPath, plan), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
