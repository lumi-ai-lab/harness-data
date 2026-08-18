import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EFFECTIVE_PROMPT,
  FIXED_BUSINESS_QUESTION,
  ORIGINAL_PROMPT,
  REQUIRED_RUNTIME_REPORT_AGENTS,
  RUNTIME_AGENT_LIST_AUDIT_MECHANISM,
  RUNTIME_AGENT_LIST_AUDIT_PRODUCER,
  assertFixedAConfigRecommendations,
  assertSinglePiSessionWriter,
  countSubagentDispatches,
  discoverPiSubagentExtensions,
  expectedContinueCount,
  inspectRuntimeAgentList,
  inspectRpcStageRecords,
  normalizeSkillPrompt,
  parseSelfTestArgs,
  parsePiSessionWriters,
  readRuntimeAgentListAuditCandidates,
  reconcileSelfTestDiagnostics,
  runtimeAgentListAttemptToken,
  runtimeAgentListAuditFileName,
  runtimeAgentListAuditSha256,
  runHtmlReportSelfTest,
  safeAbort,
  validateRuntimeContract,
  waitForAccessibleFile,
  watchInternalStageBudgets,
  withExplicitExtensions,
} from "../scripts/html-report-self-test.mjs";

const FAKE_SUBAGENT_EXTENSION = "/extensions/pi-subagents/index.ts";

const EXTERNAL_STAGES = [
  "A_CONFIG",
  "B0_PREFLIGHT",
  "B2_WRITER",
  "B3_RESEARCH",
  "B4_REVIEW",
  "B5_DESIGN",
];

function attemptStartedAt(stageId) {
  const index = Math.max(0, [
    "A_CONFIG",
    "B0_PREFLIGHT",
    "B2_WRITER",
    "B25_EDITOR",
    "B3_RESEARCH",
    "B4_REVIEW",
    "B5_DESIGN",
  ].indexOf(stageId));
  return `2026-07-29T00:00:${String(index).padStart(2, "0")}.000Z`;
}

