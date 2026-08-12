import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import registerReportWriterFetch from "../../../extensions/report-writer-fetch/index.mjs";
import {
  initialWriterGuardState,
  parseWriterAssignment,
  WRITER_SUBMIT_TOOL,
  writerUnvalidatedSubmitFailureState,
  writerToolDecision,
  writerToolResultState,
} from "../../../extensions/report-writer-fetch/lifecycle.mjs";
import {
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "../../../extensions/shared/subagent-structured-output-capture.mjs";
import { buildWriterReturnSchema } from "../scripts/writer-return.mjs";

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
    "本卡配置: {}",
    "用户问题: 测试",
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

function failedReturn(bound, error = "fetch failed") {
  return {
    cardId: bound.cardId,
    fetchStatus: "failed",
    dataPath: null,
    metaPath: null,
    error,
    analysis: {
      summary: "取数失败，未形成业务判断。",
      findings: [],
      recommendations: [],
    },
  };
}

function successReturn(bound) {
  return {
    cardId: bound.cardId,
    fetchStatus: "success",
    dataPath: bound.dataPath,
    metaPath: bound.metaPath,
    analysis: {
      summary: "本卡包含两行明细。",
      findings: [{ statement: "首行含日期字段。", evidence: ["entry.json#/0"] }],
      recommendations: ["建议结合运营动作复盘。"],
    },
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

test("Writer success path is fetch once, meta read once, data read once, typed submit once", () => {
  const bound = contract();
  let state = initialWriterGuardState();

  let transition = writerToolDecision(bound, state, {
    toolCallId: "fetch-1",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  });
  assert.equal(transition.decision, undefined);
  state = writerToolResultState(bound, transition.state, {
    toolCallId: "fetch-1",
    toolName: "fetch_report_entry",
    details: successDetails(bound),
    isError: false,
  });
  assert.equal(state.fetchResult.fetchStatus, "success");

  transition = writerToolDecision(bound, state, {
    toolCallId: "meta-1",
    toolName: "read",
    input: { path: bound.metaPath },
  });
  assert.equal(transition.decision, undefined);
  state = writerToolResultState(bound, transition.state, {
    toolCallId: "meta-1",
    toolName: "read",
    content: [{ type: "text", text: "{}" }],
    isError: false,
  });

  transition = writerToolDecision(bound, state, {
    toolCallId: "data-1",
    toolName: "read",
    input: { filePath: bound.dataPath },
  });
  assert.equal(transition.decision, undefined);
  state = writerToolResultState(bound, transition.state, {
    toolCallId: "data-1",
    toolName: "read",
    content: [{ type: "text", text: "[]" }],
    isError: false,
  });

  transition = writerToolDecision(bound, state, {
    toolName: WRITER_SUBMIT_TOOL,
    input: { value: successReturn(bound) },
  });
  assert.equal(transition.decision, undefined);
  const afterFinal = writerToolDecision(bound, transition.state, {
    toolName: "read",
    input: { path: bound.dataPath },
  });
  assert.equal(afterFinal.decision.block, true);
  assert.match(afterFinal.decision.reason, /submit_writer_result 已调用/);
});

test("Writer permits only the exact ordered meta/data read pair while meta is pending", () => {
  const bound = contract();
  let state = writerToolDecision(bound, initialWriterGuardState(), {
    toolCallId: "fetch-batched-read",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  }).state;
  state = writerToolResultState(bound, state, {
    toolCallId: "fetch-batched-read",
    toolName: "fetch_report_entry",
    details: successDetails(bound),
  });

  let transition = writerToolDecision(bound, state, {
    toolCallId: "meta-batched-read",
    toolName: "read",
    input: { path: bound.metaPath },
  });
  assert.equal(transition.decision, undefined);
  state = transition.state;

  transition = writerToolDecision(bound, state, {
    toolCallId: "data-batched-read",
    toolName: "read",
    input: { path: bound.dataPath },
  });
  assert.equal(transition.decision, undefined);
  state = transition.state;
  assert.equal(Object.keys(state.pending).length, 2);

  // Parallel tool results are matched by toolCallId, so either result order is safe.
  state = writerToolResultState(bound, state, {
    toolCallId: "data-batched-read",
    toolName: "read",
    content: [{ type: "text", text: "[]" }],
  });
  state = writerToolResultState(bound, state, {
    toolCallId: "meta-batched-read",
    toolName: "read",
    content: [{ type: "text", text: "{}" }],
  });
  assert.equal(Object.keys(state.pending).length, 0);
  assert.equal(state.readSuccess[bound.metaPath], 1);
  assert.equal(state.readSuccess[bound.dataPath], 1);

  transition = writerToolDecision(bound, state, {
    toolName: WRITER_SUBMIT_TOOL,
    input: { value: successReturn(bound) },
  });
  assert.equal(transition.decision, undefined);
});

test("Writer still rejects every non-exact call while the meta read is pending", () => {
  const bound = contract();
  let state = writerToolDecision(bound, initialWriterGuardState(), {
    toolCallId: "fetch-before-pending",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  }).state;
  state = writerToolResultState(bound, state, {
    toolCallId: "fetch-before-pending",
    toolName: "fetch_report_entry",
    details: successDetails(bound),
  });
  state = writerToolDecision(bound, state, {
    toolCallId: "meta-pending",
    toolName: "read",
    input: { path: bound.metaPath },
  }).state;

  for (const event of [
    { toolCallId: "duplicate-meta", toolName: "read", input: { path: bound.metaPath } },
    { toolCallId: "unrelated-read", toolName: "read", input: { path: join(sessionDir, "other.json") } },
    { toolCallId: "interleaved-fetch", toolName: "fetch_report_entry", input: { resultPath: bound.resultPath, cardId: bound.cardId } },
  ]) {
    const blocked = writerToolDecision(bound, state, event);
    assert.equal(blocked.decision.block, true);
    assert.match(blocked.decision.reason, /上一工具结果尚未返回/);
  }
});

test("Writer rejects wrong fetch arguments, ordering, duplicates, coordination, and unrelated reads", () => {
  const bound = contract();
  for (const event of [
    {
      toolName: "fetch_report_entry",
      input: { resultPath: bound.resultPath, cardId: "other-card" },
    },
    { toolName: "read", input: { path: bound.metaPath } },
    { toolName: "contact_supervisor", input: {} },
    { toolName: "intercom", input: {} },
  ]) {
    const transition = writerToolDecision(bound, initialWriterGuardState(), event);
    assert.equal(transition.decision.block, true);
    assert.ok(transition.state.terminalFailure);
  }

  let state = writerToolDecision(bound, initialWriterGuardState(), {
    toolCallId: "fetch",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  }).state;
  state = writerToolResultState(bound, state, {
    toolCallId: "fetch",
    toolName: "fetch_report_entry",
    details: successDetails(bound),
  });
  const duplicateFetch = writerToolDecision(bound, state, {
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  });
  assert.equal(duplicateFetch.decision.block, true);
  assert.match(duplicateFetch.decision.reason, /最多调用一次/);
  const dataBeforeMeta = writerToolDecision(bound, state, {
    toolName: "read",
    input: { path: bound.dataPath },
  });
  assert.equal(dataBeforeMeta.decision.block, true);
  assert.match(dataBeforeMeta.decision.reason, /metaPath 后 dataPath/);
});

test("any fetch/read tool_result failure terminates I/O and permits only one exact failed return", () => {
  const bound = contract();
  let state = writerToolDecision(bound, initialWriterGuardState(), {
    toolCallId: "fetch-fail",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  }).state;
  state = writerToolResultState(bound, state, {
    toolCallId: "fetch-fail",
    toolName: "fetch_report_entry",
    isError: true,
    content: [{ type: "text", text: "ETIMEDOUT" }],
  });
  assert.match(state.terminalFailure.error, /ETIMEDOUT/);
  const retry = writerToolDecision(bound, state, {
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  });
  assert.equal(retry.decision.block, true);
  assert.match(retry.decision.reason, /禁止后续 I\/O.*重试/);

  const wrongFinal = writerToolDecision(bound, state, {
    toolName: WRITER_SUBMIT_TOOL,
    input: { ...failedReturn(bound), cardId: "other-card" },
  });
  assert.equal(wrongFinal.decision.block, true);
  assert.equal(wrongFinal.state.structuredAttempts, 1);
  assert.match(
    writerToolDecision(bound, wrongFinal.state, {
      toolName: WRITER_SUBMIT_TOOL,
      input: failedReturn(bound),
    }).decision.reason,
    /最多调用一次/
  );

  let semantic = writerToolDecision(bound, initialWriterGuardState(), {
    toolCallId: "fetch-semantic-fail",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  }).state;
  semantic = writerToolResultState(bound, semantic, {
    toolCallId: "fetch-semantic-fail",
    toolName: "fetch_report_entry",
    details: {
      cardId: bound.cardId,
      fetchStatus: "failed",
      dataPath: null,
      metaPath: null,
      error: "backend failed",
    },
  });
  assert.match(semantic.terminalFailure.error, /backend failed/);
  const inventedFinal = writerToolDecision(bound, semantic, {
    toolName: WRITER_SUBMIT_TOOL,
    input: failedReturn(bound, "invented failure"),
  });
  assert.equal(inventedFinal.decision.block, true);
  assert.match(inventedFinal.decision.reason, /逐字等于.*真实终端错误/);
  const exactFinal = writerToolDecision(bound, semantic, {
    toolName: WRITER_SUBMIT_TOOL,
    input: failedReturn(bound, "backend failed"),
  });
  assert.equal(exactFinal.decision, undefined);
  assert.equal(exactFinal.state.structuredAttempts, 1);

  let readFailure = writerToolDecision(bound, initialWriterGuardState(), {
    toolCallId: "fetch-before-read-fail",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  }).state;
  readFailure = writerToolResultState(bound, readFailure, {
    toolCallId: "fetch-before-read-fail",
    toolName: "fetch_report_entry",
    details: successDetails(bound),
  });
  readFailure = writerToolDecision(bound, readFailure, {
    toolCallId: "meta-read-fail",
    toolName: "read",
    input: { path: bound.metaPath },
  }).state;
  readFailure = writerToolResultState(bound, readFailure, {
    toolCallId: "meta-read-fail",
    toolName: "read",
    isError: true,
    content: [{ type: "text", text: "meta read failed" }],
  });
  assert.match(readFailure.terminalFailure.error, /meta read failed/);
  assert.equal(writerToolDecision(bound, readFailure, {
    toolName: WRITER_SUBMIT_TOOL,
    input: failedReturn(bound, "meta read failed"),
  }).decision, undefined);
});

test("typed Writer terminal captures the exact parent output and terminates without structured_output", async (t) => {
  const stateRoot = join(projectRoot, ".harness", "state", "html-report");
  await mkdir(stateRoot, { recursive: true });
  const typedSession = await mkdtemp(join(stateRoot, "typed-writer-terminal-"));
  const runtimeDir = await mkdtemp(join(projectRoot, ".harness", "typed-writer-runtime-"));
  t.after(() => rm(typedSession, { recursive: true, force: true }));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));

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
  const pi = {
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
  };
  registerReportWriterFetch(pi);
  await handlers.get("before_agent_start")[0]({ prompt });
  assert.deepEqual(activeToolSets, [["read", "fetch_report_entry", WRITER_SUBMIT_TOOL]]);
  assert.deepEqual(tools.map((tool) => tool.name), ["fetch_report_entry", WRITER_SUBMIT_TOOL]);
  const fetchTool = tools.find((tool) => tool.name === "fetch_report_entry");
  const fetchGuidelines = fetchTool.promptGuidelines.join("\n");
  assert.match(fetchGuidelines, /failure through submit_writer_result/);
  assert.doesNotMatch(fetchGuidelines, /failure through structured_output/);

  const fetchEvent = {
    toolCallId: "typed-writer-fetch",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  };
  assert.equal(await handlers.get("tool_call")[0](fetchEvent), undefined);
  await handlers.get("tool_result")[0]({
    ...fetchEvent,
    details: successDetails(bound),
    isError: false,
  });
  for (const [index, path] of [bound.metaPath, bound.dataPath].entries()) {
    const readEvent = {
      toolCallId: `typed-writer-read-${index}`,
      toolName: "read",
      input: { path },
    };
    assert.equal(await handlers.get("tool_call")[0](readEvent), undefined);
    await handlers.get("tool_result")[0]({
      ...readEvent,
      content: [{ type: "text", text: index === 0 ? "{}" : "[]" }],
      isError: false,
    });
  }

  const value = successReturn(bound);
  const transported = { ...value, analysis: JSON.stringify(value.analysis) };
  const terminal = tools.find((tool) => tool.name === WRITER_SUBMIT_TOOL);
  assert.equal(terminal.parameters.oneOf[0].properties.analysis.type, "object");
  assert.equal(terminal.parameters.oneOf[1].properties.analysis.type, "object");
  const prepared = terminal.prepareArguments(transported);
  assert.deepEqual(prepared, value);
  const canonicalFailure = failedReturn(bound, "AUTH_TOKEN_FAILED: unable to obtain token");
  assert.deepEqual(terminal.prepareArguments({
    ...canonicalFailure,
    dataPath: "null",
    metaPath: "null",
    analysis: JSON.stringify(canonicalFailure.analysis),
  }), canonicalFailure, "the exact relay failure transport is restored before strict validation");
  assert.deepEqual(terminal.prepareArguments({
    ...canonicalFailure,
    dataPath: "null",
  }), {
    ...canonicalFailure,
    dataPath: "null",
  }, "a partial string-null pair remains invalid");
  assert.deepEqual(terminal.prepareArguments({
    ...canonicalFailure,
    fetchStatus: "success",
    dataPath: "null",
    metaPath: "null",
  }), {
    ...canonicalFailure,
    fetchStatus: "success",
    dataPath: "null",
    metaPath: "null",
  }, "success payloads never inherit the failure transport shim");
  await assert.rejects(
    terminal.execute("unapproved-writer-submit", prepared),
    /not authorized by the Writer guard/
  );
  // The rejected direct execution consumes this extension instance's terminal,
  // so create a fresh registration for the normal authorized path below.
  const freshHandlers = new Map();
  const freshTools = [];
  const freshPi = {
    on(event, handler) {
      const list = freshHandlers.get(event) || [];
      list.push(handler);
      freshHandlers.set(event, list);
    },
    registerTool(tool) {
      freshTools.push(tool);
    },
    setActiveTools() {},
  };
  registerReportWriterFetch(freshPi);
  await freshHandlers.get("before_agent_start")[0]({ prompt });
  const freshFetch = freshTools.find((tool) => tool.name === "fetch_report_entry");
  const freshFetchEvent = {
    toolCallId: "typed-writer-fresh-fetch",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  };
  assert.equal(await freshHandlers.get("tool_call")[0](freshFetchEvent), undefined);
  await freshHandlers.get("tool_result")[0]({
    ...freshFetchEvent,
    details: successDetails(bound),
    isError: false,
  });
  for (const [index, path] of [bound.metaPath, bound.dataPath].entries()) {
    const readEvent = {
      toolCallId: `typed-writer-fresh-read-${index}`,
      toolName: "read",
      input: { path },
    };
    assert.equal(await freshHandlers.get("tool_call")[0](readEvent), undefined);
    await freshHandlers.get("tool_result")[0]({
      ...readEvent,
      content: [{ type: "text", text: index === 0 ? "{}" : "[]" }],
      isError: false,
    });
  }
  const freshTerminal = freshTools.find((tool) => tool.name === WRITER_SUBMIT_TOOL);
  const submitEvent = {
    toolCallId: "typed-writer-submit",
    toolName: WRITER_SUBMIT_TOOL,
    input: {
      analysis: prepared.analysis,
      metaPath: prepared.metaPath,
      dataPath: prepared.dataPath,
      fetchStatus: prepared.fetchStatus,
      cardId: prepared.cardId,
    },
  };
  assert.equal(await freshHandlers.get("tool_call")[0](submitEvent), undefined);
  assert.throws(
    () => terminal.prepareArguments({ ...value, analysis: "{" }),
    /analysis string must contain one JSON object/
  );
  assert.throws(
    () => terminal.prepareArguments({ ...value, analysis: JSON.stringify([]) }),
    /analysis string must contain one JSON object/
  );
  assert.throws(
    () => terminal.prepareArguments({
      ...value,
      analysis: JSON.stringify(JSON.stringify(value.analysis)),
    }),
    /analysis string must contain one JSON object/
  );
  const result = await freshTerminal.execute(submitEvent.toolCallId, prepared);
  assert.equal(result.terminate, true);
  assert.match(result.content[0].text, /structured output captured/);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), value);
  assert.deepEqual(result.details.writerReturn, value);

  // Exercise the exact real relay failure shape end to end: nested analysis
  // arrives as JSON text and JSON null paths arrive as the string "null".
  await rm(outputPath);
  const failureHandlers = new Map();
  const failureTools = [];
  registerReportWriterFetch({
    on(event, handler) {
      const list = failureHandlers.get(event) || [];
      list.push(handler);
      failureHandlers.set(event, list);
    },
    registerTool(tool) {
      failureTools.push(tool);
    },
    setActiveTools() {},
  });
  await failureHandlers.get("before_agent_start")[0]({ prompt });
  const failureFetchEvent = {
    toolCallId: "typed-writer-failure-fetch",
    toolName: "fetch_report_entry",
    input: { resultPath: bound.resultPath, cardId: bound.cardId },
  };
  assert.equal(await failureHandlers.get("tool_call")[0](failureFetchEvent), undefined);
  const actualError = "AUTH_TOKEN_FAILED: unable to obtain Indicators token";
  await failureHandlers.get("tool_result")[0]({
    ...failureFetchEvent,
    isError: false,
    details: {
      cardId: bound.cardId,
      fetchStatus: "failed",
      dataPath: null,
      metaPath: null,
      error: actualError,
    },
  });
  const expectedFailure = failedReturn(bound, actualError);
  const failureTerminal = failureTools.find((tool) => tool.name === WRITER_SUBMIT_TOOL);
  const relayedFailure = failureTerminal.prepareArguments({
    ...expectedFailure,
    dataPath: "null",
    metaPath: "null",
    analysis: JSON.stringify(expectedFailure.analysis),
  });
  const failureSubmitEvent = {
    toolCallId: "typed-writer-failure-submit",
    toolName: WRITER_SUBMIT_TOOL,
    input: relayedFailure,
  };
  assert.equal(await failureHandlers.get("tool_call")[0](failureSubmitEvent), undefined);
  const failureResult = await failureTerminal.execute(
    failureSubmitEvent.toolCallId,
    relayedFailure
  );
  assert.equal(failureResult.terminate, true);
  assert.deepEqual(failureResult.details.writerReturn, expectedFailure);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), expectedFailure);
});

