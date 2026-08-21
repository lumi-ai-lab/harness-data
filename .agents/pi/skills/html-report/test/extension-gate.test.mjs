import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolve } from "node:path";
import {
  b25EditorBootstrapContract,
  b25EditorToolDecision,
  b2WriterMainWorkAccepted,
  applyGateInput,
  classifyGateInput,
  gateContextBanner,
  gateToolDecision,
  htmlReportSessionDir,
  HTML_REPORT_STAGE_TOOL,
  inspectGateState,
  normalizeStandaloneStageGateCommand,
  parseStandaloneStageGateCommand,
  readGateState,
  runStageGate,
  stageGateScriptPath,
} from "../../../extensions/qdm-harness/gate-control.mjs";
import {
  approvePipelineStage,
  applyPipelinePolicy,
  finishPipelineStage,
  formatGateMessage,
  initPipeline,
  pipelineStatePath,
  pipelineStatus,
  startPipelineStage,
  LEGACY_STAGE_POLICY,
} from "../scripts/stage-gate.mjs";
import { researcherReturnPaths } from "../scripts/researcher-return.mjs";
import { reviewerReturnPaths } from "../scripts/reviewer-return.mjs";
import { designerReturnPaths } from "../scripts/designer-return.mjs";
import { assembleReport } from "../scripts/assemble-report.mjs";
import { writeVerdict } from "../scripts/write-verdict.mjs";
import { runQualityScan } from "../scripts/quality-scan.mjs";
import { rowsSha256 } from "../scripts/fetch-entry.mjs";
import { writerReturnPaths } from "../scripts/writer-return.mjs";
import {
  extractStageProgress,
  renderStageProgressResult,
} from "../../../extensions/qdm-harness/orchestration/stage-progress.ts";
import {
  persistEditorSourceInventory,
  persistEditorWriterReturn,
} from "../scripts/editor-plan-contract.mjs";
import { parseResearcherAssignment } from "../../../extensions/report-researcher-guard/guard.mjs";
import qdmHarnessExtension, {
  HTML_REPORT_GATE_CUSTOM_TYPE,
  HTML_REPORT_UI_CUSTOM_TYPE,
  HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH,
  HTML_REPORT_RUNTIME_SOURCE_FILES,
  compactHtmlReportGateHistory,
  compactHtmlReportSkillHistory,
  fixedAConfigBanner,
  harnessQuestion,
  inspectRuntimeAgentListResult,
  isWaitingAConfigAgentList,
  normalizeResearcherEvidencePathLabel,
  ensureResearcherCitationCommitRule,
  requestRuntimeAgentListViaEventBridge,
  requestSubagentViaEventBridge,
  runningGateSubagentDecision,
  writeHtmlReportRuntimeContract,
} from "../../../extensions/qdm-harness/index.ts";

const repoRoot = resolve(new URL("../../../../../", import.meta.url).pathname);

test("harnessQuestion keeps only the business question after Pi's final skill wrapper", () => {
  const question = "生成客数和客单的平衡点，以门店101001为样本";
  const expanded = [
    '<skill name="html-report" location="/tmp/SKILL.md">',
    "The original question appears after the literal `</skill>` tag.",
    "More skill instructions that must never become the question.",
    "</skill>",
    question,
  ].join("\n");
  assert.equal(harnessQuestion(expanded), question);
  assert.equal(harnessQuestion(`/skill:html-report ${question}`), `/skill:html-report ${question}`);
});

test("A_CONFIG banner shows only the local UI instructions needed by the user", () => {
  const banner = fixedAConfigBanner({ serverUrl: "http://127.0.0.1:18080" });
  assert.match(banner, /本地编辑器：http:\/\/127\.0\.0\.1:18080/);
  assert.match(banner, /回复一次「继续」/);
  assert.doesNotMatch(banner, /local-report-builder|B0|runtime agent list|recommendations\.json|server\.mjs/);
});

test("Phase B context compacts historical skill body but preserves the business question", () => {
  const question = "比较任意两个驱动因素，以结果指标评估";
  const original = [{
    role: "user",
    content: [{
      type: "text",
      text: [
        '<skill name="html-report" location="/tmp/SKILL.md">',
        "Skill body mentions a literal `</skill>` tag.",
        "A very long instruction body that Phase B no longer needs.",
        "</skill>",
        question,
      ].join("\n"),
    }],
  }];
  const compacted = compactHtmlReportSkillHistory(original, {
    currentStage: "B2_WRITER",
    status: "running",
  });
  assert.notEqual(compacted, original);
  assert.match(compacted[0].content[0].text, /compacted="phase-b"/);
  assert.match(compacted[0].content[0].text, new RegExp(`${question}$`));
  assert.doesNotMatch(compacted[0].content[0].text, /very long instruction body/);
  assert.match(original[0].content[0].text, /very long instruction body/);
  assert.equal(compactHtmlReportSkillHistory(original, {
    currentStage: "A_CONFIG",
    status: "awaiting_approval",
  }), original);
});

test("later stages compact prior completed Gate replies and hidden reasoning", () => {
  const priorA = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "repeat the old completed pattern" },
      {
        type: "text",
        text: [
          "阶段：A Config",
          "状态：completed",
          "本阶段耗时：0秒",
          "下一阶段：B0 Preflight",
          "回复“继续”进入下一阶段",
        ].join("\n"),
      },
    ],
  };
  const priorB0 = {
    role: "assistant",
    content: [{
      type: "text",
      text: [
        "阶段：B0 Preflight",
        "状态：completed",
        "下一阶段：B2 Writer",
        "回复“继续”进入下一阶段",
      ].join("\n"),
    }],
  };
  const unrelated = { role: "assistant", content: [{ type: "text", text: "保留普通业务回答" }] };
  const current = { role: "user", content: [{ type: "text", text: "继续" }] };
  const original = [priorA, priorB0, unrelated, current];
  const compacted = compactHtmlReportGateHistory(original, {
    currentStage: "B2_WRITER",
    status: "running",
  });
  assert.notEqual(compacted, original);
  assert.deepEqual(compacted[0].content, [{
    type: "text",
    text: "[html-report prior Gate compacted: A_CONFIG completed]",
  }]);
  assert.deepEqual(compacted[1].content, [{
    type: "text",
    text: "[html-report prior Gate compacted: B0_PREFLIGHT completed]",
  }]);
  assert.equal(compacted[2], unrelated);
  assert.equal(compacted[3], current);
  assert.match(priorA.content[1].text, /阶段：A Config/);
  assert.equal(compactHtmlReportGateHistory(original, {
    currentStage: "A_CONFIG",
    status: "awaiting_approval",
  }), original);
});

test("later stages compact only authenticated deterministic custom Gate history", () => {
  const gate = (pipelineStatus, stageStatus) => ({
    role: "custom",
    customType: HTML_REPORT_GATE_CUSTOM_TYPE,
    content: `B0 ${pipelineStatus}`,
    details: {
      version: 1,
      producer: "qdm-harness",
      sessionId: "custom-gate-session",
      stageId: "B0_PREFLIGHT",
      currentStage: "B0_PREFLIGHT",
      pipelineStatus,
      stageStatus,
      attempt: { number: 1, startedAt: "2026-07-31T00:00:00.000Z" },
    },
  });
  const failed = gate("failed", "failed");
  const completed = gate("awaiting_approval", "awaiting_approval");
  const unrelated = {
    ...gate("awaiting_approval", "awaiting_approval"),
    customType: "other-extension",
  };
  const forged = {
    ...gate("awaiting_approval", "awaiting_approval"),
    details: { ...gate("awaiting_approval", "awaiting_approval").details, producer: "other" },
  };
  const compacted = compactHtmlReportGateHistory(
    [failed, completed, unrelated, forged],
    { currentStage: "B2_WRITER", status: "running" }
  );
  assert.equal(compacted[0].content[0].text, "[html-report prior Gate compacted: B0_PREFLIGHT failed]");
  assert.equal(compacted[1].content[0].text, "[html-report prior Gate compacted: B0_PREFLIGHT completed]");
  assert.equal(compacted[2], unrelated);
  assert.equal(compacted[3], forged);
});

const runtimeAgentListContent = [
  "Executable agents:",
  "- report-designer (project): design",
  "- report-researcher (project): research",
  "- report-reviewer (project): review",
  "- report-writer (project): write",
].join("\n");

function createRuntimeListEventBus({
  content = runtimeAgentListContent,
  isError = false,
  emitStarted = true,
  emitResponse = true,
  malformedResponse = false,
} = {}) {
  const listeners = new Map();
  const requests = [];
  const events = {
    on(event, handler) {
      const current = listeners.get(event) || [];
      current.push(handler);
      listeners.set(event, current);
      return () => {
        const next = (listeners.get(event) || []).filter((candidate) => candidate !== handler);
        listeners.set(event, next);
      };
    },
    emit(event, data) {
      for (const handler of [...(listeners.get(event) || [])]) handler(data);
    },
  };
  events.on("subagent:slash:request", (request) => {
    requests.push(request);
    if (emitStarted) events.emit("subagent:slash:started", { requestId: request.requestId });
    if (!emitResponse) return;
    const responseContent = typeof content === "function" ? content(request, requests.length) : content;
    queueMicrotask(() => events.emit("subagent:slash:response", malformedResponse
      ? { requestId: request.requestId, result: null }
      : {
          requestId: request.requestId,
          isError,
          result: {
            isError,
            content: [{ type: "text", text: responseContent }],
            details: { mode: "management", results: [] },
          },
        }));
  });
  return { events, requests, listeners };
}

function createForegroundSubagentEventBus(responder) {
  const listeners = new Map();
  const requests = [];
  const events = {
    on(event, handler) {
      const current = listeners.get(event) || [];
      current.push(handler);
      listeners.set(event, current);
      return () => listeners.set(
        event,
        (listeners.get(event) || []).filter((candidate) => candidate !== handler)
      );
    },
    emit(event, data) {
      for (const handler of [...(listeners.get(event) || [])]) handler(data);
    },
  };
  events.on("subagent:slash:request", (request) => {
    requests.push(request);
    events.emit("subagent:slash:started", { requestId: request.requestId });
    queueMicrotask(async () => {
      try {
        const result = await responder(request, requests.length);
        events.emit("subagent:slash:response", {
          requestId: request.requestId,
          isError: result?.isError === true,
          result,
        });
      } catch (error) {
        events.emit("subagent:slash:response", {
          requestId: request.requestId,
          isError: true,
          result: {
            isError: true,
            content: [{ type: "text", text: error.message || String(error) }],
            details: { mode: "chain", results: [] },
          },
        });
      }
    });
  });
  return { events, requests, listeners };
}

test("runtime agent list inspection accepts canonical package agent names", () => {
  const inspected = inspectRuntimeAgentListResult({
    toolName: "subagent",
    content: [{
      type: "text",
      text: [
        "- qdm-html-report.report-writer (package): write",
        "- qdm-html-report.report-researcher (package): research",
        "- qdm-html-report.report-reviewer (package): review",
        "- qdm-html-report.report-designer (package): design",
      ].join("\n"),
    }],
    isError: false,
  });
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.missingAgents, []);
});

