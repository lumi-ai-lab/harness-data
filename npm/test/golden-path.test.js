import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { publicRootContext, resolveRootContext } from "../src/lib/root-context.js";
import { runWorkbuddy } from "../../.agents/workbuddy/scripts/html-report-workbuddy.mjs";
import { htmlReportSessionDir } from "../../.agents/workbuddy/scripts/html-report-stage-runner.mjs";
import { rowsSha256 } from "../../packages/html-report-kernel/src/index.mjs";
import { writePluginManifest } from "../../scripts/build-plugin-manifest.mjs";
import { verifyArtifact } from "../../scripts/verify-artifact.mjs";

const npmRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(npmRoot, "bin", "harness-data.js");

function stageTestWikis(pluginRoot) {
  const wikis = path.join(pluginRoot, "resources", "wikis");
  for (const directory of ["metrics", "reports", "dims", "rules"]) {
    fs.mkdirSync(path.join(wikis, directory), { recursive: true });
    fs.writeFileSync(path.join(wikis, directory, "sample.md"), `# ${directory}\n`);
  }
  fs.writeFileSync(path.join(wikis, "index.md"), "# Wikis\n");
}

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "qdm-harness-golden-path-")));
  const pluginRoot = path.join(root, "plugin");
  const dataRoot = path.join(root, "data");
  const secretRoot = path.join(pluginRoot, "secrets");
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "bootstrap"), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, "bin"), { recursive: true });
  stageTestWikis(pluginRoot);
  fs.cpSync(path.join(npmRoot, "..", "packages", "data-harness-cli"), path.join(pluginRoot, "packages", "data-harness-cli"), { recursive: true });
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
  return { root, pluginRoot, dataRoot, secretRoot, workspaceRoot, metricCli, secretPath, contextFile, codexHome };
}

function capture(env = {}) {
  env = { ...process.env, HARNESS_AUTH_USER_ID: "golden-user", ...env };
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

function snapshotTree(root) {
  const entries = [];
  function visit(directory, prefix = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = path.join(prefix, name);
      const full = path.join(directory, name);
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) {
        entries.push({ relative, type: "symlink", target: fs.readlinkSync(full) });
      } else if (info.isDirectory()) {
        entries.push({ relative, type: "directory" });
        visit(full, relative);
      } else {
        entries.push({
          relative,
          type: "file",
          sha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        });
      }
    }
  }
  visit(root);
  return entries;
}

function visitTree(root, visitor) {
  const entries = [root];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    if (fs.lstatSync(full).isDirectory()) entries.push(...visitTree(full, visitor));
    else entries.push(full);
  }
  visitor(root, entries);
  return entries;
}

function setTreeReadOnly(root) {
  if (process.platform === "win32") return;
  const entries = visitTree(root, () => {});
  for (const entry of entries) {
    const info = fs.lstatSync(entry);
    if (info.isSymbolicLink()) continue;
    fs.chmodSync(entry, info.isDirectory() || (info.mode & 0o111) ? 0o555 : 0o444);
  }
}

function setTreeWritable(root) {
  if (process.platform === "win32" || !fs.existsSync(root)) return;
  const entries = visitTree(root, () => {});
  for (const entry of entries) {
    const info = fs.lstatSync(entry);
    if (info.isSymbolicLink()) continue;
    fs.chmodSync(entry, info.isDirectory() ? 0o755 : ((info.mode & 0o111) ? 0o755 : 0o644));
  }
}

