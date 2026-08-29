import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { ROOT_CONTEXT_ERROR_CODES, RootContextError } from "./root-context.mjs";

export const WORKSPACE_POLICY_SCHEMA_VERSION = 1;

export function workspacePolicyPath(context) {
  return String(
    context?.workspacePolicyPath
      || (context?.pluginRoot ? path.join(context.pluginRoot, "config", "workspace-policy.json") : ""),
  ).trim();
}

export function loadWorkspacePolicy(context, { required = true } = {}) {
  const filePath = workspacePolicyPath(context);
  if (!filePath) {
    if (required) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, "workspace allowlist is not configured");
    return null;
  }
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, `workspace allowlist is unavailable: ${filePath}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `workspace allowlist is invalid JSON: ${error?.message || error}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, "workspace allowlist must be an object");
  }
  if (Number(value.schemaVersion || WORKSPACE_POLICY_SCHEMA_VERSION) !== WORKSPACE_POLICY_SCHEMA_VERSION) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `workspace allowlist schema must be ${WORKSPACE_POLICY_SCHEMA_VERSION}`);
  }
  const mode = String(value.mode || "allowlist").trim().toLowerCase();
  if (mode !== "allowlist") {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `workspace allowlist mode must be allowlist: ${mode}`);
  }
  if (!Array.isArray(value.roots)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, "workspace allowlist roots must be an array");
  }
  const roots = value.roots.map((root) => canonicalExistingPath(root, "workspace allowlist root"));
  return {
    schemaVersion: WORKSPACE_POLICY_SCHEMA_VERSION,
    mode,
    includeChildren: value.includeChildren !== false,
    roots: [...new Set(roots)],
    path: filePath,
  };
}

export function isWorkspaceAllowed(workspaceRoot, policy) {
  if (!workspaceRoot || !policy || policy.mode !== "allowlist") return false;
  const workspace = canonicalExistingPath(workspaceRoot, "workspaceRoot", { allowMissing: false });
  return policy.roots.some((root) => {
    const relative = path.relative(root, workspace);
    if (relative === "") return true;
    if (!policy.includeChildren) return false;
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

export function assertWorkspaceAllowed(context, { policy = null } = {}) {
  if (!context?.workspaceRoot) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED, "workspaceRoot is required");
  }
  const effectivePolicy = policy || loadWorkspacePolicy(context);
  if (!isWorkspaceAllowed(context.workspaceRoot, effectivePolicy)) {
    throw new RootContextError(
      ROOT_CONTEXT_ERROR_CODES.WORKSPACE_NOT_ALLOWED,
      `workspaceRoot is not in the Harness Data allowlist: ${context.workspaceRoot}`,
      { workspaceRoot: context.workspaceRoot, policyPath: effectivePolicy.path },
    );
  }
  return context;
}

function canonicalExistingPath(value, label, { allowMissing = true } = {}) {
  const text = String(value || "").trim();
  if (!text || !path.isAbsolute(text)) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `${label} must be an absolute path`);
  const resolved = path.resolve(text);
  if (!existsSync(resolved)) {
    if (allowMissing) return resolved;
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.WORKSPACE_NOT_ALLOWED, `${label} does not exist: ${resolved}`);
  }
  const info = lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `${label} must be a regular directory: ${resolved}`);
  }
  return realpathSync.native(resolved);
}
