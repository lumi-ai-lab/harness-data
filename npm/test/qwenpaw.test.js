import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const npmRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(npmRoot, "..");
const cli = path.join(npmRoot, "bin", "harness-data.js");

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function writeFakePython(root) {
  const file = path.join(root, "fake-qwenpaw.py");
  writeFileSync(
    file,
    "#!/usr/bin/env python3\n"
    + "import os, shutil, sys\n"
    + "if len(sys.argv) > 1 and sys.argv[1] == '-c':\n"
    + "    print('2.1.0')\n"
    + "    sys.exit(0)\n"
    + "if 'plugin' in sys.argv:\n"
    + "    if 'install' in sys.argv:\n"
    + "        src = sys.argv[sys.argv.index('install') + 1]\n"
    + "        base = os.environ.get('QWENPAW_WORKING_DIR', '')\n"
    + "        if base:\n"
    + "            target = os.path.join(base, 'plugins', 'qdm-harness-qwenpaw')\n"
    + "            os.makedirs(os.path.dirname(target), exist_ok=True)\n"
    + "            shutil.copytree(src, target)\n"
    + "    sys.exit(0)\n"
    + "sys.exit(1)\n",
  );
  chmodSync(file, 0o755);
  return file;
}

function writeMetricStub(root) {
  const file = path.join(root, "qdm-metric-cli");
  writeFileSync(
    file,
    "#!/usr/bin/env python3\n"
    + "import json, sys\n"
    + "if len(sys.argv) > 1 and sys.argv[1] == 'auth':\n"
    + "    print(json.dumps({'enabled': True, 'capabilities': ['qdm.metric.query'], 'labelsResolved': True, 'dataScope': {'manageAreaId': [{'id': 'CN01', 'name': '华南区'}]}}))\n"
    + "else:\n"
    + "    print(json.dumps({'rows': []}))\n",
  );
  chmodSync(file, 0o755);
  return file;
}

function seedWikis(root) {
  for (const name of ["metrics", "reports", "dims", "rules"]) mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, "index.md"), "# index\n");
  writeFileSync(path.join(root, "metrics", "index.md"), "# metrics\n");
}

function stagePluginSource(root) {
  const source = path.join(root, "plugin-source");
  mkdirSync(path.join(source, "scripts"), { recursive: true });
  mkdirSync(path.join(source, "bootstrap"), { recursive: true });
  writeFileSync(
    path.join(source, "plugin.json"),
    JSON.stringify({ id: "qdm-harness-qwenpaw", name: "QDM Harness for QwenPaw", version: "0.1.6", type: "general", entry: { backend: "plugin.py" } }, null, 2) + "\n",
  );
  writeFileSync(path.join(source, "plugin.py"), "plugin = None\n");
  writeFileSync(
    path.join(source, "scripts", "data-harness-cli"),
    "#!/usr/bin/env node\nconsole.log('cli-shim');\n",
  );
  chmodSync(path.join(source, "scripts", "data-harness-cli"), 0o755);
  cpSync(path.join(repoRoot, "bootstrap", "cli-manifest.json"), path.join(source, "bootstrap", "cli-manifest.json"));
  const dist = path.join(source, "dist");
  mkdirSync(dist, { recursive: true });
  for (const name of ["data-harness-cli", "harness-runtime-node", "html-report-kernel"]) {
    cpSync(path.join(repoRoot, "packages", name), path.join(dist, name), { recursive: true });
  }
  return source;
}

