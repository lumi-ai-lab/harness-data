import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePlugin = path.join(repoRoot, "plugins", "harness-data");

function includeSource(source) {
  const name = path.basename(source);
  if (["dist", "test", "tests", "node_modules"].includes(name)) return false;
  return !/\.(?:test|spec)\.(?:[cm]?[jt]s|ts)$/i.test(name);
}

function stagePlugin(target, version, wikis) {
  cpSync(sourcePlugin, target, { recursive: true, filter: includeSource });
  rmSync(path.join(target, "resources", "wikis"), { recursive: true, force: true });
  cpSync(wikis, path.join(target, "resources", "wikis"), { recursive: true, filter: includeSource });
  const manifestPath = path.join(target, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  const dist = path.join(target, "dist");
  for (const name of ["data-harness-cli", "harness-runtime-node", "html-report-kernel"]) {
    cpSync(path.join(repoRoot, "packages", name), path.join(dist, name), { recursive: true, filter: includeSource });
  }
  cpSync(path.join(repoRoot, "npm"), path.join(dist, "harness-data-installer"), { recursive: true, filter: includeSource });
  mkdirSync(path.join(target, "bootstrap"), { recursive: true });
  cpSync(path.join(repoRoot, "bootstrap", "cli-manifest.json"), path.join(target, "bootstrap", "cli-manifest.json"));
  chmodSync(path.join(target, "scripts", "data-harness-cli"), 0o755);
  chmodSync(path.join(target, "scripts", "setup.mjs"), 0o755);
}

function seedSalesAmountWiki(wikis) {
  const metricRoot = path.join(wikis, "metrics", "销售额");
  mkdirSync(metricRoot, { recursive: true });
  writeFileSync(path.join(metricRoot, "index.md"), "# 销售额\n");
  writeFileSync(path.join(metricRoot, "spec.md"), `---
name: "metric_sale_amt"
label: "销售额"
aliases:
  - saleAmt
---

# 销售额指标说明

销售额是门店销售商品的总金额。
`);
  writeFileSync(path.join(metricRoot, "playbook.md"), `---
name: "playbook_metric_sale_amt"
label: "销售额取数手册"
---

# 销售额取数手册

用户询问销售额当前值时，使用本手册并通过 qdm-metric-cli 查询。
`);

  const cliRuleRoot = path.join(wikis, "rules", "qdm-metric-cli");
  mkdirSync(cliRuleRoot, { recursive: true });
  writeFileSync(path.join(cliRuleRoot, "spec.md"), "# 可信 qdm-metric-cli 使用规范\n");
  const timeRuleRoot = path.join(wikis, "rules", "QDM 时间口径");
  mkdirSync(timeRuleRoot, { recursive: true });
  writeFileSync(path.join(timeRuleRoot, "spec.md"), "# 可信 QDM 时间口径\n");
}

function setTreeMode(root, directoryMode, fileMode) {
  if (process.platform === "win32") return;
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const entry = path.join(directory, name);
      const info = lstatSync(entry);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        visit(entry);
        chmodSync(entry, directoryMode);
      } else {
        chmodSync(entry, (info.mode & 0o111) ? directoryMode : fileMode);
      }
    }
  };
  visit(root);
  chmodSync(root, directoryMode);
}