function budgets(softMs = 100, hardMs = 1000) {
  return Object.fromEntries([
    "A_CONFIG",
    "A_CONFIRM",
    "B0_PREFLIGHT",
    "B2_WRITER",
    "B25_EDITOR",
    "B3_RESEARCH",
    "B4_REVIEW",
    "B5_DESIGN",
  ].map((stageId) => [stageId, { softMs, hardMs }]));
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function runtimeAuditCandidate(stageId, {
  sessionId = "self-test-session",
  attempt = { number: 1, startedAt: attemptStartedAt(stageId) },
  status = "passed",
  observed = [...REQUIRED_RUNTIME_REPORT_AGENTS],
  missing = REQUIRED_RUNTIME_REPORT_AGENTS.filter((name) => !observed.includes(name)),
  resultIsError = false,
  resultText = "- report-writer\n- report-researcher\n- report-reviewer\n- report-designer",
  error,
  fileName = runtimeAgentListAuditFileName(stageId, attempt),
  mutate = null,
} = {}) {
  const startedAt = "2026-07-29T00:01:00.000Z";
  const terminal = status !== "inflight";
  const document = {
    version: 1,
    producer: RUNTIME_AGENT_LIST_AUDIT_PRODUCER,
    mechanism: RUNTIME_AGENT_LIST_AUDIT_MECHANISM,
    sessionId,
    stageId,
    attempt: runtimeAgentListAttemptToken(stageId, attempt),
    requestId: `runtime-list-${stageId.toLowerCase()}`,
    status,
    required: [...REQUIRED_RUNTIME_REPORT_AGENTS],
    observed: [...observed],
    missing: [...missing],
    startedAt,
    endedAt: terminal ? "2026-07-29T00:01:00.010Z" : null,
    durationMs: terminal ? 10 : null,
    result: {
      isError: resultIsError,
      text: resultText,
      sha256: sha256(resultText),
    },
    ...(error !== undefined ? { error } : {}),
  };
  if (typeof mutate === "function") mutate(document);
  document.auditSha256 = runtimeAgentListAuditSha256(document);
  return {
    fileName,
    path: `/session/debug/runtime-agent-list/${fileName}`,
    document,
  };
}

function plannerBridgeRpcRecord({ requestId = "planner-bridge-1" } = {}) {
  return {
    type: "tool_execution_end",
    toolName: "bash",
    toolCallId: "b25-source-fields",
    isError: false,
    result: {
      content: [{ type: "text", text: "B2.5 bootstrap completed" }],
      details: {
        qdmHarnessAutoSubagent: {
          version: 1,
          producer: "qdm-harness",
          mechanism: "extension-event-bridge",
          sessionId: "self-test-session",
          attempt: "B25_EDITOR:1:2026-07-29T00:00:03.000Z",
          stageId: "B25_EDITOR",
          role: "report-editor-planner",
          agent: "report-researcher",
          requestId,
          isError: false,
        },
      },
    },
  };
}

function researcherRpcRecord(taskId) {
  return {
    type: "tool_execution_start",
    toolName: "subagent",
    input: {
      context: "fresh",
      chain: [{ agent: "report-researcher", task: `taskId=${taskId}` }],
    },
  };
}

function researcherBridgeRpcRecord({ requestId = "researcher-bridge-1" } = {}) {
  return {
    type: "tool_execution_end",
    toolName: "bash",
    toolCallId: "b25-source-fields",
    isError: false,
    result: {
      content: [{ type: "text", text: "initial Researcher completed" }],
      details: {
        qdmHarnessAutoResearcher: {
          version: 1,
          producer: "qdm-harness",
          mechanism: "extension-event-bridge",
          sessionId: "self-test-session",
          attempt: "B3_RESEARCH:1:2026-07-29T00:00:04.000Z",
          stageId: "B3_RESEARCH",
          role: "report-researcher",
          agent: "report-researcher",
          requestId,
          isError: false,
        },
      },
    },
  };
}

function initialBridgeRpcRecord() {
  const record = plannerBridgeRpcRecord();
  record.result.details.qdmHarnessAutoResearcher =
    researcherBridgeRpcRecord().result.details.qdmHarnessAutoResearcher;
  return record;
}

function plannerDurableRecord(index = 1) {
  return {
    identityKey: `editor-planner-${index}`,
    role: "report-editor-planner",
    label: "B2.5 Editor Planner",
    mechanism: "extension-event-bridge",
    sessionId: "self-test-session",
    attempt: "B25_EDITOR:1:2026-07-29T00:00:03.000Z",
  };
}

function researcherDurableRecord(taskId, index = 1, mechanism = "extension-event-bridge") {
  return {
    identityKey: `research-${taskId}-${index}`,
    role: "report-researcher",
    label: `Report Researcher taskId=${taskId}`,
    mechanism,
    sessionId: "self-test-session",
    attempt: "B3_RESEARCH:1:2026-07-29T00:00:04.000Z",
  };
}

function defaultB3RpcRecords(_tasks) {
  return [{
    type: "tool_execution_start",
    toolName: "html_report_run_stage",
    input: { reservation: "qdm-stage-v1-b3" },
  }];
}

function defaultB3DurableDispatches(tasks) {
  const [first, ...remaining] = tasks;
  return [
    plannerDurableRecord(),
    ...(first ? [researcherDurableRecord(first.id, 1, "extension-event-bridge")] : []),
    ...remaining.map((task) => researcherDurableRecord(task.id)),
  ];
}

function pipelineState(stageId, { failedStage = null, execution = {} } = {}) {
  const externalIndex = EXTERNAL_STAGES.indexOf(stageId);
  const stageIds = [
    "A_CONFIG",
    "B0_PREFLIGHT",
    "B2_WRITER",
    "B25_EDITOR",
    "B3_RESEARCH",
    "B4_REVIEW",
    "B5_DESIGN",
  ];
  const currentIndex = stageIds.indexOf(stageId);
  const pipelineFailed = stageId === failedStage;
  const stages = {};
  for (const [index, id] of stageIds.entries()) {
    const isFailed = pipelineFailed && id === failedStage;
    const isCurrent = id === stageId;
    const finalCompleted = stageId === "B5_DESIGN" && isCurrent;
    stages[id] = {
      id,
      status: isFailed
        ? "failed"
        : index < currentIndex || finalCompleted
          ? "completed"
          : isCurrent
            ? "awaiting_approval"
            : "pending",
      failureReason: isFailed ? `${id} simulated failure` : null,
      executionDurationMs: Number(execution[id] || 10),
      attempts: [{ number: 1, startedAt: attemptStartedAt(id) }],
    };
  }
  // B25 is internal and is completed as part of the B3 boundary.
  if (stageId === "B3_RESEARCH" || externalIndex > EXTERNAL_STAGES.indexOf("B3_RESEARCH")) {
    stages.B25_EDITOR.status = "completed";
  }
  return {
    version: 1,
    mode: "step",
    status: pipelineFailed ? "failed" : stageId === "B5_DESIGN" ? "completed" : "awaiting_approval",
    currentStage: stageId,
    stages,
    approvals: Array.from({ length: Math.max(0, externalIndex) }, (_, index) => ({
      stageId: EXTERNAL_STAGES[index],
      actor: "user",
      phrase: "继续",
    })),
  };
}

class FakeRpc {
  constructor(settings, harness) {
    this.settings = settings;
    this.harness = harness;
    this.records = [];
    this.messages = [];
    this.promptCount = 0;
    this.abortCount = 0;
    this.closed = false;
    this.listeners = new Set();
    this.processId = 4242;
  }

  start() {}

  async getState() {
    return {
      sessionId: this.settings.sessionId,
      sessionFile: join(this.settings.cwd, "pi-session.jsonl"),
      model: { provider: "fake", id: "fake-model" },
      thinkingLevel: "off",
    };
  }

  async getCommands() {
    return [
      { name: "skill:html-report" },
      { name: "subagents", sourceInfo: { path: FAKE_SUBAGENT_EXTENSION } },
    ];
  }

  async request() {
    return { ok: true };
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(record) {
    this.records.push(record);
    for (const listener of this.listeners) listener(record);
  }

  async promptAndWait(message) {
    const stageId = EXTERNAL_STAGES[this.promptCount];
    this.promptCount += 1;
    this.messages.push(message);
    this.harness.currentStage = stageId;
    if (this.harness.runtimeListStages.includes(stageId)) {
      const listCount = Number(this.harness.runtimeListCounts[stageId] || 1);
      for (let index = 0; index < listCount; index += 1) {
      const toolCallId = `list-${stageId}`;
      this.records.push({
        type: "tool_execution_start",
        toolName: "subagent",
        toolCallId,
        args: { action: "list" },
      });
      this.records.push({
        type: "tool_execution_end",
        toolName: "subagent",
        toolCallId,
        isError: false,
        result: {
          content: [{
            type: "text",
            text: "- report-writer\n- report-researcher\n- report-reviewer\n- report-designer",
          }],
        },
      });
      }
    }
    if (stageId === "B3_RESEARCH") {
      this.records.push(...structuredClone(this.harness.b3RpcRecords));
    } else if (["B2_WRITER", "B4_REVIEW"].includes(stageId) ||
        (stageId === "B5_DESIGN" && this.harness.dynamicB5)) {
      this.records.push({
        type: "tool_execution_start",
        toolName: "html_report_run_stage",
        toolCallId: `stage-runner-${stageId}`,
        input: { reservation: `qdm-stage-v1-${stageId.toLowerCase()}` },
      });
    }
    if (stageId === this.harness.rpcErrorStage) {
      this.emit({
        type: "tool_execution_end",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "simulated live tool failure" }] },
      });
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (stageId === "B0_PREFLIGHT") {
      const failed = this.harness.failedStage === "B0_PREFLIGHT";
      const defaultGate = {
        type: "message_end",
        message: {
          role: "custom",
          customType: "html-report-gate",
          details: {
            version: 1,
            producer: "qdm-harness",
            sessionId: this.settings.sessionId,
            stageId: "B0_PREFLIGHT",
            currentStage: "B0_PREFLIGHT",
            pipelineStatus: failed ? "failed" : "awaiting_approval",
            stageStatus: failed ? "failed" : "awaiting_approval",
            attempt: { number: 1, startedAt: attemptStartedAt("B0_PREFLIGHT") },
          },
        },
      };
      const events = this.harness.b0CompletionEvents
        ? this.harness.b0CompletionEvents(defaultGate)
        : [
            ...(this.harness.b0ModelTurn ? [{ type: "agent_start" }] : []),
            defaultGate,
          ];
      for (const event of events) this.emit(event);
      return { events };
    }
    return { events: [{ type: "agent_settled" }] };
  }

  getRecords() {
    return this.records;
  }

  getStderr() {
    return "";
  }

  async abort() {
    this.abortCount += 1;
  }

  async abortRetry() {}

  async waitForAgentSettled() {}

  async close() {
    this.closed = true;
  }
}

