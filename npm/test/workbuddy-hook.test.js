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

test("WorkBuddy authz adapter preserves the original tool contract", () => {
  const payload = adapter.normalizePayload("authz", {
    session_id: " authz-session ",
    hook_event_name: "PreToolUse",
    tool_name: "PowerShell",
    tool_input: {
      command: ".\\bin\\qdm-metric-cli.exe auth describe",
      timeout_ms: 10000,
      unknown_host_field: { keep: true },
    },
    cwd: "C:\\Harness Runtime",
  });
  assert.deepEqual(payload, {
    session_id: "authz-session",
    hook_event_name: "PreToolUse",
    tool_name: "PowerShell",
    tool_input: {
      command: ".\\bin\\qdm-metric-cli.exe auth describe",
      timeout_ms: 10000,
      unknown_host_field: { keep: true },
    },
    cwd: "C:\\Harness Runtime",
  });
});

test("WorkBuddy authz failures use a real PreToolUse deny", () => {
  const output = adapter.safeOutput("authz", "QDM_AUTHZ_HOOK_UNAVAILABLE: unavailable");
  assert.deepEqual(output, {
    systemMessage: "QDM_AUTHZ_HOOK_UNAVAILABLE: unavailable",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "QDM_AUTHZ_HOOK_UNAVAILABLE: unavailable",
    },
  });
});

test("WorkBuddy authz output validator preserves non-command fields", () => {
  const canonical = {
    tool_input: { command: "original", timeout_ms: 10000, unknown: "kept" },
  };
  const valid = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "updated", timeout_ms: 10000, unknown: "kept" },
    },
  });
  assert.ok(adapter.validateHookOutput("authz", valid, canonical));
  const lossy = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "updated", timeout_ms: 10000 },
    },
  });
  assert.equal(adapter.validateHookOutput("authz", lossy, canonical), null);
});

test("WorkBuddy authz output validator accepts direct authorization injection", () => {
  const canonical = { tool_input: { command: ".\\bin\\qdm-metric-cli.exe auth describe" } };
  const leaked = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        command: "& '.\\bin\\qdm-metric-cli.exe' auth describe --auth-blob 'qdm1enc.must-not-cross-host-contract'",
      },
    },
  });
  assert.ok(adapter.validateHookOutput("authz", leaked, canonical));
  const leakedDataAuth = leaked.replace(
    "auth describe --auth-blob 'qdm1enc.must-not-cross-host-contract'",
    "analysis execute --data-auth",
  );
  assert.ok(adapter.validateHookOutput("authz", leakedDataAuth, canonical));
});

test("WorkBuddy adapter preserves JSON numbers beyond JavaScript safe integer range", () => {
  const input = '{"tool_input":{"command":"original","large_number":92233720368547758070,"decimal":1.2300e+40}}';
  const parsed = adapter.parseLosslessJSON(input);
  assert.equal(adapter.stringifyLosslessJSON(parsed), input);

  const validOutput = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"updated","large_number":92233720368547758070,"decimal":1.2300e+40}}}';
  assert.ok(adapter.validateHookOutput("authz", validOutput, parsed));
  const roundedOutput = validOutput.replace("92233720368547758070", "92233720368547760000");
  assert.equal(adapter.validateHookOutput("authz", roundedOutput, parsed), null);
});

test("WorkBuddy adapter source does not parse authorization configuration", () => {
  const source = fs.readFileSync(adapterPath, "utf8");
  assert.doesNotMatch(source, /readAuthzMode|authzMode/);
  assert.doesNotMatch(source, /readFileSync\([^\n]*harness-config\.yaml/);
});

test("WorkBuddy adapter validates disabled and noop envelopes", () => {
  for (const status of ["disabled", "noop"]) {
    const output = adapter.validateAuthzEnvelope(JSON.stringify({ schemaVersion: 1, status, hookOutput: {} }));
    assert.deepEqual(output, {});
  }
});

test("WorkBuddy adapter validates allow and deny envelopes", () => {
  const canonical = { tool_input: { command: "qdm-metric-cli auth describe", timeout_ms: 10 } };
  const allow = adapter.validateAuthzEnvelope(JSON.stringify({
    schemaVersion: 1,
    status: "allow",
    hookOutput: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "bound",
        updatedInput: { command: "qdm-metric-cli auth describe --auth-blob trusted", timeout_ms: 10 },
      },
    },
  }), canonical);
  assert.equal(allow.hookSpecificOutput.permissionDecision, "allow");

  const deny = adapter.validateAuthzEnvelope(JSON.stringify({
    schemaVersion: 1,
    status: "deny",
    hookOutput: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "QDM_AUTHZ_SOURCE_MISSING: missing",
      },
    },
  }), canonical);
  assert.equal(deny.systemMessage, "QDM_AUTHZ_SOURCE_MISSING: missing");
});