function stagePluginRuntime(pluginRoot, version) {
  const sourceRoot = path.join(npmRoot, "..");
  fs.mkdirSync(path.join(pluginRoot, "bin"), { recursive: true });
  stageTestWikis(pluginRoot);
  fs.mkdirSync(path.join(pluginRoot, "bootstrap"), { recursive: true });
  if (!fs.existsSync(path.join(pluginRoot, "bootstrap", "cli-manifest.json"))) {
    fs.writeFileSync(path.join(pluginRoot, "bootstrap", "cli-manifest.json"), JSON.stringify({ schemaVersion: 2, tools: [] }));
  }
  for (const relative of [
    ".agents/codex",
    ".agents/pi",
    ".agents/workbuddy",
    "packages/data-harness-cli",
    "packages/harness-runtime-node",
    "packages/html-report-kernel",
  ]) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(pluginRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
  fs.mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "qdm-harness",
    version,
  }, null, 2));
  const hookCli = path.join(pluginRoot, "bin", "data-harness-cli");
  const entry = path.join(pluginRoot, "packages", "data-harness-cli", "src", "main.js");
  fs.writeFileSync(hookCli, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(hookCli, 0o755);
}

test("Codex environment fallback uses CODEX_HOME as dataRoot and preserves explicit precedence", () => {
  const f = fixture();
  const context = resolveRootContext(
    { pluginRoot: f.pluginRoot },
    { env: { CODEX_HOME: f.dataRoot } },
  );
  assert.equal(context.host, "codex");
  assert.equal(context.dataRoot, path.join(f.dataRoot, "qdm-harness", "data"));
  assert.equal(context.resourceRoot, f.pluginRoot);
  assert.equal(context.secretRoot, path.join(f.pluginRoot, "secrets"));
  assert.equal(context.workspacePolicyPath, path.join(f.pluginRoot, "config", "workspace-policy.json"));

  const explicitDataRoot = path.join(f.root, "explicit-data");
  fs.mkdirSync(explicitDataRoot, { recursive: true });
  const overridden = resolveRootContext(
    { pluginRoot: f.pluginRoot },
    { env: { CODEX_HOME: f.dataRoot, HARNESS_DATA_ROOT: explicitDataRoot } },
  );
  assert.equal(overridden.dataRoot, explicitDataRoot);
});

test("Codex workspace environment participates in stable state identity", () => {
  const f = fixture();
  const context = resolveRootContext(
    { pluginRoot: f.pluginRoot, sessionId: "codex-session" },
    { env: { CODEX_HOME: f.dataRoot, CODEX_WORKSPACE_ROOT: f.workspaceRoot } },
  );
  assert.equal(context.workspaceRoot, f.workspaceRoot);
  assert.match(context.stateRoot, new RegExp(`${path.sep}state${path.sep}workspaces${path.sep}[a-f0-9]{64}$`));
  assert.equal(context.capabilities.hasStableSessionId, true);
});

test("public Codex root context redacts host secret reference details", () => {
  const f = fixture();
  const context = resolveRootContext({
    pluginRoot: f.pluginRoot,
    dataRoot: f.dataRoot,
    secretRef: { kind: "host", id: "keychain-secret-id" },
  });
  const publicContext = publicRootContext(context);
  assert.deepEqual(publicContext.secretRef, { kind: "host" });
  assert.doesNotMatch(JSON.stringify(publicContext), /keychain-secret-id/);
});

function includeArtifactFile(source) {
  const name = path.basename(source);
  return name !== "test" && name !== "tests" && name !== ".harness" && !/\.(?:test|spec)\.(?:[cm]?[jt]s|ts)$/i.test(name);
}

function copyArtifactTree(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, filter: includeArtifactFile });
}

