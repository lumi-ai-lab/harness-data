#!/usr/bin/env node
/**
 * Persistent stage gate and timing ledger for html-report sessions.
 *
 * State is stored at:
 *   $SESSION/debug/pipeline-state.json
 *
 * CLI:
 *   node stage-gate.mjs init    --session-dir <SESSION> [--mode step|auto]
 *   node stage-gate.mjs start   --session-dir <SESSION> --stage <STAGE>
 *   node stage-gate.mjs finish  --session-dir <SESSION> --stage <STAGE>
 *   node stage-gate.mjs fail    --session-dir <SESSION> --stage <STAGE> --reason <TEXT>
 *   node stage-gate.mjs approve --session-dir <SESSION> [--phrase <TEXT>]
 *   node stage-gate.mjs status  --session-dir <SESSION>
 *   node stage-gate.mjs retry   --session-dir <SESSION> [--phrase <TEXT>]
 *   node stage-gate.mjs resume  --session-dir <SESSION> [--mode step|auto]
 *
 * Tests may inject a deterministic clock with the exported functions' `now`
 * option or the CLI's --now argument. Human waits and paused intervals never
 * contribute to executionDurationMs.
 */
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PIPELINE_STATE_VERSION = 1;
export const PIPELINE_STATE_PRODUCER = "stage-gate.mjs";

export const STAGE_ORDER = Object.freeze([
  "A_CONFIG",
  "B0_PREFLIGHT",
  "B2_WRITER",
  "B2_MAIN",
  "B25_EDITOR",
  "B3_RESEARCH",
  "B4_REVIEW",
  "B5_DESIGN",
]);

export const STAGE_DEFINITIONS = Object.freeze({
  A_CONFIG: {
    id: "A_CONFIG",
    label: "A Config",
    gateLabel: "A Config",
    nextLabel: "B0 Preflight",
    approvalRequired: true,
    humanGate: "A_CONFIG",
    enabled: true,
    gate: true,
  },
  B0_PREFLIGHT: {
    id: "B0_PREFLIGHT",
    label: "B0 Preflight",
    gateLabel: "B0 Preflight",
    nextLabel: "B2 Writer",
    approvalRequired: true,
    humanGate: "B0_PREFLIGHT",
    enabled: true,
    gate: true,
  },
  B2_WRITER: {
    id: "B2_WRITER",
    label: "B2 Writer",
    gateLabel: "B2 Writer",
    nextLabel: "B2 Main",
    approvalRequired: false,
    humanGate: "B2_WRITER",
    enabled: true,
    gate: false,
  },
  B2_MAIN: {
    id: "B2_MAIN",
    label: "B2 Main",
    gateLabel: "B2 Main",
    nextLabel: "已完成",
    approvalRequired: true,
    humanGate: "B2_MAIN",
    enabled: true,
    gate: true,
  },
  B25_EDITOR: {
    id: "B25_EDITOR",
    label: "B2.5 Editor",
    gateLabel: "B2.5 Editor",
    nextLabel: "B3.5 Researcher",
    approvalRequired: false,
    humanGate: "B3_RESEARCH",
    internal: true,
    enabled: false,
    gate: false,
  },
  B3_RESEARCH: {
    id: "B3_RESEARCH",
    label: "B3.5 Researcher",
    gateLabel: "B3 Research",
    nextLabel: "B4 Review",
    approvalRequired: true,
    humanGate: "B3_RESEARCH",
    enabled: false,
    gate: true,
  },
  B4_REVIEW: {
    id: "B4_REVIEW",
    label: "B4 Review",
    gateLabel: "B4 Review",
    nextLabel: "B5 Design",
    approvalRequired: true,
    humanGate: "B4_REVIEW",
    enabled: false,
    gate: true,
  },
  B5_DESIGN: {
    id: "B5_DESIGN",
    label: "B5 Design",
    gateLabel: "B5 Design",
    nextLabel: "已完成",
    approvalRequired: false,
    humanGate: "B5_DESIGN",
    enabled: false,
    gate: false,
  },
});

