import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_PERFORMANCE_CONFIG_PATH,
  analyzeHtmlReportRun,
  analyzeHtmlReportRunDirectory,
  renderHtmlReportRunMarkdown,
} from "../scripts/analyze-html-report-run.mjs";
import {
  DEFAULT_CONFIG_PATH as CONTROLLER_CONFIG_PATH,
  inspectRpcStageRecords,
} from "../scripts/html-report-self-test.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(new URL("../scripts/analyze-html-report-run.mjs", import.meta.url).pathname);
const configPath = resolve(new URL("../html-report-self-test.config.json", import.meta.url).pathname);

function fixture(baseDir) {
  return {
    baseDir,
    generatedAt: "2026-07-29T03:05:00.000Z",
    performanceConfig: {
      performanceBudgets: {
        B2_WRITER: { softMs: 60000, hardMs: 120000 },
        B3_RESEARCH: { softMs: 75000, hardMs: 150000 },
      },
    },
    run: {
      sessionId: "session-1", status: "failed", stoppedStage: "B3_RESEARCH",
      startedAt: "2026-07-29T03:00:00.000Z", endedAt: "2026-07-29T03:05:00.000Z",
      piVersion: "0.81.1", provider: "openai", modelId: "gpt-test", thinkingLevel: "high",
      gitHead: "abc123", workspaceFingerprint: "sha256:test",
      originalPrompt: "/skill: html-report 固定问题", effectivePrompt: "/skill:html-report 固定问题",
      sessionFile: "/tmp/pi-session.jsonl", htmlReportSessionDir: "/tmp/html-report-session",
    },
    pipelineState: {
      sessionId: "session-1", status: "failed", currentStage: "B3_RESEARCH",
      stages: {
        B2_WRITER: { status: "completed", executionDurationMs: 50000, completedAt: "2026-07-29T03:01:00.000Z", attempts: [{ number: 1 }] },
        B3_RESEARCH: { status: "failed", executionDurationMs: 80000, failedAt: "2026-07-29T03:04:30.000Z", failureReason: "missing_structured_output", attempts: [{ number: 1 }] },
      },
    },
    checkpoints: [
      { stageId: "B2_WRITER", observedAt: "2026-07-29T03:01:00.000Z", layout: { status: "pass", phase: "writer" } },
      { stageId: "B3_RESEARCH", observedAt: "2026-07-29T03:04:30.000Z", layout: { status: "fail", phase: "explore", reason: "summary missing" } },
    ],
    stageObservations: [
      { stageId: "B2_WRITER", rpcStartIndex: 0, rpcEndIndex: 2 },
      { stageId: "B3_RESEARCH", rpcStartIndex: 3, rpcEndIndex: 7 },
    ],
    rpcEvents: [
      { type: "tool_execution_start", toolCallId: "w1", toolName: "subagent", args: { chain: [{ agent: "report-writer" }] }, timestamp: "2026-07-29T03:00:05.000Z" },
      { type: "tool_execution_end", toolCallId: "w1", durationMs: 30000, timestamp: "2026-07-29T03:00:35.000Z", details: { results: [{ transcriptPath: "/tmp/writer.jsonl" }] } },
      { type: "tool_execution_end", toolName: "ack_cli_data", durationMs: 10000, timestamp: "2026-07-29T03:00:50.000Z" },
      { type: "tool_execution_start", toolCallId: "r1", toolName: "subagent", input: { chain: [{ agent: "report-researcher" }] }, timestamp: "2026-07-29T03:03:05.000Z" },
      { type: "auto_retry_start", timestamp: "2026-07-29T03:03:20.000Z" },
      { receivedAt: "2026-07-29T03:03:30.000Z", event: { type: "extension_error", error: "guard contract exploded" } },
      { type: "tool_execution_end", toolCallId: "r1", toolName: "subagent", input: { chain: [{ agent: "report-researcher" }] }, durationMs: 60000, isError: true, error: "missing_structured_output", timestamp: "2026-07-29T03:04:05.000Z" },
      { type: "message_end", message: { role: "assistant", stopReason: "error" }, timestamp: "2026-07-29T03:04:10.000Z" },
    ],
    paths: {
      runMetadata: "run.json", pipelineState: "pipeline.json", rpcLog: "rpc.jsonl",
      checkpointsDir: "checkpoints", performanceConfig: configPath,
      reportJson: "self-test-report.json", reportMarkdown: "self-test-report.md",
    },
  };
}

const transcriptAssistantTool = (timestamp, name, argumentsValue = {}, id = `${name}-${timestamp}`) => ({
  recordType: "message",
  timestamp,
  role: "assistant",
  message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: argumentsValue }] },
});
const transcriptToolBoundary = (recordType, timestamp, toolName) => ({ recordType, timestamp, toolName });
const transcriptToolResult = (timestamp, toolName, { isError = false, text = "ok" } = {}) => ({
  recordType: "message",
  timestamp,
  role: "toolResult",
  text,
  message: { role: "toolResult", toolName, isError, content: [{ type: "text", text }] },
});

