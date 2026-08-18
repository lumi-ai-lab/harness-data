import assert from "node:assert/strict";
import test from "node:test";

import {
  HtmlReportStageProgressSession,
  HtmlReportStageProgressTracker,
  MAX_PROGRESS_ITEMS,
  STAGE_PROGRESS_PHASE,
  extractStageProgress,
  formatProgressBar,
  progressLineWidth,
  researcherProgressSeed,
  renderStageProgressCall,
  renderStageProgressCollapsed,
  renderStageProgressExpanded,
  renderStageProgressPlainText,
  renderStageProgressResult,
  selectProgressWindow,
  truncateProgressText,
  writerProgressSeed,
} from "../orchestration/stage-progress.ts";

function tracker(overrides = {}) {
  return new HtmlReportStageProgressTracker({
    sessionId: "session-1",
    attempt: "B2_WRITER:1:2026-08-18T00:00:00.000Z",
    entryStage: "B2_WRITER",
    phase: STAGE_PROGRESS_PHASE.writerAgents,
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    items: Array.from({ length: 14 }, (_, index) => writerProgressSeed({
      id: `card-${String(index + 1).padStart(2, "0")}`,
      title: ["销售额", "毛利额", "客流量", "转化率", "客单价", "毛利率", "库存周转", "缺货率", "损耗率", "复购率", "连带率", "坪效", "人效", "周转天数"][index],
    })),
    ...overrides,
  });
}

test("14 Writer cards count completed/failed/pending and keep taskId=cardId", () => {
  const progress = tracker();
  for (let index = 1; index <= 6; index += 1) {
    progress.markCompleted(`card-${String(index).padStart(2, "0")}`);
  }
  progress.markDispatching("card-07", { invocationId: "inv-7", agent: "report-writer" });
  const snapshot = progress.snapshot();

  assert.equal(snapshot.kind, "html-report-stage-progress");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.producer, "qdm-harness");
  assert.equal(snapshot.total, 14);
  assert.equal(snapshot.completed, 6);
  assert.equal(snapshot.failed, 0);
  assert.equal(snapshot.pending, 8);
  assert.equal(snapshot.currentItemId, "card-07");
  assert.equal(snapshot.items[0].taskId, "card-01");
  assert.equal(snapshot.items[0].cardId, "card-01");
  assert.equal(snapshot.items[0].role, "writer");
  assert.equal(snapshot.items[6].status, "dispatching");
  assert.equal(snapshot.items[6].invocationId, "inv-7");
});

test("STARTED / UPDATE / TERMINAL move one item without changing total", () => {
  const progress = tracker();
  progress.markDispatching("card-01");
  progress.markStarted("card-01", { requestId: "req-1", runId: "run-1", transport: "delegation-canonical" });
  progress.setTransport("delegation-canonical");
  let snapshot = progress.snapshot();
  assert.equal(snapshot.items[0].status, "running");
  assert.equal(snapshot.items[0].requestId, "req-1");
  assert.equal(snapshot.transport, "delegation-canonical");
  assert.equal(snapshot.total, 14);
  assert.equal(snapshot.completed, 0);

  progress.markUpdate("card-01", {
    requestId: "req-1",
    currentTool: "ack_cli_data",
    durationMs: 8000,
    tokens: 120,
    recentOutput: "ok",
  });
  snapshot = progress.snapshot();
  assert.equal(snapshot.items[0].currentTool, "ack_cli_data");
  assert.equal(snapshot.items[0].durationMs, 8000);
  assert.equal(snapshot.items[0].tokens, 120);
  assert.equal(snapshot.completed, 0);

  progress.markCompleted("card-01", { durationMs: 18000 });
  snapshot = progress.snapshot();
  assert.equal(snapshot.items[0].status, "completed");
  assert.equal(snapshot.items[0].durationMs, 18000);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.total, 14);
});