async function createHarness(t, {
  until = "B3_RESEARCH",
  failedStage = null,
  execution = {},
  workspaceSnapshot,
  configBudgets = budgets(),
  rpcErrorStage = null,
  analyzeRun = null,
  confirmMode = "http",
  confirmFailure = null,
  recommendationsReadError = null,
  createSessionFile = true,
  runtimeListStages = ["A_CONFIG", "B0_PREFLIGHT"],
  runtimeListCounts = {},
  runtimeAuditStages = [],
  runtimeAuditCandidates = {},
  sessionWriters = [{ pid: 4242, command: "fake pi writer" }],
  sessionWriterProvider = null,
  b0CompletionEvents = null,
  b0ModelTurn = false,
  b3Tasks = [{ id: "task-1" }],
  b3RpcRecords = null,
  b3DurableDispatches = null,
  env = null,
} = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), "html-report-self-test-runner-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const configPath = join(projectRoot, "self-test.config.json");
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    performanceBudgets: configBudgets,
    rpc: { requestTimeoutMs: 100 },
    close: { eofTimeoutMs: 10, termTimeoutMs: 10, killTimeoutMs: 10 },
  })}\n`, "utf8");
  await mkdir(join(projectRoot, "fixtures"), { recursive: true });
  if (createSessionFile) await writeFile(join(projectRoot, "pi-session.jsonl"), "", "utf8");

  const harness = {
    currentStage: "A_CONFIG",
    rpc: null,
    layoutCalls: [],
    confirmCalls: 0,
    confirmModes: [],
    confirmOptions: [],
    rpcErrorStage,
    failedStage,
    b0CompletionEvents,
    b0ModelTurn,
    runtimeListStages,
    runtimeListCounts,
    runtimeAuditStages,
    runtimeAuditCandidates,
    b3Tasks,
    dynamicB5: env?.HTML_REPORT_A_CONFIG_MODE === "dynamic",
    b3RpcRecords: b3RpcRecords ?? defaultB3RpcRecords(b3Tasks),
    b3DurableDispatches: b3DurableDispatches ?? defaultB3DurableDispatches(b3Tasks),
    runtimeContractCalls: [],
    policyCalls: [],
    writerAuditCalls: 0,
  };
  let clock = Date.parse("2026-07-29T00:00:00.000Z");
  const stableSnapshot = async () => ({ sha256: "source-stable", dirtyPaths: [] });
  const dependencies = {
    now: () => clock++,
    uuid: () => "self-test-session",
    workspaceSnapshot: workspaceSnapshot || stableSnapshot,
    gitMetadata: async () => ({ gitHead: "deadbeef", piVersion: "fake-pi" }),
    discoverPiSubagentExtensions: async () => ({
      packageRoot: "/extensions/pi-subagents",
      manifestPath: "/extensions/pi-subagents/package.json",
      packageVersion: "test",
      extensions: [FAKE_SUBAGENT_EXTENSION],
    }),
    createRpcClient: (settings) => {
      harness.rpc = new FakeRpc(settings, harness);
      return harness.rpc;
    },
    listPiSessionWriters: async (args) => {
      harness.writerAuditCalls += 1;
      return sessionWriterProvider ? sessionWriterProvider(args, harness.writerAuditCalls) : sessionWriters;
    },
    validateRuntimeContract: async ({ stageId }) => {
      harness.runtimeContractCalls.push(stageId);
      return {
        status: "pass",
        path: join(projectRoot, ".harness/state/html-report/self-test-session/debug/runtime-contract.json"),
        fingerprint: "runtime-fingerprint",
        sourceCount: 1,
      };
    },
    readRuntimeAgentListAudits: async (_sessionDir, stageId) => {
      if (Object.prototype.hasOwnProperty.call(harness.runtimeAuditCandidates, stageId)) {
        return harness.runtimeAuditCandidates[stageId];
      }
      return harness.runtimeAuditStages.includes(stageId)
        ? [runtimeAuditCandidate(stageId)]
        : [];
    },
    readPipelineState: async () => pipelineState(harness.currentStage, { failedStage, execution }),
    applyPipelinePolicy: async (sessionDir, policy) => {
      harness.policyCalls.push({ sessionDir, policy });
    },
    readJson: async (path) => {
      if (path.endsWith("recommendations.json") && recommendationsReadError) {
        throw recommendationsReadError;
      }
      return path.endsWith("recommendations.json")
        ? {
          version: 1,
          sessionId: "self-test-session",
          mode: "free",
          userQuestion: FIXED_BUSINESS_QUESTION,
          cards: [{
            id: "debug-store-balance-001",
            chartType: "table",
            indicatorFieldList: ["custNum", "perCustAmt", "profitLostRate", "profitAmt"],
            aggDimUniqueCodeList: ["incDate"],
            storeCollectType: 2,
            filters: [{ type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] }],
          }],
        }
      : path.endsWith("result.json")
        ? { cards: [{ id: "card-1" }] }
      : path.endsWith("tasks.json")
        ? { tasks: harness.b3Tasks }
        : {};
    },
    readDispatches: async () => {
      const records = [];
      if (EXTERNAL_STAGES.indexOf(harness.currentStage) >= EXTERNAL_STAGES.indexOf("B2_WRITER")) {
        records.push({
          identityKey: "writer-card-1",
          role: "report-writer",
          label: "cardId=card-1",
          mechanism: "extension-event-bridge",
        });
      }
      if (EXTERNAL_STAGES.indexOf(harness.currentStage) >= EXTERNAL_STAGES.indexOf("B3_RESEARCH")) {
        records.push(...harness.b3DurableDispatches);
      }
      if (EXTERNAL_STAGES.indexOf(harness.currentStage) >= EXTERNAL_STAGES.indexOf("B4_REVIEW")) {
        records.push({
          identityKey: "reviewer",
          role: "report-reviewer",
          label: "B4 Reviewer",
          mechanism: "extension-event-bridge",
        });
      }
      if (harness.currentStage === "B5_DESIGN" && harness.dynamicB5) {
        records.push({
          identityKey: "designer",
          role: "report-designer",
          label: "B5 Designer",
          mechanism: "extension-event-bridge",
        });
      }
      return records;
    },
    readRuntimeRecords: async (_sessionDir, bucket) => {
      if (bucket === "stage-runs") {
        if (!["B2_WRITER", "B3_RESEARCH", "B4_REVIEW", "B5_DESIGN"].includes(harness.currentStage)) return [];
        if (harness.currentStage === "B5_DESIGN" && !harness.dynamicB5) return [];
        return [{
          version: 1,
          producer: "qdm-harness-stage-runner",
          stage: harness.currentStage === "B3_RESEARCH" ? "B25_EDITOR" : harness.currentStage,
          status: "completed",
        }];
      }
      if (bucket !== "settlements") return [];
      const stages = [];
      if (harness.currentStage === "B2_WRITER") stages.push("B2_WRITER");
      if (harness.currentStage === "B3_RESEARCH") {
        stages.push("B25_EDITOR");
        for (const record of harness.b3DurableDispatches.filter((item) => item.role === "report-researcher")) {
          stages.push("B3_RESEARCH");
        }
      }
      if (harness.currentStage === "B4_REVIEW") stages.push("B4_REVIEW");
      if (harness.currentStage === "B5_DESIGN" && harness.dynamicB5) stages.push("B5_DESIGN");
      return stages.map((stage, index) => ({
        version: 1,
        producer: "qdm-harness-stage-runner",
        sessionId: "self-test-session",
        invocationId: `invocation-${stage}-${index}`,
        requestId: `request-${stage}-${index}`,
        stage,
        state: "TERMINAL",
        history: [{ state: "EMITTED" }, { state: "STARTED" }, { state: "TERMINAL" }],
      }));
    },
    checkSessionLayout: async (_sessionDir, { phase }) => {
      harness.layoutCalls.push(phase);
      return { ok: true, phase, errors: [], warnings: [] };
    },
    preflightAgents: async () => ({ ok: true, agents: [
      "report-writer", "report-researcher", "report-reviewer", "report-designer",
    ] }),
    headlessConfirm: async (options) => {
      harness.confirmCalls += 1;
      harness.confirmModes.push("http");
      harness.confirmOptions.push(options);
      if (confirmFailure) throw confirmFailure;
      return {
        ok: true,
        resultPath: join(projectRoot, ".harness/state/html-report/self-test-session/result.json"),
        cardCount: 1,
        validationCount: 1,
        layout: { ok: true, status: "pass", phase: "a", errors: [], warnings: [] },
      };
    },
    browserConfirm: async (options) => {
      harness.confirmCalls += 1;
      harness.confirmModes.push("browser");
      harness.confirmOptions.push(options);
      if (confirmFailure) throw confirmFailure;
      return {
        ok: true,
        resultPath: join(projectRoot, ".harness/state/html-report/self-test-session/result.json"),
        cardCount: 1,
        validationCount: 1,
        layout: { ok: true, status: "pass", phase: "a", errors: [], warnings: [] },
      };
    },
    analyzeHtmlReportRun: analyzeRun || (({ run }) => ({
      result: run.status === "pass"
        ? "PASS"
        : run.status === "performance_regression"
          ? "PERFORMANCE_REGRESSION"
          : "FAIL",
      session: { id: run.sessionId, stoppedStage: run.stoppedStage },
      firstAnomaly: run.anomaly,
      artifacts: { reportMarkdown: join(projectRoot, "report.md") },
    })),
    writeHtmlReportRunReport: async () => {},
  };
  const result = await runHtmlReportSelfTest({
    projectRoot,
    configPath,
    until,
    confirmMode,
    ...(env ? { env } : {}),
  }, dependencies);
  return { ...result, harness };
}

test("normalizes only the html-report Skill command prefix", () => {
  assert.equal(normalizeSkillPrompt(ORIGINAL_PROMPT), EFFECTIVE_PROMPT);
  assert.equal(
    normalizeSkillPrompt("/skill: html-report 业务问题中的 html-report 不应变化"),
    "/skill:html-report 业务问题中的 html-report 不应变化"
  );
  assert.equal(normalizeSkillPrompt("/skill:other html-report"), "/skill:other html-report");
  assert.equal(expectedContinueCount("B3"), 3);
});

test("fixed A_CONFIG fixture rejects an expanded Skill body as userQuestion", () => {
  const valid = {
    version: 1,
    sessionId: "fixture-session",
    mode: "free",
    userQuestion: FIXED_BUSINESS_QUESTION,
    cards: [{
      id: "debug-store-balance-001",
      chartType: "table",
      indicatorFieldList: ["custNum", "perCustAmt", "profitLostRate", "profitAmt"],
      aggDimUniqueCodeList: ["incDate"],
      storeCollectType: 2,
      filters: [{ type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] }],
    }],
  };
  assert.deepEqual(assertFixedAConfigRecommendations(valid, "fixture-session"), {
    cardCount: 1,
    cardId: "debug-store-balance-001",
  });
  assert.throws(
    () => assertFixedAConfigRecommendations({
      ...valid,
      userQuestion: `<skill>entire instructions</skill>\n${FIXED_BUSINESS_QUESTION}`,
    }, "fixture-session"),
    (error) => error.code === "FIXED_RECOMMENDATIONS_MISMATCH" &&
      error.classification === "PRODUCT_CONTRACT"
  );
});

test("fixed A_CONFIG allows one read-only Gate status but rejects recall or data tools", () => {
  const allowed = inspectRpcStageRecords([
    {
      type: "tool_execution_start",
      toolName: "subagent",
      args: { action: "list" },
    },
    {
      type: "tool_execution_start",
      toolName: "bash",
      args: {
        command: "node '/repo/.agents/pi/skills/html-report/scripts/stage-gate.mjs' status \\\n  --session-dir '/tmp/session' \\\n  --format text",
      },
    },
  ], "A_CONFIG");
  assert.deepEqual(allowed.errors, []);

  const forbidden = inspectRpcStageRecords([{
    type: "tool_execution_start",
    toolName: "bash",
    args: { command: "node .agents/pi/skills/html-report/scripts/prepare.mjs --question test" },
  }], "A_CONFIG");
  assert.equal(forbidden.errors[0].code, "A_CONFIG_TOOL_CALL_FORBIDDEN");

  const duplicateList = inspectRpcStageRecords([
    { type: "tool_execution_start", toolName: "subagent", args: { action: "list" } },
    { type: "tool_execution_start", toolName: "subagent", args: { action: "list" } },
  ], "A_CONFIG");
  assert.equal(duplicateList.errors[0].code, "A_CONFIG_TOOL_CALL_FORBIDDEN");

  const wrongAction = inspectRpcStageRecords([{
    type: "tool_execution_start",
    toolName: "subagent",
    args: { action: "run", agent: "report-writer" },
  }], "A_CONFIG");
  assert.equal(wrongAction.errors[0].code, "A_CONFIG_TOOL_CALL_FORBIDDEN");
});

test("A_CONFIG and B0 runtime lists must expose all four report agents exactly once", () => {
  const binding = (stageId) => ({
    sessionId: "self-test-session",
    attempt: { number: 1, startedAt: attemptStartedAt(stageId) },
  });
  const records = [{
    type: "tool_execution_start",
    toolName: "subagent",
    toolCallId: "list-1",
    args: { action: "list" },
  }, {
    type: "tool_execution_end",
    toolName: "subagent",
    toolCallId: "list-1",
    result: { content: [{ type: "text", text: "- report-writer\n- report-researcher\n- report-reviewer\n- report-designer" }] },
  }];
  const accepted = inspectRuntimeAgentList(records, "A_CONFIG", binding("A_CONFIG"));
  assert.equal(accepted.status, "pass");
  assert.equal(accepted.source, "rpc");
  assert.throws(
    () => inspectRuntimeAgentList(records.slice(0, 1).concat({
      ...records[1],
      result: { content: [{ type: "text", text: "- report-writer\n- report-researcher\n- report-reviewer" }] },
    }), "B0_PREFLIGHT", binding("B0_PREFLIGHT")),
    (error) => error.code === "RUNTIME_REPORT_AGENTS_MISSING"
  );
  assert.throws(
    () => inspectRuntimeAgentList([...records, ...records], "B0_PREFLIGHT", binding("B0_PREFLIGHT")),
    (error) => error.code === "RUNTIME_AGENT_LIST_COUNT_MISMATCH"
  );
});

test("runtime agent list accepts one integrity-bound extension audit without RPC evidence", () => {
  for (const stageId of ["A_CONFIG", "B0_PREFLIGHT"]) {
    const attempt = { number: 1, startedAt: attemptStartedAt(stageId) };
    const candidate = runtimeAuditCandidate(stageId, { attempt });
    const accepted = inspectRuntimeAgentList([], stageId, {
      auditCandidates: [candidate],
      sessionId: "self-test-session",
      attempt,
    });
    assert.equal(accepted.status, "pass");
    assert.equal(accepted.source, "extension_audit");
    assert.equal(accepted.attempt, runtimeAgentListAttemptToken(stageId, attempt));
    assert.equal(accepted.auditSha256, candidate.document.auditSha256);
  }
});

test("runtime agent list rejects missing, conflicting, duplicate, or misbound evidence", () => {
  const stageId = "B0_PREFLIGHT";
  const attempt = { number: 1, startedAt: attemptStartedAt(stageId) };
  const options = { sessionId: "self-test-session", attempt };
  const rpc = [{
    type: "tool_execution_start",
    toolName: "subagent",
    toolCallId: "list-1",
    args: { action: "list" },
  }, {
    type: "tool_execution_end",
    toolName: "subagent",
    toolCallId: "list-1",
    result: { content: [{ type: "text", text: "- report-writer\n- report-researcher\n- report-reviewer\n- report-designer" }] },
  }];
  const audit = runtimeAuditCandidate(stageId, { attempt });
  const historicalAttempt = { number: 1, startedAt: "2026-07-29T01:00:00.000Z" };
  const historicalAudit = runtimeAuditCandidate(stageId, { attempt: historicalAttempt });

  assert.throws(
    () => inspectRuntimeAgentList([], stageId, options),
    (error) => error.code === "RUNTIME_AGENT_LIST_EVIDENCE_MISSING"
  );
  assert.throws(
    () => inspectRuntimeAgentList(rpc, stageId, { ...options, auditCandidates: [audit] }),
    (error) => error.code === "RUNTIME_AGENT_LIST_SOURCE_CONFLICT"
  );
  assert.throws(
    () => inspectRuntimeAgentList([], stageId, { ...options, auditCandidates: [audit, audit] }),
    (error) => error.code === "RUNTIME_AGENT_LIST_AUDIT_DUPLICATE"
  );
  assert.throws(
    () => inspectRuntimeAgentList([], stageId, {
      ...options,
      auditCandidates: [runtimeAuditCandidate(stageId, { sessionId: "another-session", attempt })],
    }),
    (error) => error.code === "RUNTIME_AGENT_LIST_AUDIT_BINDING_MISMATCH"
  );
  assert.throws(
    () => inspectRuntimeAgentList([], stageId, {
      ...options,
      auditCandidates: [historicalAudit],
    }),
    (error) => error.code === "RUNTIME_AGENT_LIST_EVIDENCE_MISSING"
  );
  assert.equal(inspectRuntimeAgentList([], stageId, {
    ...options,
    auditCandidates: [historicalAudit, audit],
  }).source, "extension_audit");
  assert.equal(inspectRuntimeAgentList(rpc, stageId, {
    ...options,
    auditCandidates: [historicalAudit],
  }).source, "rpc");
});

test("runtime agent list audit fails closed on integrity, terminal-state, and agent-set errors", () => {
  const stageId = "A_CONFIG";
  const attempt = { number: 1, startedAt: attemptStartedAt(stageId) };
  const options = { sessionId: "self-test-session", attempt };

  const tampered = runtimeAuditCandidate(stageId, { attempt });
  tampered.document.observed = ["report-writer"];
  assert.throws(
    () => inspectRuntimeAgentList([], stageId, { ...options, auditCandidates: [tampered] }),
    (error) => error.code === "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID" ||
      error.code === "RUNTIME_AGENT_LIST_AUDIT_INTEGRITY_MISMATCH"
  );

  const badResult = runtimeAuditCandidate(stageId, { attempt });
  badResult.document.result.sha256 = "0".repeat(64);
  badResult.document.auditSha256 = runtimeAgentListAuditSha256(badResult.document);
  assert.throws(
    () => inspectRuntimeAgentList([], stageId, { ...options, auditCandidates: [badResult] }),
    (error) => error.code === "RUNTIME_AGENT_LIST_AUDIT_RESULT_INTEGRITY_MISMATCH"
  );

  const inflight = runtimeAuditCandidate(stageId, { attempt, status: "inflight" });
  assert.throws(
    () => inspectRuntimeAgentList([], stageId, { ...options, auditCandidates: [inflight] }),
    (error) => error.code === "RUNTIME_AGENT_LIST_AUDIT_NOT_TERMINAL"
  );

  const failed = runtimeAuditCandidate(stageId, {
    attempt,
    status: "failed",
    observed: ["report-writer"],
    resultIsError: true,
    resultText: "- report-writer",
    error: "bridge list failed",
  });
  assert.throws(
    () => inspectRuntimeAgentList([], stageId, { ...options, auditCandidates: [failed] }),
    (error) => error.code === "RUNTIME_AGENT_LIST_FAILED" && /bridge list failed/.test(error.message)
  );
});

test("runtime agent list audit loader accepts only stage-scoped hashed JSON files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-agent-list-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = join(root, "session");
  const auditDir = join(sessionDir, "debug", "runtime-agent-list");
  await mkdir(auditDir, { recursive: true });
  const stageId = "A_CONFIG";
  const attempt = { number: 1, startedAt: attemptStartedAt(stageId) };
  const candidate = runtimeAuditCandidate(stageId, { attempt });
  await writeFile(join(auditDir, candidate.fileName), `${JSON.stringify(candidate.document)}\n`);
  const historicalAttempt = { number: 1, startedAt: "2026-07-28T00:00:00.000Z" };
  const historical = runtimeAuditCandidate(stageId, { attempt: historicalAttempt });
  await writeFile(join(auditDir, historical.fileName), `${JSON.stringify(historical.document)}\n`);

  const loaded = await readRuntimeAgentListAuditCandidates(sessionDir, stageId, { attempt });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].fileName, candidate.fileName);
  assert.equal(inspectRuntimeAgentList([], stageId, {
    auditCandidates: loaded,
    sessionId: "self-test-session",
    attempt,
  }).status, "pass");
  assert.equal((await readRuntimeAgentListAuditCandidates(sessionDir, stageId)).length, 2);

  await writeFile(join(auditDir, "A_CONFIG-not-a-hash.json"), "{}\n");
  await assert.rejects(
    readRuntimeAgentListAuditCandidates(sessionDir, stageId),
    (error) => error.code === "RUNTIME_AGENT_LIST_AUDIT_FILENAME_INVALID"
  );
});

test("runtime contract matches the ordered source fingerprint and rejects source drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-runtime-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = join(root, "session");
  const sourceFiles = ["runtime-a.mjs", "runtime-b.mjs"];
  await mkdir(join(sessionDir, "debug"), { recursive: true });
  await writeFile(join(root, sourceFiles[0]), "alpha\n", "utf8");
  await writeFile(join(root, sourceFiles[1]), "beta\n", "utf8");
  const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async (path) => [
    path,
    createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
  ])));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(sourceFiles.map((path) => [path, sources[path]])), "utf8")
    .digest("hex");
  const marker = {
    version: 1,
    producer: "qdm-harness",
    sessionId: "contract-session",
    sources,
    fingerprint,
  };
  const markerPath = join(sessionDir, "debug", "runtime-contract.json");
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, "utf8");
  assert.equal((await validateRuntimeContract({
    root,
    sessionDir,
    sessionId: "contract-session",
    sourceFiles,
  })).fingerprint, fingerprint);

  const unreadableSources = { ...sources, [sourceFiles[0]]: "!ENOENT" };
  const unreadableFingerprint = createHash("sha256")
    .update(JSON.stringify(sourceFiles.map((path) => [path, unreadableSources[path]])), "utf8")
    .digest("hex");
  await writeFile(markerPath, `${JSON.stringify({
    ...marker,
    sources: unreadableSources,
    fingerprint: unreadableFingerprint,
  })}\n`, "utf8");
  await assert.rejects(
    validateRuntimeContract({ root, sessionDir, sessionId: "contract-session", sourceFiles }),
    (error) => error.code === "RUNTIME_CONTRACT_SOURCE_UNREADABLE"
  );

  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, "utf8");
  await rm(join(root, sourceFiles[0]));
  await assert.rejects(
    validateRuntimeContract({ root, sessionDir, sessionId: "contract-session", sourceFiles }),
    (error) => error.code === "RUNTIME_CONTRACT_SOURCE_UNREADABLE"
  );
  await writeFile(join(root, sourceFiles[0]), "alpha\n", "utf8");
  await writeFile(join(root, sourceFiles[1]), "changed\n", "utf8");
  await assert.rejects(
    validateRuntimeContract({ root, sessionDir, sessionId: "contract-session", sourceFiles, stageId: "B0_PREFLIGHT" }),
    (error) => error.code === "RUNTIME_CONTRACT_FINGERPRINT_MISMATCH" && error.stageId === "B0_PREFLIGHT"
  );
});

test("Pi writer audit recognizes supported session flags and rejects a second writer", async () => {
  const parsed = parsePiSessionWriters([
    " 101 pi --mode rpc --session-id session-1",
    " 102 pi --session session-1",
    " 103 pi --session /tmp/session.jsonl",
    " 104 pi --session unrelated",
  ].join("\n"), { sessionId: "session-1", sessionFile: "/tmp/session.jsonl" });
  assert.deepEqual(parsed.map(({ pid }) => pid), [101, 102, 103]);
  await assert.rejects(
    assertSinglePiSessionWriter({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      expectedPid: 101,
      listWriters: async () => parsed.slice(0, 2),
    }),
    (error) => error.code === "PI_SESSION_WRITER_CONFLICT"
  );
  const hiddenArgs = await assertSinglePiSessionWriter({
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    expectedPid: 4242,
    listWriters: async () => [],
  });
  assert.equal(hiddenArgs.method, "fresh_session_owned_rpc_pid");
  assert.equal(hiddenArgs.visibleWriterCount, 0);
  await assert.rejects(
    assertSinglePiSessionWriter({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      expectedPid: 4242,
      stageId: "B2_WRITER",
      listWriters: async () => [{ pid: "not-a-pid" }],
    }),
    (error) => error.code === "PI_SESSION_WRITER_AUDIT_INVALID" && error.stageId === "B2_WRITER"
  );
});

test("session file readiness tolerates a short get_state creation race but remains bounded", async () => {
  let attempts = 0;
  let clock = 0;
  const ready = await waitForAccessibleFile("/tmp/pi-session.jsonl", {
    timeoutMs: 100,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    accessImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("not created yet");
        error.code = "ENOENT";
        throw error;
      }
    },
  });
  assert.equal(ready.status, "accessible");
  assert.equal(attempts, 3);

  await assert.rejects(waitForAccessibleFile("/tmp/missing.jsonl", {
    timeoutMs: 20,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    accessImpl: async () => {
      const error = new Error("still missing");
      error.code = "ENOENT";
      throw error;
    },
  }), /still missing/);
});

test("discovers manifest-declared pi-subagents entries and appends explicit extension args", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "html-report-pi-agent-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const packageRoot = join(agentDir, "npm", "node_modules", "pi-subagents");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
    name: "pi-subagents",
    version: "1.2.3",
    pi: { extensions: ["./index.ts", "./extra.ts"] },
  })}\n`, "utf8");
  await Promise.all([
    writeFile(join(packageRoot, "index.ts"), "export default () => {};\n", "utf8"),
    writeFile(join(packageRoot, "extra.ts"), "export default () => {};\n", "utf8"),
  ]);
  const discovered = await discoverPiSubagentExtensions({
    env: { PI_CODING_AGENT_DIR: agentDir },
  });
  assert.equal(discovered.packageVersion, "1.2.3");
  assert.deepEqual(discovered.extensions, [
    join(packageRoot, "index.ts"),
    join(packageRoot, "extra.ts"),
  ]);
  assert.deepEqual(
    withExplicitExtensions(["--thinking", "high"], discovered.extensions, "/repo"),
    [
      "--thinking", "high",
      "--extension", join(packageRoot, "index.ts"),
      "--extension", join(packageRoot, "extra.ts"),
    ]
  );
  assert.deepEqual(
    withExplicitExtensions(["--extension", join(packageRoot, "index.ts")], discovered.extensions, "/repo"),
    [
      "--extension", join(packageRoot, "index.ts"),
      "--extension", join(packageRoot, "extra.ts"),
    ]
  );
});