function b5TranscriptFixture(baseDir, transcriptPath, records, {
  executionDurationMs = 100000,
  subagentDurationMs = 80000,
} = {}) {
  const input = fixture(baseDir);
  input.run.status = "pass";
  input.run.stoppedStage = "B5_DESIGN";
  input.run.startedAt = "2026-07-29T08:29:50.000Z";
  input.run.endedAt = "2026-07-29T08:33:10.000Z";
  input.pipelineState = {
    sessionId: "session-1",
    status: "completed",
    currentStage: "B5_DESIGN",
    stages: {
      B5_DESIGN: {
        status: "completed",
        startedAt: "2026-07-29T08:30:00.000Z",
        completedAt: "2026-07-29T08:33:10.000Z",
        executionDurationMs,
        attempts: [{ number: 1 }],
      },
    },
  };
  input.checkpoints = [{
    stageId: "B5_DESIGN",
    status: "completed",
    observedAt: "2026-07-29T08:33:10.000Z",
    layout: { status: "pass", phase: "html" },
  }];
  input.stageObservations = [{ stageId: "B5_DESIGN", rpcStartIndex: 0, rpcEndIndex: 1 }];
  input.rpcEvents = [
    {
      type: "tool_execution_start",
      toolCallId: "designer-1",
      toolName: "subagent",
      args: { chain: [{ agent: "report-designer" }] },
      timestamp: "2026-07-29T08:30:00.000Z",
    },
    {
      type: "tool_execution_end",
      toolCallId: "designer-1",
      toolName: "subagent",
      durationMs: subagentDurationMs,
      timestamp: "2026-07-29T08:32:50.000Z",
      result: { details: { results: [{ agent: "report-designer", exitCode: 0, transcriptPath }] } },
    },
  ];
  input.performanceConfig.performanceBudgets.B5_DESIGN = { softMs: 180000, hardMs: 360000 };
  input.subagentTranscriptData = [{ path: transcriptPath, records }];
  return input;
}

async function writeDirectoryFixture(runDir, {
  transcriptText,
  piSessionText,
  writePiSession = true,
} = {}) {
  const projectRoot = join(runDir, "project");
  const sessionId = "directory-session";
  const sessionDir = join(projectRoot, ".harness", "state", "html-report", sessionId);
  const pipelinePath = join(sessionDir, "debug", "pipeline-state.json");
  const checkpointsDir = join(runDir, "checkpoints");
  const transcriptPath = join(runDir, "artifacts", "designer-transcript.jsonl");
  const piSessionPath = join(runDir, "pi-session.jsonl");
  await Promise.all([
    mkdir(dirname(pipelinePath), { recursive: true }),
    mkdir(checkpointsDir, { recursive: true }),
    mkdir(dirname(transcriptPath), { recursive: true }),
  ]);
  const run = {
    sessionId,
    status: "pass",
    stoppedStage: "B5_DESIGN",
    projectRoot,
    startedAt: "2026-07-29T08:57:40.000Z",
    endedAt: "2026-07-29T08:59:30.000Z",
    pipelineStatePath: pipelinePath,
    rpcLogPath: join(runDir, "rpc.jsonl"),
    checkpointsDir,
    sessionFile: piSessionPath,
  };
  const pipeline = {
    sessionId,
    sessionDir,
    status: "completed",
    currentStage: "B5_DESIGN",
    stages: {
      B5_DESIGN: {
        status: "completed",
        startedAt: "2026-07-29T08:57:45.000Z",
        completedAt: "2026-07-29T08:59:28.000Z",
        executionDurationMs: 95000,
        attempts: [{ number: 1 }],
      },
    },
  };
  const rpc = [
    {
      type: "tool_execution_start",
      stageId: "B5_DESIGN",
      toolCallId: "designer-1",
      toolName: "subagent",
      args: { chain: [{ agent: "report-designer" }] },
      timestamp: "2026-07-29T08:57:50.000Z",
    },
    {
      type: "tool_execution_end",
      stageId: "B5_DESIGN",
      toolCallId: "designer-1",
      toolName: "subagent",
      durationMs: 80000,
      timestamp: "2026-07-29T08:59:10.000Z",
      result: { details: { results: [{ agent: "report-designer", exitCode: 0, transcriptPath }] } },
    },
  ];
  await Promise.all([
    writeFile(join(runDir, "run.json"), `${JSON.stringify(run)}\n`),
    writeFile(pipelinePath, `${JSON.stringify(pipeline)}\n`),
    writeFile(join(checkpointsDir, "B5_DESIGN.json"), `${JSON.stringify({ stageId: "B5_DESIGN", status: "completed", layout: { status: "pass", phase: "html" } })}\n`),
    writeFile(join(runDir, "rpc.jsonl"), `${rpc.map((record) => JSON.stringify(record)).join("\n")}\n`),
    writeFile(transcriptPath, transcriptText ?? ""),
    ...(writePiSession ? [writeFile(piSessionPath, piSessionText ?? "")] : []),
  ]);
  return { transcriptPath, piSessionPath };
}

