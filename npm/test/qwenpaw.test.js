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
    assert.deepEqual(config.enabled_agents, ["qdmDataAgent"]);
    assert.equal(config.secret_ref, secrets);
    assert.ok(existsSync(path.join(secrets, "auth.blob")), "secret_ref dir must contain auth.blob");
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