function stageReleaseRuntime(stageRoot, version = "0.0.53-release-smoke") {
  const sourceRoot = path.join(npmRoot, "..");
  fs.mkdirSync(stageRoot, { recursive: true });
  for (const name of ["bootstrap", "config", "bin"]) fs.mkdirSync(path.join(stageRoot, name), { recursive: true });
  for (const name of ["claude", "codex", "pi", "workbuddy", ".codebuddy-plugin", "plugins"]) {
    copyArtifactTree(path.join(sourceRoot, ".agents", name), path.join(stageRoot, "agents", name));
  }
  copyArtifactTree(path.join(sourceRoot, "plugins"), path.join(stageRoot, "plugins"));
  copyArtifactTree(
    path.join(sourceRoot, "packages", "html-report-kernel"),
    path.join(stageRoot, "plugins", "harness-data", "dist", "html-report-kernel"),
  );
  copyArtifactTree(
    path.join(sourceRoot, "packages", "harness-runtime-node"),
    path.join(stageRoot, "plugins", "harness-data", "dist", "harness-runtime-node"),
  );
  copyArtifactTree(
    path.join(sourceRoot, "packages", "data-harness-cli"),
    path.join(stageRoot, "plugins", "harness-data", "dist", "data-harness-cli"),
  );
  copyArtifactTree(
    path.join(sourceRoot, "npm"),
    path.join(stageRoot, "plugins", "harness-data", "dist", "harness-data-installer"),
  );
  copyArtifactTree(
    path.join(sourceRoot, "packages", "data-harness-cli"),
    path.join(stageRoot, "packages", "data-harness-cli"),
  );
  copyArtifactTree(
    path.join(sourceRoot, "packages", "html-report-kernel"),
    path.join(stageRoot, "packages", "html-report-kernel"),
  );
  copyArtifactTree(
    path.join(sourceRoot, "packages", "harness-runtime-node"),
    path.join(stageRoot, "packages", "harness-runtime-node"),
  );
  fs.copyFileSync(path.join(sourceRoot, "bootstrap", "cli-manifest.json"), path.join(stageRoot, "bootstrap", "cli-manifest.json"));
  fs.mkdirSync(path.join(stageRoot, "plugins", "harness-data", "bootstrap"), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRoot, "bootstrap", "cli-manifest.json"),
    path.join(stageRoot, "plugins", "harness-data", "bootstrap", "cli-manifest.json"),
  );
  fs.copyFileSync(path.join(sourceRoot, "config", "harness-config.yaml.example"), path.join(stageRoot, "config", "harness-config.yaml"));
  fs.copyFileSync(path.join(sourceRoot, "config", "harness-config.yaml.example"), path.join(stageRoot, "config", "harness-config.yaml.example"));
  fs.copyFileSync(path.join(sourceRoot, "config", "qdm-cli-paths.env.example"), path.join(stageRoot, "config", "qdm-cli-paths.env.example"));
  fs.copyFileSync(path.join(sourceRoot, "bin", "data-harness-cli"), path.join(stageRoot, "bin", "data-harness-cli"));
  fs.copyFileSync(path.join(sourceRoot, "bin", "data-harness-cli.cmd"), path.join(stageRoot, "bin", "data-harness-cli.cmd"));
  if (process.platform !== "win32") fs.chmodSync(path.join(stageRoot, "bin", "data-harness-cli"), 0o755);
  writePluginManifest({
    artifactRoot: stageRoot,
    host: "runtime",
    pluginName: "qdm-harness",
    pluginVersion: version,
    resourceMode: "external",
  });
  writePluginManifest({
    artifactRoot: path.join(stageRoot, "plugins", "harness-data"),
    host: "codex",
    resourceMode: "external",
  });
  const audit = verifyArtifact(stageRoot, { kind: "runtime" });
  assert.deepEqual(audit.errors, [], audit.errors.join("\n"));
}

function writeRootContext(f, {
  pluginRoot = f.pluginRoot,
  sessionId = "golden-session",
  name = `context-${sessionId}.json`,
  secretRoot = pluginRoot === f.pluginRoot ? f.secretRoot : path.join(pluginRoot, "secrets"),
  secretPath = pluginRoot === f.pluginRoot ? f.secretPath : path.join(secretRoot, "auth.blob"),
} = {}) {
  if (pluginRoot !== f.pluginRoot) {
    fs.mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
    fs.copyFileSync(f.secretPath, secretPath);
    fs.chmodSync(secretPath, 0o600);
  }
  const contextFile = path.join(f.root, name);
  fs.writeFileSync(contextFile, JSON.stringify({
    schemaVersion: 1,
    host: "codex",
    pluginRoot,
    dataRoot: f.dataRoot,
    secretRoot,
    workspaceRoot: f.workspaceRoot,
    secretRef: { kind: "file", path: secretPath },
    sessionId,
  }, null, 2));
  return contextFile;
}

