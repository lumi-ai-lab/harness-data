import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  classifyDesignerCommand,
  designerToolDecision,
  designerToolResultState,
  initialDesignerGuardState,
  parseDesignerAssignment,
} from "../../../extensions/report-designer-guard/guard.mjs";
import registerReportDesignerGuard from "../../../extensions/report-designer-guard/index.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
const sessionDir = join(projectRoot, ".harness", "state", "html-report", "designer-guard-test");

function assignment(overrides = {}) {
  const session = overrides.sessionDir || sessionDir;
  const resultPath = overrides.resultPath || join(session, "result.json");
  const lines = [
    "B5 Report Designer fixed assignment",
    `SESSION=${session}`,
    `result.json=${resultPath}`,
  ];
  if (overrides.extra) lines.push(overrides.extra);
  return lines.join("\n");
}

function command(contract, kind) {
  const base = `node .agents/pi/skills/html-report/scripts/${{
    compile: "compile-report-content.mjs",
    compose: "compose-report.mjs",
    capture: "capture-report.mjs",
    finalize: "finalize-design.mjs",
    layout: "check-session-layout.mjs",
  }[kind]} --result "${contract.resultPath}"`;
  if (kind === "finalize") return `${base} --assessment-file "${contract.draftPath}"`;
  if (kind === "layout") return `${base} --phase html`;
  return base;
}

function template(content = "<!-- HTML_REPORT_CONTENT -->") {
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head><meta charset=\"utf-8\"><title>{{HTML_REPORT_TITLE}}</title></head>",
    `<body>${content}</body>`,
    "</html>",
  ].join("\n");
}

function assessmentDraft() {
  return JSON.stringify({
    status: "pass",
    viewports: {
      desktop: { pass: true, notes: "桌面视口布局完整。" },
      mobile: { pass: true, notes: "移动视口无横向溢出。" },
    },
    notes: [],
  });
}

function structuredPaths(contract) {
  return {
    reportHtml: contract.returnPaths.reportHtml,
    renderMeta: contract.returnPaths.renderMeta,
    designResult: contract.returnPaths.designResult,
    desktopScreenshot: contract.returnPaths.desktopScreenshot,
    mobileScreenshot: contract.returnPaths.mobileScreenshot,
  };
}

function okReturn(contract, repairRounds = 0) {
  return {
    status: "ok",
    paths: structuredPaths(contract),
    layoutOk: true,
    repairRounds,
    elapsedMs: 1,
    residualNotes: [],
  };
}

function failedReturn(contract, repairRounds = 0) {
  return {
    status: "failed",
    paths: structuredPaths(contract),
    layoutOk: false,
    repairRounds,
    elapsedMs: 1,
    error: "compile failed",
    residualNotes: ["修复基础设施错误后重新运行 B5。"],
  };
}

function decide(contract, state, toolName, input, toolCallId) {
  return designerToolDecision(contract, state, { toolName, input, toolCallId });
}

function succeed(contract, state, toolName, toolCallId, overrides = {}) {
  return designerToolResultState(contract, state, {
    toolName,
    toolCallId,
    isError: false,
    content: [{ type: "text", text: "ok" }],
    ...overrides,
  });
}

function successfulCommand(contract, state, kind, id = kind) {
  const called = decide(contract, state, "bash", { command: command(contract, kind) }, id);
  assert.equal(called.decision, undefined, `${kind} should be allowed`);
  return succeed(contract, called.state, "bash", id);
}

function successfulRead(contract, state, path, id) {
  const called = decide(contract, state, "read", { path }, id);
  assert.equal(called.decision, undefined, `read should be allowed: ${path}`);
  return succeed(contract, called.state, "read", id);
}

function stateAfterInputReads(contract) {
  let state = successfulCommand(contract, initialDesignerGuardState(), "compile");
  for (const [index, path] of [
    contract.designInputPath,
    contract.contentPath,
    contract.referencePath,
    contract.starterPath,
  ].entries()) {
    state = successfulRead(contract, state, path, `input-${index}`);
  }
  return state;
}