test("finds the first anomaly and measures stages, budgets, agents, tools, retry and layout", () => {
  const report = analyzeHtmlReportRun(fixture("/tmp/analyzer-fixture"));
  assert.equal(report.result, "FAIL");
  assert.equal(report.firstAnomaly.code, "EXTENSION_ERROR");
  assert.equal(report.firstAnomaly.stageId, "B3_RESEARCH");
  assert.ok(report.anomalies.some((issue) => issue.code === "SOFT_BUDGET_EXCEEDED"));
  const writer = report.stages.find((stage) => stage.id === "B2_WRITER");
  assert.deepEqual(writer.subagents, [{ agent: "report-writer", dispatches: 1, durationMs: 30000, failures: 0 }]);
  assert.deepEqual(writer.tools, [
    { toolName: "ack_cli_data", calls: 1, durationMs: 10000, failures: 0 },
    { toolName: "subagent", calls: 1, durationMs: 30000, failures: 0 },
  ]);
  assert.equal(writer.indicatorsCliDurationMs, 10000);
  assert.equal(writer.parentTailDurationMs, 10000);
  const researcher = report.stages.find((stage) => stage.id === "B3_RESEARCH");
  assert.equal(researcher.retry.count, 1);
  assert.equal(researcher.budget.status, "soft_exceeded");
  assert.equal(researcher.layout.status, "fail");
  assert.deepEqual(report.artifacts.subagentTranscripts, ["/tmp/writer.jsonl"]);
  assert.equal(report.artifacts.runMetadata, "/tmp/analyzer-fixture/run.json");
});

test("B25 extension bridge attributes Planner time and transcript without counting it as fixed script time", () => {
  const baseDir = "/tmp/b25-extension-bridge";
  const transcriptPath = "artifacts/editor-planner.jsonl";
  const input = fixture(baseDir);
  input.run.status = "pass";
  input.run.stoppedStage = "B25_EDITOR";
  input.run.endedAt = "2026-07-29T03:02:00.000Z";
  input.pipelineState = {
    sessionId: "session-1",
    status: "completed",
    currentStage: "B25_EDITOR",
    stages: {
      B25_EDITOR: {
        status: "completed",
        startedAt: "2026-07-29T03:01:00.000Z",
        completedAt: "2026-07-29T03:02:00.000Z",
        executionDurationMs: 60000,
        attempts: [{ number: 1 }],
      },
    },
  };
  input.checkpoints = [{
    stageId: "B25_EDITOR",
    status: "completed",
    observedAt: "2026-07-29T03:02:00.000Z",
    layout: { status: "pass", phase: "editor" },
  }];
  input.stageObservations = [{ stageId: "B25_EDITOR", rpcStartIndex: 0, rpcEndIndex: 3 }];
  input.performanceConfig.performanceBudgets.B25_EDITOR = { softMs: 60000, hardMs: 120000 };
  input.rpcEvents = [
    {
      type: "tool_execution_start",
      toolCallId: "status-1",
      toolName: "bash",
      args: { command: "node html-report-gate.mjs status --session session-1" },
      timestamp: "2026-07-29T03:01:01.000Z",
    },
    {
      type: "tool_execution_end",
      toolCallId: "status-1",
      toolName: "bash",
      durationMs: 1000,
      timestamp: "2026-07-29T03:01:02.000Z",
    },
    {
      type: "tool_execution_start",
      toolCallId: "source-fields-1",
      toolName: "bash",
      args: { command: "node scripts/prepare-research-evidence.mjs --mode source_fields" },
      timestamp: "2026-07-29T03:01:03.000Z",
    },
    {
      type: "tool_execution_end",
      toolCallId: "source-fields-1",
      toolName: "bash",
      durationMs: 40000,
      timestamp: "2026-07-29T03:01:43.000Z",
      result: {
        details: {
          qdmHarnessAutoSubagent: {
            version: 1,
            producer: "qdm-harness",
            mechanism: "extension-event-bridge",
            stageId: "B25_EDITOR",
            role: "report-editor-planner",
            agent: "report-researcher",
            requestId: "planner-request-1",
            startedAt: "2026-07-29T03:01:13.000Z",
            endedAt: "2026-07-29T03:01:43.000Z",
            durationMs: 30000,
            isError: false,
            resultDetails: {
              mode: "chain",
              results: [{ exitCode: 0, transcriptPath }],
            },
          },
        },
      },
    },
  ];
  input.subagentTranscriptData = [{ path: transcriptPath, records: [] }];

  const report = analyzeHtmlReportRun(input);
  const editor = report.stages.find((stage) => stage.id === "B25_EDITOR");
  const expectedTranscriptPath = resolve(baseDir, transcriptPath);

  assert.equal(report.result, "PASS");
  assert.deepEqual(editor.subagents, [{
    agent: "report-researcher",
    dispatches: 1,
    durationMs: 30000,
    failures: 0,
  }]);
  assert.equal(editor.parentModelDurationMs, 30000, "Planner bridge time must be deducted from the parent interval");
  assert.equal(editor.deterministicScriptDurationMs, 10000, "embedded Planner time must be deducted from the Bash script total");
  assert.equal(editor.parentTailDurationMs, 20000);
  assert.deepEqual(editor.subagentTranscript.files, [expectedTranscriptPath]);
  assert.deepEqual(report.artifacts.subagentTranscriptBindings, [{
    path: expectedTranscriptPath,
    stageId: "B25_EDITOR",
    agent: "report-researcher",
  }]);
  assert.deepEqual(report.artifacts.subagentTranscripts, [expectedTranscriptPath]);
  assert.deepEqual(report.observations.subagentTranscripts, [{
    path: expectedTranscriptPath,
    stageId: "B25_EDITOR",
    agent: "report-researcher",
    status: "provided",
    recordCount: 0,
    error: null,
  }]);

  const failedInput = structuredClone(input);
  const failedEnd = failedInput.rpcEvents.at(-1);
  failedEnd.isError = true;
  failedEnd.result.details.qdmHarnessAutoSubagent.isError = true;
  failedEnd.result.details.qdmHarnessAutoSubagent.resultDetails.results[0].exitCode = 1;
  const failedEditor = analyzeHtmlReportRun(failedInput).stages.find((stage) => stage.id === "B25_EDITOR");
  assert.equal(failedEditor.subagents[0].failures, 1, "bridge failure must be attributed to report-researcher");
});

