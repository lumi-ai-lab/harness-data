import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolve } from "node:path";
import {
  b25EditorBootstrapContract,
  b25EditorToolDecision,
  classifyGateInput,
  gateContextBanner,
  gateToolDecision,
  htmlReportSessionDir,
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
  pipelineStatePath,
  pipelineStatus,
  LEGACY_STAGE_POLICY,
} from "../scripts/stage-gate.mjs";
import { researcherReturnPaths } from "../scripts/researcher-return.mjs";
import { reviewerReturnPaths } from "../scripts/reviewer-return.mjs";
import { designerReturnPaths } from "../scripts/designer-return.mjs";
import { assembleReport } from "../scripts/assemble-report.mjs";
import { writeVerdict } from "../scripts/write-verdict.mjs";
import { runQualityScan } from "../scripts/quality-scan.mjs";
import { rowsSha256 } from "../scripts/fetch-entry.mjs";
import {
  persistEditorSourceInventory,
  persistEditorWriterReturn,
} from "../scripts/editor-plan-contract.mjs";
import { parseResearcherAssignment } from "../../../extensions/report-researcher-guard/guard.mjs";
import qdmHarnessExtension, {
  HTML_REPORT_GATE_CUSTOM_TYPE,
  HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH,
  HTML_REPORT_RUNTIME_SOURCE_FILES,
  compactHtmlReportGateHistory,
  compactHtmlReportSkillHistory,
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
  let activeTools = [...(initialTools || ["read", "bash", "subagent", "write"])];
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
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  handlers.activeTools = () => [...activeTools];
  handlers.toolHistory = toolHistory;
  return handlers;
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

test("only explicit gate phrases are classified", () => {
  assert.equal(classifyGateInput("继续"), "continue");
  assert.equal(classifyGateInput("继续。"), "continue");
  assert.equal(classifyGateInput("确认生成报告"), "confirm");
  assert.equal(classifyGateInput("重试当前阶段"), "retry");
  assert.equal(classifyGateInput("关闭单步调试并继续"), "disable_step");
  assert.equal(classifyGateInput("请继续分析"), null);
  assert.equal(classifyGateInput("可以了"), null);
});

test("running B2 Gate banner reveals only status before its result", () => {
  const state = runningGateState("B2_WRITER");
  state.mode = "step";
  const banner = gateContextBanner(repoRoot, "shape-banner", state, {
    writerCardIds: ["card-1", "card-2"],
  });
  assert.match(banner, /^NEXT_TOOL_ONLY：bash\(\{"command":"node .*stage-gate\.mjs.*status/);
  assert.doesNotMatch(banner, /card-1|card-2|report-writer|subagent\(\{/);
  assert.doesNotMatch(banner, /两个 sibling|不要求等待前一个结果/);
  assert.doesNotMatch(banner, /contract 子代理必须复制此参数外形|context.*顶层.*chain|Schema-critical/);
  assert.doesNotMatch(banner, /SESSION:|当前状态|状态查询/);
  assert.doesNotMatch(banner, /成功时最后一个且独立的工具调用必须是/);

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
  assert.match(b0WaitingBanner, /CURRENT INPUT IS CONSUMED/);
  assert.match(b0WaitingBanner, /当前用户的“继续”只用于进入并完成 B0/);
  assert.match(b0WaitingBanner, /同一输入不能再次批准 B0，也不能启动 B2/);
  assert.match(b0WaitingBanner, /下一条 assistant 响应必须只原样返回.*B0 Gate 文本/);
  assert.match(b0WaitingBanner, /用户随后新发的一条“继续”才会.*启动 B2 Writer/);

  const researcherState = runningGateState("B3_RESEARCH");
  researcherState.mode = "step";
  const researcherBanner = gateContextBanner(
    repoRoot,
    "researcher-shape-banner",
    researcherState
  );
  assert.match(researcherBanner, /逐字包含 `evidencePath=<ABS>`/);
  assert.match(researcherBanner, /不得翻译成“证据路径”/);
  assert.match(researcherBanner, /qdm-harness 自动 finish B3_RESEARCH/);
  assert.match(researcherBanner, /不要.*手工调用 stage-gate finish/);
  assert.doesNotMatch(researcherBanner, /成功时最后一个且独立的工具调用必须是.*stage-gate/);

  const editorState = runningGateState("B25_EDITOR");
  editorState.mode = "step";
  const editorBanner = gateContextBanner(repoRoot, "editor-next-tool-banner", editorState);
  assert.match(editorBanner, /IMMEDIATE B25 TOOL MESSAGE/);
  assert.match(editorBanner, /只包含两个 sibling Bash/);
  assert.match(editorBanner, /列表顺序只确定消息形状，不要求等待前一个结果/);
  assert.match(editorBanner, /不要再判断“顺序还是并行”/);
  assert.match(editorBanner, /自动接棒契约/);
  assert.match(editorBanner, /HTML_REPORT_EDITOR_PLAN_V1/);
  assert.match(editorBanner, /subagent\(\{"context":"fresh","chain":\[\{"agent":"report-researcher"/);
  assert.match(editorBanner, /父模型不得再生成或重复调用 Planner/);
  assert.match(editorBanner, /强制短系统提示词和 typed outputSchema/);
  assert.match(editorBanner, /自动校验、生成 tasks\.json\/main\.md/);
  assert.doesNotMatch(editorBanner, /OPERATION KEY CONTRACT|compareTopN|quantileBins|correlation/);
  assert.match(editorBanner, /不要手工调用 B25 finalizer 或 stage-gate finish/);
  assert.doesNotMatch(editorBanner, /两个 sibling `write`|Pi `write` 不需要 mkdir/);
});

test("B2 runtime requires successful status, blocks concurrent siblings, and rejects fused arguments", async (t) => {
  const initialTools = ["read", "bash", "subagent", "write"];
  const handlers = registerHarnessExtension({ initialTools });
  const beforeAgentStart = handlers.get("before_agent_start")[0];
  const input = handlers.get("input")[0];
  const agentSettled = handlers.get("agent_settled")[0];
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];

  async function seed(label) {
    const sid = `b2-startup-${label}-${process.pid}-${Date.now()}`;
    const session = htmlReportSessionDir(repoRoot, sid);
    const state = runningGateState("B2_WRITER", `2026-07-31T00:00:0${label.length}.000Z`);
    state.mode = "step";
    state.stages.B2_WRITER.id = "B2_WRITER";
    state.stages.B2_WRITER.attempts[0].startupStatusRequired = true;
    await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
    await writeFile(pipelineStatePath(session), JSON.stringify(persistedGateState(state, sid)));
    await writeFile(join(session, "result.json"), JSON.stringify({
      status: "confirmed",
      cards: [{ id: "card-1" }],
    }));
    writeHtmlReportRuntimeContract(repoRoot, sid);
    t.after(async () => rm(session, { recursive: true, force: true }));
    return { sid, session, ctx: { sessionManager: { getSessionId: () => sid } } };
  }

  const fused = await seed("fused");
  const fusedStatus = {
    toolCallId: "b2-fused-status",
    toolName: "bash",
    input: {
      command: `node '${stageGateScriptPath(repoRoot)}' status --session-dir '${fused.session}' --format text`,
      "subagent<arg_key>context": "fresh",
      chain: "[{\"agent\":\"report-writer\"}]",
    },
  };
  const fusedDecision = await toolCall(fusedStatus, fused.ctx);
  assert.equal(fusedDecision.block, true);
  assert.match(fusedDecision.reason, /非法融合键|非 subagent 工具/);
  assert.equal(readGateState(repoRoot, fused.sid).status, "failed");
  const correctedSameAttempt = await toolCall({
    ...fusedStatus,
    toolCallId: "b2-fused-corrected",
    input: { command: fusedStatus.input.command },
  }, fused.ctx);
  assert.equal(correctedSameAttempt, undefined, "failed Gate still permits its read-only status command");
  assert.equal(readGateState(repoRoot, fused.sid).status, "failed");
  const writerAfterFailure = await toolCall(contractCall({
    chain: [{ agent: "report-writer", task: "must remain blocked" }],
  }, "b2-fused-writer-after-failure"), fused.ctx);
  assert.equal(writerAfterFailure.block, true);
  assert.match(writerAfterFailure.reason, /重试当前阶段|失败/);

  const sibling = await seed("sibling");
  await input({ text: "继续" }, sibling.ctx);
  await beforeAgentStart({ prompt: "继续", systemPrompt: "base" }, sibling.ctx);
  const siblingStatusCall = {
    toolCallId: "b2-sibling-status",
    toolName: "bash",
    input: {
      command: `node '${stageGateScriptPath(repoRoot)}' status --session-dir '${sibling.session}' --format text`,
    },
  };
  assert.equal(await toolCall(siblingStatusCall, sibling.ctx), undefined);
  const blockedSibling = await toolCall({
    toolCallId: "b2-sibling-ls",
    toolName: "bash",
    input: { command: `ls -la '${repoRoot}'` },
  }, sibling.ctx);
  assert.equal(blockedSibling.block, true);
  assert.match(blockedSibling.reason, /sibling 工具已阻止.*Gate attempt 保持有效/);
  assert.equal(readGateState(repoRoot, sibling.sid).status, "running");
  assert.deepEqual(handlers.activeTools(), ["bash"]);
  const siblingStatusResult = await toolResult({
    ...siblingStatusCall,
    isError: false,
    content: [{ type: "text", text: "阶段：B2 Writer\n状态：running" }],
  }, sibling.ctx);
  assert.equal(siblingStatusResult.isError, false);
  assert.match(siblingStatusResult.content.at(-1).text, /startup status 已验证/);
  assert.deepEqual(handlers.activeTools(), ["subagent"]);
  const siblingTask = [
    "按 report-writer 处理 cardId=card-1",
    `SESSION=${sibling.session}`,
    `result.json=${join(sibling.session, "result.json")}`,
  ].join("\n");
  assert.equal(await toolCall(contractCall({
    chain: [{ agent: "report-writer", task: siblingTask }],
  }, "b2-sibling-writer"), sibling.ctx), undefined);
  assert.deepEqual(handlers.activeTools(), initialTools);

  const valid = await seed("valid");
  await input({ text: "继续" }, valid.ctx);
  assert.deepEqual(handlers.activeTools(), ["bash"], "input hook 在 provider prompt 生成前收窄工具");
  const startResult = await beforeAgentStart({ prompt: "继续", systemPrompt: "base" }, valid.ctx);
  assert.match(startResult.systemPrompt, /NEXT_TOOL_ONLY/);
  assert.deepEqual(handlers.activeTools(), ["bash"], "status 前模型只能看到 bash");
  assert.equal(handlers.activeTools().includes("read"), false);
  assert.equal(handlers.activeTools().includes("subagent"), false);
  const hiddenRead = await toolResult({
    toolCallId: "b2-hidden-read",
    toolName: "read",
    input: { path: join(repoRoot, ".pi/skills/html-report/SKILL.md") },
    isError: true,
    content: [{ type: "text", text: "Tool read not found" }],
  }, valid.ctx);
  assert.equal(hiddenRead.isError, false);
  assert.match(hiddenRead.content[0].text, /已忽略：B2 启动只允许 stage-gate status，read 未执行/);
  assert.equal(readGateState(repoRoot, valid.sid).status, "running");
  const statusCall = {
    toolCallId: "b2-valid-status",
    toolName: "bash",
    input: {
      command: `node '${stageGateScriptPath(repoRoot)}' status --session-dir '${valid.session}' --format text`,
    },
  };
  assert.equal(await toolCall(statusCall, valid.ctx), undefined);
  const statusResult = await toolResult({
    ...statusCall,
    isError: false,
    content: [{ type: "text", text: "阶段：B2 Writer\n状态：running" }],
  }, valid.ctx);
  assert.equal(statusResult.isError, false);
  assert.match(statusResult.content.at(-1).text, /startup status 已验证/);
  assert.match(statusResult.content.at(-1).text, /NEXT_TOOL_ONLY[\s\S]*subagent\(\{"chain":\[\{"agent":"report-writer"/);
  assert.match(statusResult.content.at(-1).text, /cardId=card-1/);
  assert.deepEqual(handlers.activeTools(), ["subagent"], "status 成功后只暴露首个 Writer 工具");

  const driftedWriter = await toolCall(contractCall({
    chain: [{ agent: "report-writer", task: "自行重构的错误任务" }],
  }, "b2-drifted-writer"), valid.ctx);
  assert.equal(driftedWriter.block, true);
  assert.match(driftedWriter.reason, /唯一允许调用/);
  assert.equal(readGateState(repoRoot, valid.sid).status, "running");
  assert.deepEqual(handlers.activeTools(), ["subagent"]);

  const task = [
    "按 report-writer 处理 cardId=card-1",
    `SESSION=${valid.session}`,
    `result.json=${join(valid.session, "result.json")}`,
  ].join("\n");
  const missingToolCallId = await toolCall({
    toolName: "subagent",
    input: {
      chain: [{ agent: "report-writer", task }],
    },
  }, valid.ctx);
  assert.equal(missingToolCallId.block, true);
  assert.match(missingToolCallId.reason, /缺少 toolCallId/);
  assert.equal(readGateState(repoRoot, valid.sid).status, "running");
  assert.deepEqual(
    handlers.activeTools(),
    ["subagent"],
    "Writer 完整注册失败时必须保留精确接棒锁"
  );

  const writerCall = contractCall({
    chain: [{ agent: "report-writer", task }],
  }, "b2-after-status-writer");
  assert.equal(await toolCall(writerCall, valid.ctx), undefined);
  assert.deepEqual(handlers.activeTools(), initialTools, "精确 Writer 接棒后恢复原工具集");

  const invalid = await seed("invalid");
  await beforeAgentStart({ prompt: "继续", systemPrompt: "base" }, invalid.ctx);
  assert.deepEqual(handlers.activeTools(), ["bash"]);
  const wrongStatus = {
    toolCallId: "b2-invalid-status",
    toolName: "bash",
    input: { command: "pwd" },
  };
  const invalidDecision = await toolCall(wrongStatus, invalid.ctx);
  assert.equal(invalidDecision.block, true);
  assert.match(invalidDecision.reason, /该工具未执行.*Gate attempt 保持有效/);
  assert.equal(readGateState(repoRoot, invalid.sid).status, "running");
  assert.deepEqual(handlers.activeTools(), ["bash"], "无害多余工具不得废掉 B2 启动");
  const recoveredStatus = {
    toolCallId: "b2-invalid-recovered-status",
    toolName: "bash",
    input: {
      command: `node '${stageGateScriptPath(repoRoot)}' status --session-dir '${invalid.session}' --format text`,
    },
  };
  assert.equal(await toolCall(recoveredStatus, invalid.ctx), undefined);
  const recoveredResult = await toolResult({
    ...recoveredStatus,
    isError: false,
    content: [{ type: "text", text: "阶段：B2 Writer\n状态：running" }],
  }, invalid.ctx);
  assert.equal(recoveredResult.isError, false);
  assert.match(recoveredResult.content.at(-1).text, /startup status 已验证/);
  const recoveredTask = [
    "按 report-writer 处理 cardId=card-1",
    `SESSION=${invalid.session}`,
    `result.json=${join(invalid.session, "result.json")}`,
  ].join("\n");
  assert.equal(await toolCall(contractCall({
    chain: [{ agent: "report-writer", task: recoveredTask }],
  }, "b2-invalid-recovered-writer"), invalid.ctx), undefined);
  assert.deepEqual(handlers.activeTools(), initialTools);

  const executionError = await seed("execution-error");
  await input({ text: "继续" }, executionError.ctx);
  const errorStatusCall = {
    toolCallId: "b2-execution-error-status",
    toolName: "bash",
    input: {
      command: `node '${stageGateScriptPath(repoRoot)}' status --session-dir '${executionError.session}' --format text`,
    },
  };
  assert.equal(await toolCall(errorStatusCall, executionError.ctx), undefined);
  const errorStatusResult = await toolResult({
    ...errorStatusCall,
    isError: true,
    content: [{ type: "text", text: "simulated status failure" }],
  }, executionError.ctx);
  assert.equal(errorStatusResult.isError, true);
  assert.match(errorStatusResult.content[0].text, /status 执行失败/);
  assert.equal(readGateState(repoRoot, executionError.sid).status, "failed");
  assert.deepEqual(handlers.activeTools(), initialTools);

  const resumed = await seed("resumed");
  await input({ text: "继续" }, resumed.ctx);
  const firstResumedStatus = {
    toolCallId: "b2-resumed-status-1",
    toolName: "bash",
    input: {
      command: `node '${stageGateScriptPath(repoRoot)}' status --session-dir '${resumed.session}' --format text`,
    },
  };
  assert.equal(await toolCall(firstResumedStatus, resumed.ctx), undefined);
  await agentSettled({}, resumed.ctx);
  assert.equal(readGateState(repoRoot, resumed.sid).status, "paused");
  assert.deepEqual(handlers.activeTools(), initialTools);
  await input({ text: "继续" }, resumed.ctx);
  assert.equal(readGateState(repoRoot, resumed.sid).status, "running");
  assert.deepEqual(handlers.activeTools(), ["bash"]);
  const secondResumedStatus = { ...firstResumedStatus, toolCallId: "b2-resumed-status-2" };
  assert.equal(await toolCall(secondResumedStatus, resumed.ctx), undefined, "resume 后可重新执行精确 status");
  const secondResumedResult = await toolResult({
    ...secondResumedStatus,
    isError: false,
    content: [{ type: "text", text: "阶段：B2 Writer\n状态：running" }],
  }, resumed.ctx);
  assert.equal(secondResumedResult.isError, false);
  assert.deepEqual(handlers.activeTools(), ["subagent"]);
  await agentSettled({}, resumed.ctx);
  assert.deepEqual(handlers.activeTools(), initialTools);

  const stale = await seed("stale");
  await input({ text: "继续" }, stale.ctx);
  const staleStatusCall = {
    toolCallId: "b2-stale-status",
    toolName: "bash",
    input: {
      command: `node '${stageGateScriptPath(repoRoot)}' status --session-dir '${stale.session}' --format text`,
    },
  };
  assert.equal(await toolCall(staleStatusCall, stale.ctx), undefined);
  assert.equal(runStageGate(repoRoot, stale.sid, "fail", [
    "--stage", "B2_WRITER", "--reason", "simulate old attempt timeout",
  ]).ok, true);
  assert.equal(runStageGate(repoRoot, stale.sid, "retry", [
    "--phrase", "重试当前阶段", "--actor", "user",
  ]).ok, true);
  const staleResult = await toolResult({
    ...staleStatusCall,
    isError: false,
    content: [{ type: "text", text: "阶段：B2 Writer\n状态：running" }],
  }, stale.ctx);
  assert.equal(staleResult.isError, true);
  assert.match(staleResult.content[0].text, /迟到 tool_result 已忽略/);
  const stateAfterStaleResult = readGateState(repoRoot, stale.sid);
  assert.equal(stateAfterStaleResult.status, "running");
  assert.equal(stateAfterStaleResult.stages.B2_WRITER.attempts.length, 2);
  assert.deepEqual(handlers.activeTools(), initialTools);
  const staleStart = await beforeAgentStart({ prompt: "重试当前阶段", systemPrompt: "base" }, stale.ctx);
  assert.match(staleStart?.systemPrompt || "", /NEXT_TOOL_ONLY/);
  assert.deepEqual(handlers.activeTools(), ["bash"]);
  await agentSettled({}, stale.ctx);
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
  assert.equal(completedB0.state.status, "awaiting_approval");
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

test("running gate requires a standalone finish for the current stage", () => {
  const state = waitingState({ status: "running" });
  state.stages.B2_WRITER.status = "running";
  const ok = gateToolDecision(state, {
    toolName: "bash",
    input: {
      command: "node stage-gate.mjs finish --session-dir /tmp/s --stage B2_WRITER --format text",
    },
  });
  assert.equal(ok, null);

  const wrong = gateToolDecision(state, {
    toolName: "bash",
    input: { command: "node stage-gate.mjs finish --session-dir /tmp/s --stage B3_RESEARCH" },
  });
  assert.equal(wrong.block, true);
  assert.match(wrong.reason, /stage mismatch/);

  const approval = gateToolDecision(state, {
    toolName: "bash",
    input: { command: "node stage-gate.mjs approve --session-dir /tmp/s" },
  });
  assert.equal(approval.block, true);
  assert.match(approval.reason, /用户输入/);

  const inFlight = gateToolDecision(state, { toolName: "subagent", input: {} }, { finishInFlight: true });
  assert.equal(inFlight.block, true);

  const auto = { ...state, mode: "auto" };
  assert.equal(gateToolDecision(auto, { toolName: "subagent", input: {} }), null);
  const chainedAutoFinish = gateToolDecision(auto, {
    toolName: "bash",
    input: { command: "node do-work.mjs && node stage-gate.mjs finish" },
  });
  assert.equal(chainedAutoFinish.block, true);
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

test("B2.5 auto-dispatches one typed Planner only after status and source-fields both pass", async (t) => {
  for (const order of [["status", "source_fields"], ["source_fields", "status"]]) {
    const suffix = order.join("-then-");
    const sid = `editor-planner-bridge-${suffix}-${process.pid}-${Date.now()}-${++contractEventSerial}`;
    const session = htmlReportSessionDir(repoRoot, sid);
    const resultPath = join(session, "result.json");
    const cardDir = join(session, "data", "cards", "card-a");
    const ctx = { sessionManager: { getSessionId: () => sid } };
    t.after(async () => rm(session, { recursive: true, force: true }));
    await mkdir(cardDir, { recursive: true });
    await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
    await writeFile(resultPath, JSON.stringify({
      status: "confirmed",
      userQuestion: "哪一条已观察记录的结果更好？",
      title: "通用排序分析",
      cards: [{ id: "card-a", title: "观测明细", query: {
        request: {
          metrics: ["outcome"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-01-01", endDate: "2026-01-31" },
          dimensions: ["period"],
          filters: {},
        },
        comparisons: [],
      } }],
    }));
    await writeFile(join(session, "recommendations.json"), JSON.stringify({
      userQuestion: "哪一条已观察记录的结果更好？",
      cards: [{ id: "card-a", analysisFocus: "识别较好记录" }],
    }));
    const rows = [
      { period: "p1", factor: 10, outcome: 20 },
      { period: "p2", factor: 12, outcome: 30 },
    ];
    await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
    await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
      rowCount: rows.length,
      rowsSha256: rowsSha256(rows),
    }));
    await writeFile(
      pipelineStatePath(session),
      JSON.stringify(persistedGateState(runningGateState("B25_EDITOR"), sid), null, 2)
    );
    const inventory = {
      version: 1,
      producer: "prepare-research-evidence.mjs",
      mode: "source_fields",
      sources: [{
        cardId: "card-a",
        status: "available",
        rowCount: rows.length,
        rowsSha256: rowsSha256(rows),
        empty: false,
        fieldInventoryStatus: "validated",
        availableFields: ["period", "factor", "outcome"],
        profile: {},
        dataQuality: {},
      }],
    };
    persistEditorSourceInventory(resultPath, inventory);
    persistEditorWriterReturn(resultPath, {
      cardId: "card-a",
      fetchStatus: "success",
      dataPath: join(cardDir, "entry.json"),
      metaPath: join(cardDir, "entry.meta.json"),
      analysis: {
        summary: "已取得确认范围内的明细",
        findings: [{ statement: "已有起点记录", evidence: ["entry.json#/0"] }],
        recommendations: ["继续比较已观察记录"],
      },
    });
    writeHtmlReportRuntimeContract(repoRoot, sid);

    const plan = {
      version: 1,
      noDeeperReason: null,
      answerRequirements: [],
      tasks: [{
        fromCardId: "card-a",
        goal: "识别结果较好的已观察记录",
        gap: "Writer 起点尚未比较确认范围内的记录",
        mode: "reuse_entry",
        reason: "确认明细已包含记录和结果字段",
        evidenceGap: null,
        candidateIndicators: [],
        candidateDims: [],
        operations: [{
          id: "best-record",
          type: "topN",
          field: "outcome",
          fields: ["period", "factor", "outcome"],
          count: 1,
          direction: "desc",
        }],
        requirements: [{
          id: "answer-ranking",
          question: "哪一条已观察记录的结果更好？",
          capability: "ranking",
          evidenceViewIds: ["best-record"],
          targetRubric: ["R1", "R5"],
        }],
        successCriteria: "直接回答题面并引用排序证据",
        hint: "只解释确认样本",
      }],
    };
    const bridge = createForegroundSubagentEventBus(async (request, requestNumber) => {
      assert.equal(request.params.context, "fresh");
      assert.equal(request.params.chain.length, 1);
      assert.equal(request.params.chain[0].agent, "report-researcher");
      if (requestNumber === 1) {
        assert.equal(request.params.chain[0].model, "qdm-market/deepseek-v4-flash");
        assert.equal(request.params.chain[0].outputSchema.type, "object");
        assert.match(request.params.chain[0].task, /COMPACT EDITOR INPUT JSON/);
        return {
          content: [{ type: "text", text: "structured Planner return" }],
          details: {
            mode: "chain",
            results: [{
              agent: "report-researcher",
              exitCode: 0,
              transcriptPath: join(session, "debug", "planner-transcript.jsonl"),
              structuredOutput: plan,
            }],
          },
        };
      }
      assert.equal(requestNumber, 2, "bootstrap may dispatch only Planner + first Researcher");
      assert.ok(Array.isArray(request.params.chain[0].outputSchema.oneOf));
      assert.match(request.params.chain[0].task, /taskId=drill-001/);
      const paths = researcherReturnPaths({ sessionDir: session, taskId: "drill-001" });
      const researcherReturn = {
        taskId: "drill-001",
        status: "ok",
        evidenceModeUsed: "reuse_entry",
        evidencePath: paths.evidencePath,
        sectionPath: paths.sectionPath,
        summaryPath: paths.summaryPath,
        summary: "p2 的 outcome 为 30，factor 为 12，是已观察记录中的较高结果。",
        noData: false,
        evidencePointers: ["/views/best-record"],
        findings: [{
          requirementId: "answer-ranking",
          claim: "p2 的 outcome 为 30，factor 为 12，是已观察记录中的较高结果。",
          evidencePointers: ["/views/best-record"],
        }],
        selfCheck: {
          modeCompliant: true,
          evidenceTraceable: true,
          hasContrastOrBreakdown: false,
          answersGoal: true,
          queryJustified: null,
        },
        suggestedDeeper: [],
      };
      await mkdir(dirname(paths.sectionPath), { recursive: true });
      await writeFile(
        paths.sectionPath,
        "# 结论\n\np2 的 outcome 为 30，factor 为 12，是已观察记录中的较高结果。\n\n证据：`/views/best-record`\n"
      );
      await writeFile(paths.summaryPath, JSON.stringify(researcherReturn));
      return {
        content: [{ type: "text", text: "structured Researcher return" }],
        details: {
          mode: "chain",
          results: [{
            agent: "report-researcher",
            exitCode: 0,
            transcriptPath: join(session, "debug", "researcher-transcript.jsonl"),
            structuredOutput: researcherReturn,
          }],
        },
      };
    });
    const handlers = registerHarnessExtension({ events: bridge.events });
    const toolCall = handlers.get("tool_call")[0];
    const toolResult = handlers.get("tool_result")[0];
    const bootstrap = b25EditorBootstrapContract(repoRoot, sid);
    const calls = {
      status: {
        toolCallId: `${sid}-status`,
        toolName: "bash",
        input: { command: bootstrap.statusCommand },
      },
      source_fields: {
        toolCallId: `${sid}-source-fields`,
        toolName: "bash",
        input: { command: bootstrap.sourceFieldsCommand },
      },
    };
    assert.equal(await toolCall(calls.status, ctx), undefined);
    assert.equal(await toolCall(calls.source_fields, ctx), undefined);

    let terminalResult;
    for (const kind of order) {
      const call = calls[kind];
      const content = kind === "status"
        ? "阶段：B2.5 Editor\n状态：running"
        : JSON.stringify({ ok: true, ...inventory });
      terminalResult = await toolResult({
        ...call,
        isError: false,
        content: [{ type: "text", text: content }],
      }, ctx);
    }
    assert.equal(bridge.requests.length, 2, `${suffix} must dispatch Planner then first Researcher exactly once`);
    assert.equal(
      terminalResult.details?.qdmHarnessAutoResearcher?.resultDetails?.results?.[0]?.structuredOutput?.taskId,
      "drill-001",
      JSON.stringify(terminalResult.details?.qdmHarnessAutoResearcher)
    );
    assert.equal(
      terminalResult.isError,
      false,
      terminalResult.content?.map((part) => part.text).join("\n")
    );
    assert.match(terminalResult.content.map((part) => part.text).join("\n"), /确定性生成 tasks\/main/);
    assert.equal(terminalResult.details.qdmHarnessAutoSubagent.mechanism, "extension-event-bridge");
    assert.equal(terminalResult.details.qdmHarnessAutoSubagent.role, "report-editor-planner");
    assert.equal(terminalResult.details.qdmHarnessAutoResearcher.mechanism, "extension-event-bridge");
    assert.equal(terminalResult.details.qdmHarnessAutoResearcher.role, "report-researcher");
    assert.equal((await pipelineStatus(session)).state.currentStage, "B3_RESEARCH");
    const dispatchDir = join(session, "debug", "contract-runtime", "dispatches");
    const dispatchFiles = await readdir(dispatchDir);
    const dispatches = await Promise.all(dispatchFiles.map(async (name) =>
      JSON.parse(await readFile(join(dispatchDir, name), "utf8"))
    ));
    const plannerDispatches = dispatches.filter((record) => record.role === "report-editor-planner");
    const researcherDispatches = dispatches.filter((record) => record.role === "report-researcher");
    assert.equal(plannerDispatches.length, 1);
    assert.equal(plannerDispatches[0].mechanism, "extension-event-bridge");
    assert.equal(researcherDispatches.length, 1);
    assert.equal(researcherDispatches[0].mechanism, "extension-event-bridge");
  }
});

test("B2.5 runs one fresh report-researcher Planner and automatically materializes/finalizes the stage", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `editor-planner-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const resultPath = join(session, "result.json");
  const cardDir = join(session, "data", "cards", "card-a");
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  await mkdir(cardDir, { recursive: true });
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    userQuestion: "哪一种观测组合对应更好的结果？",
    title: "中性组合分析",
    cards: [{
      id: "card-a",
      title: "中性样本明细",
      query: {
        request: {
          metrics: ["metric-a", "metric-b"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-01-01", endDate: "2026-01-31" },
          dimensions: ["period-key"],
          filters: { "entity-key": ["entity-a"] },
        },
        comparisons: [],
      },
    }],
  }));
  await writeFile(join(session, "recommendations.json"), JSON.stringify({
    userQuestion: "哪一种观测组合对应更好的结果？",
    cards: [{ id: "card-a", analysisFocus: "比较因素与结果" }],
  }));
  const rows = [
    { period_value: "p-a", factor_value: 10, auxiliary_factor: 8, outcome_value: 30 },
    { period_value: "p-b", factor_value: 20, auxiliary_factor: 12, outcome_value: 50 },
  ];
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }));
  const editorState = runningGateState("B25_EDITOR");
  editorState.mode = "step";
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(editorState, sid), null, 2)
  );
  persistEditorSourceInventory(resultPath, {
    version: 1,
    producer: "prepare-research-evidence.mjs",
    mode: "source_fields",
    sources: [{
      cardId: "card-a",
      status: "available",
      rowCount: rows.length,
      rowsSha256: rowsSha256(rows),
      empty: false,
      fieldInventoryStatus: "validated",
      availableFields: ["period_value", "factor_value", "auxiliary_factor", "outcome_value"],
      profile: {},
      dataQuality: {},
    }],
  });
  persistEditorWriterReturn(resultPath, {
    cardId: "card-a",
    fetchStatus: "success",
    dataPath: join(cardDir, "entry.json"),
    metaPath: join(cardDir, "entry.meta.json"),
    analysis: {
      summary: "已取得确认范围内的明细",
      findings: [{ statement: "起点记录", evidence: ["entry.json#/0"] }],
      recommendations: ["继续形成组间对照"],
    },
  });
  writeHtmlReportRuntimeContract(repoRoot, sid);

  const plannerTask = [
    "HTML_REPORT_EDITOR_PLAN_V1",
    `SESSION=${session}`,
    `result.json=${resultPath}`,
  ].join("\n");
  const input = {
    ...hostileContractOverrides(),
    chain: [{ agent: "report-researcher", task: plannerTask, ...hostileStepOverrides() }],
  };
  // A parallel top-level tasks[] shape is rejected before contract sanitizing.
  delete input.tasks;
  const call = contractCall(input, "editor-planner-success");
  assert.equal(await toolCall(call, ctx), undefined);
  assertFixedContractEnvelope(call.input, { stepModel: "qdm-market/deepseek-v4-flash" });
  assert.equal(call.input.maxRuntimeMs, 75_000);
  assert.deepEqual(call.input.turnBudget, { maxTurns: 2, graceTurns: 1 });
  assert.equal(call.input.chain[0].model, "qdm-market/deepseek-v4-flash");
  assert.deepEqual(call.input.chain[0].toolBudget, { hard: 1, block: "*" });
  assert.match(call.input.chain[0].task, /COMPACT EDITOR INPUT JSON/);
  assert.match(call.input.chain[0].task, /哪一种观测组合对应更好的结果/);
  assert.equal(call.input.chain[0].outputSchema.type, "object");
  assert.ok(JSON.stringify(call.input.chain[0].outputSchema).length < 10_000);

  const plan = {
    version: 1,
    noDeeperReason: null,
    answerRequirements: [],
    tasks: [{
      fromCardId: "card-a",
      goal: "识别结果较好的已观察记录并形成组间对照",
      gap: "Writer 起点尚未回答哪种组合对应更好的结果",
      mode: "reuse_entry",
      reason: "确认明细包含记录、因素和结果字段",
      evidenceGap: null,
      candidateIndicators: [],
      candidateDims: [],
      operations: [
        {
          id: "best-comparison",
          type: "topN",
          sortBy: "outcome_value",
          fields: ["period_value", "factor_value", "outcome_value"],
          count: 1,
          direction: "desc",
        },
        {
          id: "joint-bins",
          type: "jointQuantileBins",
          targetField: "outcome_value",
          fields: ["factor_value", "auxiliary_factor", "outcome_value"],
          direction: "desc",
          binCount: 4,
        },
      ],
      requirements: [
        {
          id: "answer-best",
          question: "哪条已观察记录结果更好，与其余记录有何差异？",
          capability: "record",
          evidenceViewIds: ["best-comparison"],
          targetRubric: ["R1", "R5"],
        },
        {
          id: "answer-gradients",
          question: "两个因素的哪个已观察组合区间对应更好的结果？",
          capability: "joint_tradeoff",
          evidenceViewIds: ["joint-bins"],
          targetRubric: ["R3", "R5"],
        },
      ],
      successCriteria: "结论直接回答题面并引用组间对照 view",
      hint: "只解释确认样本，不扩展为通用阈值",
    }],
  };
  const accepted = await toolResult(contractResult(call, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: plan }] },
  }), ctx);
  assert.equal(accepted.isError, false, accepted.content?.[0]?.text || "Planner result unexpectedly failed");
  assert.match(accepted.content[0].text, /确定性生成 tasks\/main/);
  assert.match(accepted.content[0].text, /B3_RESEARCH 已自动启动/);
  assert.match(accepted.content[0].text, /NEXT_TOOL_ONLY/);
  const plannerHandoff = JSON.parse(accepted.content[0].text.split("\n")[1]);
  assert.equal(plannerHandoff.researchTasks.length, 1);
  assert.equal(plannerHandoff.researchTasks[0].task.id, "drill-001");
  assert.equal(plannerHandoff.researchTasks[0].evidencePath.endsWith("/analysis/evidence/drill-001.json"), true);
  const tasks = JSON.parse(await readFile(join(session, "analysis", "tasks.json"), "utf8"));
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].id, "drill-001");
  assert.deepEqual(tasks.tasks[0].evidencePlan.requiredColumns, [
    "period_value",
    "factor_value",
    "outcome_value",
    "auxiliary_factor",
  ]);
  assert.equal(tasks.tasks[0].evidencePlan.operations.length, 2);
  assert.equal(tasks.tasks[0].evidencePlan.operations[0].type, "topN");
  assert.equal(tasks.tasks[0].evidencePlan.operations[0].field, "outcome_value");
  assert.equal(tasks.tasks[0].evidencePlan.operations[0].sortBy, undefined);
  assert.equal(tasks.tasks[0].evidencePlan.operations[1].type, "jointQuantileBins");
  assert.deepEqual(tasks.tasks[0].evidencePlan.operations[1].fields, ["factor_value", "auxiliary_factor"]);
  assert.equal(tasks.tasks[0].evidencePlan.operations[1].targetField, "outcome_value");
  assert.deepEqual(tasks.tasks[0].analysisRequirements[1].evidenceViewIds, ["joint-bins"]);
  assert.equal(tasks.tasks[0].analysisContractVersion, 1);
  assert.match(await readFile(join(session, "analysis", "main.md"), "utf8"), /待 B3 Researcher 结论/);
  const status = await pipelineStatus(session);
  assert.equal(status.state.currentStage, "B3_RESEARCH");
  assert.equal(status.state.stages.B25_EDITOR.status, "completed");
  assert.equal(status.state.stages.B3_RESEARCH.status, "running");

  const researchTask = [
    "按 report-researcher 处理 taskId=drill-001",
    `SESSION=${session}`,
    `result.json=${resultPath}`,
    `完整 task 对象: ${JSON.stringify(plannerHandoff.researchTasks[0].task)}`,
    "用户问题: 哪一种观测组合对应更好的结果？",
    `evidencePath=${plannerHandoff.researchTasks[0].evidencePath}`,
    "机器契约：由 qdm-harness 根据当前 task、mode、requirements 和 outputSchema 注入；父代理不得在这里展开、转述或追加规则。",
  ].join("\n");
  const researchInput = {
    chain: [{ agent: "report-researcher", task: researchTask }],
  };
  const exactDispatch = `subagent(${JSON.stringify(researchInput)})`;
  assert.ok(accepted.content[0].text.includes(
    `NEXT_TOOL_ONLY：下一条 assistant 消息只原样调用 \`${exactDispatch}\`。`
  ));
  assert.deepEqual(handlers.activeTools(), ["subagent"], "Planner 成功后只暴露首个 Researcher 工具");
  const handoffDrift = await toolCall({
    toolCallId: "planner-handoff-read",
    toolName: "read",
    input: { path: join(session, "analysis", "tasks.json") },
  }, ctx);
  assert.equal(handoffDrift.block, true);
  assert.match(handoffDrift.reason, /确定性的 B3 首个工具调用/);
  assert.deepEqual(handlers.activeTools(), ["subagent"], "被拒绝的漂移不能解除接棒约束");
  const researchCall = contractCall(researchInput, "editor-planner-first-researcher");
  assert.equal(await toolCall(researchCall, ctx), undefined);
  assertFixedContractEnvelope(researchCall.input);
  assert.equal(researchCall.input.chain[0].outputSchema.type, undefined);
  assert.ok(Array.isArray(researchCall.input.chain[0].outputSchema.oneOf));
  assert.deepEqual(handlers.activeTools(), ["read", "bash", "subagent", "write"], "精确派发后恢复原工具集");

  const duplicate = await toolCall(contractCall({
    chain: [{ agent: "report-researcher", task: plannerTask }],
  }, "editor-planner-duplicate"), ctx);
  assert.equal(duplicate.block, true);
  assert.match(duplicate.reason, /B3_RESEARCH|不属于该阶段/);
});

test("B2.5 zero-row plan hands an empty B3 directly to the fixed finalizer", async (t) => {
  const initialTools = ["read", "bash", "subagent", "write"];
  const handlers = registerHarnessExtension({ initialTools });
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `editor-planner-empty-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const resultPath = join(session, "result.json");
  const cardDir = join(session, "data", "cards", "card-a");
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  await mkdir(cardDir, { recursive: true });
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    userQuestion: "确认范围内是否有匹配明细？",
    title: "空范围核对",
    cards: [{ id: "card-a", title: "空范围", query: { request: {}, comparisons: [] } }],
  }));
  await writeFile(join(session, "recommendations.json"), JSON.stringify({
    userQuestion: "确认范围内是否有匹配明细？",
    cards: [{ id: "card-a", analysisFocus: "确认数据可用性" }],
  }));
  await writeFile(join(cardDir, "entry.json"), "[]");
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: 0,
    rowsSha256: rowsSha256([]),
  }));
  const editorState = runningGateState("B25_EDITOR");
  editorState.mode = "step";
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(editorState, sid), null, 2)
  );
  persistEditorSourceInventory(resultPath, {
    version: 1,
    producer: "prepare-research-evidence.mjs",
    mode: "source_fields",
    sources: [{
      cardId: "card-a",
      status: "available",
      rowCount: 0,
      rowsSha256: rowsSha256([]),
      empty: true,
      fieldInventoryStatus: "unverifiable_empty_source",
      availableFields: [],
      profile: {},
      dataQuality: {},
    }],
  });
  persistEditorWriterReturn(resultPath, {
    cardId: "card-a",
    fetchStatus: "success",
    dataPath: join(cardDir, "entry.json"),
    metaPath: join(cardDir, "entry.meta.json"),
    analysis: { summary: "空结果", findings: [], recommendations: ["说明范围"] },
  });
  writeHtmlReportRuntimeContract(repoRoot, sid);

  const plannerTask = `HTML_REPORT_EDITOR_PLAN_V1\nSESSION=${session}\nresult.json=${resultPath}`;
  const plannerCall = contractCall({
    chain: [{ agent: "report-researcher", task: plannerTask }],
  }, "editor-planner-empty");
  assert.equal(await toolCall(plannerCall, ctx), undefined);
  const accepted = await toolResult(contractResult(plannerCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: {
      version: 1,
      tasks: [],
      answerRequirements: [{
        id: "direct-no-data",
        question: "确认范围内是否有匹配明细？",
        capability: "no_data",
        coverage: { kind: "empty_source", cardId: "card-a", findingIndex: null },
      }],
      noDeeperReason: "已验证的零行源直接回答无数据问题",
    } }] },
  }), ctx);
  assert.equal(accepted.isError, false);
  const handoff = JSON.parse(accepted.content[0].text.split("\n")[1]);
  assert.deepEqual(handoff.researchTasks, []);
  const finalizerCommand = `node '${join(repoRoot, ".agents/pi/skills/html-report/scripts/finalize-research-stage.mjs")}' --result '${resultPath}'`;
  const finalizerInvocation = `bash(${JSON.stringify({ command: finalizerCommand })})`;
  assert.ok(accepted.content[0].text.includes(
    `NEXT_TOOL_ONLY：下一条 assistant 消息只原样调用 \`${finalizerInvocation}\`。`
  ));
  assert.deepEqual(handlers.activeTools(), ["bash"]);
  const fakeResearcher = await toolCall(contractCall({
    chain: [{ agent: "report-researcher", task: "fake empty task" }],
  }, "editor-planner-empty-fake"), ctx);
  assert.equal(fakeResearcher.block, true);
  assert.match(fakeResearcher.reason, /唯一允许调用.*finalize-research-stage/);
  const finalizerCall = {
    toolCallId: "editor-planner-empty-finalizer",
    toolName: "bash",
    input: { command: finalizerCommand },
  };
  assert.equal(await toolCall(finalizerCall, ctx), undefined);
  assert.deepEqual(handlers.activeTools(), initialTools);
  const finalized = await toolResult({
    ...finalizerCall,
    isError: false,
    content: [{ type: "text", text: JSON.stringify({ ok: true, producer: "finalize-research-stage.mjs" }) }],
  }, ctx);
  assert.equal(finalized.isError, false);
  assert.match(finalized.content.at(-1).text, /qdm-harness 已确定性完成 B3_RESEARCH/);
  const status = await pipelineStatus(session);
  assert.equal(status.state.currentStage, "B3_RESEARCH");
  assert.equal(status.state.status, "awaiting_approval");
  assert.equal(status.state.stages.B3_RESEARCH.status, "awaiting_approval");
});

test("B3 finalizer is exact, auto-finishes on success, and fails closed without retry", async (t) => {
  let serial = 0;
  const seed = async (label) => {
    serial += 1;
    const sid = `b3-finalizer-${label}-${process.pid}-${Date.now()}-${serial}`;
    const session = htmlReportSessionDir(repoRoot, sid);
    const state = runningGateState("B3_RESEARCH", `2026-07-28T00:0${serial}:00.000Z`);
    state.mode = "step";
    await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
    await writeFile(
      pipelineStatePath(session),
      JSON.stringify(persistedGateState(state, sid), null, 2)
    );
    await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
    writeHtmlReportRuntimeContract(repoRoot, sid);
    t.after(async () => rm(session, { recursive: true, force: true }));
    const command = `node '${join(repoRoot, ".agents/pi/skills/html-report/scripts/finalize-research-stage.mjs")}' --result '${join(session, "result.json")}'`;
    return { sid, session, command, ctx: { sessionManager: { getSessionId: () => sid } } };
  };

  const success = await seed("success");
  const successHandlers = registerHarnessExtension();
  const successToolCall = successHandlers.get("tool_call")[0];
  const successToolResult = successHandlers.get("tool_result")[0];
  const manualFinish = await successToolCall({
    toolCallId: "b3-manual-finish",
    toolName: "bash",
    input: {
      command: `node '${join(repoRoot, ".agents/pi/skills/html-report/scripts/stage-gate.mjs")}' finish --session-dir '${success.session}' --stage B3_RESEARCH --format text`,
    },
  }, success.ctx);
  assert.equal(manualFinish.block, true);
  assert.match(manualFinish.reason, /只能在精确 finalizer 成功后.*自动 finish/);

  const drift = await successToolCall({
    toolCallId: "b3-finalizer-drift",
    toolName: "bash",
    input: { command: `${success.command} --extra forbidden` },
  }, success.ctx);
  assert.equal(drift.block, true);
  assert.match(drift.reason, /精确独立调用/);

  const successCall = {
    toolCallId: "b3-finalizer-success",
    toolName: "bash",
    input: { command: success.command },
  };
  assert.equal(await successToolCall(successCall, success.ctx), undefined);
  const concurrent = await successToolCall({
    ...successCall,
    toolCallId: "b3-finalizer-concurrent",
  }, success.ctx);
  assert.equal(concurrent.block, true);
  assert.match(concurrent.reason, /finish 正在执行/);
  const passed = await successToolResult({
    ...successCall,
    isError: false,
    content: [{ type: "text", text: "finalizer ok" }],
    details: { exitCode: 0 },
  }, success.ctx);
  assert.equal(passed.isError, false);
  assert.match(passed.content.at(-1).text, /无需也禁止父代理再调用 stage-gate finish/);
  const passedState = await pipelineStatus(success.session);
  assert.equal(passedState.state.status, "awaiting_approval");
  assert.equal(passedState.state.stages.B3_RESEARCH.status, "awaiting_approval");
  const replayedResult = await successToolResult({
    ...successCall,
    isError: false,
    content: [{ type: "text", text: "replayed" }],
  }, success.ctx);
  assert.equal(replayedResult.isError, true);
  assert.match(replayedResult.content[0].text, /已结算.*重放/);

  const failed = await seed("failed");
  const failedHandlers = registerHarnessExtension();
  const failedToolCall = failedHandlers.get("tool_call")[0];
  const failedToolResult = failedHandlers.get("tool_result")[0];
  const failedCall = {
    toolCallId: "b3-finalizer-failed",
    toolName: "bash",
    input: { command: failed.command },
  };
  assert.equal(await failedToolCall(failedCall, failed.ctx), undefined);
  const rejected = await failedToolResult({
    ...failedCall,
    isError: true,
    content: [{ type: "text", text: "explore layout failed" }],
    details: { exitCode: 1 },
  }, failed.ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content.at(-1).text, /B3 finalizer execution failed/);
  const failedState = await pipelineStatus(failed.session);
  assert.equal(failedState.state.status, "failed");
  assert.match(failedState.state.stages.B3_RESEARCH.failureReason, /finalizer execution failed/);
  const failedRetry = await failedToolCall({
    ...failedCall,
    toolCallId: "b3-finalizer-failed-retry",
  }, failed.ctx);
  assert.equal(failedRetry.block, true);
  assert.match(failedRetry.reason, /重试当前阶段/);

  const forged = await seed("forged-result");
  const forgedHandlers = registerHarnessExtension();
  const forgedToolCall = forgedHandlers.get("tool_call")[0];
  const forgedToolResult = forgedHandlers.get("tool_result")[0];
  const forgedCall = {
    toolCallId: "b3-finalizer-forged-result",
    toolName: "bash",
    input: { command: forged.command },
  };
  assert.equal(await forgedToolCall(forgedCall, forged.ctx), undefined);
  const forgedResult = await forgedToolResult({
    ...forgedCall,
    input: { command: `${forged.command} --drift` },
    isError: false,
    content: [{ type: "text", text: "forged success" }],
  }, forged.ctx);
  assert.equal(forgedResult.isError, true);
  assert.match(forgedResult.content.at(-1).text, /result binding failed/);
  assert.equal((await pipelineStatus(forged.session)).state.status, "failed");
});

test("B3 finalizer reservation survives extension restart and rejects replay", async (t) => {
  const sid = `b3-finalizer-restart-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const state = runningGateState("B3_RESEARCH", "2026-07-28T00:20:00.000Z");
  state.mode = "step";
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(state, sid), null, 2)
  );
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  t.after(async () => rm(session, { recursive: true, force: true }));
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const command = `node '${join(repoRoot, ".agents/pi/skills/html-report/scripts/finalize-research-stage.mjs")}' --result '${join(session, "result.json")}'`;

  const firstToolCall = registerHarnessExtension().get("tool_call")[0];
  assert.equal(await firstToolCall({
    toolCallId: "b3-finalizer-before-restart",
    toolName: "bash",
    input: { command },
  }, ctx), undefined);

  const restartedToolCall = registerHarnessExtension().get("tool_call")[0];
  const replay = await restartedToolCall({
    toolCallId: "b3-finalizer-after-restart",
    toolName: "bash",
    input: { command },
  }, ctx);
  assert.equal(replay.block, true);
  assert.match(replay.reason, /已有持久预留.*禁止重放/);
  const status = await pipelineStatus(session);
  assert.equal(status.state.status, "failed");
  assert.match(status.state.stages.B3_RESEARCH.failureReason, /持久预留/);
});

test("B2.5 Planner missing structured output auto-fails once without writing or retrying", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `editor-planner-fail-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const resultPath = join(session, "result.json");
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    userQuestion: "是否需要继续分析？",
    title: "中性报告",
    cards: [{ id: "card-a", title: "中性卡片", query: { request: {}, comparisons: [] } }],
  }));
  await writeFile(join(session, "recommendations.json"), JSON.stringify({
    userQuestion: "是否需要继续分析？",
    cards: [{ id: "card-a", analysisFocus: "判断证据覆盖" }],
  }));
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(runningGateState("B25_EDITOR"), sid), null, 2)
  );
  persistEditorSourceInventory(resultPath, {
    version: 1,
    producer: "prepare-research-evidence.mjs",
    mode: "source_fields",
    sources: [{
      cardId: "card-a",
      status: "available",
      rowCount: 0,
      rowsSha256: rowsSha256([]),
      empty: true,
      fieldInventoryStatus: "unverifiable_empty_source",
      availableFields: [],
      profile: {},
      dataQuality: {},
    }],
  });
  persistEditorWriterReturn(resultPath, {
    cardId: "card-a",
    fetchStatus: "success",
    dataPath: join(session, "data", "cards", "card-a", "entry.json"),
    metaPath: join(session, "data", "cards", "card-a", "entry.meta.json"),
    analysis: { summary: "空结果", findings: [], recommendations: ["说明范围"] },
  });
  writeHtmlReportRuntimeContract(repoRoot, sid);
  const plannerTask = `HTML_REPORT_EDITOR_PLAN_V1\nSESSION=${session}\nresult.json=${resultPath}`;
  const first = contractCall({
    chain: [{ agent: "report-researcher", task: plannerTask }],
  }, "editor-planner-missing-output");
  assert.equal(await toolCall(first, ctx), undefined);
  const failed = await toolResult(contractResult(first, {
    isError: true,
    details: { results: [{ exitCode: 1, error: "Missing structured_output call" }] },
  }), ctx);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /did not submit one valid structured_output/);
  assert.equal((await pipelineStatus(session)).state.status, "failed");
  await assert.rejects(readFile(join(session, "analysis", "tasks.json")), /ENOENT/);

  const retry = await toolCall(contractCall({
    chain: [{ agent: "report-researcher", task: plannerTask }],
  }, "editor-planner-forbidden-retry"), ctx);
  assert.equal(retry.block, true);
  assert.match(retry.reason, /当前阶段失败|重试当前阶段|failed/);
});

async function seedB5ContractGate(t, label) {
  const sid = `${label}-${process.pid}-${Date.now()}-${++contractEventSerial}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const statePath = pipelineStatePath(session);
  const state = runningGateState("B5_DESIGN");
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  t.after(async () => rm(session, { recursive: true, force: true }));
  return {
    sid,
    session,
    statePath,
    paths: designerReturnPaths({ sessionDir: session }),
    task: [
      "B5 autonomous design",
      `SESSION=${session}`,
      `result.json=${join(session, "result.json")}`,
    ].join("\n"),
    ctx: { sessionManager: { getSessionId: () => sid } },
  };
}

function validDesignerReturn(paths, overrides = {}) {
  return {
    status: "ok",
    paths: {
      reportHtml: paths.reportHtml,
      renderMeta: paths.renderMeta,
      designResult: paths.designResult,
      desktopScreenshot: paths.desktopScreenshot,
      mobileScreenshot: paths.mobileScreenshot,
    },
    layoutOk: true,
    repairRounds: 0,
    elapsedMs: 0,
    residualNotes: [],
    ...overrides,
  };
}

test("parent replaces Designer schema and generic acceptance with one fixed foreground contract", async (t) => {
  const seeded = await seedB5ContractGate(t, "designer-envelope");
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const input = {
    ...hostileContractOverrides(),
    turnBudget: { maxTurns: 99, graceTurns: 99 },
    timeoutMs: 999_999,
    maxRuntimeMs: 999_999,
    toolBudget: { hard: 999 },
    chain: [{
      agent: "report-designer",
      task: seeded.task,
      outputSchema: { type: "string" },
      turnBudget: { maxTurns: 99 },
      timeoutMs: 999_999,
      maxRuntimeMs: 999_999,
      toolBudget: { hard: 999 },
      ...hostileStepOverrides(),
    }],
  };

  assert.equal(await toolCall(contractCall(input, "designer-envelope"), seeded.ctx), undefined);
  assertFixedContractEnvelope(input);
  assert.deepEqual(input.turnBudget, { maxTurns: 14, graceTurns: 2 });
  assert.equal(input.maxRuntimeMs, 300_000);
  assert.equal(input.timeoutMs, undefined);
  assert.equal(input.toolBudget, undefined);
  const [step] = input.chain;
  assert.deepEqual(step.toolBudget, {
    hard: 24,
    block: ["read", "bash", "write", "edit"],
  });
  assert.equal(step.turnBudget, undefined);
  assert.equal(step.timeoutMs, undefined);
  assert.equal(step.maxRuntimeMs, undefined);
  assert.equal(
    step.outputSchema.oneOf[0].properties.paths.properties.reportHtml.const,
    seeded.paths.reportHtml
  );
  assert.equal(
    step.outputSchema.oneOf[0].properties.paths.properties.mobileScreenshot.const,
    seeded.paths.mobileScreenshot
  );
  assert.match(step.task, /DESIGNER FIXED EXECUTION RULE \(machine contract\)/);
  assert.match(step.task, /Do not read SKILL\.md, list\/scan directories/);
  assert.match(step.task, /report\.content\.html is context only: never paste, copy, inline, or reproduce it/);
  assert.match(step.task, /compose-report\.mjs is the sole content inserter/);
  assert.match(step.task, /next tool call must be the fixed Compose command/);
  assert.match(step.task, /Before Compose then Capture both succeed and both screenshots are read, edit and a second write are forbidden/);
  assert.match(step.task, /"viewports":\{"desktop":\{"pass":true/);
  assert.match(step.task, /Draft uses viewports \(plural\) with nested boolean pass fields/);
  assert.match(step.task, /Do not add version\/producer\/sessionId, viewport \(singular\), or an assessment wrapper/);
  assert.match(step.task, /Finalize exactly once after that draft write/);
  assert.match(step.task, /do not read design-result\.json, render\.meta\.json, report\.html/i);
  assert.match(step.task, /structured_output\.value must be the JSON object/);
  assert.match(step.task, /Do not return an acceptance report/);
});

test("B5 rejects the free-text Designer form and parallel fan-out", async (t) => {
  const seeded = await seedB5ContractGate(t, "designer-shape");
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const direct = await toolCall(
    contractCall({ agent: "report-designer", task: seeded.task }, "designer-direct"),
    seeded.ctx
  );
  assert.equal(direct.block, true);
  assert.match(direct.reason, /单步骤 chain/);

  const parallel = await toolCall(contractCall({
    chain: [{ parallel: [{ agent: "report-designer", task: seeded.task }] }],
  }, "designer-parallel"), seeded.ctx);
  assert.equal(parallel.block, true);
  assert.match(parallel.reason, /禁止通过 chain\[\]\.parallel\[\]/);
});

test("B5 rejects missing structured output and does not auto-dispatch again", async (t) => {
  const seeded = await seedB5ContractGate(t, "designer-missing-structured");
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const call = contractCall({ chain: [{ agent: "report-designer", task: seeded.task }] }, "designer-no-output");
  assert.equal(await toolCall(call, seeded.ctx), undefined);
  const rejected = await toolResult(contractResult(call, {
    isError: true,
    details: { results: [{ exitCode: 1, error: "Subagent exceeded turn budget" }] },
  }), seeded.ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /structured_output/);

  const duplicate = await toolCall(
    contractCall({ chain: [{ agent: "report-designer", task: seeded.task }] }, "designer-no-output-retry"),
    seeded.ctx
  );
  assert.equal(duplicate.block, true);
  assert.match(duplicate.reason, /持久派发记录|最多 1 次派发|已终止/);
});

test("B5 rejects status=ok when fixed HTML or screenshots are missing", async (t) => {
  const seeded = await seedB5ContractGate(t, "designer-missing-artifacts");
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const call = contractCall({ chain: [{ agent: "report-designer", task: seeded.task }] }, "designer-artifacts");
  assert.equal(await toolCall(call, seeded.ctx), undefined);
  const rejected = await toolResult(contractResult(call, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: validDesignerReturn(seeded.paths) }] },
  }), seeded.ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /missing Designer artifacts/);
  assert.match(rejected.content[0].text, /desktopScreenshot/);
  assert.match(rejected.content[0].text, /mobileScreenshot/);
});

test("B5 accepts one structured failed terminal without requiring fake artifacts", async (t) => {
  const seeded = await seedB5ContractGate(t, "designer-failed-terminal");
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const call = contractCall({ chain: [{ agent: "report-designer", task: seeded.task }] }, "designer-failed");
  assert.equal(await toolCall(call, seeded.ctx), undefined);
  const output = validDesignerReturn(seeded.paths, {
    status: "failed",
    layoutOk: false,
    error: "capture-report failed: browser unavailable",
    residualNotes: ["恢复浏览器依赖后由用户重试当前阶段"],
  });
  const accepted = await toolResult(contractResult(call, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: output }] },
  }), seeded.ctx);
  assert.equal(accepted.isError, false);
  assert.match(accepted.content[0].text, /已验收结构化 status=failed/);
  assert.match(accepted.content[0].text, /不要原样重派 Designer/);
});

test("runtime hook blocks a generic child during a running report Gate and rejects its result", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `stage-subagent-allowlist-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(pipelineStatePath(session), JSON.stringify(persistedGateState({
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "running",
    currentStage: "B2_WRITER",
    stages: { B2_WRITER: { status: "running" } },
  }, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);

  const input = { agent: "worker", task: "try to bypass Report Writer contract" };
  const blocked = await toolCall({ toolName: "subagent", input }, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /B2_WRITER.*report-writer/);

  const rejected = await toolResult({
    toolName: "subagent",
    input,
    isError: false,
    details: { results: [{ exitCode: 0 }] },
  }, ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /B2_WRITER.*report-writer/);
});

test("contract report agents reject top-level tasks[] before launch and again on result", async () => {
  const handlers = new Map();
  qdmHarnessExtension({
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const ctx = { sessionManager: { getSessionId: () => `parallel-contract-tasks-${process.pid}` } };

  for (const agent of ["report-writer", "report-researcher", "report-reviewer"]) {
    const input = { tasks: [{ agent, task: "hostile parallel launch" }] };
    const blocked = await toolCall({ toolName: "subagent", input }, ctx);
    assert.equal(blocked.block, true, `${agent} top-level tasks[] must be blocked`);
    assert.match(blocked.reason, /top-level tasks\[\].*独立、串行、单步骤 chain/);

    const rejected = await toolResult({
      toolName: "subagent",
      input,
      isError: false,
      details: { results: [{ exitCode: 0, structuredOutput: {} }] },
    }, ctx);
    assert.equal(rejected.isError, true, `${agent} parallel result must also be rejected`);
    assert.match(rejected.content[0].text, /top-level tasks\[\]/);
  }

  // Detect every protected role before a valid direct Writer chain can
  // normalize away a different protected role hidden in top-level tasks[].
  const mixed = {
    tasks: [{ agent: "report-reviewer", task: "hidden parallel Reviewer" }],
    chain: [{ agent: "report-writer", task: "otherwise valid direct Writer" }],
  };
  const mixedBlocked = await toolCall({ toolName: "subagent", input: mixed }, ctx);
  assert.equal(mixedBlocked.block, true);
  assert.match(mixedBlocked.reason, /Report Reviewer.*top-level tasks\[\]/);
  const mixedRejected = await toolResult({
    toolName: "subagent",
    input: mixed,
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: {} }] },
  }, ctx);
  assert.equal(mixedRejected.isError, true);
  assert.match(mixedRejected.content[0].text, /Report Reviewer.*top-level tasks\[\]/);

  const unrelated = await toolCall({
    toolName: "another_tool",
    input: { tasks: [{ agent: "report-reviewer", task: "ordinary payload data" }] },
  }, ctx);
  assert.equal(unrelated, undefined, "parallel contract detection must be scoped to the subagent tool");
});

test("contract report agents reject chain[].parallel static and dynamic fan-out", async () => {
  const handlers = new Map();
  qdmHarnessExtension({
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const ctx = { sessionManager: { getSessionId: () => `parallel-contract-chain-${process.pid}` } };

  for (const agent of ["report-writer", "report-researcher", "report-reviewer"]) {
    const shapes = [
      { chain: [{ parallel: [{ agent, task: "hostile static fan-out" }] }] },
      {
        chain: [{
          expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
          parallel: { agent, task: "hostile dynamic fan-out" },
          collect: { as: "results" },
        }],
      },
    ];
    for (const input of shapes) {
      const blocked = await toolCall({ toolName: "subagent", input }, ctx);
      assert.equal(blocked.block, true, `${agent} chain parallel must be blocked`);
      assert.match(blocked.reason, /chain\[\]\.parallel.*独立、串行、单步骤 chain/);

      const rejected = await toolResult({
        toolName: "subagent",
        input,
        isError: false,
        details: { results: [{ exitCode: 0, structuredOutput: {} }] },
      }, ctx);
      assert.equal(rejected.isError, true, `${agent} chain parallel result must also be rejected`);
      assert.match(rejected.content[0].text, /chain\[\]\.parallel/);
    }
  }
});

test("runtime allows one Writer dispatch per Gate attempt and treats valid failures as terminal", async (t) => {
  const handlers = new Map();
  qdmHarnessExtension({
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `writer-dispatch-cap-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  const statePath = pipelineStatePath(session);
  await mkdir(dirname(statePath), { recursive: true });
  const state = {
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "running",
    currentStage: "B2_WRITER",
    stages: {
      B2_WRITER: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-07-28T01:00:00.000Z" }],
      },
    },
  };
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  const task = `按 report-writer 处理 cardId=card-1\nSESSION=${session}\nresult.json=${session}/result.json`;
  const makeInput = () => ({ chain: [{ agent: "report-writer", task }] });

  assert.equal(await toolCall(contractCall(makeInput(), "writer-first"), ctx), undefined);
  const capped = await toolCall(contractCall(makeInput(), "writer-duplicate"), ctx);
  assert.equal(capped.block, true);
  assert.match(capped.reason, /最多 1 次派发/);

  state.stages.B2_WRITER.attempts.push({
    number: 2,
    status: "running",
    startedAt: "2026-07-28T01:05:00.000Z",
  });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  const schemaFailureInput = makeInput();
  const schemaFailureCall = contractCall(schemaFailureInput, "writer-schema-failure");
  assert.equal(await toolCall(schemaFailureCall, ctx), undefined);
  const schemaRejected = await toolResult(contractResult(schemaFailureCall, {
    isError: false,
    details: { results: [{ exitCode: 1, error: "structured output schema validation failed" }] },
  }), ctx);
  assert.equal(schemaRejected.isError, true);
  assert.match(schemaRejected.content[0].text, /exitCode=1.*structured output schema validation failed/);
  assert.equal(readGateState(repoRoot, sid).status, "failed");
  const schemaCapped = await toolCall(contractCall(makeInput(), "writer-schema-retry"), ctx);
  assert.equal(schemaCapped.block, true);
  assert.match(schemaCapped.reason, /失败|failed|重试当前阶段/);

  state.stages.B2_WRITER.attempts.push({
    number: 3,
    status: "running",
    startedAt: "2026-07-28T01:10:00.000Z",
  });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  const failedInput = makeInput();
  const failedCall = contractCall(failedInput, "writer-fetch-failed");
  failedCall.toolName = "SubAgent";
  assert.equal(await toolCall(failedCall, ctx), undefined);
  const failedReturn = {
    cardId: "card-1",
    fetchStatus: "failed",
    dataPath: null,
    metaPath: null,
    error: "INVALID_JSON_RESPONSE: backend returned HTML",
  };
  const failedAccepted = await toolResult(contractResult(failedCall, {
    isError: false,
    details: { results: [writerAckChildResult(failedReturn)] },
  }), ctx);
  assert.equal(failedAccepted.isError, true);
  assert.match(failedAccepted.content[0].text, /B2 Writer cardId=card-1 取数失败/);
  const terminal = await toolCall(contractCall(makeInput(), "writer-terminal-retry"), ctx);
  assert.equal(terminal.block, true);
  assert.match(terminal.reason, /失败|failed/);
});

test("Writer dispatch reservation survives an extension restart within the same Gate attempt", async (t) => {
  const sid = `writer-dispatch-restart-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const statePath = pipelineStatePath(session);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const state = {
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "running",
    currentStage: "B2_WRITER",
    stages: {
      B2_WRITER: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-07-28T01:30:00.000Z" }],
      },
    },
  };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const task = `按 report-writer 处理 cardId=card-restart\nSESSION=${session}\nresult.json=${session}/result.json`;
  const makeInput = () => ({ chain: [{ agent: "report-writer", task }] });

  const firstHandlers = registerHarnessExtension();
  assert.equal(
    await firstHandlers.get("tool_call")[0](contractCall(makeInput(), "writer-before-restart"), ctx),
    undefined
  );

  const restartedHandlers = registerHarnessExtension();
  const duplicate = await restartedHandlers.get("tool_call")[0](
    contractCall(makeInput(), "writer-after-restart-duplicate"),
    ctx
  );
  assert.equal(duplicate?.block, true, "restart must not erase the current attempt's dispatch reservation");
  assert.match(duplicate.reason, /最多 1 次派发|已终止|已派发|持久派发记录/);

  state.stages.B2_WRITER.attempts.push({
    number: 2,
    status: "running",
    startedAt: "2026-07-28T01:35:00.000Z",
  });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  assert.equal(
    await restartedHandlers.get("tool_call")[0](contractCall(makeInput(), "writer-new-attempt"), ctx),
    undefined,
    "a user-created new Gate attempt must receive a fresh reservation namespace"
  );
});

test("run-level timeout without structured output terminates Writer and Researcher identities", async (t) => {
  const handlers = new Map();
  qdmHarnessExtension({
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];

  const writerSid = `writer-runtime-timeout-${process.pid}-${Date.now()}`;
  const writerSession = htmlReportSessionDir(repoRoot, writerSid);
  const writerCtx = { sessionManager: { getSessionId: () => writerSid } };
  t.after(async () => rm(writerSession, { recursive: true, force: true }));
  await mkdir(dirname(pipelineStatePath(writerSession)), { recursive: true });
  await writeFile(pipelineStatePath(writerSession), JSON.stringify(persistedGateState({
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "running",
    currentStage: "B2_WRITER",
    stages: {
      B2_WRITER: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-07-28T02:00:00.000Z" }],
      },
    },
  }, writerSid)));
  writeHtmlReportRuntimeContract(repoRoot, writerSid);
  const writerTask = `按 report-writer 处理 cardId=card-timeout\nSESSION=${writerSession}\nresult.json=${writerSession}/result.json`;
  const writerInput = { chain: [{ agent: "report-writer", task: writerTask }] };
  const writerCall = contractCall(writerInput, "writer-timeout");
  assert.equal(await toolCall(writerCall, writerCtx), undefined);
  const writerTimeout = await toolResult(contractResult(writerCall, {
    isError: true,
    content: [{ type: "text", text: "Subagent exceeded maxRuntimeMs and timed out." }],
    details: { mode: "chain", timedOut: true, results: [] },
  }), writerCtx);
  assert.equal(writerTimeout.isError, true);
  assert.match(writerTimeout.content[0].text, /timed out/);
  assert.equal(readGateState(repoRoot, writerSid).status, "failed");
  const writerTerminal = await toolCall(
    contractCall({ chain: [{ agent: "report-writer", task: writerTask }] }, "writer-after-timeout"),
    writerCtx
  );
  assert.equal(writerTerminal.block, true);
  assert.match(writerTerminal.reason, /失败|failed|重试当前阶段/);

  const researcherSid = `researcher-runtime-timeout-${process.pid}-${Date.now()}`;
  const researcherSession = htmlReportSessionDir(repoRoot, researcherSid);
  const researcherCtx = { sessionManager: { getSessionId: () => researcherSid } };
  const taskObject = {
    id: "timeout-task",
    fromCardId: "card-1",
    goal: "定位毛利额最高日期",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "Writer 数据已覆盖",
      requiredColumns: ["日期", "毛利额"],
      operations: [{ id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
    },
    evidenceGap: null,
  };
  const researcherPaths = researcherReturnPaths({ sessionDir: researcherSession, taskId: taskObject.id });
  t.after(async () => rm(researcherSession, { recursive: true, force: true }));
  await mkdir(dirname(researcherPaths.tasksPath), { recursive: true });
  await mkdir(dirname(pipelineStatePath(researcherSession)), { recursive: true });
  await writeFile(researcherPaths.tasksPath, JSON.stringify({ tasks: [taskObject] }));
  await writeFile(pipelineStatePath(researcherSession), JSON.stringify(persistedGateState({
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "running",
    currentStage: "B3_RESEARCH",
    stages: {
      B3_RESEARCH: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-07-28T02:10:00.000Z" }],
      },
    },
  }, researcherSid)));
  writeHtmlReportRuntimeContract(repoRoot, researcherSid);
  const researcherTask = [
    `按 report-researcher 处理 taskId=${taskObject.id}`,
    `SESSION=${researcherSession}`,
    `result.json=${researcherPaths.resultPath}`,
    `完整 task 对象: ${JSON.stringify(taskObject)}`,
    `evidencePath=${researcherPaths.evidencePath}`,
  ].join("\n");
  const researcherInput = { chain: [{ agent: "report-researcher", task: researcherTask }] };
  const researcherCall = contractCall(researcherInput, "researcher-timeout");
  assert.equal(await toolCall(researcherCall, researcherCtx), undefined);
  const researcherRejected = await toolResult(contractResult(researcherCall, {
    isError: false,
    content: [{ type: "text", text: "Child failed before structured output: ETIMEDOUT" }],
    details: {
      mode: "chain",
      results: [{ agent: "report-researcher", exitCode: 1, error: "connect ETIMEDOUT" }],
    },
  }), researcherCtx);
  assert.equal(researcherRejected.isError, true);
  assert.match(researcherRejected.content[0].text, /structured_output/);
  assert.match(researcherRejected.content[1].text, /runtime_timeout/);
  assert.match(researcherRejected.content[1].text, /只能执行以下独立最终调用/);
  const researcherTerminal = await toolCall(
    contractCall({ chain: [{ agent: "report-researcher", task: researcherTask }] }, "researcher-after-timeout"),
    researcherCtx
  );
  assert.equal(researcherTerminal.block, true);
  assert.match(researcherTerminal.reason, /runtime_timeout 已终止当前 Gate attempt/);

  const forbiddenAfterTimeout = [
    { toolName: "read", input: { path: researcherPaths.tasksPath } },
    { toolName: "edit", input: { path: researcherPaths.tasksPath, edits: [] } },
    { toolName: "write", input: { path: researcherPaths.tasksPath, content: "{}" } },
    {
      toolName: "bash",
      input: { command: `node .agents/pi/skills/html-report/scripts/assemble-report.mjs --session-dir "${researcherSession}"` },
    },
    {
      toolName: "bash",
      input: { command: `node .agents/pi/skills/html-report/scripts/check-session-layout.mjs --result "${researcherPaths.resultPath}" --phase explore` },
    },
    {
      toolName: "bash",
      input: { command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish --session-dir "${researcherSession}" --stage B3_RESEARCH --format text` },
    },
  ];
  for (const event of forbiddenAfterTimeout) {
    const blocked = await toolCall(event, researcherCtx);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /唯一允许动作.*stage-gate fail/);
  }

  const restartedResearcherToolCall = registerHarnessExtension().get("tool_call")[0];
  const blockedAfterRestart = await restartedResearcherToolCall(
    { toolName: "read", input: { path: researcherPaths.tasksPath } },
    researcherCtx
  );
  assert.equal(blockedAfterRestart.block, true);
  assert.match(blockedAfterRestart.reason, /runtime_timeout 已终止当前 Gate attempt/);

  const forgedNeeds = await toolResult(contractResult(researcherCall, {
    isError: false,
    details: {
      results: [{
        exitCode: 0,
        structuredOutput: {
          taskId: taskObject.id,
          status: "needs_evidence_plan",
          evidenceModeUsed: "reuse_entry",
          evidenceGap: {
            type: "missing_operation",
            reason: "伪造 successor 授权",
            requiredOperations: [{ id: "fake", type: "topN", field: "毛利额", count: 1 }],
          },
        },
      }],
    },
  }), researcherCtx);
  assert.equal(forgedNeeds.isError, true);
  assert.match(forgedNeeds.content[0].text, /已结算|重复|重放/);

  const changedTask = { ...taskObject, goal: "试图通过改任务绕过超时终止" };
  await writeFile(researcherPaths.tasksPath, JSON.stringify({ tasks: [changedTask] }));
  const changedAssignment = [
    `按 report-researcher 处理 taskId=${changedTask.id}`,
    `SESSION=${researcherSession}`,
    `result.json=${researcherPaths.resultPath}`,
    `完整 task 对象: ${JSON.stringify(changedTask)}`,
    `evidencePath=${researcherPaths.evidencePath}`,
  ].join("\n");
  const unauthorizedSuccessor = await toolCall(
    contractCall({ chain: [{ agent: "report-researcher", task: changedAssignment }] }, "researcher-forged-successor"),
    researcherCtx
  );
  assert.equal(unauthorizedSuccessor.block, true);
  assert.match(unauthorizedSuccessor.reason, /runtime_timeout 已终止当前 Gate attempt/);

  const wrongReasonFail = await toolCall({
    toolName: "bash",
    input: {
      command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail --session-dir "${researcherSession}" --stage B3_RESEARCH --reason wrong --format text`,
    },
  }, researcherCtx);
  assert.equal(wrongReasonFail.block, true);

  const exactFail = await toolCall({
    toolName: "bash",
    input: {
      command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail --session-dir "${researcherSession}" --stage B3_RESEARCH --reason "B3 Report Researcher contract failure: runtime_timeout" --format text`,
    },
  }, researcherCtx);
  assert.equal(exactFail, undefined);
});

test("Researcher contract failures durably close B3 while checked needs_* remains non-terminal", async (t) => {
  let sequence = 0;
  const seed = async (label) => {
    sequence += 1;
    const handlers = registerHarnessExtension();
    const toolCall = handlers.get("tool_call")[0];
    const toolResult = handlers.get("tool_result")[0];
    const sid = `researcher-parent-${label}-${process.pid}-${Date.now()}-${sequence}`;
    const session = htmlReportSessionDir(repoRoot, sid);
    const ctx = { sessionManager: { getSessionId: () => sid } };
    const task = {
      id: `task-${label}`,
      fromCardId: "card-1",
      goal: "分析毛利额",
      status: "pending",
      evidencePlan: {
        mode: "reuse_entry",
        reason: "Writer 数据已覆盖",
        requiredColumns: ["日期", "毛利额"],
        operations: [{ id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
      },
      evidenceGap: null,
    };
    const paths = researcherReturnPaths({ sessionDir: session, taskId: task.id });
    await mkdir(dirname(paths.tasksPath), { recursive: true });
    await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
    await writeFile(paths.tasksPath, JSON.stringify({ tasks: [task] }));
    await writeFile(
      pipelineStatePath(session),
      JSON.stringify(persistedGateState(runningGateState("B3_RESEARCH"), sid))
    );
    writeHtmlReportRuntimeContract(repoRoot, sid);
    t.after(async () => rm(session, { recursive: true, force: true }));
    const assignment = [
      `按 report-researcher 处理 taskId=${task.id}`,
      `SESSION=${session}`,
      `result.json=${paths.resultPath}`,
      `完整 task 对象: ${JSON.stringify(task)}`,
      `evidencePath=${paths.evidencePath}`,
    ].join("\n");
    const input = { chain: [{ agent: "report-researcher", task: assignment }] };
    const call = contractCall(input, `researcher-parent-${label}`);
    assert.equal(await toolCall(call, ctx), undefined);
    return { handlers, toolCall, toolResult, sid, session, ctx, task, paths, input, call };
  };

  const terminalCases = [
    {
      label: "missing",
      failureCode: "missing_structured_output",
      isError: true,
      result(task) {
        return {
          isError: true,
          details: { results: [{ exitCode: 1, error: "Missing structured_output call" }] },
        };
      },
    },
    {
      label: "invalid",
      failureCode: "invalid_return_or_artifacts",
      isError: true,
      result(task) {
        return {
          isError: false,
          details: {
            results: [{
              exitCode: 0,
              structuredOutput: {
                taskId: task.id,
                status: "ok",
                evidenceModeUsed: "reuse_entry",
              },
            }],
          },
        };
      },
    },
    {
      label: "failed",
      failureCode: "structured_status_failed",
      isError: false,
      result(task) {
        return {
          isError: false,
          details: {
            results: [{
              exitCode: 0,
              structuredOutput: {
                taskId: task.id,
                status: "failed",
                evidenceModeUsed: "reuse_entry",
                error: "evidence unavailable",
              },
            }],
          },
        };
      },
    },
  ];

  for (const entry of terminalCases) {
    const seeded = await seed(entry.label);
    const checked = await seeded.toolResult(
      contractResult(seeded.call, entry.result(seeded.task)),
      seeded.ctx
    );
    assert.equal(checked.isError, entry.isError, entry.label);
    assert.match(checked.content.at(-1).text, new RegExp(entry.failureCode), entry.label);

    const forbidden = [
      { toolName: "read", input: { path: seeded.paths.tasksPath } },
      { toolName: "edit", input: { path: seeded.paths.tasksPath, edits: [] } },
      { toolName: "write", input: { path: seeded.paths.tasksPath, content: "{}" } },
      {
        toolName: "bash",
        input: { command: `node .agents/pi/skills/html-report/scripts/assemble-report.mjs --session-dir "${seeded.session}"` },
      },
      {
        toolName: "bash",
        input: { command: `node .agents/pi/skills/html-report/scripts/check-session-layout.mjs --result "${seeded.paths.resultPath}" --phase explore` },
      },
      {
        toolName: "bash",
        input: { command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish --session-dir "${seeded.session}" --stage B3_RESEARCH --format text` },
      },
    ];
    for (const event of forbidden) {
      const blocked = await seeded.toolCall(event, seeded.ctx);
      assert.equal(blocked.block, true, `${entry.label}: ${event.toolName}`);
      assert.match(blocked.reason, new RegExp(`${entry.failureCode} 已终止`));
    }

    const restartedToolCall = registerHarnessExtension().get("tool_call")[0];
    const persisted = await restartedToolCall(
      { toolName: "read", input: { path: seeded.paths.tasksPath } },
      seeded.ctx
    );
    assert.equal(persisted.block, true);
    assert.match(persisted.reason, new RegExp(`${entry.failureCode} 已终止`));

    const exactFail = await seeded.toolCall({
      toolName: "bash",
      input: {
        command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail --session-dir "${seeded.session}" --stage B3_RESEARCH --reason "B3 Report Researcher contract failure: ${entry.failureCode}" --format text`,
      },
    }, seeded.ctx);
    assert.equal(exactFail, undefined, entry.label);
  }

  const needs = await seed("needs");
  const needsOutput = {
    taskId: needs.task.id,
    status: "needs_evidence_plan",
    evidenceModeUsed: "reuse_entry",
    evidenceGap: {
      type: "missing_operation",
      reason: "需要补充 weekday 分组",
      requiredOperations: [{ id: "weekday", type: "groupBy", field: "日期" }],
    },
  };
  const acceptedNeeds = await needs.toolResult(contractResult(needs.call, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: needsOutput }] },
  }), needs.ctx);
  assert.equal(acceptedNeeds.isError, false);
  assert.equal(
    await needs.toolCall({ toolName: "read", input: { path: needs.paths.tasksPath } }, needs.ctx),
    undefined,
    "checked needs_* must not close the B3 parent Gate"
  );
});

test("contract results are bound to one toolCallId, frozen input and launch attempt", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `contract-result-binding-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const statePath = pipelineStatePath(session);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const state = runningGateState("B2_WRITER", "2026-07-28T02:20:00.000Z");
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const task = `按 report-writer 处理 cardId=bound-card\nSESSION=${session}\nresult.json=${session}/result.json`;
  const makeInput = () => ({ chain: [{ agent: "report-writer", task }] });
  const failedOutput = {
    cardId: "bound-card",
    fetchStatus: "failed",
    dataPath: null,
    metaPath: null,
    error: "deterministic failure",
  };
  const resultPayload = {
    isError: false,
    details: { results: [writerAckChildResult(failedOutput)] },
  };

  const firstCall = contractCall(makeInput(), "binding-input");
  assert.equal(await toolCall(firstCall, ctx), undefined);
  const unknown = await toolResult({
    ...contractResult(firstCall, resultPayload),
    toolCallId: "unknown-contract-result",
  }, ctx);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /没有当前 Pi 进程内的已获准派发/);

  const changedInput = JSON.parse(JSON.stringify(firstCall.input));
  changedInput.chain[0].task += "\n伪造返回输入=true";
  const changed = await toolResult(contractResult(firstCall, {
    ...resultPayload,
    input: changedInput,
  }), ctx);
  assert.equal(changed.isError, true);
  assert.match(changed.content[0].text, /input 与发起时固定输入不一致/);
  const replay = await toolResult(contractResult(firstCall, resultPayload), ctx);
  assert.equal(replay.isError, true);
  assert.match(replay.content[0].text, /已结算|重复|重放/);

  state.stages.B2_WRITER.attempts.push({
    number: 2,
    status: "running",
    startedAt: "2026-07-28T02:21:00.000Z",
  });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  const secondCall = contractCall(makeInput(), "binding-late-attempt");
  assert.equal(await toolCall(secondCall, ctx), undefined);
  state.stages.B2_WRITER.attempts.push({
    number: 3,
    status: "running",
    startedAt: "2026-07-28T02:22:00.000Z",
  });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  const late = await toolResult(contractResult(secondCall, resultPayload), ctx);
  assert.equal(late.isError, true);
  assert.match(late.content[0].text, /迟到结果不得污染新 attempt/);

  const missingId = await toolCall({ toolName: "subagent", input: makeInput() }, ctx);
  assert.equal(missingId.block, true);
  assert.match(missingId.reason, /缺少 toolCallId/);
  const thirdCall = contractCall(makeInput(), "binding-before-restart");
  assert.equal(await toolCall(thirdCall, ctx), undefined);
  const restartedHandlers = registerHarnessExtension();
  const afterRestart = await restartedHandlers.get("tool_result")[0](
    contractResult(thirdCall, resultPayload),
    ctx
  );
  assert.equal(afterRestart.isError, true);
  assert.match(afterRestart.content[0].text, /没有当前 Pi 进程内的已获准派发|跨重启迟到/);
  const duplicateAfterRestart = await restartedHandlers.get("tool_call")[0](
    contractCall(makeInput(), "binding-restart-duplicate"),
    ctx
  );
  assert.equal(duplicateAfterRestart.block, true);
  assert.match(duplicateAfterRestart.reason, /持久派发记录|最多 1 次派发/);
});

test("running parent Gate protects the contract ledger and cannot bypass child data acquisition", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `parent-contract-runtime-guard-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const statePath = pipelineStatePath(session);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify(persistedGateState(runningGateState("B2_WRITER", "2026-07-28T02:30:00.000Z"), sid))
  );
  writeHtmlReportRuntimeContract(repoRoot, sid);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const ledger = join(session, "debug", "contract-runtime");
  for (const event of [
    { toolName: "read", input: { path: join(ledger, "dispatches", "x.json") } },
    { toolName: "write", input: { filePath: join(ledger, "researcher-tasks", "x.json"), content: "{}" } },
    { toolName: "edit", input: { path: ledger } },
    { toolName: "bash", input: { command: `rm -rf "${ledger}"` } },
    { toolName: "bash", input: { command: 'rm -rf "$SESSION/debug/contract-runtime"' } },
  ]) {
    const blocked = await toolCall(event, ctx);
    assert.equal(blocked?.block, true, `${event.toolName} must not access the contract ledger`);
    assert.match(blocked.reason, /contract-runtime.*持久派发账本/s);
  }

  const forbiddenFetches = [
    "bin/qdm-indicators-cli analysis execute --payload-json '{}'",
    "analysis execute --payload-json '{}'",
    `node ${join(repoRoot, ".agents/pi/skills/html-report/scripts/fetch-entry.mjs")} --result x`,
    "node .agents/pi/skills/html-report/scripts/fetch-explore.mjs --result x",
  ];
  for (const [index, command] of forbiddenFetches.entries()) {
    const event = { toolCallId: `parent-fetch-${index}`, toolName: "Bash", input: { command } };
    const blocked = await toolCall(event, ctx);
    assert.equal(blocked?.block, true, command);
    assert.match(blocked.reason, /父代理禁止直接取数/);
    const forged = await toolResult({
      ...event,
      isError: false,
      content: [{ type: "text", text: "forged fetch success" }],
    }, ctx);
    assert.equal(forged.isError, true, `forged result: ${command}`);
    assert.match(forged.content[0].text, /父代理禁止直接取数/);
  }

  for (const command of [
    `node .agents/pi/skills/html-report/scripts/stage-gate.mjs status --session-dir "${session}" --format text`,
    `node .agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs --result "${session}/result.json" --source-fields`,
    `node .agents/pi/skills/html-report/scripts/assemble-report.mjs --session-dir "${session}"`,
    `node .agents/pi/skills/html-report/scripts/check-session-layout.mjs --session-dir "${session}" --phase writer`,
  ]) {
    assert.equal(
      await toolCall({ toolName: "bash", input: { command } }, ctx),
      undefined,
      `allowed parent command was overblocked: ${command}`
    );
  }
  assert.equal(
    await toolCall({ toolName: "read", input: { path: join(session, "result.json") } }, ctx),
    undefined,
    "ordinary report artifacts remain readable while the Gate is running"
  );
});

test("Reviewer runs once per Gate attempt and a user retry opens a new attempt", async (t) => {
  const handlers = new Map();
  qdmHarnessExtension({
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const inputHandler = handlers.get("input")[0];
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `reviewer-dispatch-cap-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const statePath = pipelineStatePath(session);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const startedAt = "2026-07-28T03:00:00.000Z";
  const attempt = {
    number: 1,
    retryOf: null,
    status: "running",
    startedAt,
    endedAt: null,
    failedAt: null,
    failureReason: null,
    executionIntervals: [{ startedAt, endedAt: null }],
    pauses: [],
    executionDurationMs: 0,
    pausedDurationMs: 0,
  };
  const stage = {
    id: "B4_REVIEW",
    label: "B4 Review",
    humanGate: "B4_REVIEW",
    internal: false,
    approvalRequired: true,
    status: "running",
    createdAt: startedAt,
    startedAt,
    completedAt: null,
    approvedAt: null,
    failedAt: null,
    failureReason: null,
    attempts: [attempt],
    waits: [],
    executionDurationMs: 0,
    gateWaitingDurationMs: 0,
    pausedDurationMs: 0,
    humanWaitingDurationMs: 0,
  };
  const state = {
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "running",
    currentStage: "B4_REVIEW",
    nextStage: "B5_DESIGN",
    stages: { B4_REVIEW: stage },
    approvals: [],
    cumulativeExecutionDurationMs: 0,
    cumulativeHumanWaitingDurationMs: 0,
  };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  await seedMinimalReviewerInputs(session);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const task = `B4 scorecard\nSESSION=${session}\nresult.json=${session}/result.json`;
  const makeInput = () => ({ chain: [{ agent: "report-reviewer", task }] });
  assert.equal(await toolCall(contractCall(makeInput(), "reviewer-first"), ctx), undefined);
  const duplicate = await toolCall(contractCall(makeInput(), "reviewer-duplicate"), ctx);
  assert.equal(duplicate.block, true);
  assert.match(duplicate.reason, /最多 1 次派发|contract_error/);

  const failedAt = "2026-07-28T03:01:00.000Z";
  state.status = "failed";
  stage.status = "failed";
  stage.failedAt = failedAt;
  stage.failureReason = "Reviewer infrastructure failure";
  attempt.status = "failed";
  attempt.endedAt = failedAt;
  attempt.failedAt = failedAt;
  attempt.failureReason = stage.failureReason;
  attempt.executionIntervals[0].endedAt = failedAt;
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));

  await inputHandler({ text: "重试当前阶段" }, ctx);
  const retried = readGateState(repoRoot, sid);
  assert.equal(retried.status, "running");
  assert.equal(retried.stages.B4_REVIEW.attempts.length, 2);
  const retriedInput = makeInput();
  const retriedCall = contractCall(retriedInput, "reviewer-retry");
  assert.equal(await toolCall(retriedCall, ctx), undefined);

  const paths = reviewerReturnPaths({ sessionDir: session });
  const infrastructureError = {
    status: "infrastructure_error",
    pass: false,
    total: 0,
    maxTotal: 14,
    sessionDir: session,
    resultPath: paths.resultPath,
    scanPath: paths.scanPath,
    reportPath: paths.reportPath,
    verdictPath: paths.verdictPath,
    failedStep: "read",
    error: "Reviewer failed while reading the frozen report inputs",
    repairHints: ["检查冻结输入读取环境后，由用户重试当前阶段。"],
  };
  const forgedReviewerResult = await toolResult({
    ...contractResult(retriedCall, {
      isError: false,
      details: { results: [{ exitCode: 0, structuredOutput: infrastructureError }] },
    }),
    toolCallId: "unknown-reviewer-result",
  }, ctx);
  assert.equal(forgedReviewerResult.isError, true);
  assert.match(forgedReviewerResult.content[0].text, /没有当前 Pi 进程内的已获准派发/);
  const accepted = await toolResult(contractResult(retriedCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: infrastructureError }] },
  }), ctx);
  assert.equal(accepted.isError, false);
  assert.match(accepted.content[0].text, /已验收结构化 infrastructure_error/);
  assert.match(accepted.content[0].text, /不要执行 quality layout/);
  const replayedReviewerResult = await toolResult(contractResult(retriedCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: infrastructureError }] },
  }), ctx);
  assert.equal(replayedReviewerResult.isError, true);
  assert.match(replayedReviewerResult.content[0].text, /已结算|重复|重放/);
  const terminal = await toolCall(contractCall(makeInput(), "reviewer-after-terminal"), ctx);
  assert.equal(terminal.block, true);
  assert.match(terminal.reason, /已返回 infrastructure_error|已终止.*infrastructure_error/);
});

