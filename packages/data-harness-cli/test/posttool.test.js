import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  injectTemplate,
  isQDMMetricCommand,
  isTemplateInjectionCommand,
  isTemplateStageCommand,
  runClaudeHook,
  runWorkBuddyHook,
} from "../src/lib/posttool/hook.js";
import { runQwenPawHook } from "../src/lib/posttool/qwenpaw.js";
import { load as loadState, save as saveState } from "../src/lib/sessionstate.js";

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function testInjectRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "posttool-"));
  writeFile(
    root,
    "config/harness-config.yaml",
    "paths:\n  spec: wikis/spec\n  routing: wikis/routing\n  playbooks: wikis/playbooks\n  templates: wikis/templates\n",
  );
  writeFile(
    root,
    "wikis/templates/idx/business/s-sale-amt.md",
    `---
name: ignored
---
# 销售额模板

正文
`,
  );
  return root;
}

function writeState(root, sessionID, state) {
  saveState(root, sessionID, { session_id: sessionID, reports: {}, ...state });
}

test("posttool recognizes inject-template and stage template", () => {
  assert.equal(isTemplateInjectionCommand("bin/data-harness-cli inject-template"), true);
  assert.equal(isTemplateStageCommand("bin/data-harness-cli stage template"), true);
  assert.equal(isTemplateInjectionCommand("echo bin/data-harness-cli inject-template"), false);
  assert.equal(isTemplateStageCommand(`printf '%s' "bin/data-harness-cli stage template"`), false);
});

test("template and metric command detection respects shell syntax", () => {
  for (const command of [
    "bin/data-harness-cli inject-template",
    "cd /tmp\nbin/data-harness-cli stage template",
    "if true; then bin/data-harness-cli stage template; fi",
    "env QDM_MODE=test bin/data-harness-cli inject-template",
    `& "C:\\Harness Runtime\\bin\\DATA-HARNESS-CLI.EXE" inject-template`,
  ]) {
    assert.ok(
      isTemplateInjectionCommand(command) || isTemplateStageCommand(command),
      `expected template command: ${command}`,
    );
  }
  for (const command of [
    `echo "audit && bin/data-harness-cli inject-template ignored"`,
    `printf '%s' "note; bin/data-harness-cli stage template"`,
  ]) {
    assert.equal(isTemplateInjectionCommand(command), false, command);
    assert.equal(isTemplateStageCommand(command), false, command);
  }
  for (const command of [
    `source config/qdm-cli-paths.env && "$QDM_METRIC_CLI" analysis execute`,
    "${QDM_METRIC_CLI:-bin/qdm-metric-cli} analysis execute",
    `& "C:\\QDM Runtime\\QDM-METRIC-CLI.EXE" analysis execute`,
  ]) {
    assert.equal(isQDMMetricCommand(command), true, command);
  }
  assert.equal(isQDMMetricCommand(`echo "audit && bin/qdm-metric-cli analysis execute"`), false);
});

test("injectTemplate uses selected template and strips frontmatter", () => {
  const root = testInjectRoot();
  const sessionID = "inject-single";
  writeState(root, sessionID, {
    mode: "single",
    selected_playbook: "playbooks/idx/business/s-sale-amt.md",
    selected_template: "templates/idx/business/s-sale-amt.md",
  });
  const first = injectTemplate(root, sessionID);
  assert.equal(first.outcome, "template_injected");
  assert.equal(first.templateRel, "templates/idx/business/s-sale-amt.md");
  assert.equal(first.message.includes("---"), false);
  assert.ok(first.message.includes("# 销售额模板"));
  assert.ok(first.message.includes("QDM_DELIVERY_MODE=chat"));
  assert.ok(first.message.includes("Do not write the final result or intermediate analysis result to a file."));
  const again = injectTemplate(root, sessionID);
  assert.equal(again.outcome, "template_injected");
  assert.equal(again.message, first.message);
});

test("runClaudeHook injects template after stage template", () => {
  const root = testInjectRoot();
  const sessionID = "needs-template";
  writeState(root, sessionID, {
    mode: "single",
    selected_playbook: "playbooks/idx/business/s-sale-amt.md",
    selected_template: "templates/idx/business/s-sale-amt.md",
  });
  const { ok, output } = runClaudeHook(
    root,
    JSON.stringify({
      session_id: sessionID,
      tool_name: "Bash",
      tool_input: { command: "bin/data-harness-cli stage template" },
    }),
  );
  assert.equal(ok, true);
  assert.ok(output.hookSpecificOutput.additionalContext.includes("销售额模板"));
});

test("runClaudeHook does not require template in free mode", () => {
  const root = testInjectRoot();
  writeState(root, "free-data", { mode: "free" });
  const { ok, output } = runClaudeHook(
    root,
    JSON.stringify({
      session_id: "free-data",
      tool_name: "Bash",
      tool_input: {
        command: "qdm-metric-cli analysis execute --metric saleAmt --start-date 2026-05-28 --end-date 2026-05-28",
      },
    }),
  );
  assert.equal(ok, false);
  assert.equal(output, null);
});

test("injectTemplate free and missing state do not guess", () => {
  const root = testInjectRoot();
  writeState(root, "free", { mode: "free" });
  const free = injectTemplate(root, "free");
  assert.equal(free.outcome, "free_mode_no_template");
  assert.ok(free.message.includes("Do not run inject-template"));

  const missing = injectTemplate(root, "missing");
  assert.equal(missing.outcome, "missing_session_state");
  assert.ok(missing.message.includes("session state missing"));
});