function stateAfterTemplate(contract) {
  let state = stateAfterInputReads(contract);
  const called = decide(
    contract,
    state,
    "write",
    { path: contract.templatePath, content: template() },
    "template-write"
  );
  assert.equal(called.decision, undefined);
  return succeed(contract, called.state, "write", "template-write");
}

function stateAfterVisualRead(contract, state = stateAfterTemplate(contract), suffix = "0") {
  let next = successfulCommand(contract, state, "compose", `compose-${suffix}`);
  next = successfulCommand(contract, next, "capture", `capture-${suffix}`);
  next = successfulRead(contract, next, contract.desktopScreenshot, `desktop-${suffix}`);
  next = successfulRead(contract, next, contract.mobileScreenshot, `mobile-${suffix}`);
  assert.equal(next.visualReady, true);
  return next;
}

test("Designer assignment pins every path to one current-project SESSION", () => {
  const contract = parseDesignerAssignment(assignment(), { projectRoot });
  assert.equal(contract.ok, true, contract.errors?.join("; "));
  assert.equal(contract.sessionDir, sessionDir);
  assert.equal(contract.resultPath, join(sessionDir, "result.json"));
  assert.equal(contract.designInputPath, join(sessionDir, "report", "design-input.json"));
  assert.equal(contract.contentPath, join(sessionDir, "report", "report.content.html"));
  assert.equal(contract.templatePath, join(sessionDir, "report", "report.design.html"));
  assert.equal(contract.draftPath, join(sessionDir, "report", "design-result.draft.json"));
  assert.equal(contract.desktopScreenshot, join(sessionDir, "report", "screenshots", "desktop-1440x1000.png"));
  assert.equal(contract.mobileScreenshot, join(sessionDir, "report", "screenshots", "mobile-390x844.png"));
  assert.equal(contract.referencePath, join(
    projectRoot,
    ".agents",
    "pi",
    "skills",
    "html-report-design",
    "references",
    "report-design-system.md"
  ));

  const cases = [
    {
      value: assignment({ resultPath: "/tmp/result.json" }),
      error: /result\.json 与 SESSION 不一致/,
    },
    {
      value: assignment({ sessionDir: "/tmp/foreign", resultPath: "/tmp/foreign/result.json" }),
      error: /当前项目 html-report 根/,
    },
    {
      value: assignment({
        sessionDir: `${sessionDir}/nested`,
        resultPath: `${sessionDir}/nested/result.json`,
      }),
      error: /单一 session 目录/,
    },
    {
      value: `${assignment()}\nSESSION=${sessionDir}`,
      error: /只能声明一次 SESSION/,
    },
    {
      value: "SESSION=.harness/state/html-report/designer-guard-test\nresult.json=./result.json",
      error: /不是规范绝对路径/,
    },
  ];
  for (const { value, error } of cases) {
    const rejected = parseDesignerAssignment(value, { projectRoot });
    assert.equal(rejected.ok, false, value);
    assert.match(rejected.errors.join("\n"), error, value);
  }
});

