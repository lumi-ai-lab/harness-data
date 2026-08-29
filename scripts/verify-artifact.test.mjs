import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyArtifact } from "./verify-artifact.mjs";
import { hostArtifactKind, requiredPathsForHost } from "./host-artifact-contract.mjs";

function write(root, relative, value = "ok\n") {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function runtimeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-artifact-"));
  mkdirSync(path.join(root, "agents"), { recursive: true });
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "plugins"), { recursive: true });
  write(root, "bootstrap/cli-manifest.json", "{}\n");
  write(root, "packages/data-harness-cli/src/main.js", "export {};\n");
  write(root, "packages/data-harness-cli/package.json", "{\"name\":\"@lumi-ai-lab/data-harness-cli\",\"version\":\"0.0.53\"}\n");
  write(root, "packages/html-report-kernel/src/index.mjs", "export {};\n");
  write(root, "packages/html-report-kernel/package.json", "{\"name\":\"@lumi-ai-lab/html-report-kernel\",\"version\":\"0.0.46\"}\n");
  write(root, "packages/harness-runtime-node/src/index.mjs", "export {};\n");
  write(root, "packages/harness-runtime-node/package.json", "{\"name\":\"@lumi-ai-lab/harness-runtime-node\",\"version\":\"0.0.46\"}\n");
  write(root, "plugin-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    product: "qdm-harness",
    host: "runtime",
    plugin: { name: "qdm-harness", version: "0.0.53" },
    core: { apiVersion: "v1", packages: { dataHarnessCli: { name: "@lumi-ai-lab/data-harness-cli", version: "0.0.53" } } },
    resource: { mode: "external", resourceId: "qdm-harness-wiki", schemaVersion: 1, contentVersion: "" },
    metricCli: { binary: "qdm-metric-cli", version: "" },
    state: { schemaVersion: 1 },
    compatibility: { node: ">=18", coreApi: "v1", resourceSchema: 1, stateSchema: 1 },
  }, null, 2)}\n`);
  write(root, "plugins/harness-data/.codex-plugin/plugin.json", "{\"name\":\"harness-data\",\"version\":\"0.0.50\"}\n");
  write(root, "plugins/harness-data/bootstrap/cli-manifest.json", "{}\n");
  write(root, "plugins/harness-data/hooks/hooks.json", "{\"hooks\":{}}\n");
  write(root, "plugins/harness-data/scripts/setup.mjs", "export {};\n");
  write(root, "plugins/harness-data/scripts/context-store.mjs", "export {};\n");
  write(root, "plugins/harness-data/scripts/data-harness-cli", "#!/usr/bin/env node\n");
  write(root, "plugins/harness-data/dist/harness-data-installer/src/cli.js", "export {};\n");
  write(root, "plugins/harness-data/dist/data-harness-cli/src/main.js", "export {};\n");
  write(root, "plugins/harness-data/dist/html-report-kernel/package.json", "{\"name\":\"@lumi-ai-lab/html-report-kernel\",\"version\":\"0.0.46\"}\n");
  write(root, "plugins/harness-data/dist/harness-runtime-node/package.json", "{\"name\":\"@lumi-ai-lab/harness-runtime-node\",\"version\":\"0.0.46\"}\n");
  write(root, "plugins/harness-data/plugin-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    product: "qdm-harness",
    host: "codex",
    plugin: { name: "harness-data", version: "0.0.50" },
    core: { apiVersion: "v1", packages: {
      htmlReportKernel: { name: "@lumi-ai-lab/html-report-kernel", version: "0.0.46" },
      harnessRuntimeNode: { name: "@lumi-ai-lab/harness-runtime-node", version: "0.0.46" },
    } },
    resource: { mode: "external", resourceId: "qdm-harness-wiki", schemaVersion: 1, contentVersion: "" },
    metricCli: { binary: "qdm-metric-cli", version: "" },
    state: { schemaVersion: 1 },
    compatibility: { node: ">=18", coreApi: "v1", resourceSchema: 1, stateSchema: 1 },
  }, null, 2)}\n`);
  return root;
}

