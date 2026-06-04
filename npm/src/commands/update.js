import fs from "node:fs";
import path from "node:path";
import { confirm } from "../lib/prompt.js";
import { findWorkspaceDir, readUserState, writeState } from "../lib/paths.js";
import { run } from "../lib/exec.js";
import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { packageVersion } from "../lib/package.js";
import { platformKey } from "../lib/platform.js";
import { githubToken, latestRelease } from "../lib/github.js";
import { buildAndCheck, installRuntimeBundle } from "./install.js";
import { collectDoctor } from "./doctor.js";

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

function archiveSuffix(url) {
  if (url.endsWith(".zip")) return "zip";
  if (url.endsWith(".tar.gz")) return "tar.gz";
  return "";
}

function toolAssetName(tool, tag, key) {
  const current = tool.platforms?.[key]?.url || "";
  const suffix = archiveSuffix(current) || (key.startsWith("windows-") ? "zip" : "tar.gz");
  return `${tool.binary}-${tag}-${key}.${suffix}`;
}

function releaseAsset(release, name) {
  return (release.assets || []).find((asset) => asset.name === name);
}

function oneToolManifest(manifest, tool, tag, asset, key) {
  return {
    ...manifest,
    tools: [{
      ...tool,
      version: tag,
      platforms: {
        [key]: {
          url: asset.browser_download_url || `https://github.com/${tool.repo}/releases/download/${tag}/${asset.name}`,
          sha256: ""
        }
      }
    }]
  };
}

async function maybeUpdateTool(runtimeDir, manifest, tool, options, state) {
  const key = platformKey();
  const release = await latestRelease(tool.repo, options);
  const tag = release.tag_name;
  const assetName = toolAssetName(tool, tag, key);
  const asset = releaseAsset(release, assetName);
  if (!asset) {
    console.warn(`warning: ${tool.name} latest release has no ${assetName}; skipped`);
    return null;
  }
  const current = state.tools?.[tool.name] || {};
  const tagChanged = current.version && current.version !== tag;
  const firstInstall = !current.version;
  if (!tagChanged && !firstInstall) {
    console.log(`${tool.name}: up to date (${tag})`);
    return null;
  }
  console.log(`${tool.name} has update:`);
  console.log(`  current: ${current.version || "unknown"}`);
  console.log(`  remote:  ${tag}`);
  if (!(await confirm(`Update ${tool.name}?`, { defaultNo: true }))) {
    console.log(`Skipped ${tool.name}`);
    return null;
  }
  const updatedManifest = oneToolManifest(manifest, tool, tag, asset, key);
  const installed = await installToolsFromManifest(runtimeDir, path.join(runtimeDir, ".bootstrap-cache", `${tool.name}-manifest.json`), {
    ...options,
    manifestOverride: updatedManifest
  });
  return installed.installedTools?.[tool.name] || { version: tag, asset: assetName };
}

async function updateWikis(runtimeDir, options, state) {
  const wikisDir = path.join(runtimeDir, "wikis");
  if (!githubToken(options) && state.installMode !== "github-token") {
    console.log("wikis: local path mode; check manually");
    return null;
  }
  if (!fs.existsSync(path.join(wikisDir, ".git"))) {
    console.log("wikis: not a git checkout; skipped");
    return null;
  }
  await run("git", ["-C", wikisDir, "fetch", "origin"], { stdio: "inherit" });
  const local = (await run("git", ["-C", wikisDir, "rev-parse", "HEAD"])).stdout.trim();
  const remote = (await run("git", ["-C", wikisDir, "rev-parse", "origin/HEAD"], { allowFailure: true })).stdout.trim();
  if (!remote || local === remote) {
    console.log(`wikis: up to date (${local.slice(0, 12)})`);
    return null;
  }
  console.log("wikis has update:");
  console.log(`  current: ${local}`);
  console.log(`  remote:  ${remote}`);
  if (!(await confirm("Update wikis?", { defaultNo: true }))) {
    console.log("Skipped wikis");
    return null;
  }
  await run("git", ["-C", wikisDir, "pull", "--ff-only"], { stdio: "inherit" });
  return { commit: (await run("git", ["-C", wikisDir, "rev-parse", "HEAD"])).stdout.trim() };
}

export async function checkUpdates(workspace, options = {}) {
  const state = readUserState();
  const latestInstaller = await npmLatest();
  return {
    installer: { current: packageVersion(), latest: latestInstaller, update: Boolean(latestInstaller && latestInstaller !== packageVersion()) },
    state,
    hasUpdates: Boolean(latestInstaller && latestInstaller !== packageVersion())
  };
}

export async function updateCommand(options = {}) {
  const runtimeDir = findWorkspaceDir(options.dir);
  if (!fs.existsSync(runtimeDir)) throw new Error(`runtime directory does not exist: ${runtimeDir}`);
  const state = readUserState();
  const manifestPath = path.join(runtimeDir, "bootstrap", "cli-manifest.json");
  const manifest = readManifest(manifestPath);
  let changed = false;
  let runtimeTag = state.runtimeTag || "";
  const nextTools = { ...(state.tools || {}) };

  const latestInstaller = await npmLatest();
  if (latestInstaller && latestInstaller !== packageVersion()) {
    console.log(`installer has update: ${packageVersion()} -> ${latestInstaller}`);
    console.log("Run the same npx command again to use the latest npm installer.");
  } else {
    console.log(`installer: up to date (${packageVersion()})`);
  }

  const runtimeRelease = await latestRelease("lumi-ai-lab/harness-data", options);
  if (state.runtimeTag && state.runtimeTag !== runtimeRelease.tag_name) {
    console.log(`runtime bundle has update: ${state.runtimeTag} -> ${runtimeRelease.tag_name}`);
    if (await confirm("Update runtime bundle?", { defaultNo: true })) {
      const bundle = await installRuntimeBundle(runtimeDir, { ...options, force: true });
      runtimeTag = bundle.tag || runtimeRelease.tag_name;
      changed = true;
    } else {
      console.log("Skipped runtime bundle");
    }
  } else {
    console.log(`runtime bundle: up to date (${state.runtimeTag || runtimeRelease.tag_name})`);
  }

  for (const tool of manifest.tools || []) {
    if (state.installMode === "local-path" && tool.name !== "data-harness-cli") {
      console.log(`${tool.name}: local path mode; check manually`);
      continue;
    }
    const installed = await maybeUpdateTool(runtimeDir, manifest, tool, options, state);
    if (installed) {
      nextTools[tool.name] = installed;
      changed = true;
    }
  }

  const wikis = await updateWikis(runtimeDir, options, state);
  if (wikis) changed = true;

  if (changed) {
    await buildAndCheck(runtimeDir, options);
    const doctor = await collectDoctor(runtimeDir, options);
    for (const check of doctor.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    writeState(runtimeDir, {
      ...state,
      runtimeTag,
      tools: nextTools,
      manifestSha256: manifestDigest(manifest),
      lastCheckAt: new Date().toISOString()
    });
    console.log("Harness Data runtime updated.");
  } else {
    writeState(runtimeDir, { ...state, lastCheckAt: new Date().toISOString() });
    console.log("No selected updates were applied.");
  }
}
