import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateDir = path.join(".lumi-ai-lab", "qdm-harness");
const legacyStateDir = path.join("lumi-ai-lab", "harness-data-installer");

export function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function defaultWorkspaceDir() {
  return process.cwd();
}

export function userStatePath() {
  return path.join(os.homedir(), stateDir, "state.json");
}

export function legacyUserStatePath({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", legacyStateDir, "state.json");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), legacyStateDir, "state.json");
  return path.join(env.XDG_STATE_HOME || path.join(homeDir, ".local", "state"), legacyStateDir, "state.json");
}

export function readUserState() {
  const current = readStateFile(userStatePath());
  if (current) return current;
  const legacy = readStateFile(legacyUserStatePath());
  if (!legacy) return {};
  try {
    const target = userStatePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch {
    // The legacy state remains readable even when migration is not writable.
  }
  return legacy;
}

function readStateFile(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function readWorkspaceState(workspace, options = {}) {
  const resolvedWorkspace = path.resolve(workspace || defaultWorkspaceDir());
  try {
    return JSON.parse(fs.readFileSync(path.join(resolvedWorkspace, ".harness", "installer-state.json"), "utf8"));
  } catch {
    const userState = options.userState || readUserState();
    if (!userState.lastInstallDir || path.resolve(userState.lastInstallDir) !== resolvedWorkspace) return {};
    return userState;
  }
}

export function writeState(workspace, patch) {
  const file = userStatePath();
  const state = {
    ...readWorkspaceState(workspace),
    schemaVersion: 4,
    lastInstallDir: workspace,
    updatedAt: new Date().toISOString(),
    ...patch
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const local = path.join(workspace, ".harness", "installer-state.json");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function resolveWorkspaceDir(value) {
  return path.resolve(expandHome(value || defaultWorkspaceDir()));
}

export function findWorkspaceDir(explicitDir) {
  if (explicitDir) return resolveWorkspaceDir(explicitDir);
  if (looksLikeWorkspace(process.cwd())) return process.cwd();
  const state = readUserState();
  if (state.lastInstallDir) return path.resolve(state.lastInstallDir);
  return defaultWorkspaceDir();
}

export function looksLikeWorkspace(dir) {
  return fs.existsSync(path.join(dir, "bootstrap", "cli-manifest.json")) &&
    fs.existsSync(path.join(dir, "agents")) &&
    fs.existsSync(path.join(dir, "wikis"));
}
