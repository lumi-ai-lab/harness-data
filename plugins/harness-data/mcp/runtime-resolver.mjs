import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRuntime } from "./kernel-loader.mjs";
import { readPersistedContext } from "../scripts/context-store.mjs";

const { normalizeRootContext } = await loadRuntime("root-context.mjs");
const { assertWorkspaceAllowed } = await loadRuntime("workspace-policy.mjs");
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function isHarnessWorkspaceRoot(dir) {
  if (!dir) return false;
  return existsSync(join(dir, "config", "harness-config.yaml")) || existsSync(join(dir, "bin", "data-harness-cli"));
}

function envValue(env, name) {
  const value = String(env?.[name] || "").trim();
  return value || "";
}

export function getRootContext(env = process.env, { requireWorkspace = true } = {}) {
  const loaded = readPersistedContext({ env, pluginRoot });
  const workspaceRoot = envValue(env, "HARNESS_WORKSPACE_ROOT")
    || envValue(env, "CODEX_WORKSPACE_ROOT")
    || envValue(env, "PWD");
  const context = {
    ...loaded.context,
    pluginRoot,
    resourceRoot: loaded.context.resourceRoot || pluginRoot,
    dataRoot: loaded.context.dataRoot,
    secretRoot: loaded.context.secretRoot,
    configPath: loaded.context.configPath,
    workspacePolicyPath: loaded.context.workspacePolicyPath || join(pluginRoot, "config", "workspace-policy.json"),
    workspaceRoot: workspaceRoot ? resolve(workspaceRoot) : "",
    host: "codex",
  };
  delete context.stateRoot;
  delete context.sessionId;
  context.capabilities = {
    ...(loaded.context.capabilities || {}),
    canWriteWorkspace: Boolean(workspaceRoot),
    hasStableSessionId: false,
  };
  const normalized = normalizeRootContext(context, { source: loaded.contextPath, requireWorkspace });
  if (requireWorkspace) assertWorkspaceAllowed(normalized);
  return normalized;
}

export function getWorkspace(env = process.env) {
  return getRootContext(env, { requireWorkspace: true }).workspaceRoot;
}
