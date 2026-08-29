import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { collectRootDoctor, doctorCommand } from "../src/commands/doctor.js";
import { installRuntimeBundle } from "../src/commands/install.js";
import { pathsCommand } from "../src/commands/paths.js";
import { reportCommand } from "../src/commands/report.js";
import { setupCommand } from "../src/commands/setup.js";
import { resolveRootContext } from "../src/lib/root-context.js";
import { runWorkbuddy } from "../../.agents/workbuddy/scripts/html-report-workbuddy.mjs";

const npmRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(npmRoot, "bin", "harness-data.js");

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "qdm-harness-golden-path-")));
  const pluginRoot = path.join(root, "plugin");
  const dataRoot = path.join(root, "data");
  const secretRoot = path.join(root, "secrets");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(path.join(pluginRoot, "bootstrap"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "bin"), { recursive: true });
  fs.mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "bootstrap", "cli-manifest.json"), JSON.stringify({ schemaVersion: 2, tools: [] }));
  const metricCli = path.join(pluginRoot, "bin", "qdm-metric-cli");
  fs.writeFileSync(metricCli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(metricCli, 0o755);
  const secretPath = path.join(secretRoot, "codex.blob");
  fs.writeFileSync(secretPath, "qdm1enc.golden-path-secret\n", { mode: 0o600 });
  fs.chmodSync(secretPath, 0o600);
  const contextFile = path.join(root, "context.json");
  fs.writeFileSync(contextFile, JSON.stringify({
    schemaVersion: 1,
    host: "codex",
    pluginRoot,
    dataRoot,
    secretRoot,
    workspaceRoot,
    secretRef: { kind: "file", path: secretPath },
    sessionId: "golden-session",
  }, null, 2));
  return { root, pluginRoot, dataRoot, secretRoot, workspaceRoot, metricCli, secretPath, contextFile };
}

function capture(env = process.env) {
  let stdout = "";
  let stderr = "";
  return {
    env,
    stdout: { write(value) { stdout += String(value); } },
    stderr: { write(value) { stderr += String(value); } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

function listTree(root, prefix = "") {
  const entries = [];
  for (const name of fs.readdirSync(path.join(root, prefix))) {
    const relative = path.join(prefix, name);
    const full = path.join(root, relative);
    entries.push(relative);
    if (fs.statSync(full).isDirectory()) entries.push(...listTree(root, relative));
  }
  return entries;
}

test("Codex setup is idempotent and keeps mutable files outside pluginRoot", async () => {
  const f = fixture();
  const before = listTree(f.pluginRoot).sort();
  if (process.platform !== "win32") fs.chmodSync(f.pluginRoot, 0o555);
  const first = await setupCommand({
    contextFile: f.contextFile,
    metricCliPath: f.metricCli,
    json: true,
  }, capture());
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.metricCli.status, "ready");
  assert.equal(first.secret.status, "configured");
  assert.equal(fs.existsSync(path.join(f.dataRoot, "install-manifest.json")), true);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "config", "settings.json")), true);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), false);

  const second = await setupCommand({
    contextFile: f.contextFile,
    metricCliPath: f.metricCli,
    json: true,
  }, capture());
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.deepEqual(listTree(f.pluginRoot).sort(), before);
  assert.equal(fs.existsSync(second.metricCli.path), true);
  assert.equal((fs.statSync(second.metricCli.path).mode & 0o111) !== 0, true);
  if (process.platform !== "win32") fs.chmodSync(f.pluginRoot, 0o755);
});

