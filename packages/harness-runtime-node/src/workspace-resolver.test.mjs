import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkspaceRoot, isHarnessWorkspaceRoot, resolveWorkspaceRoot } from "./workspace-resolver.mjs";

async function makeHarness(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-ws-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "harness-config.yaml"), "cli:\n  qdm_metric_cli: /bin/true\n");
  return root;
}

test("walks up from a nested path to config/harness-config.yaml", async (t) => {
  const root = await makeHarness(t);
  const nested = join(root, "plugins", "harness-data", "mcp");
  await mkdir(nested, { recursive: true });
  assert.equal(findWorkspaceRoot(nested), root);
  assert.equal(isHarnessWorkspaceRoot(root), true);
});

test("non-workspace start stays at that directory", async (t) => {
  const plugin = await mkdtemp(join(tmpdir(), "plugin-cache-"));
  t.after(async () => rm(plugin, { recursive: true, force: true }));
  assert.equal(findWorkspaceRoot(plugin), plugin);
  assert.equal(isHarnessWorkspaceRoot(plugin), false);
});

test("HARNESS_WORKSPACE_ROOT beats plugin-cache PWD when start is omitted", async (t) => {
  const root = await makeHarness(t);
  const plugin = await mkdtemp(join(tmpdir(), "plugin-cache-"));
  t.after(async () => rm(plugin, { recursive: true, force: true }));
  const found = findWorkspaceRoot(undefined, {
    HARNESS_WORKSPACE_ROOT: root,
    PWD: plugin,
  }, { parentCwd: false });
  assert.equal(found, root);
});

test("PWD locates the workspace when start is omitted", async (t) => {
  const root = await makeHarness(t);
  const found = findWorkspaceRoot(undefined, { PWD: root }, { parentCwd: false });
  assert.equal(found, root);
});

test("structured Root Context takes precedence over plugin-cache cwd", async (t) => {
  const workspace = await makeHarness(t);
  const plugin = await mkdtemp(join(tmpdir(), "plugin-cache-"));
  const data = await mkdtemp(join(tmpdir(), "harness-data-"));
  t.after(async () => {
    await rm(plugin, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });
  const found = findWorkspaceRoot(plugin, {
    HARNESS_PLUGIN_ROOT: plugin,
    HARNESS_DATA_ROOT: data,
    HARNESS_WORKSPACE_ROOT: workspace,
    PWD: plugin,
  }, { parentCwd: false });
  assert.equal(found, realpathSync(workspace));
});

test("structured resolution fails closed without a workspace", async (t) => {
  const plugin = await mkdtemp(join(tmpdir(), "plugin-cache-"));
  const data = await mkdtemp(join(tmpdir(), "harness-data-"));
  t.after(async () => {
    await rm(plugin, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });
  const env = { HARNESS_PLUGIN_ROOT: plugin, HARNESS_DATA_ROOT: data };
  assert.throws(() => resolveWorkspaceRoot({ env }), /workspaceRoot is required/);
  assert.equal(resolveWorkspaceRoot({ env, failClosed: true }), "");
});
