import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { commandExists, run } from "../lib/exec.js";
import {
  localPathToolNamesForProfile,
  qdmCliBinariesForProfile,
  writeLocalConfig,
  linkAgents
} from "../lib/config.js";
import { verifyApprovedWikisSource } from "../lib/approved-wikis.js";
import { ask, chooseAgent } from "../lib/prompt.js";
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
  lumiMetricCatalogArtifact,
  lumiApprovedWikisArtifact,
  lumiReleaseSet,
  localUnrestrictedProfile,
  lumiRequiredProfile,
  normalizeProfile,
  profileFromState,
  selectManifestProfile,
  validateProfileAgent
} from "../lib/profile.js";

const runtimeRepo = "lumi-ai-lab/harness-data";
const wikisRepo = "lumi-ai-lab/harness-data-wikis";
const privateMetricRoot = "/opt/harness-data/private";
const protectedMetricBrokerRoot = "/opt/harness-data/broker";
const protectedMetricBrokerPath = `${protectedMetricBrokerRoot}/qdm-metric-cli`;
const metricBrokerServicePath = "/etc/systemd/system/harness-data-metric-broker.service";

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
  const explicit = name === "qdm-metric-cli" ? options.metricCliPath : "";
  const candidates = [
    explicit,
    path.join(runtimeDir, "bin", binaryName(name)),
    path.join(runtimeDir, binaryName(name)),
    path.join(process.cwd(), binaryName(name))
  ].filter(Boolean);
  for (const candidate of candidates) {
    const file = path.resolve(candidate);
    if (executable(file)) {
      ok(`自动识别 ${name}: ${file}`);
      return file;
    }
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

export async function buildAndCheck(runtimeDir, options = {}) {
  const cli = path.join(runtimeDir, "bin", binaryName("data-harness-cli"));
  action("执行：data-harness-cli wikis build-index --skip-checks");
  const result = await run(cli, ["wikis", "build-index", "--skip-checks"], { cwd: runtimeDir, allowFailure: true });
  if (result.code !== 0) {
    if (options.requiredIndexes) {
      throw new Error("wikis index build failed for lumi-mvp-required");
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
    throw new Error(`wikis index build did not produce required Lumi indexes: ${missingIndexes.map((file) => path.basename(file)).join(", ")}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const docs = output.match(/\bdocs=(\d+)/)?.[1];
  const recall = output.match(/\brecall=(\d+)/)?.[1];
  const runtimeDocs = output.match(/\bruntimeDocs=(\d+)/)?.[1];
  ok([docs ? `docs=${docs}` : "", recall ? `recall=${recall}` : "", runtimeDocs ? `runtimeDocs=${runtimeDocs}` : ""].filter(Boolean).join(", ") || "Wikis 索引已构建");
  return { ok: true, docs, recall, runtimeDocs };
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function checkedExecutable(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || !executable(file)) {
    throw new Error(`sandbox CLI is not a regular executable: ${file}`);
  }
  return file;
}

function platformDispatcher(name) {
  return `#!/bin/sh
set -eu

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) platform="darwin-arm64" ;;
  Darwin:x86_64) platform="darwin-amd64" ;;
  Linux:aarch64|Linux:arm64) platform="linux-arm64" ;;
  Linux:x86_64|Linux:amd64) platform="linux-amd64" ;;
  *)
    echo "unsupported platform for ${name}: $(uname -s) $(uname -m)" >&2
    exit 126
    ;;
esac