test("runtime agent list inspection requires executable-agent rows, not description substrings", () => {
  assert.equal(inspectRuntimeAgentListResult({
    toolName: "subagent",
    content: [{ type: "text", text: runtimeAgentListContent }],
    isError: false,
  }).ok, true);
  const missing = inspectRuntimeAgentListResult({
    toolName: "subagent",
    content: [{
      type: "text",
      text: "- report-writer (project): mentions report-researcher, report-reviewer and report-designer",
    }],
    isError: false,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingAgents, [
    "report-researcher",
    "report-reviewer",
    "report-designer",
  ]);
});

test("runtime agent list event bridge binds cwd, requires synchronous start and cleans listeners", async () => {
  const bridge = createRuntimeListEventBus();
  const response = await requestRuntimeAgentListViaEventBridge({
    events: bridge.events,
    ctx: { cwd: "/tmp/wrong" },
    projectRoot: repoRoot,
    requestId: "runtime-list-bridge-pass",
    timeoutMs: 100,
  });
  assert.equal(inspectRuntimeAgentListResult(response.event).ok, true);
  assert.equal(bridge.requests.length, 1);
  assert.equal(bridge.requests[0].params.action, "list");
  assert.equal(bridge.requests[0].ctx.cwd, repoRoot);
  assert.equal(bridge.listeners.get("subagent:slash:started").length, 0);
  assert.equal(bridge.listeners.get("subagent:slash:response").length, 0);

  const absent = createRuntimeListEventBus({ emitStarted: false, emitResponse: false });
  await assert.rejects(
    requestRuntimeAgentListViaEventBridge({
      events: absent.events,
      ctx: {},
      projectRoot: repoRoot,
      requestId: "runtime-list-no-start",
      timeoutMs: 100,
    }),
    /no pi-subagents slash bridge received/
  );
  assert.equal(absent.listeners.get("subagent:slash:started").length, 0);
  assert.equal(absent.listeners.get("subagent:slash:response").length, 0);

  const hanging = createRuntimeListEventBus({ emitResponse: false });
  await assert.rejects(
    requestRuntimeAgentListViaEventBridge({
      events: hanging.events,
      ctx: {},
      projectRoot: repoRoot,
      requestId: "runtime-list-timeout",
      timeoutMs: 10,
    }),
    /timed out after 10ms/
  );
  assert.equal(hanging.listeners.get("subagent:slash:started").length, 0);
  assert.equal(hanging.listeners.get("subagent:slash:response").length, 0);

  const foreground = createForegroundSubagentEventBus((request) => ({
    content: [{ type: "text", text: "typed foreground result" }],
    details: { mode: "chain", results: [{ exitCode: 0, agent: request.params.chain[0].agent }] },
  }));
  const params = {
    context: "fresh",
    chain: [{ agent: "report-researcher", task: "generic typed task" }],
  };
  const foregroundResult = await requestSubagentViaEventBridge({
    events: foreground.events,
    ctx: {},
    projectRoot: repoRoot,
    params,
    requestId: "foreground-bridge-pass",
    timeoutMs: 100,
    label: "foreground test",
  });
  assert.deepEqual(foreground.requests[0].params, params);
  assert.deepEqual(foregroundResult.event.input, params);
  assert.equal(foregroundResult.event.details.results[0].agent, "report-researcher");
  assert.equal(foreground.listeners.get("subagent:slash:started").length, 0);
  assert.equal(foreground.listeners.get("subagent:slash:response").length, 0);
});

function waitingState(overrides = {}) {
  return {
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "awaiting_approval",
    currentStage: "B2_WRITER",
    nextStage: "B25_EDITOR",
    cumulativeExecutionDurationMs: 10_000,
    stages: {
      B2_WRITER: {
        status: "awaiting_approval",
        executionDurationMs: 10_000,
        failureReason: null,
      },
    },
    ...overrides,
  };
}

function persistedGateState(state, sid, root = repoRoot) {
  return {
    ...state,
    sessionId: sid,
    sessionDir: htmlReportSessionDir(root, sid),
  };
}

function runningGateState(stageId, startedAt = "2026-07-28T00:00:00.000Z") {
  return {
    version: 1,
    producer: "stage-gate.mjs",
    mode: "auto",
    status: "running",
    currentStage: stageId,
    stages: {
      [stageId]: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt }],
      },
    },
  };
}

test("B2.5 Gate delegates writes/finalize/finish to the typed Planner result and blocks split work", () => {
  const state = runningGateState("B25_EDITOR");
  const session = htmlReportSessionDir(repoRoot, "b25-finalizer");
  state.sessionDir = session;
  for (const event of [
    { toolName: "ls", input: { path: "/tmp/session/analysis" } },
    { toolName: "find", input: { path: "/tmp/session" } },
    { toolName: "grep", input: { pattern: "entry" } },
    { toolName: "bash", input: { command: "ls /tmp/session/analysis" } },
    { toolName: "bash", input: { command: "cd /tmp/session && /bin/ls analysis" } },
    { toolName: "bash", input: { command: "mkdir -p /tmp/session/analysis" } },
    { toolName: "read", input: { path: "/tmp/session/data/cards/c1/entry.json" } },
    { toolName: "bash", input: { command: "cat /tmp/session/data/cards/c1/entry.meta.json" } },
    {
      toolName: "bash",
      input: {
        command: `node ${join(repoRoot, ".agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs")} --result ${join(session, "result.json")} --pending-reuse`,
      },
    },
    {
      toolName: "bash",
      input: {
        command: `node ${join(repoRoot, ".agents/pi/skills/html-report/scripts/assemble-report.mjs")} --session-dir ${session}`,
      },
    },
    {
      toolName: "bash",
      input: {
        command: `node ${join(repoRoot, ".agents/pi/skills/html-report/scripts/finalize-editor-stage.mjs")} --result ${join(session, "result.json")}`,
      },
    },
    {
      toolName: "bash",
      input: {
        command: `node ${join(repoRoot, ".agents/pi/skills/html-report/scripts/stage-gate.mjs")} finish --session-dir ${session} --stage B25_EDITOR --format text`,
      },
    },
    { toolName: "write", input: { path: "/tmp/session/analysis/tasks.json", content: "{}" } },
    { toolName: "edit", input: { path: "/tmp/session/analysis/main.md", oldText: "a", newText: "b" } },
  ]) {
    const decision = b25EditorToolDecision(state, event);
    assert.equal(decision?.block, true, JSON.stringify(event));
  }

  for (const event of [
    {
      toolName: "bash",
      input: {
        command: "node .agents/pi/skills/html-report/scripts/stage-gate.mjs status --session-dir /tmp/session --format text",
      },
    },
    {
      toolName: "bash",
      input: {
        command: "node .agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs --result /tmp/session/result.json --source-fields",
      },
    },
  ]) {
    assert.equal(b25EditorToolDecision(state, event), null, JSON.stringify(event));
  }
});

function assertFixedContractEnvelope(input, { stepModel } = {}) {
  assert.equal(input.agentScope, "project");
  assert.equal(input.context, "fresh");
  assert.equal(input.cwd, repoRoot);
  assert.equal(input.async, false);
  assert.equal(input.clarify, false);
  for (const key of [
    "agent", "task", "tasks", "acceptance", "skill", "model", "output", "outputMode",
    "worktree", "chainDir", "artifacts", "includeProgress", "share", "sessionDir", "control",
  ]) {
    assert.equal(input[key], undefined, `top-level hostile ${key} override must be removed`);
  }
  const [step] = input.chain;
  assert.equal(step.cwd, repoRoot);
  assert.equal(step.acceptance?.level, "none");
  assert.match(step.acceptance?.reason || "", /structured return and persisted artifacts/);
  for (const key of ["output", "outputMode", "reads", "progress", "skill", "phase", "label", "as"]) {
    assert.equal(step[key], undefined, `step hostile ${key} override must be removed`);
  }
  assert.equal(step.model, stepModel, "step model must be absent unless the contract owns an exact role model");
}

function hostileContractOverrides() {
  return {
    agent: "worker",
    task: "hostile top-level single task",
    tasks: [{ agent: "worker", task: "hostile unrelated parallel task" }],
    agentScope: "user",
    context: "fork",
    cwd: "/tmp/hostile-contract-cwd",
    acceptance: "verified",
    skill: ["hostile-skill"],
    model: "hostile/model",
    output: "/tmp/hostile-output.md",
    outputMode: "file-only",
    worktree: true,
    chainDir: "/tmp/hostile-chain",
    artifacts: false,
    includeProgress: true,
    share: true,
    sessionDir: "/tmp/hostile-sessions",
    control: { enabled: true },
  };
}

function hostileStepOverrides() {
  return {
    cwd: "/tmp/hostile-step-cwd",
    acceptance: "verified",
    skill: ["hostile-step-skill"],
    model: "hostile/step-model",
    output: "/tmp/hostile-step-output.md",
    outputMode: "file-only",
    reads: ["/tmp/secret"],
    progress: true,
    phase: "hostile",
    label: "hostile",
    as: "hostile",
  };
}

function registerHarnessExtension({ initialTools, events } = {}) {
  const handlers = new Map();
  const tools = new Map();
  let activeTools = [...(initialTools || ["read", "bash", "subagent", "write"])] ;
  const toolHistory = [];
  qdmHarnessExtension({
    cwd: repoRoot,
    events,
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
      toolHistory.push([...names]);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  handlers.activeTools = () => [...activeTools];
  handlers.toolHistory = toolHistory;
  handlers.tools = tools;
  return handlers;
}

function createCanonicalDelegationBus(resultFactory) {
  const listeners = new Map();
  const emitted = [];
  const bus = {
    on(event, handler) {
      const current = listeners.get(event) || new Set();
      current.add(handler);
      listeners.set(event, current);
      return () => current.delete(handler);
    },
    emit(event, data) {
      emitted.push({ event, data });
      for (const handler of [...(listeners.get(event) || [])]) handler(data);
      if (event !== "prompt-template:subagent:request") return;
      if (!data.agent || !data.task || !data.result) {
        bus.emit("prompt-template:subagent:response", {
          requestId: data.requestId,
          ownerRunId: data.ownerRunId,
          nodeId: data.nodeId,
          status: "invalid_request",
          error: "capability probe",
        });
        return;
      }
      bus.emit("prompt-template:subagent:started", {
        requestId: data.requestId,
        ownerRunId: data.ownerRunId,
        nodeId: data.nodeId,
      });
      const value = resultFactory(data);
      bus.emit("prompt-template:subagent:response", {
        requestId: data.requestId,
        ownerRunId: data.ownerRunId,
        nodeId: data.nodeId,
        status: "completed",
        result: { kind: "structured", value },
      });
    },
  };
  bus.emitted = emitted;
  return bus;
}

let contractEventSerial = 0;
function contractCall(input, label = "contract") {
  contractEventSerial += 1;
  return {
    toolCallId: `${label}-${process.pid}-${contractEventSerial}`,
    toolName: "subagent",
    input,
  };
}

function contractResult(call, overrides = {}) {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    ...overrides,
  };
}

async function writeWriterCaptionArtifacts(cardDir, cardId = "card-1") {
  await writeFile(join(cardDir, "caption.md"), "本卡最高为 100。\n");
  await writeFile(join(cardDir, "caption-evidence.json"), JSON.stringify({
    producer: "prepare-card-caption-evidence.mjs",
    cardId,
    rowCount: 1,
    query: { metrics: [], statisticPolicy: "SUMMARY", dimensions: [], time: null, comparisons: [] },
    axis: [],
    groups: [],
    droppedDimensions: [],
    views: {},
  }));
}

function writerAckChildResult(receipt, extras = {}) {
  return {
    exitCode: extras.exitCode ?? 0,
    error: extras.error,
    messages: [{
      role: "toolResult",
      toolName: "ack_cli_data",
      isError: extras.toolIsError === true,
      content: [{ type: "text", text: JSON.stringify(receipt) }],
      details: receipt,
    }],
  };
}

async function seedMinimalReviewerInputs(session) {
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(
    join(session, "result.json"),
    JSON.stringify({ status: "confirmed", cards: [] })
  );
  await writeFile(
    join(session, "analysis", "main.md"),
    "# 报告结论\n\n当前证据不足，待质量审核。\n"
  );
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 0,
    maxRounds: 2,
    tasks: [],
  }));
  await assembleReport(session);
}

test("B2 stage runner treats awaiting Main approval as successful work", () => {
  assert.equal(b2WriterMainWorkAccepted({
    stages: {
      B2_WRITER: { status: "completed" },
      B2_MAIN: { status: "awaiting_approval" },
    },
  }), true);
  assert.equal(b2WriterMainWorkAccepted({
    stages: {
      B2_WRITER: { status: "completed" },
      B2_MAIN: { status: "completed" },
    },
  }), true);
  assert.equal(b2WriterMainWorkAccepted({
    stages: {
      B2_WRITER: { status: "completed" },
      B2_MAIN: { status: "running" },
    },
  }), false);
});

async function seedB2MainGate(t, name) {
  const root = await mkdtemp(join(tmpdir(), `html-report-${name}-`));
  const sid = name;
  const session = htmlReportSessionDir(root, sid);
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    session_id: sid,
    cards: [],
  }));
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(join(session, "analysis", "main.md"), "# 初版\n");
  await initPipeline(session, { mode: "step", sessionId: sid });
  await startPipelineStage(session, "A_CONFIG");
  await finishPipelineStage(session, "A_CONFIG");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B0_PREFLIGHT");
  await finishPipelineStage(session, "B2_WRITER");
  await finishPipelineStage(session, "B2_MAIN");
  return { root, sid, session };
}

