import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  classifyResearcherCommand,
  initialResearcherGuardState,
  parseEditorPlannerGuardAssignment,
  parseResearcherAssignment,
  researcherUnvalidatedSubmitFailureState,
  researcherToolDecision,
  researcherToolResultState,
} from "../../../extensions/report-researcher-guard/guard.mjs";
import registerReportResearcherGuard from "../../../extensions/report-researcher-guard/index.mjs";
import {
  prepareStructuredOutputCapture,
  STRUCTURED_OUTPUT_CAPTURE_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "../../../extensions/shared/subagent-structured-output-capture.mjs";
import { buildResearcherReturnSchema } from "../scripts/researcher-return.mjs";

const projectRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const session = join(projectRoot, ".harness", "state", "html-report", "guard-test-session");

function plannerAssignment() {
  return [
    "HTML_REPORT_EDITOR_PLAN_V1",
    `SESSION=${session}`,
    `result.json=${join(session, "result.json")}`,
    "",
    "COMPACT EDITOR INPUT JSON:",
    '{"version":1,"userQuestion":"中性问题","cards":[]}',
  ].join("\n");
}

function assignment(mode = "reuse_entry", overrides = {}) {
  const taskId = overrides.taskId || "drill-001";
  const task = {
    id: taskId,
    fromCardId: "card-001",
    goal: "回答缺口",
    evidencePlan: { mode },
    evidenceGap: mode === "new_query"
      ? { type: "missing_dimension", reason: "现有查询缺少品类维度" }
      : null,
    ...overrides.task,
  };
  return [
    `按 report-researcher 处理 taskId=${taskId}`,
    `SESSION=${overrides.session || session}`,
    `result.json=${overrides.resultPath || join(session, "result.json")}`,
    `完整 task 对象: ${JSON.stringify(task)}`,
    `evidencePath=${overrides.evidencePath || join(session, "analysis", "evidence", `${taskId}.json`)}`,
    overrides.genericModeRules
      ? "MODE RULE:\n- reuse_entry: read only evidencePath.\n- new_query: query only for a material gap."
      : `MODE RULE: ${overrides.directMode || mode} - fixed contract`,
  ].join("\n");
}

function transition(contract, state, event) {
  return researcherToolDecision(contract, state, event);
}

function evidencePacket() {
  return {
    source: { empty: false, queryCoverage: {} },
    views: { sample: { value: 10 } },
  };
}

function validSection() {
  return "结论值为 10。\n\n证据：`/views/sample/value`";
}

function validResearcherReturn(contract) {
  const value = {
    taskId: contract.taskId,
    status: "ok",
    evidenceModeUsed: contract.mode,
    evidencePath: contract.evidencePath,
    sectionPath: contract.sectionPath,
    summaryPath: contract.summaryPath,
    summary: "结论值为 10。",
    noData: false,
    evidencePointers: ["/views/sample/value"],
    selfCheck: {
      modeCompliant: true,
      evidenceTraceable: true,
      hasContrastOrBreakdown: true,
      answersGoal: true,
      queryJustified: contract.mode === "new_query" ? true : null,
    },
    suggestedDeeper: [],
  };
  const requirements = Array.isArray(contract.task?.analysisRequirements)
    ? contract.task.analysisRequirements
    : [];
  if (requirements.length) {
    value.findings = requirements.map((requirement) => ({
      requirementId: requirement.id,
      claim: "结论值为 10。",
      evidencePointers: ["/views/sample/value"],
    }));
    value.summary = value.findings.map((finding) => finding.claim).join(" ");
  }
  return value;
}

function toolResult(contract, state, event, overrides = {}) {
  const defaultText = event.toolName === "read" && event.input?.path === contract.evidencePath
    ? JSON.stringify(evidencePacket())
    : "ok";
  return researcherToolResultState(contract, state, {
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    isError: false,
    content: [{ type: "text", text: defaultText }],
    ...overrides,
  });
}

function successfulCall(contract, state, event, overrides = {}) {
  const called = transition(contract, state, event);
  assert.equal(called.decision, undefined, `${event.toolName}:${event.toolCallId}`);
  return toolResult(contract, called.state, event, overrides);
}

function recallCommand() {
  return 'bin/data-harness-cli wikis recall-debug --question "缺少品类维度" --json --doc-set specs';
}

function fetchCommand(contract) {
  return [
    "node .agents/pi/skills/html-report/scripts/fetch-explore.mjs",
    `--result '${contract.resultPath}'`,
    `--task-id '${contract.taskId}'`,
    `--payload-file '${contract.payloadPath}'`,
    `--goal '${contract.task.goal}'`,
    `--from-card-id '${contract.task.fromCardId}'`,
  ].join(" ");
}

function prepareCommand(contract) {
  return `node .agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs --result '${contract.resultPath}' --task-id '${contract.taskId}'`;
}

function newQueryStateThrough(contract, through) {
  const stages = [
    {
      name: "read",
      event: { toolCallId: "setup-read", toolName: "read", input: { path: contract.resultPath } },
    },
    {
      name: "recall",
      event: { toolCallId: "setup-recall", toolName: "bash", input: { command: recallCommand() } },
      result: { content: [{ type: "text", text: '{"contextFiles":[]}' }] },
    },
    {
      name: "write",
      event: {
        toolCallId: "setup-write",
        toolName: "write",
        input: { path: contract.payloadPath, content: "{}" },
      },
    },
    {
      name: "fetch",
      event: { toolCallId: "setup-fetch", toolName: "bash", input: { command: fetchCommand(contract) } },
    },
    {
      name: "prepare",
      event: { toolCallId: "setup-prepare", toolName: "bash", input: { command: prepareCommand(contract) } },
    },
  ];
  let state = initialResearcherGuardState();
  for (const stage of stages) {
    if (stage.name === through) return { state, event: stage.event };
    state = successfulCall(contract, state, stage.event, stage.result);
  }
  throw new Error(`unknown setup stage: ${through}`);
}

test("Researcher assignment parser derives exact paths and rejects conflicting authority", () => {
  const parsed = parseResearcherAssignment(assignment(), { projectRoot });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, "reuse_entry");
  assert.equal(parsed.evidencePath, join(session, "analysis", "evidence", "drill-001.json"));
  assert.equal(parsed.sectionPath, join(session, "analysis", "sections", "explore-drill-001.md"));
  assert.equal(parsed.summaryPath, join(session, "analysis", "sections", "explore-drill-001.summary.json"));

  const conflicting = parseResearcherAssignment(assignment("reuse_entry", { directMode: "new_query" }), { projectRoot });
  assert.equal(conflicting.ok, false);
  assert.match(conflicting.errors.join("\n"), /冲突/);

  const genericRules = parseResearcherAssignment(assignment("reuse_entry", { genericModeRules: true }), { projectRoot });
  assert.equal(genericRules.ok, true, genericRules.errors?.join("; "));
  assert.equal(genericRules.mode, "reuse_entry", "完整 task 对象是 mode 权威");

  const escaped = parseResearcherAssignment(assignment("reuse_entry", {
    evidencePath: "/tmp/drill-001.json",
  }), { projectRoot });
  assert.equal(escaped.ok, false);
  assert.match(escaped.errors.join("\n"), /evidencePath/);

  const unsafeId = parseResearcherAssignment(assignment("reuse_entry", { taskId: ".." }), { projectRoot });
  assert.equal(unsafeId.ok, false);
  assert.match(unsafeId.errors.join("\n"), /taskId/);

  const sanitizedId = "drill/a";
  const sanitized = parseResearcherAssignment(assignment("reuse_entry", {
    taskId: sanitizedId,
    evidencePath: join(session, "analysis", "evidence", "drill_a.json"),
  }), { projectRoot });
  assert.equal(sanitized.ok, true, sanitized.errors?.join("; "));
  assert.equal(sanitized.safeTaskId, "drill_a");
  assert.equal(sanitized.sectionPath, join(session, "analysis", "sections", "explore-drill_a.md"));

  const invalidRequirements = parseResearcherAssignment(assignment("reuse_entry", {
    task: {
      evidencePlan: { mode: "reuse_entry", operations: [{ id: "known" }] },
      analysisRequirements: [{
        id: "r1",
        question: "回答子问题",
        evidenceViewIds: ["missing"],
        targetRubric: ["R8"],
        minScore: 3,
      }],
    },
  }), { projectRoot });
  assert.equal(invalidRequirements.ok, false);
  assert.match(invalidRequirements.errors.join("\n"), /unknown evidencePlan operation.*R1-R7.*minScore/s);
});

