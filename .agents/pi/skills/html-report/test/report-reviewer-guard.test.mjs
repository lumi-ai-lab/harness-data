import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PARENT_REVIEWER_SCAN_MARKER,
  classifyReviewerCommand,
  initialReviewerGuardState,
  parseReviewerAssignment,
  reviewerToolDecision,
  reviewerToolResultState,
} from "../../../extensions/report-reviewer-guard/guard.mjs";
import registerReportReviewerGuard from "../../../extensions/report-reviewer-guard/index.mjs";
import { buildReviewerReturnSchema } from "../scripts/reviewer-return.mjs";

const projectRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const session = join(projectRoot, ".harness", "state", "html-report", "reviewer-guard-test");

function assignment(overrides = {}) {
  const assignedSession = overrides.session || session;
  const resultPath = overrides.resultPath || join(assignedSession, "result.json");
  const lines = [
    `B4 scorecard for SESSION=${assignedSession}`,
    `result.json=${resultPath}`,
    "The B3 report is already assembled and frozen; do not run assemble-report.mjs.",
    PARENT_REVIEWER_SCAN_MARKER,
    "1) read the parent-produced quality/scan.json",
    "2) draft scores R1–R7 → quality/verdict.draft.json",
    "3) write-verdict.mjs",
    "4) write quality/report.md",
    "5) structured_output",
  ];
  if (overrides.extra) lines.push(overrides.extra);
  return lines.join("\n");
}

function draftContent() {
  return JSON.stringify({
    pass: false,
    scores: Object.fromEntries(
      ["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, { score: 1, max: 2 }])
    ),
    hardBlockers: ["关键数字不可追溯"],
    issues: [],
  });
}

function normalReturn(contract, { pass = false, total = 7 } = {}) {
  return {
    status: pass ? "passed" : "failed",
    pass,
    total,
    maxTotal: 14,
    sessionDir: contract.sessionDir,
    resultPath: contract.resultPath,
    scanPath: contract.scanPath,
    reportPath: contract.reportPath,
    verdictPath: contract.verdictPath,
    repairHints: pass ? [] : ["删除不可追溯数字后重新审核"],
  };
}

function typedScorecard() {
  return {
    scores: Object.fromEntries(
      ["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, {
        score: id === "R1" ? 1 : 2,
        note: `${id} 对“最佳平衡点”的审核依据，含逗号、引号与反斜杠 \\`,
      }])
    ),
    summary: "评分对象由 typed tool 安全序列化。",
    hardBlockers: [],
    issues: [{
      severity: "soft",
      code: "RUBRIC_LOW",
      rubric: "R1",
      message: "未充分回答\"最佳平衡点\"作为区间的含义",
      where: "report/report.md",
    }],
    repairHints: [],
  };
}

function infrastructureReturn(contract, failure, overrides = {}) {
  return {
    status: "infrastructure_error",
    pass: false,
    total: 0,
    maxTotal: 14,
    sessionDir: contract.sessionDir,
    resultPath: contract.resultPath,
    scanPath: contract.scanPath,
    reportPath: contract.reportPath,
    verdictPath: contract.verdictPath,
    failedStep: failure.failedStep,
    error: failure.error,
    repairHints: ["修复该基础设施错误后，由用户重试当前阶段"],
    ...overrides,
  };
}

function decide(contract, state, toolName, input, toolCallId) {
  return reviewerToolDecision(contract, state, { toolName, input, toolCallId });
}

function result(contract, state, toolName, toolCallId, overrides = {}) {
  return reviewerToolResultState(contract, state, {
    toolName,
    toolCallId,
    isError: false,
    content: [{ type: "text", text: "ok" }],
    ...overrides,
  });
}

function scanCommand(contract) {
  return `node .agents/pi/skills/html-report/scripts/quality-scan.mjs --result "${contract.resultPath}"`;
}

function stampCommand(contract) {
  return `node .agents/pi/skills/html-report/scripts/write-verdict.mjs --result "${contract.resultPath}" --verdict-file "${contract.draftPath}"`;
}

function successfulScan(contract, state = initialReviewerGuardState()) {
  assert.equal(contract.ok, true, contract.errors?.join("; "));
  return state;
}

