import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { runGitWithProtocol } from "./git-auth.js";

export async function isGitRepo(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  const result = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, allowFailure: true });
  return result.code === 0 && result.stdout.trim() === "true";
}

export async function currentCommit(dir) {
  const result = await run("git", ["rev-parse", "HEAD"], { cwd: dir, allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function dirtyPaths(dir) {
  const result = await run("git", ["status", "--porcelain"], { cwd: dir, allowFailure: true });
  if (result.code !== 0) return ["<git status failed>"];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function isDirty(dir) {
  return (await dirtyPaths(dir)).length > 0;
}

export async function currentBranch(dir) {
  const result = await run("git", ["branch", "--show-current"], { cwd: dir, allowFailure: true });
  return result.stdout.trim();
}

export async function remoteTracking(dir) {
  const result = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: dir, allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

async function fetchQuiet(dir, options = {}) {
  if (options.gitProtocol) {
    await runGitWithProtocol(options.gitProtocol, ["fetch", "--quiet"], { ...options, cwd: dir, allowFailure: true });
    return;
  }
  await run("git", ["fetch", "--quiet"], { cwd: dir, allowFailure: true });
}

export async function behindCount(dir, options = {}) {
  const upstream = await remoteTracking(dir);
  if (!upstream) return 0;
  await fetchQuiet(dir, options);
  const result = await run("git", ["rev-list", "--count", `HEAD..${upstream}`], { cwd: dir, allowFailure: true });
  return Number(result.stdout.trim() || "0");
}

export async function submoduleCommit(dir, name = "wikis") {
  const result = await run("git", ["-C", name, "rev-parse", "HEAD"], { cwd: dir, allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : "";
}

export async function submoduleRemoteBehind(dir, name = "wikis", options = {}) {
  const subdir = path.join(dir, name);
  if (!fs.existsSync(subdir)) return 0;
  await fetchQuiet(subdir, options);
  const upstream = await remoteTracking(subdir);
  if (!upstream) return 0;
  const result = await run("git", ["rev-list", "--count", `HEAD..${upstream}`], { cwd: subdir, allowFailure: true });
  return Number(result.stdout.trim() || "0");
}

async function gitlink(dir, rev, name) {
  const result = await run("git", ["ls-tree", rev, name], { cwd: dir, allowFailure: true });
  return result.stdout.trim().split(/\s+/)[2] || "";
}

export async function submodulePointerChanged(dir, name = "wikis") {
  const upstream = await remoteTracking(dir);
  if (!upstream) return false;
  const current = await gitlink(dir, "HEAD", name);
  const remote = await gitlink(dir, upstream, name);
  return Boolean(current && remote && current !== remote);
}
