import fs from "node:fs";
import path from "node:path";
import { commandExists, run } from "../lib/exec.js";
import { localPathToolNames, writeLocalConfig, linkAgents } from "../lib/config.js";
import { ask, askSecret, chooseAgent } from "../lib/prompt.js";
import { readUserState, resolveWorkspaceDir, writeState } from "../lib/paths.js";
import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { forceSyncWikis } from "../lib/wikis-git.js";
import { binaryName, platformKey } from "../lib/platform.js";
import { resolveLatestManifest } from "../lib/tool-release.js";
import { collectDoctor } from "./doctor.js";
import { packageVersion } from "../lib/package.js";
import { downloadReleaseAsset, findReleaseAsset, githubToken, hasGithubAuth, latestRelease } from "../lib/github.js";
import { action, blank, fail, header, ok, shortSha, skip, step, warn } from "../lib/log.js";
import { gitUrls, runGitWithProtocol } from "../lib/git-auth.js";

const runtimeRepo = "lumi-ai-lab/harness-data";
const wikisRepo = "lumi-ai-lab/harness-data-wikis";

function readInstallState(runtimeDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runtimeDir, ".harness", "installer-state.json"), "utf8"));
  } catch {
    return readUserState();
  }
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
  if (executable(auto)) {
    ok(`自动识别 ${name}: ${auto}`);
    return auto;
  }
  const value = await ask(`请输入 ${name} 的绝对路径：`, options);
  const file = path.resolve(value);
  if (!executable(file)) throw new Error(`${name} path is missing or not executable: ${file}`);
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
      fs.chmodSync(target, 0o755);
    }
    installed[name] = { mode: "local-path", source };
  }
  return installed;
}

async function installWikis(runtimeDir, options = {}) {
  const target = path.join(runtimeDir, "wikis");
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
  const warnings = doctor.checks.filter((check) => !check.ok && nonBlocking(check));
  if (!failed.length) {
    ok("runtime");
    ok("wikis/metrics");
    ok("wikis/reports");
    ok("wikis/dims");
    ok("wikis/rules");
    ok("5 个 CLI");
    ok("本地配置");
    ok("CAS 凭证");
    ok("CMR Token");
    ok("Indicators Token");
    ok("SQL Token");
    if (!warnings.some((check) => check.name.startsWith("Agent hook"))) ok("Agent Hook");
    for (const check of warnings) warn(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    return;
  }
  for (const check of warnings) warn(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  for (const check of failed) fail(`${check.name}${check.detail ? ` (${check.detail})` : ""}`);
}

export async function installCommand(options = {}) {
  const key = platformKey();
  header("Harness Data 安装器", packageVersion(), [
    `安装目录：${resolveWorkspaceDir(options.dir || process.cwd())}`,
    `平台：${key}`
  ]);

  step(1, 8, "检查本机依赖");
  await requireCommands(key.startsWith("windows-") ? ["git", "tar", "unzip"] : ["git", "tar"]);
  blank();

  step(2, 8, "安装 runtime bundle");
  const runtimeDir = await prepareRuntimeDir(options);
  const bundle = await installRuntimeBundle(runtimeDir, options);
  blank();

  step(3, 8, "安装 CLI 工具");
  const manifestPath = path.resolve(options.manifest || path.join(runtimeDir, "bootstrap", "cli-manifest.json"));
  const tokenMode = await hasGithubAuth(options);
  const installState = readInstallState(runtimeDir);

  let manifest;
  let localTools = {};
  if (tokenMode) {
    manifest = readManifest(manifestPath);
    const latestManifest = await resolveLatestManifest(manifest, key, options);
    manifest = await installToolsFromManifest(runtimeDir, manifestPath, { ...options, state: installState, manifestOverride: latestManifest });
  } else {
    manifest = readManifest(manifestPath);
    const latestManifest = await resolveLatestManifest(manifest, key, { ...options, tools: ["data-harness-cli"] });
    manifest = await installToolsFromManifest(runtimeDir, manifestPath, { ...options, state: installState, manifestOverride: latestManifest });
    localTools = await installLocalTools(runtimeDir, options);
  }
  ok(`${Object.keys(manifest.installedTools || {}).length + Object.keys(localTools).length} 个 CLI 已安装到 bin/`);
  blank();

  // 及时持久化 CLI 安装状态，后续步骤失败时重新安装可跳过已下载的 CLI
  writeState(runtimeDir, {
    installMode: tokenMode ? "github-token" : "local-path",
    runtimeTag: bundle.tag,
    localTools,
    tools: manifest.installedTools || {},
    manifestSha256: manifestDigest(manifest),
    packageVersion: packageVersion()
  });
  blank();

  step(4, 8, "同步 Wikis 知识库");
  await installWikis(runtimeDir, options);
  blank();

  step(5, 8, "生成本地配置");
  writeLocalConfig(runtimeDir, { overwrite: true });
  ok("config/harness-config.yaml");
  ok("config/qdm-cli-paths.env");
  blank();

  step(6, 8, "配置 CAS 认证");
  const casDir = await configureCasAuthentication(runtimeDir, options);
  await configureTokens(runtimeDir, casDir);
  blank();

  step(7, 8, "构建 Wikis 索引");
  await buildAndCheck(runtimeDir, options);
  blank();

  step(8, 8, "配置 Agent Hook");
  const selectedAgent = await chooseAgent(options);
  const linkedAgents = linkAgents(runtimeDir, selectedAgent);
  for (const [source, target] of linkedAgents) {
    if (fs.existsSync(path.join(runtimeDir, target))) ok(`${target} -> ${source}`);
  }
  blank();

  console.log("安装校验");
  const doctor = await collectDoctor(runtimeDir, { ...options, casConfigDir: casDir });
  printDoctorSummary(doctor);
  if (doctor.checks.some((check) => !check.ok)) throw new Error("doctor failed; install is incomplete");
  blank();

  writeState(runtimeDir, {
    installMode: tokenMode ? "github-token" : "local-path",
    runtimeTag: bundle.tag,
    localTools,
    tools: manifest.installedTools || {},
    manifestSha256: manifestDigest(manifest),
    packageVersion: packageVersion(),
    agent: selectedAgent,
    lastCheckAt: new Date().toISOString()
  });
  console.log(`安装完成：${runtimeDir}`);
  console.log("");
  console.log("下一步：");
  console.log(`cd ${runtimeDir}`);
}
