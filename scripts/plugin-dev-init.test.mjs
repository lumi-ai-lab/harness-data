import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildSetupArgs, codexLaunchEnvironment, marketplaceAddArgs, pluginSelector, resolveDevWikisSource } from "./plugin-dev-init.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "plugin-dev-init.mjs");

test("Codex development initialization uses the repository Marketplace and Plugin selector", () => {
  assert.deepEqual(marketplaceAddArgs(repoRoot), ["plugin", "marketplace", "add", repoRoot, "--json"]);
  assert.equal(pluginSelector(), "harness-data@lumi-ai-lab");
  assert.deepEqual(buildSetupArgs({
    pluginRoot: "/tmp/plugin",
    dataRoot: "/tmp/data",
    projectRoot: "/tmp/project",
    secretSource: "/tmp/auth.blob",
    authUserId: "user",
    metricCli: "/tmp/qdm-metric-cli",
  }), [
    "--data-root", "/tmp/data",
    "--workspace-root", "/tmp/project",
    "--workspace-allowlist", "/tmp/project",
    "--auth-blob-file", "/tmp/auth.blob",
    "--auth-user-id", "user",
    "--json",
    "--metric-cli", "/tmp/qdm-metric-cli",
  ]);
  assert.deepEqual(buildSetupArgs({
    pluginRoot: "/tmp/plugin",
    dataRoot: "/tmp/data",
    projectRoot: "/tmp/project",
    secretSource: "/tmp/auth.blob",
    authUserId: "user",
    metricCli: "/tmp/qdm-metric-cli",
    wikisSource: "/tmp/wikis",
  }).slice(-2), ["--wikis-source", "/tmp/wikis"]);
  assert.equal(buildSetupArgs({
    projectRoot: "/tmp/project",
    secretSource: "/tmp/auth.blob",
    authUserId: "user",
  }).includes("--download-metric-cli"), true);
  assert.deepEqual(
    codexLaunchEnvironment("/tmp/project", { PWD: "/wrong", CODEX_HOME: "/wrong-home" }),
    {
      PWD: "/tmp/project",
      CODEX_HOME: "/tmp/codex-home/dev-harness-plugin",
      HARNESS_WORKSPACE_ROOT: "/tmp/project",
      CODEX_WORKSPACE_ROOT: "/tmp/project",
    },
  );
});

test("make plugin initialization registers the main repository and runs Plugin setup", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qdm-plugin-init-test-"));
  const fakePlugin = path.join(root, "installed-plugin");
  const fakeBin = path.join(root, "bin");
  const calls = path.join(root, "codex-calls.log");
  const auth = path.join(root, "codex-auth.json");
  const secret = path.join(root, "auth.blob");
  const metricCli = path.join(root, "qdm-metric-cli");
  const fakeCodex = path.join(fakeBin, "codex");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync("/tmp/codex-home/dev-harness-plugin", { recursive: true, force: true });
    rmSync("/tmp/codex-dev-harness-plugin", { recursive: true, force: true });
  });

  cpSync(path.join(repoRoot, "plugins", "harness-data"), fakePlugin, { recursive: true });
  const wikis = path.join(root, "wikis");
  mkdirSync(path.join(wikis, "metrics"), { recursive: true });
  mkdirSync(path.join(wikis, "reports"), { recursive: true });
  mkdirSync(path.join(wikis, "dims"), { recursive: true });
  mkdirSync(path.join(wikis, "rules"), { recursive: true });
  writeFileSync(path.join(wikis, "index.md"), "# Wikis\n");
  for (const name of ["metrics", "reports", "dims", "rules"]) writeFileSync(path.join(wikis, name, "sample.md"), `# ${name}\n`);
  assert.equal(resolveDevWikisSource({ pluginRoot: fakePlugin, env: { QDM_WIKIS_SOURCE: wikis } }), wikis);
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(auth, "{}\n", { mode: 0o600 });
  writeFileSync(secret, "qdm1enc.plugin-init-test\n", { mode: 0o600 });
  writeFileSync(metricCli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(auth, 0o600);
  chmodSync(secret, 0o600);
  chmodSync(metricCli, 0o755);
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.QDM_FAKE_CODEX_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "plugin" && args[1] === "add") {
  process.stdout.write(JSON.stringify({ installedPath: process.env.QDM_FAKE_PLUGIN_ROOT }) + "\\n");
} else if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ name: "harness-data" }]) + "\\n");
} else if (args[0] === "mcp" && args[1] === "list") {
  process.stdout.write("html-report enabled\\n");
}
`, { mode: 0o755 });
  chmodSync(fakeCodex, 0o755);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    input: `${secret}\nplugin-init-user\n`,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      QDM_CODEX_AUTH_SOURCE: auth,
      QDM_SECRET_SOURCE: secret,
      QDM_METRIC_CLI: metricCli,
      QDM_FAKE_CODEX_CALLS: calls,
      QDM_FAKE_PLUGIN_ROOT: fakePlugin,
      QDM_WIKIS_SOURCE: wikis,
      QDM_PLUGIN_DEV_NO_LAUNCH: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const codexCalls = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(codexCalls[0], ["plugin", "marketplace", "add", repoRoot, "--json"]);
  assert.deepEqual(codexCalls[1], ["plugin", "add", "harness-data@lumi-ai-lab", "--json"]);
  assert.equal(exists(fakePlugin, "context.json"), true);
  assert.equal(exists(fakePlugin, "config/settings.json"), true);
  assert.equal(exists(fakePlugin, ".harness/index/wikis-index.json"), true);
  assert.equal(exists(fakePlugin, "secrets/auth.blob"), true);
  assert.match(result.stdout, /Harness Data Plugin 开发环境初始化完成/);
});

function exists(root, relative) {
  return existsSync(path.join(root, ...relative.split("/")));
}