test("WorkBuddy adapter rejects invalid or contradictory envelopes", () => {
  const canonical = { tool_input: { command: "qdm-metric-cli auth describe", timeout_ms: 10 } };
  const validAllow = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: "qdm-metric-cli auth describe --auth-blob trusted", timeout_ms: 10 },
    },
  };
  const validDeny = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "QDM_AUTHZ_SOURCE_MISSING: missing",
    },
  };
  const invalid = [
    "",
    "not-json",
    "[]",
    JSON.stringify({ status: "disabled", hookOutput: {} }),
    JSON.stringify({ schemaVersion: 2, status: "disabled", hookOutput: {} }),
    JSON.stringify({ schemaVersion: 1, status: "unknown", hookOutput: {} }),
    JSON.stringify({ schemaVersion: 1, status: "disabled", hookOutput: {}, extra: true }),
    JSON.stringify({ schemaVersion: 1, status: "disabled", hookOutput: validDeny }),
    JSON.stringify({ schemaVersion: 1, status: "noop", hookOutput: validAllow }),
    JSON.stringify({ schemaVersion: 1, status: "allow", hookOutput: validDeny }),
    JSON.stringify({ schemaVersion: 1, status: "deny", hookOutput: validAllow }),
    JSON.stringify({ schemaVersion: 1, status: "deny", hookOutput: {
      hookSpecificOutput: { ...validDeny.hookSpecificOutput, updatedInput: { command: "bad" } },
    } }),
    JSON.stringify({ schemaVersion: 1, status: "allow", hookOutput: {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    } }),
    JSON.stringify({ schemaVersion: 1, status: "allow", hookOutput: {
      hookSpecificOutput: { ...validAllow.hookSpecificOutput, updatedInput: { command: canonical.tool_input.command, timeout_ms: 10 } },
    } }),
    JSON.stringify({ schemaVersion: 1, status: "allow", hookOutput: {
      hookSpecificOutput: { ...validAllow.hookSpecificOutput, updatedInput: { command: "rewritten" } },
    } }),
  ];
  for (const value of invalid) assert.equal(adapter.validateAuthzEnvelope(value, canonical), null, value);
});

test("WorkBuddy authz adapter invokes the explicit envelope format", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-workbuddy-envelope-call-"));
  const cli = path.join(root, "data-harness-cli.exe");
  fs.writeFileSync(cli, "fixture");
  let observed;
  const output = adapter.runCanonicalHook("authz", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  }, root, { QDM_HARNESS_CLI: cli }, "", (file, args, options) => {
    observed = { file, args, input: options.input };
    return {
      status: 0,
      stdout: JSON.stringify({ schemaVersion: 1, status: "noop", hookOutput: {} }),
      stderr: "",
    };
  });
  assert.deepEqual(output, {});
  assert.equal(observed.file, cli);
  assert.deepEqual(observed.args, ["authz-hook", "--agent", "workbuddy", "--format", "adapter-envelope"]);
  assert.match(observed.input, /"tool_name":"Bash"/);
});

