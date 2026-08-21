import fs from "node:fs";
import path from "node:path";
import { commandExists, run } from "../lib/exec.js";
import { assertCodexAuthPlatform, localPathToolNames, writeLocalConfig, ensureLocalAuthBlob, writeAuthBlob, linkAgents, removeLegacyDataCLIs, patchCodexHooksForWindows } from "../lib/config.js";
import { ask, chooseAgent } from "../lib/prompt.js";
import { collectInstallAuth } from "../lib/install-auth.js";
import { createInstallSession } from "../lib/install-session.js";
import { readWorkspaceState, resolveWorkspaceDir, writeState } from "../lib/paths.js";
import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { binaryName, isExecutable, platformKey } from "../lib/platform.js";
import { resolveLatestManifest } from "../lib/tool-release.js";
import { collectDoctor } from "./doctor.js";
import { packageVersion } from "../lib/package.js";
import { downloadReleaseAsset, findReleaseAsset, hasGithubAuth, latestRelease } from "../lib/github.js";
import { action, blank, fail, header, ok, skip, step, warn } from "../lib/log.js";
import { agentIncludesWorkBuddy, assertWorkBuddyAuthPlatform, inspectWorkBuddyPlugin, workBuddyMinimumVersion } from "../lib/workbuddy.js";
import { installEncryptedWikis, validateWikisDirectory } from "../lib/wikis-release.js";

const runtimeRepo = "lumi-ai-lab/harness-data";

async function requireCommands(commands) {
  for (const command of commands) {
    if (!(await commandExists(command))) throw new Error(`missing required command: ${command}`);
  }
  ok(commands.join(", "));
}

async function resolveTokenMode(options = {}) {
  if (options.githubAuth === true || options.githubAuth === false) return options.githubAuth;
  return hasGithubAuth(options);
}

export function validateInstallAuthOptions(options = {}) {
  const noAuth = options.noAuth === true;
  const dataAuth = options.dataAuth === true;
  const hasBlob = typeof options.authBlob === "string" && options.authBlob.trim() !== "";
  const hasUserID = typeof options.authUserId === "string" && options.authUserId.trim() !== "";
  const hasOffPassword = typeof options.authOffPassword === "string" && options.authOffPassword !== "";

  if (noAuth && (dataAuth || hasBlob || hasUserID)) {
    throw new Error("--no-auth cannot be combined with --data-auth, --auth-blob, or --auth-user-id");
  }
  if (dataAuth && (hasBlob || hasUserID)) {
    throw new Error("--data-auth cannot be combined with --auth-blob or --auth-user-id");
  }
  if (hasOffPassword && !noAuth) {
    throw new Error("--auth-off-password requires --no-auth");
  }
  if (hasBlob !== hasUserID) {
    throw new Error("--auth-blob and --auth-user-id must be provided together");
  }
}

export async function collectInstallAccess(options = {}, runtimeDir) {
  const tokenMode = await resolveTokenMode(options);
  const explicit = options.wikisSource ? path.resolve(options.wikisSource) : "";
  if (explicit) {
    validateWikisDirectory(explicit);
    return { tokenMode, wikisSource: explicit };
  }
  const auto = path.join(runtimeDir, "harness-data-wikis");
  if (fs.existsSync(auto)) {
    validateWikisDirectory(auto);
    return { tokenMode, wikisSource: auto };
  }
  return { tokenMode, wikisSource: "" };
}

function replaceRuntimePath(runtimeDir, name, stagedRoot, backups) {
  const target = path.join(runtimeDir, name);
  const backup = fs.mkdtempSync(path.join(runtimeDir, `.install-backup-${name}-`));
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  backups.push({ name, target, backup });
  fs.renameSync(path.join(stagedRoot, name), target);
}

function restoreRuntimeBackups(backups) {
  for (const item of backups.slice().reverse()) {
    fs.rmSync(item.target, { recursive: true, force: true });
    if (fs.existsSync(item.backup)) fs.renameSync(item.backup, item.target);
  }
}

function cleanupRuntimeBackups(backups) {
  for (const item of backups) fs.rmSync(item.backup, { recursive: true, force: true });
}

function mergeRuntimeConfig(runtimeDir, sourceDir) {
  const targetDir = path.join(runtimeDir, "config");
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of fs.readdirSync(sourceDir)) {
    const source = path.join(sourceDir, file);
    const target = path.join(targetDir, file);
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
      if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true });
      continue;
    }
    if (file.endsWith(".example") || !fs.existsSync(target)) fs.copyFileSync(source, target);
  }
}