function runHarnessCli(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || os.tmpdir(),
    encoding: "utf8",
    env: { ...process.env, HARNESS_AUTH_USER_ID: "golden-user", ...(options.env || {}) },
    input: options.input,
  });
}

function assertCliSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function runStageGateCommand(pluginRoot, sessionDir, operation, args = []) {
  const script = path.join(pluginRoot, ".agents", "pi", "skills", "html-report", "scripts", "stage-gate.mjs");
  const result = spawnSync(process.execPath, [script, operation, "--session-dir", sessionDir, ...args], {
    cwd: sessionDir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function seedConfirmedReportSession(sessionDir) {
  const cardId = "sales-by-region";
  const rows = [
    { bizDate: "2026-08-01", regionId: "east", saleAmt: 120000, profitAmt: 30000 },
    { bizDate: "2026-08-02", regionId: "west", saleAmt: 40000, profitAmt: 10000 },
  ];
  const cardDir = path.join(sessionDir, "data", "cards", cardId);
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "result.json"), JSON.stringify({
    status: "confirmed",
    session_id: "report-e2e",
    title: "区域销售报告",
    userQuestion: "本月各区域销售表现如何？",
    cards: [{ id: cardId, title: "区域销售" }],
  }, null, 2));
  fs.writeFileSync(path.join(cardDir, "entry.json"), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }, null, 2));
  fs.writeFileSync(path.join(cardDir, "caption.md"), "华东区域销售额为 120000 元，高于华西区域的 40000 元。\n");
}

test("Codex setup is idempotent and stores setup resources in the Plugin", async () => {
  const f = fixture();
  if (process.platform !== "win32") fs.chmodSync(f.pluginRoot, 0o755);
  const first = await setupCommand({
    contextFile: f.contextFile,
    metricCliPath: f.metricCli,
    json: true,
  }, capture({ CODEX_HOME: f.codexHome }));
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);
  assert.equal(first.metricCli.status, "ready");
  assert.equal(first.secret.status, "configured");
  assert.equal(first.pluginScope.status, "written");
  assert.equal(first.pluginScope.selector, "harness-data@lumi-ai-lab");
  assert.equal(fs.existsSync(path.join(f.pluginRoot, "install-manifest.json")), true);
  assert.equal(fs.existsSync(path.join(f.pluginRoot, "config", "settings.json")), true);
  assert.equal(fs.existsSync(path.join(f.pluginRoot, ".harness", "index", "wikis-index.json")), true);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), false);
  const userConfig = fs.readFileSync(path.join(f.codexHome, "config.toml"), "utf8");
  assert.match(userConfig, /\[plugins\."harness-data@lumi-ai-lab"\]\nenabled = false/);
  assert.equal(userConfig.includes(`[projects."${f.workspaceRoot}"]`), true);
  assert.match(userConfig, /trust_level = "trusted"/);
  assert.match(fs.readFileSync(path.join(f.workspaceRoot, ".codex", "config.toml"), "utf8"), /\[plugins\."harness-data@lumi-ai-lab"\]\nenabled = true/);

  const second = await setupCommand({
    contextFile: f.contextFile,
    metricCliPath: f.metricCli,
    json: true,
  }, capture({ CODEX_HOME: f.codexHome }));
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(fs.existsSync(path.join(f.pluginRoot, "context.json")), true);
  assert.equal(fs.existsSync(path.join(f.pluginRoot, "secrets", "auth.blob")), true);
  assert.equal(fs.existsSync(path.join(f.pluginRoot, ".harness", "index", "wikis-runtime-index.json")), true);
  assert.equal(fs.existsSync(second.metricCli.path), true);
  assert.equal((fs.statSync(second.metricCli.path).mode & 0o111) !== 0, true);
  if (process.platform !== "win32") fs.chmodSync(f.pluginRoot, 0o755);
});