test("one bootstrap Bash result attributes Planner to B25 and initial Researcher to B3 without duplicating outer time", () => {
  const baseDir = "/tmp/dual-bootstrap-bridge";
  const plannerTranscript = "artifacts/planner.jsonl";
  const researcherTranscript = "artifacts/researcher.jsonl";
  const input = fixture(baseDir);
  input.run.status = "pass";
  input.run.stoppedStage = "B3_RESEARCH";
  input.run.endedAt = "2026-07-29T03:02:15.000Z";
  input.pipelineState = {
    sessionId: "session-1",
    status: "awaiting_approval",
    currentStage: "B3_RESEARCH",
    stages: {
      B25_EDITOR: {
        status: "completed",
        startedAt: "2026-07-29T03:01:00.000Z",
        completedAt: "2026-07-29T03:01:35.000Z",
        executionDurationMs: 35000,
        attempts: [{ number: 1 }],
      },
      B3_RESEARCH: {
        status: "awaiting_approval",
        startedAt: "2026-07-29T03:01:35.000Z",
        completedAt: "2026-07-29T03:02:15.000Z",
        executionDurationMs: 40000,
        attempts: [{ number: 1 }],
      },
    },
  };
  input.checkpoints = [
    { stageId: "B25_EDITOR", status: "completed", observedAt: "2026-07-29T03:01:35.000Z", layout: { status: "pass", phase: "b2" } },
    { stageId: "B3_RESEARCH", status: "awaiting_approval", observedAt: "2026-07-29T03:02:15.000Z", layout: { status: "pass", phase: "explore" } },
  ];
  input.stageObservations = [
    { stageId: "B25_EDITOR", rpcStartIndex: 0, rpcEndIndex: 0 },
    { stageId: "B3_RESEARCH", rpcStartIndex: 1, rpcEndIndex: 1 },
  ];
  input.performanceConfig.performanceBudgets.B25_EDITOR = { softMs: 60000, hardMs: 120000 };
  input.rpcEvents = [
    {
      type: "tool_execution_start",
      toolCallId: "source-fields-dual",
      toolName: "bash",
      args: { command: "node scripts/prepare-research-evidence.mjs --mode source_fields" },
      timestamp: "2026-07-29T03:01:00.000Z",
    },
    {
      type: "tool_execution_end",
      toolCallId: "source-fields-dual",
      toolName: "bash",
      durationMs: 75000,
      timestamp: "2026-07-29T03:02:15.000Z",
      result: {
        details: {
          qdmHarnessAutoSubagent: {
            version: 1,
            producer: "qdm-harness",
            mechanism: "extension-event-bridge",
            stageId: "B25_EDITOR",
            role: "report-editor-planner",
            agent: "report-researcher",
            requestId: "planner-dual",
            durationMs: 30000,
            isError: false,
            resultDetails: {
              mode: "chain",
              results: [{ agent: "report-researcher", exitCode: 0, transcriptPath: plannerTranscript }],
            },
          },
          qdmHarnessAutoResearcher: {
            version: 1,
            producer: "qdm-harness",
            mechanism: "extension-event-bridge",
            stageId: "B3_RESEARCH",
            role: "report-researcher",
            agent: "report-researcher",
            requestId: "researcher-dual",
            durationMs: 40000,
            isError: false,
            resultDetails: {
              mode: "chain",
              results: [{ agent: "report-researcher", exitCode: 0, transcriptPath: researcherTranscript }],
            },
          },
        },
      },
    },
  ];
  input.subagentTranscriptData = [
    { path: plannerTranscript, records: [] },
    { path: researcherTranscript, records: [] },
  ];

  const report = analyzeHtmlReportRun(input);
  const editor = report.stages.find((stage) => stage.id === "B25_EDITOR");
  const research = report.stages.find((stage) => stage.id === "B3_RESEARCH");

  assert.equal(report.result, "PASS");
  assert.deepEqual(editor.subagents, [{
    agent: "report-researcher",
    dispatches: 1,
    durationMs: 30000,
    failures: 0,
  }]);
  assert.deepEqual(research.subagents, [{
    agent: "report-researcher",
    dispatches: 1,
    durationMs: 40000,
    failures: 0,
  }]);
  assert.equal(editor.deterministicScriptDurationMs, 5000);
  assert.equal(research.deterministicScriptDurationMs, 0);
  assert.deepEqual(report.artifacts.subagentTranscriptBindings, [
    {
      path: resolve(baseDir, plannerTranscript),
      stageId: "B25_EDITOR",
      agent: "report-researcher",
    },
    {
      path: resolve(baseDir, researcherTranscript),
      stageId: "B3_RESEARCH",
      agent: "report-researcher",
    },
  ]);
});