function fixture() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "qdm-plugin-clean-room-")));
  const pluginV1 = path.join(root, "plugin-v1");
  const pluginV2 = path.join(root, "plugin-v2");
  const codexHome = path.join(root, "codex-home");
  const dataRoot = path.join(root, "data");
  const secretRoot = path.join(root, "secrets");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const wikis = path.join(root, "wikis");
  for (const directory of [codexHome, secretRoot, projectA, projectB, ...["metrics", "reports", "dims", "rules"].map((name) => path.join(wikis, name))]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path.join(wikis, "index.md"), "# Wikis\n");
  for (const name of ["metrics", "reports", "dims", "rules"]) writeFileSync(path.join(wikis, name, "sample.md"), `# ${name}\n`);
  const secretPath = path.join(secretRoot, "auth.blob");
  writeFileSync(secretPath, "qdm1enc.clean-room-secret\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(secretPath, 0o600);
  const metricCli = path.join(root, process.platform === "win32" ? "qdm-metric-cli.cmd" : "qdm-metric-cli");
  writeFileSync(metricCli, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(metricCli, 0o755);
  stagePlugin(pluginV1, "1.0.0-test", wikis);
  stagePlugin(pluginV2, "1.0.1-test", wikis);
  return { root, pluginV1, pluginV2, codexHome, dataRoot, secretRoot, secretPath, projectA, projectB, wikis, metricCli };
}

function runNode(script, args, { cwd, env, input } = {}) {
  return runChild(process.execPath, [script, ...args], { cwd, env, input });
}

function runShell(command, { cwd, env, input } = {}) {
  return runChild("bash", ["-c", command], { cwd, env, input });
}

function runChild(command, args, { cwd, env, input } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (input) child.stdin.end(input);
    else child.stdin.end();
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function assertCodexUserPromptSubmitOutput(value) {
  const allowedTopLevel = new Set(["continue", "decision", "hookSpecificOutput", "reason", "stopReason", "suppressOutput", "systemMessage"]);
  const allowedHookSpecific = new Set(["additionalContext", "hookEventName"]);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).filter((key) => !allowedTopLevel.has(key)), []);
  assert.ok(value.hookSpecificOutput && typeof value.hookSpecificOutput === "object" && !Array.isArray(value.hookSpecificOutput));
  assert.deepEqual(Object.keys(value.hookSpecificOutput).filter((key) => !allowedHookSpecific.has(key)), []);
  assert.equal(value.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(typeof value.hookSpecificOutput.additionalContext, "string");
}

function extractTrustedContextFilePaths(additionalContext) {
  const match = String(additionalContext || "").match(/必须先读取以下 contextFiles[^\n]*：\n([\s\S]*?)\n\nInstruction:/);
  if (!match) return [];
  return [...match[1].matchAll(/^- `([^`]+)`/gm)].map((entry) => entry[1]);
}

function startMcp(t, pluginRoot, env) {
  const child = spawn(process.execPath, [path.join(pluginRoot, "mcp", "server.mjs")], {
    cwd: pluginRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const done = pending.get(message.id);
      if (done) {
        pending.delete(message.id);
        done(message);
      }
    }
  });
  return async (name, args) => {
    const id = nextId++;
    const response = new Promise((resolveResponse) => pending.set(id, resolveResponse));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    const message = await response;
    assert.equal(message.error, undefined, message.error?.message);
    return JSON.parse(message.result.content[0].text);
  };
}

test("plugin setup enables hooks and MCP from arbitrary projects with isolated state", async (t) => {
  const f = fixture();
  t.after(() => {
    setTreeMode(f.pluginV1, 0o755, 0o644);
    setTreeMode(f.pluginV2, 0o755, 0o644);
    rmSync(f.root, { recursive: true, force: true });
  });

  const env = { ...process.env, CODEX_HOME: f.codexHome };
  const setup = await runNode(path.join(f.pluginV1, "scripts", "setup.mjs"), [
    "--data-root", f.dataRoot,
    "--workspace-root", f.projectA,
    "--workspace-allowlist", f.projectA,
    "--workspace-allowlist", f.projectB,
    "--auth-blob-file", f.secretPath,
    "--auth-user-id", "clean-room-user",
    "--metric-cli", f.metricCli,
    "--json",
  ], { cwd: f.projectA, env });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const setupReport = JSON.parse(setup.stdout);
  assert.equal(setupReport.ok, true);
  assert.equal(setupReport.pluginScope.status, "written");
  assert.equal(setupReport.pluginScope.selector, "harness-data@lumi-ai-lab");
  assert.match(readFileSync(path.join(f.codexHome, "config.toml"), "utf8"), /\[plugins\."harness-data@lumi-ai-lab"\]\nenabled = false/);
  assert.match(readFileSync(path.join(f.projectA, ".codex", "config.toml"), "utf8"), /enabled = true/);
  assert.match(readFileSync(path.join(f.projectB, ".codex", "config.toml"), "utf8"), /enabled = true/);
  assert.equal(existsSync(path.join(f.pluginV1, "context.json")), true);
  assert.equal(existsSync(path.join(f.pluginV1, ".harness", "index", "wikis-index.json")), true);
  assert.equal(existsSync(path.join(f.pluginV1, "secrets", "auth.blob")), true);
  assert.equal(existsSync(path.join(f.dataRoot, "state")), false);
  assert.equal(existsSync(path.join(f.projectA, ".harness")), false);
  const persistedContextPath = path.join(f.pluginV1, "context.json");
  const persistedBeforeFailure = readFileSync(persistedContextPath, "utf8");
  const failedUpdate = await runNode(path.join(f.pluginV1, "scripts", "setup.mjs"), [
    "--data-root", f.dataRoot,
    "--workspace-root", f.projectA,
    "--workspace-allowlist", f.projectA,
    "--auth-blob-file", path.join(f.secretRoot, "missing.blob"),
    "--auth-user-id", "clean-room-user",
    "--metric-cli", f.metricCli,
    "--json",
  ], { cwd: f.projectA, env });
  assert.notEqual(failedUpdate.status, 0);
  assert.equal(readFileSync(persistedContextPath, "utf8"), persistedBeforeFailure);
  assert.equal(existsSync(setupReport.metricCli.path), true);

  const hook = await runNode(path.join(f.pluginV1, "scripts", "data-harness-cli"), ["context", "--format", "codex-hook"], {
    cwd: f.pluginV1,
    env,
    input: `${JSON.stringify({ prompt: "请修复 CSS", cwd: f.projectA, session_id: "hook-a" })}\n`,
  });
  assert.equal(hook.status, 0, hook.stderr || hook.stdout);
  const hookJSON = JSON.parse(hook.stdout);
  assertCodexUserPromptSubmitOutput(hookJSON);
  assert.match(hookJSON.hookSpecificOutput.additionalContext, /Harness mode: free/);
  assert.equal(existsSync(path.join(f.projectA, ".harness")), false);

  const mcpEnvA = {
    ...env,
    PWD: f.projectA,
    HARNESS_WORKSPACE_ROOT: f.projectA,
    HARNESS_DATA_ROOT: path.join(f.root, "untrusted-env-data"),
    HTML_REPORT_METRIC_CLI_UI_OPEN: "0",
  };
  const callA = startMcp(t, f.pluginV1, mcpEnvA);
  const started = await callA("html_report_start", { sessionId: "shared-session", userQuestion: "test" });
  assert.equal(started.sessionDir.startsWith(path.join(f.dataRoot, "state", "workspaces")), true);
  assert.equal(existsSync(path.join(f.projectA, ".harness")), false);
  const status = await callA("html_report_status", { sessionId: "shared-session" });
  assert.equal(status.sessionId, "shared-session");

  const setupV2 = await runNode(path.join(f.pluginV2, "scripts", "setup.mjs"), [
    "--data-root", f.dataRoot,
    "--workspace-root", f.projectA,
    "--workspace-allowlist", f.projectA,
    "--workspace-allowlist", f.projectB,
    "--auth-blob-file", f.secretPath,
    "--auth-user-id", "clean-room-user",
    "--metric-cli", f.metricCli,
    "--json",
  ], { cwd: f.projectA, env });
  assert.equal(setupV2.status, 0, setupV2.stderr || setupV2.stdout);
  const callAfterUpgrade = startMcp(t, f.pluginV2, mcpEnvA);
  const resumed = await callAfterUpgrade("html_report_status", { sessionId: "shared-session" });
  assert.equal(resumed.sessionId, "shared-session");
  const upgradedHook = await runNode(path.join(f.pluginV2, "scripts", "data-harness-cli"), ["context", "--format", "codex-hook"], {
    cwd: f.pluginV2,
    env,
    input: `${JSON.stringify({ prompt: "继续", cwd: f.projectA, session_id: "hook-a" })}\n`,
  });
  assert.equal(upgradedHook.status, 0, upgradedHook.stderr || upgradedHook.stdout);

  const mcpEnvB = { ...env, PWD: f.projectB, HARNESS_WORKSPACE_ROOT: f.projectB, HTML_REPORT_METRIC_CLI_UI_OPEN: "0" };
  const callB = startMcp(t, f.pluginV2, mcpEnvB);
  const startedB = await callB("html_report_start", { sessionId: "shared-session", userQuestion: "test-b" });
  assert.notEqual(startedB.sessionDir, started.sessionDir);
  assert.equal(existsSync(path.join(f.projectB, ".harness")), false);
});

test("Codex UserPromptSubmit materializes trusted sales context outside the workspace", async (t) => {
  const f = fixture();
  seedSalesAmountWiki(path.join(f.pluginV1, "resources", "wikis"));
  const cachedPlugin = path.join(f.codexHome, "plugins", "cache", "lumi-ai-lab", "harness-data", "0.0.54-test");
  cpSync(f.pluginV1, cachedPlugin, { recursive: true });
  chmodSync(path.join(cachedPlugin, "scripts", "data-harness-cli"), 0o755);
  t.after(() => {
    setTreeMode(f.pluginV1, 0o755, 0o644);
    setTreeMode(f.pluginV2, 0o755, 0o644);
    rmSync(f.root, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    CODEX_HOME: f.codexHome,
    QDM_HARNESS_CURRENT_DATE: "2026-08-30",
    QDM_HARNESS_TIMEZONE: "Asia/Shanghai",
  };
  const setup = await runNode(path.join(cachedPlugin, "scripts", "setup.mjs"), [
    "--data-root", f.dataRoot,
    "--workspace-root", f.projectA,
    "--workspace-allowlist", f.projectA,
    "--workspace-allowlist", f.projectB,
    "--auth-blob-file", f.secretPath,
    "--auth-user-id", "clean-room-user",
    "--metric-cli", f.metricCli,
    "--json",
  ], { cwd: f.projectA, env });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  assert.equal(existsSync(path.join(f.projectA, "wikis")), false);

  if (process.platform === "win32") {
    t.skip("Codex native plugin hook command currently requires Bash");
    return;
  }
  const hooks = JSON.parse(readFileSync(path.join(cachedPlugin, "hooks", "hooks.json"), "utf8"));
  const hookCommand = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const hook = await runShell(hookCommand, {
    cwd: f.projectA,
    env,
    input: `${JSON.stringify({
      session_id: "sales-hook-session",
      turn_id: "sales-turn-1",
      transcript_path: path.join(f.root, "transcript.jsonl"),
      cwd: f.projectA,
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.6",
      permission_mode: "workspace-write",
      prompt: "查看昨天的销售额",
    })}\n`,
  });
  assert.equal(hook.status, 0, `UserPromptSubmit hook failed: ${hook.stderr || hook.stdout}`);
  const hookJSON = JSON.parse(hook.stdout);
  assertCodexUserPromptSubmitOutput(hookJSON);
  const hookOutput = hookJSON.hookSpecificOutput;
  assert.equal(Object.hasOwn(hookOutput, "contextFiles"), false);
  assert.match(hookOutput.additionalContext, /Harness mode: single/);
  assert.match(hookOutput.additionalContext, /selectedPlaybook: metrics\/销售额\/playbook\.md/);
  assert.match(hookOutput.additionalContext, /current_date.*2026-08-30/);
  assert.match(hookOutput.additionalContext, /不得按 workspaceRoot 解析/);
  const expectedContextFiles = [
    path.join(cachedPlugin, "resources", "wikis", "rules", "qdm-metric-cli", "spec.md"),
    path.join(cachedPlugin, "resources", "wikis", "rules", "QDM 时间口径", "spec.md"),
    path.join(cachedPlugin, "resources", "wikis", "metrics", "销售额", "playbook.md"),
  ].map((filePath) => realpathSync(filePath));
  assert.deepEqual(extractTrustedContextFilePaths(hookOutput.additionalContext), expectedContextFiles);
  assert.equal(hookOutput.additionalContext.includes(`resourceRoot: \`${realpathSync(cachedPlugin)}\``), true);
  assert.equal(hookOutput.additionalContext.includes(expectedContextFiles[1]), true);
  for (const filePath of expectedContextFiles) {
    assert.equal(filePath.startsWith(realpathSync(f.projectA)), false);
    assert.match(readFileSync(filePath, "utf8"), /可信|销售额取数手册/);
  }
  const workspaceRead = await runChild(process.execPath, [
    "-e",
    "const fs = require('node:fs'); for (const file of JSON.parse(fs.readFileSync(0, 'utf8'))) fs.readFileSync(file);",
  ], {
    cwd: f.projectA,
    env,
    input: JSON.stringify(expectedContextFiles),
  });
  assert.equal(workspaceRead.status, 0, workspaceRead.stderr || workspaceRead.stdout);

  for (const trustedPath of expectedContextFiles) {
    const relative = path.relative(path.join(cachedPlugin, "resources", "wikis"), trustedPath);
    const shadowPath = path.join(f.projectA, "wikis", relative);
    mkdirSync(path.dirname(shadowPath), { recursive: true });
    writeFileSync(shadowPath, "# 工作区同名伪文件\n");
  }
  const shadowHook = await runShell(hookCommand, {
    cwd: f.projectA,
    env,
    input: `${JSON.stringify({
      session_id: "sales-shadow-session",
      cwd: f.projectA,
      hook_event_name: "UserPromptSubmit",
      prompt: "查看昨天的销售额",
    })}\n`,
  });
  assert.equal(shadowHook.status, 0, shadowHook.stderr || shadowHook.stdout);
  const shadowOutput = JSON.parse(shadowHook.stdout).hookSpecificOutput.additionalContext;
  assert.deepEqual(extractTrustedContextFilePaths(shadowOutput), expectedContextFiles);
  assert.equal(shadowOutput.includes(realpathSync(path.join(f.projectA, "wikis"))), false);

  const agentHook = await runNode(path.join(cachedPlugin, "scripts", "data-harness-cli"), ["context", "--format", "agent-hook"], {
    cwd: f.projectA,
    env,
    input: `${JSON.stringify({
      session_id: "sales-agent-hook-session",
      turn_id: "sales-turn-2",
      transcript_path: path.join(f.root, "transcript.jsonl"),
      cwd: f.projectA,
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.6",
      permission_mode: "workspace-write",
      prompt: "查看昨天的销售额",
    })}\n`,
  });
  assert.equal(agentHook.status, 0, agentHook.stderr || agentHook.stdout);
  const agentHookOutput = JSON.parse(agentHook.stdout).hookSpecificOutput;
  assert.ok(Array.isArray(agentHookOutput.contextFiles));
  assert.ok(agentHookOutput.contextFiles.some((ref) => ref.path.endsWith(path.join("metrics", "销售额", "playbook.md"))));

  const ordinaryHook = await runShell(hookCommand, {
    cwd: f.projectA,
    env,
    input: `${JSON.stringify({
      session_id: "ordinary-hook-session",
      turn_id: "ordinary-turn-1",
      transcript_path: path.join(f.root, "transcript.jsonl"),
      cwd: f.projectA,
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.6",
      permission_mode: "workspace-write",
      prompt: "请帮我写一个 JavaScript 函数",
    })}\n`,
  });
  assert.equal(ordinaryHook.status, 0, ordinaryHook.stderr || ordinaryHook.stdout);
  const ordinaryJSON = JSON.parse(ordinaryHook.stdout);
  assertCodexUserPromptSubmitOutput(ordinaryJSON);
  assert.match(ordinaryJSON.hookSpecificOutput.additionalContext, /Harness mode: free/);
  assert.doesNotMatch(ordinaryJSON.hookSpecificOutput.additionalContext, /metrics[\\/]销售额[\\/]playbook\\.md/);
  assert.equal(existsSync(path.join(f.projectA, ".harness")), false);
});

