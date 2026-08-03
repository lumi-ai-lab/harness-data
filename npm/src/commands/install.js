import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { commandExists, run } from "../lib/exec.js";
import {
  localPathToolNamesForProfile,
  migrateLegacyLocalAgentInstructions,
  writeLocalConfig,
  linkAgents
} from "../lib/config.js";
import { verifyApprovedWikisSource } from "../lib/approved-wikis.js";
import { ask, askSecret, chooseAgent } from "../lib/prompt.js";
import { readInstallerState, readUserState, resolveWorkspaceDir, writeState } from "../lib/paths.js";
import { installToolsFromManifest, manifestDigest, readManifest, toolDestination } from "../lib/manifest.js";
import { forceSyncWikis } from "../lib/wikis-git.js";
import { binaryName, platformKey } from "../lib/platform.js";
import { resolveLatestManifest } from "../lib/tool-release.js";
import { collectDoctor } from "./doctor.js";
import { packageVersion } from "../lib/package.js";
import { downloadReleaseAsset, findReleaseAsset, githubToken, hasGithubAuth, latestRelease } from "../lib/github.js";
import { action, blank, fail, header, ok, shortSha, skip, step, warn } from "../lib/log.js";
import { gitUrls, runGitWithProtocol } from "../lib/git-auth.js";
import {
  authzConfigPathFor,
  installerStateSchemaVersion,
  lumiApprovedWikisArtifact,
  lumiCatalogArtifact,
  localUnrestrictedProfile,
  lumiReleaseSet,
  lumiRequiredProfile,
  normalizeProfile,
  profileFromState,
  selectManifestProfile,
  validateProfileAgent
} from "../lib/profile.js";

const runtimeRepo = "lumi-ai-lab/harness-data";
const wikisRepo = "lumi-ai-lab/harness-data-wikis";
const localMetricRepo = "pengmide/qdm-metric-cli";

function readInstallState(runtimeDir) {
  const local = readInstallerState(runtimeDir);
  return Object.keys(local).length ? local : readUserState();
}

async function requireCommands(commands) {
  for (const command of commands) {
    if (!(await commandExists(command))) throw new Error(`missing required command: ${command}`);
  }
  ok(commands.join(", "));
}