test("custom Gate completion is extension overhead rather than parent model time", () => {
  const input = fixture("/tmp/b0-custom-gate");
  input.run.status = "pass";
  input.run.stoppedStage = "B0_PREFLIGHT";
  input.run.endedAt = "2026-07-29T03:00:00.113Z";
  input.pipelineState = {
    sessionId: "session-1",
    status: "completed",
    currentStage: "B0_PREFLIGHT",
    stages: {
      B0_PREFLIGHT: {
        status: "completed",
        startedAt: "2026-07-29T03:00:00.000Z",
        completedAt: "2026-07-29T03:00:00.041Z",
        executionDurationMs: 41,
        attempts: [{ number: 1 }],
      },
    },
  };
  input.checkpoints = [{
    stageId: "B0_PREFLIGHT",
    status: "completed",
    observedAt: "2026-07-29T03:00:00.113Z",
    layout: { status: "pass", phase: "preflight" },
  }];
  input.stageObservations = [{
    stageId: "B0_PREFLIGHT",
    executionDurationMs: 41,
    wallClockDurationMs: 113,
    completionSignal: "custom_gate",
  }];
  input.rpcEvents = [];

  const report = analyzeHtmlReportRun(input);
  const preflight = report.stages.find((stage) => stage.id === "B0_PREFLIGHT");

  assert.equal(report.result, "PASS");
  assert.equal(preflight.parentModelDurationMs, 0);
  assert.equal(preflight.extensionGateOverheadDurationMs, 41);
  assert.equal(preflight.parentTailDurationMs, 0);
  assert.match(renderHtmlReportRunMarkdown(report), /B0_PREFLIGHT：父模型区间 0 ms；Extension\/Gate 开销 41 ms/);
});

test("old B5 transcript exposes child tool failures, recovery retries and child timing", () => {
  const baseDir = "/tmp/old-b5-transcript";
  const transcriptPath = "artifacts/old-designer-transcript.jsonl";
  const records = [
    transcriptAssistantTool("2026-07-29T08:30:01.000Z", "bash", { command: "/opt/qdm-indicators-cli fetch" }, "cli-1"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:30:01.000Z", "bash"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:30:01.125Z", "bash"),
    transcriptToolResult("2026-07-29T08:30:01.126Z", "bash"),
    transcriptAssistantTool("2026-07-29T08:31:45.688Z", "edit", { path: "/tmp/report.design.html" }, "edit-1"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:31:45.688Z", "edit"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:31:45.689Z", "edit"),
    transcriptToolResult("2026-07-29T08:31:45.689Z", "edit", {
      isError: true,
      text: "Validation failed for tool edit: newText is required",
    }),
    transcriptAssistantTool("2026-07-29T08:32:27.978Z", "write", { path: "/tmp/report.design.html" }, "write-recovery-1"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:32:27.981Z", "write"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:32:27.982Z", "write"),
    transcriptAssistantTool("2026-07-29T08:32:31.341Z", "bash", { command: "node scripts/compose-report.mjs --result result.json" }, "compose-1"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:32:31.341Z", "bash"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:32:31.376Z", "bash"),
    transcriptToolResult("2026-07-29T08:32:31.378Z", "bash", {
      isError: true,
      text: "template must contain exactly one HTML_REPORT_CONTENT slot",
    }),
    transcriptAssistantTool("2026-07-29T08:32:56.301Z", "write", { path: "/tmp/report.design.html" }, "write-recovery-2"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:32:56.302Z", "write"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:32:56.303Z", "write"),
    transcriptAssistantTool("2026-07-29T08:32:58.991Z", "bash", { command: "node scripts/compose-report.mjs --result result.json" }, "compose-2"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:32:58.992Z", "bash"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:32:59.052Z", "bash"),
    transcriptToolResult("2026-07-29T08:32:59.062Z", "bash"),
    transcriptAssistantTool("2026-07-29T08:33:01.000Z", "structured_output", { value: { status: "ok" } }, "structured-1"),
  ];
  const report = analyzeHtmlReportRun(b5TranscriptFixture(baseDir, transcriptPath, records, {
    executionDurationMs: 190000,
    subagentDurationMs: 170000,
  }));
  const designer = report.stages.find((stage) => stage.id === "B5_DESIGN");
  const expectedPath = resolve(baseDir, transcriptPath);

  assert.equal(report.result, "FAIL");
  assert.equal(report.firstAnomaly.code, "SUBAGENT_TOOL_FAILED");
  assert.equal(report.firstAnomaly.stageId, "B5_DESIGN");
  assert.equal(report.firstAnomaly.evidence, `${expectedPath}:8`);
  assert.equal(report.anomalies.filter((issue) => issue.code === "SUBAGENT_TOOL_FAILED").length, 2);
  assert.equal(report.anomalies.filter((issue) => issue.code === "SUBAGENT_FAILURE_RETRY").length, 2);
  assert.deepEqual(designer.subagents, [{
    agent: "report-designer",
    dispatches: 1,
    durationMs: 170000,
    failures: 2,
    transcriptFailures: 2,
    transcriptRetries: 2,
  }]);
  assert.equal(designer.retry.count, 2);
  assert.equal(designer.retry.subagentRetryCount, 2);
  assert.equal(designer.indicatorsCliDurationMs, 125);
  assert.equal(designer.transcriptIndicatorsCliDurationMs, 125);
  assert.equal(designer.deterministicScriptDurationMs, 95);
  assert.equal(designer.transcriptDeterministicScriptDurationMs, 95);
  assert.equal(designer.parentModelDurationMs, 20000);
  assert.equal(designer.parentTailDurationMs, 20000, "child CLI/scripts must not be deducted twice");
  assert.deepEqual(report.artifacts.subagentTranscriptBindings, [{
    path: expectedPath,
    stageId: "B5_DESIGN",
    agent: "report-designer",
  }]);
  const markdown = renderHtmlReportRunMarkdown(report);
  assert.match(markdown, /SUBAGENT_TOOL_FAILED/);
  assert.match(markdown, /SUBAGENT_FAILURE_RETRY/);
  assert.match(markdown, /report-designer×1\/170\.0 秒\/失败2/);
  assert.match(markdown, /父模型区间 20\.0 秒/);
  assert.match(markdown, /Indicators CLI 125 ms（其中子代理内 125 ms）/);
});

