import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import registerReportWriterFetch, { receiptFor } from "../../../extensions/report-writer-fetch/index.mjs";
import {
  initialWriterGuardState,
  parseWriterAssignment,
  WRITER_ACK_TOOL,
  WRITER_CAPTION_TOOL,
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

test("Writer allows ack then caption and blocks every other tool", () => {
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
    details: { receipt: successDetails(bound), evidence: { views: {} } },
    isError: false,
  });
  assert.equal(afterFetch.fetchResult.fetchStatus, "success");

  const readBlocked = writerToolDecision(bound, afterFetch, {
    toolName: "read",
    input: { path: bound.dataPath },
  });
  assert.equal(readBlocked.decision.block, true);
  assert.match(readBlocked.decision.reason, /submit_card_caption/);

  const caption = writerToolDecision(bound, afterFetch, {
    toolCallId: "caption-1",
    toolName: WRITER_CAPTION_TOOL,
    input: { paragraphs: ["最高为 2。"], pointers: ["/views/topN-x"] },
  });
  assert.equal(caption.decision, undefined);
  const afterCaption = writerToolResultState(bound, caption.state, {
    toolCallId: "caption-1",
    toolName: WRITER_CAPTION_TOOL,
    details: successDetails(bound),
    isError: false,
  });
  assert.equal(afterCaption.captionSubmitted, true);

  const secondCaption = writerToolDecision(bound, afterCaption, {
    toolCallId: "caption-2",
    toolName: WRITER_CAPTION_TOOL,
    input: { paragraphs: ["最高为 2。"], pointers: ["/views/topN-x"] },
  });
  assert.equal(secondCaption.decision.block, true);

  const secondFetch = writerToolDecision(bound, afterFetch, {
    toolCallId: "fetch-2",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  });
  assert.equal(secondFetch.decision.block, true);
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
  assert.equal(failed.fetchAttempts, 1);
  assert.ok(failed.terminalFailure?.error);
  const retry = writerToolDecision(bound, failed, {
    toolCallId: "retry-fetch",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  });
  assert.equal(retry.decision.block, true);
  assert.match(retry.decision.reason, /最多调用一次/);
});

test("ack_cli_data returns evidence then submit_card_caption writes the receipt", async (t) => {
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
  assert.deepEqual(tools.map((tool) => tool.name), [WRITER_ACK_TOOL, WRITER_CAPTION_TOOL]);

  const fetchEvent = {
    toolCallId: "typed-writer-fetch",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  };
  assert.equal(await handlers.get("tool_call")[0](fetchEvent), undefined);
  const result = await tools[0].execute(fetchEvent.toolCallId, fetchEvent.input);
  assert.equal(result.terminate, false);
  assert.equal(result.details.receipt.fetchStatus, "success");
  assert.ok(result.details.evidence.views["topN-custNum-manageAreaId"]);
  handlers.get("tool_result")[0]({
    ...fetchEvent,
    details: result.details,
    isError: false,
  });
  assert.deepEqual(activeToolSets.at(-1), [WRITER_CAPTION_TOOL]);

  const captionEvent = {
    toolCallId: "typed-writer-caption",
    toolName: WRITER_CAPTION_TOOL,
    input: {
      paragraphs: ["来客最高为 12。"],
      pointers: ["/views/topN-custNum-manageAreaId/rows/0"],
    },
  };
  assert.equal(await handlers.get("tool_call")[0](captionEvent), undefined);
  const caption = await tools[1].execute(captionEvent.toolCallId, captionEvent.input);
  assert.equal(caption.terminate, true);
  const receipt = {
    cardId,
    fetchStatus: "success",
    dataPath: bound.dataPath,
    metaPath: bound.metaPath,
    rowCount: 1,
    rowsSha256: rowsSha256(rows),
  };
  assert.deepEqual(validateWriterReturn(receipt, bound), { ok: true, errors: [] });
  assert.deepEqual(caption.details, receipt);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), receipt);
  assert.match(await readFile(join(cardDir, "caption.md"), "utf8"), /来客最高为 12/);
});

test("failed submit_card_caption still writes a failed receipt and terminates", async (t) => {
  const stateRoot = join(projectRoot, ".harness", "state", "html-report");
  await mkdir(stateRoot, { recursive: true });
  const typedSession = await mkdtemp(join(stateRoot, "typed-writer-caption-fail-"));
  const runtimeDir = await mkdtemp(join(projectRoot, ".harness", "typed-writer-caption-fail-runtime-"));
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
  registerReportWriterFetch({
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    setActiveTools() {},
  });
  await handlers.get("before_agent_start")[0]({ prompt });
  const fetchEvent = {
    toolCallId: "fail-writer-fetch",
    toolName: WRITER_ACK_TOOL,
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  };
  await handlers.get("tool_call")[0](fetchEvent);
  await tools[0].execute(fetchEvent.toolCallId, fetchEvent.input);

  const caption = await tools[1].execute("fail-writer-caption", {
    paragraphs: ["来客最高为 999。"],
    pointers: ["/views/topN-custNum-manageAreaId/rows/0"],
  });
  assert.equal(caption.terminate, true);
  assert.equal(caption.details.fetchStatus, "failed");
  assert.match(caption.details.error, /999/);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), caption.details);
  await assert.rejects(() => readFile(join(cardDir, "caption.md"), "utf8"), /ENOENT/);
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