test("--until B3 sends exactly three continues and never adds one for B25", async (t) => {
  const { run, harness, observations } = await createHarness(t, {
    env: {
      HTML_REPORT_GATE_MODE: "auto",
      HTML_REPORT_A_CONFIG_MODE: "dynamic",
      HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN: "1",
      ORDINARY_TEST_ENV: "preserved",
    },
  });
  assert.equal(run.status, "pass");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT, "继续", "继续", "继续"]);
  assert.equal(harness.rpc.messages.filter((message) => message === "继续").length, 3);
  assert.deepEqual(
    observations.map((observation) => observation.stageId),
    ["A_CONFIG", "A_CONFIRM", "B0_PREFLIGHT", "B2_WRITER", "B25_EDITOR", "B3_RESEARCH"]
  );
  assert.equal(harness.rpc.promptCount, 4, "B25_EDITOR must not receive a separate prompt");
  assert.equal(harness.confirmCalls, 1);
  assert.equal(harness.policyCalls.length, 1);
  assert.deepEqual(harness.policyCalls[0].policy, {
    B0_PREFLIGHT: { enabled: true, gate: true },
  });
  assert.deepEqual(harness.rpc.settings.args, ["--extension", FAKE_SUBAGENT_EXTENSION]);
  assert.equal(run.piSubagents.runtimeVerified, true);
  assert.deepEqual(harness.runtimeContractCalls, ["A_CONFIG", "B0_PREFLIGHT"]);
  assert.equal(run.sessionWriterAudit.writerCount, 1);
  assert.equal(run.sessionWriterAudits.length, 5);
  assert.equal(harness.writerAuditCalls, 5);
  assert.equal(run.piProcessId, 4242);
  assert.deepEqual(run.runtimeEnv, {
    HTML_REPORT_GATE_MODE: "step",
    HTML_REPORT_A_CONFIG_MODE: "fixed",
    HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN: "0",
  });
  assert.equal(harness.rpc.settings.env.HTML_REPORT_GATE_MODE, "step");
  assert.equal(harness.rpc.settings.env.HTML_REPORT_A_CONFIG_MODE, "fixed");
  assert.equal(harness.rpc.settings.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN, "0");
  assert.equal(harness.rpc.settings.env.ORDINARY_TEST_ENV, "preserved");
  const b0 = observations.find(({ stageId }) => stageId === "B0_PREFLIGHT");
  assert.equal(b0.runtimeAgents.status, "pass");
  assert.equal(b0.completionSignal, "custom_gate");
  assert.equal(b0.agentSettled, false);
});

