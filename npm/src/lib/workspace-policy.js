import fs from "node:fs";
import path from "node:path";

import { ROOT_CONTEXT_ERROR_CODES, RootContextError } from "./root-context.js";

export function assertWorkspaceAllowed(context) {
  if (!context?.workspaceRoot) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED, "workspaceRoot is required");
  }
  const policyPath = String(
    context.workspacePolicyPath
      || (context.pluginRoot ? path.join(context.pluginRoot, "config", "workspace-policy.json") : ""),
  ).trim();
  if (!policyPath) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, "workspace allowlist is not configured");
  }
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, `workspace allowlist is unavailable: ${policyPath}`);
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, "workspace allowlist must be an object");
  }
  if (Number(policy.schemaVersion || 1) !== 1 || String(policy.mode || "allowlist").toLowerCase() !== "allowlist" || !Array.isArray(policy.roots)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, "workspace allowlist is invalid");
  }
  const workspace = canonicalDirectory(context.workspaceRoot, "workspaceRoot");
  const allowed = policy.roots.some((root) => {
    const allowedRoot = canonicalDirectory(root, "workspace allowlist root");
    const relative = path.relative(allowedRoot, workspace);
    return relative === "" || (policy.includeChildren !== false
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new RootContextError(
      ROOT_CONTEXT_ERROR_CODES.WORKSPACE_NOT_ALLOWED,
      `workspaceRoot is not in the Harness Data allowlist: ${workspace}`,
      { workspaceRoot: workspace, policyPath },
    );
  }
  return context;
}

function canonicalDirectory(value, label) {
  const resolved = path.resolve(String(value || ""));
  let info;
  try {
    info = fs.lstatSync(resolved);
  } catch {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.WORKSPACE_NOT_ALLOWED, `${label} does not exist: ${resolved}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `${label} must be a regular directory: ${resolved}`);
  }
  return fs.realpathSync.native(resolved);
}