runtime_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$runtime_root/.harness/platform-bin/$platform/${name}" "$@"
`;
}

function replaceExecutableCopy(source, target) {
  const temporary = `${target}.install-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.copyFileSync(source, temporary);
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function installSandboxPlatformTools(runtimeDir, profile, options = {}) {
  if (!String(options.sandboxCliDir || "").trim()) return {};
  if (profile !== localUnrestrictedProfile) {
    throw new Error("--sandbox-cli-dir is supported only for local-unrestricted");
  }

  const sourceDir = path.resolve(options.sandboxCliDir);
  const hostPlatform = String(options.hostPlatformKey || platformKey());
  const sandboxPlatform = String(options.sandboxPlatform || "linux-arm64");
  if (!["linux-arm64", "linux-amd64"].includes(sandboxPlatform)) {
    throw new Error(`unsupported sandbox platform: ${sandboxPlatform}`);
  }

  const platformRoot = path.join(runtimeDir, ".harness", "platform-bin");
  const installed = {};
  for (const name of qdmCliBinariesForProfile(profile)) {
    const active = checkedExecutable(path.join(runtimeDir, "bin", binaryName(name)));
    const sandboxSource = checkedExecutable(path.join(sourceDir, binaryName(name)));
    const hostTarget = path.join(platformRoot, hostPlatform, binaryName(name));
    const sandboxTarget = path.join(platformRoot, sandboxPlatform, binaryName(name));
    fs.mkdirSync(path.dirname(hostTarget), { recursive: true });
    fs.mkdirSync(path.dirname(sandboxTarget), { recursive: true });
    replaceExecutableCopy(active, hostTarget);
    replaceExecutableCopy(sandboxSource, sandboxTarget);
    fs.writeFileSync(active, platformDispatcher(binaryName(name)), { mode: 0o755 });
    installed[name] = {
      mode: "platform-dispatch",
      hostPlatform,
      hostSha256: fileSha256(hostTarget),
      sandboxPlatform,
      sandboxSha256: fileSha256(sandboxTarget)
    };
  }
  return installed;
}

export function validateLumiManifestReleaseSet(runtimeDir, manifest, releaseSet) {
  const helper = manifest.tools?.find((tool) => tool.name === "data-harness-cli");
  const publicMetric = manifest.tools?.find((tool) => tool.name === "qdm-metric-cli");
  const realMetric = manifest.tools?.find((tool) => tool.name === "qdm-metric-cli-real");
  if (!helper || !publicMetric || !realMetric) {
    throw new Error("lumi-mvp-required manifest must include all Harness authorization artifacts");
  }
  for (const tool of [helper, publicMetric, realMetric]) {
    if (tool.tracking !== "fixed") throw new Error("Lumi authorization artifacts must use fixed tracking");
  }
  const platform = platformKey();
  if (!platform.startsWith("linux-")) {
    throw new Error("lumi-mvp-required requires Linux trusted broker isolation");
  }
  if (releaseSet.platform !== platform) {
    throw new Error(`Lumi release-set platform does not match ${platform}`);
  }
  for (const [name, tool] of [["data-harness-cli", helper], ["qdm-metric-cli", publicMetric], ["qdm-metric-cli-real", realMetric]]) {
    if (!/^[a-f0-9]{64}$/.test(String(tool.platforms?.[platform]?.binarySha256 || ""))) {
      throw new Error(`${name} binary sha256 is not fixed for ${platform}`);
    }
  }
  if (publicMetric.version !== releaseSet.publicMetricVersion ||
      realMetric.version !== releaseSet.realMetricVersion) {
    throw new Error("Metric CLI versions do not match the Lumi release-set");
  }
  if (publicMetric.platforms[platform].binarySha256 !== releaseSet.publicMetricSha256 ||
      realMetric.platforms[platform].binarySha256 !== releaseSet.realMetricSha256) {
    throw new Error(`Metric CLI artifacts do not match the Lumi release-set for ${platform}`);
  }
  const publicPath = path.join(runtimeDir, "bin", binaryName("qdm-metric-cli"));
  const realDestination = path.resolve(String(realMetric.destination || ""));
  if (path.resolve(toolDestination(runtimeDir, helper)) !== path.resolve(runtimeDir, "bin", binaryName("data-harness-cli")) ||
      path.resolve(toolDestination(runtimeDir, publicMetric)) !== path.resolve(publicPath) ||
      path.dirname(realDestination) !== privateMetricRoot ||
      !/^qdm-metric-cli-v0\.1\.\d+$/.test(path.basename(realDestination))) {
    throw new Error("Lumi authorization artifact destinations are invalid");
  }
}