test("fixed-debug full run completes B5 without Designer dispatch or html layout", async (t) => {
  const { run, harness, observations } = await createHarness(t, { until: "B5_DESIGN" });
  assert.equal(run.status, "pass");
  assert.deepEqual(harness.rpc.messages, [
    EFFECTIVE_PROMPT,
    "继续",
    "继续",
    "继续",
    "继续",
    "继续",
  ]);
  assert.equal(harness.layoutCalls.includes("html"), false);
  const b5 = observations.find(({ stageId }) => stageId === "B5_DESIGN");
  assert.equal(b5.layout.status, "skipped");
  assert.equal(b5.layout.phase, null);
  assert.equal(b5.dispatch.observed["report-designer"] || 0, 0);
});

test("B3 durable audit counts one Planner and permits one Researcher successor", async (t) => {
  const b3Tasks = [{ id: "task-1" }];
  const b3DurableDispatches = [
    plannerDurableRecord(),
    researcherDurableRecord("task-1", 1),
    researcherDurableRecord("task-1", 2),
  ];

  const { run, observations, harness } = await createHarness(t, {
    b3Tasks,
    b3DurableDispatches,
  });
  assert.equal(run.status, "pass");
  const dispatch = observations.find(({ stageId }) => stageId === "B3_RESEARCH").dispatch;
  assert.equal(dispatch.observed["report-editor-planner"], 1);
  assert.equal(dispatch.observed["report-researcher"], 2);
  assert.equal(harness.rpc.records.filter((record) =>
    record.type === "tool_execution_start" && record.toolName === "html_report_run_stage"
  ).length >= 1, true);
  assert.equal(harness.rpc.records.some((record) =>
    record.type === "tool_execution_start" && record.toolName === "subagent" && record.input?.chain
  ), false);
});