test("HTML phrases only run on B2_MAIN; export failure keeps the gate approvable", async (t) => {
  const waitingA = waitingState({
    currentStage: "A_CONFIG",
    status: "awaiting_approval",
    stages: { A_CONFIG: { status: "awaiting_approval", attempts: [{ number: 1, startedAt: "2026-08-20T00:00:00.000Z" }] } },
  });
  const aRoot = await mkdtemp(join(tmpdir(), "html-report-a-config-html-"));
  t.after(async () => rm(aRoot, { recursive: true, force: true }));
  const aSid = "a-config-html";
  const aSession = htmlReportSessionDir(aRoot, aSid);
  await mkdir(dirname(pipelineStatePath(aSession)), { recursive: true });
  await writeFile(
    pipelineStatePath(aSession),
    JSON.stringify(persistedGateState(waitingA, aSid, aRoot)),
  );
  const rejected = await applyGateInput(aRoot, aSid, "生成 HTML");
  assert.equal(rejected.rejected, "html_only_on_b2_main");

  const seeded = await seedB2MainGate(t, "html-fail-continue");
  const failed = await applyGateInput(seeded.root, seeded.sid, "生成 HTML", {
    exportHtml: async () => ({ ok: false, status: "failed", error: "md2html boom" }),
  });
  assert.equal(failed.handled, true);
  assert.equal(failed.exportResult.ok, false);
  assert.equal(readGateState(seeded.root, seeded.sid).status, "awaiting_approval");
  assert.match(failed.message, /HTML 生成失败/);
  assert.match(await readFile(join(seeded.session, "analysis", "main.md"), "utf8"), /初版/);

  const skipped = await applyGateInput(seeded.root, seeded.sid, "继续");
  assert.equal(skipped.result?.ok, true);
  assert.equal(readGateState(seeded.root, seeded.sid).status, "completed");
});

test("生成 HTML success approves B2_MAIN; skip and retry stay on the export path", async (t) => {
  const generated = await seedB2MainGate(t, "html-generate-ok");
  const ok = await applyGateInput(generated.root, generated.sid, "生成 HTML", {
    exportHtml: async () => ({
      ok: true,
      status: "generated",
      htmlPath: join(generated.session, "analysis", "main.html"),
    }),
  });
  assert.equal(ok.exportResult.status, "generated");
  assert.equal(readGateState(generated.root, generated.sid).status, "completed");
  assert.match(ok.message, /已生成 analysis\/main\.html/);

  const skipSession = await seedB2MainGate(t, "html-skip");
  const skipped = await applyGateInput(skipSession.root, skipSession.sid, "暂不生成 HTML", {
    exportHtml: async () => {
      throw new Error("skip must not export");
    },
  });
  assert.equal(skipped.action, "skip_html");
  assert.equal(skipped.exportResult, null);
  assert.equal(readGateState(skipSession.root, skipSession.sid).status, "completed");

  const retrySession = await seedB2MainGate(t, "html-retry");
  const retryFail = await applyGateInput(retrySession.root, retrySession.sid, "重试 HTML 生成", {
    exportHtml: async () => ({ ok: false, status: "failed", error: "once" }),
  });
  assert.equal(readGateState(retrySession.root, retrySession.sid).status, "awaiting_approval");
  const retryOk = await applyGateInput(retrySession.root, retrySession.sid, "重试 HTML 生成", {
    exportHtml: async () => ({ ok: true, status: "generated", htmlPath: "/tmp/main.html" }),
  });
  assert.equal(retryFail.action, "retry_html");
  assert.equal(retryOk.exportResult.status, "generated");
  assert.equal(readGateState(retrySession.root, retrySession.sid).status, "completed");

  const later = await applyGateInput(generated.root, generated.sid, "生成 HTML", {
    exportHtml: async () => ({ ok: true, status: "up_to_date", htmlPath: join(generated.session, "analysis", "main.html") }),
  });
  assert.equal(later.exportResult.status, "up_to_date");
  assert.equal(readGateState(generated.root, generated.sid).status, "completed");
});

test("original four gate phrases still classify after HTML options", () => {
  assert.equal(classifyGateInput("继续"), "continue");
  assert.equal(classifyGateInput("继续。"), "continue");
  assert.equal(classifyGateInput("确认生成报告"), "confirm");
  assert.equal(classifyGateInput("重试当前阶段"), "retry");
  assert.equal(classifyGateInput("关闭单步调试并继续"), "disable_step");
  assert.equal(classifyGateInput("生成 HTML"), "generate_html");
  assert.equal(classifyGateInput("生成HTML"), "generate_html");
  assert.equal(classifyGateInput("重试 HTML 生成"), "retry_html");
  assert.equal(classifyGateInput("暂不生成 HTML"), "skip_html");
  assert.equal(classifyGateInput("请继续分析"), null);
  assert.equal(classifyGateInput("可以了"), null);
  assert.equal(classifyGateInput("生成一下 HTML"), null);
});