export function verifyLumiInstalledReleaseSet(installedTools, releaseSet, manifest = null) {
  const publicMetric = installedTools?.["qdm-metric-cli"];
  const realMetric = installedTools?.["qdm-metric-cli-real"];
  if (!publicMetric || !realMetric) throw new Error("Lumi installation is missing Metric authorization artifacts");
  if (publicMetric.version !== releaseSet.publicMetricVersion ||
      realMetric.version !== releaseSet.realMetricVersion ||
      publicMetric.sha256 !== releaseSet.publicMetricSha256 ||
      realMetric.sha256 !== releaseSet.realMetricSha256) {
    throw new Error("installed Metric CLI artifacts do not match the release-set");
  }
  if (manifest) {
    const platform = platformKey();
    const publicSha = manifest.tools?.find((tool) => tool.name === "qdm-metric-cli")?.platforms?.[platform]?.binarySha256;
    const realSha = manifest.tools?.find((tool) => tool.name === "qdm-metric-cli-real")?.platforms?.[platform]?.binarySha256;
    if (publicMetric.sha256 !== publicSha || realMetric.sha256 !== realSha) {
      throw new Error("installed Metric CLI artifacts do not match the manifest");
    }
  }
}

export function installLumiMetricCatalog(runtimeDir, manifest) {
  const catalog = lumiMetricCatalogArtifact(manifest);
  const source = path.resolve(runtimeDir, catalog.source);
  const expectedSource = path.join(path.resolve(runtimeDir), "bootstrap", "approved-metrics-v1.json");
  if (source !== expectedSource || fileSha256(source) !== catalog.sha256) {
    throw new Error("approved Metric catalog does not match the release manifest");
  }
  const destination = catalog.destination;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  if (fs.existsSync(destination) && fileSha256(destination) !== catalog.sha256) {
    throw new Error(`approved Metric catalog destination already contains a different artifact: ${destination}`);
  }
  if (!fs.existsSync(destination)) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o644);
  return destination;
}

function assertRootOwnedDirectory(directory, mode) {
  fs.mkdirSync(directory, { recursive: true, mode });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`trusted broker path is not a regular directory: ${directory}`);
  }
  if (typeof info.uid === "number" && info.uid !== 0) {
    throw new Error(`trusted broker path is not root-owned: ${directory}`);
  }
  fs.chownSync(directory, 0, 0);
  fs.chmodSync(directory, mode);
}

function systemdQuote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("trusted broker executable path is invalid");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function writeRootOwnedFileAtomic(destination, content, mode) {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.install-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
  );
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode });
    fs.chownSync(temporary, 0, 0);
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function renderLumiMetricBrokerService() {
  return `[Unit]
Description=Harness Data trusted Metric CLI broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
ExecStart=${systemdQuote(protectedMetricBrokerPath)} broker-serve
RuntimeDirectory=harness-data
RuntimeDirectoryMode=0755
UMask=0077
Restart=on-failure
RestartSec=2s
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectClock=true
ProtectHostname=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectProc=invisible
ProcSubset=pid
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
`;
}

