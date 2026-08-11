import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvePipelineStage,
  failPipelineStage,
  finishPipelineStage,
  formatDuration,
  initPipeline,
  pausePipelineStage,
  pipelineStatePath,
  pipelineStatus,
  resumePipeline,
  retryPipelineStage,
  startPipelineStage,
} from "../scripts/stage-gate.mjs";

const at = (seconds) => new Date(Date.UTC(2026, 6, 24, 0, 0, seconds)).toISOString();

async function makeSession(t, name = "gate") {
  const root = await mkdtemp(join(tmpdir(), `html-report-${name}-`));
  const session = join(root, ".harness", "state", "html-report", name);
  await mkdir(session, { recursive: true });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return session;
}

async function confirmResult(session) {
  await writeFile(
    join(session, "result.json"),
    JSON.stringify({ status: "confirmed", session_id: "test", cards: [] })
  );
}

test("stage gate excludes approval and paused waits from execution time", async (t) => {
  const session = await makeSession(t, "timing");
  await initPipeline(session, { mode: "step", now: at(0) });
  await startPipelineStage(session, "A_CONFIG", { now: at(1) });
  let output = await finishPipelineStage(session, "A_CONFIG", { now: at(11) });
  assert.equal(output.state.status, "awaiting_approval");
  assert.equal(output.state.stages.A_CONFIG.executionDurationMs, 10_000);

  await confirmResult(session);
  output = await approvePipelineStage(session, { now: at(41), phrase: "继续" });
  assert.equal(output.state.currentStage, "B0_PREFLIGHT");
  assert.equal(output.state.status, "running");
  assert.equal(output.state.stages.A_CONFIG.humanWaitingDurationMs, 30_000);

  await pausePipelineStage(session, { now: at(51), reason: "interrupted" });
  output = await resumePipeline(session, { now: at(71), phrase: "继续" });
  assert.equal(output.state.status, "running");
  output = await finishPipelineStage(session, "B0_PREFLIGHT", { now: at(81) });

  assert.equal(output.state.stages.B0_PREFLIGHT.executionDurationMs, 20_000);
  assert.equal(output.state.stages.B0_PREFLIGHT.pausedDurationMs, 20_000);
  assert.equal(output.state.cumulativeExecutionDurationMs, 30_000);
  assert.equal(output.state.cumulativeHumanWaitingDurationMs, 50_000);
  assert.equal(formatDuration(output.state.cumulativeExecutionDurationMs), "30秒");
});

test("duration output stays second-based and uses minutes plus seconds after one minute", () => {
  assert.equal(formatDuration(0), "0秒");
  assert.equal(formatDuration(59_000), "59秒");
  assert.equal(formatDuration(60_000), "1分0秒");
  assert.equal(formatDuration(261_000), "4分21秒");
  assert.equal(formatDuration(3_661_000), "61分1秒");
});

test("init, start, finish and approve are idempotent without skipping a gate", async (t) => {
  const session = await makeSession(t, "idempotent");
  const first = await initPipeline(session, { mode: "step", now: at(0) });
  const second = await initPipeline(session, { mode: "auto", now: at(1) });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.state.mode, "step");

  await startPipelineStage(session, "A_CONFIG", { now: at(2) });
  const repeatedStart = await startPipelineStage(session, "A_CONFIG", { now: at(3) });
  assert.equal(repeatedStart.changed, false);
  await finishPipelineStage(session, "A_CONFIG", { now: at(12) });
  const repeatedFinish = await finishPipelineStage(session, "A_CONFIG", { now: at(13) });
  assert.equal(repeatedFinish.changed, false);
  assert.equal(repeatedFinish.state.stages.A_CONFIG.executionDurationMs, 10_000);

  await confirmResult(session);
  const approved = await approvePipelineStage(session, { now: at(20), phrase: "继续" });
  const duplicate = await approvePipelineStage(session, { now: at(21), phrase: "继续" });
  assert.equal(approved.state.currentStage, "B0_PREFLIGHT");
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.state.currentStage, "B0_PREFLIGHT");
  assert.equal(duplicate.state.approvals.length, 1);
});