test("reuse_entry permits one evidence read and one write per exact completion artifact", () => {
  const contract = parseResearcherAssignment(assignment(), { projectRoot });
  let state = initialResearcherGuardState();

  let result = transition(contract, state, { toolName: "bash", input: { command: "ls -la" } });
  assert.equal(result.decision.block, true);
  assert.match(result.decision.reason, /禁止所有 Bash/);

  result = transition(contract, state, { toolName: "read", input: { path: join(session, "result.json") } });
  assert.equal(result.decision.block, true);
  assert.match(result.decision.reason, /只能读取精确 evidencePath/);

  const evidenceRead = { toolCallId: "reuse-read", toolName: "read", input: { path: contract.evidencePath } };
  result = transition(contract, state, evidenceRead);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, evidenceRead);
  result = transition(contract, state, { toolName: "read", input: { path: contract.evidencePath } });
  assert.equal(result.decision.block, true);
  assert.match(result.decision.reason, /最多读取一次/);

  const sectionWrite = {
    toolCallId: "reuse-section",
    toolName: "write",
    input: { path: contract.sectionPath, content: validSection() },
  };
  result = transition(contract, state, sectionWrite);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, sectionWrite);
  result = transition(contract, state, { toolName: "write", input: { path: contract.sectionPath, content: "rewrite" } });
  assert.equal(result.decision.block, true);
  assert.match(result.decision.reason, /最多写一次/);

  const summaryWrite = {
    toolCallId: "reuse-summary",
    toolName: "write",
    input: { path: contract.summaryPath, content: JSON.stringify(validResearcherReturn(contract)) },
  };
  result = transition(contract, state, summaryWrite);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, summaryWrite);
  assert.equal(transition(contract, state, { toolName: "contact_supervisor", input: {} }).decision.block, true);
  assert.equal(
    transition(contract, state, { toolName: "structured_output", input: { value: validResearcherReturn(contract) } }).decision,
    undefined
  );
});

test("reuse_entry accepts the fixed section and summary as sibling writes", () => {
  const contract = parseResearcherAssignment(assignment(), { projectRoot });
  const evidenceRead = {
    toolCallId: "sibling-read",
    toolName: "read",
    input: { path: contract.evidencePath },
  };
  let state = successfulCall(contract, initialResearcherGuardState(), evidenceRead);

  const sectionWrite = {
    toolCallId: "sibling-section",
    toolName: "write",
    input: { path: contract.sectionPath, content: validSection() },
  };
  const sectionPreflight = transition(contract, state, sectionWrite);
  assert.equal(sectionPreflight.decision, undefined);

  const summaryWrite = {
    toolCallId: "sibling-summary",
    toolName: "write",
    input: {
      path: contract.summaryPath,
      content: JSON.stringify(validResearcherReturn(contract)),
    },
  };
  const summaryPreflight = transition(contract, sectionPreflight.state, summaryWrite);
  assert.equal(summaryPreflight.decision, undefined);

  // Parallel execution may finish in either order. The final contract remains
  // locked until both exact write results have succeeded.
  state = toolResult(contract, summaryPreflight.state, summaryWrite);
  state = toolResult(contract, state, sectionWrite);
  const final = transition(contract, state, {
    toolCallId: "sibling-final",
    toolName: "structured_output",
    input: { value: validResearcherReturn(contract) },
  });
  assert.equal(final.decision, undefined);
});

test("Researcher preflights section and summary content before the first filesystem write", () => {
  const contract = parseResearcherAssignment(assignment(), { projectRoot });
  const evidenceRead = {
    toolCallId: "preflight-read",
    toolName: "read",
    input: { path: contract.evidencePath },
  };

  let state = successfulCall(contract, initialResearcherGuardState(), evidenceRead, {
    content: [{
      type: "text",
      text: JSON.stringify({
        source: { empty: false, queryCoverage: {} },
        views: { comparison: { mean: 17.966 } },
      }),
    }],
  });
  const invalidSection = transition(contract, state, {
    toolCallId: "preflight-invalid-section",
    toolName: "write",
    input: {
      path: contract.sectionPath,
      content: "均值为 17.97。\n\n指标 | 值\n--- | ---\n均值 | 17.97\n\n`/views/comparison/mean`",
    },
  });
  assert.equal(invalidSection.decision.block, true);
  assert.match(invalidSection.decision.reason, /section 内容预检失败.*Markdown table.*17\.97/);
  assert.equal(invalidSection.state.writes[contract.sectionPath], undefined);
  assert.equal(invalidSection.state.terminalFailure.failedStep, "write");
  assert.equal(
    transition(contract, invalidSection.state, {
      toolCallId: "preflight-section-failed-final",
      toolName: "structured_output",
      input: { value: { status: "failed", error: "section preflight rejected" } },
    }).decision,
    undefined
  );

  state = successfulCall(contract, initialResearcherGuardState(), evidenceRead);
  const sectionWrite = {
    toolCallId: "preflight-valid-section",
    toolName: "write",
    input: { path: contract.sectionPath, content: validSection() },
  };
  state = successfulCall(contract, state, sectionWrite);
  const invalidSummary = {
    ...validResearcherReturn(contract),
    summary: "结论值为 11。",
  };
  const summaryDecision = transition(contract, state, {
    toolCallId: "preflight-invalid-summary",
    toolName: "write",
    input: { path: contract.summaryPath, content: JSON.stringify(invalidSummary) },
  });
  assert.equal(summaryDecision.decision.block, true);
  assert.match(summaryDecision.decision.reason, /summary 内容预检失败.*11/);
  assert.equal(summaryDecision.state.writes[contract.summaryPath], undefined);
  assert.equal(summaryDecision.state.terminalFailure.failedStep, "write");
});

test("Researcher guard requires requirement findings and validates per-finding evidence before writes", () => {
  const task = {
    evidencePlan: { mode: "reuse_entry", operations: [{ id: "sample" }] },
    analysisRequirements: [
      {
        id: "answer",
        question: "回答业务问题",
        evidenceViewIds: ["sample"],
        targetRubric: ["R3"],
      },
      {
        id: "boundary",
        question: "指出证据边界",
        evidenceViewIds: ["sample"],
        targetRubric: ["R5"],
        minScore: 2,
      },
    ],
  };
  const contract = parseResearcherAssignment(assignment("reuse_entry", { task }), { projectRoot });
  assert.equal(contract.ok, true, contract.errors?.join("; "));

  const evidenceRead = {
    toolCallId: "requirements-read",
    toolName: "read",
    input: { path: contract.evidencePath },
  };
  const sectionWrite = {
    toolCallId: "requirements-section",
    toolName: "write",
    input: { path: contract.sectionPath, content: validSection() },
  };

  let state = successfulCall(contract, initialResearcherGuardState(), evidenceRead);
  state = successfulCall(contract, state, sectionWrite);
  const missingFinding = validResearcherReturn(contract);
  missingFinding.findings = missingFinding.findings.slice(0, 1);
  const missingDecision = transition(contract, state, {
    toolCallId: "requirements-missing-summary",
    toolName: "write",
    input: { path: contract.summaryPath, content: JSON.stringify(missingFinding) },
  });
  assert.equal(missingDecision.decision.block, true);
  assert.match(missingDecision.decision.reason, /not covered.*boundary/);

  state = successfulCall(contract, initialResearcherGuardState(), evidenceRead);
  const invalidSectionWrite = {
    ...sectionWrite,
    toolCallId: "requirements-number-section",
    input: {
      path: contract.sectionPath,
      content: "结论值为 11。\n\n证据：`/views/sample/value`",
    },
  };
  const sectionDecision = transition(contract, state, invalidSectionWrite);
  assert.equal(sectionDecision.decision.block, true);
  assert.match(sectionDecision.decision.reason, /numbers absent.*11/);

  state = successfulCall(contract, initialResearcherGuardState(), evidenceRead);
  state = successfulCall(contract, state, sectionWrite);
  const validSummary = validResearcherReturn(contract);
  const validDecision = transition(contract, state, {
    toolCallId: "requirements-valid-summary",
    toolName: "write",
    input: { path: contract.summaryPath, content: JSON.stringify(validSummary) },
  });
  assert.equal(validDecision.decision, undefined);
});

