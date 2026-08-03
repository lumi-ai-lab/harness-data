import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installerStateSchemaVersion, piRequesterAuthorizedProfile } from "./profile.js";

const stateDir = path.join("lumi-ai-lab", "harness-data-installer");

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
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", stateDir, "state.json");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), stateDir, "state.json");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), stateDir, "state.json");
}

export function readUserState() {
  try {
    return JSON.parse(fs.readFileSync(userStatePath(), "utf8"));
  } catch {
    return {};
  }
}

export function installerStatePath(workspace) {
  return path.join(workspace, ".harness", "installer-state.json");
}

export function readInstallerState(workspace) {
  try {
    return JSON.parse(fs.readFileSync(installerStatePath(workspace), "utf8"));
  } catch {
    return {};
  }
}

const piRequesterStateFields = [
  "schemaVersion",
  "profile",
  "agent",
  "installMode",
  "runtimeTag",
  "localTools",
  "tools",
  "manifestSha256",
  "packageVersion",
  "releaseSet",
  "authzConfigPath",
  "lastCheckAt"
];

export function installerStateDocument(workspace, patch, options = {}) {
  const updatedAt = options.updatedAt || new Date().toISOString();
  if (patch?.profile === piRequesterAuthorizedProfile) {
    if (patch.schemaVersion !== installerStateSchemaVersion) {
      throw new Error("pi-requester-authorized installer state must be a fresh schemaVersion 3 document");
    }
    const state = { lastInstallDir: workspace, updatedAt };
    for (const field of piRequesterStateFields) {
      if (patch[field] !== undefined) state[field] = patch[field];
    }
    return state;
  }
  return {
    ...(options.currentState || readUserState()),
    lastInstallDir: workspace,
    updatedAt,
    ...patch
  };
}

export function writeState(workspace, patch) {
  const file = userStatePath();
  const state = installerStateDocument(workspace, patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const local = installerStatePath(workspace);
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