async function prepareRuntimeDir(options) {
  const runtimeDir = resolveWorkspaceDir(options.dir || process.cwd());
  fs.mkdirSync(runtimeDir, { recursive: true });
  return runtimeDir;
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
      fs.existsSync(path.join(runtimeDir, "bootstrap", "cli-manifest.json"))) {
    skip("runtime bundle 已存在");
    return { tag: String(options.runtimeTag || ""), skipped: true };
  }

  const cacheDir = path.join(runtimeDir, ".bootstrap-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  let tag = "";
  let archive = "";
  if (options.runtimeBundle) {
    tag = String(options.runtimeTag || "").trim();
    if (!tag) throw new Error("a local runtime bundle requires --runtime-tag");
    const source = path.resolve(options.runtimeBundle);
    const info = fs.lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`local runtime bundle is not a regular file: ${source}`);
    archive = path.join(cacheDir, path.basename(source));
    if (path.resolve(source) !== path.resolve(archive)) fs.copyFileSync(source, archive);
    const shaFile = `${source}.sha256`;
    if (!fs.existsSync(shaFile)) throw new Error(`local runtime bundle checksum is missing: ${shaFile}`);
    const expected = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
    const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error("local runtime bundle sha256 mismatch");
    action(`使用本地 harness-data-runtime ${tag}`);
  } else {
    const release = await latestRelease(runtimeRepo, options);
    tag = release.tag_name;
    const assetName = `harness-data-runtime-${tag}.tar.gz`;
    const asset = findReleaseAsset(release, assetName);
    const shaAsset = findReleaseAsset(release, `${assetName}.sha256`);
    if (!asset) throw new Error(`runtime bundle asset missing in ${runtimeRepo} ${tag}: ${assetName}`);
    archive = path.join(cacheDir, assetName);
    action(`下载 harness-data-runtime ${tag}`);
    await downloadReleaseAsset(asset, archive, { ...options, progressLabel: assetName });
    if (shaAsset) {
      const shaFile = `${archive}.sha256`;
      await downloadReleaseAsset(shaAsset, shaFile, options);
      const expected = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
      const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
      if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("runtime bundle sha256 is invalid");
      if (actual !== expected) throw new Error("runtime bundle sha256 mismatch");
    } else if (options.profile === lumiRequiredProfile || options.requireChecksum === true) {
      throw new Error("lumi-mvp-required runtime bundle checksum is missing");
    } else {
      warn("runtime bundle 未提供 sha256，已继续安装");
    }
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
    fs.mkdirSync(path.join(stagedRoot, "config"), { recursive: true });
    for (const file of fs.readdirSync(configSource)) fs.copyFileSync(path.join(configSource, file), path.join(stagedRoot, "config", file));

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

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function promptExecutable(runtimeDir, name, options = {}) {
  const auto = path.join(runtimeDir, "bin", binaryName(name));
  const explicit = name === "qdm-metric-cli" ? options.metricCliPath : "";
  if (explicit) {
    const file = path.resolve(explicit);
    if (!executable(file)) throw new Error(`${name} path is missing or not executable: ${file}`);
    return file;
  }
  if (executable(auto)) {
    ok(`自动识别 ${name}: ${auto}`);
    return auto;
  }
  const value = await ask(`请输入 ${name} 的绝对路径：`, options);
  const file = path.resolve(value);
  if (!executable(file)) throw new Error(`${name} path is missing or not executable: ${file}`);
  return file;
}

async function installLocalTools(runtimeDir, profile, options = {}) {
  const binDir = path.join(runtimeDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const installed = {};
  for (const name of localPathToolNamesForProfile(profile, options)) {
    const source = await promptExecutable(runtimeDir, name, options);
    const target = path.join(binDir, binaryName(name));
    if (path.resolve(source) !== path.resolve(target)) {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o755);
    }
    installed[name] = { mode: "local-path", source };
  }
  return installed;
}

async function installWikis(runtimeDir, profile, manifest, options = {}) {
  const target = path.join(runtimeDir, "wikis");
  if (profile === lumiRequiredProfile) {
    if (!options.wikisSource) {
      throw new Error("lumi-mvp-required installation requires explicit --wikis-source for business-approved content");
    }
    const approved = lumiApprovedWikisArtifact(manifest);
    const approvalManifest = path.resolve(runtimeDir, approved.manifest);
    const expectedManifest = path.join(path.resolve(runtimeDir), "bootstrap", "approved-lumi-wikis-manifest.json");
    if (approvalManifest !== expectedManifest) throw new Error("approved Wikis manifest escapes the runtime bundle");
    const verified = verifyApprovedWikisSource(options.wikisSource, approvalManifest, approved.manifestSha256);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(verified.source, target, { recursive: true });
    ok(`已安装业务批准的 Lumi Wikis 内容 ${approved.manifestSha256.slice(0, 12)}`);
    return { mode: "approved-release-content", source: verified.source, path: target };
  }
  if (options.wikisSource) {
    const source = path.resolve(options.wikisSource);
    validateLocalWikisSource(source);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
    ok(`harness-data-wikis 构建输入 ${source}`);
    return { mode: "release-build-input", source, path: target };
  }
  if (githubToken(options)) {
    if (fs.existsSync(path.join(target, ".git"))) {
      warn("已有 Wikis 仓库将以远程版本强制同步，本地修改不会保留");
      await forceSyncWikis(target, options);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
      await runGitWithProtocol("https", ["clone", gitUrls.https.wikis, target], options);
    }
    const commit = (await run("git", ["-C", target, "rev-parse", "HEAD"])).stdout.trim();
    ok(`harness-data-wikis ${shortSha(commit)}`);
    return { mode: "github", path: target, commit };
  }
  if (await hasGithubAuth(options)) {
    if (fs.existsSync(path.join(target, ".git"))) {
      warn("已有 Wikis 仓库将以远程版本强制同步，本地修改不会保留");
      await forceSyncWikis(target, options);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
      await run("gh", ["repo", "clone", wikisRepo, target]);
    }
    const commit = (await run("git", ["-C", target, "rev-parse", "HEAD"])).stdout.trim();
    ok(`harness-data-wikis ${shortSha(commit)}`);
    return { mode: "github", path: target, commit };
  }

  const auto = path.join(runtimeDir, "harness-data-wikis");
  const source = fs.existsSync(auto) ? auto : path.resolve(await ask("请输入 harness-data-wikis 的绝对路径：", options));
  validateLocalWikisSource(source);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  ok(`harness-data-wikis 本地路径 ${source}`);
  return { mode: "local-path", source, path: target };
}

export function validateLocalWikisSource(source) {
  if (!fs.existsSync(path.join(source, "index.md"))) throw new Error(`harness-data-wikis missing index.md: ${source}`);
  for (const dir of ["metrics", "reports", "dims", "rules"]) {
    if (!fs.existsSync(path.join(source, dir))) throw new Error(`harness-data-wikis missing ${dir}/: ${source}`);
  }
}

function casConfigDir(runtimeDir) {
  return path.join(runtimeDir, ".qdm-auth", "cas");
}

export async function writeCasCredentials(runtimeDir, options = {}) {
  const username = options.casUsername || await ask("CAS 用户名：", options);
  const password = options.casPassword || await askSecret("CAS 密码：", options);
  if (!username || !password) throw new Error("CAS username and password are required");
  const dir = options.casConfigDir || casConfigDir(runtimeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = { QDM_CAS_CONFIG_DIR: dir };
  await run(path.join(runtimeDir, "bin", binaryName("cas-cli")), ["config", "set-credentials", "--username", username, "--password", password], {
    cwd: runtimeDir,
    env,
    sensitiveArgs: [5]
  });
  ok("CAS 凭证已加密保存");
  return dir;
}

function isCasAuthenticationFailure(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid credentials?|bad credentials?|认证.{0,8}(失败|不通过)|账号.{0,8}密码|<!doctype html|<html[\s>]/i.test(message);
}

function sanitizedCasError(error) {
  if (isCasAuthenticationFailure(error)) return new Error("CAS 账号或密码验证不通过");
  const message = String(error?.message || error || "CAS 认证失败");
  if (/<(!doctype|html)[\s>]/i.test(message)) return new Error("CAS 服务返回了异常页面，请稍后重试");
  return error instanceof Error ? error : new Error(message);
}

async function validateCasCredentials(runtimeDir, casDir) {
  const env = { QDM_CAS_CONFIG_DIR: casDir };
  const command = path.join(runtimeDir, "bin", binaryName("cas-cli"));
  await run(command, ["token", "--app", "cmr"], { cwd: runtimeDir, env });
}

function activateCasCredentials(stagedDir, targetDir) {
  const backupDir = `${targetDir}.backup-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(targetDir), { recursive: true, mode: 0o700 });
  try {
    if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backupDir);
    fs.renameSync(stagedDir, targetDir);
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    if (fs.existsSync(backupDir)) fs.renameSync(backupDir, targetDir);
    throw error;
  }
}

export async function configureCasAuthentication(runtimeDir, options = {}) {
  const targetDir = casConfigDir(runtimeDir);
  const promptUsername = options.askUsername || ask;
  const promptPassword = options.askPassword || askSecret;
  const suppliedCredentials = Boolean(options.casUsername || options.casPassword || options.yes);
  const maxAttempts = suppliedCredentials ? 1 : Number(options.casMaxAttempts || 3);
  let previousUsername = String(options.casUsername || "").trim();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const usernameAnswer = options.casUsername || await promptUsername(previousUsername ? `CAS 用户名 [${previousUsername}]：` : "CAS 用户名：", options);
    const username = String(usernameAnswer || previousUsername).trim();
    const password = options.casPassword || await promptPassword("CAS 密码：", options);
    previousUsername = username;
    if (!username || !password) {
      warn("CAS 用户名和密码不能为空");
      if (attempt < maxAttempts) continue;
      throw new Error("CAS username and password are required");
    }

    const stagedDir = fs.mkdtempSync(path.join(runtimeDir, ".cas-auth-"));
    try {
      await writeCasCredentials(runtimeDir, { ...options, casUsername: username, casPassword: password, casConfigDir: stagedDir });
      action("正在验证 CAS 账号……");
      await validateCasCredentials(runtimeDir, stagedDir);
      activateCasCredentials(stagedDir, targetDir);
      ok("CAS 认证成功");
      return targetDir;
    } catch (error) {
      fs.rmSync(stagedDir, { recursive: true, force: true });
      const cleanError = sanitizedCasError(error);
      if (!isCasAuthenticationFailure(error) || attempt >= maxAttempts) throw cleanError;
      warn(`${cleanError.message}，请重新输入`);
    }
  }

  throw new Error("CAS 认证失败");
}

export async function configureTokens(runtimeDir, casDir) {
  const env = { QDM_CAS_CONFIG_DIR: casDir };
  const bin = (name) => path.join(runtimeDir, "bin", binaryName(name));
  const cmrToken = (await run(bin("cas-cli"), ["token", "--app", "cmr"], { cwd: runtimeDir, env })).stdout.trim();
  await run(bin("qdm-cmr-cli"), ["config", "set-token", cmrToken], { cwd: runtimeDir, env, sensitiveArgs: [2] });
  ok("CMR Token 已配置");
  const indicatorsToken = (await run(bin("cas-cli"), ["token", "--app", "indicators"], { cwd: runtimeDir, env })).stdout.trim();
  await run(bin("qdm-indicators-cli"), ["config", "set-token", indicatorsToken], { cwd: runtimeDir, env, sensitiveArgs: [2] });
  ok("Indicators Token 已配置");
  const sqlToken = (await run(bin("cas-cli"), ["token", "--app", "rtp"], { cwd: runtimeDir, env })).stdout.trim();
  await run(bin("qdm-sql-cli"), ["config", "set-token", sqlToken], { cwd: runtimeDir, env, sensitiveArgs: [2] });
  ok("SQL Token 已配置");
  await run(bin("qdm-cmr-cli"), ["config", "check-token"], { cwd: runtimeDir, env });
  await run(bin("qdm-indicators-cli"), ["config", "check-token"], { cwd: runtimeDir, env });
  await run(bin("qdm-sql-cli"), ["config", "check-token"], { cwd: runtimeDir, env });
}

export async function buildAndCheck(runtimeDir, options = {}) {
  const cli = path.join(runtimeDir, "bin", binaryName("data-harness-cli"));
  action("执行：data-harness-cli wikis build-index --skip-checks");
  const result = await run(cli, ["wikis", "build-index", "--skip-checks"], { cwd: runtimeDir, allowFailure: true });
  if (result.code !== 0) {
    if (options.requiredIndexes) {
      throw new Error("wikis index build failed");
    }
    warn("wikis 索引构建失败，安装会继续；后续可手动执行 data-harness-cli wikis build-index --skip-checks");
    return { ok: false };
  }
  const requiredIndexes = [
    path.join(runtimeDir, ".harness", "index", "wikis-index.json"),
    path.join(runtimeDir, ".harness", "index", "wikis-runtime-index.json")
  ];
  const missingIndexes = requiredIndexes.filter((file) => {
    try {
      return !fs.statSync(file).isFile() || fs.statSync(file).size === 0;
    } catch {
      return true;
    }
  });
  if (options.requiredIndexes && missingIndexes.length) {
    throw new Error(`wikis index build did not produce required indexes: ${missingIndexes.map((file) => path.basename(file)).join(", ")}`);
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
  const warnings = doctor.checks.filter((check) => !check.ok && nonBlocking(check));
  if (!failed.length) {
    if (doctor.profile === lumiRequiredProfile) {
      ok("lumi-mvp-required profile 与 installer-state v3");
      ok("2 个 Agent 可见 CLI（data-harness-cli 与 Indicators Facade）");
      ok("固定真实 Indicators CLI 与 release-set");
      ok("Lumi 配置（未暴露 CMR/SQL/CAS）");
      ok("Pi Agent Hook");
      for (const check of warnings) warn(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
      return;
    }
    ok("runtime");
    ok("wikis/metrics");
    ok("wikis/reports");
    ok("wikis/dims");
    ok("wikis/rules");
    ok("2 个 CLI");
    ok("本地配置");
    if (!warnings.some((check) => check.name.startsWith("Agent hook"))) ok("Agent Hook");
    for (const check of warnings) warn(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    return;
  }
  for (const check of warnings) warn(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  for (const check of failed) fail(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
}

export function validateLumiManifestReleaseSet(runtimeDir, manifest, releaseSet) {
  const helper = manifest.tools?.find((tool) => tool.name === "data-harness-cli");
  const facade = manifest.tools?.find((tool) => tool.name === "qdm-indicators-facade");
  const real = manifest.tools?.find((tool) => tool.name === "qdm-indicators-cli-real");
  if (!helper || !facade || !real) throw new Error("lumi-mvp-required manifest must include all Harness authorization artifacts");
  if (helper.tracking !== "fixed" || facade.tracking !== "fixed" || real.tracking !== "fixed") {
    throw new Error("lumi-mvp-required authorization artifacts must use fixed tracking");
  }
  const helperBinarySha256 = helper.platforms?.[platformKey()]?.binarySha256;
  if (!String(helper.version || "").trim() || !/^[a-f0-9]{64}$/.test(String(helperBinarySha256 || ""))) {
    throw new Error("Harness helper version and binary sha256 must be fixed");
  }
  if (facade.version !== releaseSet.facadeVersion) {
    throw new Error(`Facade version ${facade.version || "missing"} does not match release-set ${releaseSet.facadeVersion}`);
  }
  if (real.version !== releaseSet.realIndicatorsVersion) {
    throw new Error(`real Indicators CLI version ${real.version || "missing"} does not match release-set ${releaseSet.realIndicatorsVersion}`);
  }
  const lumiPlatformKey = platformKey();
  const facadeBinarySha256 = String(facade.platforms?.[lumiPlatformKey]?.binarySha256 || "");
  if (!/^[a-f0-9]{64}$/.test(facadeBinarySha256)) {
    throw new Error(`Facade binary sha256 is not fixed for ${lumiPlatformKey}`);
  }
  const realBinarySha256 = String(real.platforms?.[lumiPlatformKey]?.binarySha256 || "");
  if (!/^[a-f0-9]{64}$/.test(realBinarySha256)) {
    throw new Error(`real Indicators CLI binary sha256 is not fixed for ${lumiPlatformKey}`);
  }
  const publicFacade = path.join(runtimeDir, "bin", binaryName("qdm-indicators-cli"));
  const publicHelper = path.join(runtimeDir, "bin", binaryName("data-harness-cli"));
  if (path.resolve(toolDestination(runtimeDir, helper)) !== path.resolve(publicHelper)) {
    throw new Error(`Harness helper destination must be ${publicHelper}`);
  }
  if (path.resolve(toolDestination(runtimeDir, facade)) !== path.resolve(publicFacade)) {
    throw new Error(`Facade destination must be ${publicFacade}`);
  }
  if (!path.isAbsolute(String(real.destination || ""))) {
    throw new Error("real Indicators CLI destination must be an absolute private path");
  }
}

export function verifyLumiInstalledReleaseSet(installedTools, releaseSet, manifest = null) {
  const facade = installedTools?.["qdm-indicators-facade"];
  const real = installedTools?.["qdm-indicators-cli-real"];
  if (!facade || !real) throw new Error("lumi-mvp-required installation is missing fixed Indicators artifacts");
  if (facade.version !== releaseSet.facadeVersion) {
    throw new Error(`installed Facade version ${facade.version || "missing"} does not match release-set ${releaseSet.facadeVersion}`);
  }
  if (real.version !== releaseSet.realIndicatorsVersion) {
    throw new Error(`installed real Indicators CLI version ${real.version || "missing"} does not match release-set ${releaseSet.realIndicatorsVersion}`);
  }
  if (manifest) {
    const key = platformKey();
    const facadeTool = manifest.tools?.find((tool) => tool.name === "qdm-indicators-facade");
    const realTool = manifest.tools?.find((tool) => tool.name === "qdm-indicators-cli-real");
    const helperTool = manifest.tools?.find((tool) => tool.name === "data-harness-cli");
    const helper = installedTools?.["data-harness-cli"];
    const facadeBinarySha256 = facadeTool?.platforms?.[key]?.binarySha256;
    const realBinarySha256 = realTool?.platforms?.[key]?.binarySha256;
    const helperBinarySha256 = helperTool?.platforms?.[key]?.binarySha256;
    if (!/^[a-f0-9]{64}$/.test(String(facadeBinarySha256 || ""))) {
      throw new Error(`manifest is missing Facade binary sha256 for ${key}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(realBinarySha256 || ""))) {
      throw new Error(`manifest is missing real Indicators CLI binary sha256 for ${key}`);
    }
    if (facade.sha256 !== facadeBinarySha256) {
      throw new Error(`installed Facade sha256 does not match manifest for ${key}`);
    }
    if (real.sha256 !== realBinarySha256) {
      throw new Error(`installed real Indicators CLI sha256 does not match manifest for ${key}`);
    }
    if (!helper || helper.version !== helperTool?.version || helper.sha256 !== helperBinarySha256) {
      throw new Error("installed Harness helper does not match its fixed manifest contract");
    }
  } else {
    if (real.sha256 !== releaseSet.realIndicatorsSha256) {
      throw new Error("installed real Indicators CLI sha256 does not match release-set");
    }
    if (facade.sha256 !== releaseSet.facadeSha256) {
      throw new Error("installed Facade sha256 does not match release-set");
    }
  }
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function installLumiCatalog(runtimeDir, manifest) {
  const catalog = lumiCatalogArtifact(manifest);
  const source = path.resolve(runtimeDir, catalog.source);
  const expectedSource = path.join(path.resolve(runtimeDir), "bootstrap", "approved-indicators-v1.json");
  if (source !== expectedSource) throw new Error("approved indicator catalog source escapes the runtime bundle");
  let sourceInfo;
  try {
    sourceInfo = fs.lstatSync(source);
  } catch {
    throw new Error(`business-approved indicator catalog is missing from the runtime bundle: ${source}`);
  }
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size <= 0 || sourceInfo.size > 4 * 1024 * 1024) {
    throw new Error("business-approved indicator catalog is not a safe regular file");
  }
  if (fileSha256(source) !== catalog.sha256) {
    throw new Error("business-approved indicator catalog sha256 does not match release-set");
  }
  const destination = catalog.destination;
  if (fs.existsSync(destination)) {
    const destinationInfo = fs.lstatSync(destination);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || fileSha256(destination) !== catalog.sha256) {
      throw new Error(`approved indicator catalog destination already contains a different artifact: ${destination}`);
    }
    fs.chmodSync(destination, 0o644);
    return destination;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  const staged = `${destination}.install-${process.pid}`;
  try {
    fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(staged, 0o644);
    fs.renameSync(staged, destination);
  } finally {
    fs.rmSync(staged, { force: true });
  }
  return destination;
}