test("current Researcher contract uses one typed findings submit instead of model-authored writes", () => {
  const task = {
    analysisContractVersion: 1,
    evidencePlan: { mode: "reuse_entry", operations: [{ id: "sample" }] },
    analysisRequirements: [{
      id: "answer",
      question: "回答业务问题",
      evidenceViewIds: ["sample"],
      targetRubric: ["R1"],
    }],
  };
  const contract = parseResearcherAssignment(assignment("reuse_entry", { task }), { projectRoot });
  assert.equal(contract.ok, true, contract.errors?.join("; "));
  const evidenceRead = {
    toolCallId: "typed-read",
    toolName: "read",
    input: { path: contract.evidencePath },
  };
  let state = successfulCall(contract, initialResearcherGuardState(), evidenceRead);

  const directWrite = transition(contract, state, {
    toolCallId: "typed-direct-write",
    toolName: "write",
    input: { path: contract.sectionPath, content: validSection() },
  });
  assert.equal(directWrite.decision.block, true);
  assert.match(directWrite.decision.reason, /必须调用 submit_research_findings/);

  const submit = {
    toolCallId: "typed-submit",
    toolName: "submit_research_findings",
    input: {
      findings: [{ requirementId: "answer", claim: "结论值为 10。", evidencePointers: ["/views/sample/value"] }],
      suggestedDeeper: [],
    },
  };
  const submittedCall = transition(contract, state, submit);
  assert.equal(submittedCall.decision, undefined);
  const researcherReturn = validResearcherReturn(contract);
  state = researcherToolResultState(contract, submittedCall.state, {
    toolName: submit.toolName,
    toolCallId: submit.toolCallId,
    isError: false,
    content: [{ type: "text", text: JSON.stringify(researcherReturn) }],
    details: { researcherReturn },
  });
  assert.equal(state.submitSuccess, 1);
  assert.equal(state.writeSuccess[contract.sectionPath], 1);
  assert.equal(state.writeSuccess[contract.summaryPath], 1);

  const final = transition(contract, state, {
    toolCallId: "typed-final",
    toolName: "structured_output",
    input: { value: researcherReturn },
  });
  assert.equal(final.decision, undefined);
});

test("duplicate read and write attempts terminally stop the run but preserve one failed final", () => {
  const contract = parseResearcherAssignment(assignment(), { projectRoot });

  const evidenceRead = {
    toolCallId: "duplicate-read-first",
    toolName: "read",
    input: { path: contract.evidencePath },
  };
  let state = successfulCall(contract, initialResearcherGuardState(), evidenceRead);
  let duplicate = transition(contract, state, {
    ...evidenceRead,
    toolCallId: "duplicate-read-second",
  });
  assert.equal(duplicate.decision.block, true);
  assert.equal(duplicate.state.terminalFailure.failedStep, "read");
  assert.equal(duplicate.state.structuredAttempts, 0);
  assert.match(duplicate.decision.reason, /终止/);
  assert.match(
    transition(contract, duplicate.state, {
      toolCallId: "after-duplicate-read",
      toolName: "write",
      input: { path: contract.sectionPath, content: "must not write" },
    }).decision.reason,
    /固定文件最多读取一次.*禁止后续 I\/O/
  );
  const readFailureFinal = transition(contract, duplicate.state, {
    toolCallId: "duplicate-read-final",
    toolName: "structured_output",
    input: { value: { status: "failed", error: "duplicate read" } },
  });
  assert.equal(readFailureFinal.decision, undefined);
  assert.equal(readFailureFinal.state.structuredAttempts, 1);
  assert.equal(
    transition(contract, readFailureFinal.state, {
      toolCallId: "duplicate-read-second-final",
      toolName: "structured_output",
      input: { value: { status: "failed", error: "duplicate read" } },
    }).decision.block,
    true
  );

  state = successfulCall(contract, initialResearcherGuardState(), evidenceRead);
  const sectionWrite = {
    toolCallId: "duplicate-write-first",
    toolName: "write",
    input: { path: contract.sectionPath, content: validSection() },
  };
  state = successfulCall(contract, state, sectionWrite);
  duplicate = transition(contract, state, {
    ...sectionWrite,
    toolCallId: "duplicate-write-second",
    input: { path: contract.sectionPath, content: "replacement section" },
  });
  assert.equal(duplicate.decision.block, true);
  assert.equal(duplicate.state.terminalFailure.failedStep, "write");
  assert.equal(duplicate.state.structuredAttempts, 0);
  assert.match(
    transition(contract, duplicate.state, {
      toolCallId: "after-duplicate-write",
      toolName: "write",
      input: { path: contract.summaryPath, content: "{}" },
    }).decision.reason,
    /禁止后续 I\/O/
  );
  const writeFailureFinal = transition(contract, duplicate.state, {
    toolCallId: "duplicate-write-final",
    toolName: "structured_output",
    input: { value: { status: "failed", error: "duplicate write" } },
  });
  assert.equal(writeFailureFinal.decision, undefined);
  assert.equal(writeFailureFinal.state.structuredAttempts, 1);
});

test("duplicate authorized commands terminally stop new_query without a command retry", () => {
  const contract = parseResearcherAssignment(assignment("new_query"), { projectRoot });
  const setup = newQueryStateThrough(contract, "recall");
  const first = transition(contract, setup.state, setup.event);
  assert.equal(first.decision, undefined);
  const duplicate = transition(contract, first.state, {
    ...setup.event,
    toolCallId: "duplicate-recall",
  });
  assert.equal(duplicate.decision.block, true);
  assert.equal(duplicate.state.terminalFailure.failedStep, "recall");
  assert.equal(duplicate.state.structuredAttempts, 0);
  assert.match(duplicate.decision.reason, /不允许失败重试/);
  assert.match(
    transition(contract, duplicate.state, {
      toolCallId: "after-duplicate-command",
      toolName: "read",
      input: { path: contract.resultPath },
    }).decision.reason,
    /禁止后续 I\/O/
  );
  const final = transition(contract, duplicate.state, {
    toolCallId: "duplicate-command-final",
    toolName: "structured_output",
    input: { value: { status: "failed", error: "duplicate recall" } },
  });
  assert.equal(final.decision, undefined);
  assert.equal(final.state.structuredAttempts, 1);
});