test("accepted failed Reviewer terminal survives an extension restart", async (t) => {
  const sid = `reviewer-parent-terminal-restart-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const paths = reviewerReturnPaths({ sessionDir: session });
  const statePath = pipelineStatePath(session);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const state = {
    version: 1,
    producer: "stage-gate.mjs",
    mode: "auto",
    status: "running",
    currentStage: "B4_REVIEW",
    stages: {
      B4_REVIEW: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-07-28T03:30:00.000Z" }],
      },
    },
  };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persistedGateState(state, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  await seedMinimalReviewerInputs(session);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const task = `B4 scorecard\nSESSION=${session}\nresult.json=${paths.resultPath}`;
  const reviewerInput = { chain: [{ agent: "report-reviewer", task }] };
  const firstHandlers = registerHarnessExtension();
  const reviewerCall = contractCall(reviewerInput, "reviewer-failed-restart");
  assert.equal(
    await firstHandlers.get("tool_call")[0](reviewerCall, ctx),
    undefined
  );
  await writeFile(paths.reportPath, "# 质量审核\n\nR1 存在硬阻断，需修复。\n");
  const scores = Object.fromEntries(
    ["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, { score: 1 }])
  );
  const { verdict } = await writeVerdict(session, {
    pass: false,
    scores,
    hardBlockers: [{ code: "R1_HARD_BLOCKER" }],
    issues: [],
  });
  const failed = {
    status: "failed",
    pass: false,
    total: verdict.total,
    maxTotal: 14,
    sessionDir: session,
    resultPath: paths.resultPath,
    scanPath: paths.scanPath,
    reportPath: paths.reportPath,
    verdictPath: paths.verdictPath,
    repairHints: ["删除不可追溯数字后重新审核"],
    requiredRubrics: verdict.requiredRubrics,
    gateFailures: verdict.gateFailures,
  };
  const accepted = await firstHandlers.get("tool_result")[0](contractResult(reviewerCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: failed }] },
  }), ctx);
  assert.equal(accepted.isError, false);

  const restartedHandlers = registerHarnessExtension();
  const restartedToolCall = restartedHandlers.get("tool_call")[0];
  for (const event of [
    { toolName: "read", input: { path: paths.verdictPath } },
    {
      toolName: "bash",
      input: { command: `node .agents/pi/skills/html-report/scripts/assemble-report.mjs --session-dir "${session}"` },
    },
    {
      toolName: "bash",
      input: {
        command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish --session-dir "${session}" --stage B4_REVIEW --format text`,
      },
    },
  ]) {
    const blocked = await restartedToolCall(event, ctx);
    assert.equal(blocked?.block, true, `${event.toolName} must remain blocked after restart`);
  }

  const repairLogPath = join(session, "quality", "repair-log.json");
  assert.equal(
    await restartedToolCall(
      { toolName: "write", input: { path: repairLogPath, content: "{}" } },
      ctx
    ),
    undefined,
    "accepted failed permits only the exact repair log before Gate fail"
  );
  const wrongRepair = await restartedToolCall(
    { toolName: "write", input: { path: join(session, "quality", "other.json"), content: "{}" } },
    ctx
  );
  assert.equal(wrongRepair?.block, true);
  assert.equal(
    await restartedToolCall({
      toolName: "bash",
      input: {
        command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail --session-dir "${session}" --stage B4_REVIEW --reason "quality failed" --format text`,
      },
    }, ctx),
    undefined,
    "the current Session B4 fail remains the only allowed terminal command"
  );
});

test("Reviewer contract_error parent terminal survives an extension restart", async (t) => {
  const sid = `reviewer-contract-error-restart-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const paths = reviewerReturnPaths({ sessionDir: session });
  const statePath = pipelineStatePath(session);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persistedGateState({
    version: 1,
    producer: "stage-gate.mjs",
    mode: "auto",
    status: "running",
    currentStage: "B4_REVIEW",
    stages: {
      B4_REVIEW: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-07-28T03:45:00.000Z" }],
      },
    },
  }, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  await seedMinimalReviewerInputs(session);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const task = `B4 scorecard\nSESSION=${session}\nresult.json=${paths.resultPath}`;
  const reviewerInput = { chain: [{ agent: "report-reviewer", task }] };
  const firstHandlers = registerHarnessExtension();
  const reviewerCall = contractCall(reviewerInput, "reviewer-contract-error");
  assert.equal(
    await firstHandlers.get("tool_call")[0](reviewerCall, ctx),
    undefined
  );
  const rejected = await firstHandlers.get("tool_result")[0](contractResult(reviewerCall, {
    isError: false,
    details: { results: [{ exitCode: 1, error: "structured output schema validation failed" }] },
  }), ctx);
  assert.equal(rejected.isError, true);

  const restartedHandlers = registerHarnessExtension();
  const restartedToolCall = restartedHandlers.get("tool_call")[0];
  for (const event of [
    { toolName: "read", input: { path: paths.resultPath } },
    {
      toolName: "bash",
      input: { command: `node .agents/pi/skills/html-report/scripts/assemble-report.mjs --session-dir "${session}"` },
    },
    {
      toolName: "bash",
      input: {
        command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish --session-dir "${session}" --stage B4_REVIEW --format text`,
      },
    },
    { toolName: "write", input: { path: join(session, "quality", "repair-log.json"), content: "{}" } },
  ]) {
    const blocked = await restartedToolCall(event, ctx);
    assert.equal(blocked?.block, true, `${event.toolName} must remain blocked after contract_error restart`);
  }
  assert.equal(
    await restartedToolCall({
      toolName: "bash",
      input: {
        command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail --session-dir "${session}" --stage B4_REVIEW --reason "Reviewer contract rejected" --format text`,
      },
    }, ctx),
    undefined
  );
});

test("Researcher dispatch fingerprint is canonical, capped, and changes only with task substance", async (t) => {
  const handlers = new Map();
  qdmHarnessExtension({
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `researcher-dispatch-cap-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const taskObject = {
    id: "canonical-task",
    fromCardId: "card-1",
    goal: "找出毛利额最高的日期",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "Writer 数据已覆盖",
      requiredColumns: ["日期", "毛利额"],
      operations: [{ id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
    },
    evidenceGap: null,
  };
  const paths = researcherReturnPaths({ sessionDir: session, taskId: taskObject.id });
  const statePath = pipelineStatePath(session);
  await mkdir(dirname(paths.tasksPath), { recursive: true });
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persistedGateState({
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    status: "running",
    currentStage: "B3_RESEARCH",
    stages: {
      B3_RESEARCH: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-07-28T04:00:00.000Z" }],
      },
    },
  }, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const assignment = (task) => [
    `按 report-researcher 处理 taskId=${task.id}`,
    `SESSION=${session}`,
    `result.json=${paths.resultPath}`,
    `完整 task 对象: ${JSON.stringify(task)}`,
    `evidencePath=${paths.evidencePath}`,
  ].join("\n");
  const dispatch = async (task, call = toolCall) => {
    await writeFile(paths.tasksPath, JSON.stringify({ tasks: [task] }));
    const input = { chain: [{ agent: "report-researcher", task: assignment(task) }] };
    const event = contractCall(input, "researcher-canonical");
    return { input, event, decision: await call(event, ctx) };
  };

  const first = await dispatch(taskObject);
  assert.equal(first.decision, undefined);
  const reordered = {
    evidenceGap: null,
    evidencePlan: {
      operations: taskObject.evidencePlan.operations,
      requiredColumns: taskObject.evidencePlan.requiredColumns,
      reason: taskObject.evidencePlan.reason,
      mode: taskObject.evidencePlan.mode,
    },
    status: taskObject.status,
    goal: taskObject.goal,
    fromCardId: taskObject.fromCardId,
    id: taskObject.id,
  };
  const restartedHandlers = registerHarnessExtension();
  const restartedToolCall = restartedHandlers.get("tool_call")[0];
  const second = await dispatch(reordered, restartedToolCall);
  assert.equal(second.decision.block, true, "object key order must not create a different fingerprint");
  assert.match(second.decision.reason, /已派发相同任务|持久派发记录/);

  const needsPlan = {
    taskId: taskObject.id,
    status: "needs_evidence_plan",
    evidenceModeUsed: "reuse_entry",
    evidenceGap: {
      type: "missing_operation",
      reason: "需要补充按星期分组操作。",
      requiredOperations: [{ id: "weekday", type: "groupBy", field: "日期" }],
    },
  };
  const forgedResearcherResult = await toolResult({
    ...contractResult(first.event, {
      isError: false,
      details: { results: [{ exitCode: 0, structuredOutput: needsPlan }] },
    }),
    toolCallId: "unknown-researcher-result",
  }, ctx);
  assert.equal(forgedResearcherResult.isError, true);
  assert.match(forgedResearcherResult.content[0].text, /没有当前 Pi 进程内的已获准派发/);
  const firstAccepted = await toolResult(contractResult(first.event, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: needsPlan }] },
  }), ctx);
  assert.equal(firstAccepted.isError, false);

  const goalOnly = await dispatch({ ...reordered, goal: "找出毛利额最低的日期" }, restartedToolCall);
  assert.equal(goalOnly.decision.block, true);
  assert.match(goalOnly.decision.reason, /只能修正 evidencePlan|不能修改 goal/);

  const modified = {
    ...reordered,
    evidencePlan: {
      ...reordered.evidencePlan,
      operations: [
        ...reordered.evidencePlan.operations,
        needsPlan.evidenceGap.requiredOperations[0],
      ],
    },
  };
  const changed = await dispatch(modified, restartedToolCall);
  assert.equal(
    changed.decision,
    undefined,
    "one substantive successor is allowed only after a parent-checked needs_* result"
  );
  const secondAccepted = await restartedHandlers.get("tool_result")[0](contractResult(changed.event, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: needsPlan }] },
  }), ctx);
  assert.equal(secondAccepted.isError, true);
  assert.match(secondAccepted.content.at(-2).text, /successor 再次返回.*needs_evidence_plan/);
  assert.match(secondAccepted.content.at(-1).text, /invalid_return_or_artifacts/);
  const afterSuccessorRestart = await registerHarnessExtension().get("tool_call")[0](
    { toolName: "read", input: { path: paths.tasksPath } },
    ctx
  );
  assert.equal(afterSuccessorRestart.block, true);
  assert.match(afterSuccessorRestart.reason, /invalid_return_or_artifacts 已终止/);
  const terminal = await dispatch(modified);
  assert.equal(terminal.decision.block, true);
  assert.match(terminal.decision.reason, /invalid_return_or_artifacts 已终止/);

  const thirdMutation = await dispatch({ ...modified, goal: "再换一个目标绕过门禁" }, restartedToolCall);
  assert.equal(thirdMutation.decision.block, true);
  assert.match(thirdMutation.decision.reason, /invalid_return_or_artifacts 已终止/);
});

test("Researcher needs_new_query successor is bound to the checked gap", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `researcher-new-query-successor-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const task = {
    id: "new-query-successor",
    fromCardId: "card-1",
    goal: "分析现有毛利额",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "先复用 Writer 数据",
      requiredColumns: ["日期", "毛利额"],
      operations: [{ id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
    },
    evidenceGap: null,
    candidateIndicators: [],
    candidateDims: [],
  };
  const paths = researcherReturnPaths({ sessionDir: session, taskId: task.id });
  await mkdir(dirname(paths.tasksPath), { recursive: true });
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(paths.tasksPath, JSON.stringify({ tasks: [task] }));
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(runningGateState("B3_RESEARCH"), sid))
  );
  writeHtmlReportRuntimeContract(repoRoot, sid);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const dispatch = async (candidate) => {
    await writeFile(paths.tasksPath, JSON.stringify({ tasks: [candidate] }));
    const assignment = [
      `按 report-researcher 处理 taskId=${candidate.id}`,
      `SESSION=${session}`,
      `result.json=${paths.resultPath}`,
      `完整 task 对象: ${JSON.stringify(candidate)}`,
      `evidencePath=${paths.evidencePath}`,
    ].join("\n");
    const event = contractCall({ chain: [{ agent: "report-researcher", task: assignment }] }, "new-query-successor");
    return { event, decision: await toolCall(event, ctx) };
  };

  const first = await dispatch(task);
  assert.equal(first.decision, undefined);
  const gap = {
    type: "missing_indicator",
    reason: "需要新增客单价指标",
    requiredIndicators: ["客单价"],
    requiredDims: [],
  };
  const needsNewQuery = {
    taskId: task.id,
    status: "needs_new_query",
    evidenceModeUsed: "reuse_entry",
    evidenceGap: gap,
  };
  const accepted = await toolResult(contractResult(first.event, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: needsNewQuery }] },
  }), ctx);
  assert.equal(accepted.isError, false);

  const goalOnly = await dispatch({ ...task, goal: "任意替换目标" });
  assert.equal(goalOnly.decision.block, true);
  assert.match(goalOnly.decision.reason, /不能修改 goal|必须切换为 new_query/);

  const successor = {
    ...task,
    evidencePlan: { ...task.evidencePlan, mode: "new_query" },
    evidenceGap: gap,
    candidateIndicators: ["客单价"],
  };
  const corrected = await dispatch(successor);
  assert.equal(corrected.decision, undefined);
});