function successfulReviewReads(contract, state) {
  const paths = [
    contract.resultPath,
    contract.candidateReportPath,
    contract.renderManifestPath,
    contract.rubricPath,
    contract.scanPath,
  ];
  let next = state;
  for (const [index, path] of paths.entries()) {
    const id = `read-${index}`;
    const called = decide(contract, next, "read", { path }, id);
    assert.equal(called.decision, undefined, path);
    next = result(contract, called.state, "read", id);
  }
  return next;
}

function successfulDraft(contract, state) {
  const called = decide(
    contract,
    state,
    "write",
    { path: contract.draftPath, content: draftContent() },
    "draft-1"
  );
  assert.equal(called.decision, undefined);
  return result(contract, called.state, "write", "draft-1");
}

function successfulStamp(contract, state) {
  const called = decide(contract, state, "bash", { command: stampCommand(contract) }, "stamp-1");
  assert.equal(called.decision, undefined);
  return result(contract, called.state, "bash", "stamp-1");
}

test("Reviewer assignment pins all writable and readable paths to one current SESSION", () => {
  const parsed = parseReviewerAssignment(assignment(), { projectRoot });
  assert.equal(parsed.ok, true, parsed.errors?.join("; "));
  assert.equal(parsed.sessionDir, session);
  assert.equal(parsed.resultPath, join(session, "result.json"));
  assert.equal(parsed.scanPath, join(session, "quality", "scan.json"));
  assert.equal(parsed.reportPath, join(session, "quality", "report.md"));
  assert.equal(parsed.verdictPath, join(session, "quality", "verdict.json"));
  assert.equal(parsed.draftPath, join(session, "quality", "verdict.draft.json"));
  assert.equal(parsed.candidateReportPath, join(session, "report", "report.md"));
  assert.equal(parsed.renderManifestPath, join(session, "report", "render-manifest.json"));
  assert.equal(parsed.rubricPath, join(projectRoot, "docs", "html-report-quality-rubric.md"));

  const forgedResult = parseReviewerAssignment(assignment({ resultPath: "/tmp/result.json" }), { projectRoot });
  assert.equal(forgedResult.ok, false);
  assert.match(forgedResult.errors.join("\n"), /result\.json 与 SESSION/);

  const escapedSession = parseReviewerAssignment(
    assignment({ session: "/tmp/other-session", resultPath: "/tmp/other-session/result.json" }),
    { projectRoot }
  );
  assert.equal(escapedSession.ok, false);
  assert.match(escapedSession.errors.join("\n"), /html-report 根/);

  const duplicate = parseReviewerAssignment(`${assignment()}\nSESSION=${session}`, { projectRoot });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join("\n"), /只能声明一次 SESSION/);

  const redirectedArtifact = parseReviewerAssignment(
    assignment({ extra: "verdictPath=/tmp/forged-verdict.json" }),
    { projectRoot }
  );
  assert.equal(redirectedArtifact.ok, false);
  assert.match(redirectedArtifact.errors.join("\n"), /verdictPath 与 SESSION/);

  const explicitCandidate = parseReviewerAssignment(
    assignment({ extra: `reportPath=${join(session, "report", "report.md")}` }),
    { projectRoot }
  );
  assert.equal(explicitCandidate.ok, true, explicitCandidate.errors?.join("; "));

  const explicitQualityReport = parseReviewerAssignment(
    assignment({ extra: `reportPath=${join(session, "quality", "report.md")}` }),
    { projectRoot }
  );
  assert.equal(explicitQualityReport.ok, true, explicitQualityReport.errors?.join("; "));

  const redirectedReport = parseReviewerAssignment(
    assignment({ extra: "reportPath=/tmp/forged-report.md" }),
    { projectRoot }
  );
  assert.equal(redirectedReport.ok, false);
  assert.match(redirectedReport.errors.join("\n"), /reportPath 与 SESSION/);
});

test("Reviewer Bash whitelist rejects scan reruns and accepts only the legacy stamp command", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });
  assert.equal(classifyReviewerCommand(scanCommand(contract), contract), null);
  assert.deepEqual(classifyReviewerCommand(stampCommand(contract), contract), {
    kind: "stamp",
    failedStep: "stamp",
  });

  for (const command of [
    `node .agents/pi/skills/html-report/scripts/assemble-report.mjs --session-dir "${contract.sessionDir}"`,
    `node .agents/pi/skills/html-report/scripts/check-session-layout.mjs --result "${contract.resultPath}" --phase quality`,
    "ls -la",
    `cat "${contract.scanPath}"`,
    "python3 -c 'print(1)'",
    "node -e 'console.log(1)'",
    `node .agents/pi/skills/html-report/scripts/quality-scan.mjs --result "${contract.resultPath}" 2>&1`,
    `node .agents/pi/skills/html-report/scripts/quality-scan.mjs --result /tmp/result.json`,
    `${scanCommand(contract)} && ls`,
  ]) {
    assert.equal(classifyReviewerCommand(command, contract), null, command);
    const blocked = decide(contract, initialReviewerGuardState(), "bash", { command }, "bad-command");
    assert.equal(blocked.decision.block, true, command);
    assert.match(blocked.decision.reason, /父扩展已完成 quality-scan/);
    assert.ok(blocked.state.terminalFailure, "forbidden command must terminate the child run");
  }
});

