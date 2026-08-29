import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPluginManifest, writePluginManifest } from "./build-plugin-manifest.mjs";

function write(root, relative, value) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  return file;
}

function fixture({ embedded = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-plugin-manifest-"));
  write(root, "vendor/data-harness-cli/package.json", { name: "@lumi-ai-lab/data-harness-cli", version: "0.0.53" });
  write(root, "vendor/html-report-kernel/package.json", { name: "@lumi-ai-lab/html-report-kernel", version: "1.2.3" });
  write(root, "vendor/harness-runtime-node/package.json", { name: "@lumi-ai-lab/harness-runtime-node", version: "4.5.6" });
  write(root, "bootstrap/cli-manifest.json", { tools: [{ name: "qdm-metric-cli", binary: "qdm-metric-cli", version: "7.8.9" }] });
  if (embedded) {
    const version = createHash("sha256").update("embedded resource").digest("hex");
    write(root, "resource-manifest.json", {
      schemaVersion: 1,
      resourceSchemaVersion: 1,
      resourceId: "qdm-harness-wiki",
      wikiContentVersion: version,
      files: [{ path: "index.md", sha256: version, kind: "wiki" }],
    });
  }
  return root;
}

test("buildPluginManifest binds packaged core versions and an embedded resource manifest", () => {
  const root = fixture({ embedded: true });
  const manifest = buildPluginManifest({
    artifactRoot: root,
    host: "codex",
    pluginName: "qdm-harness",
    pluginVersion: "0.0.53",
  });
  assert.equal(manifest.host, "codex");
  assert.equal(manifest.resource.mode, "embedded");
  assert.equal(manifest.resource.manifest, "./resource-manifest.json");
  assert.equal(manifest.core.packages.htmlReportKernel.version, "1.2.3");
  assert.equal(manifest.core.packages.harnessRuntimeNode.version, "4.5.6");
  assert.equal(manifest.metricCli.version, "7.8.9");
});

test("writePluginManifest makes external resource ownership explicit when a bundle is absent", () => {
  const root = fixture();
  const result = writePluginManifest({
    artifactRoot: root,
    host: "pi",
    pluginName: "@lumi-ai-lab/pi-html-report",
    pluginVersion: "0.0.46",
    resourceMode: "external",
  });
  const written = JSON.parse(readFileSync(result.path, "utf8"));
  assert.equal(written.resource.mode, "external");
  assert.equal(written.resource.contentVersion, "");
  assert.equal(path.basename(result.path), "plugin-manifest.json");
});

test("buildPluginManifest requires all core packages for host-scoped adapters", () => {
  const root = fixture();
  const manifest = buildPluginManifest({
    artifactRoot: root,
    host: "claude",
    pluginName: "qdm-harness-claude",
    pluginVersion: "0.0.54",
    resourceMode: "external",
  });
  assert.deepEqual(Object.keys(manifest.core.packages).sort(), [
    "dataHarnessCli",
    "harnessRuntimeNode",
    "htmlReportKernel",
  ]);
});