/** Old A→B5 path for tests that still cover Planner / Researcher / Reviewer. */
export const LEGACY_STAGE_POLICY = Object.freeze({
  B2_WRITER: { enabled: true, gate: true },
  B2_MAIN: { enabled: false },
  B25_EDITOR: { enabled: true, gate: false },
  B3_RESEARCH: { enabled: true, gate: true },
  B4_REVIEW: { enabled: true, gate: true },
  B5_DESIGN: { enabled: true, gate: false },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveStagePolicy(state, stageId) {
  const definition = stageDefinition(stageId);
  const override = isPlainObject(state?.policy) ? state.policy[stageId] : null;
  const enabled = override && typeof override.enabled === "boolean"
    ? override.enabled
    : definition.enabled !== false;
  const gate = override && typeof override.gate === "boolean"
    ? override.gate
    : definition.gate === true || definition.approvalRequired === true;
  return { enabled, gate };
}

export function nextEnabledStage(state, stageId) {
  const index = STAGE_ORDER.indexOf(stageId);
  if (index < 0) return null;
  for (let cursor = index + 1; cursor < STAGE_ORDER.length; cursor += 1) {
    const candidate = STAGE_ORDER[cursor];
    if (resolveStagePolicy(state, candidate).enabled) return candidate;
  }
  return null;
}

function nextStageLabel(state, stageId) {
  const next = nextEnabledStage(state, stageId);
  return next ? stageDefinition(next).gateLabel : "已完成";
}

function stageDefinition(stageId) {
  const definition = STAGE_DEFINITIONS[stageId];
  if (!definition) {
    throw new Error(`unknown stage ${JSON.stringify(stageId)}; allowed: ${STAGE_ORDER.join(", ")}`);
  }
  return definition;
}

function normalizeMode(mode) {
  const value = String(mode || "step").trim().toLowerCase();
  if (value !== "step" && value !== "auto") {
    throw new Error(`mode must be step or auto, got ${JSON.stringify(mode)}`);
  }
  return value;
}

function nowIso(now) {
  const raw = typeof now === "function" ? now() : now;
  const date = raw === undefined ? new Date() : raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid clock value: ${JSON.stringify(raw)}`);
  return date.toISOString();
}

function durationBetween(startedAt, endedAt) {
  if (!startedAt || !endedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function sumIntervals(intervals, currentAt, startKey = "startedAt", endKey = "endedAt") {
  return (Array.isArray(intervals) ? intervals : []).reduce((total, interval) => {
    const end = interval?.[endKey] || currentAt;
    return total + durationBetween(interval?.[startKey], end);
  }, 0);
}

function activeAttempt(stage) {
  return Array.isArray(stage?.attempts) ? stage.attempts.at(-1) : null;
}

function recalculateAttempt(attempt, at) {
  attempt.executionDurationMs = sumIntervals(attempt.executionIntervals, at);
  attempt.pausedDurationMs = sumIntervals(attempt.pauses, at, "pausedAt", "resumedAt");
  return attempt;
}

function recalculateStage(stage, at) {
  for (const attempt of stage.attempts || []) recalculateAttempt(attempt, at);
  stage.executionDurationMs = (stage.attempts || []).reduce(
    (total, attempt) => total + Number(attempt.executionDurationMs || 0),
    0
  );
  stage.gateWaitingDurationMs = sumIntervals(
    stage.waits,
    at,
    "startedAt",
    "endedAt"
  );
  stage.pausedDurationMs = (stage.attempts || []).reduce(
    (total, attempt) => total + Number(attempt.pausedDurationMs || 0),
    0
  );
  stage.humanWaitingDurationMs = stage.gateWaitingDurationMs + stage.pausedDurationMs;
  return stage;
}

function updateTotals(state, at) {
  for (const stage of Object.values(state.stages || {})) recalculateStage(stage, at);
  state.cumulativeExecutionDurationMs = Object.values(state.stages || {}).reduce(
    (total, stage) => total + Number(stage.executionDurationMs || 0),
    0
  );
  state.cumulativeHumanWaitingDurationMs = Object.values(state.stages || {}).reduce(
    (total, stage) => total + Number(stage.humanWaitingDurationMs || 0),
    0
  );
  return state;
}

function snapshot(state, at = nowIso()) {
  const copy = structuredClone(state);
  updateTotals(copy, at);
  copy.observedAt = at;
  return copy;
}

function makeStage(stageId, at) {
  const definition = stageDefinition(stageId);
  return {
    id: stageId,
    label: definition.label,
    humanGate: definition.humanGate,
    internal: definition.internal === true,
    approvalRequired: definition.approvalRequired === true,
    status: "paused",
    createdAt: at,
    startedAt: null,
    completedAt: null,
    approvedAt: null,
    failedAt: null,
    failureReason: null,
    attempts: [],
    waits: [],
    executionDurationMs: 0,
    gateWaitingDurationMs: 0,
    pausedDurationMs: 0,
    humanWaitingDurationMs: 0,
  };
}

function makeAttempt(stage, at, { retryOf = null } = {}) {
  const attempt = {
    number: stage.attempts.length + 1,
    retryOf,
    status: "running",
    startedAt: at,
    endedAt: null,
    failedAt: null,
    failureReason: null,
    executionIntervals: [{ startedAt: at, endedAt: null }],
    pauses: [],
    executionDurationMs: 0,
    pausedDurationMs: 0,
  };
  if (stage.id === "B2_WRITER") attempt.startupStatusRequired = true;
  stage.attempts.push(attempt);
  stage.startedAt ||= at;
  stage.status = "running";
  return attempt;
}

function closeExecution(stage, at) {
  const attempt = activeAttempt(stage);
  if (!attempt) return;
  const interval = (attempt.executionIntervals || []).at(-1);
  if (interval && !interval.endedAt) interval.endedAt = at;
  recalculateAttempt(attempt, at);
}

function closePause(stage, at) {
  const attempt = activeAttempt(stage);
  const pause = (attempt?.pauses || []).at(-1);
  if (pause && !pause.resumedAt) {
    pause.resumedAt = at;
    pause.durationMs = durationBetween(pause.pausedAt, pause.resumedAt);
  }
}

function openExecution(stage, at) {
  const attempt = activeAttempt(stage);
  if (!attempt) return makeAttempt(stage, at);
  const interval = (attempt.executionIntervals || []).at(-1);
  if (!interval || interval.endedAt) {
    attempt.executionIntervals ||= [];
    attempt.executionIntervals.push({ startedAt: at, endedAt: null });
  }
  attempt.status = "running";
  stage.status = "running";
  return attempt;
}

function openWait(stage, kind, at, details = {}) {
  stage.waits ||= [];
  const current = stage.waits.at(-1);
  if (current && !current.endedAt && current.kind === kind) return current;
  const wait = { kind, startedAt: at, endedAt: null, durationMs: 0, ...details };
  stage.waits.push(wait);
  return wait;
}

function closeWait(stage, at) {
  const wait = (stage.waits || []).at(-1);
  if (!wait || wait.endedAt) return;
  wait.endedAt = at;
  wait.durationMs = durationBetween(wait.startedAt, wait.endedAt);
}

function resultPathFor(sessionDir) {
  return join(resolve(sessionDir), "result.json");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function requireConfirmedResult(sessionDir) {
  const resultPath = resultPathFor(sessionDir);
  if (!(await exists(resultPath))) {
    throw new Error(`A_CONFIG cannot be approved before result.json exists: ${resultPath}`);
  }
  return resultPath;
}

export function pipelineStatePath(sessionDir) {
  return join(resolve(sessionDir), "debug", "pipeline-state.json");
}

async function writeState(sessionDir, state, at) {
  const path = pipelineStatePath(sessionDir);
  const debugDir = dirname(path);
  await mkdir(debugDir, { recursive: true });
  updateTotals(state, at);
  state.updatedAt = at;
  const temp = join(debugDir, `.pipeline-state.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temp, path);
}

export async function readPipelineState(sessionDir, { allowMissing = false } = {}) {
  const path = pipelineStatePath(sessionDir);
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    if (state?.producer !== PIPELINE_STATE_PRODUCER) {
      throw new Error(`invalid pipeline state producer at ${path}`);
    }
    return state;
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function withStateLock(sessionDir, operation) {
  const debugDir = join(resolve(sessionDir), "debug");
  const lockDir = join(debugDir, ".pipeline-state.lock");
  await mkdir(debugDir, { recursive: true });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > 30_000) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for pipeline state lock: ${lockDir}`);
      await delay(10);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function startStageInState(state, stageId, at, { retryOf = null } = {}) {
  stageDefinition(stageId);
  let stage = state.stages[stageId];
  if (!stage) {
    stage = makeStage(stageId, at);
    state.stages[stageId] = stage;
  }
  if (stage.status === "running") return { changed: false, stage };
  if (stage.status === "completed" || stage.status === "awaiting_approval") {
    return { changed: false, stage };
  }
  if (stage.status === "failed" && retryOf === null) {
    throw new Error(`${stageId} failed; use retry instead of start`);
  }
  if (stage.status === "paused" && activeAttempt(stage) && retryOf === null) {
    closeWait(stage, at);
    const attempt = activeAttempt(stage);
    const pause = (attempt.pauses || []).at(-1);
    if (pause && !pause.resumedAt) {
      pause.resumedAt = at;
      pause.durationMs = durationBetween(pause.pausedAt, pause.resumedAt);
    }
    openExecution(stage, at);
  } else {
    makeAttempt(stage, at, { retryOf });
  }
  state.currentStage = stageId;
  state.status = "running";
  state.nextStage = nextEnabledStage(state, stageId);
  state.pauseReason = null;
  return { changed: true, stage };
}

function stageResult(state, at, changed, extra = {}) {
  const current = snapshot(state, at);
  const { messageStage, ...rest } = extra;
  return {
    ok: true,
    changed,
    state: current,
    message: formatGateMessage(current, { stageId: messageStage }),
    ...rest,
  };
}

/**
 * Prepare deterministic stage-owned directories before the stage timer starts.
 * B2.5 only authors analysis/tasks.json and analysis/main.md; creating their
 * fixed parent here removes any need for an Editor shell discovery/mkdir turn.
 */
async function prepareStageWorkspace(sessionDir, stageId) {
  if (stageId === "B25_EDITOR" || stageId === "B2_MAIN") {
    await mkdir(join(resolve(sessionDir), "analysis"), { recursive: true });
  }
}

function normalizePolicy(raw) {
  if (!isPlainObject(raw)) return {};
  const policy = {};
  for (const stageId of STAGE_ORDER) {
    const item = raw[stageId];
    if (!isPlainObject(item)) continue;
    const next = {};
    if (typeof item.enabled === "boolean") next.enabled = item.enabled;
    if (typeof item.gate === "boolean") next.gate = item.gate;
    if (Object.keys(next).length) policy[stageId] = next;
  }
  return policy;
}

export async function initPipeline(sessionDir, { mode = "step", sessionId, now, policy } = {}) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  return withStateLock(abs, async () => {
    const existing = await readPipelineState(abs, { allowMissing: true });
    if (existing) return stageResult(existing, at, false, { statePath: pipelineStatePath(abs) });
    const normalizedMode = normalizeMode(mode);
    const firstStage = STAGE_ORDER[0];
    const state = {
      version: PIPELINE_STATE_VERSION,
      producer: PIPELINE_STATE_PRODUCER,
      sessionId: String(sessionId || basename(abs)),
      sessionDir: abs,
      mode: normalizedMode,
      status: "paused",
      currentStage: firstStage,
      policy: normalizePolicy(policy),
      nextStage: null,
      pauseReason: "initialized",
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      stages: { [firstStage]: makeStage(firstStage, at) },
      approvals: [],
      modeChanges: [],
      cumulativeExecutionDurationMs: 0,
      cumulativeHumanWaitingDurationMs: 0,
    };
    state.nextStage = nextEnabledStage(state, firstStage);
    await writeState(abs, state, at);
    return stageResult(state, at, true, { statePath: pipelineStatePath(abs) });
  });
}

export async function applyPipelinePolicy(sessionDir, policy, { now } = {}) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  return withStateLock(abs, async () => {
    const state = await readPipelineState(abs);
    state.policy = { ...state.policy, ...normalizePolicy(policy) };
    state.nextStage = nextEnabledStage(state, state.currentStage);
    await writeState(abs, state, at);
    return stageResult(state, at, true);
  });
}

export async function startPipelineStage(sessionDir, stageId, { now } = {}) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  return withStateLock(abs, async () => {
    const state = await readPipelineState(abs);
    if (state.currentStage !== stageId) {
      throw new Error(`stage mismatch: current=${state.currentStage}, requested=${stageId}`);
    }
    if (!resolveStagePolicy(state, stageId).enabled) {
      throw new Error(`stage ${stageId} is disabled by policy`);
    }
    await prepareStageWorkspace(abs, stageId);
    const outcome = startStageInState(state, stageId, at);
    if (outcome.changed) await writeState(abs, state, at);
    return stageResult(state, at, outcome.changed);
  });
}

async function advanceAfterCompletion(state, sessionDir, stageId, at) {
  const next = nextEnabledStage(state, stageId);
  state.nextStage = next;
  if (!next) {
    state.status = "completed";
    state.completedAt = at;
    return false;
  }

  // Even auto mode must wait until the HTML confirmation has materialized the
  // immutable result.json input. This is a data prerequisite, not a debug gate.
  if (stageId === "A_CONFIG" && !(await exists(resultPathFor(sessionDir)))) {
    state.status = "paused";
    state.pauseReason = "result.json required before B0_PREFLIGHT";
    openWait(state.stages[stageId], "result", at, { nextStage: next });
    return false;
  }

  await prepareStageWorkspace(sessionDir, next);
  startStageInState(state, next, at);
  return true;
}

export async function finishPipelineStage(sessionDir, stageId, { now } = {}) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  return withStateLock(abs, async () => {
    const state = await readPipelineState(abs);
    if (state.currentStage !== stageId) {
      const existing = state.stages?.[stageId];
      if (existing?.status === "completed") return stageResult(state, at, false);
      throw new Error(`stage mismatch: current=${state.currentStage}, requested=${stageId}`);
    }
    const stage = state.stages[stageId];
    if (stage.status === "awaiting_approval" || stage.status === "completed") {
      return stageResult(state, at, false);
    }
    if (stage.status !== "running") {
      throw new Error(`cannot finish ${stageId} while status=${stage.status}`);
    }

    closeExecution(stage, at);
    const attempt = activeAttempt(stage);
    attempt.status = "completed";
    attempt.endedAt = at;
    stage.completedAt = at;
    stage.failedAt = null;
    stage.failureReason = null;

    const policy = resolveStagePolicy(state, stageId);
    const next = nextEnabledStage(state, stageId);
    state.nextStage = next;
    if (state.mode === "step" && policy.gate) {
      stage.status = "awaiting_approval";
      state.status = "awaiting_approval";
      state.pauseReason = null;
      openWait(stage, "approval", at, { nextStage: next });
    } else {
      stage.status = "completed";
      await advanceAfterCompletion(state, abs, stageId, at);
    }

    await writeState(abs, state, at);
    return stageResult(state, at, true, { messageStage: stageId });
  });
}

export async function failPipelineStage(sessionDir, stageId, reason, { now } = {}) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  const failureReason = String(reason || "stage failed").trim();
  return withStateLock(abs, async () => {
    const state = await readPipelineState(abs);
    if (state.currentStage !== stageId) {
      throw new Error(`stage mismatch: current=${state.currentStage}, requested=${stageId}`);
    }
    const stage = state.stages[stageId];
    if (stage.status === "failed") return stageResult(state, at, false);
    const awaitingFixedRuntimePrerequisite =
      stageId === "A_CONFIG" && stage.status === "awaiting_approval";
    if (stage.status !== "running" && stage.status !== "paused" && !awaitingFixedRuntimePrerequisite) {
      throw new Error(`cannot fail ${stageId} while status=${stage.status}`);
    }
    closeExecution(stage, at);
    closePause(stage, at);
    closeWait(stage, at);
    const attempt = activeAttempt(stage);
    if (attempt) {
      attempt.status = "failed";
      attempt.failedAt = at;
      attempt.endedAt = at;
      attempt.failureReason = failureReason;
    }
    stage.status = "failed";
    stage.failedAt = at;
    stage.failureReason = failureReason;
    state.status = "failed";
    state.pauseReason = null;
    openWait(stage, "retry", at, { reason: failureReason });
    await writeState(abs, state, at);
    return stageResult(state, at, true, { reason: failureReason });
  });
}

export async function approvePipelineStage(
  sessionDir,
  { phrase = "继续", actor = "user", now } = {}
) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  return withStateLock(abs, async () => {
    const state = await readPipelineState(abs);
    if (state.status !== "awaiting_approval") {
      return stageResult(state, at, false, { approvalRejected: "not_awaiting_approval" });
    }
    const stageId = state.currentStage;
    const stage = state.stages[stageId];
    if (stage.status !== "awaiting_approval") {
      throw new Error(`pipeline/stage status mismatch for ${stageId}`);
    }
    if (stageId === "A_CONFIG") await requireConfirmedResult(abs);

    closeWait(stage, at);
    stage.status = "completed";
    stage.approvedAt = at;
    state.approvals.push({
      stage: stageId,
      humanGate: stageDefinition(stageId).humanGate,
      approvedAt: at,
      actor: String(actor || "user"),
      phrase: String(phrase || "继续"),
      nextStage: nextEnabledStage(state, stageId),
    });
    await advanceAfterCompletion(state, abs, stageId, at);
    await writeState(abs, state, at);
    return stageResult(state, at, true, { approvedStage: stageId });
  });
}

export async function retryPipelineStage(
  sessionDir,
  { phrase = "重试当前阶段", actor = "user", now } = {}
) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  return withStateLock(abs, async () => {
    const state = await readPipelineState(abs);
    if (state.status !== "failed") {
      return stageResult(state, at, false, { retryRejected: "current_stage_not_failed" });
    }
    const stageId = state.currentStage;
    const stage = state.stages[stageId];
    closeWait(stage, at);
    const previous = activeAttempt(stage)?.number || null;
    stage.failedAt = null;
    stage.failureReason = null;
    await prepareStageWorkspace(abs, stageId);
    startStageInState(state, stageId, at, { retryOf: previous });
    state.retry = {
      stage: stageId,
      requestedAt: at,
      actor: String(actor || "user"),
      phrase: String(phrase || "重试当前阶段"),
      retryOf: previous,
    };
    await writeState(abs, state, at);
    return stageResult(state, at, true, { retriedStage: stageId });
  });
}

export async function pausePipelineStage(sessionDir, { reason = "agent settled", now } = {}) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  return withStateLock(abs, async () => {
    const state = await readPipelineState(abs);
    if (state.status !== "running") return stageResult(state, at, false);
    const stage = state.stages[state.currentStage];
    closeExecution(stage, at);
    const attempt = activeAttempt(stage);
    attempt.status = "paused";
    attempt.pauses ||= [];
    const lastPause = attempt.pauses.at(-1);
    if (!lastPause || lastPause.resumedAt) {
      attempt.pauses.push({ pausedAt: at, resumedAt: null, durationMs: 0, reason: String(reason) });
    }
    stage.status = "paused";
    state.status = "paused";
    state.pauseReason = String(reason);
    await writeState(abs, state, at);
    return stageResult(state, at, true);
  });
}

export async function resumePipeline(
  sessionDir,
  { mode, phrase = "继续", actor = "user", now } = {}
) {
  const abs = resolve(sessionDir);
  const at = nowIso(now);
  return withStateLock(abs, async () => {
    const state = await readPipelineState(abs);
    let changed = false;
    if (mode !== undefined) {
      const normalized = normalizeMode(mode);
      if (state.mode !== normalized) {
        state.modeChanges.push({ from: state.mode, to: normalized, changedAt: at, phrase, actor });
        state.mode = normalized;
        changed = true;
      }
    }

    const stage = state.stages[state.currentStage];
    if (state.status === "running" || state.status === "completed") {
      if (changed) await writeState(abs, state, at);
      return stageResult(state, at, changed);
    }

    if (state.status === "awaiting_approval") {
      if (state.mode !== "auto") {
        if (changed) await writeState(abs, state, at);
        return stageResult(state, at, changed, { resumeRejected: "approval_required" });
      }
      if (state.currentStage === "A_CONFIG") await requireConfirmedResult(abs);
      closeWait(stage, at);
      stage.status = "completed";
      stage.approvedAt = at;
      state.approvals.push({
        stage: state.currentStage,
        humanGate: stageDefinition(state.currentStage).humanGate,
        approvedAt: at,
        actor: String(actor),
        phrase: String(phrase),
        nextStage: nextEnabledStage(state, state.currentStage),
        automatic: true,
      });
      await advanceAfterCompletion(state, abs, state.currentStage, at);
      changed = true;
    } else if (state.status === "failed") {
      closeWait(stage, at);
      const previous = activeAttempt(stage)?.number || null;
      stage.failedAt = null;
      stage.failureReason = null;
      startStageInState(state, state.currentStage, at, { retryOf: previous });
      changed = true;
    } else if (state.status === "paused") {
      if (stage.status === "paused" && activeAttempt(stage)) {
        const attempt = activeAttempt(stage);
        const pause = (attempt.pauses || []).at(-1);
        if (pause && !pause.resumedAt) {
          pause.resumedAt = at;
          pause.durationMs = durationBetween(pause.pausedAt, pause.resumedAt);
        }
        openExecution(stage, at);
        state.status = "running";
        state.pauseReason = null;
        changed = true;
      } else if (stage.status === "completed" && state.nextStage) {
        if (state.currentStage === "A_CONFIG") await requireConfirmedResult(abs);
        closeWait(stage, at);
        startStageInState(state, state.nextStage, at);
        changed = true;
      } else if (!activeAttempt(stage)) {
        startStageInState(state, state.currentStage, at);
        changed = true;
      }
    }

    if (changed) await writeState(abs, state, at);
    return stageResult(state, at, changed);
  });
}

export async function pipelineStatus(sessionDir, { now, allowMissing = false } = {}) {
  const at = nowIso(now);
  const state = await readPipelineState(sessionDir, { allowMissing });
  if (!state) {
    return { ok: true, exists: false, statePath: pipelineStatePath(sessionDir), message: "尚未初始化 html-report Gate" };
  }
  return stageResult(state, at, false, { exists: true, statePath: pipelineStatePath(sessionDir) });
}

export function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

export function formatGateMessage(state, { stageId: requestedStageId } = {}) {
  if (!state?.currentStage) return "html-report Gate 尚未初始化";
  const stageId = requestedStageId || state.currentStage;
  const stage = state.stages?.[stageId] || {};
  const definition = stageDefinition(stageId);
  const lines = [`阶段：${definition.gateLabel}`];

  if (state.status === "failed" || stage.status === "failed") {
    lines.push(
      "状态：failed",
      `失败前耗时：${formatDuration(stage.executionDurationMs)}`,
      `累计执行耗时：${formatDuration(state.cumulativeExecutionDurationMs)}`,
      `原因：${stage.failureReason || "未知错误"}`,
      "回复“重试当前阶段”重新执行；普通“继续”不会跳过失败 Gate"
    );
    return lines.join("\n");
  }

  const completedForGate =
    stage.status === "awaiting_approval" ||
    stage.status === "completed" ||
    (state.status === "completed" && stageId === "B5_DESIGN");
  lines.push(`状态：${completedForGate ? "completed" : state.status}`);

  if (stageId === "B3_RESEARCH" && completedForGate) {
    const editor = state.stages?.B25_EDITOR?.executionDurationMs || 0;
    const researcher = stage.executionDurationMs || 0;
    lines.push(
      `Editor 耗时：${formatDuration(editor)}`,
      `Researcher 耗时：${formatDuration(researcher)}`,
      `本阶段耗时：${formatDuration(editor + researcher)}`
    );
  } else {
    lines.push(`本阶段耗时：${formatDuration(stage.executionDurationMs)}`);
  }
  lines.push(`累计执行耗时：${formatDuration(state.cumulativeExecutionDurationMs)}`);

  const nextLabel = nextStageLabel(state, stageId);
  if ((stageId === "B5_DESIGN" || !nextEnabledStage(state, stageId)) && stage.status === "completed") {
    lines.push("下一阶段：已完成");
  } else if (stageId === state.currentStage && state.status === "awaiting_approval") {
    lines.push(
      `下一阶段：${nextLabel}`,
      nextEnabledStage(state, stageId) ? "回复“继续”进入下一阶段" : "回复“继续”结束本阶段",
      "当前必须立即停止工具调用，并将以上 Gate 文本原样返回用户；不要主动检查目录或文件"
    );
  } else if (stageId === state.currentStage && state.status === "paused") {
    lines.push(`暂停原因：${state.pauseReason || "等待恢复"}`, "回复“继续”恢复当前阶段");
  } else if (stage.status === "completed" && state.mode === "auto") {
    lines.push(`下一阶段：${nextLabel}`, "Gate 模式：auto（已自动进入下一阶段）");
  } else if (stageId === "B25_EDITOR" && stage.status === "completed") {
    lines.push("下一阶段：B3.5 Researcher（无需人工回复）");
  } else {
    lines.push(`下一阶段：${nextLabel}`);
  }
  return lines.join("\n");
}

function cliValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function cliSessionDir(argv) {
  const sessionDir = cliValue(argv, "--session-dir");
  const resultPath = cliValue(argv, "--result");
  if (sessionDir) return resolve(sessionDir);
  if (resultPath) return dirname(resolve(resultPath));
  throw new Error("--session-dir <SESSION> or --result <result.json> is required");
}

async function runCli() {
  const argv = process.argv.slice(2);
  const operation = argv[0];
  if (!operation) throw new Error("operation required: init|start|finish|fail|approve|status|retry|resume|pause");
  const sessionDir = cliSessionDir(argv);
  const options = {
    now: cliValue(argv, "--now") || process.env.HTML_REPORT_GATE_NOW,
  };
  let output;
  if (operation === "init") {
    output = await initPipeline(sessionDir, {
      ...options,
      mode: cliValue(argv, "--mode") || process.env.HTML_REPORT_GATE_MODE || "step",
      sessionId: cliValue(argv, "--session-id"),
    });
  } else if (operation === "start") {
    output = await startPipelineStage(sessionDir, cliValue(argv, "--stage"), options);
  } else if (operation === "finish") {
    output = await finishPipelineStage(sessionDir, cliValue(argv, "--stage"), options);
  } else if (operation === "fail") {
    output = await failPipelineStage(
      sessionDir,
      cliValue(argv, "--stage"),
      cliValue(argv, "--reason"),
      options
    );
  } else if (operation === "approve") {
    output = await approvePipelineStage(sessionDir, {
      ...options,
      phrase: cliValue(argv, "--phrase") || "继续",
      actor: cliValue(argv, "--actor") || "user",
    });
  } else if (operation === "status") {
    output = await pipelineStatus(sessionDir, { ...options, allowMissing: true });
  } else if (operation === "retry") {
    output = await retryPipelineStage(sessionDir, {
      ...options,
      phrase: cliValue(argv, "--phrase") || "重试当前阶段",
      actor: cliValue(argv, "--actor") || "user",
    });
  } else if (operation === "resume") {
    output = await resumePipeline(sessionDir, {
      ...options,
      mode: cliValue(argv, "--mode"),
      phrase: cliValue(argv, "--phrase") || "继续",
      actor: cliValue(argv, "--actor") || "user",
    });
  } else if (operation === "pause") {
    output = await pausePipelineStage(sessionDir, {
      ...options,
      reason: cliValue(argv, "--reason") || "agent settled",
    });
  } else {
    throw new Error(`unknown operation ${JSON.stringify(operation)}`);
  }

  if (cliValue(argv, "--format") === "text") {
    process.stdout.write(`${output.message}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2)}\n`);
    process.exit(1);
  }
}