function releaseArchiveForPlatform(asset, platform) {
  if (String(asset?.archive || "").trim()) return asset.archive;
  return platform.startsWith("windows-") ? "zip" : "tar.gz";
}

export function localUnrestrictedReleaseManifest(manifest, options = {}) {
  const selected = selectManifestProfile(manifest, localUnrestrictedProfile);
  const helper = selected.tools.find((tool) => tool.name === "data-harness-cli");
  if (!helper) throw new Error("local-unrestricted manifest is missing data-harness-cli");
  if (String(options.metricCliPath || "").trim()) {
    return { ...selected, tools: [helper] };
  }

  const platformSource = helper.platforms || {};
  const platforms = Object.fromEntries(
    Object.entries(platformSource).map(([platform, asset]) => [
      platform,
      { archive: releaseArchiveForPlatform(asset, platform) }
    ])
  );
  if (Object.keys(platforms).length === 0) {
    throw new Error("local-unrestricted manifest does not declare Metric CLI platforms");
  }

  return {
    ...selected,
    tools: [
      helper,
      {
        name: "qdm-metric-cli",
        binary: "qdm-metric-cli",
        repo: localMetricRepo,
        destination: "bin/qdm-metric-cli",
        tracking: "latest",
        requireAssetSha256: true,
        cleanupArchive: true,
        platforms
      }
    ]
  };
}