test("A_CONFIG approval requires result.json and stage mismatch cannot advance", async (t) => {
  const session = await makeSession(t, "guard");
  await initPipeline(session, { mode: "step", now: at(0) });
  await startPipelineStage(session, "A_CONFIG", { now: at(1) });
  await assert.rejects(
    startPipelineStage(session, "B0_PREFLIGHT", { now: at(2) }),
    /stage mismatch/
  );
  await finishPipelineStage(session, "A_CONFIG", { now: at(3) });
  await assert.rejects(
    approvePipelineStage(session, { now: at(4), phrase: "继续" }),
    /result\.json exists/
  );
  const status = await pipelineStatus(session, { now: at(5) });
  assert.equal(status.state.status, "awaiting_approval");
  assert.equal(status.state.currentStage, "A_CONFIG");
});

test("A_CONFIG may fail while awaiting approval when its runtime prerequisite is rejected", async (t) => {
  const session = await makeSession(t, "a-runtime-failure");
  await initPipeline(session, { mode: "step", now: at(0) });
  await startPipelineStage(session, "A_CONFIG", { now: at(1) });
  await finishPipelineStage(session, "A_CONFIG", { now: at(2) });
  const failed = await failPipelineStage(
    session,
    "A_CONFIG",
    "runtime list missing report-reviewer",
    { now: at(3) }
  );
  assert.equal(failed.state.status, "failed");
  assert.equal(failed.state.stages.A_CONFIG.status, "failed");
  assert.match(failed.state.stages.A_CONFIG.failureReason, /runtime list/);
  const retried = await retryPipelineStage(session, { now: at(4), phrase: "重试当前阶段" });
  assert.equal(retried.state.status, "running");
  assert.equal(retried.state.stages.A_CONFIG.attempts.length, 2);
});

test("failed stage only retry starts a new timed attempt", async (t) => {
  const session = await makeSession(t, "retry");
  await confirmResult(session);
  await initPipeline(session, { mode: "auto", now: at(0) });
  await startPipelineStage(session, "A_CONFIG", { now: at(1) });
  await finishPipelineStage(session, "A_CONFIG", { now: at(2) });
  assert.equal((await pipelineStatus(session, { now: at(2) })).state.currentStage, "B0_PREFLIGHT");

  let output = await failPipelineStage(session, "B0_PREFLIGHT", "agents missing", { now: at(7) });
  assert.equal(output.state.status, "failed");
  assert.equal(output.state.stages.B0_PREFLIGHT.executionDurationMs, 5_000);

  const ordinaryApproval = await approvePipelineStage(session, { now: at(20), phrase: "继续" });
  assert.equal(ordinaryApproval.changed, false);
  assert.equal(ordinaryApproval.state.status, "failed");

  output = await retryPipelineStage(session, { now: at(27), phrase: "重试当前阶段" });
  assert.equal(output.state.status, "running");
  assert.equal(output.state.stages.B0_PREFLIGHT.attempts.length, 2);
  output = await finishPipelineStage(session, "B0_PREFLIGHT", { now: at(34) });
  assert.equal(output.state.stages.B0_PREFLIGHT.executionDurationMs, 12_000);
  assert.equal(output.state.stages.B0_PREFLIGHT.humanWaitingDurationMs, 20_000);
});

test("failing a paused stage closes the pause interval", async (t) => {
  const session = await makeSession(t, "paused-failure");
  await confirmResult(session);
  await initPipeline(session, { mode: "auto", now: at(0) });
  await startPipelineStage(session, "A_CONFIG", { now: at(1) });
  await finishPipelineStage(session, "A_CONFIG", { now: at(2) });
  await pausePipelineStage(session, { now: at(7), reason: "interrupted" });
  await failPipelineStage(session, "B0_PREFLIGHT", "cannot resume", { now: at(17) });
  const status = await pipelineStatus(session, { now: at(40) });
  const attempt = status.state.stages.B0_PREFLIGHT.attempts[0];
  assert.equal(attempt.pausedDurationMs, 10_000);
  assert.equal(attempt.pauses[0].resumedAt, at(17));
});