export async function installRuntimeBundle(runtimeDir, options = {}) {
  if (!options.force && fs.existsSync(path.join(runtimeDir, "agents")) &&
      fs.existsSync(path.join(runtimeDir, "config")) &&
      fs.existsSync(path.join(runtimeDir, "bootstrap", "cli-manifest.json")) &&
      (!options.requireWorkBuddy || (
        fs.existsSync(path.join(runtimeDir, "agents", "workbuddy", ".codebuddy-plugin", "plugin.json")) &&
        fs.existsSync(path.join(runtimeDir, "agents", ".codebuddy-plugin", "marketplace.json"))
      ))) {
    skip("runtime bundle 已存在");
    return { tag: "", skipped: true };
  }

  const release = await latestRelease(runtimeRepo, options);
  const tag = release.tag_name;
  const assetName = `harness-data-runtime-${tag}.tar.gz`;
  const asset = findReleaseAsset(release, assetName);
  const shaAsset = findReleaseAsset(release, `${assetName}.sha256`);
  if (!asset) throw new Error(`runtime bundle asset missing in ${runtimeRepo} ${tag}: ${assetName}`);

  const cacheDir = path.join(runtimeDir, ".bootstrap-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, assetName);
  action(`下载 harness-data-runtime ${tag}`);
  await downloadReleaseAsset(asset, archive, { ...options, progressLabel: assetName });
  if (shaAsset) {
    const shaFile = `${archive}.sha256`;
    await downloadReleaseAsset(shaAsset, shaFile, options);
    const expected = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
    const crypto = await import("node:crypto");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (expected && actual !== expected) throw new Error("runtime bundle sha256 mismatch");
  } else {
    warn("runtime bundle 未提供 sha256，已继续安装");
  }

  const extractDir = fs.mkdtempSync(path.join(cacheDir, "runtime-"));
  const stagedRoot = fs.mkdtempSync(path.join(runtimeDir, ".install-new-runtime-"));
  const backups = [];
  try {
    // 在 Git Bash 中 tar 无法处理 Windows 绝对路径（E:\...），使用相对路径执行
    await run("tar", ["-xzf", path.relative(cacheDir, archive), "-C", path.relative(cacheDir, extractDir)], { cwd: cacheDir });
    for (const dir of ["agents", "bootstrap"]) if (!fs.existsSync(path.join(extractDir, dir))) throw new Error(`runtime bundle missing ${dir}/`);
    const configSource = path.join(extractDir, "config");
    if (!fs.existsSync(configSource)) throw new Error("runtime bundle missing config/");

    for (const dir of ["agents", "bootstrap"]) fs.cpSync(path.join(extractDir, dir), path.join(stagedRoot, dir), { recursive: true });
    // Recursive so config/fixtures (local-test auth blob) lands in the runtime.
    fs.cpSync(configSource, path.join(stagedRoot, "config"), { recursive: true });

    if (options.requireWorkBuddy) {
      const plugin = inspectWorkBuddyPlugin(stagedRoot);
      if (!plugin.prepared) throw new Error(`WorkBuddy plugin package is incomplete: ${plugin.errors.join("; ")}`);
      if (!plugin.versionMatchesPackage) throw new Error(`WorkBuddy plugin version ${plugin.version || "missing"} does not match installer ${packageVersion()}`);
    }

    for (const name of ["agents", "bootstrap"]) replaceRuntimePath(runtimeDir, name, stagedRoot, backups);
    mergeRuntimeConfig(runtimeDir, path.join(stagedRoot, "config"));
    cleanupRuntimeBackups(backups);
  } catch (error) {
    restoreRuntimeBackups(backups);
    throw error;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(stagedRoot, { recursive: true, force: true });
  }
  ok(`runtime bundle ${tag}`);
  return { tag, skipped: false };
}

async function promptExecutable(runtimeDir, name, options = {}) {
  const provided = options[`${name.replaceAll("-", "")}Path`] || options[`${name}Path`] || options.metricCliPath;
  if (provided) {
    const file = path.resolve(provided);
    if (!isExecutable(file)) throw new Error(`${name} path is missing or not executable: ${file}`);
    return file;
  }
  const auto = path.join(runtimeDir, "bin", binaryName(name));
  if (isExecutable(auto)) {
    ok(`自动识别 ${name}: ${auto}`);
    return auto;
  }
  const value = await ask(`请输入 ${name} 的绝对路径：`, options);
  const file = path.resolve(value);
  if (!isExecutable(file)) throw new Error(`${name} path is missing or not executable: ${file}`);
  return file;
}

async function installLocalTools(runtimeDir, options = {}) {
  const binDir = path.join(runtimeDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const installed = {};
  for (const name of localPathToolNames) {
    const source = await promptExecutable(runtimeDir, name, options);
    const target = path.join(binDir, binaryName(name));
    if (path.resolve(source) !== path.resolve(target)) {
      fs.copyFileSync(source, target);
      if (process.platform !== "win32") fs.chmodSync(target, 0o755);
    }
    installed[name] = { mode: "local-path", source };
  }
  return installed;
}

export async function installWikis(runtimeDir, tag, options = {}) {
  const target = path.join(runtimeDir, "wikis");
  if (options.wikisSource) {
    validateWikisDirectory(options.wikisSource);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(options.wikisSource, target, { recursive: true });
    ok(`harness-data-wikis 本地路径 ${options.wikisSource}`);
    return { source: "local-path", path: target };
  }
  if (!tag) throw new Error("cannot determine installed runtime tag for Wikis; rerun install with --force");
  if (fs.existsSync(path.join(target, ".git"))) warn("已有 Git Wikis 将迁移为与 Runtime tag 绑定的加密发布物，本地修改不会保留");
  const installed = await installEncryptedWikis(runtimeDir, tag, options);
  ok(`harness-data-wikis ${installed.tag}（Gitee 加密发布物）`);
  return installed;
}

function applyInstallAuth(runtimeDir, auth, selectedAgent) {
  if (auth.mode === "no-auth") {
    writeLocalConfig(runtimeDir, { overwrite: true, noAuth: true });
    ok("config/harness-config.yaml");
    ok("config/qdm-cli-paths.env");
    ok("authz.mode: off (密码已验证)");
    return;
  }
  if (auth.mode === "data-auth") {
    writeLocalConfig(runtimeDir, { overwrite: true, dataAuth: true });
    ok("config/harness-config.yaml");
    ok("config/qdm-cli-paths.env");
    const blob = ensureLocalAuthBlob(runtimeDir, { force: true });
    ok(blob.copied ? "authz.mode: on + local test blob (copied)" : "authz.mode: on + local test blob (kept existing)");
    if (agentIncludesWorkBuddy(selectedAgent)) ok("WorkBuddy macOS PreToolUse auth enabled (--data-auth)");
    return;
  }
  writeAuthBlob(runtimeDir, auth.blobContent);
  writeLocalConfig(runtimeDir, { overwrite: true, authBlob: true, devUserId: auth.devUserId });
  ok("config/harness-config.yaml");
  ok("config/qdm-cli-paths.env");
  ok("authz.mode: on + user-provided blob");
  ok(`dev_user_id: ${auth.devUserId}`);
  if (agentIncludesWorkBuddy(selectedAgent)) ok("WorkBuddy macOS PreToolUse auth enabled");
}

export const validateLocalWikisSource = validateWikisDirectory;

export async function buildAndCheck(runtimeDir, options = {}) {
  const cli = path.join(runtimeDir, "bin", binaryName("data-harness-cli"));
  action("执行：data-harness-cli wikis build-index --skip-checks");
  const result = await run(cli, ["wikis", "build-index", "--skip-checks"], { cwd: runtimeDir, allowFailure: true });
  if (result.code !== 0) {
    warn("wikis 索引构建失败，安装会继续；后续可手动执行 data-harness-cli wikis build-index --skip-checks");
    return { ok: false };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const docs = output.match(/\bdocs=(\d+)/)?.[1];
  const recall = output.match(/\brecall=(\d+)/)?.[1];
  const runtimeDocs = output.match(/\bruntimeDocs=(\d+)/)?.[1];
  ok([docs ? `docs=${docs}` : "", recall ? `recall=${recall}` : "", runtimeDocs ? `runtimeDocs=${runtimeDocs}` : ""].filter(Boolean).join(", ") || "Wikis 索引已构建");
  return { ok: true, docs, recall, runtimeDocs };
}

export function printDoctorSummary(doctor, options = {}) {
  const nonBlocking = options.nonBlocking || (() => false);
  const failed = doctor.checks.filter((check) => !check.ok && !nonBlocking(check));
  const warnings = doctor.checks.filter((check) => (!check.ok && nonBlocking(check)) || check.status === "warning");
  if (!failed.length) {
    ok("runtime");
    ok("wikis/metrics");
    ok("wikis/reports");
    ok("wikis/dims");
    ok("wikis/rules");
    ok("2 个 CLI（data-harness / metric）");
    ok("本地配置");
    ok("唯一数据入口 qdm-metric-cli");
    if (!warnings.some((check) => check.name.startsWith("Agent hook"))) ok("Agent Hook");
    for (const check of warnings) warn(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    return;
  }
  for (const check of warnings) warn(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  for (const check of failed) fail(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
}

export async function installCommand(options = {}) {
  validateInstallAuthOptions(options);
  const key = platformKey();
  const targetRuntimeDir = resolveWorkspaceDir(options.dir || process.cwd());
  header("Harness Data 安装器", packageVersion(), [
    `安装目录：${targetRuntimeDir}`,
    `平台：${key}`
  ]);

  const selectedAgent = await chooseAgent(options);
  assertCodexAuthPlatform(selectedAgent, !options.noAuth, options.platform || process.platform);
  assertWorkBuddyAuthPlatform(selectedAgent, !options.noAuth, options.platform || process.platform);

  step(1, 7, "授权与访问预检");
  await requireCommands(key.startsWith("windows-") ? ["git", "tar", "unzip"] : ["git", "tar"]);
  const auth = await collectInstallAuth(options);
  const access = await collectInstallAccess(options, targetRuntimeDir);
  ok("授权材料已校验");
  blank();

  const session = createInstallSession(targetRuntimeDir);
  const priorState = readWorkspaceState(targetRuntimeDir);
  try {
    session.begin();
    const runtimeDir = targetRuntimeDir;

    step(2, 7, "安装 runtime bundle");
    const bundle = await installRuntimeBundle(runtimeDir, { ...options, requireWorkBuddy: agentIncludesWorkBuddy(selectedAgent) });
    blank();

    step(3, 7, "安装 CLI 工具");
    const manifestPath = path.resolve(options.manifest || path.join(runtimeDir, "bootstrap", "cli-manifest.json"));
    const tokenMode = access.tokenMode;
    const installState = readWorkspaceState(runtimeDir);

    let manifest;
    let localTools = {};
    manifest = readManifest(manifestPath);
    const latestManifest = await resolveLatestManifest(manifest, key, {
      ...options,
      ...(options.metricCliPath ? { tools: ["data-harness-cli"] } : {})
    });
    manifest = await installToolsFromManifest(runtimeDir, manifestPath, { ...options, state: installState, manifestOverride: latestManifest });
    if (options.metricCliPath) localTools = await installLocalTools(runtimeDir, options);
    ok(`${Object.keys(manifest.installedTools || {}).length + Object.keys(localTools).length} 个 CLI 已安装到 bin/`);
    const removedLegacy = removeLegacyDataCLIs(runtimeDir);
    for (const name of removedLegacy) action(`移除遗留数据 CLI：bin/${name}`);
    blank();

    step(4, 7, "同步 Wikis 知识库");
    const wikis = await installWikis(runtimeDir, bundle.tag || priorState.runtimeTag, { ...options, wikisSource: access.wikisSource });
    blank();

    step(5, 7, "生成本地配置");
    applyInstallAuth(runtimeDir, auth, selectedAgent);
    blank();

    step(6, 7, "构建 Wikis 索引");
    await buildAndCheck(runtimeDir, options);
    blank();

    step(7, 7, "配置 Agent Hook");
    const linkedAgents = linkAgents(runtimeDir, selectedAgent);
    for (const [source, target] of linkedAgents) {
      if (fs.existsSync(path.join(runtimeDir, target))) ok(`${target} -> ${source}`);
    }
    patchCodexHooksForWindows(runtimeDir);
    if (agentIncludesWorkBuddy(selectedAgent)) {
      const plugin = inspectWorkBuddyPlugin(runtimeDir);
      if (!plugin.prepared) throw new Error(`WorkBuddy plugin package is incomplete: ${plugin.errors.join("; ")}`);
      if (!plugin.versionMatchesPackage) {
        throw new Error(`WorkBuddy plugin version ${plugin.version || "missing"} does not match installer ${packageVersion()}; update the runtime bundle`);
      }
      ok(`WorkBuddy Marketplace prepared: ${path.relative(runtimeDir, plugin.marketplaceRoot)}`);
      action(`需要 WorkBuddy ${workBuddyMinimumVersion}+；在插件管理中 Add Marketplace：${plugin.marketplaceRoot}`);
      action(`安装并启用 qdm-harness@${plugin.marketplaceName}，reload plugins 后在 Harness runtime workspace 中新建会话`);
    }
    blank();

    console.log("安装校验");
    const doctor = await collectDoctor(runtimeDir, { ...options, agent: selectedAgent });
    printDoctorSummary(doctor);
    if (doctor.checks.some((check) => !check.ok)) throw new Error("doctor failed; install is incomplete");
    blank();

    writeState(runtimeDir, {
      installMode: options.metricCliPath ? "local-path" : "gitee-public",
      runtimeTag: bundle.tag || priorState.runtimeTag,
      wikis,
      localTools,
      tools: manifest.installedTools || {},
      manifestSha256: manifestDigest(manifest),
      packageVersion: packageVersion(),
      agent: selectedAgent,
      lastCheckAt: new Date().toISOString()
    });
    session.commit();
    console.log(`安装完成：${runtimeDir}`);
    console.log("");
    console.log("下一步：");
    console.log(`cd ${runtimeDir}`);
  } catch (error) {
    session.rollback();
    warn("安装失败，已回滚本次写入");
    throw error;
  }
}