test("new B5 transcript remains clean and reports the direct single-pass timing", () => {
  const baseDir = "/tmp/new-b5-transcript";
  const transcriptPath = "artifacts/new-designer-transcript.jsonl";
  const records = [
    transcriptAssistantTool("2026-07-29T08:57:59.144Z", "bash", { command: "node scripts/compile-report-content.mjs --result result.json" }, "compile-1"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:57:59.144Z", "bash"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:57:59.187Z", "bash"),
    transcriptToolResult("2026-07-29T08:57:59.190Z", "bash"),
    transcriptAssistantTool("2026-07-29T08:58:31.645Z", "write", { path: "/tmp/report.design.html" }, "design-write-1"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:58:31.648Z", "write"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:58:31.658Z", "write"),
    transcriptToolResult("2026-07-29T08:58:31.664Z", "write"),
    transcriptAssistantTool("2026-07-29T08:58:34.548Z", "bash", { command: "node scripts/compose-report.mjs --result result.json" }, "compose-1"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:58:34.550Z", "bash"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:58:34.620Z", "bash"),
    transcriptToolResult("2026-07-29T08:58:34.622Z", "bash"),
    transcriptAssistantTool("2026-07-29T08:59:15.097Z", "structured_output", { value: { status: "ok" } }, "structured-1"),
  ];
  const report = analyzeHtmlReportRun(b5TranscriptFixture(baseDir, transcriptPath, records));
  const designer = report.stages.find((stage) => stage.id === "B5_DESIGN");

  assert.equal(report.result, "PASS");
  assert.equal(report.firstAnomaly, null);
  assert.equal(designer.retry.count, 0);
  assert.equal(designer.subagentTranscript.failures, 0);
  assert.equal(designer.subagentTranscript.retries, 0);
  assert.equal(designer.deterministicScriptDurationMs, 113);
  assert.equal(designer.parentModelDurationMs, 20000);
  assert.equal(designer.parentTailDurationMs, 20000);
});

test("child assistant error or aborted stopReason is a transcript failure", () => {
  for (const stopReason of ["error", "aborted"]) {
    const errorMessage = `${stopReason} from provider`;
    const input = b5TranscriptFixture(`/tmp/child-${stopReason}`, `child-${stopReason}.jsonl`, [{
      recordType: "message",
      timestamp: "2026-07-29T08:32:00.000Z",
      role: "assistant",
      message: {
        role: "assistant",
        stopReason,
        errorMessage,
        content: [],
      },
    }]);
    const report = analyzeHtmlReportRun(input);
    assert.equal(report.result, "FAIL");
    assert.equal(report.firstAnomaly.code, `SUBAGENT_ASSISTANT_${stopReason.toUpperCase()}`);
    assert.equal(report.firstAnomaly.stageId, "B5_DESIGN");
    assert.equal(report.firstAnomaly.reason, errorMessage);
  }
});

test("completed run with only a soft budget breach is PERFORMANCE_REGRESSION", () => {
  const input = fixture("/tmp/performance-fixture");
  input.run.status = "pass";
  input.run.stoppedStage = "B2_WRITER";
  input.pipelineState.status = "completed";
  input.pipelineState.currentStage = "B2_WRITER";
  input.pipelineState.stages = { B2_WRITER: { status: "completed", executionDurationMs: 61000, completedAt: "2026-07-29T03:01:01.000Z", attempts: [{ number: 1 }] } };
  input.checkpoints = [{ stageId: "B2_WRITER", layout: { status: "pass", phase: "writer" }, observedAt: "2026-07-29T03:01:01.000Z" }];
  input.stageObservations = [];
  input.rpcEvents = [];
  const report = analyzeHtmlReportRun(input);
  assert.equal(report.result, "PERFORMANCE_REGRESSION");
  assert.equal(report.firstAnomaly.classification, "PERFORMANCE_REGRESSION");
});

