import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  advance,
  buildWriterPrompt,
  cancel,
  htmlReportSessionDir,
  normalizeWriterChildValue,
  retryTask,
  runStageGate,
  runWriterForCard,
  runWriterStage,
  sanitizeSessionId,
  start,
  status,
  writerSchema,
} from "./html-report-stage-runner.mjs";
import {
  buildCodeBuddyChildArgs,
  extractJsonObject,
  resolveCodeBuddyCli,
  validateJsonSchema,
} from "./codebuddy-child.mjs";

function fixtureCard(cardId, overrides = {}) {
  return {
    id: cardId,
    chartType: "table",
    headingLevel: 2,
    query: {
      comparisons: ["YOY", "MOM"],
      request: {
        dimensions: ["bizDate", "regionId"],
        filters: {},
        metrics: ["saleAmt", "profitAmt"],
        pageNo: 1,
        pageSize: 500,
        statisticPolicy: "SALES_STORE_DAY_AVG",
        time: { startDate: "2026-01-01", endDate: "2026-01-31", grain: "DAY" },
      },
    },
    ...overrides,
  };
}

function fixtureResult(cards) {
  return {
    status: "confirmed",
    session_id: "test-session",
    title: "测试分析报告",
    cards,
  };
}

function makeSession({ cards } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hr-runner-test-"));
  const sessionDir = htmlReportSessionDir(root, "test-session");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "result.json"), JSON.stringify(fixtureResult(cards), null, 2));
  return { root, sessionDir, sessionId: "test-session" };
}

function writeCardFixtures(sessionDir, cardId, rows) {
  const cardDir = join(sessionDir, "data", "cards", cardId);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "entry.json"), JSON.stringify(rows, null, 2));
  writeFileSync(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: "0".repeat(64),
  }, null, 2));
  writeFileSync(join(cardDir, "entry.column-meta.json"), JSON.stringify({
    saleAmt: "销售额",
    profitAmt: "利润额",
    regionId: "区域",
    bizDate: "日期",
  }, null, 2));
}