test("B3 durable audit keeps exactly one Planner when tasks is empty", async (t) => {
  const { run, observations } = await createHarness(t, { b3Tasks: [] });
  assert.equal(run.status, "pass");
  const dispatch = observations.find(({ stageId }) => stageId === "B3_RESEARCH").dispatch;
  assert.equal(dispatch.observed["report-editor-planner"], 1);
  assert.equal(dispatch.observed["report-researcher"] || 0, 0);
});

test("B3 dispatch acceptance rejects a missing durable Planner", async (t) => {
  const { run } = await createHarness(t, {
    b3DurableDispatches: [researcherDurableRecord("task-1")],
  });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "B3_RESEARCH");
  assert.equal(run.anomaly.code, "EDITOR_PLANNER_DISPATCH_COUNT_MISMATCH");
});

test("B3 dispatch acceptance rejects duplicate durable Planners", async (t) => {
  const { run } = await createHarness(t, {
    b3DurableDispatches: [
      plannerDurableRecord(1),
      plannerDurableRecord(2),
      researcherDurableRecord("task-1"),
    ],
  });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "B3_RESEARCH");
  assert.equal(run.anomaly.code, "EDITOR_PLANNER_DISPATCH_COUNT_MISMATCH");
});

test("B0 deterministic completion rejects missing, ambiguous, invalid and model-backed Gate events", async (t) => {
  const fixtures = [
    {
      label: "missing",
      b0CompletionEvents: () => [{ type: "agent_settled" }],
      code: "B0_HANDLED_GATE_MISSING",
    },
    {
      label: "ambiguous",
      b0CompletionEvents: (gate) => [gate, structuredClone(gate)],
      code: "B0_HANDLED_GATE_AMBIGUOUS",
    },
    {
      label: "invalid scope",
      b0CompletionEvents: (gate) => [{
        ...gate,
        message: {
          ...gate.message,
          details: { ...gate.message.details, sessionId: "another-session" },
        },
      }],
      code: "B0_HANDLED_GATE_INVALID",
    },
    {
      label: "model turn",
      b0ModelTurn: true,
      code: "B0_MODEL_TURN_FORBIDDEN",
    },
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.label, async (t) => {
      const { run, harness } = await createHarness(t, {
        until: "B0_PREFLIGHT",
        b0CompletionEvents: fixture.b0CompletionEvents,
        b0ModelTurn: fixture.b0ModelTurn,
      });
      assert.equal(run.status, "failed");
      assert.equal(run.stoppedStage, "B0_PREFLIGHT");
      assert.equal(run.anomaly.code, fixture.code);
      assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT, "继续"]);
    });
  }
});

