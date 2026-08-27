import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function isHarnessWorkspaceRoot(dir) {
  if (!dir) return false;
  return existsSync(join(dir, "config", "harness-config.yaml"))
    || existsSync(join(dir, "bin", "data-harness-cli"));
}

function parentProcessCwd(ppid = process.ppid) {
  const pid = Number(ppid) || 0;
  if (pid <= 1) return "";
  try {
    if (process.platform === "linux") {
      return realpathSync(`/proc/${pid}/cwd`);
    }
    if (process.platform === "darwin") {
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const line = out.split(/\r?\n/).find((row) => row.startsWith("n"));
      return line ? line.slice(1) : "";
    }
  } catch {
    return "";
  }
  return "";
}

function workspaceStartCandidates(env = process.env, { parentCwd = true } = {}) {
  return [
    env.HARNESS_WORKSPACE_ROOT,
    env.CODEX_WORKSPACE_ROOT,
    env.PWD,
    parentCwd ? parentProcessCwd() : "",
    process.cwd(),
  ].filter((candidate) => candidate && existsSync(candidate));
}

function walkToHarness(start) {
  let dir = resolve(start);
  for (let i = 0; i < 20; i++) {
    if (isHarnessWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/**
 * Walk up from start until a harness workspace root is found.
 * When `start` is omitted, try env / parent cwd / process.cwd() in order.
 * Plugin MCP cwd is the plugin cache, so the session workspace must come from
 * HARNESS_WORKSPACE_ROOT, CODEX_WORKSPACE_ROOT, PWD, or the parent process.
 */
export function findWorkspaceRoot(start, env = process.env, options = {}) {
  const starts = start ? [start] : workspaceStartCandidates(env, options);
  let last = process.cwd();
  for (const candidate of starts) {
    last = resolve(candidate);
    const found = walkToHarness(last);
    if (found) return found;
  }
  return last;
}
