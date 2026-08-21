import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function isHarnessWorkspaceRoot(dir) {
  return existsSync(join(dir, "config", "harness-config.yaml"))
    || existsSync(join(dir, "bin", "data-harness-cli"));
}

function defaultWorkspaceStart() {
  for (const candidate of [
    process.env.CODEX_WORKSPACE_ROOT,
    process.env.HARNESS_WORKSPACE_ROOT,
    process.env.PWD,
    process.cwd(),
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return process.cwd();
}

/** Walk up from start until a harness workspace root is found. */
export function findWorkspaceRoot(start = defaultWorkspaceStart()) {
  let dir = resolve(start);
  for (let i = 0; i < 20; i++) {
    if (isHarnessWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}
