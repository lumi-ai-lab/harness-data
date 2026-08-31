import fs from "node:fs";
import path from "node:path";
import { chooseAgent, confirm } from "../lib/prompt.js";
import { findWorkspaceDir, readWorkspaceState, writeState } from "../lib/paths.js";
import { run } from "../lib/exec.js";
import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { packageVersion } from "../lib/package.js";
import { platformKey } from "../lib/platform.js";
import { collectReleaseArchivePassword } from "../lib/release-password.js";
import { githubToken } from "../lib/github.js";
import { resolveReleaseSource } from "../lib/release-source.js";
import { resolveLatestTool } from "../lib/tool-release.js";
import { forceSyncWikis, remoteDefaultRef, runWikisGit } from "../lib/wikis-git.js";
import { createInstallSession } from "../lib/install-session.js";
import { buildAndCheck, installRuntimeBundle, installWikis, printDoctorSummary, resolveLatestHarnessRelease } from "./install.js";
import { collectDoctor } from "./doctor.js";
import { assertCodexAuthPlatform, hasAnyAgentHook, linkAgents, patchCodexHooksForWindows, readAuthzFromHarnessConfig, writeLocalConfig } from "../lib/config.js";
import { action, blank, header, ok, shortSha, skip, step, warn } from "../lib/log.js";
import { agentIncludesWorkBuddy, assertWorkBuddyAuthPlatform, inspectWorkBuddyPlugin } from "../lib/workbuddy.js";