test("Reviewer successful path is a fixed one-shot state machine", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });
  let state = successfulScan(contract);

  const duplicateScan = decide(contract, state, "bash", { command: scanCommand(contract) }, "scan-2");
  assert.equal(duplicateScan.decision.block, true);
  assert.match(duplicateScan.decision.reason, /父扩展已完成 quality-scan/);
  assert.equal(duplicateScan.state.terminalFailure.failedStep, "read");

  state = successfulReviewReads(contract, state);
  const duplicateRead = decide(contract, state, "read", { path: contract.scanPath }, "read-again");
  assert.equal(duplicateRead.decision.block, true);
  assert.match(duplicateRead.decision.reason, /最多读取一次/);

  state = successfulDraft(contract, state);
  const rewrite = decide(
    contract,
    state,
    "write",
    { path: contract.draftPath, content: draftContent() },
    "draft-2"
  );
  assert.equal(rewrite.decision.block, true);
  assert.match(rewrite.decision.reason, /最多写一次/);

  state = successfulStamp(contract, state);
  let called = decide(contract, state, "read", { path: contract.verdictPath }, "verdict-read");
  assert.equal(called.decision, undefined);
  state = result(contract, called.state, "read", "verdict-read");

  called = decide(
    contract,
    state,
    "write",
    { path: contract.reportPath, content: "# 质量审核\n\n未通过，需删除不可追溯数字。\n" },
    "report-write"
  );
  assert.equal(called.decision, undefined);
  state = result(contract, called.state, "write", "report-write");

  called = decide(
    contract,
    state,
    "structured_output",
    { value: normalReturn(contract) },
    "structured-1"
  );
  assert.equal(called.decision, undefined);
  state = called.state;

  const secondFinal = decide(
    contract,
    state,
    "structured_output",
    { value: normalReturn(contract) },
    "structured-2"
  );
  assert.equal(secondFinal.decision.block, true);
  assert.match(secondFinal.decision.reason, /最多调用一次/);
  const afterFinalIo = decide(contract, state, "read", { path: contract.scanPath }, "after-final-read");
  assert.equal(afterFinalIo.decision.block, true);
  assert.match(afterFinalIo.decision.reason, /structured_output 已调用/);
});

test("typed scorecard path replaces model-written JSON and binds final output to tool result", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });
  let state = successfulReviewReads(contract, successfulScan(contract));

  let called = decide(
    contract,
    state,
    "submit_review_scorecard",
    typedScorecard(),
    "typed-submit"
  );
  assert.equal(called.decision, undefined);
  state = result(contract, called.state, "submit_review_scorecard", "typed-submit", {
    details: { reviewerReturn: normalReturn(contract, { pass: true, total: 13 }) },
  });
  assert.equal(state.submissionSuccess, true);

  const duplicate = decide(
    contract,
    state,
    "submit_review_scorecard",
    typedScorecard(),
    "typed-submit-2"
  );
  assert.equal(duplicate.decision.block, true);
  assert.match(duplicate.decision.reason, /最多调用一次/);

  called = decide(
    contract,
    state,
    "structured_output",
    { value: normalReturn(contract, { pass: true, total: 13 }) },
    "typed-final"
  );
  assert.equal(called.decision, undefined);

  const drifted = normalReturn(contract, { pass: true, total: 12 });
  const rejected = decide(
    contract,
    state,
    "structured_output",
    { value: drifted },
    "typed-final-drifted"
  );
  assert.equal(rejected.decision.block, true);
  assert.match(rejected.decision.reason, /原样复制/);
});

