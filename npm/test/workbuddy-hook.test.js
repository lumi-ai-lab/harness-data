import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const npmRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(npmRoot, "..");
const adapterPath = path.join(repoRoot, ".agents", "workbuddy", "scripts", "harness-hook.mjs");
const adapter = await import(pathToFileURL(adapterPath).href);

test("WorkBuddy adapter normalizes prompt aliases", () => {
  assert.deepEqual(adapter.normalizePayload("context", {
    session_id: " session-1 ",
    prompt: "销售额最近怎么样？",
  }), {
    session_id: "session-1",
    prompt: "销售额最近怎么样？",
  });
  assert.deepEqual(adapter.normalizePayload("context", {
    session_id: "session-2",
    user_prompt: "会员复购为什么下降？",
  }), {
    session_id: "session-2",
    prompt: "会员复购为什么下降？",
  });
  assert.equal(adapter.normalizePayload("context", { prompt: "   " }), null);
});

test("WorkBuddy adapter canonicalizes shell tool names", () => {
  for (const toolName of ["Bash", "PowerShell", "execute_command"]) {
    assert.deepEqual(adapter.normalizePayload("posttool", {
      session_id: "session",
      tool_name: toolName,
      tool_input: { command: "bin/data-harness-cli stage template" },
    }), {
      session_id: "session",
      tool_name: "Bash",
      tool_input: { command: "bin/data-harness-cli stage template" },
    });
  }
  assert.equal(adapter.normalizePayload("posttool", {
    session_id: "session",
    tool_name: "Read",
    tool_input: { command: "ignored" },
  }), null);
});

test("WorkBuddy adapter finds a Harness root through directories with spaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness workbuddy root "));
  const nested = path.join(root, "nested folder", "child");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, "config", "harness-config.yaml"), "paths:\n  knowledge: wikis\n");
  assert.equal(adapter.findHarnessRoot(nested), root);
});

const integrationOptions = { skip: process.platform === "win32" };

test("WorkBuddy adapter forwards canonical context to workbuddy-hook", integrationOptions, () => {
  const fixture = createAdapterFixture();
  const result = runAdapter("context", {
    session_id: "context-session",
    user_prompt: "销售额最近怎么样？",
    cwd: path.join(fixture.root, "nested folder"),
  }, {
    CODEBUDDY_PROJECT_DIR: path.join(fixture.root, "nested folder"),
    QDM_HARNESS_CLI: fixture.cli,
    QDM_HARNESS_TEST_LOG: fixture.log,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const call = JSON.parse(fs.readFileSync(fixture.log, "utf8"));
  assert.deepEqual(call.args, ["context", "--format", "workbuddy-hook"]);
  assert.deepEqual(call.stdin, { session_id: "context-session", prompt: "销售额最近怎么样？" });
  assert.equal(call.projectDir, fixture.root);
});

test("WorkBuddy adapter forwards PowerShell as canonical Bash", integrationOptions, () => {
  const fixture = createAdapterFixture();
  const result = runAdapter("posttool", {
    session_id: "posttool-session",
    tool_name: "PowerShell",
    tool_input: { command: "bin/data-harness-cli inject-template" },
    cwd: fixture.root,
  }, {
    CODEBUDDY_PROJECT_DIR: fixture.root,
    QDM_HARNESS_CLI: fixture.cli,
    QDM_HARNESS_TEST_LOG: fixture.log,
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  const call = JSON.parse(fs.readFileSync(fixture.log, "utf8"));
  assert.deepEqual(call.stdin, {
    session_id: "posttool-session",
    tool_name: "Bash",
    tool_input: { command: "bin/data-harness-cli inject-template" },
  });
});

test("WorkBuddy adapter emits safe context when CLI is missing", integrationOptions, () => {
  const fixture = createAdapterFixture({ createCLI: false });
  const result = runAdapter("context", {
    session_id: "missing-cli",
    prompt: "销售额是多少？",
    cwd: fixture.root,
  }, {
    CODEBUDDY_PROJECT_DIR: fixture.root,
    QDM_HARNESS_CLI: path.join(fixture.root, "bin", "missing-data-harness-cli"),
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, true);
  assert.match(output.hookSpecificOutput.additionalContext, /QDM_HARNESS_UNAVAILABLE/);
  assert.match(output.hookSpecificOutput.additionalContext, /Do not run qdm-metric-cli/);
  assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
});

test("WorkBuddy adapter emits safe context on CLI timeout", integrationOptions, () => {
  const fixture = createAdapterFixture({ timeout: true });
  const result = runAdapter("context", {
    session_id: "timeout-cli",
    prompt: "销售额是多少？",
    cwd: fixture.root,
  }, {
    CODEBUDDY_PROJECT_DIR: fixture.root,
    QDM_HARNESS_CLI: fixture.cli,
    QDM_HARNESS_HOOK_TIMEOUT_MS: "20",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /timed out/);
});

test("WorkBuddy adapter is a silent semantic no-op outside Harness projects", integrationOptions, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-workbuddy-project-"));
  fs.mkdirSync(path.join(root, ".harness"), { recursive: true });
  assert.equal(adapter.findHarnessRoot(root), "");
  const result = runAdapter("context", {
    session_id: "ordinary",
    prompt: "hello",
    cwd: root,
  }, { CODEBUDDY_PROJECT_DIR: root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

function runAdapter(mode, payload, env = {}) {
  return spawnSync(process.execPath, [adapterPath, mode], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 5_000,
  });
}

function createAdapterFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness workbuddy fixture "));
  const binDir = path.join(root, "bin");
  const log = path.join(root, "hook-call.json");
  const cli = path.join(binDir, "data-harness-cli");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "nested folder"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(root, "config", "harness-config.yaml"), "paths:\n  knowledge: wikis\n");

  if (options.createCLI !== false) {
    const script = options.timeout ? "#!/bin/sh\nsleep 1\n" : `#!/bin/sh
input=$(cat)
export HOOK_STDIN="$input"
node -e '
const fs = require("fs");
const args = process.argv.slice(1);
const stdin = JSON.parse(process.env.HOOK_STDIN);
fs.writeFileSync(process.env.QDM_HARNESS_TEST_LOG, JSON.stringify({ args, stdin, projectDir: process.env.CODEBUDDY_PROJECT_DIR }));
const event = args[0] === "posttool" ? "PostToolUse" : "UserPromptSubmit";
process.stdout.write(JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: event, additionalContext: "fixture context" } }));
' "$@"
`;
    fs.writeFileSync(cli, script, { mode: 0o755 });
  }
  return { root, cli, log };
}