test("qwenpaw setup installs the native plugin and builds the reference config", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-qwenpaw-setup-"));
  try {
    const source = stagePluginSource(root);
    const python = writeFakePython(root);
    const metric = writeMetricStub(root);
    const wikis = path.join(root, "wikis");
    seedWikis(wikis);
    const instance = path.join(root, "instance");
    const data = path.join(root, "data");
    const project = path.join(root, "project");
    const secrets = path.join(root, "secrets");
    mkdirSync(project, { recursive: true });
    mkdirSync(secrets, { recursive: true });
    const blob = path.join(root, "auth.blob");
    writeFileSync(blob, "qdm1enc.local-test-blob\n");
    chmodSync(blob, 0o600);
    const configFile = path.join(root, "plugin-config.json");

    const result = runCli([
      "qwenpaw", "setup",
      "--source", source,
      "--qwenpaw-python", python,
      "--qwenpaw-working-dir", path.join(root, "qwenpaw-home"),
      "--instance-root", instance,
      "--data-root", data,
      "--workspace-root", project,
      "--workspace-allowlist", project,
      "--wikis-source", wikis,
      "--metric-cli", metric,
      "--auth-blob-file", blob,
      "--auth-user-id", "local-test-user",
      "--plugin-config-file", configFile,
      "--secret-dir", secrets,
      "--json",
    ], repoRoot);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(path.join(instance, "context.json")), "instanceRoot context.json missing");
    assert.ok(existsSync(path.join(instance, "resources", "wikis", "index.md")), "instanceRoot wikis missing");
    assert.ok(existsSync(path.join(instance, "config", "settings.json")), "instanceRoot settings missing");

    const config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.equal(config.schema_version, 2);
    assert.equal(config.plugin_id, "qdm-harness-qwenpaw");
    assert.equal(config.plugin_version, "0.1.6");
    assert.equal(config.root_context_path, path.join(instance, "context.json"));
    assert.deepEqual(config.enabled_agents, ["harness-data-*"], "setup must default to the prefix convention");
    assert.equal("qdm_agent_id" in config, false, "the single-value field is no longer written");
    assert.equal(config.secret_ref, secrets);
    assert.ok(existsSync(path.join(secrets, "auth.blob")), "secret_ref dir must contain auth.blob");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qwenpaw setup --channel-auth-only authorizes via channel-auth.json without auth.blob", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-qwenpaw-channel-"));
  try {
    const source = stagePluginSource(root);
    const python = writeFakePython(root);
    const metric = writeMetricStub(root);
    const wikis = path.join(root, "wikis");
    seedWikis(wikis);
    const instance = path.join(root, "instance");
    const data = path.join(root, "data");
    const project = path.join(root, "project");
    const secrets = path.join(root, "secrets"); // not created: setup must create it
    mkdirSync(project, { recursive: true });
    const configFile = path.join(root, "plugin-config.json");

    const result = runCli([
      "qwenpaw", "setup",
      "--source", source,
      "--qwenpaw-python", python,
      "--qwenpaw-working-dir", path.join(root, "qwenpaw-home"),
      "--instance-root", instance,
      "--data-root", data,
      "--workspace-root", project,
      "--workspace-allowlist", project,
      "--wikis-source", wikis,
      "--metric-cli", metric,
      "--channel-auth-only",
      "--plugin-config-file", configFile,
      "--secret-dir", secrets,
      "--json",
    ], repoRoot);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(path.join(instance, "context.json")), "instanceRoot context.json missing");
    assert.ok(existsSync(secrets), "secret dir must be created for channel-auth.json");
    assert.equal(existsSync(path.join(secrets, "auth.blob")), false, "--channel-auth-only must not write auth.blob");

    const settings = JSON.parse(readFileSync(path.join(instance, "config", "settings.json"), "utf8"));
    assert.equal(settings.authz.mode, "on", "authz must stay enabled for the QwenPaw adapter");
    assert.equal(settings.authz.userId, "");
    assert.equal(settings.secretRef, null);

    const persisted = JSON.parse(readFileSync(path.join(instance, "context.json"), "utf8"));
    assert.equal(persisted.secretRef, null);

    const config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.equal(config.schema_version, 2);
    assert.equal(config.secret_ref, secrets, "reference config must point at the dir holding channel-auth.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qwenpaw setup writes the agent scope from --enabled-agents patterns", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-qwenpaw-scope-"));
  try {
    const source = stagePluginSource(root);
    const python = writeFakePython(root);
    const metric = writeMetricStub(root);
    const wikis = path.join(root, "wikis");
    seedWikis(wikis);
    const instance = path.join(root, "instance");
    const project = path.join(root, "project");
    const secrets = path.join(root, "secrets");
    mkdirSync(project, { recursive: true });
    mkdirSync(secrets, { recursive: true });
    const configFile = path.join(root, "plugin-config.json");
    // Each run gets its own QwenPaw home: the fake installer copies the plugin
    // tree in and refuses to overwrite an existing target.
    const baseArgs = (home) => [
      "qwenpaw", "setup",
      "--source", source,
      "--qwenpaw-python", python,
      "--qwenpaw-working-dir", path.join(root, home),
      "--instance-root", instance,
      "--data-root", path.join(root, "data"),
      "--workspace-root", project,
      "--workspace-allowlist", project,
      "--wikis-source", wikis,
      "--metric-cli", metric,
      "--channel-auth-only",
      "--plugin-config-file", configFile,
      "--secret-dir", secrets,
      "--json",
    ];

    const patterns = runCli([...baseArgs("home-patterns"), "--enabled-agents", "harness-data-*", "--enabled-agents", "default"], repoRoot);
    assert.equal(patterns.status, 0, patterns.stderr || patterns.stdout);
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).enabled_agents, ["harness-data-*", "default"]);

    const single = runCli([...baseArgs("home-single"), "--agent-id", "qdmDataAgent"], repoRoot);
    assert.equal(single.status, 0, single.stderr || single.stdout);
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).enabled_agents, ["qdmDataAgent"]);

    // Re-running setup without a scope flag must not re-scope a working install.
    const carried = runCli(baseArgs("home-carried"), repoRoot);
    assert.equal(carried.status, 0, carried.stderr || carried.stdout);
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).enabled_agents, ["qdmDataAgent"]);

    const rejected = runCli([...baseArgs("home-rejected"), "--enabled-agents", "has space"], repoRoot);
    assert.notEqual(rejected.status, 0, "an invalid pattern must fail setup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function strictSetupFixture(root, home) {
  const working = path.join(root, home);
  for (const agentId of ["harness-data-east", "default"]) {
    const dir = path.join(working, "workspaces", agentId);
    mkdirSync(dir, { recursive: true });
    const wide = {
      read_file: { name: "read_file", enabled: true },
      execute_shell_command: { name: "execute_shell_command", enabled: true },
      // The host writes some entries without ``enabled``; those read as enabled.
      web_search: { name: "web_search" },
    };
    writeFileSync(path.join(dir, "agent.json"), JSON.stringify({
      id: agentId,
      channels: { wecom: { enabled: agentId === "harness-data-east" } },
      tools: { builtin_tools: wide },
    }), "utf8");
  }
  writeFileSync(path.join(working, "config.json"), JSON.stringify({
    agents: { profiles: { "harness-data-east": { id: "harness-data-east" }, default: { id: "default" } } },
  }), "utf8");
  return working;
}