test("rejected early or illegal structured output becomes terminal without spending the failed final", () => {
  const contract = parseResearcherAssignment(assignment(), { projectRoot });

  for (const [label, value, reason] of [
    ["early ok", { status: "ok" }, /过早/],
    ["illegal status", { status: "complete" }, /status 必须/],
  ]) {
    const rejected = transition(contract, initialResearcherGuardState(), {
      toolCallId: `rejected-${label}`,
      toolName: "structured_output",
      input: { value },
    });
    assert.equal(rejected.decision.block, true, label);
    assert.match(rejected.decision.reason, reason, label);
    assert.equal(rejected.state.terminalFailure.failedStep, "structured_output", label);
    assert.equal(rejected.state.structuredAttempts, 0, label);
    assert.match(
      transition(contract, rejected.state, {
        toolCallId: `after-${label}`,
        toolName: "read",
        input: { path: contract.evidencePath },
      }).decision.reason,
      /禁止后续 I\/O/,
      label
    );

    const failedFinal = transition(contract, rejected.state, {
      toolCallId: `failed-${label}`,
      toolName: "structured_output",
      input: { value: { status: "failed", error: label } },
    });
    assert.equal(failedFinal.decision, undefined, label);
    assert.equal(failedFinal.state.structuredAttempts, 1, label);
  }
});

test("new_query keeps only the three prompt-authorized commands and fixed paths", () => {
  const contract = parseResearcherAssignment(assignment("new_query"), { projectRoot });
  assert.equal(contract.ok, true, contract.errors?.join("; "));
  let state = initialResearcherGuardState();

  for (const command of [
    "ls -la",
    "python3 -c 'print(1)'",
    "node -e 'console.log(1)'",
    "jq . result.json",
    "qdm-indicators-cli analysis execute --single-page",
    "bin/data-harness-cli wikis recall-debug --question x --json --doc-set specs && ls",
  ]) {
    assert.equal(transition(contract, state, { toolName: "bash", input: { command } }).decision.block, true, command);
  }

  const resultRead = { toolCallId: "result-read", toolName: "read", input: { path: contract.resultPath } };
  let result = transition(contract, state, resultRead);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, resultRead);

  const recall = 'bin/data-harness-cli wikis recall-debug --question "缺少品类维度" --json --doc-set specs';
  assert.deepEqual(classifyResearcherCommand(recall, contract), { kind: "recall" });
  result = transition(contract, state, { toolCallId: "recall-1", toolName: "bash", input: { command: recall } });
  assert.equal(result.decision, undefined);
  state = researcherToolResultState(contract, result.state, {
    toolCallId: "recall-1",
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: JSON.stringify({
      contextFiles: [
        { path: "wikis/metrics/经营分析/客流与客单/spec.md" },
        { path: "wikis/metrics/经营分析/销售额/spec.md" },
        { path: "wikis/metrics/经营分析/毛利额/spec.md" },
        { path: "wikis/reports/index.md" },
        { path: "/tmp/forged/spec.md" },
      ],
    }) }],
  });
  const recalledSpec = join(projectRoot, "wikis", "metrics", "经营分析", "客流与客单", "spec.md");
  const secondSpec = join(projectRoot, "wikis", "metrics", "经营分析", "销售额", "spec.md");
  const cappedSpec = join(projectRoot, "wikis", "metrics", "经营分析", "毛利额", "spec.md");
  assert.deepEqual(state.allowedSpecPaths, [recalledSpec, secondSpec]);
  const specRead = { toolCallId: "spec-read", toolName: "read", input: { path: recalledSpec } };
  result = transition(contract, state, specRead);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, specRead);
  assert.equal(
    transition(contract, state, { toolName: "read", input: { path: cappedSpec } }).decision.block,
    true,
    "at most two recalled Specs may consume the bounded new_query tool budget"
  );
  assert.equal(
    transition(contract, state, { toolName: "read", input: { path: join(projectRoot, "wikis", "reports", "index.md") } }).decision.block,
    true
  );

  const payloadWrite = {
    toolCallId: "payload-write",
    toolName: "write",
    input: { path: contract.payloadPath, content: "{}" },
  };
  result = transition(contract, state, payloadWrite);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, payloadWrite);
  const fetch = [
    "node .agents/pi/skills/html-report/scripts/fetch-explore.mjs",
    `--result '${contract.resultPath}'`,
    `--task-id '${contract.taskId}'`,
    `--payload-file '${contract.payloadPath}'`,
    `--goal '${contract.task.goal}'`,
    `--from-card-id '${contract.task.fromCardId}'`,
  ].join(" ");
  result = transition(contract, state, { toolCallId: "fetch-1", toolName: "bash", input: { command: fetch } });
  assert.equal(result.decision, undefined);
  state = result.state;
  assert.equal(transition(contract, state, { toolName: "bash", input: { command: fetch } }).decision.block, true);
  state = researcherToolResultState(contract, state, {
    toolCallId: "fetch-1",
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "fetch ok" }],
  });

  const prepare = `node .agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs --result '${contract.resultPath}' --task-id '${contract.taskId}'`;
  result = transition(contract, state, { toolCallId: "prepare-1", toolName: "bash", input: { command: prepare } });
  assert.equal(result.decision, undefined);
  state = result.state;
  assert.equal(
    transition(contract, state, { toolName: "read", input: { path: contract.evidencePath } }).decision.block,
    true,
    "calling prepare is insufficient until its tool result succeeds"
  );
  state = researcherToolResultState(contract, state, {
    toolCallId: "prepare-1",
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text: "prepare ok" }],
  });
  const evidenceRead = { toolCallId: "evidence-read", toolName: "read", input: { path: contract.evidencePath } };
  result = transition(contract, state, evidenceRead);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, evidenceRead);
  const sectionWrite = {
    toolCallId: "section-write",
    toolName: "write",
    input: { path: contract.sectionPath, content: validSection() },
  };
  result = transition(contract, state, sectionWrite);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, sectionWrite);
  assert.equal(transition(contract, state, { toolName: "write", input: { path: "/tmp/out.md", content: "x" } }).decision.block, true);
  const summaryWrite = {
    toolCallId: "summary-write",
    toolName: "write",
    input: { path: contract.summaryPath, content: JSON.stringify(validResearcherReturn(contract)) },
  };
  result = transition(contract, state, summaryWrite);
  assert.equal(result.decision, undefined);
  state = toolResult(contract, result.state, summaryWrite);
  assert.equal(
    transition(contract, state, { toolName: "structured_output", input: { value: validResearcherReturn(contract) } }).decision,
    undefined
  );
});

test("read, write, recall, fetch, and prepare failures terminally stop all I/O and retries", () => {
  const contract = parseResearcherAssignment(assignment("new_query"), { projectRoot });

  for (const failedStep of ["read", "recall", "write", "fetch", "prepare"]) {
    const setup = newQueryStateThrough(contract, failedStep);
    const called = transition(contract, setup.state, setup.event);
    assert.equal(called.decision, undefined, failedStep);
    const failed = toolResult(contract, called.state, setup.event, {
      isError: true,
      content: [{ type: "text", text: `${failedStep} exploded` }],
    });
    assert.deepEqual(failed.terminalFailure, {
      failedStep,
      error: `${failedStep} exploded`,
    });

    for (const [toolName, input] of [
      ["read", { path: contract.resultPath }],
      ["write", { path: contract.payloadPath, content: "retry" }],
      ["bash", { command: recallCommand() }],
    ]) {
      const blocked = transition(contract, failed, {
        toolCallId: `after-${failedStep}-${toolName}`,
        toolName,
        input,
      });
      assert.equal(blocked.decision.block, true, `${failedStep}:${toolName}`);
      assert.match(blocked.decision.reason, /禁止后续 I\/O、命令或重试/);
    }

    const retry = transition(contract, failed, {
      ...setup.event,
      toolCallId: `${setup.event.toolCallId}-retry`,
    });
    assert.equal(retry.decision.block, true, `${failedStep}:retry`);
    assert.match(retry.decision.reason, /失败终止/);

    for (const status of ["needs_evidence_plan", "needs_new_query", "ok"]) {
      const disguised = transition(contract, failed, {
        toolCallId: `${failedStep}-${status}`,
        toolName: "structured_output",
        input: { value: { status, evidenceGap: { type: "field_mismatch", reason: "EVIDENCE_FIELD_MISMATCH" } } },
      });
      assert.equal(disguised.decision.block, true, `${failedStep}:${status}`);
      assert.match(disguised.decision.reason, /失败后只能返回 status=failed/);
    }

    const final = transition(contract, failed, {
      toolCallId: `${failedStep}-final`,
      toolName: "structured_output",
      input: { value: { status: "failed", error: `${failedStep} exploded` } },
    });
    assert.equal(final.decision, undefined, `${failedStep}:final`);
    assert.equal(final.state.structuredAttempts, 1);
    assert.equal(
      transition(contract, final.state, {
        toolName: "structured_output",
        input: { value: { status: "failed" } },
      }).decision.block,
      true,
      `${failedStep}:second-final`
    );
  }
});