test("plugin setup fails closed and does not publish context without a secret", async (t) => {
  const f = fixture();
  t.after(() => {
    setTreeMode(f.pluginV1, 0o755, 0o644);
    setTreeMode(f.pluginV2, 0o755, 0o644);
    rmSync(f.root, { recursive: true, force: true });
  });
  const badCodexHome = path.join(f.root, "bad-codex-home");
  mkdirSync(badCodexHome, { recursive: true });
  const failed = await runNode(path.join(f.pluginV1, "scripts", "setup.mjs"), [
    "--data-root", path.join(f.root, "bad-data"),
    "--workspace-root", f.projectA,
    "--workspace-allowlist", f.projectA,
    "--metric-cli", f.metricCli,
    "--yes",
    "--json",
  ], { cwd: f.projectA, env: { ...process.env, CODEX_HOME: badCodexHome } });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /QDM_SECRET_UNAVAILABLE/);
  assert.equal(existsSync(path.join(f.pluginV1, "secrets")), false);
  assert.equal(existsSync(path.join(f.pluginV1, "context.json")), false);

  const missingPrincipal = await runNode(path.join(f.pluginV1, "scripts", "setup.mjs"), [
    "--data-root", path.join(f.root, "principal-data"),
    "--workspace-root", f.projectA,
    "--workspace-allowlist", f.projectA,
    "--workspace-allowlist", f.projectB,
    "--auth-blob-file", f.secretPath,
    "--metric-cli", f.metricCli,
    "--json",
  ], { cwd: f.projectA, env: { ...process.env, CODEX_HOME: badCodexHome, HARNESS_AUTH_USER_ID: "" } });
  assert.notEqual(missingPrincipal.status, 0);
  assert.match(missingPrincipal.stderr, /auth-user-id|HARNESS_AUTH_USER_ID/);

  const ephemeralSecret = await runNode(path.join(f.pluginV1, "scripts", "setup.mjs"), [
    "--data-root", path.join(f.root, "fd-data"),
    "--workspace-root", f.projectA,
    "--workspace-allowlist", f.projectA,
    "--secret-ref", JSON.stringify({ kind: "fd", fd: 3 }),
    "--auth-user-id", "clean-room-user",
    "--metric-cli", f.metricCli,
    "--json",
  ], { cwd: f.projectA, env: { ...process.env, CODEX_HOME: badCodexHome } });
  assert.notEqual(ephemeralSecret.status, 0);
  assert.match(ephemeralSecret.stderr, /file secretRef/);
  assert.equal(existsSync(path.join(f.pluginV1, "context.json")), false);
});