test("injectTemplate selected template must exist", () => {
  const root = testInjectRoot();
  const sessionID = "missing-template";
  writeState(root, sessionID, {
    mode: "single",
    selected_playbook: "playbooks/idx/business/default-overview.md",
    selected_template: "templates/idx/business/missing.md",
  });
  const result = injectTemplate(root, sessionID);
  assert.equal(result.outcome, "template_selection_error");
  assert.equal(result.templateRel, "templates/idx/business/missing.md");
  assert.ok(result.message.includes("missing templates/idx/business/missing.md"));
});

test("runWorkBuddyHook injects namespaced template", () => {
  const root = testInjectRoot();
  const rawSessionID = "report-session";
  writeState(root, `workbuddy:${rawSessionID}`, {
    mode: "single",
    selected_playbook: "playbooks/idx/business/s-sale-amt.md",
    selected_template: "templates/idx/business/s-sale-amt.md",
  });
  const { ok, output } = runWorkBuddyHook(
    root,
    JSON.stringify({
      session_id: rawSessionID,
      tool_name: "Bash",
      tool_input: { command: "bin/data-harness-cli stage template" },
    }),
  );
  assert.equal(ok, true);
  assert.equal(output.continue, true);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(output.hookSpecificOutput.additionalContext.includes("销售额模板"));
  assert.equal(loadState(root, `workbuddy:${rawSessionID}`).template_injected, true);
});

test("runWorkBuddyHook supports Windows template command", () => {
  const root = testInjectRoot();
  const rawSessionID = "windows-report-session";
  writeState(root, `workbuddy:${rawSessionID}`, {
    mode: "single",
    selected_playbook: "playbooks/idx/business/s-sale-amt.md",
    selected_template: "templates/idx/business/s-sale-amt.md",
  });
  const { ok, output } = runWorkBuddyHook(
    root,
    JSON.stringify({
      session_id: rawSessionID,
      tool_name: "Bash",
      tool_input: { command: `& "C:\\Harness Runtime\\bin\\DATA-HARNESS-CLI.EXE" inject-template` },
    }),
  );
  assert.equal(ok, true);
  assert.ok(output.hookSpecificOutput.additionalContext.includes("销售额模板"));
});

test("runWorkBuddyHook missing session fails safely", () => {
  const root = testInjectRoot();
  const { ok, output } = runWorkBuddyHook(
    root,
    JSON.stringify({
      session_id: "",
      tool_name: "Bash",
      tool_input: { command: "bin/data-harness-cli inject-template" },
    }),
  );
  assert.equal(ok, true);
  assert.equal(output.continue, true);
  assert.ok(output.hookSpecificOutput.additionalContext.includes("stable session_id"));
  assert.ok(output.hookSpecificOutput.additionalContext.includes("Do not guess"));
  assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
});

test("runWorkBuddyHook ignores non-canonical tools and commands", () => {
  const root = testInjectRoot();
  const payloads = [
    { session_id: "session", tool_name: "execute_command", tool_input: { command: "bin/data-harness-cli inject-template" } },
    { session_id: "session", tool_name: "Bash", tool_input: { command: "echo hello" } },
    { session_id: "session", tool_name: "Bash", tool_input: { command: "echo bin/data-harness-cli inject-template" } },
    { session_id: "session", tool_name: "Bash", tool_input: { command: `printf '%s' "bin/data-harness-cli stage template"` } },
    { session_id: "session", tool_name: "Bash", tool_input: { command: "echo bin/qdm-metric-cli analysis execute" } },
  ];
  for (const payload of payloads) {
    const { ok, output } = runWorkBuddyHook(root, JSON.stringify(payload));
    assert.equal(ok, false, JSON.stringify(payload));
    assert.equal(output, null, JSON.stringify(payload));
  }
});

test("runWorkBuddyHook metric results are silent no-ops", () => {
  const root = testInjectRoot();
  for (const [sessionID, command] of [
    ["", `"$QDM_METRIC_CLI" analysis execute`],
    ["metric", "bin/qdm-metric-cli analysis execute"],
  ]) {
    const { ok, output } = runWorkBuddyHook(
      root,
      JSON.stringify({
        session_id: sessionID,
        tool_name: "Bash",
        tool_input: { command },
      }),
    );
    assert.equal(ok, false, command);
    assert.equal(output, null, command);
  }
});

test("runQwenPawHook injects template after successful qdm_query", () => {
  const root = testInjectRoot();
  const sessionID = `qwenpaw:${"a".repeat(64)}`;
  writeState(root, sessionID, {
    mode: "report",
    selected_playbook: "playbooks/idx/business/r-business-analysis-report.md",
    selected_template: "templates/idx/business/s-sale-amt.md",
  });
  const output = runQwenPawHook(
    root,
    JSON.stringify({
      session_id: sessionID,
      tool_name: "qdm_query",
      status: "success",
      safe_command_args: { report_name: "financial-overview", report_module: "indicators" },
    }),
  );
  assert.equal(output.ok, true);
  assert.equal(output.diagnostic_code, "template_injected");
  assert.ok(output.additional_context.includes("QDM_DELIVERY_MODE=chat"));
  const state = loadState(root, sessionID);
  assert.equal(state.template_injected, true);
  assert.ok(state.reports["financial-overview"].recorded_modules.includes("indicators"));
});

test("runQwenPawHook rejects untrusted payload fields", () => {
  const sessionID = `qwenpaw:${"b".repeat(64)}`;
  assert.throws(
    () =>
      runQwenPawHook(
        testInjectRoot(),
        `{"session_id":"${sessionID}","tool_name":"qdm_query","status":"success","safe_command_args":{},"command":"qdm-metric-cli --auth-blob secret"}`,
      ),
    /invalid qwenpaw-hook payload/,
  );
});