test("failed stage without a checkpoint observation still attributes nested structured subagent failure", () => {
  const input = fixture("/tmp/failed-stage-attribution");
  input.run.endedAt = "2026-07-29T03:05:40.000Z";
  input.pipelineState.stages.B3_RESEARCH = {
    status: "failed",
    startedAt: "2026-07-29T03:03:13.000Z",
    failedAt: "2026-07-29T03:05:40.000Z",
    executionDurationMs: 147000,
    failureReason: "B3 Report Researcher contract failure: structured_status_failed",
    attempts: [{ number: 1, startedAt: "2026-07-29T03:03:13.000Z", endedAt: "2026-07-29T03:05:40.000Z" }],
  };
  input.checkpoints = input.checkpoints.filter((item) => item.stageId !== "B3_RESEARCH");
  input.stageObservations = [];
  input.rpcEvents = [
    {
      type: "tool_execution_start",
      toolCallId: "researcher-1",
      toolName: "subagent",
      args: { chain: [{ agent: "report-researcher" }] },
      timestamp: "2026-07-29T03:03:30.000Z",
    },
    {
      type: "tool_execution_end",
      toolCallId: "researcher-1",
      toolName: "subagent",
      durationMs: 87108,
      isError: false,
      timestamp: "2026-07-29T03:05:01.000Z",
      result: { details: { results: [{
        agent: "report-researcher",
        exitCode: 0,
        transcriptPath: "/tmp/researcher.jsonl",
        structuredOutput: { status: "failed", error: "section citation missing" },
      }] } },
    },
  ];
  const report = analyzeHtmlReportRun(input);
  const researcher = report.stages.find((stage) => stage.id === "B3_RESEARCH");
  assert.deepEqual(researcher.subagents, [{
    agent: "report-researcher", dispatches: 1, durationMs: 87108, failures: 1,
  }]);
  assert.equal(report.firstAnomaly.code, "SUBAGENT_STRUCTURED_FAILED");
  assert.equal(report.firstAnomaly.stageId, "B3_RESEARCH");
  assert.equal(report.firstAnomaly.toolOrAgent, "report-researcher");
  assert.equal(report.firstAnomaly.reason, "section citation missing");
  assert.deepEqual(report.artifacts.subagentTranscripts, ["/tmp/researcher.jsonl"]);
});

test("explicit observation performance anomaly is retained even when measured execution is within budget", () => {
  const input = fixture("/tmp/explicit-performance");
  input.run.status = "performance_regression";
  input.pipelineState.status = "completed";
  input.pipelineState.currentStage = "B2_WRITER";
  input.pipelineState.stages = {
    B2_WRITER: { status: "completed", executionDurationMs: 50000, attempts: [{ number: 1 }] },
  };
  input.checkpoints = [{ stageId: "B2_WRITER", layout: { status: "pass" } }];
  input.rpcEvents = [];
  input.stageObservations = [{
    stageId: "B2_WRITER",
    executionDurationMs: 50000,
    anomalies: [{
      classification: "PERFORMANCE_REGRESSION",
      code: "SOFT_BUDGET_EXCEEDED",
      reason: "B2_WRITER 墙钟耗时超过软阈值",
      occurredAt: "2026-07-29T03:01:00.000Z",
    }],
  }];
  const report = analyzeHtmlReportRun(input);
  assert.equal(report.result, "PERFORMANCE_REGRESSION");
  assert.equal(report.firstAnomaly.reason, "B2_WRITER 墙钟耗时超过软阈值");
});

test("performance config matches all initial design thresholds", async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.performanceBudgets, {
    A_CONFIG: { softMs: 30000, hardMs: 60000 },
    A_CONFIRM: { softMs: 90000, hardMs: 180000 },
    B0_PREFLIGHT: { softMs: 30000, hardMs: 60000 },
    B2_WRITER: { softMs: 60000, hardMs: 120000 },
    B25_EDITOR: { softMs: 60000, hardMs: 120000 },
    B3_RESEARCH: { softMs: 75000, hardMs: 150000 },
    B4_REVIEW: { softMs: 90000, hardMs: 180000 },
    B5_DESIGN: { softMs: 180000, hardMs: 360000 },
  });
  assert.equal(DEFAULT_PERFORMANCE_CONFIG_PATH, configPath);
  assert.equal(CONTROLLER_CONFIG_PATH, configPath);
});

test("artifacts expose one canonical htmlReportSession property", () => {
  const artifacts = analyzeHtmlReportRun(fixture("/tmp/canonical-artifacts")).artifacts;
  assert.equal(artifacts.htmlReportSession, "/tmp/html-report-session");
  assert.equal(Object.keys(artifacts).filter((key) => key === "htmlReportSession").length, 1);
  assert.equal(Object.hasOwn(artifacts, "htmlReportSessionDir"), false);
});

