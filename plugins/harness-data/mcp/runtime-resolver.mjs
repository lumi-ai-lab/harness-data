import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ChatGPTDesktopAdapter,
  CodexHostAdapter,
  createHostAdapter,
} from "./host-adapter.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function isHarnessWorkspaceRoot(dir) {
  if (!dir) return false;
  return existsSync(join(dir, "config", "harness-config.yaml")) || existsSync(join(dir, "bin", "data-harness-cli"));
}

/**
 * Resolve the active host adapter. Codex remains the default for backwards
 * compatibility, while ChatGPT Desktop can select `HARNESS_HOST=chatgpt` and
 * `HARNESS_SURFACE=chat|work` without changing the MCP tool contract.
 */
export function getHostAdapter(env = process.env, options = {}) {
  return createHostAdapter(env, {
    pluginRoot,
    ...options,
  });
}

export function getRootContext(env = process.env, { requireWorkspace = true, ...options } = {}) {
  const adapter = getHostAdapter(env, options);
  return requireWorkspace ? adapter.requireWorkspace() : adapter.resolveContext();
}

export function getHostCapabilities(env = process.env, options = {}) {
  return getHostAdapter(env, options).getCapabilities();
}

export function getHostDiagnostics(env = process.env, options = {}) {
  return getHostAdapter(env, options).diagnostics();
}

export function getWorkspace(env = process.env) {
  return getRootContext(env, { requireWorkspace: true }).workspaceRoot;
}

export { ChatGPTDesktopAdapter, CodexHostAdapter, createHostAdapter };