test("a failed deterministic B0 Gate reports GATE_FAILED instead of timing out", async (t) => {
  const { run, harness } = await createHarness(t, {
    until: "B0_PREFLIGHT",
    failedStage: "B0_PREFLIGHT",
  });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "B0_PREFLIGHT");
  assert.equal(run.anomaly.code, "GATE_FAILED");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT, "继续"]);
});

test("missing B0 runtime list fails closed before B2", async (t) => {
  const { run, harness } = await createHarness(t, {
    runtimeListStages: ["A_CONFIG"],
  });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "B0_PREFLIGHT");
  assert.equal(run.anomaly.code, "RUNTIME_AGENT_LIST_EVIDENCE_MISSING");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT, "继续"]);
});

test("A_CONFIG and B0 can use one persisted extension audit each without RPC list tools", async (t) => {
  const { run, harness, observations } = await createHarness(t, {
    until: "B0_PREFLIGHT",
    runtimeListStages: [],
    runtimeAuditStages: ["A_CONFIG", "B0_PREFLIGHT"],
  });
  assert.equal(run.status, "pass");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT, "继续"]);
  assert.equal(harness.rpc.records.some((record) =>
    record.type === "tool_execution_start" && record.toolName === "subagent"
  ), false);
  for (const stageId of ["A_CONFIG", "B0_PREFLIGHT"]) {
    const runtimeAgents = observations.find((item) => item.stageId === stageId).runtimeAgents;
    assert.equal(runtimeAgents.status, "pass");
    assert.equal(runtimeAgents.source, "extension_audit");
    assert.equal(runtimeAgents.sessionId, "self-test-session");
  }
});

test("controller rejects simultaneous RPC and extension-audit runtime list evidence", async (t) => {
  const { run, harness } = await createHarness(t, {
    until: "A_CONFIG",
    runtimeAuditStages: ["A_CONFIG"],
  });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "A_CONFIG");
  assert.equal(run.anomaly.code, "RUNTIME_AGENT_LIST_SOURCE_CONFLICT");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT]);
  assert.equal(harness.confirmCalls, 0);
});

test("first settled stage requires the Pi session file while startup rejects a second writer", async (t) => {
  const missing = await createHarness(t, { until: "A_CONFIG", createSessionFile: false });
  assert.equal(missing.run.anomaly.code, "PI_SESSION_FILE_MISSING");
  assert.deepEqual(missing.harness.rpc.messages, [EFFECTIVE_PROMPT]);

  const conflict = await createHarness(t, {
    until: "A_CONFIG",
    sessionWriters: [
      { pid: 4242, command: "current" },
      { pid: 5252, command: "conflict" },
    ],
  });
  assert.equal(conflict.run.anomaly.code, "PI_SESSION_WRITER_CONFLICT");
  assert.deepEqual(conflict.harness.rpc.messages, []);
});

test("a writer appearing after startup is rejected at the next settled stage", async (t) => {
  const current = { pid: 4242, command: "current" };
  const foreign = { pid: 5252, command: "late conflict" };
  const { run, harness } = await createHarness(t, {
    until: "A_CONFIG",
    sessionWriterProvider: async (_args, call) => call === 1 ? [current] : [current, foreign],
  });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "A_CONFIG");
  assert.equal(run.anomaly.code, "PI_SESSION_WRITER_CONFLICT");
  assert.equal(harness.writerAuditCalls, 2);
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT]);
  assert.equal(harness.confirmCalls, 0);
});

test("A_CONFIRM dispatches browser mode with one hard deadline", async (t) => {
  const { run, harness } = await createHarness(t, {
    until: "A_CONFIG",
    confirmMode: "browser",
  });
  assert.equal(run.status, "pass");
  assert.deepEqual(harness.confirmModes, ["browser"]);
  assert.equal(harness.confirmOptions[0].totalTimeoutMs, 1_000);
  assert.equal(harness.confirmOptions[0].confirmTimeoutMs, 1_000);
  assert.equal(harness.confirmOptions[0].startupTimeoutMs, 1_000);
});

test("A_CONFIRM preserves explicit failure classification and stage", async (t) => {
  const failure = new Error("simulated Indicators outage");
  failure.classification = "INFRASTRUCTURE";
  failure.code = "A_CONFIRM_INDICATORS_FAILED";
  const { run, harness } = await createHarness(t, {
    until: "A_CONFIG",
    confirmFailure: failure,
  });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "A_CONFIRM");
  assert.equal(run.anomaly.classification, "INFRASTRUCTURE");
  assert.equal(run.anomaly.code, "A_CONFIRM_INDICATORS_FAILED");
  assert.deepEqual(harness.confirmModes, ["http"]);
});

