import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ROOT_CONTEXT_ERROR_CODES,
  RootContextError,
  normalizeRootContext,
  resolveRootContext,
} from "./root-context.mjs";

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
 * Resolve a workspace from an explicit Root Context when one is supplied.
 * Otherwise retain the legacy env/parent-cwd upward scan for old hooks.
 */
export function findWorkspaceRoot(start, env = process.env, options = {}) {
  const structured = options.context || options.contextFile || hasStructuredContextEnv(env);
  if (structured) {
    try {
      const context = options.context
        ? normalizeRootContext(options.context)
        : resolveRootContext({ contextFile: options.contextFile, env });
      if (!context?.workspaceRoot) {
        throw new RootContextError(
          ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED,
          "workspaceRoot is required for structured runtime resolution",
        );
      }
      return context.workspaceRoot;
    } catch (error) {
      if (options.failClosed) return "";
      throw error;
    }
  }
  const starts = start ? [start] : workspaceStartCandidates(env, options);
  let last = process.cwd();
  for (const candidate of starts) {
    last = resolve(candidate);
    const found = walkToHarness(last);
    if (found) return found;
  }
  return options.failClosed ? "" : last;
}

/** Resolve a workspace only from an explicit Root Context. */
export function resolveWorkspaceRoot({ context, contextFile = "", env = process.env, failClosed = false } = {}) {
  if (!context && !contextFile && !hasStructuredContextEnv(env)) {
    if (failClosed) return "";
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, "explicit Root Context is required");
  }
  return findWorkspaceRoot(undefined, env, { context, contextFile, failClosed });
}

function hasStructuredContextEnv(env = process.env) {
  return Boolean(
    env?.HARNESS_CONTEXT_FILE ||
      env?.CODEX_CONTEXT_FILE ||
      env?.HARNESS_PLUGIN_ROOT ||
      env?.HARNESS_DATA_ROOT,
  );
}