test("typed scorecard cannot run before scan reads or mix with legacy draft writes", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });
  let blocked = decide(
    contract,
    initialReviewerGuardState(),
    "submit_review_scorecard",
    typedScorecard(),
    "typed-early"
  );
  assert.equal(blocked.decision.block, true);
  assert.match(blocked.decision.reason, /必须完成父级 scan 标记约束下的全部固定读取/);

  let state = successfulReviewReads(contract, successfulScan(contract));
  state = successfulDraft(contract, state);
  blocked = decide(
    contract,
    state,
    "submit_review_scorecard",
    typedScorecard(),
    "typed-mixed"
  );
  assert.equal(blocked.decision.block, true);
  assert.match(blocked.decision.reason, /禁止与旧.*流程混用/);
});

test("Reviewer first batch reads all five frozen inputs after parent scan", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });
  let state = initialReviewerGuardState();
  const resultRead = {
    toolName: "read",
    toolCallId: "first-result",
    input: { path: contract.resultPath },
  };
  const reportRead = {
    toolName: "read",
    toolCallId: "first-report",
    input: { path: contract.candidateReportPath },
  };

  let called = reviewerToolDecision(contract, state, resultRead);
  assert.equal(called.decision, undefined);
  state = called.state;
  called = reviewerToolDecision(contract, state, reportRead);
  assert.equal(called.decision, undefined);
  state = called.state;
  const scanRead = decide(
    contract,
    initialReviewerGuardState(),
    "read",
    { path: contract.scanPath },
    "early-scan-json"
  );
  assert.equal(scanRead.decision, undefined);

  // Parallel tool results may complete out of order. Once scan succeeds, the
  // generated scan.json becomes readable while the frozen reads stay valid.
  state = result(contract, state, "read", "first-report");
  state = result(contract, state, "read", "first-result");
  state = result(contract, scanRead.state, "read", "early-scan-json");
});

test("Reviewer requires successful fixed reads before draft and validates draft JSON before I/O", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });
  let state = successfulScan(contract);

  let blocked = decide(
    contract,
    state,
    "write",
    { path: contract.draftPath, content: draftContent() },
    "early-draft"
  );
  assert.equal(blocked.decision.block, true);
  assert.match(blocked.decision.reason, /尚未成功读取/);
  assert.equal(blocked.state.terminalFailure.failedStep, "write");

  state = successfulReviewReads(contract, successfulScan(contract));
  blocked = decide(
    contract,
    state,
    "write",
    { path: contract.draftPath, content: "{ invalid json" },
    "invalid-draft"
  );
  assert.equal(blocked.decision.block, true);
  assert.match(blocked.decision.reason, /不是有效 JSON/);
  assert.equal(blocked.state.terminalFailure.failedStep, "write");

  const wrongScale = JSON.parse(draftContent());
  wrongScale.scores.R4 = { score: 7, max: 7 };
  blocked = decide(
    contract,
    successfulReviewReads(contract, successfulScan(contract)),
    "write",
    { path: contract.draftPath, content: JSON.stringify(wrongScale) },
    "wrong-scale"
  );
  assert.equal(blocked.decision.block, true);
  assert.match(blocked.decision.reason, /R4.*0\|1\|2/);
});

test("any read/write/stamp failure terminally blocks later I/O and permits only matching infrastructure_error", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });

  let called = decide(contract, initialReviewerGuardState(), "read", { path: contract.resultPath }, "read-fail");
  let failed = result(contract, called.state, "read", "read-fail", {
    isError: true,
    content: [{ type: "text", text: "ENOENT result.json" }],
  });
  assert.equal(failed.terminalFailure.failedStep, "read");
  assert.match(failed.terminalFailure.error, /ENOENT/);
  for (const [toolName, input] of [
    ["read", { path: contract.resultPath }],
    ["write", { path: contract.reportPath, content: "retry" }],
    ["bash", { command: scanCommand(contract) }],
    ["ls", { path: contract.sessionDir }],
  ]) {
    const afterFailure = decide(contract, failed, toolName, input, `after-${toolName}`);
    assert.equal(afterFailure.decision.block, true, toolName);
    assert.match(afterFailure.decision.reason, /禁止后续 I\/O、命令或重试/);
  }

  let final = decide(
    contract,
    failed,
    "structured_output",
    { value: infrastructureReturn(contract, failed.terminalFailure) },
    "infra-final"
  );
  assert.equal(final.decision, undefined);
  assert.equal(final.state.structuredAttempts, 1);
  assert.equal(
    decide(
      contract,
      final.state,
      "structured_output",
      { value: infrastructureReturn(contract, failed.terminalFailure) },
      "infra-final-2"
    ).decision.block,
    true
  );

  final = decide(
    contract,
    failed,
    "structured_output",
    { value: normalReturn(contract) },
    "wrong-final"
  );
  assert.equal(final.decision.block, true);
  assert.match(final.decision.reason, /只允许 status=infrastructure_error/);

  final = decide(
    contract,
    failed,
    "structured_output",
    { value: infrastructureReturn(contract, failed.terminalFailure, { failedStep: "stamp" }) },
    "wrong-step"
  );
  assert.equal(final.decision.block, true);
  assert.match(final.decision.reason, /failedStep 必须是 read/);

  final = decide(
    contract,
    failed,
    "structured_output",
    { value: infrastructureReturn(contract, failed.terminalFailure, { error: "模型自行改写的错误原因" }) },
    "rewritten-error"
  );
  assert.equal(final.decision.block, true);
  assert.match(final.decision.reason, /必须原样复制 guard 捕获的错误/);
});