test("only an exact prepare EVIDENCE_FIELD_MISMATCH may end as needs_evidence_plan", () => {
  const contract = parseResearcherAssignment(assignment("new_query"), { projectRoot });
  const setup = newQueryStateThrough(contract, "prepare");
  const called = transition(contract, setup.state, setup.event);
  assert.equal(called.decision, undefined);
  const mismatch = {
    ok: false,
    code: "EVIDENCE_FIELD_MISMATCH",
    taskId: contract.taskId,
    availableFields: ["日期", "门店毛利额"],
    missingFields: [
      { field: "来客数", references: ["evidencePlan.operations[0].fields"] },
      { field: "客单价", references: ["evidencePlan.requiredColumns"] },
    ],
  };
  const failed = toolResult(contract, called.state, setup.event, {
    details: { exitCode: 1 },
    content: [{ type: "text", text: JSON.stringify(mismatch, null, 2) }],
  });
  assert.deepEqual(failed.terminalFailure.evidenceFieldMismatch, {
    availableFields: mismatch.availableFields,
    missingFields: mismatch.missingFields,
  });

  const exactGap = {
    type: "field_mismatch",
    reason: "EVIDENCE_FIELD_MISMATCH",
    // Ordering is not authority; completeness is. Both arrays may be emitted
    // in a different stable order without losing a field or reference.
    availableFields: [...mismatch.availableFields].reverse(),
    missingFields: [...mismatch.missingFields].reverse(),
  };
  const accepted = transition(contract, failed, {
    toolName: "structured_output",
    input: { value: { status: "needs_evidence_plan", evidenceGap: exactGap } },
  });
  assert.equal(accepted.decision, undefined);

  for (const [label, value] of [
    ["wrong status", { status: "needs_new_query", evidenceGap: exactGap }],
    ["missing available field", {
      status: "needs_evidence_plan",
      evidenceGap: { ...exactGap, availableFields: ["日期"] },
    }],
    ["missing field entry", {
      status: "needs_evidence_plan",
      evidenceGap: { ...exactGap, missingFields: [mismatch.missingFields[0]] },
    }],
    ["missing reference", {
      status: "needs_evidence_plan",
      evidenceGap: {
        ...exactGap,
        missingFields: mismatch.missingFields.map((item, index) =>
          index === 0 ? { ...item, references: ["different.reference"] } : item
        ),
      },
    }],
  ]) {
    const rejected = transition(contract, failed, {
      toolName: "structured_output",
      input: { value },
    });
    assert.equal(rejected.decision.block, true, label);
    assert.match(rejected.decision.reason, /完整字段清单精确一致/);
  }

  assert.equal(
    transition(contract, failed, {
      toolName: "structured_output",
      input: { value: { status: "failed", error: "EVIDENCE_FIELD_MISMATCH" } },
    }).decision,
    undefined,
    "the ordinary failed branch remains legal for the same prepare error"
  );
});

test("contract terminal failures can only end as failed", () => {
  const contract = parseResearcherAssignment(assignment(), { projectRoot });
  const terminal = {
    ...initialResearcherGuardState(),
    terminalFailure: { failedStep: "contract", error: "contract violation" },
  };
  assert.equal(
    transition(contract, terminal, {
      toolName: "structured_output",
      input: { value: { status: "needs_evidence_plan", evidenceGap: {} } },
    }).decision.block,
    true
  );
  assert.equal(
    transition(contract, terminal, {
      toolName: "structured_output",
      input: { value: { status: "failed", error: "contract violation" } },
    }).decision,
    undefined
  );
});

test("nonzero exitCode, code, and statusCode each count as a terminal tool failure", () => {
  const contract = parseResearcherAssignment(assignment("new_query"), { projectRoot });
  for (const [key, value] of [
    ["exitCode", 1],
    ["code", "ENOENT"],
    ["statusCode", 503],
  ]) {
    const event = {
      toolCallId: `nonzero-${key}`,
      toolName: "read",
      input: { path: contract.resultPath },
    };
    const called = transition(contract, initialResearcherGuardState(), event);
    assert.equal(called.decision, undefined);
    const failed = toolResult(contract, called.state, event, {
      details: { [key]: value },
      content: [{ type: "text", text: `${key}=${value}` }],
    });
    assert.equal(failed.terminalFailure.failedStep, "read", key);
    assert.match(failed.terminalFailure.error, new RegExp(key));
    assert.equal(failed.readSuccess[contract.resultPath], undefined);
  }
});

test("dependencies advance only on matching successful tool results", () => {
  const contract = parseResearcherAssignment(assignment("new_query"), { projectRoot });
  const readEvent = { toolCallId: "pending-result", toolName: "read", input: { path: contract.resultPath } };
  let called = transition(contract, initialResearcherGuardState(), readEvent);
  assert.equal(called.decision, undefined);
  const wrongResult = toolResult(contract, called.state, { ...readEvent, toolCallId: "wrong-result-id" });
  assert.equal(wrongResult.readSuccess[contract.resultPath], undefined, "a different toolCallId cannot satisfy the read");
  const wrongTool = toolResult(contract, wrongResult, { ...readEvent, toolName: "write" });
  assert.equal(wrongTool.readSuccess[contract.resultPath], undefined, "a different tool type cannot satisfy the read");
  assert.equal(
    transition(contract, wrongTool, {
      toolCallId: "early-recall",
      toolName: "bash",
      input: { command: recallCommand() },
    }).decision.block,
    true,
    "a read attempt is not a successful read"
  );
  let state = toolResult(contract, wrongTool, readEvent);

  const recallEvent = { toolCallId: "pending-recall", toolName: "bash", input: { command: recallCommand() } };
  called = transition(contract, state, recallEvent);
  assert.equal(called.decision, undefined);
  assert.equal(
    transition(contract, called.state, {
      toolCallId: "early-payload",
      toolName: "write",
      input: { path: contract.payloadPath, content: "{}" },
    }).decision.block,
    true,
    "a recall attempt is not a successful recall"
  );
  state = toolResult(contract, called.state, recallEvent, {
    content: [{ type: "text", text: '{"contextFiles":[]}' }],
  });

  const payloadEvent = {
    toolCallId: "pending-payload",
    toolName: "write",
    input: { path: contract.payloadPath, content: "{}" },
  };
  called = transition(contract, state, payloadEvent);
  assert.equal(called.decision, undefined);
  assert.equal(
    transition(contract, called.state, {
      toolCallId: "early-fetch",
      toolName: "bash",
      input: { command: fetchCommand(contract) },
    }).decision.block,
    true,
    "a write attempt is not a successful write"
  );
});

test("needs_* and failed are legal early exits, while every final is one-shot and terminal", () => {
  const contract = parseResearcherAssignment(assignment(), { projectRoot });
  for (const status of ["needs_evidence_plan", "needs_new_query", "failed"]) {
    const final = transition(contract, initialResearcherGuardState(), {
      toolCallId: `final-${status}`,
      toolName: "structured_output",
      input: { value: { status } },
    });
    assert.equal(final.decision, undefined, status);
    assert.equal(final.state.structuredAttempts, 1);

    const afterFinal = transition(contract, final.state, {
      toolCallId: `after-final-${status}`,
      toolName: "read",
      input: { path: contract.evidencePath },
    });
    assert.equal(afterFinal.decision.block, true, status);
    assert.match(afterFinal.decision.reason, /structured_output 已调用/);
    assert.equal(
      transition(contract, final.state, {
        toolName: "structured_output",
        input: { value: { status } },
      }).decision.block,
      true,
      status
    );
  }
});