function enabledTools(file) {
  return Object.entries(JSON.parse(readFileSync(file, "utf8")).tools.builtin_tools)
    .filter(([, value]) => value.enabled !== false)
    .map(([name]) => name)
    .sort();
}

test("qwenpaw setup --tool-policy strict narrows in-scope agents to the QDM tools", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-qwenpaw-tool-policy-"));
  try {
    const source = stagePluginSource(root);
    const python = writeFakePython(root);
    const metric = writeMetricStub(root);
    const wikis = path.join(root, "wikis");
    seedWikis(wikis);
    const project = path.join(root, "project");
    const secrets = path.join(root, "secrets");
    mkdirSync(project, { recursive: true });
    mkdirSync(secrets, { recursive: true });
    const configFile = path.join(root, "plugin-config.json");
    const args = (working, extra) => [
      "qwenpaw", "setup",
      "--source", source,
      "--qwenpaw-python", python,
      "--qwenpaw-working-dir", working,
      "--instance-root", path.join(root, "instance"),
      "--data-root", path.join(root, "data"),
      "--workspace-root", project,
      "--workspace-allowlist", project,
      "--wikis-source", wikis,
      "--metric-cli", metric,
      "--channel-auth-only",
      "--plugin-config-file", configFile,
      "--secret-dir", secrets,
      "--enabled-agents", "harness-data-*",
      ...extra,
      "--json",
    ];

    const working = strictSetupFixture(root, "home-strict");
    const strict = runCli(args(working, ["--tool-policy", "strict"]), repoRoot);
    assert.equal(strict.status, 0, strict.stderr || strict.stdout);
    const narrowed = JSON.parse(readFileSync(path.join(working, "workspaces", "harness-data-east", "agent.json"), "utf8"));
    assert.deepEqual(enabledTools(path.join(working, "workspaces", "harness-data-east", "agent.json")),
      ["get_current_time", "qdm_query", "qdm_scope_summary"]);
    assert.equal(narrowed.tools.builtin_tools.web_search.enabled, false, "an entry without ``enabled`` reads as enabled and must be switched off");
    assert.deepEqual(
      { id: narrowed.id, channels: narrowed.channels },
      { id: "harness-data-east", channels: { wecom: { enabled: true } } },
      "narrowing must not disturb the rest of the agent config",
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(working, "workspaces", "harness-data-east", "agent.json"), "utf8"))
        .light_context_config.tool_result_pruning_config.enabled,
      false,
      "QDM query results must not be pruned",
    );
    assert.deepEqual(
      Object.keys(JSON.parse(readFileSync(path.join(working, "config.json"), "utf8")).agents.profiles).sort(),
      ["default", "harness-data-east"],
      "narrowing must write agent.json only, never the host agent list",
    );
    assert.deepEqual(
      enabledTools(path.join(working, "workspaces", "default", "agent.json")),
      ["execute_shell_command", "read_file", "web_search"],
      "out-of-scope agents stay as the host left them",
    );
    assert.equal(JSON.parse(readFileSync(configFile, "utf8")).tool_policy, "strict");

    // Re-running setup without the flag must keep the governed policy.
    const carried = strictSetupFixture(root, "home-carried");
    const again = runCli(args(carried, []), repoRoot);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.deepEqual(enabledTools(path.join(carried, "workspaces", "harness-data-east", "agent.json")),
      ["get_current_time", "qdm_query", "qdm_scope_summary"]);

    const rejected = runCli(args(strictSetupFixture(root, "home-bad"), ["--tool-policy", "loose"]), repoRoot);
    assert.notEqual(rejected.status, 0, "an unknown policy must fail setup");

    // A strict policy that cannot enumerate agents must fail, not pass silently.
    const noList = path.join(root, "home-no-list");
    mkdirSync(noList, { recursive: true });
    const unenforceable = runCli(args(noList, ["--tool-policy", "strict"]), repoRoot);
    assert.notEqual(unenforceable.status, 0, "strict must fail when there is no host agent list");
    assert.match(unenforceable.stderr, /needs the host agent list/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedQwenPawHome(root, profiles) {
  const working = path.join(root, "qwenpaw-home");
  mkdirSync(working, { recursive: true });
  writeFileSync(path.join(working, "config.json"), JSON.stringify({ agents: { profiles, active_agent: Object.keys(profiles)[0] } }), "utf8");
  return working;
}

test("qwenpaw doctor agent-scope fails when no host agent matches the scope", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-qwenpaw-scope-doctor-"));
  try {
    const working = seedQwenPawHome(root, { default: { id: "default" }, a3f9Kq: { id: "a3f9Kq" } });
    const configFile = path.join(root, "plugin-config.json");
    const writeScope = (patterns) => writeFileSync(configFile, JSON.stringify({
      schema_version: 2, plugin_id: "qdm-harness-qwenpaw", plugin_version: "0.1.6",
      root_context_path: path.join(root, "missing", "context.json"),
      enabled_agents: patterns, user_id_display_mode: "off",
    }, null, 2) + "\n");
    const scopeOf = (extraArgs) => JSON.parse(runCli(["qwenpaw", "doctor", "--plugin-config-file", configFile, "--json", ...extraArgs], repoRoot).stdout)
      .checks.find((check) => check.name === "agent-scope");

    writeScope(["harness-data-*"]);
    const mismatch = scopeOf(["--qwenpaw-working-dir", working]);
    assert.equal(mismatch.ok, false, "an install that activates no agent must be reported as a failure");
    assert.match(mismatch.detail, /matched=none/);
    assert.match(mismatch.detail, /agents=a3f9Kq,default/);

    writeScope(["harness-data-*", "default"]);
    assert.equal(scopeOf(["--qwenpaw-working-dir", working]).ok, true);

    // No working dir: nothing to compare against, so the check must not block.
    assert.equal(scopeOf(["--qwenpaw-working-dir", path.join(root, "absent")]).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qwenpaw doctor tool-allowlist reports tools beyond the QDM set under strict", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-qwenpaw-allowlist-doctor-"));
  try {
    const working = seedQwenPawHome(root, { "harness-data-east": { id: "harness-data-east" }, default: { id: "default" } });
    const writeAgent = (agentId, tools) => {
      const dir = path.join(working, "workspaces", agentId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ tools: { builtin_tools: tools } }), "utf8");
    };
    const configFile = path.join(root, "plugin-config.json");
    const writeConfig = (policy) => writeFileSync(configFile, JSON.stringify({
      schema_version: 2, plugin_id: "qdm-harness-qwenpaw", plugin_version: "0.1.6",
      root_context_path: path.join(root, "missing", "context.json"),
      enabled_agents: ["harness-data-*"], user_id_display_mode: "off", tool_policy: policy,
    }, null, 2) + "\n");
    const allowlistOf = () => JSON.parse(
      runCli(["qwenpaw", "doctor", "--plugin-config-file", configFile, "--qwenpaw-working-dir", working, "--json"], repoRoot).stdout,
    ).checks.find((check) => check.name === "tool-allowlist");

    writeConfig("preserve");
    assert.match(allowlistOf().detail, /policy=preserve/);
    assert.equal(allowlistOf().ok, true, "preserve must not gate the host's own tool config");

    writeConfig("strict");
    writeAgent("default", { read_file: { enabled: true } });
    writeAgent("harness-data-east", { read_file: { enabled: true }, qdm_query: { enabled: true } });
    const wide = allowlistOf();
    assert.equal(wide.ok, false, "an in-scope agent with file tools still enabled must fail the check");
    assert.match(wide.detail, /harness-data-east\(read_file\)/);
    assert.doesNotMatch(wide.detail, /default/, "out-of-scope agents are not the QDM boundary");

    writeAgent("harness-data-east", { get_current_time: { enabled: true }, qdm_query: {}, qdm_scope_summary: { enabled: true } });
    assert.equal(allowlistOf().ok, true, "a missing enabled flag reads as enabled and stays allowed here");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qwenpaw doctor reports missing instance as failures with json output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-qwenpaw-doctor-"));
  try {
    const configFile = path.join(root, "plugin-config.json");
    writeFileSync(
      configFile,
      JSON.stringify({ schema_version: 2, plugin_id: "qdm-harness-qwenpaw", plugin_version: "0.1.6", root_context_path: path.join(root, "missing", "context.json") }, null, 2) + "\n",
    );
    const result = runCli(["qwenpaw", "doctor", "--plugin-config-file", configFile, "--json"], repoRoot);
    assert.equal(result.status, 1, "doctor must fail when the root context is missing");
    const report = JSON.parse(result.stdout);
    assert.equal(report.host, "qwenpaw");
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.name === "root-context" && !check.ok));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