test("structured paths and doctor expose five roots without secret contents", async () => {
  const f = fixture();
  const context = resolveRootContext({ contextFile: f.contextFile, metricCliPath: f.metricCli });
  await setupCommand({ contextFile: f.contextFile, metricCliPath: f.metricCli }, capture());

  const pathsIo = capture();
  const paths = pathsCommand({ contextFile: f.contextFile, json: true }, pathsIo);
  const output = JSON.parse(pathsIo.stdoutText);
  assert.equal(paths.roots.pluginRoot, f.pluginRoot);
  assert.deepEqual(Object.keys(output.roots).sort(), ["dataRoot", "pluginRoot", "secretRoot", "stateRoot", "workspaceRoot"]);
  assert.equal(output.secretRef.kind, "file");
  assert.doesNotMatch(pathsIo.stdoutText, /golden-path-secret/);

  const report = await collectRootDoctor(context);
  assert.equal(report.host, "codex");
  assert.equal(report.roots.dataRoot, f.dataRoot);
  assert.equal(report.roots.stateRoot.startsWith(f.dataRoot), true);
  assert.equal(report.secret.type, "file");
  assert.equal(report.secret.status, "configured");
  assert.equal(report.versions.runtimeHash.length, 64);
  assert.equal(report.checks.some((check) => check.name === "qdm-metric-cli" && check.ok), true);
  assert.equal(JSON.stringify(report).includes("golden-path-secret"), false);
});

test("structured doctor is read-only and does not create project state", async () => {
  const f = fixture();
  await setupCommand({ contextFile: f.contextFile, metricCliPath: f.metricCli }, capture());
  const beforeState = fs.existsSync(path.join(f.dataRoot, "state"));
  const beforeWorkspace = fs.existsSync(path.join(f.workspaceRoot, ".harness"));
  const io = capture();
  const report = await doctorCommand({ contextFile: f.contextFile, json: true }, io);
  assert.equal(report.host, "codex");
  assert.equal(fs.existsSync(path.join(f.dataRoot, "state")), beforeState);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), beforeWorkspace);
  assert.doesNotMatch(io.stdoutText, /golden-path-secret/);
});

test("doctor JSON is available through the qdm-harness CLI alias contract", async () => {
  const f = fixture();
  await setupCommand({ contextFile: f.contextFile, metricCliPath: f.metricCli }, capture());
  const result = spawnSync(process.execPath, [cli, "doctor", "--context-file", f.contextFile, "--json"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.host, "codex");
  assert.equal(report.secretSourceType, "file");
  assert.equal(report.ok, true);
  assert.doesNotMatch(result.stdout, /golden-path-secret/);
});

test("paths command works through the qdm-harness-compatible CLI entrypoint", () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [cli, "paths", "--context-file", f.contextFile, "--json"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.host, "codex");
  assert.equal(output.roots.pluginRoot, f.pluginRoot);
  assert.equal(output.roots.dataRoot, f.dataRoot);
});

test("Codex hook template falls back to an explicit plugin root and gives a setup hint", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(npmRoot, "..", ".agents", "codex", "hooks.json"), "utf8"));
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
    const command = hooks.hooks[event][0].hooks[0].command;
    assert.match(command, /HARNESS_PLUGIN_ROOT/);
    assert.match(command, /QDM_SETUP_REQUIRED/);
  }
});

test("explicit Codex report start keeps session state under stateRoot", async () => {
  const f = fixture();
  const result = await runWorkbuddy([
    "start",
    "--session",
    "report-session",
    "--context-file",
    f.contextFile,
    "--phase-a",
    "agent",
  ]);
  assert.equal(result.ok, true, result.error || result.message);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), false);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "state")), true);
  const status = await runWorkbuddy([
    "status",
    "--session",
    "report-session",
    "--context-file",
    f.contextFile,
    "--format",
    "json",
  ]);
  assert.equal(status.ok, true, status.error || status.message);
  assert.match(status.message, /report-session|A_CONFIG|html-report/);
});