export function removeLegacyLocalTools(runtimeDir) {
  const removed = [];
  for (const name of ["qdm-cmr-cli", "qdm-indicators-cli", "qdm-sql-cli", "cas-cli"]) {
    const destination = path.join(runtimeDir, "bin", binaryName(name));
    if (!fs.existsSync(destination)) continue;
    fs.rmSync(destination, { force: true });
    removed.push(name);
  }
  return removed;
}

export async function installCommand(options = {}) {
  const explicitProfile = String(options.profile || "").trim();
  if (!explicitProfile && (options.yes || !process.stdin.isTTY)) {
    throw new Error("non-interactive installation requires explicit --profile local-unrestricted or lumi-mvp-required");
  }
  const profile = normalizeProfile(options.profile);
  if (profile === lumiRequiredProfile && String(options.profile || "") !== lumiRequiredProfile) {
    throw new Error("Lumi installation must explicitly pass --profile lumi-mvp-required");
  }
  if (profile === lumiRequiredProfile && !options.agent) {
    throw new Error("lumi-mvp-required profile requires explicit --agent pi");
  }
  const selectedAgent = profile === lumiRequiredProfile
    ? String(options.agent).trim().toLowerCase()
    : await chooseAgent(options);
  validateProfileAgent(profile, selectedAgent);
  if (profile === lumiRequiredProfile && !options.wikisSource) {
    throw new Error("lumi-mvp-required installation requires explicit --wikis-source for business-approved content");
  }
  const requestedRuntimeDir = resolveWorkspaceDir(options.dir || process.cwd());
  const existingState = readInstallerState(requestedRuntimeDir);
  if (Object.keys(existingState).length > 0) {
    const existingProfile = profileFromState(existingState);
    if (!existingProfile) {
      throw new Error("existing installer profile is ambiguous; rebuild the runtime in a fresh directory");
    }
    if (existingProfile !== profile) {
      throw new Error(`cannot change installer profile from ${existingProfile} to ${profile}; rebuild the runtime in a fresh directory`);
    }
    if (profile === lumiRequiredProfile) {
      throw new Error("lumi-mvp-required runtimes are immutable; rebuild the image in a fresh directory");
    }
  }
  const key = platformKey();
  const installOptions = {
    ...options,
    profile,
    runtimeTag: options.runtimeTag || existingState.runtimeTag || ""
  };
  header("Harness Data 安装器", packageVersion(), [
    `安装目录：${requestedRuntimeDir}`,
    `平台：${key}`,
    `Profile：${profile}`
  ]);

  step(1, 7, "检查本机依赖");
  await requireCommands(key.startsWith("windows-") ? ["git", "tar", "unzip"] : ["git", "tar"]);
  blank();

  step(2, 7, "安装 runtime bundle");
  const runtimeDir = await prepareRuntimeDir(options);
  const bundle = await installRuntimeBundle(runtimeDir, installOptions);
  if (profile === localUnrestrictedProfile) {
    for (const file of migrateLegacyLocalAgentInstructions(runtimeDir)) {
      action(`更新旧版 Agent 指令：${file}`);
    }
  }
  blank();

  step(3, 7, "安装 CLI 工具");
  const manifestPath = path.resolve(options.manifest || path.join(runtimeDir, "bootstrap", "cli-manifest.json"));
  const tokenMode = await hasGithubAuth(options);
  const installState = profile === lumiRequiredProfile ? readInstallerState(runtimeDir) : readInstallState(runtimeDir);
  const sourceManifest = readManifest(manifestPath);
  const selectedManifest = profile === localUnrestrictedProfile
    ? localUnrestrictedReleaseManifest(sourceManifest, options)
    : selectManifestProfile(sourceManifest, profile);
  if (profile === localUnrestrictedProfile) {
    for (const name of removeLegacyLocalTools(runtimeDir)) action(`移除旧版 CLI：${name}`);
    fs.rmSync(path.join(runtimeDir, ".qdm-auth"), { recursive: true, force: true });
  }
  const releaseSet = profile === lumiRequiredProfile ? lumiReleaseSet(sourceManifest) : null;
  const authzConfigPath = authzConfigPathFor(sourceManifest, profile);
  if (profile === lumiRequiredProfile) validateLumiManifestReleaseSet(runtimeDir, selectedManifest, releaseSet);

  let manifest;
  let localTools = {};
  if (profile === lumiRequiredProfile) {
    if (!tokenMode) throw new Error("lumi-mvp-required profile requires authenticated access to fixed release artifacts");
    manifest = await installToolsFromManifest(runtimeDir, manifestPath, {
      ...options,
      state: installState,
      manifestOverride: selectedManifest
    });
    verifyLumiInstalledReleaseSet(manifest.installedTools, releaseSet, selectedManifest);
    installLumiCatalog(runtimeDir, sourceManifest);
  } else {
    const latestManifest = await resolveLatestManifest(selectedManifest, key, {
      ...options,
      tools: selectedManifest.tools.map((tool) => tool.name)
    });
    manifest = await installToolsFromManifest(runtimeDir, manifestPath, { ...options, state: installState, manifestOverride: latestManifest });
    localTools = await installLocalTools(runtimeDir, profile, options);
  }
  ok(`${Object.keys(manifest.installedTools || {}).length + Object.keys(localTools).length} 个 CLI 已按 ${profile} profile 安装`);
  blank();
  const installedManifestSha256 = profile === lumiRequiredProfile
    ? fileSha256(manifestPath)
    : manifestDigest(manifest);

  // 及时持久化 CLI 安装状态，后续步骤失败时重新安装可跳过已下载的 CLI
  writeState(runtimeDir, {
    schemaVersion: installerStateSchemaVersion,
    profile,
    agent: selectedAgent,
    installMode: tokenMode ? "github-token" : "local-path",
    runtimeTag: bundle.tag,
    localTools,
    tools: manifest.installedTools || {},
    manifestSha256: installedManifestSha256,
    packageVersion: packageVersion(),
    releaseSet,
    authzConfigPath
  });
  blank();

  step(4, 7, "同步 Wikis 知识库");
  await installWikis(runtimeDir, profile, sourceManifest, options);
  blank();

  step(5, 7, "生成本地配置");
  writeLocalConfig(runtimeDir, { overwrite: true, profile });
  ok("config/harness-config.yaml");
  ok("config/qdm-cli-paths.env");
  blank();

  step(6, 7, "构建 Wikis 索引");
  await buildAndCheck(runtimeDir, { ...options, requiredIndexes: true });
  blank();

  step(7, 7, "配置 Agent Hook");
  const linkedAgents = linkAgents(runtimeDir, selectedAgent);
  for (const [source, target] of linkedAgents) {
    if (fs.existsSync(path.join(runtimeDir, target))) ok(`${target} -> ${source}`);
  }
  blank();

  console.log("安装校验");
  const doctor = await collectDoctor(runtimeDir, { ...options, buildTime: profile === lumiRequiredProfile });
  printDoctorSummary(doctor);
  if (doctor.checks.some((check) => !check.ok)) throw new Error("doctor failed; install is incomplete");
  blank();

  writeState(runtimeDir, {
    schemaVersion: installerStateSchemaVersion,
    profile,
    installMode: tokenMode ? "github-token" : "local-path",
    runtimeTag: bundle.tag,
    localTools,
    tools: manifest.installedTools || {},
    manifestSha256: installedManifestSha256,
    packageVersion: packageVersion(),
    agent: selectedAgent,
    releaseSet,
    authzConfigPath,
    lastCheckAt: new Date().toISOString()
  });
  console.log(`安装完成：${runtimeDir}`);
  console.log("");
  console.log("下一步：");
  console.log(`cd ${runtimeDir}`);
}
