import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HostCapabilities,
  HostContextProvider,
  normalizeHostSurface,
} from "./host-context.mjs";

async function roots() {
  const root = await mkdtemp(path.join(tmpdir(), "harness-host-context-"));
  const pluginRoot = path.join(root, "plugin");
  const dataRoot = path.join(root, "data");
  const workspaceRoot = path.join(root, "workspace");
  await Promise.all([mkdir(pluginRoot), mkdir(dataRoot), mkdir(workspaceRoot)]);
  return { root, pluginRoot, dataRoot, workspaceRoot };
}

test("HostContextProvider exposes the shared host capability contract", async (t) => {
  const f = await roots();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const provider = new HostContextProvider({
    host: "chatgpt-desktop",
    surface: "work",
    context: {
      ...f,
      host: "chatgpt-desktop",
      surface: "work",
      sessionId: "desktop-session",
      capabilities: {
        canWriteWorkspace: true,
        canWriteData: true,
        hasStableSessionId: true,
        supportsSecretReference: false,
      },
    },
  });
  const context = provider.requireWorkspace();
  assert.equal(context.surface, "work");
  assert.equal(context.hostCapabilities.surface, "work");
  assert.equal(provider.getSessionId(), "desktop-session");
  assert.equal(provider.getCapabilities().supportsHooks, false);
  assert.equal(new HostCapabilities(context).surface, "work");
});

test("HostContextProvider policy and capability failures are fail-closed", async (t) => {
  const f = await roots();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const provider = new HostContextProvider({
    host: "codex",
    surface: "codex",
    context: { ...f, capabilities: { canWriteWorkspace: false } },
  });
  assert.throws(() => provider.requireWorkspace(), (error) => error?.code === "QDM_WORKSPACE_REQUIRED");
});

test("host surface normalization rejects unknown values", () => {
  assert.equal(normalizeHostSurface("cli", "codex"), "codex");
  assert.equal(normalizeHostSurface("work", "chatgpt-desktop"), "work");
  assert.throws(() => normalizeHostSurface("mobile", "chatgpt-desktop"), /surface must be one of/);
});

test("host surface derivation survives a persisted Root Context", () => {
  // setup writes the derived surface back into context.json, so re-reading the
  // sentinel produced for unmapped hosts must not fail, and QwenPaw (a
  // messaging-channel host) must resolve to a real surface.
  assert.equal(normalizeHostSurface("", "qwenpaw"), "chat");
  assert.equal(normalizeHostSurface("unknown", "qwenpaw"), "unknown");
  assert.equal(normalizeHostSurface("unknown", "codex"), "unknown");
});
