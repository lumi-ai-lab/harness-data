import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { doctorCommand } from "../src/commands/doctor.js";
import { inspectLegacyRuntime } from "../src/lib/legacy-runtime.js";
import { setupCommand } from "../src/commands/setup.js";

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += String(value); } },
    stderr: { write(value) { stderr += String(value); } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qdm-legacy-detect-"));
  const legacy = path.join(root, "legacy");
  const plugin = path.join(root, "plugin");
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  for (const directory of ["agents/codex", "wikis/metrics", "wikis/reports", "wikis/dims", "wikis/rules", "config", "bootstrap"]) {
    fs.mkdirSync(path.join(legacy, directory), { recursive: true });
  }
  write(legacy, "bootstrap/cli-manifest.json", JSON.stringify({ schemaVersion: 2, releaseTag: "v0.0.53" }));
  write(legacy, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n");
  write(legacy, "wikis/index.md", "# Wikis\n");
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(path.join(plugin, "bootstrap"), { recursive: true });
  fs.mkdirSync(path.join(plugin, "agents"), { recursive: true });
  write(plugin, "bootstrap/cli-manifest.json", JSON.stringify({ schemaVersion: 2 }));
  fs.mkdirSync(data, { recursive: true });
  return { root, legacy, plugin, data, workspace };
}

test("legacy runtime detection is explicit, non-destructive, and secret-safe", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const result = inspectLegacyRuntime(f.legacy);
  assert.equal(result.detected, true);
  assert.equal(result.valid, true);
  assert.equal(result.runtimeTag, "v0.0.53");
  assert.match(result.hint, /migrate --check/);
  assert.doesNotMatch(result.hint, /auth|blob/);
});

test("modern runtime markers suppress the legacy migration hint", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  write(f.legacy, "plugin-manifest.json", "{}");
  for (const relative of [
    "packages/data-harness-cli/package.json",
    "packages/html-report-kernel/package.json",
    "packages/harness-runtime-node/package.json",
  ]) write(f.legacy, relative, "{}");
  const result = inspectLegacyRuntime(f.legacy);
  assert.equal(result.detected, false);
  assert.equal(result.modern, true);
});

test("structured doctor reports an available migration without copying the old runtime", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const io = capture();
  const report = await doctorCommand({
    pluginRoot: f.plugin,
    dataRoot: f.data,
    workspaceRoot: f.workspace,
    legacyRuntime: f.legacy,
    json: true,
  }, io);
  assert.equal(report.migration.status, "available");
  assert.equal(report.migration.sourceRoot, f.legacy);
  assert.equal(report.checks.some((check) => check.name === "legacy runtime migration" && check.status === "warning"), true);
  assert.equal(fs.existsSync(path.join(f.data, "migration.json")), false);
  assert.doesNotMatch(io.stdoutText, /auth|blob/);
});

test("setup surfaces a migration hint but does not migrate automatically", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const report = await setupCommand({
    pluginRoot: f.plugin,
    dataRoot: f.data,
    workspaceRoot: f.workspace,
    legacyRuntime: f.legacy,
    skipMetricCli: true,
    json: true,
  }, capture());
  assert.equal(report.migration.status, "available");
  assert.equal(fs.existsSync(path.join(f.data, "install-manifest.json")), true);
  assert.equal(fs.existsSync(path.join(f.data, "migration.json")), false);
});