test("running report stages reveal only the stable stage runner tool", () => {
  const state = runningGateState("B2_WRITER");
  state.mode = "step";
  const banner = gateContextBanner(repoRoot, "shape-banner", state, {
    writerCardIds: ["card-1", "card-2"],
  });
  assert.equal(banner, `NEXT_TOOL_ONLY：${HTML_REPORT_STAGE_TOOL}()`);
  assert.doesNotMatch(banner, /card-1|card-2|report-writer|subagent\(\{|stage-gate/);

  const preflightState = runningGateState("B0_PREFLIGHT");
  preflightState.mode = "step";
  const preflightBanner = gateContextBanner(repoRoot, "runtime-list-banner", preflightState);
  assert.match(preflightBanner, /扩展重新执行一次独立的 runtime agent list/);
  assert.match(preflightBanner, /不得复用 A_CONFIG 的审计结果/);
  assert.match(preflightBanner, /真实 pi-subagents 事件桥/);
  assert.match(preflightBanner, /phase-a layout 和 finish\/fail/);
  assert.match(preflightBanner, /模型不得调用 subagent list、Bash、layout 或 stage-gate/);
  for (const agent of ["report-writer", "report-researcher", "report-reviewer", "report-designer"]) {
    assert.match(preflightBanner, new RegExp(agent));
  }
  assert.match(preflightBanner, /扩展会自动 fail/);

  const fixedWaiting = waitingState({
    currentStage: "A_CONFIG",
    nextStage: "B0_PREFLIGHT",
    stages: {
      A_CONFIG: {
        status: "awaiting_approval",
        attempts: [{ number: 1, status: "completed", startedAt: "2026-07-29T00:00:00.000Z" }],
      },
    },
  });
  const fixedBanner = gateContextBanner(repoRoot, "fixed-runtime-list", fixedWaiting, {
    fixedAConfig: true,
  });
  assert.match(fixedBanner, /awaiting_approval[\s\S]*状态：completed[\s\S]*两者含义不同/);
  assert.match(fixedBanner, /runtime agent list 已由扩展.*自动验收/);
  assert.match(fixedBanner, /立即原样返回.*不要调用 subagent/);
  assert.doesNotMatch(fixedBanner, /必须且只调用一次.*subagent/);

  const b0Waiting = waitingState({
    currentStage: "B0_PREFLIGHT",
    nextStage: "B2_WRITER",
    stages: {
      B0_PREFLIGHT: {
        status: "awaiting_approval",
        attempts: [{ number: 1, status: "completed", startedAt: "2026-07-29T00:00:01.000Z" }],
      },
    },
  });
  const b0WaitingBanner = gateContextBanner(repoRoot, "b0-consumed-input", b0Waiting);
  assert.match(b0WaitingBanner, /显式兼容策略.*B0.*人工 Gate/);
  assert.match(b0WaitingBanner, /默认策略下 B0 成功会自动进入 B2/);
  assert.match(b0WaitingBanner, /CURRENT INPUT IS CONSUMED/);
  assert.match(b0WaitingBanner, /当前用户的“继续”只用于进入并完成这个兼容 B0 Gate/);
  assert.match(b0WaitingBanner, /同一输入不能再次批准 B0/);
  assert.match(b0WaitingBanner, /下一条 assistant 响应必须只原样返回.*B0 Gate 文本/);
  assert.match(b0WaitingBanner, /用户随后新发一条“继续”后才会.*启动 B2 Writer/);

  const researcherState = runningGateState("B3_RESEARCH");
  researcherState.mode = "step";
  const researcherBanner = gateContextBanner(
    repoRoot,
    "researcher-shape-banner",
    researcherState
  );
  assert.equal(researcherBanner, `NEXT_TOOL_ONLY：${HTML_REPORT_STAGE_TOOL}()`);
  assert.doesNotMatch(researcherBanner, /subagent|evidencePath|stage-gate/);

  const editorState = runningGateState("B25_EDITOR");
  editorState.mode = "step";
  const editorBanner = gateContextBanner(repoRoot, "editor-next-tool-banner", editorState);
  assert.equal(editorBanner, `NEXT_TOOL_ONLY：${HTML_REPORT_STAGE_TOOL}()`);
  assert.doesNotMatch(editorBanner, /subagent|sibling|stage-gate|HTML_REPORT_EDITOR_PLAN_V1/);

  const mainWaiting = waitingState({
    currentStage: "B2_MAIN",
    nextStage: null,
    stages: {
      B2_MAIN: {
        status: "awaiting_approval",
        attempts: [{ number: 1, status: "completed", startedAt: "2026-08-20T00:00:00.000Z" }],
      },
    },
  });
  const mainBanner = gateContextBanner(repoRoot, "b2-main-html-banner", mainWaiting);
  assert.match(mainBanner, /生成 HTML/);
  assert.match(mainBanner, /暂不生成 HTML/);
  assert.match(mainBanner, /重试 HTML 生成/);
  assert.match(mainBanner, /禁止手写 HTML，禁止直接调用 md2html 或 Bash/);
  assert.match(mainBanner, /HTML 失败时 Gate 保持可批准/);
});

test("running report stage exposes only the registered stage runner tool", async (t) => {
  const initialTools = ["read", "bash", "subagent", "write"];
  const handlers = registerHarnessExtension({ initialTools });
  const beforeAgentStart = handlers.get("before_agent_start")[0];
  const toolCall = handlers.get("tool_call")[0];
  const agentSettled = handlers.get("agent_settled")[0];
  const sid = `stage-runner-tools-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const state = runningGateState("B2_WRITER", "2026-08-18T00:00:00.000Z");
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(pipelineStatePath(session), JSON.stringify(persistedGateState(state, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);

  const started = await beforeAgentStart({ prompt: "继续", systemPrompt: "base" }, ctx);
  assert.match(started.systemPrompt, new RegExp(`${HTML_REPORT_STAGE_TOOL}\\(\\)`));
  assert.deepEqual(handlers.activeTools(), [HTML_REPORT_STAGE_TOOL]);
  assert.ok(handlers.tools.has(HTML_REPORT_STAGE_TOOL));

  const oldPath = await toolCall({
    toolCallId: "legacy-writer",
    toolName: "subagent",
    input: { chain: [{ agent: "report-writer", task: "legacy model-facing dispatch" }] },
  }, ctx);
  assert.equal(oldPath.block, true);
  assert.match(oldPath.reason, new RegExp(HTML_REPORT_STAGE_TOOL));

  assert.equal(await toolCall({
    toolCallId: "legacy-reservation-ignored",
    toolName: HTML_REPORT_STAGE_TOOL,
    input: { reservation: "qdm-stage-v1-stale" },
  }, ctx), undefined);

  assert.equal(await toolCall({
    toolCallId: "valid-stage-runner",
    toolName: HTML_REPORT_STAGE_TOOL,
    input: {},
  }, ctx), undefined);

  await agentSettled({}, ctx);
  assert.equal(readGateState(repoRoot, sid).status, "paused");
  assert.deepEqual(handlers.activeTools(), initialTools);
});

test("standalone parser rejects chaining and accepts direct status/finish", () => {
  const status = parseStandaloneStageGateCommand(
    "node '/repo/stage-gate.mjs' status --session-dir '/repo/.harness/state/html-report/s1' --format text"
  );
  assert.equal(status.operation, "status");
  assert.equal(status.options["--format"], "text");

  const finish = parseStandaloneStageGateCommand(
    "node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish --session-dir \"$SESSION\" --stage B2_WRITER --format text"
  );
  assert.equal(finish.operation, "finish");
  assert.equal(finish.options["--stage"], "B2_WRITER");
  const continued = parseStandaloneStageGateCommand(
    "node stage-gate.mjs finish \\\n      --session-dir /tmp/s \\\n      --stage B2_WRITER --format text"
  );
  assert.equal(continued.operation, "finish");
  assert.equal(parseStandaloneStageGateCommand("echo work && node stage-gate.mjs finish"), null);
  assert.equal(parseStandaloneStageGateCommand("node stage-gate.mjs finish | tee out"), null);
  assert.equal(parseStandaloneStageGateCommand("node stage-gate.mjs finish\nnode next.mjs"), null);
});

test("normalizer repairs only observed safe standalone stage-gate command drifts", () => {
  const redirected = "node stage-gate.mjs finish --session-dir /tmp/s --stage B0_PREFLIGHT --format text 2>&1";
  assert.equal(
    normalizeStandaloneStageGateCommand(redirected),
    "node stage-gate.mjs finish --session-dir /tmp/s --stage B0_PREFLIGHT --format text"
  );
  const realScript = stageGateScriptPath(repoRoot);
  const missingRoot = `node '.${realScript.slice(1)}' finish --session-dir /tmp/s --stage B0_PREFLIGHT --format text`;
  assert.equal(
    normalizeStandaloneStageGateCommand(missingRoot),
    `node '${realScript}' finish --session-dir /tmp/s --stage B0_PREFLIGHT --format text`
  );
  for (const unsafe of [
    "node stage-gate.mjs finish --session-dir /tmp/s --stage B0_PREFLIGHT > /tmp/x 2>&1",
    "echo bad && node stage-gate.mjs finish --session-dir /tmp/s --stage B0_PREFLIGHT 2>&1",
    "node stage-gate.mjs finish --session-dir /tmp/s --stage B0_PREFLIGHT 2>&1 && echo bad",
    "node '.Users/not-real/stage-gate.mjs' finish --session-dir /tmp/s --stage B0_PREFLIGHT --format text",
  ]) {
    assert.equal(normalizeStandaloneStageGateCommand(unsafe), unsafe);
  }
});

test("waiting gate allows readonly tools and status but blocks advancing tools", () => {
  const state = waitingState();
  for (const toolName of ["read", "grep", "find", "ls"]) {
    assert.equal(gateToolDecision(state, { toolName, input: {} }), null);
  }
  assert.equal(
    gateToolDecision(state, {
      toolName: "bash",
      input: { command: "node stage-gate.mjs status --session-dir /tmp/s --format text" },
    }),
    null
  );
  for (const toolName of ["bash", "write", "edit", "subagent"]) {
    const input = toolName === "bash" ? { command: "node fetch-entry.mjs" } : {};
    const decision = gateToolDecision(state, { toolName, input });
    assert.equal(decision.block, true, `${toolName} should be blocked`);
    assert.match(decision.reason, /立即停止工具调用.*不得主动检查目录/);
  }
});

test("only the exact read-only subagent list shape is eligible during waiting A_CONFIG", () => {
  const state = waitingState({
    currentStage: "A_CONFIG",
    nextStage: "B0_PREFLIGHT",
    stages: {
      A_CONFIG: {
        status: "awaiting_approval",
        attempts: [{ number: 1, status: "completed", startedAt: "2026-07-29T00:00:00.000Z" }],
      },
    },
  });
  assert.equal(
    isWaitingAConfigAgentList(state, { toolName: "subagent", input: { action: "list" } }),
    true
  );
  assert.equal(
    isWaitingAConfigAgentList(state, {
      toolName: "subagent",
      input: { action: "list", agentScope: "project" },
    }),
    false
  );
  assert.equal(
    isWaitingAConfigAgentList(state, { toolName: "subagent", input: { action: "cancel" } }),
    false
  );
  assert.equal(
    isWaitingAConfigAgentList(waitingState(), { toolName: "subagent", input: { action: "list" } }),
    false
  );
});

test("runtime hook permits one A_CONFIG subagent list and blocks a duplicate", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const sid = `waiting-a-list-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(pipelineStatePath(session), JSON.stringify(persistedGateState({
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "awaiting_approval",
    currentStage: "A_CONFIG",
    nextStage: "B0_PREFLIGHT",
    stages: {
      A_CONFIG: {
        status: "awaiting_approval",
        attempts: [{ number: 1, status: "completed", startedAt: "2026-07-29T00:00:00.000Z" }],
      },
    },
  }, sid), null, 2));
  writeHtmlReportRuntimeContract(repoRoot, sid);

  const first = await toolCall({
    toolCallId: "a-list-1",
    toolName: "subagent",
    input: { action: "list" },
  }, ctx);
  assert.equal(first, undefined);

  const duplicate = await toolCall({
    toolCallId: "a-list-2",
    toolName: "subagent",
    input: { action: "list" },
  }, ctx);
  assert.equal(duplicate.block, true);
  assert.match(duplicate.reason, /只允许一次/);

  const execution = await toolCall({
    toolCallId: "a-run-1",
    toolName: "subagent",
    input: { agent: "worker", task: "must stay blocked" },
  }, ctx);
  assert.equal(execution.block, true);
  assert.match(execution.reason, /前置条件未满足/);

  const toolResult = handlers.get("tool_result")[0];
  const accepted = await toolResult({
    toolCallId: "a-list-1",
    toolName: "subagent",
    input: { action: "list" },
    content: [{ type: "text", text: runtimeAgentListContent }],
    isError: false,
  }, ctx);
  assert.equal(accepted.isError, false);

  const b0State = persistedGateState(runningGateState("B0_PREFLIGHT"), sid);
  b0State.mode = "step";
  await writeFile(pipelineStatePath(session), JSON.stringify(b0State, null, 2));
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  const finishCommand = `node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish --session-dir "${session}" --stage B0_PREFLIGHT --format text`;
  const reusedAList = await toolCall({
    toolCallId: "b0-finish-before-list",
    toolName: "bash",
    input: { command: finishCommand },
  }, ctx);
  assert.equal(reusedAList.block, true);
  assert.match(reusedAList.reason, /B0_PREFLIGHT.*尚未执行本阶段独立/);

  const b0List = {
    toolCallId: "b0-list-1",
    toolName: "subagent",
    input: { action: "list" },
  };
  assert.equal(await toolCall(b0List, ctx), undefined);
  const acceptedB0 = await toolResult({
    ...b0List,
    content: [{ type: "text", text: runtimeAgentListContent }],
    isError: false,
  }, ctx);
  assert.equal(acceptedB0.isError, false);
  assert.match(acceptedB0.content.at(-1).text, /phase-a layout：passed/);
  const completedB0 = await pipelineStatus(session);
  assert.equal(completedB0.state.currentStage, "B2_WRITER");
  assert.equal(completedB0.state.status, "running");
  assert.equal(completedB0.state.stages.B0_PREFLIGHT.status, "completed");
  const redundantFinish = await toolCall({
    toolCallId: "b0-finish-after-list",
    toolName: "bash",
    input: { command: finishCommand },
  }, ctx);
  assert.equal(redundantFinish.block, true);
});

test("B0 runtime list auto-fails when phase-a result.json is missing or invalid", async (t) => {
  for (const fixture of [
    {
      name: "missing result.json",
      resultText: null,
      expectedReason: /missing result\.json/,
    },
    {
      name: "invalid result.json",
      resultText: "{not-json",
      expectedReason: /result\.json is not valid JSON/,
    },
  ]) {
    await t.test(fixture.name, async (t) => {
      const handlers = registerHarnessExtension();
      const toolCall = handlers.get("tool_call")[0];
      const toolResult = handlers.get("tool_result")[0];
      const sid = `b0-layout-failure-${fixture.name.startsWith("missing") ? "missing" : "invalid"}-${process.pid}-${Date.now()}`;
      const session = htmlReportSessionDir(repoRoot, sid);
      const ctx = { sessionManager: { getSessionId: () => sid } };
      t.after(async () => rm(session, { recursive: true, force: true }));

      await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
      const b0State = persistedGateState(runningGateState("B0_PREFLIGHT"), sid);
      b0State.mode = "step";
      await writeFile(pipelineStatePath(session), JSON.stringify(b0State, null, 2));
      writeHtmlReportRuntimeContract(repoRoot, sid);
      if (fixture.resultText !== null) {
        await writeFile(join(session, "result.json"), fixture.resultText);
      }

      const b0List = {
        toolCallId: `b0-layout-failure-list-${sid}`,
        toolName: "subagent",
        input: { action: "list" },
      };
      assert.equal(await toolCall(b0List, ctx), undefined);
      const rejected = await toolResult({
        ...b0List,
        content: [{ type: "text", text: runtimeAgentListContent }],
        isError: false,
      }, ctx);

      assert.equal(rejected.isError, true);
      const failureText = rejected.content.at(-1).text;
      assert.match(failureText, /B0 phase-a layout failed:/);
      assert.match(failureText, fixture.expectedReason);
      assert.match(failureText, /状态：failed/);

      const status = await pipelineStatus(session);
      assert.equal(status.state.currentStage, "B0_PREFLIGHT");
      assert.equal(status.state.status, "failed");
      assert.equal(status.state.stages.B0_PREFLIGHT.status, "failed");
      assert.match(status.state.stages.B0_PREFLIGHT.failureReason, fixture.expectedReason);
      assert.equal(status.state.stages.B2_WRITER, undefined, "failed phase-a layout must not finish B0");
    });
  }
});

test("running report gate accepts the no-arg stage runner and ignores leftover reservation args", () => {
  const state = runningGateState("B2_WRITER", "2026-08-18T01:00:00.000Z");
  assert.equal(gateToolDecision(state, {
    toolName: HTML_REPORT_STAGE_TOOL,
    input: {},
  }), null);
  assert.equal(gateToolDecision(state, {
    toolName: HTML_REPORT_STAGE_TOOL,
    input: { reservation: "qdm-stage-v1-stale" },
  }), null);

  for (const event of [
    { toolName: "bash", input: { command: "node stage-gate.mjs finish --stage B2_WRITER" } },
    { toolName: "subagent", input: { chain: [{ agent: "report-writer", task: "legacy" }] } },
  ]) {
    const blocked = gateToolDecision(state, event);
    assert.equal(blocked.block, true);
  }

  const inFlight = gateToolDecision(
    state,
    { toolName: HTML_REPORT_STAGE_TOOL, input: {} },
    { finishInFlight: true },
  );
  assert.equal(inFlight.block, true);
});

test("failed gate cannot be advanced with normal tools", () => {
  const state = waitingState({ status: "failed" });
  state.stages.B2_WRITER.status = "failed";
  state.stages.B2_WRITER.failureReason = "layout failed";
  const decision = gateToolDecision(state, { toolName: "subagent", input: { agent: "report-writer" } });
  assert.equal(decision.block, true);
  assert.match(decision.reason, /重试当前阶段/);
  assert.equal(
    gateToolDecision({ ...state, mode: "auto" }, { toolName: "subagent", input: {} }).block,
    true
  );
});

test("running html-report Gates only allow their stage-specific subagent role", () => {
  const state = (currentStage) => ({ status: "running", currentStage });
  const call = (input) => ({ toolName: "subagent", input });

  for (const stageId of ["A_CONFIG", "B0_PREFLIGHT"]) {
    assert.equal(runningGateSubagentDecision(state(stageId), call({ action: "list" })), undefined);
    assert.match(
      runningGateSubagentDecision(state(stageId), call({ agent: "worker", task: "bypass" })).reason,
      /action="list"/
    );
  }

  const allowed = [
    ["B2_WRITER", "report-writer"],
    ["B3_RESEARCH", "report-researcher"],
    ["B4_REVIEW", "report-researcher"],
    ["B4_REVIEW", "report-reviewer"],
    ["B5_DESIGN", "report-designer"],
  ];
  for (const [stageId, agent] of allowed) {
    assert.equal(
      runningGateSubagentDecision(state(stageId), call({ chain: [{ agent, task: "valid stage role" }] })),
      undefined,
      `${stageId} must allow ${agent}`
    );
  }

  const denied = [
    ["B2_WRITER", "worker"],
    ["B2_WRITER", "report-researcher"],
    ["B3_RESEARCH", "report-writer"],
    ["B4_REVIEW", "worker"],
    ["B5_DESIGN", "report-reviewer"],
  ];
  for (const [stageId, agent] of denied) {
    const decision = runningGateSubagentDecision(state(stageId), call({ agent, task: "wrong stage role" }));
    assert.equal(decision.block, true, `${stageId} must reject ${agent}`);
    assert.match(decision.reason, new RegExp(stageId));
  }

  assert.equal(
    runningGateSubagentDecision(state("B25_EDITOR"), call({
      chain: [{
        agent: "report-researcher",
        task: "HTML_REPORT_EDITOR_PLAN_V1\nSESSION=/tmp/session\nresult.json=/tmp/session/result.json",
      }],
    })),
    undefined,
    "Editor timing stage allows only the explicit Planner mode"
  );
  for (const input of [
    { agent: "report-researcher", task: "ordinary Researcher" },
    { chain: [{ agent: "report-researcher", task: "ordinary Researcher" }] },
    { chain: [{ agent: "report-writer", task: "wrong child" }] },
  ]) {
    assert.equal(
      runningGateSubagentDecision(state("B25_EDITOR"), call(input)).block,
      true,
      "B25 must reject ordinary Researcher and every non-Planner child"
    );
  }
  assert.equal(
    runningGateSubagentDecision(state("B3_RESEARCH"), call({ action: "list" })).block,
    true,
    "agent discovery is not research work"
  );
  assert.equal(
    runningGateSubagentDecision(null, call({ agent: "worker" })),
    undefined,
    "ordinary sessions without a Gate must remain unaffected"
  );
  assert.equal(
    runningGateSubagentDecision(state("B2_WRITER"), { toolName: "read", input: {} }),
    undefined,
    "the allowlist only governs subagent calls"
  );
});

async function seedStageRunnerGate(t, stageId, label) {
  const sid = `${label}-${process.pid}-${Date.now()}-${++contractEventSerial}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const state = runningGateState(stageId, `2026-08-18T02:00:${String(contractEventSerial).padStart(2, "0")}.000Z`);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(pipelineStatePath(session), JSON.stringify(persistedGateState(state, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  return { sid, session, state, ctx };
}

function failedDesignerReturn(session, message = "capture-report failed: browser unavailable") {
  const paths = designerReturnPaths({ sessionDir: session });
  return {
    status: "failed",
    paths: {
      reportHtml: paths.reportHtml,
      renderMeta: paths.renderMeta,
      designResult: paths.designResult,
      desktopScreenshot: paths.desktopScreenshot,
      mobileScreenshot: paths.mobileScreenshot,
    },
    layoutOk: false,
    repairRounds: 0,
    elapsedMs: 0,
    residualNotes: ["恢复浏览器依赖后由用户重试当前阶段"],
    error: message,
  };
}

test("model-facing subagent dispatch is cut off for every runner-owned report stage", async (t) => {
  for (const stageId of ["B2_WRITER", "B25_EDITOR", "B3_RESEARCH", "B4_REVIEW", "B5_DESIGN"]) {
    const seeded = await seedStageRunnerGate(t, stageId, `legacy-cutoff-${stageId}`);
    const handlers = registerHarnessExtension();
    const toolCall = handlers.get("tool_call")[0];
    const blocked = await toolCall({
      toolCallId: `legacy-${stageId}`,
      toolName: "subagent",
      input: { chain: [{ agent: "report-researcher", task: "legacy model-facing child" }] },
    }, seeded.ctx);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, new RegExp(HTML_REPORT_STAGE_TOOL));
  }
});

test("registered stage runner invokes one canonical owned-leaf child and settles B5", async (t) => {
  const seeded = await seedStageRunnerGate(t, "B5_DESIGN", "canonical-stage-runner");
  const events = createCanonicalDelegationBus(() => failedDesignerReturn(seeded.session));
  const handlers = registerHarnessExtension({ events });
  const toolCall = handlers.get("tool_call")[0];
  const stageTool = handlers.tools.get(HTML_REPORT_STAGE_TOOL);
  assert.ok(stageTool);
  assert.equal(stageTool.parameters.required, undefined);
  assert.equal(stageTool.parameters.additionalProperties, true);

  const call = {
    toolCallId: "canonical-stage-call",
    toolName: HTML_REPORT_STAGE_TOOL,
    input: {},
  };
  assert.equal(await toolCall(call, seeded.ctx), undefined);
  const result = await stageTool.execute(call.toolCallId, call.input, undefined, undefined, seeded.ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /B5_DESIGN|failed/);
  assert.equal(readGateState(repoRoot, seeded.sid).status, "failed");

  const childRequests = events.emitted.filter(({ event, data }) =>
    event === "prompt-template:subagent:request" && data.agent === "report-designer"
  );
  assert.equal(childRequests.length, 1);
  const request = childRequests[0].data;
  assert.equal(Object.hasOwn(request, "version"), false);
  assert.equal(request.context, "fresh");
  assert.equal(request.cwd, repoRoot);
  assert.equal(request.result.kind, "structured");
  assert.equal(Object.hasOwn(request, "chain"), false);
  assert.match(request.ownerRunId, /^qdm-/);
  assert.match(request.nodeId, /^report-designer-/);

  const dispatches = await readdir(join(seeded.session, "debug", "contract-runtime", "dispatches"));
  const settlements = await readdir(join(seeded.session, "debug", "contract-runtime", "settlements"));
  const stageRuns = await readdir(join(seeded.session, "debug", "contract-runtime", "stage-runs"));
  assert.equal(dispatches.length, 1);
  assert.equal(settlements.length, 1);
  assert.equal(stageRuns.length, 1);
});

test("stage runner fails closed when the pi-subagents event bridge is unavailable", async (t) => {
  const seeded = await seedStageRunnerGate(t, "B5_DESIGN", "missing-stage-transport");
  const handlers = registerHarnessExtension();
  const stageTool = handlers.tools.get(HTML_REPORT_STAGE_TOOL);
  const result = await stageTool.execute(
    "missing-stage-transport-call",
    {},
    undefined,
    undefined,
    seeded.ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /event bridge is unavailable/);
  assert.equal(readGateState(repoRoot, seeded.sid).status, "failed");
  const stageRuns = await readdir(join(seeded.session, "debug", "contract-runtime", "stage-runs"));
  assert.equal(stageRuns.length, 1);
});

test("parent gate state is not reused by a child Pi session id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-extension-isolation-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const parentDir = htmlReportSessionDir(root, "parent-session");
  const statePath = pipelineStatePath(parentDir);
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persistedGateState(waitingState(), "parent-session", root)));

  assert.equal(readGateState(root, "parent-session")?.status, "awaiting_approval");
  assert.equal(readGateState(root, "child-session"), null);
});

test("A_CONFIG UI launcher is resolved from the extension package, not workspace .agents/pi", async () => {
  const src = await readFile(new URL("../../../extensions/qdm-harness/index.ts", import.meta.url), "utf8");
  assert.match(src, /htmlReportSkillScript\("open-metric-cli-ui\.mjs"\)/);
  assert.doesNotMatch(
    src,
    /projectRoot[\s\S]{0,80}"\.agents"[\s\S]{0,80}"open-metric-cli-ui\.mjs"/
  );
});

test("runtime contract fingerprints child guards and authoritative report scripts", () => {
  for (const suffix of [
    "report-researcher-guard/index.mjs",
    "report-researcher-guard/guard.mjs",
    "shared/subagent-structured-output-capture.mjs",
    "report-reviewer-guard/index.mjs",
    "report-reviewer-guard/guard.mjs",
    "report-designer-guard/index.mjs",
    "report-designer-guard/guard.mjs",
    "assemble-report.mjs",
    "export-main-html.mjs",
    "quality-scan.mjs",
    "researcher-return.mjs",
    "submit-research-findings.mjs",
    "submit-review-scorecard.mjs",
    "write-verdict.mjs",
    "render-report.mjs",
  ]) {
    assert.equal(
      HTML_REPORT_RUNTIME_SOURCE_FILES.some((path) => path.endsWith(suffix)),
      true,
      `${suffix} must invalidate an in-progress or resumed html-report Session when it changes`
    );
  }
});

test("runtime contract refuses to stamp an unreadable runtime source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-runtime-unreadable-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const snapshot = new Map(
    HTML_REPORT_RUNTIME_SOURCE_FILES.map((path) => [path, "a".repeat(64)])
  );
  const missing = HTML_REPORT_RUNTIME_SOURCE_FILES.find((path) =>
    path.endsWith("shared/subagent-structured-output-capture.mjs")
  );
  assert.ok(missing);
  snapshot.set(missing, "!ENOENT");
  assert.throws(
    () => writeHtmlReportRuntimeContract(root, "unreadable-runtime", snapshot),
    /运行时源码缺失或不可读/
  );
  await assert.rejects(
    readFile(join(root, ".harness", "state", "html-report", "unreadable-runtime", HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH)),
    (error) => error.code === "ENOENT"
  );
});

test("owned html-report Sessions with missing or corrupt Gate state fail closed without reconstruction", async (t) => {
  const handlers = registerHarnessExtension();
  const input = handlers.get("input")[0];
  const beforeAgentStart = handlers.get("before_agent_start")[0];
  const contextHandler = handlers.get("context")[0];
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];

  const variants = ["empty", "missing", "invalid-json", "wrong-contract"];
  for (const variant of variants) {
    const sid = `gate-integrity-${variant}-${process.pid}-${Date.now()}`;
    const session = htmlReportSessionDir(repoRoot, sid);
    const statePath = pipelineStatePath(session);
    const markerPath = join(session, HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH);
    const notices = [];
    const ctx = {
      sessionManager: { getSessionId: () => sid },
      ui: { notify: (...args) => notices.push(args) },
    };
    await mkdir(dirname(statePath), { recursive: true });
    t.after(async () => rm(session, { recursive: true, force: true }));

    if (variant !== "empty") {
      await writeFile(
        statePath,
        JSON.stringify(persistedGateState(runningGateState("B2_WRITER"), sid))
      );
      writeHtmlReportRuntimeContract(repoRoot, sid);
    }
    if (variant === "missing") await unlink(statePath);
    if (variant === "invalid-json") await writeFile(statePath, "{\n");
    if (variant === "wrong-contract") {
      const wrong = persistedGateState(runningGateState("B2_WRITER"), sid);
      wrong.producer = "forged-producer";
      wrong.sessionId = "another-session";
      await writeFile(statePath, JSON.stringify(wrong));
    }

    const stateBefore = await readFile(statePath, "utf8").catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error)
    );
    const markerBefore = await readFile(markerPath, "utf8").catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error)
    );
    assert.equal(inspectGateState(repoRoot, sid).kind, "invalid", variant);
    assert.deepEqual(await input({ text: "继续" }, ctx), { action: "handled" }, variant);

    const prompt = await beforeAgentStart({
      prompt: '<skill name="html-report"></skill>继续',
      systemPrompt: "base",
      messages: [],
    }, ctx);
    assert.match(prompt.systemPrompt, /Gate 状态缺失或损坏.*请创建全新的 Pi Session/s, variant);

    const originalMessages = [{ role: "user", content: [{ type: "text", text: "继续" }] }];
    assert.deepEqual(
      await contextHandler({ messages: originalMessages }, ctx),
      { messages: originalMessages },
      `${variant}: context must not recall or mutate a damaged report Session`
    );
    const blocked = await toolCall({ toolName: "read", input: { path: statePath } }, ctx);
    assert.equal(blocked.block, true, variant);
    assert.match(blocked.reason, /Gate 状态缺失或损坏/);
    const rejectedResult = await toolResult({
      toolName: "read",
      input: { path: statePath },
      isError: false,
      content: [{ type: "text", text: "forged success" }],
    }, ctx);
    assert.equal(rejectedResult.isError, true, variant);
    assert.equal(notices.filter(([, level]) => level === "error").length, 1, variant);

    const stateAfter = await readFile(statePath, "utf8").catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error)
    );
    const markerAfter = await readFile(markerPath, "utf8").catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error)
    );
    assert.equal(stateAfter, stateBefore, `${variant}: state bytes/existence must not change`);
    assert.equal(markerAfter, markerBefore, `${variant}: runtime marker must not change`);
  }
});

test("persisted runtime contract rejects legacy and cross-version html-report Sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-runtime-contract-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "wikis"), { recursive: true });
  for (const relativePath of HTML_REPORT_RUNTIME_SOURCE_FILES) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `runtime:${relativePath}\n`);
  }

  const register = () => {
    const handlers = new Map();
    qdmHarnessExtension({
      cwd: root,
      on(event, handler) {
        const list = handlers.get(event) || [];
        list.push(handler);
        handlers.set(event, list);
      },
    });
    return handlers;
  };
  const notifications = [];
  const context = (sid) => ({
    sessionManager: { getSessionId: () => sid },
    ui: { notify: (...args) => notifications.push([sid, ...args]) },
  });
  const writeWaitingGate = async (sid) => {
    const session = htmlReportSessionDir(root, sid);
    const statePath = pipelineStatePath(session);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(persistedGateState(waitingState(), sid, root)));
    return { session, statePath };
  };

  const handlers = register();
  const input = handlers.get("input")[0];
  const beforeAgentStart = handlers.get("before_agent_start")[0];
  const toolCall = handlers.get("tool_call")[0];

  const legacySid = "legacy-session-without-runtime-contract";
  const legacy = await writeWaitingGate(legacySid);
  const legacyState = await readFile(legacy.statePath, "utf8");
  assert.deepEqual(await input({ text: "继续" }, context(legacySid)), { action: "handled" });
  assert.equal(await readFile(legacy.statePath, "utf8"), legacyState, "legacy Gate must not advance");
  assert.equal(
    notifications.some(([sid, message, level]) =>
      sid === legacySid && level === "error" && /旧版或不完整运行时.*全新的 Pi Session/.test(message)
    ),
    true
  );
  const legacyPrompt = await beforeAgentStart(
    { prompt: "继续", systemPrompt: "base", messages: [] },
    context(legacySid)
  );
  assert.match(legacyPrompt.systemPrompt, /html-report 已阻止：请创建新 Session/);
  const legacyTool = await toolCall(
    { toolCallId: "legacy-read", toolName: "read", input: { path: legacy.statePath } },
    context(legacySid)
  );
  assert.equal(legacyTool.block, true);
  assert.match(legacyTool.reason, /不要恢复此 Session/);

  const compatibleSid = "matching-runtime-contract";
  const compatible = await writeWaitingGate(compatibleSid);
  const markerPath = writeHtmlReportRuntimeContract(root, compatibleSid);
  assert.equal(markerPath, join(compatible.session, HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH));
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.producer, "qdm-harness");
  assert.match(marker.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    await input({ text: "普通说明，不推进 Gate" }, context(compatibleSid)),
    { action: "continue" },
    "a matching persisted contract must remain usable"
  );
  assert.equal(
    await toolCall(
      { toolCallId: "compatible-read", toolName: "read", input: { path: compatible.statePath } },
      context(compatibleSid)
    ),
    undefined
  );
  const compatibleRestartHandlers = register();
  const compatibleRestartPrompt = await compatibleRestartHandlers.get("before_agent_start")[0](
    { prompt: "普通说明，不推进 Gate", systemPrompt: "base", messages: [] },
    context(compatibleSid)
  );
  assert.doesNotMatch(compatibleRestartPrompt?.systemPrompt || "", /html-report 已阻止/);
  assert.match(compatibleRestartPrompt?.systemPrompt || "", /B2_WRITER|html-report Gate/i);
  assert.deepEqual(
    await compatibleRestartHandlers.get("input")[0](
      { text: "普通说明，不推进 Gate" },
      context(compatibleSid)
    ),
    { action: "continue" },
    "a restarted Pi process must continue a Session stamped with the same runtime fingerprint"
  );

  const mismatchedSid = "cross-version-runtime-contract";
  await writeWaitingGate(mismatchedSid);
  writeHtmlReportRuntimeContract(root, mismatchedSid);
  const changedSource = HTML_REPORT_RUNTIME_SOURCE_FILES.find((path) => path.endsWith("reviewer-return.mjs"));
  assert.ok(changedSource);
  const changedSourcePath = join(repoRoot, changedSource);
  const originalSource = await readFile(changedSourcePath);
  t.after(async () => writeFile(changedSourcePath, originalSource));
  await writeFile(changedSourcePath, "new runtime after Session creation\n");

  const restartedHandlers = register();
  const restartedInput = restartedHandlers.get("input")[0];
  assert.deepEqual(
    await restartedInput({ text: "继续" }, context(mismatchedSid)),
    { action: "handled" },
    "a fresh Pi process must still reject artifacts created by a different runtime contract"
  );
  assert.equal(
    notifications.some(([sid, message, level]) =>
      sid === mismatchedSid && level === "error" && /运行时契约与当前 Pi 进程不一致/.test(message)
    ),
    true
  );
  assert.deepEqual(
    await restartedInput({ text: "普通非技能问题" }, context("ordinary-after-contract-change")),
    { action: "continue" },
    "persisted contract checks must not affect ordinary sessions without an html-report Gate"
  );
});

test("runtime source changes require a Pi restart only for html-report sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-runtime-freshness-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "wikis"), { recursive: true });
  for (const relativePath of HTML_REPORT_RUNTIME_SOURCE_FILES) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `loaded:${relativePath}\n`);
  }

  const handlers = new Map();
  qdmHarnessExtension({
    cwd: root,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const input = handlers.get("input")[0];
  const beforeAgentStart = handlers.get("before_agent_start")[0];
  const toolCall = handlers.get("tool_call")[0];
  const notifications = [];
  const context = (sid) => ({
    sessionManager: { getSessionId: () => sid },
    ui: { notify: (...args) => notifications.push([sid, ...args]) },
  });

  const changedSource = HTML_REPORT_RUNTIME_SOURCE_FILES.find((path) =>
    path.endsWith("researcher-return.mjs")
  );
  assert.ok(changedSource);
  const changedSourcePath = join(repoRoot, changedSource);
  const loadedSourceContent = await readFile(changedSourcePath);
  t.after(async () => writeFile(changedSourcePath, loadedSourceContent));
  await writeFile(changedSourcePath, loadedSourceContent);
  assert.deepEqual(
    await input({ text: "/skill: html-report 同内容重写" }, context("same-content-session")),
    { action: "continue" },
    "rewriting identical bytes must not create a false stale-runtime result"
  );
  await writeFile(changedSourcePath, "changed after Pi loaded\n");

  const ordinarySid = "ordinary-session";
  assert.deepEqual(
    await input({ text: "普通非技能问题" }, context(ordinarySid)),
    { action: "continue" },
    "an unrelated non-skill session must not be stopped by html-report freshness"
  );
  assert.equal(
    await toolCall({ toolCallId: "ordinary-read", toolName: "read", input: { path: "/tmp/x" } }, context(ordinarySid)),
    undefined,
    "ordinary non-skill tools must remain unaffected"
  );
  assert.equal(
    await beforeAgentStart({ prompt: "", systemPrompt: "base", messages: [] }, context(ordinarySid)),
    undefined,
    "ordinary before_agent_start must not receive the html-report restart banner"
  );

  const newHtmlSid = "new-html-report-session";
  assert.deepEqual(
    await input({ text: "/skill: html-report 生成报告" }, context(newHtmlSid)),
    { action: "handled" },
    "a stale runtime must consume a new html-report input before the agent starts"
  );
  assert.equal(readGateState(root, newHtmlSid), null, "a stale process must not initialize a new Gate");
  assert.equal(
    notifications.some(([sid, message, level]) =>
      sid === newHtmlSid && level === "error" && /重启 Pi/.test(message) && message.includes(changedSource)
    ),
    true
  );

  const stalePrompt = await beforeAgentStart(
    {
      prompt: '<skill name="html-report"></skill>生成报告',
      systemPrompt: "base",
      messages: [],
    },
    context(newHtmlSid)
  );
  assert.match(stalePrompt.systemPrompt, /html-report 已阻止：请重启 Pi/);
  const staleTool = await toolCall(
    { toolCallId: "stale-read", toolName: "read", input: { path: "/tmp/x" } },
    context(newHtmlSid)
  );
  assert.equal(staleTool.block, true);
  assert.match(staleTool.reason, /旧的 qdm-harness \/ contract 模块.*重启 Pi/);

  const unknownPrompt = await beforeAgentStart(
    {
      prompt: '<skill name="html-report"></skill>unknown session',
      systemPrompt: "base",
      messages: [],
    },
    context("unknown")
  );
  assert.match(unknownPrompt.systemPrompt, /html-report 已阻止：请重启 Pi/);
  const unknownTurnTool = await toolCall(
    { toolCallId: "unknown-stale-read", toolName: "read", input: { path: "/tmp/x" } },
    context("unknown")
  );
  assert.equal(unknownTurnTool.block, true, "an expanded stale skill turn must be protected without a session id");
  assert.deepEqual(
    await input({ text: "unknown session 的下一条普通问题" }, context("unknown")),
    { action: "continue" },
    "a new ordinary input must clear the turn-local unknown-session marker"
  );
  assert.equal(
    await toolCall(
      { toolCallId: "unknown-ordinary-read", toolName: "read", input: { path: "/tmp/x" } },
      context("unknown")
    ),
    undefined,
    "unknown session freshness state must not leak into a later ordinary turn"
  );

  const existingSid = "existing-html-report-session";
  const existingSession = htmlReportSessionDir(root, existingSid);
  const existingStatePath = pipelineStatePath(existingSession);
  await mkdir(dirname(existingStatePath), { recursive: true });
  await writeFile(existingStatePath, JSON.stringify(waitingState()));
  const beforeState = await readFile(existingStatePath, "utf8");
  assert.deepEqual(
    await input({ text: "继续" }, context(existingSid)),
    { action: "handled" },
    "an existing html-report Gate must not advance under stale runtime code"
  );
  assert.equal(await readFile(existingStatePath, "utf8"), beforeState);
  const existingTool = await toolCall(
    { toolCallId: "existing-write", toolName: "write", input: { path: "/tmp/x", content: "x" } },
    context(existingSid)
  );
  assert.equal(existingTool.block, true, "an in-progress stale Gate must block its very next tool call");
  assert.match(existingTool.reason, /重启 Pi/);

  assert.deepEqual(
    await input({ text: "另一个普通非技能问题" }, context(ordinarySid)),
    { action: "continue" },
    "even after staleness is latched, unrelated sessions must remain unaffected"
  );

  await writeFile(changedSourcePath, loadedSourceContent);
  const latchedTool = await toolCall(
    { toolCallId: "latched-read", toolName: "read", input: { path: "/tmp/x" } },
    context(newHtmlSid)
  );
  assert.equal(latchedTool.block, true, "restoring bytes must not silently unlock the already stale Pi process");

  const restartedHandlers = new Map();
  qdmHarnessExtension({
    cwd: root,
    on(event, handler) {
      const list = restartedHandlers.get(event) || [];
      list.push(handler);
      restartedHandlers.set(event, list);
    },
  });
  const restartedInput = restartedHandlers.get("input")[0];
  assert.deepEqual(
    await restartedInput({ text: "/skill: html-report 重启后的新会话" }, context("restarted-session")),
    { action: "continue" },
    "a newly registered extension instance must use current bytes as its fresh baseline"
  );
  await unlink(changedSourcePath);
  assert.deepEqual(
    await restartedInput({ text: "/skill: html-report 缺失契约文件" }, context("missing-source-session")),
    { action: "handled" },
    "deleting a critical runtime file after registration must also require restart"
  );
});

test("automatic A_CONFIG runtime list fails closed, persists one audit and never retries the attempt", async (t) => {
  const previousMode = process.env.HTML_REPORT_A_CONFIG_MODE;
  process.env.HTML_REPORT_A_CONFIG_MODE = "dynamic";
  const cases = [{
    label: "missing-agent",
    bridge: createRuntimeListEventBus({
      content: runtimeAgentListContent.replace(/^- report-designer.*\n?/m, ""),
    }),
    expected: /缺少 Agent：report-designer/,
  }, {
    label: "missing-bridge",
    bridge: null,
    expected: /slash event bridge is unavailable/,
  }];
  t.after(() => {
    if (previousMode === undefined) delete process.env.HTML_REPORT_A_CONFIG_MODE;
    else process.env.HTML_REPORT_A_CONFIG_MODE = previousMode;
  });

  for (const scenario of cases) {
    const sid = `automatic-runtime-fail-${scenario.label}-${process.pid}-${Date.now()}`;
    const session = htmlReportSessionDir(repoRoot, sid);
    t.after(() => rm(session, { recursive: true, force: true }));
    const handlers = new Map();
    const pi = {
      cwd: repoRoot,
      ...(scenario.bridge ? { events: scenario.bridge.events } : {}),
      on(event, handler) {
        const current = handlers.get(event) || [];
        current.push(handler);
        handlers.set(event, current);
      },
    };
    qdmHarnessExtension(pi);
    const ctx = { sessionManager: { getSessionId: () => sid }, ui: { notify: () => {} } };
    const before = handlers.get("before_agent_start")[0];
    await before({
      prompt: '<skill name="html-report"></skill>验证自动 runtime list',
      systemPrompt: "base",
      messages: [],
    }, ctx);
    let status = await pipelineStatus(session);
    assert.equal(status.state.currentStage, "A_CONFIG");
    assert.equal(status.state.status, "failed");
    assert.match(status.state.stages.A_CONFIG.failureReason, scenario.expected);

    const auditDir = join(session, "debug", "runtime-agent-list");
    const files = (await readdir(auditDir)).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    const audit = JSON.parse(await readFile(join(auditDir, files[0]), "utf8"));
    assert.equal(audit.status, "failed");
    assert.match(audit.error, scenario.expected);
    assert.match(audit.auditSha256, /^[a-f0-9]{64}$/);

    await before({ prompt: "重试前不得重复", systemPrompt: "base", messages: [] }, ctx);
    status = await pipelineStatus(session);
    assert.equal(status.state.status, "failed");
    assert.equal(scenario.bridge?.requests.length || 0, scenario.bridge ? 1 : 0);
    assert.equal((await readdir(auditDir)).filter((name) => name.endsWith(".json")).length, 1);
  }
});

test("qdm-harness extension initializes, injects, approves and hard-blocks the live parent gate", async (t) => {
  const sid = `extension-live-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const previousSessionId = process.env.PI_SESSION_ID;
  const previousAConfigMode = process.env.HTML_REPORT_A_CONFIG_MODE;
  process.env.HTML_REPORT_A_CONFIG_MODE = "dynamic";
  t.after(async () => {
    await rm(session, { recursive: true, force: true });
    if (previousSessionId === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = previousSessionId;
    if (previousAConfigMode === undefined) delete process.env.HTML_REPORT_A_CONFIG_MODE;
    else process.env.HTML_REPORT_A_CONFIG_MODE = previousAConfigMode;
  });

  const handlers = new Map();
  const runtimeBridge = createRuntimeListEventBus();
  const pi = {
    cwd: repoRoot,
    events: runtimeBridge.events,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  qdmHarnessExtension(pi);
  const notifications = [];
  const parentCtx = {
    sessionManager: { getSessionId: () => sid },
    ui: { notify: (...args) => notifications.push(args) },
  };
  const before = handlers.get("before_agent_start")[0];
  const injected = await before(
    {
      prompt: '<skill name="html-report"></skill>分析销售额',
      systemPrompt: "base",
      messages: [],
    },
    parentCtx
  );
  let status = await pipelineStatus(session);
  assert.equal(status.state.mode, "step");
  assert.equal(status.state.currentStage, "A_CONFIG");
  assert.equal(status.state.status, "running");
  assert.match(injected.systemPrompt, /html-report 单步调试 Gate/);
  const runtimeContract = JSON.parse(
    await readFile(join(session, HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH), "utf8")
  );
  assert.equal(runtimeContract.producer, "qdm-harness");
  assert.equal(runtimeContract.sessionId, sid);
  assert.match(runtimeContract.fingerprint, /^[a-f0-9]{64}$/);

  await finishPipelineStage(session, "A_CONFIG");
  const toolCall = handlers.get("tool_call")[0];
  const blocked = await toolCall(
    { toolCallId: "write-1", toolName: "write", input: { path: "/tmp/x", content: "x" } },
    parentCtx
  );
  assert.equal(blocked.block, true);

  const input = handlers.get("input")[0];
  await input({ text: "请继续分析" }, parentCtx);
  status = await pipelineStatus(session);
  assert.equal(status.state.status, "awaiting_approval", "non-control input must not approve");

  await input({ text: "继续" }, parentCtx);
  status = await pipelineStatus(session);
  assert.equal(status.state.status, "awaiting_approval", "result.json prerequisite must hold");

  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  await input({ text: "继续" }, parentCtx);
  status = await pipelineStatus(session);
  assert.equal(status.state.currentStage, "B2_WRITER");
  assert.equal(status.state.status, "running");
  assert.equal(status.state.stages.B0_PREFLIGHT.status, "completed");

  await input({ text: "关闭单步调试并继续" }, parentCtx);
  status = await pipelineStatus(session);
  assert.equal(status.state.mode, "auto");
  await before({ prompt: "关闭单步调试并继续", systemPrompt: "base", messages: [] }, parentCtx);
  status = await pipelineStatus(session);
  assert.equal(status.state.currentStage, "B2_WRITER");
  assert.equal(status.state.status, "running");
  assert.equal(runtimeBridge.requests.length, 2, "A_CONFIG and B0 must each use one automatic runtime list");
  for (const request of runtimeBridge.requests) {
    assert.deepEqual(request.params, { action: "list" });
    assert.equal(request.ctx.cwd, repoRoot);
  }

  assert.equal(
    handlers.has("agent_end"),
    false,
    "the extension must not inject a durable custom message that can trigger a ghost model turn"
  );

  const childCtx = { sessionManager: { getSessionId: () => `${sid}-child` }, ui: parentCtx.ui };
  const childDecision = await toolCall(
    { toolCallId: "write-child", toolName: "write", input: { path: "/tmp/y", content: "y" } },
    childCtx
  );
  assert.equal(childDecision, undefined);
});

test("default A_CONFIG opens qdm-metric-cli ui and does not write recommendations.json", async (t) => {
  const sid = `extension-fixed-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const previousMode = process.env.HTML_REPORT_A_CONFIG_MODE;
  const previousOpen = process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN;
  delete process.env.HTML_REPORT_A_CONFIG_MODE;
  process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN = "0";
  t.after(async () => {
    await rm(session, { recursive: true, force: true });
    if (previousMode === undefined) delete process.env.HTML_REPORT_A_CONFIG_MODE;
    else process.env.HTML_REPORT_A_CONFIG_MODE = previousMode;
    if (previousOpen === undefined) delete process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN;
    else process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN = previousOpen;
  });

  const handlers = new Map();
  const runtimeBridge = createRuntimeListEventBus();
  const sentMessages = [];
  const pi = {
    cwd: repoRoot,
    events: runtimeBridge.events,
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  qdmHarnessExtension(pi);
  const parentCtx = {
    sessionManager: { getSessionId: () => sid },
    ui: { notify: () => {} },
  };
  const before = handlers.get("before_agent_start")[0];
  const injected = await before(
    {
      prompt: '<skill name="html-report"></skill>分析任意指标',
      systemPrompt: "base",
      messages: [],
    },
    parentCtx
  );
  const status = await pipelineStatus(session);
  assert.equal(status.state.currentStage, "A_CONFIG");
  assert.equal(status.state.status, "awaiting_approval");
  assert.match(injected.systemPrompt, /qdm-metric-cli ui/);
  assert.match(injected.systemPrompt, /保存/);
  assert.match(injected.systemPrompt, /继续/);
  assert.match(injected.systemPrompt, /runtime agent list 已由扩展/);
  assert.match(injected.systemPrompt, /不要写 recommendations\.json，不要启动 server\.mjs/);
  assert.doesNotMatch(injected.systemPrompt, /下一条 assistant action.*subagent/);
  assert.equal(
    await readFile(join(session, "recommendations.json"), "utf8").then(() => "exists").catch(() => "missing"),
    "missing"
  );
  const question = JSON.parse(await readFile(join(session, "debug", "a-config-question.json"), "utf8"));
  assert.equal(question.userQuestion, "分析任意指标");
  const marker = JSON.parse(await readFile(join(session, "debug", "metric-cli-ui.json"), "utf8"));
  assert.equal(marker.producer, "open-metric-cli-ui.mjs");
  assert.equal(sentMessages.length, 0, "UI message must not be inserted ahead of the skill message");
  assert.equal(injected.message.customType, HTML_REPORT_UI_CUSTOM_TYPE);
  assert.equal(injected.message.display, true);
  assert.match(injected.message.content, /本地编辑器已按当前设置启动/);
  assert.match(injected.message.content, /保存后回到 Pi 回复一次「继续」/);
  assert.doesNotMatch(
    injected.message.content,
    /local-report-builder|B0|runtime agent list|recommendations\.json|server\.mjs/
  );
  assert.deepEqual(injected.message.details, {
    version: 1,
    producer: "qdm-harness",
    sessionId: sid,
    serverUrl: null,
  });

  // Pi's context hook may only see the normalized question (without the
  // skill wrapper), so ensure the fixed skill marker still blocks recall.
  const context = handlers.get("context")[0];
  const skillMessages = [{ role: "user", content: [{ type: "text", text: "分析任意指标" }] }];
  const noRecall = await context({ messages: skillMessages }, parentCtx);
  assert.equal(noRecall.messages.length, 1, "fixed html-report skill must not inject recall in context hook");

  // The suppression is strictly per skill turn. A normal prompt in the same
  // debug-enabled process continues to use the normal Harness recall flow.
  const input = handlers.get("input")[0];
  assert.deepEqual(await input({ text: "分析销售额" }, parentCtx), { action: "continue" });
  const normalMessages = [{ role: "user", content: [{ type: "text", text: "分析销售额" }] }];
  const withRecall = await context({ messages: normalMessages }, parentCtx);
  assert.ok(withRecall.messages.length >= 1, "non-skill prompt must not be dropped");

  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  assert.deepEqual(await input({ text: "继续" }, parentCtx), { action: "continue" });
  const gated = await pipelineStatus(session);
  assert.equal(gated.state.currentStage, "B2_WRITER");
  assert.equal(gated.state.status, "running");
  assert.equal(gated.state.stages.B0_PREFLIGHT.status, "completed");
  assert.equal(gated.state.approvals.length, 1, "only A_CONFIG requires user approval");
  assert.equal(runtimeBridge.requests.length, 2, "fixed A_CONFIG and B0 each run one automatic list");
  assert.equal(sentMessages.length, 0, "successful B0 must not emit a stopping html-report-gate message");

  const shutdown = handlers.get("session_shutdown")?.[0];
  assert.equal(typeof shutdown, "function");
  await shutdown({}, parentCtx);
  await assert.rejects(
    readFile(join(session, "debug", "metric-cli-ui.json")),
    "session_shutdown must stop the metric-cli ui marker for this session"
  );
});

test("fixed debug mode automatically completes B5 without dispatching Report Designer", async (t) => {
  const sid = `extension-fixed-b5-skip-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const previousMode = process.env.HTML_REPORT_A_CONFIG_MODE;
  const previousOpen = process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN;
  delete process.env.HTML_REPORT_A_CONFIG_MODE;
  process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN = "0";
  t.after(async () => {
    await rm(session, { recursive: true, force: true });
    if (previousMode === undefined) delete process.env.HTML_REPORT_A_CONFIG_MODE;
    else process.env.HTML_REPORT_A_CONFIG_MODE = previousMode;
    if (previousOpen === undefined) delete process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN;
    else process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN = previousOpen;
  });

  const handlers = new Map();
  const runtimeBridge = createRuntimeListEventBus();
  qdmHarnessExtension({
    cwd: repoRoot,
    events: runtimeBridge.events,
    on(event, handler) {
      const current = handlers.get(event) || [];
      current.push(handler);
      handlers.set(event, current);
    },
  });
  const ctx = {
    sessionManager: { getSessionId: () => sid },
    ui: { notify: () => {} },
  };
  await handlers.get("before_agent_start")[0]({
    prompt: '<skill name="html-report"></skill>验证 B5 调试跳过',
    systemPrompt: "base",
    messages: [],
  }, ctx);

  // Drive only the persistent Gate to B4. The fixed-A_CONFIG hook above is
  // what marks this live Session as Debug; no Designer task is fabricated.
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  await applyPipelinePolicy(session, LEGACY_STAGE_POLICY);
  await approvePipelineStage(session, { phrase: "继续" });
  await finishPipelineStage(session, "B0_PREFLIGHT");
  await approvePipelineStage(session, { phrase: "继续" });
  await finishPipelineStage(session, "B2_WRITER");
  await approvePipelineStage(session, { phrase: "继续" });
  await finishPipelineStage(session, "B25_EDITOR");
  await finishPipelineStage(session, "B3_RESEARCH");
  await approvePipelineStage(session, { phrase: "继续" });
  await finishPipelineStage(session, "B4_REVIEW");

  let status = await pipelineStatus(session);
  assert.equal(status.state.currentStage, "B4_REVIEW");
  assert.equal(status.state.status, "awaiting_approval");

  // Recreate the extension before the B4 approval. This proves the durable
  // fixed-preset marker, rather than only in-memory A_CONFIG state, owns the
  // Debug B5 skip after a same-version Pi restart.
  const restartedHandlers = new Map();
  const restartedMessages = [];
  qdmHarnessExtension({
    cwd: repoRoot,
    sendMessage(message, options) {
      restartedMessages.push({ message, options });
    },
    on(event, handler) {
      const current = restartedHandlers.get(event) || [];
      current.push(handler);
      restartedHandlers.set(event, current);
    },
  });
  const input = restartedHandlers.get("input")[0];
  assert.deepEqual(await input({ text: "继续" }, ctx), { action: "handled" });
  status = await pipelineStatus(session);
  assert.equal(status.state.currentStage, "B5_DESIGN");
  assert.equal(status.state.status, "completed");
  assert.equal(status.state.stages.B5_DESIGN.status, "completed");
  assert.equal(status.state.stages.B5_DESIGN.attempts.length, 1);
  assert.match(restartedMessages.at(-1).message.content, /自动跳过 B5 Report Designer/);
  assert.match(restartedMessages.at(-1).message.content, /未生成 report\.html、截图或 phase=html/);
  assert.equal(restartedMessages.at(-1).message.details.debugB5Skipped, true);
  assert.deepEqual(restartedMessages.at(-1).options, { triggerTurn: false });
});

test("deterministic B0 input path emits a failed Gate and never starts B2", async (t) => {
  const sid = `extension-b0-handled-failure-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const previousMode = process.env.HTML_REPORT_A_CONFIG_MODE;
  const previousOpen = process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN;
  delete process.env.HTML_REPORT_A_CONFIG_MODE;
  process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN = "0";
  t.after(async () => {
    await rm(session, { recursive: true, force: true });
    if (previousMode === undefined) delete process.env.HTML_REPORT_A_CONFIG_MODE;
    else process.env.HTML_REPORT_A_CONFIG_MODE = previousMode;
    if (previousOpen === undefined) delete process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN;
    else process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN = previousOpen;
  });

  const handlers = new Map();
  const runtimeBridge = createRuntimeListEventBus({
    content: (_request, requestNumber) => requestNumber === 1
      ? runtimeAgentListContent
      : runtimeAgentListContent.replace(/^- report-designer.*\n?/m, ""),
  });
  const sentMessages = [];
  qdmHarnessExtension({
    cwd: repoRoot,
    events: runtimeBridge.events,
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const ctx = {
    sessionManager: { getSessionId: () => sid },
    ui: { notify: () => {} },
  };
  const injected = await handlers.get("before_agent_start")[0]({
    prompt: '<skill name="html-report"></skill>验证 B0 失败回显',
    systemPrompt: "base",
    messages: [],
  }, ctx);
  assert.equal(injected.message.customType, HTML_REPORT_UI_CUSTOM_TYPE);
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));

  assert.deepEqual(await handlers.get("input")[0]({ text: "继续" }, ctx), { action: "handled" });
  const status = await pipelineStatus(session);
  assert.equal(status.state.currentStage, "B0_PREFLIGHT");
  assert.equal(status.state.status, "failed");
  assert.equal(status.state.stages.B0_PREFLIGHT.status, "failed");
  assert.equal(status.state.stages.B2_WRITER, undefined);
  assert.match(status.state.stages.B0_PREFLIGHT.failureReason, /report-designer/);
  assert.equal(runtimeBridge.requests.length, 2);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].message.customType, HTML_REPORT_GATE_CUSTOM_TYPE);
  assert.equal(sentMessages[0].message.content, formatGateMessage(status.state, { stageId: "B0_PREFLIGHT" }));
  assert.equal(sentMessages[0].message.details.pipelineStatus, "failed");
  assert.equal(sentMessages[0].message.details.stageStatus, "failed");
  assert.deepEqual(sentMessages[0].options, { triggerTurn: false });
});

test("auto mode runs fixed A_CONFIG and B0 runtime lists in the same model-start hook", async (t) => {
  const sid = `extension-auto-runtime-lists-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const previousGateMode = process.env.HTML_REPORT_GATE_MODE;
  const previousAConfigMode = process.env.HTML_REPORT_A_CONFIG_MODE;
  const previousOpen = process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN;
  process.env.HTML_REPORT_GATE_MODE = "auto";
  delete process.env.HTML_REPORT_A_CONFIG_MODE;
  process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN = "0";
  t.after(async () => {
    await rm(session, { recursive: true, force: true });
    if (previousGateMode === undefined) delete process.env.HTML_REPORT_GATE_MODE;
    else process.env.HTML_REPORT_GATE_MODE = previousGateMode;
    if (previousAConfigMode === undefined) delete process.env.HTML_REPORT_A_CONFIG_MODE;
    else process.env.HTML_REPORT_A_CONFIG_MODE = previousAConfigMode;
    if (previousOpen === undefined) delete process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN;
    else process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN = previousOpen;
  });

  const handlers = new Map();
  const runtimeBridge = createRuntimeListEventBus();
  runtimeBridge.events.on("subagent:slash:request", () => {
    if (runtimeBridge.requests.length === 1) {
      writeFileSync(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
    }
  });
  qdmHarnessExtension({
    cwd: repoRoot,
    events: runtimeBridge.events,
    on(event, handler) {
      const current = handlers.get(event) || [];
      current.push(handler);
      handlers.set(event, current);
    },
  });
  const ctx = { sessionManager: { getSessionId: () => sid }, ui: { notify: () => {} } };
  await handlers.get("before_agent_start")[0]({
    prompt: '<skill name="html-report"></skill>自动模式验收',
    systemPrompt: "base",
    messages: [],
  }, ctx);

  const status = await pipelineStatus(session);
  assert.equal(status.state.mode, "auto");
  assert.equal(status.state.currentStage, "B2_WRITER");
  assert.equal(status.state.status, "running");
  assert.equal(runtimeBridge.requests.length, 2);
  const auditFiles = await readdir(join(session, "debug", "runtime-agent-list"));
  assert.equal(auditFiles.filter((name) => name.startsWith("A_CONFIG-")).length, 1);
  assert.equal(auditFiles.filter((name) => name.startsWith("B0_PREFLIGHT-")).length, 1);
});

function writerCard(id, title) {
  return { id, title };
}

async function writeConfirmedResult(session, cards) {
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    userQuestion: "进度展示",
    cards,
  }));
}

function persistSuccessfulWriterCard(session, cardId, rows = [{ value: 1 }]) {
  const paths = writerReturnPaths({ sessionDir: session, cardId });
  mkdirSync(dirname(paths.dataPath), { recursive: true });
  const hash = rowsSha256(rows);
  writeFileSync(paths.dataPath, `${JSON.stringify(rows)}\n`);
  writeFileSync(paths.metaPath, `${JSON.stringify({ rowCount: rows.length, rowsSha256: hash })}\n`);
  writeFileSync(paths.captionPath, "本卡最高为 100。\n");
  writeFileSync(join(dirname(paths.dataPath), "caption-evidence.json"), JSON.stringify({
    producer: "prepare-card-caption-evidence.mjs",
    cardId,
    rowCount: 1,
    query: { metrics: [], statisticPolicy: "SUMMARY", dimensions: [], time: null, comparisons: [] },
    axis: [],
    groups: [],
    droppedDimensions: [],
    views: {},
  }));
  return {
    cardId,
    fetchStatus: "success",
    dataPath: paths.dataPath,
    metaPath: paths.metaPath,
    rowCount: rows.length,
    rowsSha256: hash,
  };
}

function failedWriterReturn(cardId, error = "metric cli failed") {
  return {
    cardId,
    fetchStatus: "failed",
    dataPath: null,
    metaPath: null,
    error,
  };
}

function createStageProgressBus(resultFactory) {
  const bus = createCanonicalDelegationBus((request) => resultFactory(request));
  const originalEmit = bus.emit.bind(bus);
  bus.emit = (event, data) => {
    if (event === "prompt-template:subagent:request" && data.agent && data.task && data.result) {
      originalEmit(event, data);
      return;
    }
    originalEmit(event, data);
  };
  return bus;
}

function progressSnapshots(updates) {
  return updates.map((update) => extractStageProgress(update.details)).filter(Boolean);
}

function progressCtx(seeded) {
  const widgets = [];
  const statuses = [];
  return {
    ctx: {
      ...seeded.ctx,
      ui: {
        notify() {},
        setWidget(key, value) { widgets.push([key, value]); },
        setStatus(key, value) { statuses.push([key, value]); },
      },
    },
    widgets,
    statuses,
  };
}

test("B2 stage progress publishes total, current card and monotonic completed", async (t) => {
  const seeded = await seedStageRunnerGate(t, "B2_WRITER", "b2-progress-total");
  const cards = [
    writerCard("card-01", "销售额"),
    writerCard("card-02", "毛利额"),
    writerCard("card-03", "客流量"),
  ];
  await writeConfirmedResult(seeded.session, cards);
  const events = createStageProgressBus((request) => {
    const match = String(request.task || "").match(/cardId=([^\s]+)/);
    const cardId = match?.[1];
    if (cardId === "card-01") return persistSuccessfulWriterCard(seeded.session, cardId);
    return failedWriterReturn(cardId, "second card failed");
  });
  const handlers = registerHarnessExtension({ events });
  const stageTool = handlers.tools.get(HTML_REPORT_STAGE_TOOL);
  const updates = [];
  const { ctx, widgets, statuses } = progressCtx(seeded);
  const result = await stageTool.execute("b2-progress-call", {}, undefined, (update) => updates.push(update), ctx);
  const snapshots = progressSnapshots(updates);

  assert.ok(snapshots.length);
  assert.equal(snapshots[0].total, 3);
  assert.equal(snapshots[0].completed, 0);
  assert.ok(snapshots.some((snapshot) => snapshot.currentItemId === "card-01"));
  const completedCounts = snapshots.map((snapshot) => snapshot.completed);
  for (let index = 1; index < completedCounts.length; index += 1) {
    assert.ok(completedCounts[index] >= completedCounts[index - 1], "completed must be monotonic");
  }
  assert.ok(completedCounts.some((count) => count >= 1));
  const last = extractStageProgress(result.details);
  assert.equal(last.total, 3);
  assert.equal(last.completed, 1);
  assert.equal(last.failed, 1);
  assert.equal(last.items.find((item) => item.id === "card-02").status, "failed");
  assert.equal(result.isError, true);
  assert.equal(readGateState(repoRoot, seeded.sid).status, "failed");
  assert.equal(widgets.length, 0);
  assert.equal(statuses.length, 0);
  const defaultView = stageTool.renderResult(result, { expanded: false }, {
    fg: (_token, text) => text,
    bold: (text) => text,
    dim: (text) => text,
  }).render(120).join("\n");
  assert.match(defaultView, /3/);
  assert.match(defaultView, /card-02/);
  const rendered = stageTool.renderResult(result, { expanded: true }, {
    fg: (_token, text) => text,
    bold: (text) => text,
    dim: (text) => text,
  }).render(120).join("\n");
  assert.match(rendered, /card-01/);
  assert.match(rendered, /\[!].*card-02|card-02/);
});

test("awaiting_approval progress snapshot renders as completed", () => {
  const progress = {
    kind: "html-report-stage-progress",
    version: 1,
    producer: "qdm-harness",
    sessionId: "s",
    attempt: "B2_WRITER:1:2026-08-18T00:00:00.000Z",
    entryStage: "B2_WRITER",
    currentStage: "B2_WRITER",
    status: "completed",
    phase: "awaiting-approval",
    total: 14,
    completed: 14,
    failed: 0,
    pending: 0,
    items: [],
    startedAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
  const rendered = renderStageProgressResult(
    { details: { status: "completed", progress }, isError: false },
    { expanded: false },
  ).render(80).join("\n");
  assert.match(rendered, /14\/14/);
  assert.match(rendered, /B2 Writer/);
});

test("B25 stage progress starts on B25 and B3 progress uses currentStage B3_RESEARCH", async (t) => {
  const editor = await seedStageRunnerGate(t, "B25_EDITOR", "b25-progress-stage");
  const editorEvents = createCanonicalDelegationBus(() => ({ ok: false }));
  const editorHandlers = registerHarnessExtension({ events: editorEvents });
  const editorUpdates = [];
  const editorResult = await editorHandlers.tools.get(HTML_REPORT_STAGE_TOOL).execute(
    "b25-progress-call",
    {},
    undefined,
    (update) => editorUpdates.push(update),
    editor.ctx,
  );
  const editorProgress = extractStageProgress(editorResult.details) || progressSnapshots(editorUpdates).at(-1);
  assert.equal(editorProgress.entryStage, "B25_EDITOR");
  assert.equal(editorProgress.currentStage, "B25_EDITOR");

  const research = await seedStageRunnerGate(t, "B3_RESEARCH", "b3-progress-stage");
  await mkdir(join(research.session, "analysis"), { recursive: true });
  await writeFile(join(research.session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    editorial: { userQuestion: "为什么库存上升" },
    tasks: [
      { id: "drill-001", goal: "库存原因", status: "pending" },
      { id: "drill-002", goal: "客流下降", status: "pending" },
    ],
  }));
  const researchEvents = createCanonicalDelegationBus(() => ({ status: "failed", error: "no evidence" }));
  const researchHandlers = registerHarnessExtension({ events: researchEvents });
  const researchResult = await researchHandlers.tools.get(HTML_REPORT_STAGE_TOOL).execute(
    "b3-progress-call",
    {},
    undefined,
    undefined,
    research.ctx,
  );
  const researchProgress = extractStageProgress(researchResult.details);
  assert.equal(researchProgress.currentStage, "B3_RESEARCH");
  assert.equal(researchProgress.total, 2);
  assert.equal(researchProgress.items[0].id, "drill-001");
});

test("B5 fixed skip marks the designer item skipped and renderer restores final details", async (t) => {
  const seeded = await seedStageRunnerGate(t, "B5_DESIGN", "b5-progress-skip");
  await mkdir(join(seeded.session, "debug"), { recursive: true });
  await writeFile(join(seeded.session, "debug", "fixed-recommendation.json"), JSON.stringify({
    version: 1,
    producer: "seed-debug-recommendations.mjs",
    sessionId: seeded.sid,
    b5Design: "skip",
  }));
  const handlers = registerHarnessExtension();
  const stageTool = handlers.tools.get(HTML_REPORT_STAGE_TOOL);
  const { ctx } = progressCtx(seeded);
  const result = await stageTool.execute("b5-skip-progress", {}, undefined, undefined, ctx);
  assert.equal(result.isError, false);
  const progress = extractStageProgress(result.details);
  assert.equal(progress.currentStage, "B5_DESIGN");
  assert.equal(progress.status, "completed");
  assert.equal(progress.items[0].status, "skipped");
  assert.equal(progress.completed, 1);
  const rendered = stageTool.renderResult(result, { expanded: true }, {
    fg: (_token, text) => text,
    bold: (text) => text,
    dim: (text) => text,
  }).render(80).join("\n");
  assert.match(rendered, /skipped|designer/i);
});
