import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/main.js";
import { normalizeRootContext } from "../src/lib/root-context.js";
import { loadIndex, loadRuntimeIndex } from "../src/lib/wikis/index.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(root, relative, value) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
  return file;
}

function fixture({ pluginManifest = null } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "qdm-resource-manifest-"));
  const pluginRoot = path.join(base, "plugin");
  const dataRoot = path.join(base, "data");
  const workspaceRoot = path.join(base, "workspace");
  mkdirSync(pluginRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });

  const wikiContent = "# 销售额\n";
  const wikiPath = write(pluginRoot, "metrics/sales.md", wikiContent);
  const wikiContentVersion = sha256("resource-fixture-v1");
  const meta = {
    resourceId: "qdm-harness-wiki",
    resourceSchemaVersion: 1,
    wikiContentVersion,
    resourceVersion: wikiContentVersion,
    paths: { knowledge: ".", metrics: "metrics", reports: "reports", dims: "dims", rules: "rules" },
  };
  const index = { meta, docs: [], recall: [] };
  const runtime = { meta, docsByPath: {}, recall: [], templateSelection: [] };
  const indexPath = write(pluginRoot, ".harness/index/wikis-index.json", `${JSON.stringify(index)}\n`);
  const runtimePath = write(pluginRoot, ".harness/index/wikis-runtime-index.json", `${JSON.stringify(runtime)}\n`);
  const files = [
    ["metrics/sales.md", wikiPath, "wiki"],
    [".harness/index/wikis-index.json", indexPath, "index"],
    [".harness/index/wikis-runtime-index.json", runtimePath, "index"],
  ].map(([relative, filePath, kind]) => ({
    path: relative,
    sha256: sha256(readFileSync(filePath)),
    kind,
  }));
  write(pluginRoot, "resource-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    resourceSchemaVersion: 1,
    resourceId: "qdm-harness-wiki",
    wikiContentVersion,
    files,
  }, null, 2)}\n`);
  if (pluginManifest) write(pluginRoot, "plugin-manifest.json", `${JSON.stringify(pluginManifest(wikiContentVersion), null, 2)}\n`);

  const context = normalizeRootContext({
    schemaVersion: 1,
    host: "codex",
    pluginRoot,
    dataRoot,
    workspaceRoot,
    sessionId: "resource-fixture",
  });
  const contextFile = path.join(base, "context.json");
  writeFileSync(contextFile, `${JSON.stringify(context)}\n`);
  return { base, pluginRoot, context, contextFile, wikiPath };
}

function embeddedPluginManifest(version) {
  return {
    schemaVersion: 1,
    product: "qdm-harness",
    host: "codex",
    plugin: { name: "qdm-harness", version: "0.0.53" },
    core: {
      apiVersion: "v1",
      packages: {
        dataHarnessCli: { name: "@lumi-ai-lab/data-harness-cli", version: "0.0.53" },
      },
    },
    resource: {
      mode: "embedded",
      manifest: "./resource-manifest.json",
      resourceId: "qdm-harness-wiki",
      schemaVersion: 1,
      contentVersion: version,
    },
    metricCli: { binary: "qdm-metric-cli", version: "" },
    state: { schemaVersion: 1 },
    compatibility: { node: ">=18", coreApi: "v1", resourceSchema: 1, stateSchema: 1 },
  };
}

function memoryIO() {
  return {
    stdin: Buffer.alloc(0),
    stdout: { write() {} },
    stderr: { write() {} },
  };
}

test("structured resource consumers validate manifest hashes and index versions", () => {
  const f = fixture({ pluginManifest: embeddedPluginManifest });
  assert.equal(loadIndex(f.context).meta.wikiContentVersion.length, 64);
  assert.equal(loadRuntimeIndex(f.context).meta.resourceId, "qdm-harness-wiki");

  writeFileSync(f.wikiPath, "# 被篡改的销售额\n");
  assert.throws(
    () => loadRuntimeIndex(f.context),
    (error) => error?.code === "QDM_RESOURCE_MISMATCH" && /resource hash mismatch/.test(error.message),
  );
});

test("structured resources fail closed for a missing manifest while legacy roots remain compatible", () => {
  const f = fixture();
  rmSync(path.join(f.pluginRoot, "resource-manifest.json"));
  assert.throws(
    () => loadRuntimeIndex(f.context),
    (error) => error?.code === "QDM_RESOURCE_MISMATCH" && /resource manifest is missing/.test(error.message),
  );
  assert.equal(loadRuntimeIndex(f.pluginRoot).meta.resourceId, "qdm-harness-wiki");
});

test("plugin manifest resource binding fails closed when content versions differ", () => {
  const f = fixture({ pluginManifest: () => embeddedPluginManifest("f".repeat(64)) });
  assert.throws(
    () => loadRuntimeIndex(f.context),
    (error) => error?.code === "QDM_RESOURCE_MISMATCH" && /plugin manifest resource version/.test(error.message),
  );
});

test("CLI surfaces QDM_RESOURCE_MISMATCH for structured resource corruption", async () => {
  const f = fixture();
  writeFileSync(f.wikiPath, "# 被篡改的销售额\n");
  await assert.rejects(
    run(["--context-file", f.contextFile, "context", "--question", "销售额"], memoryIO()),
    (error) => error?.code === 2 && /QDM_RESOURCE_MISMATCH: resource hash mismatch/.test(error.message),
  );
});