function rowsFixture() {
  return [
    { bizDate: "2026-01-05", regionId: "east", saleAmt: 120000, profitAmt: 30000, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
    { bizDate: "2026-01-06", regionId: "west", saleAmt: 40000, profitAmt: 10000, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
    { bizDate: "2026-01-07", regionId: "north", saleAmt: 90000, profitAmt: 25000, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
  ];
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** Walk the gate from init to B2_WRITER running (A_CONFIG is an approvalRequired gate). */
function driveGateToWriter(root, sessionId) {
  assert.equal(runStageGate(root, sessionId, "init", ["--mode", "step", "--session-id", sessionId]).ok, true, "init");
  assert.equal(runStageGate(root, sessionId, "start", ["--stage", "A_CONFIG"]).ok, true, "start A_CONFIG");
  assert.equal(runStageGate(root, sessionId, "finish", ["--stage", "A_CONFIG"]).ok, true, "finish A_CONFIG");
  assert.equal(runStageGate(root, sessionId, "approve", ["--phrase", "继续"]).ok, true, "approve A_CONFIG");
  assert.equal(runStageGate(root, sessionId, "finish", ["--stage", "B0_PREFLIGHT"]).ok, true, "finish B0_PREFLIGHT");
  const gate = runStageGate(root, sessionId, "status");
  assert.equal(gate.payload?.state?.currentStage, "B2_WRITER", `expected B2_WRITER, got ${gate.payload?.state?.currentStage}`);
}

test("sanitizeSessionId strips unsafe chars", () => {
  assert.equal(sanitizeSessionId("a b/c:待"), "a_b_c__");
  assert.equal(sanitizeSessionId("safe.id-1_2"), "safe.id-1_2");
});

test("htmlReportSessionDir nests under .harness/state/html-report", () => {
  const dir = htmlReportSessionDir("/repo", "sid-1");
  assert.equal(dir, join("/repo", ".harness", "state", "html-report", "sid-1"));
});

test("writerSchema pins role and cardId", () => {
  const schema = writerSchema("card-001");
  const ok = validateJsonSchema({ role: "report-writer", taskId: "t1", cardId: "card-001", paragraphs: ["x"] }, schema);
  assert.equal(ok.ok, true);
  const badRole = validateJsonSchema({ role: "writer", taskId: "t1", cardId: "card-001", paragraphs: ["x"] }, schema);
  assert.equal(badRole.ok, false);
  const badCard = validateJsonSchema({ role: "report-writer", taskId: "t1", cardId: "other", paragraphs: ["x"] }, schema);
  assert.equal(badCard.ok, false);
  const extra = validateJsonSchema({ role: "report-writer", taskId: "t1", cardId: "card-001", paragraphs: ["x"], conclusion: "y" }, schema);
  assert.equal(extra.ok, false, "additionalProperties:false must reject conclusion");
});

test("buildWriterPrompt embeds cardId and capsule, forbids conclusion field", () => {
  const evidence = {
    query: { metrics: ["saleAmt"], dimensions: ["regionId"], time: { startDate: "2026-01-01", endDate: "2026-01-31", grain: "DAY" } },
    views: {},
    columnLabels: {},
  };
  const prompt = buildWriterPrompt({ cardId: "card-001", evidence });
  assert.match(prompt, /cardId=card-001/);
  assert.match(prompt, /capsule JSON/);
  assert.match(prompt, /不要用 conclusion 等其他字段名/);
});

test("normalizeWriterChildValue accepts exact paragraphs and aliases conclusion", () => {
  const exact = normalizeWriterChildValue({ role: "report-writer", taskId: "t1", cardId: "card-001", paragraphs: ["华东最高 12 万"] }, "card-001");
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.value.paragraphs, ["华东最高 12 万"]);

  const alias = normalizeWriterChildValue({ role: "report-writer", taskId: "t1", cardId: "card-001", conclusion: ["华南最低 3 万"] }, "card-001");
  assert.equal(alias.ok, true);
  assert.deepEqual(alias.value.paragraphs, ["华南最低 3 万"]);

  const wrongRole = normalizeWriterChildValue({ role: "writer", taskId: "t1", cardId: "card-001", paragraphs: ["x"] }, "card-001");
  assert.equal(wrongRole.ok, false);

  const wrongCard = normalizeWriterChildValue({ role: "report-writer", taskId: "t1", cardId: "other", paragraphs: ["x"] }, "card-001");
  assert.equal(wrongCard.ok, false);

  const empty = normalizeWriterChildValue({ role: "report-writer", taskId: "t1", cardId: "card-001", paragraphs: [] }, "card-001");
  assert.equal(empty.ok, false);
});

test("extractJsonObject pulls first object from prose", () => {
  assert.deepEqual(extractJsonObject('先写说明\n{"a": 1}\n结尾'), { a: 1 });
  assert.deepEqual(extractJsonObject('{"x": {"y": 2}} tail'), { x: { y: 2 } });
  assert.equal(extractJsonObject("没有 JSON"), null);
  assert.equal(extractJsonObject('[1,2,3]'), null);
});

test("buildCodeBuddyChildArgs disables all tools and pins model", () => {
  const args = buildCodeBuddyChildArgs({ cli: "/cli/codebuddy", prompt: "p", schema: { type: "object" }, sessionId: "s-1", model: "custom-local:gpt-5.5", tools: [] });
  assert.deepEqual(args.command, "/cli/codebuddy");
  const joined = args.args.join(" ");
  assert.match(joined, /--tools /);
  assert.match(joined, /--model custom-local:gpt-5.5/);
  assert.match(joined, /--session-id s-1/);
  assert.throws(() => buildCodeBuddyChildArgs({ cli: "relative", prompt: "p", schema: {}, sessionId: "s" }), /absolute/);
});

test("validateJsonSchema enforces required and const", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.equal(validateJsonSchema({ a: "x" }, schema).ok, true);
  assert.equal(validateJsonSchema({}, schema).ok, false);
});

test("runStageGate fails closed on stage-gate non-zero exit", () => {
  const { root, sessionId } = makeSession();
  try {
    // Init once so the session exists; then ask for an operation that must fail.
    assert.equal(runStageGate(root, sessionId, "init", ["--mode", "step", "--session-id", sessionId]).ok, true);
    const result = runStageGate(root, sessionId, "start", ["--stage", "B2_WRITER"]);
    // A_CONFIG is current; starting B2_WRITER is a stage mismatch → exit 1.
    assert.equal(result.ok, false);
    assert.match(result.error, /stage mismatch/i);
  } finally {
    cleanup(root);
  }
});

test("stage-gate init + start A_CONFIG via runStageGate (real stage-gate script)", () => {
  const { root, sessionDir, sessionId } = makeSession();
  try {
    const init = runStageGate(root, sessionId, "init", ["--mode", "step", "--session-id", sessionId]);
    assert.equal(init.ok, true, init.error);
    assert.equal(init.payload?.state?.currentStage, "A_CONFIG");
    const start0 = runStageGate(root, sessionId, "start", ["--stage", "A_CONFIG"]);
    assert.equal(start0.ok, true);
    const st = runStageGate(root, sessionId, "status");
    assert.equal(st.ok, true);
    assert.equal(st.payload?.state?.currentStage, "A_CONFIG");
    assert.equal(st.payload?.exists, true);
  } finally {
    cleanup(root);
  }
});

test("resolveCodeBuddyCli finds codebuddy on PATH", () => {
  const env = { PATH: process.env.PATH || "/usr/bin:/bin", CODEBUDDY_CLI: "" };
  const cli = resolveCodeBuddyCli(env);
  assert.ok(cli, "should resolve a codebuddy CLI path");
});

test("start + status + cancel on a fresh session", () => {
  const { root, sessionId } = makeSession();
  try {
    const started = start(root, sessionId);
    assert.equal(started.ok, true, started.error);
    const st = status(root, sessionId);
    assert.equal(st.ok, true);
    assert.equal(st.exists, true);
    assert.equal(st.state.currentStage, "A_CONFIG");
    const cancelled = cancel(root, sessionId);
    assert.equal(cancelled.ok, true, cancelled.error);
  } finally {
    cleanup(root);
  }
});

test("status on a missing session returns a clear prompt, not a crash", () => {
  const { root } = makeSession();
  try {
    const st = status(root, "no-such-session-xyz");
    assert.equal(st.ok, true);
    assert.equal(st.exists, false);
    assert.match(st.message, /尚未初始化/);
  } finally {
    cleanup(root);
  }
});

test("M1 runWriterForCard writes caption and persists violations on a bad number", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    const rows = rowsFixture();
    writeCardFixtures(sessionDir, cardId, rows);

    const fetchEntries = async (resultPath, opts) => {
      assert.equal(opts.cardId, cardId);
      return { producer: "fetch-entry.mjs", cards: [{ cardId, fetchStatus: "success", rowCount: rows.length, rowsSha256: "0".repeat(64) }] };
    };
    const runChild = async (opts) => {
      assert.equal(opts.schema.properties.cardId.const, cardId);
      // Valid child: paragraphs cite numbers present in the evidence views.
      return {
        status: "completed",
        code: "ok",
        value: { role: "report-writer", taskId: cardId, cardId, paragraphs: ["销售额最高的是1月5日东部，120000元；最低是1月6日西部，40000元"] },
        message: "ok",
      };
    };

    const attempt = await runWriterForCard(root, sessionId, cardId, { fetchEntries, runChild });
    assert.equal(attempt.status, "committed", attempt.error);
    const captionPath = join(sessionDir, "data", "cards", cardId, "caption.md");
    assert.equal(existsSync(captionPath), true);
    assert.ok(readFileSync(captionPath, "utf8").trim().length > 0);
    // writeCardCaption also writes an empty violations record next to caption.md
    const violationsPath = join(sessionDir, "data", "cards", cardId, "caption.md.violations.json");
    assert.equal(existsSync(violationsPath), true);

    // Bad number not in evidence → fail closed, no caption.md, violations persisted.
    const runChildBad = async () => ({
      status: "completed",
      code: "ok",
      value: { role: "report-writer", taskId: cardId, cardId, paragraphs: ["总额高达 999999 元"] },
      message: "ok",
    });
    const attempt2 = await runWriterForCard(root, sessionId, cardId, { fetchEntries, runChild: runChildBad });
    assert.equal(attempt2.status, "failed");
    assert.match(attempt2.error, /违规|caption/i);
    assert.equal(existsSync(join(sessionDir, "data", "cards", cardId, "caption.violations.json")), true);
  } finally {
    cleanup(root);
  }
});