test("parent accepts Report Writer only through checked structured output and persisted entry/meta", async (t) => {
  const handlers = new Map();
  const pi = {
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  qdmHarnessExtension(pi);
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `writer-contract-${process.pid}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  t.after(async () => rm(session, { recursive: true, force: true }));
  const writerState = runningGateState("B2_WRITER");
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(writerState, sid))
  );
  writeHtmlReportRuntimeContract(repoRoot, sid);
  const task = `按 report-writer 处理 cardId=card-1\nSESSION=${session}\nresult.json=${session}/result.json`;

  const direct = await toolCall({ toolName: "subagent", input: { agent: "report-writer", task } }, ctx);
  assert.equal(direct.block, true);
  assert.match(direct.reason, /单步骤 chain|自由文本/);

  const missingSchemaInput = { chain: [{ agent: "report-writer", task }] };
  assert.equal(await toolCall(contractCall(missingSchemaInput, "writer-schema-attach"), ctx), undefined);
  assert.equal(missingSchemaInput.chain[0].outputSchema.oneOf.length, 2);
  assert.equal(missingSchemaInput.chain[0].outputSchema.oneOf[0].properties.cardId.const, "card-1");

  writerState.stages.B2_WRITER.attempts.push({
    number: 2,
    status: "running",
    startedAt: "2026-07-28T00:05:00.000Z",
  });
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(writerState, sid))
  );

  const input = {
    ...hostileContractOverrides(),
    async: true,
    turnBudget: { maxTurns: 99, graceTurns: 99 },
    toolBudget: { hard: 999 },
    timeoutMs: 1,
    maxRuntimeMs: 1,
    chain: [{
      ...hostileStepOverrides(),
      agent: "report-writer",
      task,
      outputSchema: { type: "object" },
      toolBudget: { hard: 999 },
      timeoutMs: 1,
    }],
  };
  const writerCall = contractCall(input, "writer-valid-result");
  assert.equal(await toolCall(writerCall, ctx), undefined);
  assertFixedContractEnvelope(input);
  assert.equal(input.chain[0].outputSchema.oneOf.length, 2, "caller schema must be replaced by the receipt contract");
  assert.equal(input.chain[0].outputSchema.oneOf[0].properties.cardId.const, "card-1");
  assert.equal(input.chain[0].outputSchema.oneOf[0].properties.dataPath.const, `${session}/data/cards/card-1/entry.json`);
  assert.equal(input.async, false, "Writer must remain a foreground run");
  assert.equal(input.clarify, false);
  assert.deepEqual(input.turnBudget, { maxTurns: 4, graceTurns: 1 });
  assert.equal(input.maxRuntimeMs, 720_000);
  assert.equal(input.timeoutMs, undefined);
  assert.equal(input.toolBudget, undefined);
  assert.deepEqual(input.chain[0].toolBudget, {
    hard: 3,
    block: "*",
  });
  assert.equal(input.chain[0].timeoutMs, undefined);

  const wrongSession = await toolCall(
    {
      toolName: "subagent",
      input: {
        chain: [{
          agent: "report-writer",
          task: task.replace(`${session}/result.json`, "/tmp/another-session/result.json"),
          outputSchema: { type: "object" },
        }],
      },
    },
    ctx
  );
  assert.equal(wrongSession.block, true);
  assert.match(wrongSession.reason, /当前 html-report session/);

  const valid = {
    cardId: "card-1",
    fetchStatus: "success",
    dataPath: `${session}/data/cards/card-1/entry.json`,
    metaPath: `${session}/data/cards/card-1/entry.meta.json`,
    rowCount: 1,
    rowsSha256: rowsSha256([{ 日期: "2026-07-01", 毛利额: 100 }]),
  };
  const writerRows = [{ 日期: "2026-07-01", 毛利额: 100 }];
  await mkdir(dirname(valid.dataPath), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    cards: [{ id: "card-1" }, { id: "card-2" }],
  }));
  await writeFile(valid.dataPath, JSON.stringify(writerRows));
  await writeFile(valid.metaPath, JSON.stringify({
    rowCount: writerRows.length,
    rowsSha256: rowsSha256(writerRows),
  }));
  await writeWriterCaptionArtifacts(dirname(valid.dataPath), "card-1");
  const accepted = await toolResult(
    contractResult(writerCall, {
      isError: false,
      details: { results: [writerAckChildResult(valid)] },
    }),
    ctx
  );
  assert.equal(accepted.isError, false);
  assert.match(accepted.content[0].text, /B2 Report Writer 已通过 ack_cli_data 回执验收/);
  assert.match(accepted.content[0].text, /"cardId":"card-1"/);
  assert.match(accepted.content[0].text, /尚待串行派发的 cardId：card-2/);
  assert.doesNotMatch(accepted.content[0].text, /phase-writer layout：passed/);

  const task2 = `按 report-writer 处理 cardId=card-2\nSESSION=${session}\nresult.json=${session}/result.json`;
  const input2 = { chain: [{ agent: "report-writer", task: task2 }] };
  const writerCall2 = contractCall(input2, "writer-second-card");
  assert.equal(await toolCall(writerCall2, ctx), undefined);
  const valid2 = {
    ...valid,
    cardId: "card-2",
    dataPath: `${session}/data/cards/card-2/entry.json`,
    metaPath: `${session}/data/cards/card-2/entry.meta.json`,
  };
  await mkdir(dirname(valid2.dataPath), { recursive: true });
  await writeFile(valid2.dataPath, JSON.stringify(writerRows));
  await writeFile(valid2.metaPath, JSON.stringify({
    rowCount: writerRows.length,
    rowsSha256: rowsSha256(writerRows),
  }));
  await writeWriterCaptionArtifacts(dirname(valid2.dataPath), "card-2");
  const accepted2 = await toolResult(
    contractResult(writerCall2, {
      isError: false,
      details: { results: [writerAckChildResult(valid2)] },
    }),
    ctx
  );
  assert.equal(accepted2.isError, false);
  assert.match(accepted2.content[0].text, /phase-writer layout：passed/);
  assert.match(accepted2.content[0].text, /状态：completed/);

  let writerAttempt = 2;
  const nextWriterCall = async (label) => {
    writerAttempt += 1;
    writerState.stages.B2_WRITER.attempts.push({
      number: writerAttempt,
      status: "running",
      startedAt: `2026-07-28T00:${String(writerAttempt).padStart(2, "0")}:00.000Z`,
    });
    await writeFile(
      pipelineStatePath(session),
      JSON.stringify(persistedGateState(writerState, sid))
    );
    const call = contractCall(input, label);
    assert.equal(await toolCall(call, ctx), undefined);
    return call;
  };
  const assertWriterGateFailed = (label) => {
    const failed = readGateState(repoRoot, sid);
    assert.equal(failed.currentStage, "B2_WRITER", `${label}: failure must remain bound to B2`);
    assert.equal(failed.status, "failed", `${label}: B2 must fail instead of remaining running`);
  };

  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    cards: [{ id: "card-1" }],
  }));

  const topLevelFailureCall = await nextWriterCall("writer-top-level-error");
  const topLevelFailure = await toolResult(contractResult(topLevelFailureCall, {
    isError: true,
    content: [{ type: "text", text: "child process failed before typed submit" }],
  }), ctx);
  assert.equal(topLevelFailure.isError, true);
  assert.match(topLevelFailure.content[0].text, /child process failed before typed submit/);
  assertWriterGateFailed("top-level isError");

  const nonzeroExitCall = await nextWriterCall("writer-nonzero-exit");
  const nonzeroExit = await toolResult(contractResult(nonzeroExitCall, {
    isError: false,
    details: { results: [{ exitCode: 17, error: "typed terminal crashed" }] },
  }), ctx);
  assert.equal(nonzeroExit.isError, true);
  assert.match(nonzeroExit.content[0].text, /exitCode=17.*typed terminal crashed/);
  assertWriterGateFailed("nonzero exitCode");

  await unlink(valid.metaPath);
  const missingArtifactCall = await nextWriterCall("writer-missing-artifact");
  const missingArtifacts = await toolResult(
    contractResult(missingArtifactCall, {
      isError: false,
      details: { results: [writerAckChildResult(valid)] },
    }),
    ctx
  );
  assert.equal(missingArtifacts.isError, true);
  assert.match(missingArtifacts.content[0].text, /entry\.json.*entry\.meta\.json.*不存在|rowCount\/rowsSha256/);
  assertWriterGateFailed("missing persisted artifacts");

  const badPathCall = await nextWriterCall("writer-bad-path");
  const bad = await toolResult(
    contractResult(badPathCall, {
      isError: false,
      details: { results: [writerAckChildResult({ ...valid, metaPath: "/tmp/forged.meta.json" })] },
    }),
    ctx
  );
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /metaPath/);
  assertWriterGateFailed("invalid structured return");

  const missingOutputCall = await nextWriterCall("writer-missing-output");
  const missing = await toolResult(contractResult(missingOutputCall, {
    isError: false,
    details: { results: [{ exitCode: 0 }] },
  }), ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /ack_cli_data 返回回执/);
  assertWriterGateFailed("missing ack receipt");

  await writeFile(valid.dataPath, JSON.stringify(writerRows));
  await writeFile(valid.metaPath, JSON.stringify({
    rowCount: writerRows.length,
    rowsSha256: rowsSha256(writerRows),
  }));
  await writeWriterCaptionArtifacts(dirname(valid.dataPath), "card-1");
  const transcriptPath = join(session, "writer-ack.transcript.jsonl");
  await writeFile(transcriptPath, `${JSON.stringify({
    recordType: "message",
    role: "toolResult",
    message: {
      role: "toolResult",
      toolName: "ack_cli_data",
      isError: false,
      content: [{ type: "text", text: JSON.stringify(valid, null, 2) }],
      details: valid,
    },
  })}\n`);
  const emptyOutputCall = await nextWriterCall("writer-empty-output-ack");
  const emptyAccepted = await toolResult(contractResult(emptyOutputCall, {
    isError: true,
    details: {
      results: [{
        exitCode: 1,
        error: "Subagent produced no output (possible model cold-start or empty response).",
        transcriptPath,
        finalOutput: "",
      }],
    },
  }), ctx);
  assert.equal(emptyAccepted.isError, false);
  assert.match(emptyAccepted.content[0].text, /ack_cli_data 回执验收/);
});

test("parent accepts Report Researcher only through a checked structured chain and evidence artifacts", async (t) => {
  const handlers = new Map();
  const pi = {
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  qdmHarnessExtension(pi);
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `researcher-contract-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const taskObject = {
    id: "drill-1",
    fromCardId: "card-1",
    goal: "找出毛利额最高的日期",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "Writer 数据已覆盖",
      requiredColumns: ["日期", "毛利额"],
      operations: [{ id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
    },
    evidenceGap: null,
  };
  const paths = researcherReturnPaths({ sessionDir: session, taskId: taskObject.id });
  await mkdir(dirname(paths.tasksPath), { recursive: true });
  await mkdir(dirname(paths.evidencePath), { recursive: true });
  await mkdir(dirname(paths.sectionPath), { recursive: true });
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  const researcherState = runningGateState("B3_RESEARCH");
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(researcherState, sid))
  );
  writeHtmlReportRuntimeContract(repoRoot, sid);
  await writeFile(paths.resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "card-1", query: {
      request: {
        metrics: ["profitAmt"],
        statisticPolicy: "SUMMARY",
        time: { startDate: "2026-07-01", endDate: "2026-07-02" },
        dimensions: [],
        filters: {},
      },
      comparisons: [],
    } }],
  }));
  await writeFile(paths.tasksPath, JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [taskObject] }));
  t.after(async () => rm(session, { recursive: true, force: true }));

  const task = [
    `按 report-researcher 处理 taskId=${taskObject.id}`,
    `SESSION=${session}`,
    `result.json=${paths.resultPath}`,
    `完整 task 对象: ${JSON.stringify(taskObject)}`,
    "用户问题: 哪一天毛利最好？",
    `evidencePath=${paths.evidencePath}`,
  ].join("\n");
  assert.equal(parseResearcherAssignment(task, { projectRoot: repoRoot }).ok, true);

  const direct = await toolCall({ toolName: "subagent", input: { agent: "report-researcher", task } }, ctx);
  assert.equal(direct.block, true);
  assert.match(direct.reason, /单步骤 chain/);

  const input = {
    ...hostileContractOverrides(),
    async: true,
    turnBudget: { maxTurns: 99, graceTurns: 99 },
    timeoutMs: 1,
    chain: [{
      ...hostileStepOverrides(),
      agent: "report-researcher",
      task,
      outputSchema: { type: "object" },
      toolBudget: { hard: 99 },
    }],
  };
  const researcherCall = contractCall(input, "researcher-valid-result");
  assert.equal(await toolCall(researcherCall, ctx), undefined);
  assertFixedContractEnvelope(input);
  assert.equal(input.async, false);
  assert.equal(input.clarify, false);
  assert.deepEqual(input.turnBudget, { maxTurns: 7, graceTurns: 1 });
  assert.equal(input.maxRuntimeMs, 240_000);
  assert.equal(input.timeoutMs, undefined);
  assert.equal(input.chain[0].outputSchema.oneOf[0].properties.taskId.const, "drill-1");
  assert.equal(input.chain[0].outputSchema.oneOf[0].properties.evidencePath.const, paths.evidencePath);
  assert.deepEqual(input.chain[0].toolBudget, {
    hard: 3,
    block: ["read", "write", "bash", "submit_research_findings"],
  });

  const valid = {
    taskId: "drill-1",
    status: "ok",
    evidenceModeUsed: "reuse_entry",
    evidencePath: paths.evidencePath,
    sectionPath: paths.sectionPath,
    summaryPath: paths.summaryPath,
    summary: "2026-07-05 的毛利额为 3470.74。",
    noData: false,
    evidencePointers: ["/views/top"],
    selfCheck: {
      modeCompliant: true,
      evidenceTraceable: true,
      hasContrastOrBreakdown: true,
      answersGoal: true,
      queryJustified: null,
    },
    suggestedDeeper: [],
  };
  await writeFile(paths.evidencePath, JSON.stringify({
    taskId: "drill-1",
    evidenceMode: "reuse_entry",
    source: { empty: false, queryCoverage: { startDate: "2026-07-01" } },
    views: { top: { rows: [{ row: { 日期: "2026-07-05", 毛利额: 3470.74 } }] } },
  }));
  await writeFile(paths.sectionPath, "# 结论\n\n2026-07-05 的毛利额为 3470.74。\n\n`/views/top`\n");
  await writeFile(paths.summaryPath, JSON.stringify(valid));

  const accepted = await toolResult(contractResult(researcherCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: valid }] },
  }), ctx);
  assert.equal(accepted.isError, false);
  assert.match(accepted.content[0].text, /B3 Report Researcher 已通过结构化返回与证据产物契约验证/);
  assert.equal(
    await toolCall({ toolName: "read", input: { path: paths.tasksPath } }, ctx),
    undefined,
    "checked status=ok must keep normal B3 parent merge tools open"
  );

  let researcherAttempt = 1;
  const nextResearcherCall = async (label) => {
    researcherAttempt += 1;
    researcherState.stages.B3_RESEARCH.attempts.push({
      number: researcherAttempt,
      status: "running",
      startedAt: `2026-07-28T00:${String(researcherAttempt).padStart(2, "0")}:00.000Z`,
    });
    await writeFile(
      pipelineStatePath(session),
      JSON.stringify(persistedGateState(researcherState, sid))
    );
    const call = contractCall(input, label);
    assert.equal(await toolCall(call, ctx), undefined);
    return call;
  };

  const forged = { ...valid, summaryPath: join(session, "analysis", "sections", "forged.json") };
  const forgedCall = await nextResearcherCall("researcher-forged-path");
  const rejected = await toolResult(contractResult(forgedCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: forged }] },
  }), ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /summaryPath/);

  const rounded = {
    ...valid,
    summary: "高客单组客数均值为 470。",
    evidencePointers: ["/views/high-ticket-stats"],
  };
  await writeFile(paths.evidencePath, JSON.stringify({
    taskId: "drill-1",
    evidenceMode: "reuse_entry",
    source: { empty: false, queryCoverage: { startDate: "2026-07-01" } },
    views: { "high-ticket-stats": { mean: 469.8 } },
  }));
  await writeFile(
    paths.sectionPath,
    "# 结论\n\n高客单组客数均值为 470。\n\n分组 | 客数均值\n--- | ---:\n高客单 | 470\n\n`/views/high-ticket-stats`\n"
  );
  await writeFile(paths.summaryPath, JSON.stringify(rounded));
  const roundedCall = await nextResearcherCall("researcher-rounded-output");
  const ungrounded = await toolResult(contractResult(roundedCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: rounded }] },
  }), ctx);
  assert.equal(ungrounded.isError, true);
  assert.match(ungrounded.content[0].text, /Markdown table/);
  assert.match(ungrounded.content[0].text, /470/);
});