test("structured paths and doctor expose all roots without secret contents", async () => {
  const f = fixture();
  const context = resolveRootContext({ contextFile: f.contextFile, metricCliPath: f.metricCli });
  await setupCommand({ contextFile: f.contextFile, metricCliPath: f.metricCli }, capture({ CODEX_HOME: f.codexHome }));

  const pathsIo = capture();
  const paths = pathsCommand({ contextFile: f.contextFile, json: true }, pathsIo);
  const output = JSON.parse(pathsIo.stdoutText);
  assert.equal(paths.roots.pluginRoot, f.pluginRoot);
  assert.deepEqual(Object.keys(output.roots).sort(), ["dataRoot", "pluginRoot", "resourceRoot", "secretRoot", "stateRoot", "workspacePolicyPath", "workspaceRoot"]);
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
  await setupCommand({ contextFile: f.contextFile, metricCliPath: f.metricCli }, capture({ CODEX_HOME: f.codexHome }));
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
  await setupCommand({ contextFile: f.contextFile, metricCliPath: f.metricCli }, capture({ CODEX_HOME: f.codexHome }));
  const result = spawnSync(process.execPath, [cli, "doctor", "--context-file", f.contextFile, "--json"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
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
  await setupCommand({ contextFile: f.contextFile, metricCliPath: f.metricCli }, capture({ CODEX_HOME: f.codexHome }));
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

test("Codex clean-room writes setup resources in the Plugin without creating project state", async (t) => {
  const f = fixture();
  t.after(() => {
    setTreeWritable(f.pluginRoot);
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  stagePluginRuntime(f.pluginRoot, "1.0.0-clean-room");

  assertCliSuccess(runHarnessCli([
    "setup",
    "--context-file", f.contextFile,
    "--metric-cli", f.metricCli,
    "--json",
  ]));
  const paths = JSON.parse(assertCliSuccess(runHarnessCli([
    "paths",
    "--context-file", f.contextFile,
    "--json",
  ])));
  assert.equal(paths.roots.pluginRoot, f.pluginRoot);
  assert.equal(paths.roots.dataRoot, f.dataRoot);
  const doctor = JSON.parse(assertCliSuccess(runHarnessCli([
    "doctor",
    "--context-file", f.contextFile,
    "--json",
  ])));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.secret.status, "configured");

  const started = JSON.parse(assertCliSuccess(runHarnessCli([
    "report",
    "start",
    "--context-file", f.contextFile,
    "--session", "clean-room-session",
    "--phase-a", "agent",
    "--json",
  ])));
  assert.equal(started.ok, true, started.stderr || started.stdout);

  if (process.platform !== "win32") {
    const hooks = JSON.parse(fs.readFileSync(path.join(f.pluginRoot, ".agents", "codex", "hooks.json"), "utf8"));
    const hookCommand = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    const hook = spawnSync("bash", ["-c", hookCommand], {
      cwd: f.workspaceRoot,
      encoding: "utf8",
      input: JSON.stringify({ prompt: "请修复这个 CSS bug", cwd: f.workspaceRoot, session_id: "clean-hook" }),
      env: {
        ...process.env,
        HARNESS_PLUGIN_ROOT: f.pluginRoot,
        HARNESS_DATA_ROOT: f.dataRoot,
        HARNESS_SECRET_ROOT: f.secretRoot,
        HARNESS_SECRET_REF: f.secretPath,
        HARNESS_WORKSPACE_ROOT: f.workspaceRoot,
        HARNESS_HOST: "codex",
      },
    });
    assert.equal(hook.status, 0, hook.stderr || hook.stdout);
    const hookJSON = JSON.parse(hook.stdout);
    assert.ok(hookJSON.hookSpecificOutput);
    assert.equal(hookJSON.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(hookJSON.hookSpecificOutput.additionalContext, /Harness mode: free/);
    assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), false);
  }

  const status = JSON.parse(assertCliSuccess(runHarnessCli([
    "report",
    "status",
    "--context-file", f.contextFile,
    "--session", "clean-room-session",
    "--format", "json",
    "--json",
  ])));
  assert.equal(status.ok, true, status.stderr || status.stdout);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), false);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "state")), true);
  assert.equal(fs.existsSync(path.join(f.pluginRoot, "context.json")), true);
  assert.equal(fs.existsSync(path.join(f.pluginRoot, ".harness", "index", "wikis-index.json")), true);
});