test("WorkBuddy authz transport failures fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-workbuddy-envelope-failure-"));
  const cli = path.join(root, "data-harness-cli.exe");
  fs.writeFileSync(cli, "fixture");
  const canonical = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "qdm-metric-cli auth describe" },
  };
  const failures = [
    { name: "startup failure", result: { error: Object.assign(new Error("spawn"), { code: "ENOENT" }), status: null, stdout: "" } },
    { name: "timeout", result: { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null, stdout: "" } },
    { name: "non-zero", result: { status: 2, stdout: "", stderr: "failed" } },
    { name: "empty stdout", result: { status: 0, stdout: "", stderr: "" } },
    { name: "non-json stdout", result: { status: 0, stdout: "not-json", stderr: "" } },
    { name: "invalid envelope", result: { status: 0, stdout: JSON.stringify({ schemaVersion: 1, status: "bad", hookOutput: {} }), stderr: "" } },
  ];
  for (const failure of failures) {
    const output = adapter.runCanonicalHook("authz", canonical, root, { QDM_HARNESS_CLI: cli }, "", () => failure.result);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny", failure.name);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /QDM_AUTHZ_HOOK_UNAVAILABLE/, failure.name);
    assert.equal(Object.hasOwn(output.hookSpecificOutput, "updatedInput"), false, failure.name);
  }
});

test("WorkBuddy adapter preserves unsafe-range numbers through an allow envelope", () => {
  const canonical = adapter.parseLosslessJSON('{"tool_input":{"command":"qdm-metric-cli auth describe","large":92233720368547758070}}');
  const envelope = '{"schemaVersion":1,"status":"allow","hookOutput":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"rewritten","large":92233720368547758070}}}}';
  const output = adapter.validateAuthzEnvelope(envelope, canonical);
  assert.ok(output);
  assert.match(adapter.stringifyLosslessJSON(output), /92233720368547758070/);
});

test("WorkBuddy authz output validator rejects unchanged gated commands", () => {
  const command = "./original/qdm-metric-cli.exe auth describe \\--auth-blob 'qdm1enc.model'";
  const canonical = { tool_input: { command, timeout_ms: 10000 } };
  const unchanged = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command, timeout_ms: 10000 },
    },
  });
  assert.equal(adapter.validateHookOutput("authz", unchanged, canonical), null);
});

test("WorkBuddy adapter accepts the validated Windows auth runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-windows-runtime-"));
  const cliRoot = path.join(root, "resources", "app.asar.unpacked", "cli");
  fs.mkdirSync(cliRoot, { recursive: true });
  fs.writeFileSync(path.join(cliRoot, "product.json"), JSON.stringify({ genieVersion: "5.3.11" }));
  fs.writeFileSync(path.join(cliRoot, "package.json"), JSON.stringify({
    publishConfig: { customPackage: { version: "2.115.0" } },
  }));
  const detected = adapter.detectAuthRuntime({ WORKBUDDY_APP_PATH: root }, "win32");
  assert.equal(detected.supported, true);
  assert.equal(detected.workBuddyVersion, "5.3.11");
  assert.equal(detected.codeBuddyVersion, "2.115.0");
  assert.equal(adapter.detectAuthRuntime({}, "linux").supported, false);
});

test("WorkBuddy authz adapter fails closed when CLI is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-workbuddy-authz-off-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "config", "harness-config.yaml"), "authz:\n  mode: off\n");
  const result = runAdapter("authz", {
    session_id: "off",
    tool_name: "PowerShell",
    tool_input: { command: ".\\bin\\qdm-metric-cli.exe auth describe" },
    cwd: root,
  }, {
    CODEBUDDY_PROJECT_DIR: root,
    QDM_HARNESS_CLI: path.join(root, "bin", "missing-data-harness-cli.exe"),
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /QDM_AUTHZ_HOOK_UNAVAILABLE/);
});

test("WorkBuddy authz adapter is a no-op outside Harness projects even for incomplete payloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ordinary-workbuddy-authz-"));
  const result = runAdapter("authz", {
    session_id: "ordinary",
    tool_name: "execute_command",
    tool_input: {},
    cwd: root,
  }, { CODEBUDDY_PROJECT_DIR: root });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
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
  return runAdapterRaw(mode, JSON.stringify(payload), env);
}

function runAdapterRaw(mode, input, env = {}) {
  return spawnSync(process.execPath, [adapterPath, mode], {
    input,
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