export function prepareLumiMetricBrokerDestination(manifest, options = {}) {
  if (process.platform !== "linux") {
    throw new Error("lumi-mvp-required requires Linux trusted broker isolation");
  }
  const effectiveUID = options.effectiveUID ?? process.getuid?.();
  if (effectiveUID !== 0) {
    throw new Error("lumi-mvp-required installation must run as root to isolate the private Metric CLI");
  }
  const realTool = manifest.tools?.find((tool) => tool.name === "qdm-metric-cli-real");
  const realPath = path.resolve(String(realTool?.destination || ""));
  if (path.dirname(realPath) !== privateMetricRoot ||
      !/^qdm-metric-cli-v0\.1\.\d+$/.test(path.basename(realPath))) {
    throw new Error("private Metric CLI destination is outside the trusted broker directory");
  }

  assertRootOwnedDirectory("/opt/harness-data", 0o755);
  assertRootOwnedDirectory(privateMetricRoot, 0o700);
  if (fs.existsSync(realPath)) {
    const info = fs.lstatSync(realPath);
    if (!info.isFile() || info.isSymbolicLink() ||
        (typeof info.uid === "number" && info.uid !== 0)) {
      throw new Error("existing private Metric CLI destination is not a root-owned regular file");
    }
  }
  return realPath;
}

export function installLumiMetricBroker(runtimeDir, installedTools, options = {}) {
  if (process.platform !== "linux") {
    throw new Error("lumi-mvp-required requires Linux trusted broker isolation");
  }
  const effectiveUID = options.effectiveUID ?? process.getuid?.();
  if (effectiveUID !== 0) {
    throw new Error("lumi-mvp-required installation must run as root to isolate the private Metric CLI");
  }

  const realMetric = installedTools?.["qdm-metric-cli-real"];
  const realPath = path.resolve(String(realMetric?.destination || ""));
  if (path.dirname(realPath) !== privateMetricRoot ||
      !/^qdm-metric-cli-v0\.1\.\d+$/.test(path.basename(realPath))) {
    throw new Error("private Metric CLI destination is outside the trusted broker directory");
  }
  assertRootOwnedDirectory("/opt/harness-data", 0o755);
  assertRootOwnedDirectory(privateMetricRoot, 0o700);
  const realInfo = fs.lstatSync(realPath);
  if (!realInfo.isFile() || realInfo.isSymbolicLink()) {
    throw new Error("private Metric CLI is not a regular file");
  }

  fs.chownSync(realPath, 0, 0);
  fs.chmodSync(realPath, 0o500);

  const publicMetricPath = path.join(path.resolve(runtimeDir), "bin", binaryName("qdm-metric-cli"));
  const publicMetric = installedTools?.["qdm-metric-cli"];
  if (path.resolve(String(publicMetric?.destination || "")) !== publicMetricPath ||
      !/^[a-f0-9]{64}$/.test(String(publicMetric?.sha256 || ""))) {
    throw new Error("public Metric broker artifact state is invalid");
  }
  const publicInfo = fs.lstatSync(publicMetricPath);
  if (!publicInfo.isFile() || publicInfo.isSymbolicLink()) {
    throw new Error("public Metric CLI is not a regular file");
  }
  const publicMetricBytes = fs.readFileSync(publicMetricPath);
  if (crypto.createHash("sha256").update(publicMetricBytes).digest("hex") !== publicMetric.sha256) {
    throw new Error("public Metric broker artifact does not match its installed SHA256");
  }
  assertRootOwnedDirectory(protectedMetricBrokerRoot, 0o700);
  writeRootOwnedFileAtomic(protectedMetricBrokerPath, publicMetricBytes, 0o500);

  const service = renderLumiMetricBrokerService();
  const servicePath = path.resolve(options.servicePath || metricBrokerServicePath);
  assertRootOwnedDirectory(path.dirname(servicePath), 0o755);
  writeRootOwnedFileAtomic(servicePath, service, 0o644);

  return {
    servicePath,
    socketPath: "/run/harness-data/qdm-metric-cli.sock",
    brokerPath: protectedMetricBrokerPath,
    realPath
  };
}