test("failed item keeps error and increments failed without changing total", () => {
  const progress = tracker();
  progress.markDispatching("card-02");
  progress.markStarted("card-02", { requestId: "req-2" });
  progress.markFailed("card-02", "caption rejected: too long");
  const snapshot = progress.snapshot();
  assert.equal(snapshot.items[1].status, "failed");
  assert.match(snapshot.items[1].error, /caption rejected/);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.completed, 0);
  assert.equal(snapshot.total, 14);
});

test("B3 successor updates attempt on the same task and does not increase total", () => {
  const progress = new HtmlReportStageProgressTracker({
    sessionId: "session-1",
    attempt: "B3_RESEARCH:1:2026-08-18T00:00:00.000Z",
    entryStage: "B25_EDITOR",
    currentStage: "B3_RESEARCH",
    phase: STAGE_PROGRESS_PHASE.researchers,
    items: [
      { id: "planner", role: "planner", label: "Editor Planner", status: "completed", agent: "report-researcher" },
      researcherProgressSeed({ id: "drill-001", goal: "库存原因" }),
      researcherProgressSeed({ id: "drill-002", goal: "客流下降" }),
    ],
  });
  progress.markDispatching("drill-001");
  progress.markStarted("drill-001", { requestId: "r1" });
  progress.noteAttempt("drill-001", 2, 2);
  progress.markDispatching("drill-001");
  const snapshot = progress.snapshot();
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.currentStage, "B3_RESEARCH");
  assert.equal(snapshot.entryStage, "B25_EDITOR");
  assert.equal(snapshot.items[1].attempt, 2);
  assert.equal(snapshot.items[1].maxAttempts, 2);
  assert.equal(snapshot.items[1].status, "dispatching");
  assert.equal(snapshot.items.filter((item) => item.id === "drill-001").length, 1);
});

test("snapshot truncates label/output/error and reports omitted items", () => {
  const items = Array.from({ length: MAX_PROGRESS_ITEMS + 3 }, (_, index) => writerProgressSeed({
    id: `card-${index + 1}`,
    title: "x".repeat(80),
  }));
  const progress = new HtmlReportStageProgressTracker({
    sessionId: "session-1",
    attempt: "B2_WRITER:1:2026-08-18T00:00:00.000Z",
    entryStage: "B2_WRITER",
    phase: STAGE_PROGRESS_PHASE.writerAgents,
    items,
  });
  progress.markFailed("card-1", "e".repeat(200));
  progress.markUpdate("card-2", { currentTool: "t".repeat(80), recentOutput: "o".repeat(200) });
  const snapshot = progress.snapshot();
  assert.equal(snapshot.total, MAX_PROGRESS_ITEMS + 3);
  assert.equal(snapshot.items.length, MAX_PROGRESS_ITEMS);
  assert.equal(snapshot.omitted, 3);
  assert.ok(snapshot.items[0].label.length <= 40);
  assert.ok(snapshot.items[0].error.length <= 120);
  assert.ok(snapshot.items[1].recentOutput.length <= 80);
  assert.ok(snapshot.items[1].currentTool.length <= 40);
});

function runningSixOfFourteen() {
  const progress = tracker();
  for (let index = 1; index <= 6; index += 1) {
    progress.markCompleted(`card-${String(index).padStart(2, "0")}`, { durationMs: 16000 + index * 1000 });
  }
  progress.markStarted("card-07", { requestId: "req-7" });
  progress.markUpdate("card-07", { currentTool: "ack_cli_data", durationMs: 8000, tokens: 120 });
  return progress;
}

function assertWithinWidth(lines, width) {
  for (const line of lines) {
    assert.ok(progressLineWidth(line) <= width, `"${line}" wider than ${width}`);
  }
}