test("read, write, and stamp tool errors each preserve their exact terminal failedStep", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });

  let state = successfulScan(contract);
  let called = decide(contract, state, "read", { path: contract.resultPath }, "read-fail");
  state = result(contract, called.state, "read", "read-fail", {
    isError: true,
    content: [{ type: "text", text: "ENOENT result.json" }],
  });
  assert.deepEqual(state.terminalFailure, { failedStep: "read", error: "ENOENT result.json" });

  state = successfulReviewReads(contract, successfulScan(contract));
  called = decide(
    contract,
    state,
    "write",
    { path: contract.draftPath, content: draftContent() },
    "write-fail"
  );
  state = result(contract, called.state, "write", "write-fail", {
    isError: true,
    content: [{ type: "text", text: "EACCES verdict.draft.json" }],
  });
  assert.equal(state.terminalFailure.failedStep, "write");
  assert.match(state.terminalFailure.error, /EACCES/);

  state = successfulDraft(contract, successfulReviewReads(contract, successfulScan(contract)));
  called = decide(contract, state, "bash", { command: stampCommand(contract) }, "stamp-fail");
  state = result(contract, called.state, "bash", "stamp-fail", {
    isError: true,
    content: [{ type: "text", text: "invalid draft" }],
  });
  assert.equal(state.terminalFailure.failedStep, "stamp");
  assert.match(state.terminalFailure.error, /invalid draft/);
  const retry = decide(contract, state, "bash", { command: stampCommand(contract) }, "stamp-retry");
  assert.equal(retry.decision.block, true);
  assert.match(retry.decision.reason, /run 已因 stamp 失败终止/);
});

test("Reviewer blocks unstamped verdict reads, manual verdict writes, directory/data reads, and early final output", () => {
  const contract = parseReviewerAssignment(assignment(), { projectRoot });
  const scanned = successfulScan(contract);

  for (const path of [
    contract.verdictPath,
    join(contract.sessionDir, "data", "cards", "card-1", "entry.json"),
    join(contract.sessionDir, "analysis", "main.md"),
    join(projectRoot, ".pi-subagents", "run", "output.json"),
  ]) {
    const blocked = decide(contract, scanned, "read", { path }, `bad-read-${path}`);
    assert.equal(blocked.decision.block, true, path);
  }

  const manualVerdict = decide(
    contract,
    scanned,
    "write",
    { path: contract.verdictPath, content: "{}" },
    "manual-verdict"
  );
  assert.equal(manualVerdict.decision.block, true);
  assert.match(manualVerdict.decision.reason, /write 只能写一次固定/);

  let early = decide(
    contract,
    initialReviewerGuardState(),
    "structured_output",
    { value: normalReturn(contract) },
    "early-final"
  );
  assert.equal(early.decision.block, true);
  assert.match(early.decision.reason, /structured_output 过早/);
  early = decide(
    contract,
    early.state,
    "structured_output",
    { value: normalReturn(contract) },
    "early-final-retry"
  );
  assert.equal(early.decision.block, true);
  assert.match(early.decision.reason, /最多调用一次/);
});