test("Designer command classifier whitelists exactly five standalone commands", () => {
  const contract = parseDesignerAssignment(assignment(), { projectRoot });
  for (const kind of ["compile", "compose", "capture", "finalize", "layout"]) {
    assert.equal(classifyDesignerCommand(command(contract, kind), contract), kind);
  }
  assert.equal(
    classifyDesignerCommand(
      `node .agents/pi/skills/html-report/scripts/compile-report-content.mjs \\\n        --result "${contract.resultPath}"`,
      contract
    ),
    "compile",
    "a pure line continuation remains the same fixed command"
  );

  for (const forbidden of [
    "ls -la",
    "node -e 'console.log(1)'",
    `node .agents/pi/skills/html-report/scripts/compile-report-content.mjs --result /tmp/result.json`,
    `${command(contract, "compile")} --extra value`,
    `${command(contract, "compose")} && echo retry`,
    `${command(contract, "capture")} 2>&1`,
    `node .agents/pi/skills/html-report/scripts/finalize-design.mjs --assessment-file "${contract.draftPath}" --result "${contract.resultPath}" --other x`,
    `node .agents/pi/skills/html-report/scripts/check-session-layout.mjs --result "${contract.resultPath}" --phase quality`,
  ]) {
    assert.equal(classifyDesignerCommand(forbidden, contract), null, forbidden);
    const blocked = decide(
      contract,
      initialDesignerGuardState(),
      "bash",
      { command: forbidden },
      `forbidden-${forbidden}`
    );
    assert.equal(blocked.decision.block, true, forbidden);
    assert.match(blocked.decision.reason, /只允许五条固定 Designer 命令/);
    assert.equal(blocked.state.terminalFailure.failedStep, "command");
  }
});

test("Designer zero-repair success path follows the fixed one-shot state machine", () => {
  const contract = parseDesignerAssignment(assignment(), { projectRoot });
  const earlyCompose = decide(
    contract,
    initialDesignerGuardState(),
    "bash",
    { command: command(contract, "compose") },
    "early-compose"
  );
  assert.equal(earlyCompose.decision.block, true);
  assert.match(earlyCompose.decision.reason, /必须先成功 compile/);

  let state = stateAfterVisualRead(contract);
  let called = decide(
    contract,
    state,
    "write",
    { path: contract.draftPath, content: assessmentDraft() },
    "draft"
  );
  assert.equal(called.decision, undefined);
  state = succeed(contract, called.state, "write", "draft");
  assert.equal(state.draftWritten, true);

  state = successfulCommand(contract, state, "finalize");
  state = successfulCommand(contract, state, "layout");
  assert.equal(state.layoutSuccess, true);

  called = decide(
    contract,
    state,
    "structured_output",
    { value: okReturn(contract) },
    "final"
  );
  assert.equal(called.decision, undefined);
  assert.equal(called.state.structuredAttempts, 1);
  assert.match(
    decide(contract, called.state, "read", { path: contract.designInputPath }, "after-final").decision.reason,
    /structured_output 后禁止任何工具/
  );
  assert.match(
    decide(contract, called.state, "structured_output", { value: okReturn(contract) }, "final-2").decision.reason,
    /最多调用一次/
  );
});

test("after the first template write, edit and rewrite terminate while compose is the next legal action", () => {
  const contract = parseDesignerAssignment(assignment(), { projectRoot });
  const state = stateAfterTemplate(contract);

  const earlyEdit = decide(
    contract,
    state,
    "edit",
    { path: contract.templatePath, oldText: "color:red", newText: "color:blue" },
    "early-edit"
  );
  assert.equal(earlyEdit.decision.block, true);
  assert.match(earlyEdit.decision.reason, /首次 capture 并读完两张截图前禁止 edit/);
  assert.equal(earlyEdit.state.terminalFailure.failedStep, "edit");

  const rewrite = decide(
    contract,
    state,
    "write",
    { path: contract.templatePath, content: template() },
    "template-rewrite"
  );
  assert.equal(rewrite.decision.block, true);
  assert.match(rewrite.decision.reason, /只能首次 write 一次/);
  assert.equal(rewrite.state.terminalFailure.failedStep, "write");

  const compose = decide(
    contract,
    state,
    "bash",
    { command: command(contract, "compose") },
    "next-compose"
  );
  assert.equal(compose.decision, undefined);
});