test("sliding window follows the current card and hides distant items", () => {
  const first = runningSixOfFourteen().snapshot();
  const wide = selectProgressWindow(first, 120);
  assert.deepEqual(wide.recentCompleted.map((item) => item.id), ["card-05", "card-06"]);
  assert.equal(wide.current.id, "card-07");
  assert.deepEqual(wide.upcoming.map((item) => item.id), ["card-08", "card-09"]);
  assert.equal(wide.hiddenPending, 5);
  assert.equal(wide.hiddenCompleted, 4);

  const moved = tracker();
  for (let index = 1; index <= 7; index += 1) moved.markCompleted(`card-${String(index).padStart(2, "0")}`);
  moved.markStarted("card-08", { requestId: "req-8" });
  const next = selectProgressWindow(moved.snapshot(), 120);
  assert.deepEqual(next.recentCompleted.map((item) => item.id), ["card-06", "card-07"]);
  assert.equal(next.current.id, "card-08");
  assert.deepEqual(next.upcoming.map((item) => item.id), ["card-09", "card-10"]);
});

function runningWithEarlyFailures(errorById) {
  const progress = tracker();
  for (let index = 1; index <= 6; index += 1) {
    const id = `card-${String(index).padStart(2, "0")}`;
    if (errorById[id]) progress.markFailed(id, errorById[id]);
    else progress.markCompleted(id, { durationMs: 16000 });
  }
  progress.markStarted("card-07", { requestId: "req-7" });
  progress.markUpdate("card-07", { currentTool: "ack_cli_data", durationMs: 8000 });
  return progress;
}

test("0/14 window shows the queue head and a pinned failure stays visible", () => {
  const empty = selectProgressWindow(tracker().snapshot(), 120);
  assert.equal(empty.current, undefined);
  assert.deepEqual(empty.upcoming.map((item) => item.id), ["card-01", "card-02", "card-03", "card-04", "card-05"]);
  assert.match(String(empty.hiddenPending), /9/);

  const pinned = selectProgressWindow(runningWithEarlyFailures({
    "card-01": "caption rejected",
    "card-03": "artifact validation failed",
  }).snapshot(), 120);
  assert.equal(pinned.failed[0].id, "card-01");
  assert.equal(pinned.hiddenFailed, 1);
  assert.equal(pinned.current.id, "card-07");
  assert.ok(pinned.recentCompleted.every((item) => item.status !== "failed"));
});

test("default renderer is a sliding window; expanded lists every card", () => {
  const snapshot = runningSixOfFourteen().snapshot();
  const collapsed = renderStageProgressCollapsed(snapshot).render(120);
  const text = collapsed.join("\n");
  assert.match(text, /HTML Report · B2 Writer/);
  assert.match(text, /6\/14/);
  assert.match(text, /card-05/);
  assert.match(text, /card-06/);
  assert.match(text, /card-07/);
  assert.match(text, /ack_cli_data/);
  assert.match(text, /card-08/);
  assert.match(text, /card-09/);
  assert.match(text, /\+5 queued/);
  assert.doesNotMatch(text, /card-01/);
  assert.doesNotMatch(text, /card-14/);
  assert.ok(collapsed.length >= 4 && collapsed.length <= 7);
  assertWithinWidth(collapsed, 120);

  const expanded = renderStageProgressExpanded(snapshot).render(120).join("\n");
  assert.match(expanded, /✓ card-01/);
  assert.match(expanded, /▶ card-07/);
  assert.match(expanded, /ack_cli_data/);
  assert.match(expanded, /○ card-08/);
  assert.match(expanded, /card-14/);
  assert.match(expanded, /phase: writer-agents/);

  assert.match(renderStageProgressPlainText(snapshot), /6\/14/);
  assert.match(renderStageProgressCall({}, { bold: (text) => text, fg: (_token, text) => text }).render(40).join("\n"), /html-report/);
});

test("width tiers change neighbor count and stay inside the given width", () => {
  const snapshot = runningSixOfFourteen().snapshot();
  const wide = renderStageProgressCollapsed(snapshot).render(120);
  assert.match(wide.join("\n"), /card-05/);
  assert.match(wide.join("\n"), /card-09/);
  assert.ok(wide.length >= 6 && wide.length <= 7);
  assertWithinWidth(wide, 120);

  const medium = renderStageProgressCollapsed(snapshot).render(80);
  assert.doesNotMatch(medium.join("\n"), /card-05/);
  assert.match(medium.join("\n"), /card-06/);
  assert.match(medium.join("\n"), /card-09/);
  assert.ok(medium.length >= 5 && medium.length <= 6);
  assertWithinWidth(medium, 80);

  const narrow = renderStageProgressCollapsed(snapshot).render(60);
  const narrowText = narrow.join("\n");
  assert.match(narrowText, /6\/14/);
  assert.match(narrowText, /card-07/);
  assert.doesNotMatch(narrowText, /card-06/);
  assert.doesNotMatch(narrowText, /card-08/);
  assert.match(narrowText, /queued|ack_cli_data/);
  assert.ok(narrow.length <= 4);
  assertWithinWidth(narrow, 60);
});

