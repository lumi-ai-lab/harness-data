import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import registerReportWriterFetch, { receiptFor } from "../../../extensions/report-writer-fetch/index.mjs";
import {
  initialWriterGuardState,
  parseWriterAssignment,
  WRITER_ACK_TOOL,
  writerUnvalidatedSubmitFailureState,
  writerToolDecision,
  writerToolResultState,
} from "../../../extensions/report-writer-fetch/lifecycle.mjs";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "../../../extensions/shared/subagent-structured-output-capture.mjs";
import { buildWriterReturnSchema, validateWriterReturn } from "../scripts/writer-return.mjs";
import { rowsSha256 } from "../scripts/fetch-entry.mjs";

const projectRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const sessionDir = join(projectRoot, ".harness", "state", "html-report", "writer-guard-session");

function assignment(overrides = {}) {
  const cardId = overrides.cardId || "card-1";
  const session = overrides.sessionDir || sessionDir;
  const resultPath = overrides.resultPath || join(session, "result.json");
  return [
    `按 report-writer 处理 cardId=${cardId}`,
    `SESSION=${session}`,
    `result.json=${resultPath}`,
  ].join("\n");
}

function contract() {
  const value = parseWriterAssignment(assignment(), { projectRoot });
  assert.equal(value.ok, true, value.errors?.join("; "));
  return value;
}

function successDetails(bound) {
  return {
    cardId: bound.cardId,
    fetchStatus: "success",
    dataPath: bound.dataPath,
    metaPath: bound.metaPath,
    rowCount: 2,
    rowsSha256: "a".repeat(64),
  };
}

test("Writer assignment binds one safe cardId and one current-project result.json", () => {
  const parsed = contract();
  assert.equal(parsed.cardId, "card-1");
  assert.equal(parsed.resultPath, join(sessionDir, "result.json"));
  assert.equal(parsed.metaPath, join(sessionDir, "data", "cards", "card-1", "entry.meta.json"));
  assert.equal(parsed.dataPath, join(sessionDir, "data", "cards", "card-1", "entry.json"));

  assert.equal(parseWriterAssignment(`${assignment()}\nSESSION=${sessionDir}`, { projectRoot }).ok, false);
  assert.equal(parseWriterAssignment(assignment({ resultPath: "/tmp/other/result.json" }), { projectRoot }).ok, false);
  assert.equal(parseWriterAssignment(assignment({ cardId: "../escape" }), { projectRoot }).ok, false);
  assert.equal(parseWriterAssignment("missing assignment", { projectRoot }).ok, false);
});

test("Writer allows only one ack_cli_data and blocks every other tool", () => {
  const bound = contract();
  let transition = writerToolDecision(bound, initialWriterGuardState(), {
    toolCallId: "fetch-1",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  });
  assert.equal(transition.decision, undefined);
  const afterFetch = writerToolResultState(bound, transition.state, {
    toolCallId: "fetch-1",
    toolName: WRITER_ACK_TOOL,
    details: successDetails(bound),
    isError: false,
  });
  assert.equal(afterFetch.fetchResult.fetchStatus, "success");

  const readBlocked = writerToolDecision(bound, afterFetch, {
    toolName: "read",
    input: { path: bound.dataPath },
  });
  assert.equal(readBlocked.decision.block, true);
  assert.match(readBlocked.decision.reason, /最多调用一次|只允许调用 ack_cli_data/);

  const submitBlocked = writerToolDecision(bound, afterFetch, {
    toolName: "submit_writer_result",
    input: successDetails(bound),
  });
  assert.equal(submitBlocked.decision.block, true);

  const secondFetch = writerToolDecision(bound, afterFetch, {
    toolCallId: "fetch-2",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  });
  assert.equal(secondFetch.decision.block, true);
  assert.match(secondFetch.decision.reason, /最多调用一次/);
});

test("Writer rejects wrong fetch arguments", () => {
  const bound = contract();
  const wrong = writerToolDecision(bound, initialWriterGuardState(), {
    toolCallId: "fetch-wrong",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: "other-card" },
  });
  assert.equal(wrong.decision.block, true);
  assert.match(wrong.decision.reason, /参数必须逐字等于/);
});