test("Designer rejects templates without one slot or with copied immutable content", () => {
  const contract = parseDesignerAssignment(assignment(), { projectRoot });
  const ready = stateAfterInputReads(contract);
  for (const [label, content, expected] of [
    ["missing slot", template("<main>empty</main>"), /exactly one.*HTML_REPORT_CONTENT/],
    [
      "duplicated slot",
      template("<!-- HTML_REPORT_CONTENT --><!-- HTML_REPORT_CONTENT -->"),
      /exactly one.*HTML_REPORT_CONTENT/,
    ],
    [
      "immutable marker",
      template("<!-- HTML_REPORT_CONTENT --><main data-html-report-content=\"immutable\">copied</main>"),
      /不得|must not embed immutable/,
    ],
    [
      "content boundary",
      template("<!-- HTML_REPORT_CONTENT --><!-- html-report:content-start -->copied<!-- html-report:content-end -->"),
      /不得|must not embed immutable/,
    ],
  ]) {
    const blocked = decide(
      contract,
      ready,
      "write",
      { path: contract.templatePath, content },
      `invalid-template-${label}`
    );
    assert.equal(blocked.decision.block, true, label);
    assert.match(blocked.decision.reason, expected, label);
    assert.equal(blocked.state.terminalFailure.failedStep, "write", label);
  }
});

test("any tool failure forbids retry and permits only one failed structured_output", () => {
  const contract = parseDesignerAssignment(assignment(), { projectRoot });
  const called = decide(
    contract,
    initialDesignerGuardState(),
    "bash",
    { command: command(contract, "compile") },
    "compile-failure"
  );
  assert.equal(called.decision, undefined);
  const failed = succeed(contract, called.state, "bash", "compile-failure", {
    isError: true,
    content: [{ type: "text", text: "ENOENT report.md" }],
  });
  assert.deepEqual(failed.terminalFailure, { failedStep: "compile", error: "ENOENT report.md" });

  for (const [toolName, input] of [
    ["bash", { command: command(contract, "compile") }],
    ["read", { path: contract.designInputPath }],
    ["write", { path: contract.templatePath, content: template() }],
    ["edit", { path: contract.templatePath, oldText: "a", newText: "b" }],
  ]) {
    const blocked = decide(contract, failed, toolName, input, `retry-${toolName}`);
    assert.equal(blocked.decision.block, true, toolName);
    assert.match(blocked.decision.reason, /禁止后续 I\/O、命令或重试/);
  }

  const wrongFinal = decide(
    contract,
    failed,
    "structured_output",
    { value: okReturn(contract) },
    "wrong-success-final"
  );
  assert.equal(wrongFinal.decision.block, true);
  assert.match(wrongFinal.decision.reason, /失败终止后只能返回 status=failed/);

  const final = decide(
    contract,
    failed,
    "structured_output",
    { value: failedReturn(contract) },
    "failed-final"
  );
  assert.equal(final.decision, undefined);
  assert.equal(final.state.structuredAttempts, 1);
  assert.match(
    decide(contract, final.state, "structured_output", { value: failedReturn(contract) }, "failed-final-2").decision.reason,
    /最多调用一次/
  );
});

test("tool results without an explicit success signal fail closed", () => {
  const contract = parseDesignerAssignment(assignment(), { projectRoot });
  const called = decide(
    contract,
    initialDesignerGuardState(),
    "bash",
    { command: command(contract, "compile") },
    "compile-ambiguous"
  );
  assert.equal(called.decision, undefined);
  const failed = designerToolResultState(contract, called.state, {
    toolName: "bash",
    toolCallId: "compile-ambiguous",
    content: [{ type: "text", text: "bridge omitted exit status" }],
  });
  assert.deepEqual(failed.terminalFailure, {
    failedStep: "compile",
    error: "bridge omitted exit status",
  });
  assert.equal(failed.compileSuccess, false);
});