test("parent normalizes only the observed Chinese evidencePath label drift before strict validation", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const sid = `researcher-evidence-label-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const taskObject = {
    id: "drill-label",
    analysisContractVersion: 1,
    fromCardId: "card-1",
    goal: "找出毛利额最高的日期",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "Writer 数据已覆盖",
      requiredColumns: ["日期", "毛利额"],
      operations: [
        { id: "top-row", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] },
        { id: "top", type: "compareTopN", sortBy: "毛利额", count: 1, fields: ["日期", "毛利额"] },
      ],
    },
    analysisRequirements: [{
      id: "compare-pattern",
      question: "样本对比呈现什么模式？",
      evidenceViewIds: ["top"],
      targetRubric: ["R3", "R5"],
      minScore: 2,
    }],
    evidenceGap: null,
  };
  const paths = researcherReturnPaths({ sessionDir: session, taskId: taskObject.id });
  await mkdir(dirname(paths.tasksPath), { recursive: true });
  await mkdir(dirname(pipelineStatePath(session)), { recursive: true });
  await writeFile(paths.tasksPath, JSON.stringify({ tasks: [taskObject] }));
  await writeFile(
    pipelineStatePath(session),
    JSON.stringify(persistedGateState(runningGateState("B3_RESEARCH"), sid))
  );
  writeHtmlReportRuntimeContract(repoRoot, sid);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const assignment = (evidenceLine) => [
    `按 report-researcher 处理 taskId=${taskObject.id}`,
    `SESSION=${session}`,
    `result.json=${paths.resultPath}`,
    `完整 task 对象: ${JSON.stringify(taskObject)}`,
    evidenceLine,
  ].join("\n");

  const input = {
    chain: [{
      agent: "report-researcher",
      task: assignment(`证据路径: ${paths.evidencePath}`),
    }],
  };
  const accepted = await toolCall(contractCall(input, "researcher-chinese-evidence-label"), ctx);
  assert.equal(accepted, undefined);
  assert.equal(
    input.chain[0].task.split("\n").includes(`evidencePath=${paths.evidencePath}`),
    true
  );
  assert.doesNotMatch(input.chain[0].task, /^证据路径:/m);
  assert.doesNotMatch(input.chain[0].task, /SUMMARY ARTIFACT RULE \(machine contract\)/);
  assert.match(input.chain[0].task, /TYPED FINDINGS SUBMIT RULE \(machine contract\)/);
  assert.match(
    input.chain[0].task,
    /Exact requirement bindings: \{"compare-pattern":\{"evidencePointers":\["\/views\/top"\]\}\}/
  );
  assert.match(input.chain[0].task, /submit_research_findings exactly once/);
  assert.match(
    input.chain[0].task,
    /jointQuantileBins[\s\S]*copy \/decisionBrief\.recommendedClaim verbatim[\s\S]*do not preface, append, redraft/
  );
  assert.match(input.chain[0].task, /Copy numeric values exactly[\s\S]*never calculate, round, derive/);
  assert.match(input.chain[0].task, /one compact finding per requirement/);
  assert.match(input.chain[0].task, /captures structured output, and terminates/);
  assert.match(input.chain[0].task, /Do not call write afterward/);
  assert.match(
    input.chain[0].task,
    /ranking=two ranked facts[\s\S]*comparison=both sides[\s\S]*joint_tradeoff=the exact recommendedClaim/
  );
  assert.match(input.chain[0].task, /answer-first business prose[\s\S]*global optimum[\s\S]*low-support winner/);
  assert.match(
    input.chain[0].task,
    /Keep suggestedDeeper=\[\][\s\S]*concrete unresolved gap/
  );
  assert.match(input.chain[0].task, /Any submit error consumes the attempt/);
  const injectedContract = input.chain[0].task.split("TYPED FINDINGS SUBMIT RULE (machine contract):")[1];
  assert.ok(injectedContract.length < 2200, "the per-task machine rule must stay compact");
  assert.doesNotMatch(injectedContract, /evaluation\.status\/support\/stability|bestSupportedCandidates/);
  assert.doesNotMatch(input.chain[0].task, /EXACT COMPACT EVIDENCE POINTERS/);
  assert.doesNotMatch(input.chain[0].task, /Fixed safe prose shape only/);
  assert.doesNotMatch(input.chain[0].task, /exactly two bullets|exactly two sentences/);
  assert.equal(input.chain[0].outputSchema.oneOf[0].properties.evidencePath.const, paths.evidencePath);
  assert.equal(input.chain[0].outputSchema.oneOf[0].properties.evidencePointers.maxItems, 24);
  assert.deepEqual(input.chain[0].toolBudget, {
    hard: 3,
    block: ["read", "write", "bash", "submit_research_findings"],
  });
  assert.ok(input.chain[0].outputSchema.oneOf[0].required.includes("findings"));
  assert.deepEqual(
    input.chain[0].outputSchema.oneOf[0].properties.findings.items.properties.requirementId.enum,
    ["compare-pattern"]
  );

  const jointContract = ensureResearcherCitationCommitRule(
    "joint assignment",
    [{
      id: "tradeoff",
      capability: "joint_tradeoff",
      evidenceViewIds: ["joint-view"],
    }],
    [{ id: "joint-view", type: "jointQuantileBins" }]
  );
  assert.match(
    jointContract,
    /"tradeoff":\{"evidencePointers":\["\/views\/joint-view\/decisionBrief"\],"capability":"joint_tradeoff"\}/
  );

  const equalsAssignment = assignment(`证据路径=${paths.evidencePath}`);
  assert.equal(
    normalizeResearcherEvidencePathLabel(equalsAssignment),
    assignment(`evidencePath=${paths.evidencePath}`)
  );
  assert.equal(
    normalizeResearcherEvidencePathLabel(assignment(`证据路径 = ${paths.evidencePath}`)),
    assignment(`证据路径 = ${paths.evidencePath}`),
    "the unobserved spaced-equals variant must remain rejected"
  );

  const invalidHandlers = registerHarnessExtension();
  const invalidToolCall = invalidHandlers.get("tool_call")[0];
  const relativeInput = {
    chain: [{
      agent: "report-researcher",
      task: assignment("证据路径: analysis/evidence/drill-label.json"),
    }],
  };
  const rejectedRelative = await invalidToolCall(
    contractCall(relativeInput, "researcher-relative-chinese-evidence-label"),
    ctx
  );
  assert.equal(rejectedRelative.block, true);
  assert.match(rejectedRelative.reason, /规范绝对路径/);

  const unsupportedInput = {
    chain: [{
      agent: "report-researcher",
      task: assignment(`证据路径 = ${paths.evidencePath}`),
    }],
  };
  const rejectedUnsupported = await invalidToolCall(
    contractCall(unsupportedInput, "researcher-unsupported-evidence-label"),
    ctx
  );
  assert.equal(rejectedUnsupported.block, true);
  assert.match(rejectedUnsupported.reason, /必须包含 taskId、SESSION、result\.json 与 evidencePath/);
});

test("B4 parent scan hard issues fail the Gate before Reviewer dispatch", async (t) => {
  const handlers = registerHarnessExtension();
  const toolCall = handlers.get("tool_call")[0];
  const sid = `reviewer-hard-preflight-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const statePath = pipelineStatePath(session);
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const state = persistedGateState({
    version: 1,
    producer: "stage-gate.mjs",
    mode: "auto",
    status: "running",
    currentStage: "B4_REVIEW",
    nextStage: "B5_DESIGN",
    stages: {
      B4_REVIEW: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-08-12T06:00:00.000Z" }],
      },
    },
  }, sid);
  await mkdir(dirname(statePath), { recursive: true });
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 0,
    maxRounds: 2,
    tasks: [],
  }));
  await writeFile(
    join(session, "analysis", "main.md"),
    "# 质量门禁\n\n报告声称销售额达到 888888 元，但没有任何行级数据支持。\n"
  );
  await assembleReport(session);
  t.after(async () => rm(session, { recursive: true, force: true }));

  const input = {
    chain: [{
      agent: "report-reviewer",
      task: `B4 scorecard\nSESSION=${session}\nresult.json=${session}/result.json`,
      outputSchema: { type: "object" },
    }],
  };
  const decision = await toolCall(contractCall(input, "reviewer-hard-preflight"), ctx);
  assert.equal(decision.block, true);
  assert.match(decision.reason, /quality-scan hard > 0.*不得派发 Reviewer/);
  const after = readGateState(repoRoot, sid);
  assert.equal(after.status, "failed");
  assert.equal(after.stages.B4_REVIEW.status, "failed");
  const repairLog = JSON.parse(await readFile(join(session, "quality", "repair-log.json"), "utf8"));
  assert.equal(repairLog.maxRepairRounds, 2);
  assert.equal(repairLog.rounds.length, 1);
  assert.ok(repairLog.rounds[0].scan.hard > 0);
  await assert.rejects(
    () => readdir(join(session, "debug", "contract-runtime", "dispatches")),
    /ENOENT/
  );
});