test("Markdown is Chinese, answer-first and preserves absolute artifact paths", () => {
  const markdown = renderHtmlReportRunMarkdown(analyzeHtmlReportRun(fixture("/tmp/analyzer-markdown")));
  assert.match(markdown, /^# html-report 自测报告/m);
  assert.match(markdown, /结论：FAIL/);
  assert.match(markdown, /## 第一个异常/);
  assert.match(markdown, /report-researcher×1\/60\.0 秒\/失败1/);
  assert.match(markdown, /\/tmp\/analyzer-markdown\/rpc\.jsonl/);
});

test("directory analyzer loads child transcript and Pi Session JSONL with source counts", async () => {
  const runDir = await mkdtemp(`${tmpdir()}/analyzer-directory-jsonl-`);
  const transcriptRecords = [
    transcriptAssistantTool("2026-07-29T08:58:00.000Z", "bash", { command: "node scripts/compile-report-content.mjs --result result.json" }, "compile-directory"),
    transcriptToolBoundary("tool_start", "2026-07-29T08:58:00.000Z", "bash"),
    transcriptToolBoundary("tool_end", "2026-07-29T08:58:00.050Z", "bash"),
    transcriptToolResult("2026-07-29T08:58:00.051Z", "bash"),
    transcriptAssistantTool("2026-07-29T08:59:00.000Z", "structured_output", { value: { status: "ok" } }, "structured-directory"),
  ];
  const piSessionRecords = [
    { type: "session", timestamp: "2026-07-29T08:57:40.000Z" },
    { type: "message", timestamp: "2026-07-29T08:57:50.000Z", message: { role: "user", content: [{ type: "text", text: "继续" }] } },
    { type: "message", timestamp: "2026-07-29T08:58:10.000Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "parent-1", name: "subagent", arguments: {} }] } },
    { type: "message", timestamp: "2026-07-29T08:59:20.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } },
  ];
  try {
    const paths = await writeDirectoryFixture(runDir, {
      transcriptText: `${transcriptRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      piSessionText: `${piSessionRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    });
    const report = await analyzeHtmlReportRunDirectory(runDir);
    const designer = report.stages.find((stage) => stage.id === "B5_DESIGN");
    assert.equal(report.result, "PASS");
    assert.deepEqual(report.artifacts.subagentTranscriptBindings, [{
      path: paths.transcriptPath,
      stageId: "B5_DESIGN",
      agent: "report-designer",
    }]);
    assert.equal(designer.transcriptDeterministicScriptDurationMs, 50);
    assert.deepEqual(report.observations.piSession, {
      path: paths.piSessionPath,
      status: "loaded",
      recordCount: 4,
      messageCount: 3,
      toolCallCount: 1,
      assistantFailureCount: 0,
      error: null,
    });
    assert.equal(report.observations.subagentTranscripts[0].status, "loaded");
    assert.match(renderHtmlReportRunMarkdown(report), /Pi Session：loaded；记录 4；消息 3；工具调用 1/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("directory analyzer reports invalid transcript, missing Pi Session and Pi assistant aborts", async () => {
  const invalidRunDir = await mkdtemp(`${tmpdir()}/analyzer-invalid-jsonl-`);
  try {
    await writeDirectoryFixture(invalidRunDir, {
      transcriptText: "{not-json}\n",
      writePiSession: false,
    });
    const invalidReport = await analyzeHtmlReportRunDirectory(invalidRunDir);
    assert.equal(invalidReport.result, "FAIL");
    assert.ok(invalidReport.anomalies.some((issue) => issue.code === "SUBAGENT_TRANSCRIPT_UNREADABLE"));
    assert.ok(invalidReport.anomalies.some((issue) => issue.code === "PI_SESSION_JSONL_UNREADABLE"));
    assert.equal(invalidReport.observations.subagentTranscripts[0].status, "invalid");
    assert.equal(invalidReport.observations.piSession.status, "missing");
  } finally {
    await rm(invalidRunDir, { recursive: true, force: true });
  }

  const input = b5TranscriptFixture("/tmp/pi-session-abort", "designer.jsonl", []);
  input.piSessionRecords = [{
    type: "message",
    timestamp: "2026-07-29T08:32:30.000Z",
    message: {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      content: [],
    },
  }];
  input.piSessionObservation = { status: "provided" };
  const abortedReport = analyzeHtmlReportRun(input);
  assert.equal(abortedReport.result, "FAIL");
  assert.equal(abortedReport.firstAnomaly.code, "PI_SESSION_ASSISTANT_ABORTED");
  assert.equal(abortedReport.firstAnomaly.reason, "Request was aborted");
  assert.equal(abortedReport.firstAnomaly.stageId, "B5_DESIGN");
  assert.equal(abortedReport.observations.piSession.assistantFailureCount, 1);

  const immediate = inspectRpcStageRecords([{
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      content: [],
    },
  }], "B5_DESIGN");
  assert.equal(immediate.errors[0].code, "ASSISTANT_ABORTED");
  assert.equal(immediate.errors[0].reason, "Request was aborted");
});

test("CLI loads a run directory and writes machine JSON and Markdown", async () => {
  const runDir = await mkdtemp(`${tmpdir()}/analyzer-cli-`);
  const projectRoot = join(runDir, "project");
  const sessionId = "cli-session";
  const pipelinePath = join(projectRoot, ".harness", "state", "html-report", sessionId, "debug", "pipeline-state.json");
  await mkdir(dirname(pipelinePath), { recursive: true });
  await mkdir(join(runDir, "checkpoints"));
  await writeFile(join(runDir, "run.json"), `${JSON.stringify({ sessionId, status: "pass", stoppedStage: "B5_DESIGN", projectRoot, startedAt: "2026-07-29T03:00:00.000Z", endedAt: "2026-07-29T03:05:00.000Z" })}\n`);
  await writeFile(pipelinePath, `${JSON.stringify({ sessionId, sessionDir: dirname(dirname(pipelinePath)), status: "completed", currentStage: "B5_DESIGN", observedAt: "2026-07-29T03:05:00.000Z", stages: { B5_DESIGN: { status: "completed", executionDurationMs: 1000, attempts: [{ number: 1 }] } } })}\n`);
  await writeFile(join(runDir, "checkpoints", "B5_DESIGN.json"), `${JSON.stringify({ stageId: "B5_DESIGN", status: "completed", layout: { status: "pass", phase: "html" } })}\n`);
  await writeFile(join(runDir, "rpc.jsonl"), '{"receivedAt":"2026-07-29T03:05:00.000Z","event":{"type":"agent_settled","stageId":"B5_DESIGN"}}\n');
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--run-dir", runDir]);
    assert.match(stdout, /结果：PASS/);
    const report = JSON.parse(await readFile(join(runDir, "self-test-report.json"), "utf8"));
    assert.deepEqual(report.stages[0].budget, { softMs: 180000, hardMs: 360000, status: "within_budget" });
    assert.equal(report.artifacts.performanceConfig, configPath);
    assert.match(await readFile(join(runDir, "self-test-report.md"), "utf8"), /结论：PASS/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
