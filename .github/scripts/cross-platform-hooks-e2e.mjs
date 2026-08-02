import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { installQdmHarnessExtension } from "../../.agents/pi/extensions/qdm-harness/index.ts";
import { hooks as openClawHooks } from "../../.agents/openclaw/plugins/qdm-harness/src/index.ts";
import {
  reconcileAgentIntegrations,
  writeLocalConfig,
} from "../../npm/src/lib/config.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(scriptDir, "../..");
const workspace = mkdtempSync(path.join(os.tmpdir(), "Harness Data 中文 workspace-"));
const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "harness-hooks-outside-"));
const executableName = process.platform === "win32" ? "data-harness-cli.exe" : "data-harness-cli";
const executable = path.join(workspace, "bin", executableName);
const reportPrompt = "请生成经营综合分析报告";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function runExecutable(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    input: options.input,
    shell: false,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || result.error || ""}`,
  );
  return result.stdout;
}

function runDeclarativeHook(command, payload, cwd) {
  const result = spawnSync(command, {
    cwd,
    encoding: "utf8",
    input: `${JSON.stringify(payload)}\n`,
    shell: true,
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `Hook command failed: ${command}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || result.error || ""}`,
  );
  assert.ok(result.stdout.trim(), `Hook command returned empty stdout: ${command}`);
  return JSON.parse(result.stdout);
}

function copyAgentTemplates() {
  const target = path.join(workspace, "agents");
  rmSync(target, { recursive: true, force: true });
  cpSync(path.join(repository, ".agents"), target, { recursive: true });
}

function hookCommand(document, eventName) {
  const handler = document.hooks[eventName][0].hooks[0];
  if (process.platform === "win32") {
    assert.equal(handler.commandWindows, handler.command);
    return handler.commandWindows;
  }
  assert.equal(handler.commandWindows, undefined);
  return handler.command;
}

function nativeTemplateCommand() {
  if (process.platform === "win32") return `& "${executable}" stage template`;
  return `'${executable.replaceAll("'", `'\\''`)}' stage template`;
}