test("malformed assignments fail closed but still permit a structured failure return", () => {
  const contract = parseResearcherAssignment("taskId=x", { projectRoot });
  assert.equal(contract.ok, false);
  const state = initialResearcherGuardState();
  for (const toolName of ["read", "write", "bash", "edit", "find", "intercom"]) {
    assert.equal(transition(contract, state, { toolName, input: {} }).decision.block, true);
  }
  assert.equal(
    transition(contract, state, {
      toolName: "structured_output",
      input: { value: { status: "failed", error: "invalid assignment" } },
    }).decision,
    undefined
  );
});

test("structured-output capture validates the parent-owned schema pair and never overwrites", async (t) => {
  const base = join(projectRoot, ".harness", "test-runtime-capture-");
  await mkdir(join(projectRoot, ".harness"), { recursive: true });
  const runtimeDir = await mkdtemp(base);
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const schemaPath = join(runtimeDir, "schema.json");
  const outputPath = join(runtimeDir, "output.json");
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { status: { const: "ok" } },
    required: ["status"],
  };
  await writeFile(schemaPath, JSON.stringify(schema));
  const env = {
    [STRUCTURED_OUTPUT_SCHEMA_ENV]: schemaPath,
    [STRUCTURED_OUTPUT_CAPTURE_ENV]: outputPath,
  };
  await prepareStructuredOutputCapture(schema, env);
  await writeFile(outputPath, JSON.stringify({ status: "ok" }));
  await assert.rejects(() => prepareStructuredOutputCapture(schema, env), /already exists/);

  const mismatchDir = await mkdtemp(base);
  t.after(() => rm(mismatchDir, { recursive: true, force: true }));
  const mismatchSchemaPath = join(mismatchDir, "schema.json");
  await writeFile(mismatchSchemaPath, JSON.stringify({ type: "null" }));
  await assert.rejects(
    () => prepareStructuredOutputCapture(schema, {
      [STRUCTURED_OUTPUT_SCHEMA_ENV]: mismatchSchemaPath,
      [STRUCTURED_OUTPUT_CAPTURE_ENV]: join(mismatchDir, "output.json"),
    }),
    /does not match/
  );
  await assert.rejects(() => prepareStructuredOutputCapture(schema, {}), /unavailable/);
});

test("typed findings submit writes artifacts and hands off official structured_output", async (t) => {
  const stateRoot = join(projectRoot, ".harness", "state", "html-report");
  await mkdir(stateRoot, { recursive: true });
  const typedSession = await mkdtemp(join(stateRoot, "typed-terminal-test-"));
  const runtimeDir = await mkdtemp(join(projectRoot, ".harness", "typed-terminal-runtime-"));
  t.after(() => rm(typedSession, { recursive: true, force: true }));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));

  const taskId = "typed-terminal";
  const task = {
    analysisContractVersion: 1,
    evidencePlan: {
      mode: "reuse_entry",
      operations: [{ id: "sample", type: "project" }],
    },
    analysisRequirements: [{
      id: "answer",
      question: "回答业务问题",
      evidenceViewIds: ["sample"],
      targetRubric: ["R1"],
    }],
  };
  const prompt = assignment("reuse_entry", {
    taskId,
    session: typedSession,
    resultPath: join(typedSession, "result.json"),
    evidencePath: join(typedSession, "analysis", "evidence", `${taskId}.json`),
    task,
  });
  const contract = parseResearcherAssignment(prompt, { projectRoot });
  assert.equal(contract.ok, true, contract.errors?.join("; "));
  const expected = {
    taskId: contract.taskId,
    mode: contract.mode,
    evidencePath: contract.evidencePath,
    sectionPath: contract.sectionPath,
    summaryPath: contract.summaryPath,
    task: contract.task,
    analysisRequirements: contract.task.analysisRequirements,
  };
  const schemaPath = join(runtimeDir, "schema.json");
  const outputPath = join(runtimeDir, "output.json");
  await writeFile(schemaPath, JSON.stringify(buildResearcherReturnSchema(expected)));

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
  const registeredTools = [];
  const activeToolSets = [];
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      registeredTools.push(tool);
    },
    setActiveTools(names) {
      activeToolSets.push(names);
    },
  };
  registerReportResearcherGuard(pi);
  const start = await handlers.get("before_agent_start")[0]({
    prompt,
    systemPrompt: "ordinary long Researcher prompt",
  });
  assert.match(start.systemPrompt, /submit_research_findings[\s\S]*structured_output exactly once/);
  assert.doesNotMatch(start.systemPrompt, /ordinary long Researcher prompt/);

  const readEvent = {
    toolCallId: "typed-terminal-read",
    toolName: "read",
    input: { path: contract.evidencePath },
  };
  assert.equal(await handlers.get("tool_call")[0](readEvent), undefined);
  await handlers.get("tool_result")[0]({
    ...readEvent,
    isError: false,
    content: [{
      type: "text",
      text: JSON.stringify({
        taskId,
        evidenceMode: "reuse_entry",
        source: { empty: false, queryCoverage: {} },
        views: {
          sample: {
            type: "project",
            matchedRows: 1,
            returnedRows: 1,
            rows: [{ sourcePointer: "/0", row: { value: 10 } }],
          },
        },
      }),
    }],
  });
  const params = {
    findings: [{
      requirementId: "answer",
      claim: "结论值为 10。",
      evidencePointers: ["/views/sample"],
    }],
    suggestedDeeper: [],
  };
  assert.equal(await handlers.get("tool_call")[0]({
    toolCallId: "typed-terminal-submit",
    toolName: "submit_research_findings",
    input: params,
  }), undefined);
  const result = await registeredTools[0].execute("typed-terminal-submit", params);
  assert.equal(result.terminate, false);
  assert.match(result.content[0].text, /structured_output exactly once/);
  assert.deepEqual(activeToolSets.at(-1), ["structured_output"]);
  await assert.rejects(() => readFile(outputPath, "utf8"), /ENOENT/);
  const summary = JSON.parse(await readFile(contract.summaryPath, "utf8"));
  assert.deepEqual(summary, result.details.researcherReturn);
  assert.deepEqual(result.details.value, result.details.researcherReturn);
  assert.match(await readFile(contract.sectionPath, "utf8"), /结论值为 10。/);
});

