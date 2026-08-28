import { loadRuntime } from "./kernel-loader.mjs";

const { findWorkspaceRoot, isHarnessWorkspaceRoot } = await loadRuntime("workspace-resolver.mjs");

export { findWorkspaceRoot, isHarnessWorkspaceRoot };

/** Resolve at call time so Codex-forwarded PWD / HARNESS_WORKSPACE_ROOT are visible. */
export function getWorkspace(env = process.env) {
  return findWorkspaceRoot(undefined, env);
}