test("verifyArtifact accepts a relocatable runtime skeleton", () => {
  const root = runtimeFixture();
  const report = verifyArtifact(root, { kind: "runtime" });
  assert.deepEqual(report.errors, []);
});

test("verifyArtifact rejects secrets, mutable state, binaries, symlinks, and build paths", () => {
  const root = runtimeFixture();
  write(root, "config/dev-auth.blob", "qdm1enc.fixture-secret-value\n");
  write(root, "state/workspace/session.json", "{}\n");
  write(root, "bin/qdm-metric-cli", "binary\n");
  write(root, "agent.md", "built at /Users/example/worktree\n");
  symlinkSync(path.join(root, "agent.md"), path.join(root, "linked.md"));

  const report = verifyArtifact(root, { kind: "runtime" });
  assert.equal(report.errors.some((line) => line.includes("secret-like file") && line.includes("dev-auth.blob")), true);
  assert.equal(report.errors.some((line) => line.includes("forbidden directory") && line.includes("state")), true);
  assert.equal(report.errors.some((line) => line.includes("downloaded metric CLI")), true);
  assert.equal(report.errors.some((line) => line.includes("build-machine absolute path") && line.includes("agent.md")), true);
  assert.equal(report.errors.some((line) => line.includes("symlink is not allowed") && line.includes("linked.md")), true);
});

test("verifyArtifact requires a valid product plugin manifest", () => {
  const root = runtimeFixture();
  write(root, "plugin-manifest.json", "{}\n");
  const report = verifyArtifact(root, { kind: "runtime" });
  assert.equal(report.errors.some((line) => line.includes("invalid plugin manifest")), true);
});

test("verifyArtifact rejects mismatched Codex native and product versions", () => {
  const root = runtimeFixture();
  write(root, "plugins/harness-data/.codex-plugin/plugin.json", "{\"name\":\"harness-data\",\"version\":\"0.0.51\"}\n");
  const report = verifyArtifact(root, { kind: "runtime" });
  assert.equal(report.errors.some((line) => line.includes("native manifest version must match product manifest")), true);
});

test("verifyArtifact validates a host-scoped artifact descriptor and manifest binding", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-host-artifact-"));
  const host = "claude";
  for (const relative of requiredPathsForHost(host)) {
    if (relative.endsWith(".json")) write(root, relative, "{}\n");
    else if (relative.endsWith(".mjs") || relative.endsWith(".js")) write(root, relative, "export {};\n");
    else write(root, relative, "ok\n");
  }
  write(root, "host-artifact.json", `${JSON.stringify({
    schemaVersion: 1,
    host,
    plugin: { name: "qdm-harness-claude", version: "0.0.54" },
    adapter: { root: "adapter", manifest: "adapter/.claude-plugin/plugin.json" },
    requiredPaths: requiredPathsForHost(host),
  }, null, 2)}\n`);
  write(root, "plugin-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    product: "qdm-harness",
    host,
    plugin: { name: "qdm-harness-claude", version: "0.0.54" },
    core: { apiVersion: "v1", packages: {
      dataHarnessCli: { name: "@lumi-ai-lab/data-harness-cli", version: "0.0.54" },
      htmlReportKernel: { name: "@lumi-ai-lab/html-report-kernel", version: "0.0.46" },
      harnessRuntimeNode: { name: "@lumi-ai-lab/harness-runtime-node", version: "0.0.46" },
    } },
    resource: { mode: "external", resourceId: "qdm-harness-wiki", schemaVersion: 1, contentVersion: "" },
    metricCli: { binary: "qdm-metric-cli", version: "" },
    state: { schemaVersion: 1 },
    compatibility: { node: ">=18", coreApi: "v1", resourceSchema: 1, stateSchema: 1 },
  }, null, 2)}\n`);

  const report = verifyArtifact(root, { kind: hostArtifactKind(host) });
  assert.deepEqual(report.errors, []);
});