test("a schema-invalid first typed submit is consumed and cannot be corrected in the same assignment", async (t) => {
  const stateRoot = join(projectRoot, ".harness", "state", "html-report");
  await mkdir(stateRoot, { recursive: true });
  const typedSession = await mkdtemp(join(stateRoot, "typed-schema-failure-"));
  t.after(() => rm(typedSession, { recursive: true, force: true }));
  const taskId = "typed-schema-failure";
  const prompt = assignment("reuse_entry", {
    taskId,
    session: typedSession,
    resultPath: join(typedSession, "result.json"),
    evidencePath: join(typedSession, "analysis", "evidence", `${taskId}.json`),
    task: {
      analysisContractVersion: 1,
      evidencePlan: { mode: "reuse_entry", operations: [{ id: "sample" }] },
      analysisRequirements: [{
        id: "answer",
        question: "回答业务问题",
        evidenceViewIds: ["sample"],
        targetRubric: ["R1"],
      }],
    },
  });
  const contract = parseResearcherAssignment(prompt, { projectRoot });
  assert.equal(contract.ok, true, contract.errors?.join("; "));

  const failedState = researcherUnvalidatedSubmitFailureState(
    contract,
    initialResearcherGuardState(),
    {
      toolCallId: "invalid-submit",
      toolName: "submit_research_findings",
      isError: true,
      result: {
        content: [{ type: "text", text: "arguments failed schema validation" }],
      },
    }
  );
  assert.equal(failedState.submitAttempts, 1);
  assert.equal(failedState.terminalFailure?.error, "arguments failed schema validation");

  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    setActiveTools() {},
  };
  registerReportResearcherGuard(pi);
  await handlers.get("before_agent_start")[0]({ prompt, systemPrompt: "ordinary prompt" });

  const readEvent = {
    toolCallId: "schema-failure-read",
    toolName: "read",
    input: { path: contract.evidencePath },
  };
  assert.equal(await handlers.get("tool_call")[0](readEvent), undefined);
  await handlers.get("tool_result")[0]({
    ...readEvent,
    isError: false,
    content: [{
      type: "text",
      text: JSON.stringify({
        taskId,
        evidenceMode: "reuse_entry",
        source: { empty: false, queryCoverage: {} },
        views: { sample: { value: 10 } },
      }),
    }],
  });

  // Pi emits this event even when strict tool-argument validation rejects the
  // call before the tool_call hook. That first malformed attempt is terminal.
  await handlers.get("tool_execution_end")[0]({
    toolCallId: "schema-invalid-submit",
    toolName: "submit_research_findings",
    isError: true,
    result: { content: [{ type: "text", text: "arguments failed schema validation" }] },
  });

  const corrected = await handlers.get("tool_call")[0]({
    toolCallId: "corrected-submit",
    toolName: "submit_research_findings",
    input: {
      findings: [{
        requirementId: "answer",
        claim: "结论值为 10。",
        evidencePointers: ["/views/sample"],
      }],
      suggestedDeeper: [],
    },
  });
  assert.equal(corrected.block, true);
  assert.match(corrected.reason, /首次提交机会已消费|失败终止/);

  const invalidOk = await handlers.get("tool_call")[0]({
    toolCallId: "invalid-ok-after-schema-failure",
    toolName: "structured_output",
    input: { value: { status: "ok" } },
  });
  assert.equal(invalidOk.block, true);
  assert.match(invalidOk.reason, /只能返回 status=failed/);

  assert.equal(await handlers.get("tool_call")[0]({
    toolCallId: "failed-after-schema-failure",
    toolName: "structured_output",
    input: { value: { status: "failed", error: "typed submit arguments were invalid" } },
  }), undefined);
  await assert.rejects(readFile(contract.sectionPath, "utf8"), (error) => error.code === "ENOENT");
  await assert.rejects(readFile(contract.summaryPath, "utf8"), (error) => error.code === "ENOENT");
});

test("unvalidated typed-submit failures do not poison admitted, legacy, or already-terminal flows", () => {
  const currentContract = parseResearcherAssignment(assignment("reuse_entry", {
    task: {
      analysisContractVersion: 1,
      evidencePlan: { mode: "reuse_entry", operations: [{ id: "sample" }] },
      analysisRequirements: [{
        id: "answer",
        question: "回答业务问题",
        evidenceViewIds: ["sample"],
        targetRubric: ["R1"],
      }],
    },
  }), { projectRoot });
  assert.equal(currentContract.ok, true, currentContract.errors?.join("; "));
  const executionError = {
    toolCallId: "schema-invalid-submit",
    toolName: "submit_research_findings",
    isError: true,
    result: { content: [{ type: "text", text: `validation:${"x".repeat(1600)}` }] },
  };

  const consumed = researcherUnvalidatedSubmitFailureState(
    currentContract,
    initialResearcherGuardState(),
    executionError
  );
  assert.equal(consumed.submitAttempts, 1);
  assert.equal(consumed.terminalFailure.failedStep, "write");
  assert.equal(consumed.terminalFailure.error.length, 1200, "validation errors are bounded");

  const evidenceRead = {
    toolCallId: "admitted-read",
    toolName: "read",
    input: { path: currentContract.evidencePath },
  };
  const evidenceReady = successfulCall(
    currentContract,
    initialResearcherGuardState(),
    evidenceRead
  );
  const admitted = transition(currentContract, evidenceReady, {
    toolCallId: "admitted-submit",
    toolName: "submit_research_findings",
    input: {
      findings: [{
        requirementId: "answer",
        claim: "结论值为 10。",
        evidencePointers: ["/views/sample/value"],
      }],
      suggestedDeeper: [],
    },
  });
  assert.equal(admitted.decision, undefined);
  assert.equal(admitted.state.submitAttempts, 1);
  assert.strictEqual(
    researcherUnvalidatedSubmitFailureState(currentContract, admitted.state, {
      ...executionError,
      toolCallId: "admitted-submit",
    }),
    admitted.state,
    "an admitted submit error is owned by the ordinary tool-result transition"
  );

  const legacyContract = parseResearcherAssignment(assignment("reuse_entry"), { projectRoot });
  assert.equal(legacyContract.ok, true, legacyContract.errors?.join("; "));
  const legacyInitial = initialResearcherGuardState();
  assert.strictEqual(
    researcherUnvalidatedSubmitFailureState(legacyContract, legacyInitial, executionError),
    legacyInitial,
    "legacy assignments must not inherit the typed-submit terminal contract"
  );
  const legacyReady = successfulCall(legacyContract, legacyInitial, {
    toolCallId: "legacy-read-after-unrelated-submit-error",
    toolName: "read",
    input: { path: legacyContract.evidencePath },
  });
  assert.equal(transition(legacyContract, legacyReady, {
    toolCallId: "legacy-section-after-unrelated-submit-error",
    toolName: "write",
    input: { path: legacyContract.sectionPath, content: validSection() },
  }).decision, undefined);

  const premature = transition(currentContract, initialResearcherGuardState(), {
    toolCallId: "premature-submit",
    toolName: "submit_research_findings",
    input: { findings: [], suggestedDeeper: [] },
  });
  assert.equal(premature.decision?.block, true);
  const originalFailure = premature.state.terminalFailure;
  assert.strictEqual(
    researcherUnvalidatedSubmitFailureState(currentContract, premature.state, {
      ...executionError,
      toolCallId: "premature-submit",
    }),
    premature.state
  );
  assert.strictEqual(premature.state.terminalFailure, originalFailure);

  const completed = { ...initialResearcherGuardState(), structuredAttempts: 1 };
  assert.strictEqual(
    researcherUnvalidatedSubmitFailureState(currentContract, completed, executionError),
    completed,
    "a completed structured branch remains immutable"
  );
});

test("current new_query gets a compact complete acquisition prompt before typed submission", async () => {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    setActiveTools() {},
  };
  registerReportResearcherGuard(pi);
  const prompt = assignment("new_query", {
    task: {
      analysisContractVersion: 1,
      evidencePlan: { mode: "new_query", operations: [{ id: "sample" }] },
      analysisRequirements: [{
        id: "answer",
        question: "回答新增证据问题",
        evidenceViewIds: ["sample"],
        targetRubric: ["R1"],
      }],
    },
  });
  const fullPrompt = await readFile(
    join(projectRoot, ".agents", "pi", "agents", "report-researcher.md"),
    "utf8"
  );
  assert.match(fullPrompt, /recall-debug[\s\S]*--doc-set specs/);
  assert.match(fullPrompt, /fetch-explore\.mjs/);
  assert.match(fullPrompt, /prepare-research-evidence\.mjs/);
  assert.match(fullPrompt, /submit_research_findings/);
  const result = await handlers.get("before_agent_start")[0]({
    prompt,
    systemPrompt: fullPrompt,
  });
  assert.match(result.systemPrompt, /Read the assigned absolute result\.json exactly once/);
  assert.match(result.systemPrompt, /recall-debug[\s\S]*--doc-set specs/);
  assert.match(result.systemPrompt, /fetch-explore\.mjs[\s\S]*--payload-file/);
  assert.match(result.systemPrompt, /prepare-research-evidence\.mjs/);
  assert.match(result.systemPrompt, /submit_research_findings[\s\S]*structured_output exactly once/);
  assert.match(result.systemPrompt, /do not retry or repair/);
  assert.doesNotMatch(result.systemPrompt, /The summary JSON file is not a reduced summary record/);
});

