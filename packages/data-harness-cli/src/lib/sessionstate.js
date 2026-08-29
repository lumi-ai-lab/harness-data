import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { normalizeResolverOwners } from "./harness.js";
import { ROOT_CONTEXT_ERROR_CODES, RootContextError } from "./root-context.js";

export const MODE_SINGLE = "single";
export const MODE_FREE = "free";
export const MODE_MULTI = "multi_single";
export const MODE_REPORT = "report";
export const MODE_TEMPLATE_REPORT = MODE_REPORT;
export const MODE_FREE_ANALYSIS = MODE_FREE;

const MAX_PLAIN_SESSION_ID_LENGTH = 120;
const UNSAFE_SESSION_ID = /[^A-Za-z0-9_.-]/;
const STATE_SCHEMA_VERSION = 1;
const STALE_LOCK_MS = 30_000;

export function emptyState(sessionId) {
  return {
    session_id: sessionId,
    template_injected: false,
    reports: {},
  };
}

export function load(root, sessionId) {
  const filePath = statePath(root, sessionId);
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyState(sessionId);
    throw error;
  }
  try {
    const state = JSON.parse(raw);
    if (!state.session_id) state.session_id = sessionId;
    if (!state.reports) state.reports = {};
    return state;
  } catch {
    return emptyState(sessionId);
  }
}

export function save(root, sessionId, state) {
  if (!state.session_id) state.session_id = sessionId;
  const owners = normalizeResolverOwners(root);
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  if (!owners.legacy) {
    state.schemaVersion ??= STATE_SCHEMA_VERSION;
    if (root.pluginVersion != null) state.pluginVersion ??= root.pluginVersion;
    if (root.resourceVersion != null) state.resourceVersion ??= root.resourceVersion;
  }
  const data = `${JSON.stringify(state, null, 2)}\n`;
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const lock = owners.legacy ? null : acquireLock(dir, sessionId);
  try {
    writeFileSync(temp, data);
    renameSync(temp, statePath(root, sessionId));
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // ignore cleanup
    }
    throw error;
  } finally {
    if (lock) releaseLock(lock);
  }
}

export function stateDir(root) {
  return path.join(requireStateRoot(root), "business-report");
}

export function diagnosticsDir(root) {
  return path.join(requireStateRoot(root), "diagnostics");
}

export function statePath(root, sessionId) {
  return path.join(stateDir(root), `${safeSessionId(sessionId)}.json`);
}

export function safeSessionId(sessionId) {
  if (!sessionId) return "unknown";
  if (
    sessionId.length <= MAX_PLAIN_SESSION_ID_LENGTH &&
    !UNSAFE_SESSION_ID.test(sessionId) &&
    !isWindowsReservedFilename(sessionId)
  ) {
    return sessionId;
  }
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `sha256~${digest}`;
}

export function stateRootFor(root) {
  return normalizeResolverOwners(root).stateRoot;
}

function requireStateRoot(root) {
  const stateRoot = stateRootFor(root);
  if (!stateRoot) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED, "stateRoot is unavailable; a workspace context is required");
  }
  return stateRoot;
}

function acquireLock(dir, sessionId) {
  const lockPath = path.join(dir, `${safeSessionId(sessionId)}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      closeSync(fd);
      return lockPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      const locked = new RootContextError(ROOT_CONTEXT_ERROR_CODES.STATE_LOCKED, `state lock is held for ${safeSessionId(sessionId)}`);
      throw locked;
    }
  }
  throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.STATE_LOCKED, `state lock is held for ${safeSessionId(sessionId)}`);
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // best effort; a completed atomic state write remains valid
  }
}

function isWindowsReservedFilename(name) {
  const base = name.split(".", 2)[0].toUpperCase();
  switch (base) {
    case "CON":
    case "PRN":
    case "AUX":
    case "NUL":
    case "CLOCK$":
      return true;
    default:
      break;
  }
  if (base.length === 4 && (base.startsWith("COM") || base.startsWith("LPT"))) {
    const n = base.charCodeAt(3);
    return n >= 49 && n <= 57;
  }
  return false;
}

export { tmpdir };
