import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_CONTEXT_RELATIVE_PATH = ["qdm-harness", "context.json"];
export const PLUGIN_CONTEXT_FILE_NAME = "context.json";

export class PluginContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PluginContextError";
    this.code = code;
  }
}

export function resolveCodexHome(env = process.env) {
  return path.resolve(String(env.CODEX_HOME || path.join(os.homedir(), ".codex")));
}

export function resolvePersistedContextPath(env = process.env, pluginRoot = "") {
  const explicit = String(env.HARNESS_CONTEXT_FILE || env.CODEX_CONTEXT_FILE || "").trim();
  if (explicit) return path.resolve(explicit);
  const currentPluginRoot = String(pluginRoot || env.HARNESS_PLUGIN_ROOT || "").trim();
  if (currentPluginRoot) return path.join(path.resolve(currentPluginRoot), PLUGIN_CONTEXT_FILE_NAME);
  return path.join(resolveCodexHome(env), ...CODEX_CONTEXT_RELATIVE_PATH);
}

export function readPersistedContext({ env = process.env, required = true, pluginRoot = "" } = {}) {
  const contextPath = resolvePersistedContextPath(env, pluginRoot);
  let raw;
  try {
    raw = fs.readFileSync(contextPath, "utf8");
  } catch (error) {
    if (!required && error?.code === "ENOENT") return { contextPath, context: null };
    throw new PluginContextError(
      "QDM_SETUP_REQUIRED",
      `Harness Data setup is required; run the installed plugin's scripts/setup.mjs (${contextPath})`,
    );
  }
  let context;
  try {
    context = JSON.parse(raw);
  } catch (error) {
    throw new PluginContextError("QDM_CONTEXT_INVALID", `persisted Root Context is invalid JSON: ${error?.message || error}`);
  }
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new PluginContextError("QDM_CONTEXT_INVALID", "persisted Root Context must contain a JSON object");
  }
  return { contextPath, context };
}

export function invocationContext({ pluginRoot, workspaceRoot = "", sessionId = "", env = process.env } = {}) {
  const loaded = readPersistedContext({ env, pluginRoot });
  const context = {
    ...loaded.context,
    pluginRoot: path.resolve(String(pluginRoot || loaded.context.pluginRoot || "")),
  };
  if (workspaceRoot) {
    context.workspaceRoot = path.resolve(String(workspaceRoot));
    delete context.stateRoot;
  } else {
    delete context.workspaceRoot;
    delete context.stateRoot;
  }
  if (sessionId) context.sessionId = String(sessionId);
  else delete context.sessionId;
  return { contextPath: loaded.contextPath, context };
}

export function setupEnvironment({ pluginRoot, env = process.env } = {}) {
  const codexHome = resolveCodexHome(env);
  const resolvedPluginRoot = path.resolve(String(pluginRoot));
  return {
    ...env,
    CODEX_HOME: codexHome,
    HARNESS_HOST: "codex",
    HARNESS_SURFACE: env.HARNESS_SURFACE || "codex",
    HARNESS_PLUGIN_ROOT: resolvedPluginRoot,
    HARNESS_CONTEXT_FILE: env.HARNESS_CONTEXT_FILE || path.join(resolvedPluginRoot, PLUGIN_CONTEXT_FILE_NAME),
    HARNESS_WORKSPACE_POLICY: env.HARNESS_WORKSPACE_POLICY || path.join(resolvedPluginRoot, "config", "workspace-policy.json"),
  };
}
