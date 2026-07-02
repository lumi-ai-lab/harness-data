import fs from "node:fs";
import path from "node:path";
import { chooseAgent, confirm } from "../lib/prompt.js";
import { findWorkspaceDir, readUserState, writeState } from "../lib/paths.js";
import { run } from "../lib/exec.js";
import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { packageVersion } from "../lib/package.js";
import { platformKey } from "../lib/platform.js";
import { githubToken, latestRelease } from "../lib/github.js";
import { resolveLatestTool } from "../lib/tool-release.js";
import { protocolFromUrl, runGitWithProtocol } from "../lib/git-auth.js";
import { buildAndCheck, installRuntimeBundle, printDoctorSummary } from "./install.js";
import { collectDoctor } from "./doctor.js";
import { hasAnyAgentHook, linkAgents, writeLocalConfig } from "../lib/config.js";
import { action, blank, header, ok, shortSha, skip, step, warn } from "../lib/log.js";

export function isNonBlockingUpdateDoctorCheck(check) {
  return check.name === "Agent hook" ||
    check.name.startsWith("Agent hook .") ||
    check.name === "CAS credentials file" ||
    check.name === "CMR token" ||
    check.name === "Indicators token";
}

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

function oneToolManifest(manifest, tool) {
  return {
    ...manifest,
    tools: [tool]
  };
}

async function maybeUpdateTool(runtimeDir, manifest, tool, options, state) {
  const key = platformKey();
  const latestTool = await resolveLatestTool(tool, key, options);
  const tag = latestTool.version;
  const current = state.tools?.[tool.name] || {};
  const tagChanged = current.version && current.version !== tag;
  const firstInstall = !current.version;
  if (!tagChanged && !firstInstall) {
    ok(`${tool.name} 已是最新 ${tag}`);
    return null;
  }
  action(`发现更新：${tool.name} ${current.version || "unknown"} -> ${tag}`);
  if (!(await confirm(`是否更新 ${tool.name}？`))) {
    skip(tool.name);
    options.skippedUpdates?.push(`${tool.name} ${tag}`);
    return null;
  }
  const updatedManifest = oneToolManifest(manifest, latestTool);
  const installed = await installToolsFromManifest(runtimeDir, path.join(runtimeDir, ".bootstrap-cache", `${tool.name}-manifest.json`), {
    ...options,
    manifestOverride: updatedManifest
  });
  const result = installed.installedTools?.[tool.name] || { version: tag };
  ok(`${tool.name} 已更新到 ${tag}`);
  return result;
}

async function updateWikisGit(wikisDir, args, options) {
  const remote = (await run("git", ["-C", wikisDir, "remote", "get-url", "origin"], { ...options, allowFailure: true })).stdout.trim();
  const protocol = protocolFromUrl(remote);
  if (!protocol) return run("git", ["-C", wikisDir, ...args], options);
  return runGitWithProtocol(protocol, ["-C", wikisDir, ...args], options);
}

export async function updateWikis(runtimeDir, options, state) {
  const wikisDir = path.join(runtimeDir, "wikis");
  if (!githubToken(options) && state.installMode !== "github-token") {
    skip("harness-data-wikis 为本地路径模式，请手动检查");
    return null;
  }
  if (!fs.existsSync(path.join(wikisDir, ".git"))) {
    skip("harness-data-wikis 不是 git checkout");
    return null;
  }
  await updateWikisGit(wikisDir, ["fetch", "origin"], options);
  const local = (await run("git", ["-C", wikisDir, "rev-parse", "HEAD"], options)).stdout.trim();
  const remote = (await run("git", ["-C", wikisDir, "rev-parse", "origin/HEAD"], { ...options, allowFailure: true })).stdout.trim();
  if (!remote || local === remote) {
    ok(`harness-data-wikis 已是最新 ${shortSha(local)}`);
    return null;
  }
  action(`发现更新：harness-data-wikis ${shortSha(local)} -> ${shortSha(remote)}`);
  if (!(await confirm("是否更新 harness-data-wikis？"))) {
    skip("harness-data-wikis");
    options.skippedUpdates?.push(`harness-data-wikis ${shortSha(remote)}`);
    return null;
  }
  await updateWikisGit(wikisDir, ["pull", "--ff-only"], options);
  const commit = (await run("git", ["-C", wikisDir, "rev-parse", "HEAD"], options)).stdout.trim();
  ok(`harness-data-wikis 已更新到 ${shortSha(commit)}`);
  return { commit };
}