export function isNonBlockingUpdateDoctorCheck(check) {
  return check.name === "Agent hook" ||
    check.name.startsWith("Agent hook .");
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

export async function updateWikis(runtimeDir, options, state, harnessRelease) {
  const wikisMode = wikisInstallMode(state);
  if (wikisMode === "local-path") {
    skip("harness-data-wikis 为本地路径模式，请手动检查");
    return null;
  }
  if (options.useGitWikis) return updateGitWikis(runtimeDir, options, state);

  const resolved = harnessRelease || await resolveLatestHarnessRelease(options);
  const tag = resolved.tag;
  if (wikisMode === "release" && state.wikisTag === tag) {
    ok("harness-data-wikis 已是最新 " + tag);
    return null;
  }
  if (fs.existsSync(path.join(runtimeDir, "wikis"))) {
    warn("已有 Wikis 将以 Release 附件替换，本地修改不会保留");
  }
  action("发现更新：harness-data-wikis " + (state.wikisTag || "unknown") + " -> " + tag);
  if (!(await confirm("是否更新 harness-data-wikis？", options))) {
    skip("harness-data-wikis");
    options.skippedUpdates?.push("harness-data-wikis " + tag);
    return null;
  }
  const installed = await installWikis(runtimeDir, {
    ...options,
    _harnessRelease: resolved
  });
  ok("harness-data-wikis 已更新到 " + tag);
  return installed;
}

async function updateGitWikis(runtimeDir, options, state) {
  const wikisDir = path.join(runtimeDir, "wikis");
  const wikisMode = wikisInstallMode(state);
  if (!githubToken(options) && wikisMode !== "github") {
    skip("harness-data-wikis 为本地路径模式，请手动检查");
    return null;
  }
  if (!fs.existsSync(path.join(wikisDir, ".git"))) {
    skip("harness-data-wikis 不是 git checkout");
    return null;
  }
  await runWikisGit(wikisDir, ["fetch", "origin"], options);
  const local = (await run("git", ["-C", wikisDir, "rev-parse", "HEAD"], options)).stdout.trim();
  const remoteRef = await remoteDefaultRef(wikisDir, options);
  const remote = (await run("git", ["-C", wikisDir, "rev-parse", remoteRef], options)).stdout.trim();
  const dirty = (await run("git", ["-C", wikisDir, "status", "--porcelain"], options)).stdout.trim();
  if (local === remote && !dirty) {
    ok(`harness-data-wikis 已是最新 ${shortSha(local)}`);
    return null;
  }
  if (dirty) warn("Wikis 存在本地修改，更新时将以远程版本强制覆盖");
  action(local === remote
    ? `发现 Wikis 本地修改：harness-data-wikis ${shortSha(local)}`
    : `发现更新：harness-data-wikis ${shortSha(local)} -> ${shortSha(remote)}`);
  if (!(await confirm("是否更新 harness-data-wikis？", options))) {
    skip("harness-data-wikis");
    options.skippedUpdates?.push(`harness-data-wikis ${shortSha(remote)}`);
    return null;
  }
  action(`强制同步 Wikis 到 ${remoteRef}`);
  const { commit } = await forceSyncWikis(wikisDir, options, { fetched: true });
  ok(`harness-data-wikis 已更新到 ${shortSha(commit)}`);
  return { commit };
}

export function toolInstallMode(state = {}, toolName) {
  if (state.toolInstallModes?.[toolName]) return state.toolInstallModes[toolName];
  if (state.localTools?.[toolName]?.mode === "local-path") return "local-path";
  if (state.installMode === "local-path" && toolName !== "data-harness-cli") return "local-path";
  return "release";
}

export function wikisInstallMode(state = {}) {
  return state.wikisMode || (state.installMode === "github-token" ? "github" : "local-path");
}

/**
 * Run an update as one filesystem transaction. Runtime, tools, wikis, hooks,
 * config, and installer state must either all commit or all roll back so a
 * failed update cannot leave a mixed-version runtime behind.
 */
export async function withUpdateSession(runtimeDir, operation) {
  const session = createInstallSession(runtimeDir);
  try {
    session.begin();
    const result = await operation();
    session.commit();
    return result;
  } catch (error) {
    session.rollback();
    warn("更新失败，已回滚本次写入");
    throw error;
  }
}

function migratedInstallState(state, manifest, releaseSource) {
  return {
    installMode: undefined,
    releaseSource,
    wikisMode: wikisInstallMode(state),
    ...(state.wikisTag ? { wikisTag: state.wikisTag } : {}),
    toolInstallModes: Object.fromEntries((manifest.tools || []).map((tool) => [
      tool.name,
      toolInstallMode(state, tool.name)
    ]))
  };
}

export async function restoreAgentHooksIfMissing(runtimeDir, options = {}) {
  if (agentIncludesWorkBuddy(options.agent)) {
    const plugin = inspectWorkBuddyPlugin(runtimeDir);
    if (!plugin.prepared) throw new Error(`WorkBuddy plugin package is incomplete: ${plugin.errors.join("; ")}`);
    if (!plugin.versionMatchesPackage) {
      throw new Error(`WorkBuddy plugin version ${plugin.version || "missing"} does not match installer ${packageVersion()}`);
    }
    ok(`WorkBuddy Marketplace 已准备：${plugin.marketplaceRoot}；安装/启用状态需在 WorkBuddy 中确认`);
    return null;
  }
  if (hasAnyAgentHook(runtimeDir)) {
    // A runtime bundle update restores hooks.json to the original bash form.
    // Patch the freshly installed file even when the agent junction exists.
    patchCodexHooksForWindows(runtimeDir);
    ok("Agent Hook 已配置");
    return null;
  }
  action("未检测到 Agent Hook，重新配置");
  const agent = await chooseAgent(options);
  const linkedAgents = linkAgents(runtimeDir, agent);
  for (const [source, target] of linkedAgents) {
    if (fs.existsSync(path.join(runtimeDir, target))) ok(`${target} -> ${source}`);
  }
  patchCodexHooksForWindows(runtimeDir);
  return { agent, linkedAgents };
}

export async function checkUpdates(workspace, options = {}) {
  const state = readWorkspaceState(workspace);
  const latestInstaller = await npmLatest();
  return {
    installer: { current: packageVersion(), latest: latestInstaller, update: Boolean(latestInstaller && latestInstaller !== packageVersion()) },
    state,
    hasUpdates: Boolean(latestInstaller && latestInstaller !== packageVersion())
  };
}

export async function updateCommand(options = {}) {
  const selectedReleaseSource = resolveReleaseSource(options);
  const runtimeDir = findWorkspaceDir(options.dir);
  if (!fs.existsSync(runtimeDir)) throw new Error(`runtime directory does not exist: ${runtimeDir}`);
  return withUpdateSession(runtimeDir, async () => {
    const key = platformKey();
    header("Harness Data 更新器", packageVersion(), [
      `运行目录：${runtimeDir}`,
      `平台：${key}`
    ]);
    const state = readWorkspaceState(runtimeDir);
    const configuredAgent = options.agent || state.agent;
    const existingAuthz = readAuthzFromHarnessConfig(path.join(runtimeDir, "config", "harness-config.yaml"));
    assertCodexAuthPlatform(configuredAgent, existingAuthz?.mode === "on", options.platform || process.platform);
    assertWorkBuddyAuthPlatform(configuredAgent, existingAuthz?.mode === "on", options.platform || process.platform);
    const manifestPath = path.join(runtimeDir, "bootstrap", "cli-manifest.json");
    const manifest = readManifest(manifestPath);
    const migratedState = migratedInstallState(state, manifest, selectedReleaseSource);
    const archivePassword = await collectReleaseArchivePassword(options);
    let changed = false;
    let runtimeTag = state.runtimeTag || "";
    const nextTools = { ...(state.tools || {}) };
    let nextWikis = {};
    const applied = [];
    const skipped = [];
    const trackingOptions = { ...options, _releaseArchivePassword: archivePassword, skippedUpdates: skipped };

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
    const runtimeRelease = await resolveLatestHarnessRelease(trackingOptions);
    const workBuddyPlugin = inspectWorkBuddyPlugin(runtimeDir);
    const workBuddyRepairNeeded = agentIncludesWorkBuddy(configuredAgent) &&
      (!workBuddyPlugin.prepared || !workBuddyPlugin.versionMatchesPackage);
    if ((state.runtimeTag && state.runtimeTag !== runtimeRelease.tag) || workBuddyRepairNeeded) {
      if (workBuddyRepairNeeded && state.runtimeTag === runtimeRelease.tag) {
        action("发现 WorkBuddy plugin package 缺失或不完整，需要修复 runtime bundle");
      } else {
        action(`发现更新：runtime bundle ${state.runtimeTag || "unknown"} -> ${runtimeRelease.tag}`);
      }
      if (await confirm(workBuddyRepairNeeded ? "是否修复 runtime bundle？" : "是否更新 runtime bundle？")) {
        const bundle = await installRuntimeBundle(runtimeDir, {
          ...trackingOptions,
          _harnessRelease: runtimeRelease,
          force: true,
          requireWorkBuddy: agentIncludesWorkBuddy(configuredAgent)
        });
        runtimeTag = bundle.tag || runtimeRelease.tag;
        changed = true;
        applied.push(`runtime bundle ${runtimeTag}`);
      } else {
        skip("runtime bundle");
        skipped.push(`runtime bundle ${runtimeRelease.tag}`);
      }
    } else {
      ok(`runtime bundle 已是最新 ${state.runtimeTag || runtimeRelease.tag}`);
    }
    blank();

    step(3, 7, "检查 CLI 工具");
    for (const tool of manifest.tools || []) {
      if (toolInstallMode(state, tool.name) === "local-path") {
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
    const wikis = await updateWikis(runtimeDir, trackingOptions, state, runtimeRelease);
    if (wikis) {
      changed = true;
      nextWikis = {
        wikisMode: wikis.mode,
        ...(wikis.tag ? { wikisTag: wikis.tag } : {})
      };
      applied.push("harness-data-wikis " + (wikis.tag || "updated"));
    }
    blank();

    step(5, 7, "检查 Agent Hook");
    const restoredAgent = await restoreAgentHooksIfMissing(runtimeDir, { ...trackingOptions, agent: configuredAgent });
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
      const doctor = await collectDoctor(runtimeDir, { ...trackingOptions, agent: configuredAgent });
      printDoctorSummary(doctor, { nonBlocking: isNonBlockingUpdateDoctorCheck });
      if (doctor.checks.some((check) => !check.ok && !isNonBlockingUpdateDoctorCheck(check))) throw new Error("doctor failed; update is incomplete");
      writeState(runtimeDir, {
        ...state,
        ...migratedState,
        ...nextWikis,
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
      writeState(runtimeDir, { ...state, ...migratedState, agent: restoredAgent.agent, lastCheckAt: new Date().toISOString() });
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
      writeState(runtimeDir, { ...state, ...migratedState, lastCheckAt: new Date().toISOString() });
      blank();
      console.log(skipped.length ? "没有应用任何更新。" : "没有发现需要更新的内容。");
      if (skipped.length) {
        console.log("");
        console.log("已跳过：");
        for (const item of skipped) console.log(`- ${item}`);
      }
    }
  });
}
