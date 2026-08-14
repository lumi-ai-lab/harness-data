import fs from "node:fs";
import path from "node:path";
import { userStatePath } from "./paths.js";

const trackedRoots = ["agents", "bootstrap", "bin", "wikis", "config", ".harness"];
const hookRoots = [".claude", ".codex", ".pi", ".openclaw", ".hermes"];
const cacheRoot = ".bootstrap-cache";
const tempPrefixes = [".install-session-backup-", ".install-backup-", ".install-new-runtime-"];

function cleanupTemps(root) {
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    if (tempPrefixes.some((prefix) => name.startsWith(prefix))) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  }
}

function snapshotCopy(target, prefix) {
  const backup = fs.mkdtempSync(prefix);
  fs.rmSync(backup, { recursive: true, force: true });
  fs.cpSync(target, backup, { recursive: true });
  return backup;
}

export function createInstallSession(runtimeDir) {
  const root = path.resolve(runtimeDir);
  const createdRuntimeDir = !fs.existsSync(root);
  const userFile = userStatePath();
  const priorUserStateExisted = fs.existsSync(userFile);
  const priorUserState = priorUserStateExisted ? fs.readFileSync(userFile) : null;
  const existed = {};
  for (const name of [...trackedRoots, ...hookRoots, cacheRoot]) {
    existed[name] = fs.existsSync(path.join(root, name));
  }
  const isReinstall = fs.existsSync(path.join(root, ".harness", "installer-state.json"))
    || (existed.agents && existed.bootstrap);

  const backups = [];
  let begun = false;
  let committed = false;

  function restoreUserState() {
    if (priorUserStateExisted) {
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, priorUserState, { mode: 0o600 });
      return;
    }
    if (!fs.existsSync(userFile)) return;
    try {
      const current = JSON.parse(fs.readFileSync(userFile, "utf8"));
      if (current.lastInstallDir && path.resolve(current.lastInstallDir) === root) {
        fs.rmSync(userFile, { force: true });
      }
    } catch {
      // leave unrelated user state alone
    }
  }

  return {
    root,
    isReinstall,
    createdRuntimeDir,
    begin() {
      if (begun) return;
      begun = true;
      if (createdRuntimeDir) fs.mkdirSync(root, { recursive: true });
      // Snapshot any pre-existing root, including first install into a dest
      // that already has bin/wikis/config (not classified as reinstall).
      for (const name of [...trackedRoots, ...hookRoots]) {
        const target = path.join(root, name);
        if (!fs.existsSync(target)) continue;
        backups.push({
          name,
          target,
          backup: snapshotCopy(target, path.join(root, `.install-session-backup-${name}-`))
        });
      }
    },
    rollback() {
      if (committed) return;
      for (const item of backups.slice().reverse()) {
        fs.rmSync(item.target, { recursive: true, force: true });
        if (fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target);
      }
      for (const name of [...trackedRoots, ...hookRoots, cacheRoot]) {
        if (!existed[name]) fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
      cleanupTemps(root);
      restoreUserState();
      if (createdRuntimeDir) {
        try {
          fs.rmdirSync(root);
        } catch {
          // directory still has unrelated files
        }
      }
    },
    commit() {
      committed = true;
      for (const item of backups) fs.rmSync(item.backup, { recursive: true, force: true });
      cleanupTemps(root);
    }
  };
}