export async function restoreAgentHooksIfMissing(runtimeDir, options = {}) {
  if (hasAnyAgentHook(runtimeDir)) {
    ok("Agent Hook 已配置");
    return null;
  }
  action("未检测到 Agent Hook，重新配置");
  const agent = await chooseAgent(options);
  const linkedAgents = linkAgents(runtimeDir, agent);
  for (const [source, target] of linkedAgents) {
    if (fs.existsSync(path.join(runtimeDir, target))) ok(`${target} -> ${source}`);
  }
  return { agent, linkedAgents };
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
  const key = platformKey();
  header("Harness Data 更新器", packageVersion(), [
    `运行目录：${runtimeDir}`,
    `平台：${key}`
  ]);
  const state = readUserState();
  const manifestPath = path.join(runtimeDir, "bootstrap", "cli-manifest.json");
  const manifest = readManifest(manifestPath);
  let changed = false;
  let runtimeTag = state.runtimeTag || "";
  const nextTools = { ...(state.tools || {}) };
  const applied = [];
  const skipped = [];
  const trackingOptions = { ...options, skippedUpdates: skipped };

  step(1, 7, "检查 installer");
  const latestInstaller = await npmLatest();
  if (latestInstaller && latestInstaller !== packageVersion()) {
    warn(`installer 有新版本 ${packageVersion()} -> ${latestInstaller}`);
    action("请重新执行：npx @lumi-ai-lab/harness-data@latest update");
  } else {
    ok(`installer 已是最新 ${packageVersion()}`);
  }
  blank();

  step(2, 7, "检查 runtime bundle");
  const runtimeRelease = await latestRelease("lumi-ai-lab/harness-data", options);
  if (state.runtimeTag && state.runtimeTag !== runtimeRelease.tag_name) {
    action(`发现更新：runtime bundle ${state.runtimeTag} -> ${runtimeRelease.tag_name}`);
    if (await confirm("是否更新 runtime bundle？")) {
      const bundle = await installRuntimeBundle(runtimeDir, { ...trackingOptions, force: true });
      runtimeTag = bundle.tag || runtimeRelease.tag_name;
      changed = true;
      applied.push(`runtime bundle ${runtimeTag}`);
    } else {
      skip("runtime bundle");
      skipped.push(`runtime bundle ${runtimeRelease.tag_name}`);
    }
  } else {
    ok(`runtime bundle 已是最新 ${state.runtimeTag || runtimeRelease.tag_name}`);
  }
  blank();

  step(3, 7, "检查 CLI 工具");
  for (const tool of manifest.tools || []) {
    if (state.installMode === "local-path" && tool.name !== "data-harness-cli") {
      skip(`${tool.name} 为本地路径模式，请手动检查`);
      continue;
    }
    const installed = await maybeUpdateTool(runtimeDir, manifest, tool, trackingOptions, state);
    if (installed) {
      nextTools[tool.name] = installed;
      changed = true;
      applied.push(`${tool.name} ${installed.version || ""}`.trim());
    }
  }
  blank();

  step(4, 7, "检查 Wikis 知识库");
  const wikis = await updateWikis(runtimeDir, trackingOptions, state);
  if (wikis) {
    changed = true;
    applied.push(`harness-data-wikis ${shortSha(wikis.commit)}`);
  }
  blank();

  step(5, 7, "检查 Agent Hook");
  const restoredAgent = await restoreAgentHooksIfMissing(runtimeDir, trackingOptions);
  blank();

  step(6, 7, "构建 Wikis 索引");
  if (changed) {
    await buildAndCheck(runtimeDir, trackingOptions);
  } else {
    skip("没有组件更新");
  }
  blank();

  step(7, 7, "安装校验");
  if (changed) {
    writeLocalConfig(runtimeDir, { overwrite: true });
    ok("本地配置已刷新");
    const doctor = await collectDoctor(runtimeDir, trackingOptions);
    printDoctorSummary(doctor, { nonBlocking: isNonBlockingUpdateDoctorCheck });
    if (doctor.checks.some((check) => !check.ok && !isNonBlockingUpdateDoctorCheck(check))) throw new Error("doctor failed; update is incomplete");
    writeState(runtimeDir, {
      ...state,
      runtimeTag,
      tools: nextTools,
      manifestSha256: manifestDigest(manifest),
      ...(restoredAgent ? { agent: restoredAgent.agent } : {}),
      lastCheckAt: new Date().toISOString()
    });
    blank();
    console.log(`更新完成：${runtimeDir}`);
    if (applied.length) {
      console.log("");
      console.log("已更新：");
      for (const item of applied) console.log(`- ${item}`);
    }
    if (skipped.length) {
      console.log("");
      console.log("已跳过：");
      for (const item of skipped) console.log(`- ${item}`);
    }
    if (restoredAgent) {
      console.log("");
      console.log("已恢复：");
      console.log(`- Agent Hook ${restoredAgent.agent}`);
    }
  } else if (restoredAgent) {
    ok("Agent Hook 已恢复");
    writeState(runtimeDir, { ...state, agent: restoredAgent.agent, lastCheckAt: new Date().toISOString() });
    blank();
    console.log(`配置已恢复：${runtimeDir}`);
    console.log("");
    console.log("已恢复：");
    console.log(`- Agent Hook ${restoredAgent.agent}`);
    if (skipped.length) {
      console.log("");
      console.log("已跳过：");
      for (const item of skipped) console.log(`- ${item}`);
    }
  } else {
    skip("没有组件更新");
    writeState(runtimeDir, { ...state, lastCheckAt: new Date().toISOString() });
    blank();
    console.log(skipped.length ? "没有应用任何更新。" : "没有发现需要更新的内容。");
    if (skipped.length) {
      console.log("");
      console.log("已跳过：");
      for (const item of skipped) console.log(`- ${item}`);
    }
  }
}