test("Codex report E2E publishes workspace output and survives plugin replacement", async (t) => {
  const f = fixture();
  const pluginV2 = path.join(f.root, "plugin-v2");
  const sessionId = "report-e2e";
  const contextV1 = writeRootContext(f, { sessionId, name: "context-v1.json" });
  const contextV2 = writeRootContext(f, { pluginRoot: pluginV2, sessionId, name: "context-v2.json" });
  t.after(() => {
    setTreeWritable(f.pluginRoot);
    setTreeWritable(pluginV2);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  fs.mkdirSync(pluginV2, { recursive: true });
  stagePluginRuntime(f.pluginRoot, "1.0.0-report");
  stagePluginRuntime(pluginV2, "1.0.1-report");
  const pluginV1Before = snapshotTree(f.pluginRoot);
  const pluginV2Before = snapshotTree(pluginV2);

  const setup = JSON.parse(assertCliSuccess(runHarnessCli([
    "setup",
    "--context-file", contextV1,
    "--metric-cli", f.metricCli,
    "--json",
  ])));
  const metricCliPath = setup.metricCli.path;
  const metricCliHash = createHash("sha256").update(fs.readFileSync(metricCliPath)).digest("hex");
  const context = resolveRootContext({ contextFile: contextV1 });

  const started = JSON.parse(assertCliSuccess(runHarnessCli([
    "report",
    "start",
    "--context-file", contextV1,
    "--session", sessionId,
    "--phase-a", "agent",
    "--json",
  ])));
  assert.equal(started.ok, true, started.stderr || started.stdout);

  const sessionDir = htmlReportSessionDir(f.workspaceRoot, sessionId, context.stateRoot);
  assert.equal(fs.existsSync(sessionDir), true);
  seedConfirmedReportSession(sessionDir);
  runStageGateCommand(f.pluginRoot, sessionDir, "finish", ["--stage", "A_CONFIG"]);
  runStageGateCommand(f.pluginRoot, sessionDir, "approve", ["--phrase", "继续"]);
  runStageGateCommand(f.pluginRoot, sessionDir, "finish", ["--stage", "B0_PREFLIGHT"]);
  runStageGateCommand(f.pluginRoot, sessionDir, "finish", ["--stage", "B2_WRITER"]);

  const advanced = JSON.parse(assertCliSuccess(runHarnessCli([
    "report",
    "advance",
    "--context-file", contextV1,
    "--session", sessionId,
    "--json",
  ])));
  assert.equal(advanced.ok, true, advanced.stderr || advanced.stdout);
  const sessionMain = path.join(sessionDir, "analysis", "main.md");
  const workspaceMain = path.join(f.workspaceRoot, "analysis", "main.md");
  assert.equal(fs.existsSync(sessionMain), true);
  assert.equal(fs.existsSync(workspaceMain), true);
  assert.equal(fs.readFileSync(workspaceMain, "utf8"), fs.readFileSync(sessionMain, "utf8"));
  assert.match(fs.readFileSync(workspaceMain, "utf8"), /区域销售报告/);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), false);

  const reloaded = JSON.parse(assertCliSuccess(runHarnessCli([
    "report",
    "status",
    "--context-file", contextV1,
    "--session", sessionId,
    "--format", "json",
    "--json",
  ])));
  assert.equal(reloaded.ok, true, reloaded.stderr || reloaded.stdout);
  assert.match(reloaded.stdout, /B2_MAIN/);

  const upgradedDoctor = await collectRootDoctor(resolveRootContext({ contextFile: contextV2 }));
  assert.equal(upgradedDoctor.pluginVersion, "1.0.1-report");

  const replacementSetup = JSON.parse(assertCliSuccess(runHarnessCli([
    "setup",
    "--context-file", contextV2,
    "--metric-cli", f.metricCli,
    "--json",
  ])));
  assert.equal(replacementSetup.ok, true);
  const afterReplacement = JSON.parse(assertCliSuccess(runHarnessCli([
    "report",
    "status",
    "--context-file", contextV2,
    "--session", sessionId,
    "--format", "json",
    "--json",
  ])));
  assert.equal(afterReplacement.ok, true, afterReplacement.stderr || afterReplacement.stdout);
  assert.match(afterReplacement.stdout, /B2_MAIN/);
  const newSession = JSON.parse(assertCliSuccess(runHarnessCli([
    "report",
    "start",
    "--context-file", contextV2,
    "--session", "replacement-new-session",
    "--phase-a", "agent",
    "--json",
  ])));
  assert.equal(newSession.ok, true, newSession.stderr || newSession.stdout);

  const installManifest = JSON.parse(fs.readFileSync(path.join(pluginV2, "install-manifest.json"), "utf8"));
  assert.equal(installManifest.pluginRoot, pluginV2);
  assert.equal(installManifest.pluginVersion, "1.0.1-report");
  assert.equal(fs.readFileSync(f.secretPath, "utf8"), "qdm1enc.golden-path-secret\n");
  assert.equal(createHash("sha256").update(fs.readFileSync(metricCliPath)).digest("hex"), metricCliHash);
  assert.equal(fs.existsSync(sessionDir), true, "existing report session must remain recoverable");
  assert.equal(snapshotTree(f.pluginRoot).some((entry) => entry.relative === "context.json"), true);
  assert.equal(snapshotTree(pluginV2).some((entry) => entry.relative === "context.json"), true);
  assert.equal(pluginV1Before.some((entry) => entry.relative === "bootstrap/cli-manifest.json"), true);
  assert.equal(pluginV2Before.some((entry) => entry.relative === "bootstrap/cli-manifest.json"), true);
});