test("schema-invalid first fetch is consumed before any retry", () => {
  const bound = contract();
  const failed = writerUnvalidatedSubmitFailureState(bound, initialWriterGuardState(), {
    toolCallId: "invalid-fetch",
    toolName: WRITER_ACK_TOOL,
    isError: true,
    result: { content: [{ type: "text", text: "arguments failed schema validation" }] },
  });
  assert.equal(failed.structuredAttempts, 1);
  const retry = writerToolDecision(bound, failed, {
    toolCallId: "retry-fetch",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  });
  assert.equal(retry.decision.block, true);
  assert.match(retry.decision.reason, /最多调用一次/);
});

test("ack_cli_data returns the receipt and terminates", async (t) => {
  const stateRoot = join(projectRoot, ".harness", "state", "html-report");
  await mkdir(stateRoot, { recursive: true });
  const typedSession = await mkdtemp(join(stateRoot, "typed-writer-terminal-"));
  const runtimeDir = await mkdtemp(join(projectRoot, ".harness", "typed-writer-runtime-"));
  t.after(() => rm(typedSession, { recursive: true, force: true }));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));

  const cardId = "card-1";
  const cardDir = join(typedSession, "data", "cards", cardId);
  await mkdir(cardDir, { recursive: true });
  const rows = [{ manageAreaId: "CN01", custNum: 12 }];
  const resultPath = join(typedSession, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{
      id: cardId,
      query: {
        request: {
          metrics: ["custNum"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-07-01", endDate: "2026-07-02" },
          dimensions: ["manageAreaId"],
          filters: {},
          pageNo: 1,
          pageSize: 500,
        },
        comparisons: [],
      },
    }],
  }));
  await writeFile(join(cardDir, "entry.json"), `${JSON.stringify(rows)}\n`);
  await writeFile(
    join(cardDir, "entry.meta.json"),
    `${JSON.stringify({ rowCount: rows.length, rowsSha256: rowsSha256(rows) })}\n`
  );

  const prompt = assignment({ sessionDir: typedSession });
  const bound = parseWriterAssignment(prompt, { projectRoot });
  assert.equal(bound.ok, true, bound.errors?.join("; "));
  const schemaPath = join(runtimeDir, "schema.json");
  const outputPath = join(runtimeDir, "output.json");
  await writeFile(schemaPath, JSON.stringify(buildWriterReturnSchema(bound)));
  const previousSchema = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
  const previousCapture = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
  process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
  process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
  t.after(() => {
    if (previousSchema === undefined) delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
    else process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = previousSchema;
    if (previousCapture === undefined) delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
    else process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = previousCapture;
  });

  const handlers = new Map();
  const tools = [];
  const activeToolSets = [];
  registerReportWriterFetch({
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    setActiveTools(names) {
      activeToolSets.push(names);
    },
  });
  await handlers.get("before_agent_start")[0]({ prompt });
  assert.deepEqual(activeToolSets, [[WRITER_ACK_TOOL]]);
  assert.deepEqual(tools.map((tool) => tool.name), [WRITER_ACK_TOOL]);

  const fetchEvent = {
    toolCallId: "typed-writer-fetch",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  };
  assert.equal(await handlers.get("tool_call")[0](fetchEvent), undefined);
  const result = await tools[0].execute(fetchEvent.toolCallId, fetchEvent.input);
  assert.equal(result.terminate, true);
  const receipt = {
    cardId,
    fetchStatus: "success",
    dataPath: bound.dataPath,
    metaPath: bound.metaPath,
    rowCount: 1,
    rowsSha256: rowsSha256(rows),
  };
  assert.deepEqual(validateWriterReturn(receipt, bound), { ok: true, errors: [] });
  assert.deepEqual(result.details, receipt);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), receipt);
});

test("receiptFor maps fetch adapter output to the parent receipt", () => {
  assert.deepEqual(receiptFor({
    cardId: "c1",
    fetchStatus: "success",
    dataPath: "/tmp/e.json",
    metaPath: "/tmp/m.json",
    rowCount: 3,
    rowsSha256: "b".repeat(64),
  }), {
    cardId: "c1",
    fetchStatus: "success",
    dataPath: "/tmp/e.json",
    metaPath: "/tmp/m.json",
    rowCount: 3,
    rowsSha256: "b".repeat(64),
  });
  assert.deepEqual(receiptFor({
    cardId: "c1",
    fetchStatus: "failed",
    error: "timeout",
  }), {
    cardId: "c1",
    fetchStatus: "failed",
    dataPath: null,
    metaPath: null,
    error: "timeout",
  });
});