test("runtime report-researcher mounts only its child guard extension", async () => {
  const runtime = await readFile(join(projectRoot, ".pi", "agents", "report-researcher.md"), "utf8");
  assert.match(runtime, /^extensions:\s*$/m);
  assert.match(
    runtime,
    /^subagentOnlyExtensions:\s*\.agents\/pi\/extensions\/report-researcher-guard\/index\.mjs$/m
  );
  assert.match(runtime, /^tools:.*submit_research_findings/m);
});

test("Editor Planner guard mode allows one structured output and blocks all data/file tools", () => {
  const contract = parseEditorPlannerGuardAssignment(plannerAssignment(), { projectRoot });
  assert.equal(contract.ok, true);
  assert.equal(contract.kind, "editor_plan");
  let state = initialResearcherGuardState();
  for (const event of [
    { toolName: "read", input: { path: join(session, "result.json") } },
    { toolName: "bash", input: { command: "true" } },
    { toolName: "write", input: { path: join(session, "analysis", "tasks.json"), content: "{}" } },
    { toolName: "submit_research_findings", input: { findings: [], suggestedDeeper: [] } },
  ]) {
    const blocked = transition(contract, state, event);
    assert.equal(blocked.decision?.block, true);
    assert.match(blocked.decision?.reason || "", /只允许一次 structured_output/);
    assert.deepEqual(blocked.state, state, "blocked Planner calls must not consume its final allowance");
  }
  const submitted = transition(contract, state, {
    toolName: "structured_output",
    input: { value: { version: 1, tasks: [], noDeeperReason: "无需继续" } },
  });
  assert.equal(submitted.decision, undefined);
  state = submitted.state;
  assert.equal(state.structuredAttempts, 1);
  assert.equal(transition(contract, state, {
    toolName: "structured_output",
    input: { value: { version: 1, tasks: [], noDeeperReason: "重复" } },
  }).decision?.block, true);
  assert.equal(transition(contract, state, {
    toolName: "read",
    input: { path: join(session, "result.json") },
  }).decision?.block, true);
});

test("child extension replaces the long Researcher system prompt for explicit Planner mode", async () => {
  const handlers = new Map();
  const activeToolSets = [];
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    setActiveTools(tools) {
      activeToolSets.push(tools);
    },
  };
  registerReportResearcherGuard(pi);
  const piWrappedAssignment = `Task: ${plannerAssignment()}`;
  const result = await handlers.get("before_agent_start")[0]({
    prompt: piWrappedAssignment,
    systemPrompt: "very long ordinary Researcher prompt",
  });
  assert.match(result.systemPrompt, /Editor Planner/);
  assert.doesNotMatch(result.systemPrompt, /very long ordinary Researcher prompt/);
  assert.match(result.systemPrompt, /structured_output exactly once/);
  assert.deepEqual(activeToolSets, [["structured_output"]]);

  const blocked = await handlers.get("tool_call")[0]({
    toolName: "read",
    input: { path: join(session, "result.json") },
  });
  assert.equal(blocked.block, true);
  const allowed = await handlers.get("tool_call")[0]({
    toolName: "structured_output",
    input: { value: { version: 1, tasks: [], noDeeperReason: "无需继续" } },
  });
  assert.equal(allowed, undefined);
});

test("child extension discovers Pi's Task-wrapped Planner assignment from the real session branch", async () => {
  const handlers = new Map();
  const activeToolSets = [];
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    setActiveTools(tools) {
      activeToolSets.push(tools);
    },
  };
  registerReportResearcherGuard(pi);
  const task = `Task: ${plannerAssignment()}`;
  const result = await handlers.get("before_agent_start")[0](
    { systemPrompt: "very long ordinary Researcher prompt" },
    {
      sessionManager: {
        getBranch() {
          return [{
            type: "message",
            message: { role: "user", content: [{ type: "text", text: task }] },
          }];
        },
      },
    }
  );
  assert.match(result.systemPrompt, /Editor Planner/);
  assert.doesNotMatch(result.systemPrompt, /very long ordinary Researcher prompt/);
  assert.deepEqual(activeToolSets, [["structured_output"]]);
  assert.equal(await handlers.get("tool_call")[0]({
    toolName: "structured_output",
    input: { value: { version: 1, tasks: [], noDeeperReason: "无需继续" } },
  }), undefined);
});

test("child extension recognizes a long Planner task from Pi's temporary file wrapper at context time", async () => {
  const handlers = new Map();
  const activeToolSets = [];
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    setActiveTools(tools) {
      activeToolSets.push(tools);
    },
  };
  registerReportResearcherGuard(pi);
  await handlers.get("before_agent_start")[0]({ systemPrompt: "Report Researcher runtime" });
  const wrapped = `<file name="/tmp/task.md">\nTask: ${plannerAssignment()}\n</file>`;
  await handlers.get("context")[0]({
    messages: [{ role: "user", content: [{ type: "text", text: wrapped }] }],
  });
  assert.deepEqual(activeToolSets, [["structured_output"]]);
  const blocked = await handlers.get("tool_call")[0]({
    toolName: "read",
    input: { path: join(session, "result.json") },
  });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /只允许一次 structured_output/);
  assert.equal(await handlers.get("tool_call")[0]({
    toolName: "structured_output",
    input: { value: { version: 1, tasks: [], noDeeperReason: "无需继续" } },
  }), undefined);
});

test("child extension captures the assignment from context after a system-only start event", async () => {
  const handlers = new Map();
  const registeredTools = [];
  const activeToolSets = [];
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      registeredTools.push(tool);
    },
    setActiveTools(tools) {
      activeToolSets.push(tools);
    },
  };
  registerReportResearcherGuard(pi);
  assert.deepEqual(registeredTools.map((tool) => tool.name), ["submit_research_findings"]);
  assert.equal(handlers.get("before_agent_start").length, 1);
  assert.equal(handlers.get("context").length, 1);

  await handlers.get("before_agent_start")[0]({ systemPrompt: "Report Researcher runtime" });
  let decision = await handlers.get("tool_call")[0]({
    toolName: "read",
    input: { path: join(session, "analysis", "evidence", "drill-001.json") },
  });
  assert.equal(decision.block, true, "tools must remain fail closed before child context arrives");

  const prompt = assignment();
  await handlers.get("context")[0]({
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  assert.deepEqual(activeToolSets, [], "ordinary B3 Researcher keeps its declared read/query/submit tools");
  decision = await handlers.get("tool_call")[0]({
    toolName: "read",
    input: { path: join(session, "analysis", "evidence", "drill-001.json") },
  });
  assert.equal(decision, undefined);

  // Pi may call context again before the next model turn. The identical task
  // must not reset the one-shot evidence read counter.
  await handlers.get("context")[0]({
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  decision = await handlers.get("tool_call")[0]({
    toolName: "read",
    input: { path: join(session, "analysis", "evidence", "drill-001.json") },
  });
  assert.equal(decision.block, true);
  assert.match(decision.reason, /最多读取一次/);

  decision = await handlers.get("tool_call")[0]({
    toolName: "write",
    input: { path: join(session, "analysis", "sections", "explore-drill-001.md"), content: "retry" },
  });
  assert.equal(decision.block, true);
  assert.match(decision.reason, /失败终止/);

  decision = await handlers.get("tool_call")[0]({
    toolName: "structured_output",
    input: { value: { status: "failed", error: "duplicate read" } },
  });
  assert.equal(decision, undefined, "the runtime hook preserves one failed structured final after termination");

  decision = await handlers.get("tool_call")[0]({
    toolName: "structured_output",
    input: { value: { status: "failed", error: "duplicate read" } },
  });
  assert.equal(decision.block, true);
  assert.match(decision.reason, /最多调用一次/);
});
