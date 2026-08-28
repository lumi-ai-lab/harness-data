import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const MODE_SINGLE = "single";
export const MODE_FREE = "free";
export const MODE_MULTI = "multi_single";
export const MODE_REPORT = "report";
export const MODE_TEMPLATE_REPORT = MODE_REPORT;
export const MODE_FREE_ANALYSIS = MODE_FREE;

const MAX_PLAIN_SESSION_ID_LENGTH = 120;
const UNSAFE_SESSION_ID = /[^A-Za-z0-9_.-]/;

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
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const data = `${JSON.stringify(state, null, 2)}\n`;
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
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
  }
}

export function stateDir(root) {
  return path.join(root, ".harness", "state", "business-report");
}

export function diagnosticsDir(root) {
  return path.join(root, ".harness", "state", "diagnostics");
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
