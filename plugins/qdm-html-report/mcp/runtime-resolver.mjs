import { loadRuntime } from "./kernel-loader.mjs";

const { findWorkspaceRoot, isHarnessWorkspaceRoot } = await loadRuntime("workspace-resolver.mjs");

export { findWorkspaceRoot, isHarnessWorkspaceRoot };

export const workspace = findWorkspaceRoot();