export function printDoctorSummary(doctor, options = {}) {
  const nonBlocking = options.nonBlocking || (() => false);
  const failed = doctor.checks.filter((check) => !check.ok && !nonBlocking(check));
  const warnings = doctor.checks.filter((check) => !check.ok && nonBlocking(check));
  if (!failed.length) {
    if (doctor.profile === lumiRequiredProfile) {
      ok("lumi-mvp-required profile 与 installer-state v3");
      ok("2 个运行时 CLI（data-harness-cli 与 qdm-metric-cli）");
      ok("唯一数据入口 qdm-metric-cli");
      ok("无 CAS/token 与其他数据 CLI");
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

export function installModeFor(profile, options = {}, tokenMode = false) {
  if (profile === localUnrestrictedProfile && String(options.wikisSource || "").trim()) {
    return "local-path";
  }
  return tokenMode ? "github-token" : "local-path";
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
  if (profile === localUnrestrictedProfile && !String(options.metricCliPath || "").trim()) {
    throw new Error("local-unrestricted installation requires --metric-cli-path for the real qdm-metric-cli executable");
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
  const bundle = await installRuntimeBundle(runtimeDir, { ...options, profile });
  blank();

  step(3, 7, "安装 CLI 工具");
  const manifestPath = path.resolve(options.manifest || path.join(runtimeDir, "bootstrap", "cli-manifest.json"));
  const tokenMode = await hasGithubAuth(options);
  const installMode = installModeFor(profile, options, tokenMode);
  const installState = profile === lumiRequiredProfile ? readInstallerState(runtimeDir) : readInstallState(runtimeDir);
  const sourceManifest = readManifest(manifestPath);
  const selectedManifest = selectManifestProfile(sourceManifest, profile);
  const releaseSet = profile === lumiRequiredProfile ? lumiReleaseSet(sourceManifest, key) : null;
  const authzConfigPath = authzConfigPathFor(sourceManifest, profile);
  if (profile === lumiRequiredProfile) validateLumiManifestReleaseSet(runtimeDir, selectedManifest, releaseSet);

  let manifest;
  let localTools = {};
  let platformTools = {};
  if (profile === lumiRequiredProfile) {
    if (!tokenMode) throw new Error("lumi-mvp-required profile requires authenticated access to fixed release artifacts");
    prepareLumiMetricBrokerDestination(selectedManifest);
    manifest = await installToolsFromManifest(runtimeDir, manifestPath, {
      ...options,
      state: installState,
      manifestOverride: selectedManifest
    });
    verifyLumiInstalledReleaseSet(manifest.installedTools, releaseSet, selectedManifest);
    installLumiMetricBroker(runtimeDir, manifest.installedTools);
    installLumiMetricCatalog(runtimeDir, sourceManifest);
  } else {
    const releaseToolNames = selectedManifest.tools
      .map((tool) => tool.name)
      .filter((name) => !(name === "qdm-metric-cli" && options.metricCliPath));
    const latestManifest = await resolveLatestManifest(selectedManifest, key, {
      ...options,
      tools: releaseToolNames
    });
    manifest = await installToolsFromManifest(runtimeDir, manifestPath, {
      ...options,
      state: installState,
      manifestOverride: latestManifest
    });
    localTools = await installLocalTools(runtimeDir, profile, options);
    platformTools = installSandboxPlatformTools(runtimeDir, profile, options);
  }
  ok(`${Object.keys(manifest.installedTools || {}).length + Object.keys(localTools).length} 个 CLI 已按 ${profile} profile 安装`);
  blank();
  const installedManifestSha256 = manifestDigest(manifest);

  // 及时持久化 CLI 安装状态，后续步骤失败时重新安装可跳过已下载的 CLI
  writeState(runtimeDir, {
    schemaVersion: installerStateSchemaVersion,
    profile,
    agent: selectedAgent,
    installMode,
    runtimeTag: bundle.tag,
    localTools,
    platformTools,
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
  await buildAndCheck(runtimeDir, { ...options, requiredIndexes: profile === lumiRequiredProfile });
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
    installMode,
    runtimeTag: bundle.tag,
    localTools,
    platformTools,
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