test("parent binds Report Reviewer structured status to the stamped verdict", async (t) => {
  const handlers = new Map();
  const pi = {
    cwd: repoRoot,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  qdmHarnessExtension(pi);
  const toolCall = handlers.get("tool_call")[0];
  const toolResult = handlers.get("tool_result")[0];
  const sid = `reviewer-contract-${process.pid}-${Date.now()}`;
  const session = htmlReportSessionDir(repoRoot, sid);
  const paths = reviewerReturnPaths({ sessionDir: session });
  const ctx = { sessionManager: { getSessionId: () => sid } };
  const statePath = pipelineStatePath(session);
  await mkdir(dirname(paths.scanPath), { recursive: true });
  await mkdir(join(session, "analysis"), { recursive: true });
  await mkdir(dirname(statePath), { recursive: true });
  const reviewerState = {
    version: 1,
    producer: "stage-gate.mjs",
    mode: "auto",
    status: "running",
    currentStage: "B4_REVIEW",
    stages: {
      B4_REVIEW: {
        status: "running",
        attempts: [{ number: 1, status: "running", startedAt: "2026-07-28T05:00:00.000Z" }],
      },
    },
  };
  await writeFile(statePath, JSON.stringify(persistedGateState(reviewerState, sid)));
  writeHtmlReportRuntimeContract(repoRoot, sid);
  await writeFile(paths.resultPath, JSON.stringify({ status: "confirmed", cards: [] }));
  await writeFile(join(session, "analysis", "main.md"), "# 报告结论\n\n当前证据不足，需修复后重新审核。\n");
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 0,
    maxRounds: 2,
    tasks: [],
  }));
  await assembleReport(session);
  const { scan } = await runQualityScan(session);
  assert.equal(scan.hardIssues.length, 0, JSON.stringify(scan.hardIssues));
  await writeFile(paths.reportPath, "# 质量审核\n\n存在不可追溯数字。\n");
  const reviewerScores = Object.fromEntries(
    ["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, { score: id === "R1" ? 2 : 1 }])
  );
  t.after(async () => rm(session, { recursive: true, force: true }));

  const task = `B4 scorecard for SESSION=${session}\nresult.json=${paths.resultPath}\nrun fixed quality workflow`;
  const direct = await toolCall({ toolName: "subagent", input: { agent: "report-reviewer", task } }, ctx);
  assert.equal(direct.block, true);
  assert.match(direct.reason, /单步骤 chain/);

  const input = {
    ...hostileContractOverrides(),
    async: true,
    timeoutMs: 1,
    chain: [{
      ...hostileStepOverrides(),
      agent: "report-reviewer",
      task,
      outputSchema: { type: "object" },
      toolBudget: { hard: 99 },
    }],
  };
  const reviewerCall = contractCall(input, "reviewer-valid-failed");
  assert.equal(await toolCall(reviewerCall, ctx), undefined);
  const { verdict } = await writeVerdict(session, {
    pass: true,
    scores: reviewerScores,
    hardBlockers: [{ code: "DATA_UNTRACEABLE" }],
    issues: [],
  });
  assert.equal(verdict.pass, false);
  assertFixedContractEnvelope(input, { stepModel: "qdm-market/deepseek-v4-flash" });
  assert.equal(input.async, false);
  assert.equal(input.clarify, false);
  assert.deepEqual(input.turnBudget, { maxTurns: 4, graceTurns: 1 });
  assert.equal(input.maxRuntimeMs, 150_000);
  assert.equal(input.timeoutMs, undefined);
  assert.match(input.chain[0].task, /REVIEWER FIRST BATCH RULE \(machine contract\)/);
  assert.match(
    input.chain[0].task,
    /PARENT QUALITY SCAN: passed with hardIssues=0/
  );
  assert.match(input.chain[0].task, /call submit_review_scorecard once/);
  assert.match(input.chain[0].task, /captures the attached structured output and terminates the child/);
  assert.match(input.chain[0].task, /do not call structured_output afterward/);
  assert.match(input.chain[0].task, /Never hand-write verdict\.draft\.json, verdict\.json, or quality\/report\.md/);
  assert.match(input.chain[0].task, /first and only read batch contains result\.json.*quality\/scan\.json/);
  assert.match(input.chain[0].task, new RegExp(`Exact rubric read path: ${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/docs\/html-report-quality-rubric\\.md`));
  assert.match(input.chain[0].task, /never prefix SESSION or resolve it as SESSION\/docs/);
  assert.match(input.chain[0].task, /Base pass formula: no scan\/draft hard issues/);
  assert.match(input.chain[0].task, /additional minimum-score gates derived only from status=done Researcher task/);
  assert.match(input.chain[0].task, /never inflate a rubric score merely to satisfy a task target/);
  assert.match(input.chain[0].task, /auditable requiredRubrics\/gateFailures/);
  assert.equal(input.chain[0].outputSchema.oneOf[1].properties.status.const, "failed");
  assert.equal(input.chain[0].outputSchema.oneOf[1].properties.pass.const, false);
  assert.deepEqual(input.chain[0].toolBudget, {
    hard: 6,
    block: ["read", "submit_review_scorecard"],
  });

  const failed = {
    status: "failed",
    pass: false,
    total: verdict.total,
    maxTotal: 14,
    sessionDir: session,
    resultPath: paths.resultPath,
    scanPath: paths.scanPath,
    reportPath: paths.reportPath,
    verdictPath: paths.verdictPath,
    repairHints: ["修复不可追溯数字后重新审核"],
    requiredRubrics: verdict.requiredRubrics,
    gateFailures: verdict.gateFailures,
  };
  const accepted = await toolResult(contractResult(reviewerCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: failed }] },
  }), ctx);
  assert.equal(accepted.isError, false);
  assert.match(accepted.content[0].text, /审核结论：failed/);
  assert.match(accepted.content[0].text, /"diagnosis"/);
  assert.match(accepted.content[0].text, /DATA_UNTRACEABLE/);

  const duplicateVerdictRead = await toolCall(
    { toolCallId: "post-review-read", toolName: "read", input: { path: paths.verdictPath } },
    ctx
  );
  assert.equal(duplicateVerdictRead.block, true);
  assert.match(duplicateVerdictRead.reason, /唯一可用的审核与诊断 JSON|禁止再读目录/);
  const duplicateAssemble = await toolCall(
    {
      toolCallId: "post-review-assemble",
      toolName: "bash",
      input: { command: `node .agents/pi/skills/html-report/scripts/assemble-report.mjs --session-dir "${session}"` },
    },
    ctx
  );
  assert.equal(duplicateAssemble.block, true);
  assert.match(duplicateAssemble.reason, /禁止重复 assemble\/layout/);
  assert.equal(
    await toolCall(
      {
        toolCallId: "post-review-repair-log",
        toolName: "write",
        input: { path: join(session, "quality", "repair-log.json"), content: "{}" },
      },
      ctx
    ),
    undefined,
    "normal failed verdict may write only the Editor repair log before failing the Gate"
  );

  let reviewerAttempt = 1;
  const nextReviewerCall = async (label) => {
    reviewerAttempt += 1;
    reviewerState.stages.B4_REVIEW.attempts.push({
      number: reviewerAttempt,
      status: "running",
      startedAt: `2026-07-28T05:${String(reviewerAttempt).padStart(2, "0")}:00.000Z`,
    });
    await writeFile(statePath, JSON.stringify(persistedGateState(reviewerState, sid)));
    const call = contractCall(input, label);
    assert.equal(await toolCall(call, ctx), undefined);
    return call;
  };

  const fakeSuccess = { ...failed, status: "passed", pass: true };
  const fakeSuccessCall = await nextReviewerCall("reviewer-fake-success");
  const rejected = await toolResult(contractResult(fakeSuccessCall, {
    isError: false,
    details: { results: [{ exitCode: 0, structuredOutput: fakeSuccess }] },
  }), ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /pass.*verdict|status/i);

  const rejectedFinish = await toolCall({
    toolName: "bash",
    input: {
      command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs finish --session-dir "${session}" --stage B4_REVIEW --format text`,
    },
  }, ctx);
  assert.equal(rejectedFinish.block, true);
  assert.match(rejectedFinish.reason, /Reviewer 已返回 (?:failed|contract_error).*当前 SESSION\/B4_REVIEW.*stage-gate fail/);

  const crossSessionFail = await toolCall({
    toolName: "bash",
    input: {
      command: "node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail --session-dir /tmp/not-current-session --stage B4_REVIEW --reason rejected --format text",
    },
  }, ctx);
  assert.equal(crossSessionFail.block, true);
  assert.match(crossSessionFail.reason, /禁止跨 Session 收尾/);

  const rejectedFail = await toolCall({
    toolName: "bash",
    input: {
      command: `node .agents/pi/skills/html-report/scripts/stage-gate.mjs fail --session-dir "${session}" --stage B4_REVIEW --reason "Reviewer contract rejected" --format text`,
    },
  }, ctx);
  assert.equal(rejectedFail, undefined, "rejected Reviewer output may only fail the current Gate");
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
  await writeFile(join(root, changedSource), "new runtime after Session creation\n");

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
  const loadedSourceContent = `loaded:${changedSource}\n`;
  await writeFile(join(root, changedSource), loadedSourceContent);
  assert.deepEqual(
    await input({ text: "/skill: html-report 同内容重写" }, context("same-content-session")),
    { action: "continue" },
    "rewriting identical bytes must not create a false stale-runtime result"
  );
  await writeFile(join(root, changedSource), "changed after Pi loaded\n");

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

  await writeFile(join(root, changedSource), loadedSourceContent);
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
  await unlink(join(root, changedSource));
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
  assert.equal(status.state.currentStage, "B0_PREFLIGHT");
  assert.equal(status.state.status, "running");

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
  assert.doesNotMatch(injected.systemPrompt, /下一条 assistant action.*subagent/);
  assert.equal(
    await readFile(join(session, "recommendations.json"), "utf8").then(() => "exists").catch(() => "missing"),
    "missing"
  );
  const question = JSON.parse(await readFile(join(session, "debug", "a-config-question.json"), "utf8"));
  assert.equal(question.userQuestion, "分析任意指标");
  const marker = JSON.parse(await readFile(join(session, "debug", "metric-cli-ui.json"), "utf8"));
  assert.equal(marker.producer, "open-metric-cli-ui.mjs");

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
  assert.deepEqual(await input({ text: "继续" }, parentCtx), { action: "handled" });
  let gated = await pipelineStatus(session);
  assert.equal(gated.state.currentStage, "B0_PREFLIGHT");
  assert.equal(gated.state.status, "awaiting_approval");
  assert.equal(runtimeBridge.requests.length, 2, "fixed A_CONFIG and B0 each run one automatic list");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].message.customType, HTML_REPORT_GATE_CUSTOM_TYPE);
  assert.equal(sentMessages[0].message.content, formatGateMessage(gated.state, { stageId: "B0_PREFLIGHT" }));
  assert.equal(sentMessages[0].message.display, true);
  assert.deepEqual(sentMessages[0].options, { triggerTurn: false });
  assert.deepEqual(sentMessages[0].message.details, {
    version: 1,
    producer: "qdm-harness",
    sessionId: sid,
    stageId: "B0_PREFLIGHT",
    currentStage: "B0_PREFLIGHT",
    pipelineStatus: "awaiting_approval",
    stageStatus: "awaiting_approval",
    attempt: {
      number: 1,
      startedAt: gated.state.stages.B0_PREFLIGHT.attempts.at(-1).startedAt,
    },
  });

  assert.deepEqual(await input({ text: "继续" }, parentCtx), { action: "continue" });
  gated = await pipelineStatus(session);
  assert.equal(gated.state.currentStage, "B2_WRITER");
  assert.equal(gated.state.status, "running");
  assert.equal(sentMessages.length, 1, "B0 approval must not replay the consumed A_CONFIG message");

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
  await handlers.get("before_agent_start")[0]({
    prompt: '<skill name="html-report"></skill>验证 B0 失败回显',
    systemPrompt: "base",
    messages: [],
  }, ctx);
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
