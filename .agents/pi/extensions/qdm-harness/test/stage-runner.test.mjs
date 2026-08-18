import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  HtmlReportStageRunner,
  persistReportAgentLifecycle,
  settlementMarkerPath,
  stageRunMarkerPath,
} from "../orchestration/stage-runner.ts";

function identity(sessionDir, overrides = {}) {
  return {
    sessionId: "stage-runner-session",
    sessionDir,
    stage: "B4_REVIEW",
    attempt: "B4_REVIEW:1:2026-08-18T00:00:00.000Z",
    reservation: "qdm-stage-v1-test",
    ...overrides,
  };
}

function lifecycleEvent(overrides = {}) {
  return {
    state: "EMITTED",
    requestId: "request-1",
    invocationId: "invocation-1",
    sessionId: "stage-runner-session",
    stage: "B4_REVIEW",
    attempt: "B4_REVIEW:1:2026-08-18T00:00:00.000Z",
    transport: "delegation-canonical",
    at: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

test("stage runner reserves once and never replays a terminal run", async (t) => {
  const sessionDir = await mkdtemp(join(tmpdir(), "qdm-stage-runner-"));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));
  const runner = new HtmlReportStageRunner();
  const runIdentity = identity(sessionDir);
  let executions = 0;

  const first = await runner.run(runIdentity, async () => {
    executions += 1;
    return { status: "completed", text: "stage completed", transport: "delegation-canonical" };
  });
  assert.equal(first.status, "completed");
  assert.equal(executions, 1);

  const replay = await runner.run(runIdentity, async () => {
    executions += 1;
    return { status: "completed", text: "must not execute" };
  });
  assert.equal(replay.status, "failed");
  assert.match(replay.text, /already completed.*cannot be replayed/);
  assert.equal(executions, 1);

  const marker = JSON.parse(await readFile(stageRunMarkerPath(runIdentity), "utf8"));
  assert.equal(marker.status, "completed");
  assert.equal(marker.transport, "delegation-canonical");
});

test("stage runner treats a durable running marker as ambiguous and does not replay", async (t) => {
  const sessionDir = await mkdtemp(join(tmpdir(), "qdm-stage-running-"));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));
  const runIdentity = identity(sessionDir, { reservation: "qdm-stage-v1-running" });
  const markerPath = stageRunMarkerPath(runIdentity);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify({
    version: 1,
    producer: "qdm-harness-stage-runner",
    ...runIdentity,
    status: "running",
    startedAt: "2026-08-18T00:00:00.000Z",
  }, null, 2)}\n`);

  let executions = 0;
  const result = await new HtmlReportStageRunner().run(runIdentity, async () => {
    executions += 1;
    return { status: "completed", text: "must not execute" };
  });
  assert.equal(result.status, "failed");
  assert.match(result.text, /already reserved.*will not be replayed/);
  assert.equal(executions, 0);
});

test("lifecycle settlement is first-terminal-wins for one physical request", async (t) => {
  const sessionDir = await mkdtemp(join(tmpdir(), "qdm-stage-settlement-"));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));
  const emitted = lifecycleEvent();
  persistReportAgentLifecycle(sessionDir, emitted);
  persistReportAgentLifecycle(sessionDir, lifecycleEvent({
    state: "STARTED",
    at: "2026-08-18T00:00:01.000Z",
  }));
  persistReportAgentLifecycle(sessionDir, lifecycleEvent({
    state: "TERMINAL",
    at: "2026-08-18T00:00:02.000Z",
    outcome: {
      status: "completed",
      value: { ok: true },
      requestId: "request-1",
      started: true,
      transport: "delegation-canonical",
    },
  }));
  persistReportAgentLifecycle(sessionDir, lifecycleEvent({
    state: "TERMINAL",
    at: "2026-08-18T00:00:03.000Z",
    outcome: {
      status: "failed",
      code: "failed",
      message: "late terminal",
      requestId: "request-1",
      started: true,
      transport: "delegation-canonical",
    },
  }));

  const path = settlementMarkerPath(sessionDir, "invocation-1", "request-1");
  const settlement = JSON.parse(await readFile(path, "utf8"));
  assert.equal(settlement.state, "TERMINAL");
  assert.equal(settlement.outcome.status, "completed");
  assert.deepEqual(settlement.history.map(({ state }) => state), ["EMITTED", "STARTED", "TERMINAL"]);
});

test("pre-start adapter switch can persist a second physical request for one logical invocation", async (t) => {
  const sessionDir = await mkdtemp(join(tmpdir(), "qdm-stage-switch-"));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));
  persistReportAgentLifecycle(sessionDir, lifecycleEvent({
    requestId: "request-canonical",
    transport: "delegation-canonical",
  }));
  persistReportAgentLifecycle(sessionDir, lifecycleEvent({
    state: "TERMINAL",
    requestId: "request-canonical",
    transport: "delegation-canonical",
    at: "2026-08-18T00:00:01.000Z",
    outcome: {
      status: "failed",
      code: "invalid_request",
      message: "protocol changed before STARTED",
      requestId: "request-canonical",
      started: false,
      transport: "delegation-canonical",
    },
  }));
  persistReportAgentLifecycle(sessionDir, lifecycleEvent({
    requestId: "request-v2",
    transport: "delegation-v2",
    at: "2026-08-18T00:00:02.000Z",
  }));

  const files = await readdir(join(sessionDir, "debug", "contract-runtime", "settlements"));
  assert.equal(files.length, 2);
  assert.notEqual(
    settlementMarkerPath(sessionDir, "invocation-1", "request-canonical"),
    settlementMarkerPath(sessionDir, "invocation-1", "request-v2"),
  );
});