test("M1 runWriterStage writes caption and advances gate to B2_MAIN (mocked fetch + child)", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    driveGateToWriter(root, sessionId);
    const rows = rowsFixture();
    writeCardFixtures(sessionDir, cardId, rows);

    const fetchEntries = async (resultPath, opts) => {
      assert.equal(opts.cardId, cardId);
      return { producer: "fetch-entry.mjs", cards: [{ cardId, fetchStatus: "success", rowCount: rows.length, rowsSha256: "0".repeat(64) }] };
    };
    const runChild = async (opts) => ({
      status: "completed",
      code: "ok",
      value: { role: "report-writer", taskId: cardId, cardId, paragraphs: ["销售额最高的是1月5日东部，120000元；最低是1月6日西部，40000元"] },
      message: "ok",
    });

    const outcome = await runWriterStage(root, sessionId, { fetchEntries, runChild });
    assert.equal(outcome.ok, true, outcome.message || outcome.error);
    assert.equal(existsSync(join(sessionDir, "data", "cards", cardId, "caption.md")), true);
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B2_MAIN", "gate should advance to B2_MAIN");
  } finally {
    cleanup(root);
  }
});

test("M1 runWriterStage isolates a failing card (mocked)", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    driveGateToWriter(root, sessionId);
    const rows = rowsFixture();
    writeCardFixtures(sessionDir, cardId, rows);

    const fetchEntries = async (resultPath, opts) => ({
      producer: "fetch-entry.mjs",
      cards: [{ cardId, fetchStatus: "success", rowCount: rows.length, rowsSha256: "0".repeat(64) }],
    });
    const runChild = async () => ({ status: "failed", code: "child_exit_nonzero", message: "child failed" });

    const outcome = await runWriterStage(root, sessionId, { fetchEntries, runChild });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /失败/);
    // caption.md must NOT be written; violations record IS persisted
    assert.equal(existsSync(join(sessionDir, "data", "cards", cardId, "caption.md")), false);
    assert.equal(existsSync(join(sessionDir, "data", "cards", cardId, "caption.violations.json")), true);
    // gate must NOT be advanced past B2_WRITER
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B2_WRITER");
  } finally {
    cleanup(root);
  }
});