test("failed items preempt the default window and missing fields degrade", () => {
  const withError = renderStageProgressCollapsed(runningWithEarlyFailures({
    "card-03": "artifact validation failed",
  }).snapshot()).render(120).join("\n");
  assert.match(withError, /! card-03/);
  assert.match(withError, /artifact validation failed/);
  assert.match(withError, /card-07/);
  assert.doesNotMatch(withError, /card-01/);

  const multi = renderStageProgressCollapsed(runningWithEarlyFailures({
    "card-01": "timeout",
    "card-02": "schema",
    "card-03": "validation failed",
  }).snapshot()).render(120).join("\n");
  assert.match(multi, /card-01/);
  assert.match(multi, /\+2 failed/);

  const legacy = tracker();
  legacy.applyChildProgress("card-01", { requestId: "legacy-1", transport: "legacy-chain", started: true });
  const legacyText = renderStageProgressCollapsed(legacy.snapshot()).render(100).join("\n");
  assert.match(legacyText, /card-01/);
  assert.match(legacyText, /running/);
  assert.doesNotMatch(legacyText, /undefined/);
});

test("legacy child progress without optional fields still updates counts", () => {
  const progress = tracker();
  progress.applyChildProgress("card-01", {
    requestId: "legacy-1",
    transport: "legacy-chain",
    started: true,
  });
  let snapshot = progress.snapshot();
  assert.equal(snapshot.items[0].status, "running");
  assert.equal(snapshot.transport, "legacy-chain");
  assert.equal(snapshot.items[0].currentTool, undefined);
  assert.equal(snapshot.completed, 0);

  progress.applyChildProgress("card-01", {
    requestId: "legacy-1",
    transport: "legacy-chain",
    started: true,
    currentTool: "read",
    toolCount: 1,
  });
  progress.markCompleted("card-01");
  snapshot = progress.snapshot();
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.total, 14);
  assert.equal(snapshot.items[0].currentTool, undefined);
});

test("awaiting-approval completes the stage and skipped counts toward completed", () => {
  const progress = tracker({ phase: STAGE_PROGRESS_PHASE.awaitingApproval });
  for (let index = 1; index <= 14; index += 1) progress.markCompleted(`card-${String(index).padStart(2, "0")}`);
  progress.completeStage();
  const snapshot = progress.snapshot();
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.completed, 14);
  assert.equal(snapshot.phase, STAGE_PROGRESS_PHASE.awaitingApproval);
  const done = renderStageProgressCollapsed(snapshot).render(80).join("\n");
  assert.match(done, /14\/14/);
  assert.match(done, /awaiting approval/);
  assert.ok(done.split("\n").length <= 3);

  const skipped = new HtmlReportStageProgressTracker({
    sessionId: "session-1",
    attempt: "B5_DESIGN:1:2026-08-18T00:00:00.000Z",
    entryStage: "B5_DESIGN",
    phase: STAGE_PROGRESS_PHASE.skipped,
    items: [{ id: "designer", role: "designer", label: "Report Designer", agent: "report-designer" }],
  });
  skipped.markSkipped("designer", "fixed debug skip");
  skipped.completeStage();
  const skipShot = skipped.snapshot();
  assert.equal(skipShot.completed, 1);
  assert.equal(skipShot.items[0].status, "skipped");
  assert.equal(skipShot.status, "completed");
  const skipRendered = renderStageProgressCollapsed(skipShot).render(80).join("\n");
  assert.match(skipRendered, /B5 Design/);
  assert.match(skipRendered, /1\/1/);
  assert.ok(skipRendered.split("\n").length <= 3);
});

