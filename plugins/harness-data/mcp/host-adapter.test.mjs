import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ChatGPTDesktopAdapter,
  CodexHostAdapter,
  createHostAdapter,
} from "./host-adapter.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "harness-host-adapter-"));
  const pluginRoot = path.join(root, "plugin");
  const dataRoot = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspace");
  const policyPath = path.join(pluginRoot, "config", "workspace-policy.json");
  await Promise.all([
    mkdir(path.join(pluginRoot, "config"), { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);
  await writeFile(policyPath, `${JSON.stringify({
    schemaVersion: 1,
    mode: "allowlist",
    includeChildren: true,
    roots: [workspaceRoot],
  }, null, 2)}\n`);
  return { root, pluginRoot, dataRoot, workspaceRoot, policyPath };
}

test("CodexHostAdapter resolves an explicit workspace and exposes hook capabilities", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const adapter = new CodexHostAdapter({
    allowUnpersistedContext: true,
    env: {
      HARNESS_PLUGIN_ROOT: f.pluginRoot,
      HARNESS_DATA_ROOT: f.dataRoot,
      HARNESS_WORKSPACE_ROOT: f.workspaceRoot,
      HARNESS_WORKSPACE_POLICY: f.policyPath,
      HARNESS_SESSION_ID: "codex-session",
    },
  });
  const context = adapter.requireWorkspace();
  assert.equal(context.host, "codex");
  assert.equal(context.surface, "codex");
  assert.equal(adapter.getSessionId(), "codex-session");
  assert.deepEqual(adapter.getCapabilities(), {
    host: "codex",
    surface: "codex",
    workspaceRoot: context.workspaceRoot,
    sessionId: "codex-session",
    canWriteWorkspace: true,
    canWriteData: true,
    supportsLocalUi: true,
    supportsHooks: true,
    hasStableSessionId: true,
    supportsSecretReference: false,
  });
});

test("ChatGPTDesktopAdapter uses one runtime for chat and work surfaces", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  for (const surface of ["chat", "work"]) {
    const adapter = new ChatGPTDesktopAdapter({
      surface,
      env: {
        HARNESS_PLUGIN_ROOT: f.pluginRoot,
        HARNESS_DATA_ROOT: f.dataRoot,
        HARNESS_WORKSPACE_ROOT: f.workspaceRoot,
        HARNESS_WORKSPACE_POLICY: f.policyPath,
        HARNESS_SESSION_ID: `${surface}-session`,
      },
    });
    const context = adapter.requireWorkspace();
    assert.equal(context.host, "chatgpt-desktop");
    assert.equal(context.surface, surface);
    assert.equal(adapter.getCapabilities().supportsHooks, false);
    assert.equal(adapter.getCapabilities().supportsLocalUi, true);
  }
  assert.equal(createHostAdapter({
    HARNESS_HOST: "chatgpt",
    HARNESS_SURFACE: "work",
    HARNESS_PLUGIN_ROOT: f.pluginRoot,
    HARNESS_DATA_ROOT: f.dataRoot,
    HARNESS_WORKSPACE_ROOT: f.workspaceRoot,
    HARNESS_WORKSPACE_POLICY: f.policyPath,
  }).surface, "work");
});

test("host adapters fail closed when only PWD supplies a workspace", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const adapter = new CodexHostAdapter({
    allowUnpersistedContext: true,
    env: {
      HARNESS_PLUGIN_ROOT: f.pluginRoot,
      HARNESS_DATA_ROOT: f.dataRoot,
      HARNESS_WORKSPACE_POLICY: f.policyPath,
      PWD: f.workspaceRoot,
    },
  });
  assert.throws(() => adapter.requireWorkspace(), (error) => error?.code === "QDM_WORKSPACE_REQUIRED");
});

test("host adapters enforce the workspace allowlist", async (t) => {
  const f = await fixture();
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const adapter = new ChatGPTDesktopAdapter({
    env: {
      HARNESS_PLUGIN_ROOT: f.pluginRoot,
      HARNESS_DATA_ROOT: f.dataRoot,
      HARNESS_WORKSPACE_ROOT: outside,
      HARNESS_WORKSPACE_POLICY: f.policyPath,
    },
  });
  assert.throws(() => adapter.requireWorkspace(), (error) => error?.code === "QDM_WORKSPACE_NOT_ALLOWED");
});

test("diagnostics expose host state without secret identifiers", async (t) => {
  const f = await fixture();
  const secretPath = path.join(f.root, "secret.blob");
  await writeFile(secretPath, `qdm${"1enc"}.test\n`, { mode: 0o600 });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const adapter = new ChatGPTDesktopAdapter({
    surface: "chat",
    env: {
      HARNESS_PLUGIN_ROOT: f.pluginRoot,
      HARNESS_DATA_ROOT: f.dataRoot,
      HARNESS_WORKSPACE_ROOT: f.workspaceRoot,
      HARNESS_WORKSPACE_POLICY: f.policyPath,
      HARNESS_SECRET_REF: JSON.stringify({ kind: "host", id: "do-not-leak" }),
    },
  });
  const diagnostics = adapter.diagnostics();
  assert.equal(diagnostics.host, "chatgpt-desktop");
  assert.equal(diagnostics.surface, "chat");
  assert.doesNotMatch(JSON.stringify(diagnostics), /do-not-leak/);
});