async function verifyPiAdapter() {
  const handlers = new Map();
  await installQdmHarnessExtension({
    cwd: workspace,
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const sessionId = "native-pi-context";
  const context = {
    cwd: workspace,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify() {}, setStatus() {} },
  };
  handlers.get("session_start")({}, context);
  const result = await handlers.get("context")({
    messages: [{
      role: "user",
      timestamp: 1,
      content: [{ type: "text", text: reportPrompt }],
    }],
  }, context);
  assert.match(JSON.stringify(result), /Harness mode: report/);
}

function verifyOpenClawAdapter() {
  const previousCwd = process.cwd();
  process.chdir(workspace);
  try {
    const context = openClawHooks.before_prompt_build({
      session_id: "native-openclaw-context",
      prompt: reportPrompt,
    });
    assert.match(String(context?.additionalContext || ""), /Harness mode: report/);
  } finally {
    process.chdir(previousCwd);
  }
}

try {
  mkdirSync(path.join(workspace, "bin"), { recursive: true });
  mkdirSync(path.join(workspace, "config"), { recursive: true });
  cpSync(path.join(repository, "wikis"), path.join(workspace, "wikis"), { recursive: true });
  copyAgentTemplates();

  runExecutable("go", ["build", "-trimpath", "-o", executable, "./cli/cmd/data-harness-cli"]);
  assert.equal(existsSync(executable), true);
  writeLocalConfig(workspace, { overwrite: true });
  const powershellConfig = readFileSync(path.join(workspace, "config", "qdm-cli-paths.ps1"), "utf8");
  assert.match(powershellConfig, /\$env:QDM_INDICATORS_CLI/);
  if (process.platform === "win32") assert.match(powershellConfig, /data-harness-cli|\.exe/);

  runExecutable(executable, ["wikis", "build-index", "--skip-checks"], { cwd: workspace });

  const first = reconcileAgentIntegrations(workspace, "all");
  assert.equal(first.changed, true);
  assert.equal(first.codexTrustReviewRequired, true);
  assert.deepEqual(first.agents, ["claude", "codex", "pi", "openclaw", "hermes"]);

  const hooksFile = path.join(workspace, ".harness", "generated", "agents", "codex", "hooks.json");
  const hooksBody = readFileSync(hooksFile, "utf8");
  const hooksHash = sha256(hooksBody);
  const hooksMtime = statSync(hooksFile).mtimeMs;
  const codexHooks = JSON.parse(hooksBody);
  assert.equal(codexHooks.hooks.PostToolUse[0].matcher, "^Bash$");
  for (const eventName of ["UserPromptSubmit", "PostToolUse"]) {
    const command = hookCommand(codexHooks, eventName);
    assert.ok(command.includes(executable));
    assert.doesNotMatch(command, /python|powershell|\$PWD|dirname/iu);
  }
  const generatedHermesFallback = path.join(workspace, ".harness", "generated", "agents", "hermes", "agent-hooks");
  assert.equal(existsSync(generatedHermesFallback), process.platform !== "win32");

  const noOp = reconcileAgentIntegrations(workspace, "all");
  assert.equal(noOp.changed, false);
  assert.equal(noOp.codexTrustReviewRequired, false);
  assert.equal(sha256(readFileSync(hooksFile)), hooksHash);
  assert.equal(statSync(hooksFile).mtimeMs, hooksMtime);

  const nestedCwd = path.join(workspace, "work", "nested");
  mkdirSync(nestedCwd, { recursive: true });
  const userPromptFixture = JSON.parse(readFileSync(
    path.join(repository, "cli", "testdata", "hooks", "codex-user-prompt-submit.json"),
    "utf8",
  ));
  Object.assign(userPromptFixture, {
    cwd: nestedCwd,
    session_id: "native-codex-report",
    prompt: reportPrompt,
  });
  const contextOutput = runDeclarativeHook(
    hookCommand(codexHooks, "UserPromptSubmit"),
    userPromptFixture,
    nestedCwd,
  );
  assert.equal(contextOutput.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(contextOutput.hookSpecificOutput?.additionalContext || "", /Harness mode: report/);
  if (process.platform === "win32") {
    assert.match(contextOutput.hookSpecificOutput?.additionalContext || "", /data-harness-cli\.exe stage template/);
  }

  const outsideCwd = outsideRoot;
  mkdirSync(outsideCwd, { recursive: true });
  const fallbackOutput = runDeclarativeHook(
    hookCommand(codexHooks, "UserPromptSubmit"),
    {
      ...userPromptFixture,
      cwd: outsideCwd,
      session_id: "native-codex-executable-fallback",
    },
    outsideCwd,
  );
  assert.match(fallbackOutput.hookSpecificOutput?.additionalContext || "", /Harness mode: report/);

  const claudeSettings = JSON.parse(readFileSync(
    path.join(workspace, ".harness", "generated", "agents", "claude", "settings.json"),
    "utf8",
  ));
  const claudeContextCommand = claudeSettings.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(claudeContextCommand.commandWindows, undefined);
  assert.ok(claudeContextCommand.command.includes(executable));
  const claudeOutput = runDeclarativeHook(
    claudeContextCommand.command,
    { ...userPromptFixture, session_id: "native-claude-report" },
    nestedCwd,
  );
  assert.equal(claudeOutput.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(claudeOutput.hookSpecificOutput?.additionalContext || "", /Harness mode: report/);

  copyAgentTemplates();
  appendFileSync(path.join(workspace, "agents", "codex", "AGENTS.md"), "\nRuntime replacement marker.\n");
  const afterRuntimeUpdate = reconcileAgentIntegrations(workspace, "all");
  assert.equal(afterRuntimeUpdate.changed, true);
  assert.equal(afterRuntimeUpdate.codexTrustReviewRequired, false);
  assert.equal(sha256(readFileSync(hooksFile)), hooksHash);
  assert.match(readFileSync(path.join(workspace, ".codex", "AGENTS.md"), "utf8"), /Runtime replacement marker/);

  const posttoolFixture = JSON.parse(readFileSync(
    path.join(repository, "cli", "testdata", "hooks", "codex-post-tool-use-windows.json"),
    "utf8",
  ));
  Object.assign(posttoolFixture, {
    cwd: nestedCwd,
    session_id: userPromptFixture.session_id,
  });
  posttoolFixture.tool_input.command = nativeTemplateCommand();
  assert.equal(posttoolFixture.tool_name, "Bash");
  const posttoolOutput = runDeclarativeHook(
    hookCommand(JSON.parse(readFileSync(hooksFile, "utf8")), "PostToolUse"),
    posttoolFixture,
    nestedCwd,
  );
  assert.equal(posttoolOutput.hookSpecificOutput?.hookEventName, "PostToolUse");
  assert.match(posttoolOutput.hookSpecificOutput?.additionalContext || "", /QDM_FINAL_OUTPUT_CONTRACT/);

  await verifyPiAdapter();
  verifyOpenClawAdapter();
  if (process.env.HARNESS_HERMES_E2E === "1") {
    const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    runExecutable(python, [
      path.join(repository, ".github", "scripts", "hermes-hooks-e2e.py"),
      workspace,
      path.join(repository, ".agents", "hermes", "plugins", "qdm-harness", "hooks.py"),
    ]);
  }

  console.log(`Cross-platform Hook E2E passed on ${process.platform}/${process.arch}: ${workspace}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
}