test("clean-install fixture stages a relocatable Codex runtime without touching a project", async () => {
  const f = fixture();
  const source = path.join(f.root, "runtime-source");
  fs.mkdirSync(path.join(source, "agents", "codex", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(source, "bootstrap"), { recursive: true });
  fs.mkdirSync(path.join(source, "config"), { recursive: true });
  fs.mkdirSync(path.join(source, "packages", "data-harness-cli", "src"), { recursive: true });
  fs.mkdirSync(path.join(source, "plugins", "harness-data"), { recursive: true });
  fs.writeFileSync(path.join(source, "bootstrap", "cli-manifest.json"), JSON.stringify({ schemaVersion: 2, tools: [] }));
  fs.writeFileSync(path.join(source, "config", "settings.example.json"), "{}\n");
  fs.writeFileSync(path.join(source, "packages", "data-harness-cli", "src", "main.js"), "export async function main() {}\n");
  fs.writeFileSync(path.join(source, "plugins", "harness-data", "plugin.txt"), "fixture\n");
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
  assert.equal(fs.existsSync(path.join(runtimeDir, "plugins", "harness-data", "plugin.txt")), true);
  assert.equal(fs.existsSync(path.join(runtimeDir, "bin", "data-harness-cli")), true);
  assert.equal(fs.existsSync(path.join(f.root, "workspace", ".harness")), false);
});

test("manifest-bearing runtime archives are rejected before an existing runtime is replaced", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const source = path.join(f.root, "runtime-source");
  stageReleaseRuntime(source);
  const manifestPath = path.join(source, "plugin-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.schemaVersion = 99;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const archive = path.join(f.root, "invalid-runtime.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "."], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);

  const runtimeDir = path.join(f.root, "runtime");
  fs.mkdirSync(path.join(runtimeDir, "agents"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "agents", "keep.txt"), "preserve me\n");
  await assert.rejects(
    installRuntimeBundle(runtimeDir, {
      _harnessRelease: { tag: "invalid", assets: { runtime: { name: "invalid-runtime.tar.gz" } } },
      downloadAsset: async (_asset, destination) => fs.copyFileSync(archive, destination),
    }),
    /runtime bundle has invalid plugin-manifest\.json/,
  );
  assert.equal(fs.readFileSync(path.join(runtimeDir, "agents", "keep.txt"), "utf8"), "preserve me\n");
});