test("schema-invalid first Writer typed submit is consumed before any corrected retry", () => {
  const bound = contract();
  const initial = initialWriterGuardState();
  const failed = writerUnvalidatedSubmitFailureState(bound, initial, {
    toolCallId: "invalid-writer-submit",
    toolName: WRITER_SUBMIT_TOOL,
    isError: true,
    result: { content: [{ type: "text", text: "arguments failed schema validation" }] },
  });
  assert.equal(failed.structuredAttempts, 1);
  assert.match(failed.terminalFailure.error, /arguments failed schema validation/);
  const corrected = writerToolDecision(bound, failed, {
    toolCallId: "corrected-writer-submit",
    toolName: WRITER_SUBMIT_TOOL,
    input: successReturn(bound),
  });
  assert.equal(corrected.decision.block, true);
  assert.match(corrected.decision.reason, /最多调用一次/);
});

test("schema-invalid first Writer typed submit removes every tool and fails closed", async () => {
  const handlers = new Map();
  const activeToolSets = [];
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    setActiveTools(names) {
      activeToolSets.push(names);
    },
  };
  registerReportWriterFetch(pi);
  await handlers.get("before_agent_start")[0]({ prompt: assignment() });
  assert.deepEqual(activeToolSets, [["read", "fetch_report_entry", WRITER_SUBMIT_TOOL]]);

  await handlers.get("tool_execution_end")[0]({
    toolCallId: "schema-invalid-submit",
    toolName: WRITER_SUBMIT_TOOL,
    isError: true,
    result: { content: [{ type: "text", text: "arguments failed schema validation" }] },
  });
  assert.deepEqual(activeToolSets.at(-1), []);

  const corrected = await handlers.get("tool_call")[0]({
    toolCallId: "corrected-submit",
    toolName: WRITER_SUBMIT_TOOL,
    input: failedReturn(contract(), "arguments failed schema validation"),
  });
  assert.equal(corrected.block, true);
  assert.match(corrected.reason, /最多调用一次/);

  // Later execution-end notifications cannot re-arm or mutate the tool set.
  await handlers.get("tool_execution_end")[0]({
    toolCallId: "another-invalid-submit",
    toolName: WRITER_SUBMIT_TOOL,
    isError: true,
    result: { content: [{ type: "text", text: "second validation error" }] },
  });
  assert.equal(activeToolSets.length, 2);
});

test("Writer child extension wires assignment context and both tool hooks into the guard", async () => {
  const source = await readFile(
    join(projectRoot, ".agents", "pi", "extensions", "report-writer-fetch", "index.mjs"),
    "utf8"
  );
  assert.match(source, /pi\.on\?\.\("before_agent_start"/);
  assert.match(source, /pi\.on\?\.\("context"/);
  assert.match(source, /pi\.on\?\.\("tool_call"[\s\S]*writerToolDecision/);
  assert.match(source, /pi\.on\?\.\("tool_result"[\s\S]*writerToolResultState/);
  assert.match(source, /pi\.on\?\.\("tool_execution_end"[\s\S]*writerUnvalidatedSubmitFailureState/);
  assert.match(source, /prepareStructuredOutputCapture[\s\S]*writeStructuredOutputCapture/);
  assert.match(source, /params\.resultPath !== contract\.resultPath/);
  assert.match(source, /params\.cardId !== contract\.cardId/);
});
