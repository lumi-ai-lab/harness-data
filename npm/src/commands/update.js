import fs from "node:fs";
import path from "node:path";
import { confirm } from "../lib/prompt.js";
import { findWorkspaceDir, readUserState, writeState } from "../lib/paths.js";
import { run } from "../lib/exec.js";
import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { behindCount, currentCommit, dirtyPaths, submoduleCommit, submodulePointerChanged, submoduleRemoteBehind } from "../lib/git.js";
import { packageVersion } from "../lib/package.js";
import { collectDoctor } from "./doctor.js";
import { normalizeGitProtocol, repoProtocol, repoUrl, runGitWithProtocol, syncWikisSubmodule } from "../lib/git-auth.js";

async function npmLatest() {
  try {
    const response = await fetch("https://registry.npmjs.org/@lumi-ai-lab%2Fharness-data/latest", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return "";
    const data = await response.json();
    return data.version || "";
  } catch {
    return "";
  }
}

async function remoteManifest(workspace) {
  const upstream = (await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: workspace, allowFailure: true })).stdout.trim();
  if (!upstream) return null;
  const result = await run("git", ["show", `${upstream}:bootstrap/cli-manifest.json`], { cwd: workspace, allowFailure: true });
  if (result.code !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function versionChanged(current, latest) {
  return latest && latest !== current;
}

export async function checkUpdates(workspace, gitOptions = {}) {
  const manifestPath = path.join(workspace, "bootstrap", "cli-manifest.json");
  const currentInstaller = packageVersion();
  const latestInstaller = await npmLatest();
  const mainBehind = await behindCount(workspace, gitOptions);
  const wikisBehind = await submoduleRemoteBehind(workspace, "wikis", gitOptions);
  const manifest = fs.existsSync(manifestPath) ? readManifest(manifestPath) : { tools: [] };
  const digest = manifestDigest(manifest);
  const remote = await remoteManifest(workspace);
  const remoteDigest = remote ? manifestDigest(remote) : "";
  const state = readUserState();
  const updates = {
    installer: { current: currentInstaller, latest: latestInstaller, update: versionChanged(currentInstaller, latestInstaller) },
    mainRepo: { behind: mainBehind, update: mainBehind > 0 },
    wikis: { remoteBehind: wikisBehind, pointerChanged: await submodulePointerChanged(workspace), update: wikisBehind > 0 },
    cli: {
      digest,
      remoteDigest,
      previousDigest: state.manifestSha256 || "",
      update: Boolean((state.manifestSha256 && state.manifestSha256 !== digest) || (remoteDigest && remoteDigest !== digest)),
      tools: manifest.tools || [],
      remoteTools: remote?.tools || []
    }
  };
  updates.wikis.update = updates.wikis.update || updates.wikis.pointerChanged;
  updates.hasUpdates = updates.installer.update || updates.mainRepo.update || updates.wikis.update || updates.cli.update;
  return updates;
}

function printUpdateSummary(updates) {
  console.log("Update summary:");
  console.log(`installer: ${updates.installer.current}${updates.installer.latest ? ` -> ${updates.installer.latest}` : " (latest unavailable)"}`);
  console.log(`main repo: ${updates.mainRepo.behind} commits behind`);
  console.log(`wikis: ${updates.wikis.remoteBehind} commits behind remote${updates.wikis.pointerChanged ? ", submodule pointer changed" : ""}`);
  console.log(`CLI manifest: ${updates.cli.update ? "changed" : "unchanged or first check"}`);
  const remoteByName = new Map(updates.cli.remoteTools.map((tool) => [tool.name, tool]));
  for (const tool of updates.cli.tools) {
    const remote = remoteByName.get(tool.name);
    const target = remote && remote.version !== tool.version ? ` -> ${remote.version}` : "";
    console.log(`  ${tool.name} ${tool.version}${target}`);
  }
}

async function updateProtocol(workspace, options) {
  const requested = normalizeGitProtocol(options.gitProtocol);
  if (requested !== "auto") return requested;
  const state = readUserState();
  return state.gitProtocol || await repoProtocol(workspace) || "ssh";
}

export async function updateCommand(options = {}) {
  const workspace = findWorkspaceDir(options.dir);
  if (!fs.existsSync(workspace)) throw new Error(`workspace does not exist: ${workspace}`);
  const mainDirty = await dirtyPaths(workspace);
  const wikisDirty = fs.existsSync(path.join(workspace, "wikis")) ? await dirtyPaths(path.join(workspace, "wikis")) : [];
  if (mainDirty.length || wikisDirty.length) {
    console.error("Dirty worktree detected; update will not overwrite local changes.");
    for (const line of mainDirty) console.error(`main: ${line}`);
    for (const line of wikisDirty) console.error(`wikis: ${line}`);
    process.exitCode = 1;
    return;
  }
  const gitProtocol = await updateProtocol(workspace, options);
  await syncWikisSubmodule(workspace, gitProtocol);
  const originUrl = await repoUrl(workspace);
  const updates = await checkUpdates(workspace, { ...options, gitProtocol });
  printUpdateSummary(updates);
  if (options.check) {
    writeState(workspace, {
      mainCommit: await currentCommit(workspace),
      wikisCommit: await submoduleCommit(workspace),
      manifestSha256: updates.cli.digest,
      packageVersion: packageVersion(),
      lastCheckAt: new Date().toISOString(),
      gitProtocol,
      repoUrl: originUrl
    });
    return updates;
  }
  if (!updates.hasUpdates) {
    console.log("No repository or wikis updates detected.");
    writeState(workspace, {
      mainCommit: await currentCommit(workspace),
      wikisCommit: await submoduleCommit(workspace),
      manifestSha256: updates.cli.digest,
      packageVersion: packageVersion(),
      lastCheckAt: new Date().toISOString(),
      gitProtocol,
      repoUrl: originUrl
    });
    return updates;
  }
  if (!(await confirm(`Apply updates to ${workspace}?`, { yes: options.yes, defaultNo: true }))) throw new Error("update cancelled");
  if (updates.mainRepo.update) {
    await runGitWithProtocol(gitProtocol, ["pull", "--ff-only"], { ...options, cwd: workspace, stdio: "inherit" });
  }
  if (updates.wikis.update || updates.mainRepo.update) {
    if (!(await confirm("Update wikis submodule? This can change Agent behavior.", { yes: options.yes, defaultNo: true }))) {
      console.warn("warning: wikis update skipped");
    } else {
      await syncWikisSubmodule(workspace, gitProtocol);
      await runGitWithProtocol(gitProtocol, ["submodule", "update", "--init", "--recursive", "--remote", "wikis"], { ...options, cwd: workspace, stdio: "inherit" });
    }
  }
  await installToolsFromManifest(workspace, path.join(workspace, "bootstrap", "cli-manifest.json"), options);
  await run(path.join(workspace, "bin", "data-harness-cli"), ["wikis", "build-index"], { cwd: workspace, stdio: "inherit" });
  const doctor = await collectDoctor(workspace, options);
  for (const check of doctor.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
  if (doctor.checks.some((check) => !check.ok)) throw new Error("doctor failed after update");
  writeState(workspace, {
    mainCommit: await currentCommit(workspace),
    wikisCommit: await submoduleCommit(workspace),
    manifestSha256: updates.cli.digest,
    packageVersion: packageVersion(),
    lastCheckAt: new Date().toISOString(),
    gitProtocol,
    repoUrl: originUrl
  });
  console.log(`Harness Data updated: ${workspace}`);
}