test("Designer allows at most two complete screenshot-driven edit-compose-capture repair rounds", () => {
  const contract = parseDesignerAssignment(assignment(), { projectRoot });
  let state = stateAfterVisualRead(contract);

  for (let round = 1; round <= 2; round += 1) {
    const editId = `repair-${round}`;
    let called = decide(
      contract,
      state,
      "edit",
      {
        path: contract.templatePath,
        oldText: `.card { gap: ${round}px; }`,
        newText: `.card { gap: ${round + 1}px; }`,
      },
      editId
    );
    assert.equal(called.decision, undefined, `repair ${round}`);
    state = succeed(contract, called.state, "edit", editId);
    assert.equal(state.repairRounds, round);
    assert.equal(state.visualReady, false);
    state = stateAfterVisualRead(contract, state, String(round));
  }

  const thirdEdit = decide(
    contract,
    state,
    "edit",
    { path: contract.templatePath, oldText: ".x{a:b}", newText: ".x{a:c}" },
    "repair-3"
  );
  assert.equal(thirdEdit.decision.block, true);
  assert.match(thirdEdit.decision.reason, /视觉修复最多两轮/);
  assert.equal(thirdEdit.state.terminalFailure.failedStep, "edit");

  let called = decide(
    contract,
    state,
    "write",
    { path: contract.draftPath, content: assessmentDraft() },
    "draft-after-repair"
  );
  assert.equal(called.decision, undefined);
  state = succeed(contract, called.state, "write", "draft-after-repair");
  state = successfulCommand(contract, state, "finalize", "finalize-after-repair");
  state = successfulCommand(contract, state, "layout", "layout-after-repair");
  called = decide(
    contract,
    state,
    "structured_output",
    { value: okReturn(contract, 2) },
    "final-after-repair"
  );
  assert.equal(called.decision, undefined);
});

test("runtime extension captures assignment from context without resetting one-shot state", () => {
  const handlers = new Map();
  registerReportDesignerGuard({
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  assert.deepEqual([...handlers.keys()], ["before_agent_start", "context", "tool_call", "tool_result"]);

  handlers.get("before_agent_start")({ systemPrompt: "Report Designer child runtime" });
  const beforeContext = handlers.get("tool_call")({
    toolName: "bash",
    toolCallId: "runtime-too-early",
    input: { command: "node unknown.mjs" },
  });
  assert.equal(beforeContext.block, true);
  assert.match(beforeContext.reason, /任务契约解析失败/);

  const task = assignment();
  const contract = parseDesignerAssignment(task, { projectRoot });
  handlers.get("context")({
    messages: [{ role: "user", content: [{ type: "text", text: task }] }],
  });
  let decision = handlers.get("tool_call")({
    toolName: "bash",
    toolCallId: "runtime-compile",
    input: { command: command(contract, "compile") },
  });
  assert.equal(decision, undefined);
  handlers.get("tool_result")({
    toolName: "bash",
    toolCallId: "runtime-compile",
    isError: false,
    content: [{ type: "text", text: "ok" }],
  });

  // Pi emits context repeatedly after tools. Seeing the same child assignment
  // again must not erase compileSuccess or any one-shot read record.
  handlers.get("context")({
    messages: [
      { role: "user", content: task },
      { role: "assistant", content: [{ type: "text", text: "compiled" }] },
    ],
  });
  decision = handlers.get("tool_call")({
    toolName: "read",
    toolCallId: "runtime-input-1",
    input: { path: contract.designInputPath },
  });
  assert.equal(decision, undefined, "compileSuccess survives the repeated context event");
  handlers.get("tool_result")({
    toolName: "read",
    toolCallId: "runtime-input-1",
    isError: false,
    content: [{ type: "text", text: "ok" }],
  });

  handlers.get("context")({ prompt: task });
  decision = handlers.get("tool_call")({
    toolName: "read",
    toolCallId: "runtime-input-2",
    input: { path: contract.contentPath },
  });
  assert.equal(decision, undefined, "the first successful read also survives context recapture");

  const duplicate = handlers.get("tool_call")({
    toolName: "read",
    toolCallId: "runtime-input-duplicate",
    input: { path: contract.designInputPath },
  });
  assert.equal(duplicate.block, true);
  assert.match(duplicate.reason, /最多读取一次/);
});
