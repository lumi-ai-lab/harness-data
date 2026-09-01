import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ROOT_CONTEXT_ERROR_CODES,
  contextFromHookPayload,
  normalizeRootContext,
  publicRootContext,
  resolveRootContext,
  workspaceIdentity,
} from "./root-context.mjs";

const fixture = JSON.parse(await readFile(new URL("../../../test/fixtures/root-context-cases.json", import.meta.url), "utf8"));

async function makeRoots() {
  const base = await mkdtemp(path.join(tmpdir(), "qdm-runtime-context-"));
  const roots = {
    base,
    pluginRoot: path.join(base, "plugin"),
    dataRoot: path.join(base, "data"),
    secretRoot: path.join(base, "secrets"),
    workspaceRoot: path.join(base, "workspace"),
  };
  await Promise.all(Object.values(roots).filter((value) => value !== base).map((dir) => mkdir(dir, { recursive: true })));
  roots.configPath = path.join(roots.dataRoot, "config", "settings.json");
  roots.workspacePolicyPath = path.join(roots.pluginRoot, "config", "workspace-policy.json");
  roots.secretPath = path.join(roots.secretRoot, "profiles", "default", "auth.blob");
  await mkdir(path.dirname(roots.configPath), { recursive: true });
  await mkdir(path.dirname(roots.workspacePolicyPath), { recursive: true });
  await mkdir(path.dirname(roots.secretPath), { recursive: true });
  await writeFile(roots.configPath, "{}\n");
  await writeFile(roots.secretPath, "qdm1enc.fixture\n");
  await chmod(roots.secretPath, 0o600);
  return roots;
}

function fixtureContext(roots) {
  return JSON.parse(JSON.stringify(fixture.valid, (_, value) => {
    if (typeof value !== "string") return value;
    return value
      .replaceAll("${PLUGIN_ROOT}", roots.pluginRoot)
      .replaceAll("${DATA_ROOT}", roots.dataRoot)
      .replaceAll("${SECRET_ROOT}", roots.secretRoot)
      .replaceAll("${WORKSPACE_ROOT}", roots.workspaceRoot)
      .replaceAll("${CONFIG_PATH}", roots.configPath)
      .replaceAll("${WORKSPACE_POLICY_PATH}", roots.workspacePolicyPath)
      .replaceAll("${SECRET_PATH}", roots.secretPath);
  }));
}

test("runtime RootContext matches the shared fixture and derives stateRoot", async () => {
  const roots = await makeRoots();
  const context = normalizeRootContext(fixtureContext(roots));
  assert.equal(context.pluginRoot, realpathSync(roots.pluginRoot));
  assert.equal(context.resourceRoot, realpathSync(roots.dataRoot));
  assert.equal(context.dataRoot, realpathSync(roots.dataRoot));
  assert.equal(context.stateRoot, path.join(context.dataRoot, "state", "workspaces", workspaceIdentity(context)));
  assert.deepEqual(context.capabilities, fixture.valid.capabilities);
});

test("runtime RootContext applies explicit values over file and environment", async () => {
  const roots = await makeRoots();
  const file = path.join(roots.base, "context.json");
  await writeFile(file, JSON.stringify(fixtureContext(roots)));
  const explicitDataRoot = path.join(roots.base, "explicit-data");
  await mkdir(explicitDataRoot);
  const context = resolveRootContext({
    contextFile: file,
    explicit: { dataRoot: explicitDataRoot },
    env: { HARNESS_PLUGIN_ROOT: path.join(roots.base, "env-plugin"), HARNESS_DATA_ROOT: path.join(roots.base, "env-data") },
  });
  assert.equal(context.pluginRoot, realpathSync(roots.pluginRoot));
  assert.equal(context.dataRoot, realpathSync(explicitDataRoot));
});

test("runtime RootContext uses stable error codes and does not accept overlapping roots", async () => {
  const roots = await makeRoots();
  const input = fixtureContext(roots);
  input.dataRoot = roots.pluginRoot;
  assert.throws(
    () => normalizeRootContext(input),
    (error) => error?.code === ROOT_CONTEXT_ERROR_CODES.INVALID && /overlap/.test(error.message),
  );
  input.dataRoot = path.join(roots.base, "missing-data");
  input.pluginRoot = path.join(roots.base, "missing-plugin");
  assert.throws(
    () => normalizeRootContext(input),
    (error) => error?.code === ROOT_CONTEXT_ERROR_CODES.PLUGIN_ROOT_UNAVAILABLE,
  );
});

test("runtime hook envelope conversion matches the CLI contract", async () => {
  const roots = await makeRoots();
  const base = normalizeRootContext({
    schemaVersion: 1,
    host: "codex",
    pluginRoot: roots.pluginRoot,
    dataRoot: roots.dataRoot,
    capabilities: {
      canWriteWorkspace: false,
      canWriteData: true,
      hasStableSessionId: false,
      supportsSecretReference: false,
    },
  });
  const context = contextFromHookPayload({ cwd: roots.workspaceRoot, session_id: "runtime-hook-session" }, {
    root: roots.pluginRoot,
    baseContext: base,
    env: {},
  });
  assert.equal(context.workspaceRoot, realpathSync(roots.workspaceRoot));
  assert.equal(context.sessionId, "runtime-hook-session");
  assert.equal(context.capabilities.canWriteWorkspace, true);
  assert.equal(publicRootContext(context).secretRef, null);
});

test("runtime RootContext preserves host surface and optional UI/Hook capabilities", async () => {
  const roots = await makeRoots();
  const context = normalizeRootContext({
    schemaVersion: 1,
    host: "chatgpt-desktop",
    surface: "work",
    pluginRoot: roots.pluginRoot,
    dataRoot: roots.dataRoot,
    workspaceRoot: roots.workspaceRoot,
    capabilities: {
      canWriteWorkspace: true,
      canWriteData: true,
      supportsLocalUi: true,
      supportsHooks: false,
    },
  });
  assert.equal(context.surface, "work");
  assert.equal(context.capabilities.supportsHooks, false);
  assert.equal(context.capabilities.supportsLocalUi, true);
});