test("B2.5 is timed separately and B3 gate reports both durations", async (t) => {
  const session = await makeSession(t, "research");
  await confirmResult(session);
  await initPipeline(session, { mode: "step", now: at(0) });
  await startPipelineStage(session, "A_CONFIG", { now: at(1) });
  await finishPipelineStage(session, "A_CONFIG", { now: at(2) });
  await approvePipelineStage(session, { now: at(3) });
  await finishPipelineStage(session, "B0_PREFLIGHT", { now: at(4) });
  await approvePipelineStage(session, { now: at(5) });
  await finishPipelineStage(session, "B2_WRITER", { now: at(6) });
  await approvePipelineStage(session, { now: at(7) });
  assert.equal((await pipelineStatus(session, { now: at(7) })).state.currentStage, "B25_EDITOR");
  assert.equal((await stat(join(session, "analysis"))).isDirectory(), true);

  await finishPipelineStage(session, "B25_EDITOR", { now: at(37) });
  let status = await pipelineStatus(session, { now: at(37) });
  assert.equal(status.state.currentStage, "B3_RESEARCH");
  assert.equal(status.state.stages.B25_EDITOR.executionDurationMs, 30_000);

  const output = await finishPipelineStage(session, "B3_RESEARCH", { now: at(77) });
  assert.equal(output.state.status, "awaiting_approval");
  assert.match(output.message, /Editor 耗时：30秒/);
  assert.match(output.message, /Researcher 耗时：40秒/);
  assert.match(output.message, /本阶段耗时：1分10秒/);
});

test("auto mode completes every stage without approval records", async (t) => {
  const session = await makeSession(t, "auto");
  await confirmResult(session);
  await initPipeline(session, { mode: "auto", now: at(0) });
  await startPipelineStage(session, "A_CONFIG", { now: at(1) });
  const stages = [
    "A_CONFIG",
    "B0_PREFLIGHT",
    "B2_WRITER",
    "B25_EDITOR",
    "B3_RESEARCH",
    "B4_REVIEW",
    "B5_DESIGN",
  ];
  for (let index = 0; index < stages.length; index += 1) {
    await finishPipelineStage(session, stages[index], { now: at(index + 2) });
  }
  const output = await pipelineStatus(session, { now: at(10) });
  assert.equal(output.state.status, "completed");
  assert.equal(output.state.currentStage, "B5_DESIGN");
  assert.equal(output.state.approvals.length, 0);
  assert.match(output.message, /下一阶段：已完成/);
});

test("auto mode still pauses A until result.json exists", async (t) => {
  const session = await makeSession(t, "auto-result");
  await initPipeline(session, { mode: "auto", now: at(0) });
  await startPipelineStage(session, "A_CONFIG", { now: at(1) });
  let output = await finishPipelineStage(session, "A_CONFIG", { now: at(2) });
  assert.equal(output.state.status, "paused");
  assert.equal(output.state.currentStage, "A_CONFIG");
  assert.match(output.message, /result\.json required/);

  await confirmResult(session);
  output = await resumePipeline(session, { now: at(10), phrase: "继续" });
  assert.equal(output.state.currentStage, "B0_PREFLIGHT");
  assert.equal(output.state.status, "running");
});

test("sessions keep independent state files", async (t) => {
  const first = await makeSession(t, "isolation-a");
  const second = await makeSession(t, "isolation-b");
  await initPipeline(first, { mode: "step", now: at(0) });
  await initPipeline(second, { mode: "auto", now: at(0) });
  await startPipelineStage(first, "A_CONFIG", { now: at(1) });

  const firstState = JSON.parse(await readFile(pipelineStatePath(first), "utf8"));
  const secondState = JSON.parse(await readFile(pipelineStatePath(second), "utf8"));
  assert.equal(firstState.mode, "step");
  assert.equal(firstState.status, "running");
  assert.equal(secondState.mode, "auto");
  assert.equal(secondState.status, "paused");
  assert.notEqual(pipelineStatePath(first), pipelineStatePath(second));
});
