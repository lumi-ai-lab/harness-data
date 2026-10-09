import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("unchanged structured resources reuse validation metadata", () => {
  const f = fixture({ pluginManifest: embeddedPluginManifest });
  loadRuntimeIndex(f.context);
  const cachePath = path.join(
    f.context.dataRoot,
    "cache",
    `resource-validation-${sha256(f.context.resourceRoot).slice(0, 16)}.json`,
  );
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.equal(cache.schemaVersion, 1);
  assert.equal(cache.files.length, 3);
  // The fast path only holds when every entry carries finite metadata; a
  // filesystem reporting no ctime would otherwise compare NaN against NaN.
  const wiki = cache.files.find((file) => file.relative === "metrics/sales.md");
  assert.ok(Number.isFinite(wiki.mtimeMs), "mtimeMs must be a finite number");
  assert.ok(Number.isFinite(wiki.size), "size must be a finite number");
  assert.ok(Number.isFinite(wiki.ctimeMs), "ctimeMs must be a finite number");
  const second = loadRuntimeIndex(f.context);
  assert.equal(second.meta.resourceId, "qdm-harness-wiki");
});

// POSIX directory permissions model the hardened Linux install layout where the
// shared dataRoot is owned by another user. Before the guard moved inside the
// try, cache creation failure aborted the whole hook with a misleading
// QDM_WORKSPACE_REQUIRED and every wiki manual went missing.
test(
  "a read-only dataRoot degrades to full hashing instead of failing the hook",
  { skip: process.platform === "win32" ? "POSIX directory permissions only" : false },
  () => {
    const f = fixture({ pluginManifest: embeddedPluginManifest });
    const cacheDir = path.join(f.context.dataRoot, "cache");
    chmodSync(f.context.dataRoot, 0o555);
    try {
      assert.equal(loadRuntimeIndex(f.context).meta.resourceId, "qdm-harness-wiki");
      assert.equal(existsSync(cacheDir), false, "an unwritable dataRoot must not grow a cache dir");
      // Repeated turns must keep working, not only the first one.
      assert.equal(loadRuntimeIndex(f.context).meta.resourceId, "qdm-harness-wiki");
    } finally {
      chmodSync(f.context.dataRoot, 0o755);
    }
  },
);

test("structured resources reject duplicate manifest entries even with a warm validation cache", () => {
  const f = fixture({ pluginManifest: embeddedPluginManifest });
  // Warm the metadata cache so the duplicate check cannot be reached only by
  // falling through the fast path.
  loadRuntimeIndex(f.context);
  const manifestPath = path.join(f.pluginRoot, "resource-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files = [...manifest.files, manifest.files[0]];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    () => loadRuntimeIndex(f.context),
    (error) => error?.code === "QDM_RESOURCE_MISMATCH" && /resource manifest contains duplicate file/.test(error.message),
  );
});

test("validation cache keys on ctime so a restored mtime cannot hide tampering", () => {
  const f = fixture({ pluginManifest: embeddedPluginManifest });
  loadRuntimeIndex(f.context);
  const cachePath = path.join(
    f.context.dataRoot,
    "cache",
    `resource-validation-${sha256(f.context.resourceRoot).slice(0, 16)}.json`,
  );
  // Rewrite the wiki with different bytes but the same length, so size alone
  // cannot notice, then forge the cached mtime/size to the current values.
  // Only ctime still differs -- which is exactly the `touch -r` case on POSIX.
  writeFileSync(f.wikiPath, "# 采购额\n");
  const info = statSync(f.wikiPath);
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  const entry = cache.files.find((file) => file.relative === "metrics/sales.md");
  assert.equal(entry.size, info.size);
  entry.mtimeMs = info.mtimeMs;
  entry.size = info.size;
  writeFileSync(cachePath, `${JSON.stringify(cache)}\n`);

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