test("qdm-harness report wrapper forwards an explicit lifecycle command", async () => {
  const f = fixture();
  const runner = path.join(npmRoot, "..", ".agents", "workbuddy", "scripts", "html-report-workbuddy.mjs");
  if (process.platform !== "win32") fs.chmodSync(f.pluginRoot, 0o555);
  const output = capture();
  const report = await reportCommand({
    _: ["start"],
    contextFile: f.contextFile,
    runner,
    sessionId: "wrapped-report",
    phaseA: "agent",
    json: true,
  }, output);
  assert.equal(report.ok, true, report.stderr || report.stdout);
  const body = JSON.parse(output.stdoutText);
  assert.equal(body.action, "start");
  assert.equal(body.context.host, "codex");
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), false);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "state")), true);
  if (process.platform !== "win32") fs.chmodSync(f.pluginRoot, 0o755);

  const statusOutput = capture();
  const resumed = await reportCommand({
    _: ["status"],
    contextFile: f.contextFile,
    runner,
    sessionId: "wrapped-report",
    format: "json",
    json: true,
  }, statusOutput);
  assert.equal(resumed.ok, true, resumed.stderr || resumed.stdout);
  assert.match(statusOutput.stdoutText, /wrapped-report|A_CONFIG|html-report/);
});

test("clean-install fixture stages a relocatable Codex runtime without touching a project", async () => {
  const f = fixture();
  const source = path.join(f.root, "runtime-source");
  fs.mkdirSync(path.join(source, "agents", "codex", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(source, "bootstrap"), { recursive: true });
  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.mkdirSync(path.join(source, "packages", "data-harness-cli", "src"), { recursive: true });
  fs.mkdirSync(path.join(source, "plugins", "qdm-html-report"), { recursive: true });
  fs.writeFileSync(path.join(source, "bootstrap", "cli-manifest.json"), JSON.stringify({ schemaVersion: 2, tools: [] }));
  fs.writeFileSync(path.join(source, "config", "settings.example.json"), "{}\n");
  fs.writeFileSync(path.join(source, "packages", "data-harness-cli", "src", "main.js"), "export async function main() {}\n");
  fs.writeFileSync(path.join(source, "plugins", "qdm-html-report", "plugin.txt"), "fixture\n");
  const archive = path.join(f.root, "runtime-fixture.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "."], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);

  const runtimeDir = path.join(f.root, "runtime");
  const bundle = await installRuntimeBundle(runtimeDir, {
    _harnessRelease: { tag: "fixture", assets: { runtime: { name: "fixture.tar.gz" } } },
    downloadAsset: async (_asset, destination) => fs.copyFileSync(archive, destination),
  });
  assert.equal(bundle.tag, "fixture");
  assert.equal(fs.existsSync(path.join(runtimeDir, "agents")), true);
  assert.equal(fs.existsSync(path.join(runtimeDir, "bootstrap", "cli-manifest.json")), true);
  assert.equal(fs.existsSync(path.join(runtimeDir, "plugins", "qdm-html-report", "plugin.txt")), true);
  assert.equal(fs.existsSync(path.join(runtimeDir, "bin", "data-harness-cli")), true);
  assert.equal(fs.existsSync(path.join(f.root, "workspace", ".harness")), false);
});

test("root context rejects a missing workspace only for write-capable callers", () => {
  const f = fixture();
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
  const context = resolveRootContext({ contextFile: f.contextFile, metricCliPath: f.metricCli });
  assert.equal(context.workspaceRoot, f.workspaceRoot);
  assert.equal(context.capabilities.canWriteWorkspace, false);
});

test("report lifecycle fails closed when the declared workspace is unavailable", async () => {
  const f = fixture();
  fs.rmSync(f.workspaceRoot, { recursive: true, force: true });
  await assert.rejects(
    reportCommand({
      _: ["start"],
      contextFile: f.contextFile,
      runner: path.join(npmRoot, "..", ".agents", "workbuddy", "scripts", "html-report-workbuddy.mjs"),
      sessionId: "missing-workspace",
      phaseA: "agent",
    }),
    (error) => error?.code === "QDM_WORKSPACE_REQUIRED",
  );
});