test("A_CONFIRM classifies a missing or malformed recommendations file as PRODUCT_CONTRACT", async (t) => {
  const cases = [
    Object.assign(new Error("ENOENT: recommendations.json"), { code: "ENOENT" }),
    Object.assign(new Error("recommendations.json 不是合法 JSON"), {
      classification: "TEST_HARNESS",
      code: "INVALID_JSON",
    }),
  ];
  for (const recommendationsReadError of cases) {
    const { run, harness } = await createHarness(t, {
      until: "A_CONFIG",
      recommendationsReadError,
    });
    assert.equal(run.status, "failed");
    assert.equal(run.stoppedStage, "A_CONFIRM");
    assert.equal(run.anomaly.classification, "PRODUCT_CONTRACT");
    assert.equal(run.anomaly.code, "A_CONFIRM_RECOMMENDATIONS_INVALID");
    assert.equal(harness.confirmCalls, 0);
  }
});

test("controller awaits an asynchronous run analyzer before writing and returning the report", async (t) => {
  let analyzerResolved = false;
  const analyzeRun = async ({ run }) => {
    await new Promise((resolve) => setImmediate(resolve));
    analyzerResolved = true;
    return {
      result: "PASS",
      asyncAnalyzer: true,
      session: { id: run.sessionId, stoppedStage: run.stoppedStage },
      firstAnomaly: null,
      artifacts: { reportMarkdown: "/tmp/async-report.md" },
    };
  };
  const { report } = await createHarness(t, { until: "A_CONFIG", analyzeRun });
  assert.equal(analyzerResolved, true);
  assert.equal(report.asyncAnalyzer, true);
});

test("a failed B2 Gate stops before the B3 continue", async (t) => {
  const { run, harness } = await createHarness(t, { failedStage: "B2_WRITER" });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "B2_WRITER");
  assert.equal(run.anomaly.code, "GATE_FAILED");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT, "继续", "继续"]);
  assert.equal(harness.rpc.messages.filter((message) => message === "继续").length, 2);
  assert.equal(harness.rpc.abortCount > 0, true);
});

test("a live B2 RPC tool failure aborts before the model can settle or retry", async (t) => {
  const { run, harness } = await createHarness(t, { rpcErrorStage: "B2_WRITER" });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "B2_WRITER");
  assert.equal(run.anomaly.code, "TOOL_EXECUTION_FAILED");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT, "继续", "继续"]);
  assert.equal(harness.rpc.abortCount > 0, true);
});

test("soft performance budget stops after B2 without continuing to B3", async (t) => {
  const { run, harness } = await createHarness(t, {
    execution: { B2_WRITER: 101 },
    configBudgets: budgets(100, 1000),
  });
  assert.equal(run.status, "performance_regression");
  assert.equal(run.stoppedStage, "B2_WRITER");
  assert.equal(run.anomaly.code, "SOFT_BUDGET_EXCEEDED");
  assert.equal(run.anomaly.classification, "PERFORMANCE_REGRESSION");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT, "继续", "继续"]);
});

test("completed B25 soft regression aborts the just-started B3 immediately", async () => {
  const watcher = watchInternalStageBudgets({
    readPipelineState: async () => ({
      status: "running",
      currentStage: "B3_RESEARCH",
      stages: {
        B25_EDITOR: { status: "completed", executionDurationMs: 101 },
        B3_RESEARCH: { status: "running", executionDurationMs: 0, attempts: [] },
      },
    }),
    sessionDir: "/tmp/session",
    config: { performanceBudgets: budgets(100, 1_000) },
    intervalMs: 1,
  });
  try {
    await assert.rejects(
      watcher.promise,
      (error) => error.code === "SOFT_BUDGET_EXCEEDED" && error.stageId === "B25_EDITOR"
    );
  } finally {
    watcher.stop();
  }
});

test("abort observes agent_settled emitted before the abort response completes", async () => {
  const records = [];
  const order = [];
  let settle;
  const rpc = {
    getRecords: () => [...records],
    waitForAgentSettled: () => {
      order.push("wait");
      return new Promise((resolve) => { settle = resolve; });
    },
    abort: async () => {
      order.push("abort");
      records.push({ type: "agent_settled" });
      settle({ type: "agent_settled" });
    },
    abortRetry: async () => { order.push("abort_retry"); },
  };
  await safeAbort(rpc);
  assert.deepEqual(order, ["wait", "abort", "abort_retry"]);
});

test("hard budget remains the first root cause and is recorded once after controller abort", () => {
  const hardBudget = {
    classification: "PERFORMANCE_REGRESSION",
    code: "HARD_BUDGET_EXCEEDED",
    stageId: "B25_EDITOR",
    reason: "B25_EDITOR exceeded its hard budget",
    occurredAt: "2026-07-29T00:01:00.000Z",
  };
  const abortConsequence = {
    classification: "INFRASTRUCTURE",
    code: "PI_SESSION_ASSISTANT_ABORTED",
    stageId: "B25_EDITOR",
    reason: "Request was aborted",
    occurredAt: "2026-07-29T00:01:00.001Z",
    source: "pi-session",
  };
  const report = reconcileSelfTestDiagnostics({
    firstAnomaly: abortConsequence,
    anomalies: [
      abortConsequence,
      { ...hardBudget, source: "performance", reason: "derived hard budget failure" },
      { ...hardBudget, source: "run" },
    ],
  }, {
    anomaly: hardBudget,
    firstAnomaly: hardBudget,
  });
  assert.equal(report.firstAnomaly.code, "HARD_BUDGET_EXCEEDED");
  assert.equal(report.firstAnomaly.reason, hardBudget.reason);
  assert.equal(report.anomalies[0], report.firstAnomaly);
  assert.equal(report.anomalies.filter((issue) =>
    issue.code === "HARD_BUDGET_EXCEEDED" && issue.stageId === "B25_EDITOR"
  ).length, 1);
  assert.equal(report.anomalies.some((issue) => issue.code === "PI_SESSION_ASSISTANT_ABORTED"), true);
});

test("workspace source fingerprint change fails closed before any continue", async (t) => {
  let calls = 0;
  const workspaceSnapshot = async () => {
    calls += 1;
    return { sha256: calls >= 3 ? "source-mutated" : "source-stable", dirtyPaths: [] };
  };
  const { run, harness } = await createHarness(t, { workspaceSnapshot });
  assert.equal(run.status, "failed");
  assert.equal(run.stoppedStage, "A_CONFIG");
  assert.equal(run.anomaly.code, "SOURCE_MUTATION_DETECTED");
  assert.equal(run.anomaly.classification, "PRODUCT_CONTRACT");
  assert.deepEqual(harness.rpc.messages, [EFFECTIVE_PROMPT]);
  assert.equal(harness.confirmCalls, 0);
});

test("argument parser accepts B3 alias and rejects ambiguous targets", () => {
  const parsed = parseSelfTestArgs(["--until", "B3", "--confirm-mode", "http"]);
  assert.equal(parsed.until, "B3_RESEARCH");
  assert.throws(() => parseSelfTestArgs(["--full", "--until", "B2"]), /必须且只能指定/);
  assert.throws(() => parseSelfTestArgs(["--until", "B9"]), /阶段无效/);
});