test("release ZIP clean-room installs a random Plugin runtime artifact", async (t) => {
  if (process.platform === "win32") {
    t.skip("release ZIP password smoke uses the POSIX zip/unzip fixture");
    return;
  }
  const f = fixture();
  const releaseStage = path.join(f.root, "release-stage");
  const archive = path.join(f.root, "harness-data-runtime-v-release-smoke.zip");
  const runtimeRoot = path.join(f.root, "installed-runtime");
  t.after(() => {
    setTreeWritable(runtimeRoot);
    fs.rmSync(f.root, { recursive: true, force: true });
  });

  stageReleaseRuntime(releaseStage);
  const zipped = spawnSync("zip", ["-q", "-r", "-P", "release-smoke-password", archive, "."], {
    cwd: releaseStage,
    encoding: "utf8",
  });
  assert.equal(zipped.status, 0, zipped.stderr || zipped.stdout);

  const installed = await installRuntimeBundle(runtimeRoot, {
    _harnessRelease: { tag: "v-release-smoke", assets: { runtime: { name: path.basename(archive) } } },
    _releaseArchivePassword: "release-smoke-password",
    downloadAsset: async (_asset, destination) => fs.copyFileSync(archive, destination),
  });
  assert.equal(installed.tag, "v-release-smoke");
  assert.equal(fs.existsSync(path.join(runtimeRoot, "plugin-manifest.json")), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "plugins", "harness-data", "plugin-manifest.json")), true);

  const installedPluginRoot = path.join(runtimeRoot, "plugins", "harness-data");
  stageTestWikis(installedPluginRoot);
  const contextFile = writeRootContext(f, {
    pluginRoot: installedPluginRoot,
    sessionId: "release-smoke",
    name: "release-smoke-context.json",
  });

  const selfTest = spawnSync(process.execPath, [
    path.join(runtimeRoot, "plugins", "harness-data", "mcp", "server.mjs"),
    "--self-test",
  ], { cwd: runtimeRoot, encoding: "utf8" });
  assert.equal(selfTest.status, 0, selfTest.stderr || selfTest.stdout);

  assertCliSuccess(runHarnessCli([
    "setup",
    "--context-file", contextFile,
    "--metric-cli", f.metricCli,
    "--json",
  ]));
  const doctor = JSON.parse(assertCliSuccess(runHarnessCli([
    "doctor",
    "--context-file", contextFile,
    "--json",
  ])));
  assert.equal(doctor.ok, true);
  const report = JSON.parse(assertCliSuccess(runHarnessCli([
    "report",
    "start",
    "--context-file", contextFile,
    "--runner", path.join(runtimeRoot, "agents", "workbuddy", "scripts", "html-report-workbuddy.mjs"),
    "--session", "release-smoke-report",
    "--phase-a", "agent",
    "--json",
  ])));
  assert.equal(report.ok, true, report.stderr || report.stdout);
  assert.equal(fs.existsSync(path.join(f.workspaceRoot, ".harness")), false);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "state")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, "context.json")), true);
  assert.equal(fs.existsSync(path.join(installedPluginRoot, ".harness", "index", "wikis-index.json")), true);
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