test("child-only extension captures assignment from context and enforces the guard", () => {
  const handlers = new Map();
  let registeredTool;
  registerReportReviewerGuard({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(tool) {
      registeredTool = tool;
    },
  });
  assert.deepEqual([...handlers.keys()], ["before_agent_start", "context", "tool_call", "tool_result"]);
  assert.equal(registeredTool.name, "submit_review_scorecard");
  assert.deepEqual(registeredTool.parameters.properties.scores.required, ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
  assert.equal(registeredTool.parameters.anyOf.length, 2);
  assert.equal(registeredTool.parameters.properties.scores.properties.summary.type, "string");
  assert.equal(registeredTool.parameters.properties.issues.items.properties.message.type, "string");

  handlers.get("before_agent_start")({ systemPrompt: "Reviewer child system prompt" });
  handlers.get("context")({
    messages: [{ role: "user", content: [{ type: "text", text: assignment() }] }],
  });

  const forbidden = handlers.get("tool_call")({ toolName: "ls", input: { path: session } });
  assert.equal(forbidden.block, true);
  assert.match(forbidden.reason, /未授权工具：ls/);
});

test("typed Reviewer submit captures outputSchema and terminates without a second model turn", async (t) => {
  const sessionRoot = join(projectRoot, ".harness", "state", "html-report");
  await mkdir(sessionRoot, { recursive: true });
  const assignedSession = await mkdtemp(join(sessionRoot, "reviewer-capture-test-"));
  const qualityDir = join(assignedSession, "quality");
  await mkdir(qualityDir, { recursive: true });
  const resultPath = join(assignedSession, "result.json");
  await writeFile(resultPath, JSON.stringify({ status: "confirmed" }));
  await writeFile(join(qualityDir, "scan.json"), JSON.stringify({
    version: 1,
    report: { matchedCount: 1, unmatchedCount: 0 },
    hardIssues: [],
    softIssues: [],
  }));

  const captureDir = await mkdtemp(join(tmpdir(), "reviewer-capture-runtime-"));
  const schemaPath = join(captureDir, "schema.json");
  const outputPath = join(captureDir, "output.json");
  const assigned = assignment({ session: assignedSession, resultPath });
  const contract = parseReviewerAssignment(assigned, { projectRoot });
  await writeFile(schemaPath, JSON.stringify(buildReviewerReturnSchema(contract)));

  const previousSchema = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
  const previousCapture = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
  process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA = schemaPath;
  process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE = outputPath;
  t.after(async () => {
    if (previousSchema === undefined) delete process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
    else process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA = previousSchema;
    if (previousCapture === undefined) delete process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
    else process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE = previousCapture;
    await rm(assignedSession, { recursive: true, force: true });
    await rm(captureDir, { recursive: true, force: true });
  });

  const handlers = new Map();
  let registeredTool;
  registerReportReviewerGuard({
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(tool) {
      registeredTool = tool;
    },
  });
  handlers.get("before_agent_start")({ systemPrompt: "Reviewer child system prompt" });
  handlers.get("context")({
    messages: [{ role: "user", content: [{ type: "text", text: assigned }] }],
  });

  let transition;
  for (const [index, path] of [
    contract.resultPath,
    contract.candidateReportPath,
    contract.renderManifestPath,
    contract.rubricPath,
    contract.scanPath,
  ].entries()) {
    const toolCallId = `capture-read-${index}`;
    transition = handlers.get("tool_call")({ toolName: "read", toolCallId, input: { path } });
    assert.equal(transition, undefined);
    handlers.get("tool_result")({
      toolName: "read",
      toolCallId,
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });
  }
  transition = handlers.get("tool_call")({
    toolName: "submit_review_scorecard",
    toolCallId: "capture-submit",
    input: typedScorecard(),
  });
  assert.equal(transition, undefined);

  const committed = await registeredTool.execute("capture-submit", typedScorecard());
  assert.equal(committed.terminate, true);
  assert.equal(committed.details.structuredOutputPath, outputPath);
  assert.deepEqual(
    JSON.parse(await readFile(outputPath, "utf8")),
    committed.details.reviewerReturn
  );
});

test("report-reviewer registration loads only the child guard", async () => {
  const runtime = await readFile(join(projectRoot, ".agents/pi/agents/report-reviewer.md"), "utf8");
  assert.match(runtime, /^tools:\s*read, submit_review_scorecard$/m);
  assert.match(runtime, /^extensions:\s*$/m);
  assert.match(
    runtime,
    /^subagentOnlyExtensions:\s*\.agents\/pi\/extensions\/report-reviewer-guard\/index\.mjs$/m
  );
  assert.match(runtime, /^inheritProjectContext:\s*false$/m);
});