test("M1 runWriterStage card isolation: one bad card does not block the next good card", async () => {
  const goodId = "card-good";
  const badId = "card-bad";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(goodId), fixtureCard(badId)] });
  try {
    driveGateToWriter(root, sessionId);
    writeCardFixtures(sessionDir, goodId, rowsFixture());
    writeCardFixtures(sessionDir, badId, rowsFixture());

    const fetchEntries = async (resultPath, opts) => ({
      producer: "fetch-entry.mjs",
      cards: [{ cardId: opts.cardId, fetchStatus: "success", rowCount: 3, rowsSha256: "0".repeat(64) }],
    });
    const runChild = async (opts) => {
      if (opts.schema.properties.cardId.const === badId) {
        return { status: "failed", code: "child_exit_nonzero", message: "bad card child failed" };
      }
      return {
        status: "completed",
        code: "ok",
        value: { role: "report-writer", taskId: opts.schema.properties.cardId.const, cardId: opts.schema.properties.cardId.const, paragraphs: ["销售额最高的是1月5日东部，120000元；最低是1月6日西部，40000元"] },
        message: "ok",
      };
    };

    const outcome = await runWriterStage(root, sessionId, { fetchEntries, runChild });
    assert.equal(outcome.ok, false, "stage must report failure");
    assert.deepEqual(outcome.failed.map((item) => item.cardId), [badId]);
    assert.deepEqual(outcome.succeeded, [goodId]);
    // good card caption written, bad card caption absent
    assert.equal(existsSync(join(sessionDir, "data", "cards", goodId, "caption.md")), true);
    assert.equal(existsSync(join(sessionDir, "data", "cards", badId, "caption.md")), false);
    // gate stays on B2_WRITER (not finished)
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B2_WRITER");

    // retry the bad card with a working child → committed
    const retryRunChild = async (opts) => ({
      status: "completed",
      code: "ok",
      value: { role: "report-writer", taskId: badId, cardId: badId, paragraphs: ["销售额最高的是1月5日东部，120000元；最低是1月6日西部，40000元"] },
      message: "ok",
    });
    const retried = await retryTask(root, sessionId, badId, { fetchEntries, runChild: retryRunChild });
    assert.equal(retried.ok, true, retried.error);
    assert.equal(existsSync(join(sessionDir, "data", "cards", badId, "caption.md")), true);
  } finally {
    cleanup(root);
  }
});

test("advance on a disabled stage reports 未启用 and does not change state", async () => {
  const { root, sessionDir, sessionId } = makeSession();
  try {
    // Real init/start so we have a valid stage-gate state, then hand-edit currentStage
    // into a disabled stage (B3_RESEARCH) to exercise the runner's disabled branch.
    assert.equal(runStageGate(root, sessionId, "init", ["--mode", "step", "--session-id", sessionId]).ok, true);
    assert.equal(runStageGate(root, sessionId, "start", ["--stage", "A_CONFIG"]).ok, true);
    const statePath = join(sessionDir, "debug", "pipeline-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.currentStage = "B3_RESEARCH";
    state.status = "paused";
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const outcome = await advance(root, sessionId);
    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /未启用/);
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(after.currentStage, "B3_RESEARCH", "state must not change on a disabled stage");
    assert.equal(after.status, "paused");
  } finally {
    cleanup(root);
  }
});