test("single-item stages do not invent empty neighbor rows", () => {
  const review = new HtmlReportStageProgressTracker({
    sessionId: "session-1",
    attempt: "B4_REVIEW:1:2026-08-18T00:00:00.000Z",
    entryStage: "B4_REVIEW",
    phase: STAGE_PROGRESS_PHASE.reviewer,
    items: [{ id: "reviewer", role: "reviewer", label: "Report Reviewer", agent: "report-reviewer" }],
  });
  review.markStarted("reviewer", { requestId: "rev-1" });
  review.markUpdate("reviewer", { currentTool: "read", durationMs: 4000 });
  const rendered = renderStageProgressCollapsed(review.snapshot()).render(120);
  assert.match(rendered.join("\n"), /reviewer/);
  assert.doesNotMatch(rendered.join("\n"), /queued/);
  assert.ok(rendered.length <= 4);
});

test("session publish keeps the full snapshot and never calls widget or status APIs", () => {
  const updates = [];
  const widgets = [];
  const statuses = [];
  const session = new HtmlReportStageProgressSession(
    {
      sessionId: "session-1",
      attempt: "B2_WRITER:1:2026-08-18T00:00:00.000Z",
      entryStage: "B2_WRITER",
      phase: STAGE_PROGRESS_PHASE.writerAgents,
      items: [writerProgressSeed({ id: "card-01", title: "销售额" })],
    },
    {
      onUpdate: (update) => {
        updates.push(update);
        throw new Error("onUpdate boom");
      },
      ui: {
        setWidget: (key, value) => {
          widgets.push([key, value]);
          throw new Error("widget boom");
        },
        setStatus: (key, value) => {
          statuses.push([key, value]);
        },
      },
    },
  );
  session.tracker.markStarted("card-01", { requestId: "r1" });
  const published = session.publish();
  assert.equal(published.currentItemId, "card-01");
  assert.equal(updates.length, 1);
  assert.equal(extractStageProgress(updates[0].details).total, 1);
  assert.deepEqual(widgets, []);
  assert.deepEqual(statuses, []);

  const finished = session.finish("completed");
  assert.equal(finished.status, "completed");
  assert.deepEqual(widgets, []);
  assert.deepEqual(statuses, []);
});

test("renderResult restores a stored snapshot from final details", () => {
  const progress = tracker();
  for (let index = 1; index <= 14; index += 1) progress.markCompleted(`card-${String(index).padStart(2, "0")}`);
  progress.completeStage();
  const details = { status: "completed", progress: progress.snapshot() };
  const collapsed = renderStageProgressResult({ details, isError: false }, { expanded: false, isPartial: false }).render(80).join("\n");
  const expanded = renderStageProgressResult({ details, isError: false }, { expanded: true }).render(120).join("\n");
  assert.match(collapsed, /14\/14/);
  assert.ok(collapsed.split("\n").length <= 3);
  assert.match(expanded, /✓ card-01/);
  assert.equal(extractStageProgress({ stage: { progress: progress.snapshot() } }).completed, 14);
});

test("long CJK labels and errors clip to the renderer width", () => {
  const progress = tracker();
  progress.markFailed("card-01", "e".repeat(80));
  progress.markStarted("card-02", { requestId: "r2" });
  progress.markUpdate("card-02", { currentTool: "ack_cli_data", durationMs: 8000 });
  const lines = renderStageProgressCollapsed(progress.snapshot()).render(60);
  assertWithinWidth(lines, 60);
  assert.match(lines.join("\n"), /card-01|failed/);
});

test("truncate and bar helpers stay bounded", () => {
  assert.equal(truncateProgressText("abc", 3), "abc");
  assert.equal(truncateProgressText("abcd", 3), "ab…");
  assert.equal(formatProgressBar(6, 14, 14), "[######--------]");
  assert.equal(formatProgressBar(0, 0, 4), "[----]");
});
