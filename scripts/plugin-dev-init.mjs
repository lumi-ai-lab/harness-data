#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyCodexRepository } from "./build-codex-marketplace.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_HOME = "/tmp/codex-home/dev-harness-plugin";
const PROJECT_ROOT = "/tmp/codex-dev-harness-plugin";
const SYSTEM_CODEX_AUTH = process.env.QDM_CODEX_AUTH_SOURCE || path.join(os.homedir(), ".codex", "auth.json");
const DEFAULT_SECRET_SOURCE = path.join(repoRoot, "config", "fixtures", "local-test-auth.blob");
const DEFAULT_AUTH_USER_ID = "local-test-user";

function run(command, args, { allowFailure = false, cwd = repoRoot, env = {}, stdio = ["ignore", "pipe", "pipe"] } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CODEX_HOME, ...env },
    encoding: "utf8",
    stdio,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed${output ? `: ${output}` : ` (exit ${result.status})`}`);
  }
  return { ...result, output };
}

export function codexLaunchEnvironment(cwd, baseEnv = process.env) {
  const workspaceRoot = path.resolve(cwd);
  return {
    ...baseEnv,
    CODEX_HOME,
    HARNESS_WORKSPACE_ROOT: workspaceRoot,
    CODEX_WORKSPACE_ROOT: workspaceRoot,
    PWD: workspaceRoot,
  };
}

function runInteractive(command, args, cwd) {
  const workspaceRoot = path.resolve(cwd);
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: codexLaunchEnvironment(workspaceRoot),
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

function runNode(script, args, options = {}) {
  return run(process.execPath, [script, ...args], options);
}

function resetFixedDirectory(directory) {
  const normalized = path.resolve(directory);
  if (normalized !== path.resolve(CODEX_HOME) && normalized !== path.resolve(PROJECT_ROOT)) {
    throw new Error(`refusing to reset an unexpected development path: ${directory}`);
  }
  rmSync(normalized, { recursive: true, force: true });
  mkdirSync(normalized, { recursive: true, mode: 0o700 });
}

function prepareCodexAuth() {
  const source = path.resolve(SYSTEM_CODEX_AUTH);
  const sourceInfo = lstatSync(source, { throwIfNoEntry: false });
  if (!sourceInfo) {
    if (process.env.QDM_CODEX_AUTH_SOURCE) throw new Error(`configured Codex auth file does not exist: ${source}`);
    console.log(`[auth] 未找到系统 Codex 登录信息，启动时可能需要登录: ${source}`);
    return { status: "missing", source };
  }
  const resolvedSource = realpathSync(source);
  const resolvedInfo = lstatSync(resolvedSource, { throwIfNoEntry: false });
  if (!resolvedInfo?.isFile() || resolvedInfo.isSymbolicLink()) {
    throw new Error(`Codex auth must resolve to a regular file: ${source}`);
  }
  if (process.platform !== "win32" && (resolvedInfo.mode & 0o077) !== 0) {
    throw new Error(`Codex auth file must not be readable by group or other users: ${resolvedSource}`);
  }
  const target = path.join(CODEX_HOME, "auth.json");
  copyFileSync(resolvedSource, target);
  if (process.platform !== "win32") chmodSync(target, 0o600);
  console.log(`[auth] 已复用系统 Codex 登录信息: ${source}`);
  return { status: "copied", source, target };
}

function validateSecret(sourcePath) {
  const source = path.resolve(sourcePath);
  const info = lstatSync(source, { throwIfNoEntry: false });
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error(`secret must be a regular file: ${source}`);
  const isDevelopmentFixture = source === path.resolve(DEFAULT_SECRET_SOURCE);
  if (!isDevelopmentFixture && process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`secret permissions must be 0600: ${source}`);
  }
  const content = readFileSync(source, "utf8").trim();
  if (!/^qdm1enc\.[A-Za-z0-9_-]+$/.test(content)) throw new Error(`secret must contain a qdm1enc blob: ${source}`);
  return source;
}

function prepareDevSecret(source) {
  const target = path.join(CODEX_HOME, "dev-auth.blob");
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  if (process.platform !== "win32") chmodSync(target, 0o600);
  return target;
}

function resolveDevMetricCli() {
  const binary = process.platform === "win32" ? "qdm-metric-cli.exe" : "qdm-metric-cli";
  const candidates = [
    process.env.QDM_METRIC_CLI,
    process.env.QDM_METRIC_CLI_SOURCE,
    path.join(repoRoot, "..", "qdm-metric-cli", "dist", binary),
  ].filter(Boolean).map((value) => path.resolve(String(value)));
  for (const candidate of candidates) {
    const info = lstatSync(candidate, { throwIfNoEntry: false });
    if (info?.isFile() && !info.isSymbolicLink() && (process.platform === "win32" || (info.mode & 0o111) !== 0)) {
      return candidate;
    }
  }
  return "";
}

async function promptValue(readline, answers, label, defaultValue) {
  if (answers) {
    const answer = String(answers.shift() || "").trim();
    stdout.write(`${label} [${defaultValue}]: ${answer}\n`);
    return answer || defaultValue;
  }
  const answer = (await readline.question(`${label} [${defaultValue}]: `)).trim();
  return answer || defaultValue;
}

export function marketplaceAddArgs(source = repoRoot) {
  return ["plugin", "marketplace", "add", path.resolve(source), "--json"];
}

export function pluginSelector() {
  return "harness-data@lumi-ai-lab";
}

export function buildSetupArgs({ pluginRoot, dataRoot = path.join(CODEX_HOME, "qdm-harness", "data"), projectRoot = PROJECT_ROOT, secretSource = DEFAULT_SECRET_SOURCE, authUserId = DEFAULT_AUTH_USER_ID, metricCli = "", giteeToken = "", githubToken = "", archivePassword = "", wikisSource = "" } = {}) {
  const args = [
    "--data-root", path.resolve(dataRoot),
    "--workspace-root", path.resolve(projectRoot),
    "--workspace-allowlist", path.resolve(projectRoot),
    "--auth-blob-file", path.resolve(secretSource),
    "--auth-user-id", authUserId,
    "--json",
  ];
  if (metricCli) args.push("--metric-cli", path.resolve(metricCli));
  else args.push("--download-metric-cli");
  if (wikisSource) args.push("--wikis-source", path.resolve(wikisSource));
  if (giteeToken) args.push("--gitee-token", giteeToken);
  if (githubToken) args.push("--github-token", githubToken);
  if (archivePassword) args.push("--release-archive-password", archivePassword);
  return args;
}

export function resolveDevWikisSource({ pluginRoot = "", env = process.env } = {}) {
  const candidates = [
    env.QDM_WIKIS_SOURCE,
    pluginRoot ? path.join(pluginRoot, "resources", "wikis") : "",
    path.join(repoRoot, "plugins", "harness-data", "resources", "wikis"),
    "/Users/pengmd/c/qdm/harness-data-wikis",
  ].filter(Boolean).map((value) => path.resolve(String(value)));
  return candidates.find((candidate) => existsSync(path.join(candidate, "index.md"))) || "";
}

function preparePluginSource() {
  const pluginRoot = path.join(repoRoot, "plugins", "harness-data");
  runNode(path.join(pluginRoot, "scripts", "bundle-dist.mjs"), ["--output-dir", path.join(pluginRoot, "dist")]);
  verifyCodexRepository({ repoRoot, version: process.env.QDM_PLUGIN_VERSION || "" });
  return pluginRoot;
}

export async function initializeCodexDev() {
  resetFixedDirectory(CODEX_HOME);
  resetFixedDirectory(PROJECT_ROOT);
  prepareCodexAuth();

  const answers = stdin.isTTY ? null : readFileSync(0, "utf8").split(/\r?\n/);
  const readline = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    const secretSource = validateSecret(await promptValue(
      readline,
      answers,
      "QDM auth.blob 文件",
      process.env.QDM_SECRET_SOURCE || DEFAULT_SECRET_SOURCE,
    ));
    const preparedSecret = prepareDevSecret(secretSource);
    const authUserId = await promptValue(readline, answers, "QDM_AUTH_USER_ID", process.env.QDM_AUTH_USER_ID || DEFAULT_AUTH_USER_ID);
    if (!authUserId) throw new Error("QDM_AUTH_USER_ID cannot be empty");
    const metricCli = resolveDevMetricCli();
    const pluginRootSource = preparePluginSource();

    console.log("[1/4] 注册主仓库 Codex Marketplace");
    run("codex", marketplaceAddArgs(process.env.QDM_CODEX_MARKETPLACE_SOURCE || repoRoot));

    console.log("[2/4] 安装 harness-data Plugin");
    const added = run("codex", ["plugin", "add", pluginSelector(), "--json"]);
    const pluginRoot = installedPluginPath(added.stdout);

    console.log("[3/4] 执行 Plugin Setup");
    const setupArgs = buildSetupArgs({
      pluginRoot,
      secretSource: preparedSecret,
      authUserId,
      metricCli,
      wikisSource: resolveDevWikisSource({ pluginRoot, env: process.env }),
      giteeToken: process.env.GITEE_TOKEN || "",
      githubToken: process.env.GITHUB_TOKEN || "",
      archivePassword: process.env.HARNESS_RELEASE_ARCHIVE_PASSWORD || "",
    });
    const setup = runNode(path.join(pluginRoot, "scripts", "setup.mjs"), setupArgs, {
      cwd: PROJECT_ROOT,
      stdio: stdin.isTTY ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    if (setup.stdout) process.stdout.write(setup.stdout);

    console.log("[4/4] 验证 Plugin、Hook 和 MCP");
    const pluginList = run("codex", ["plugin", "list", "--json"], { cwd: PROJECT_ROOT });
    if (!pluginList.stdout.includes("harness-data")) throw new Error("harness-data is not installed");
    const mcpList = run("codex", ["mcp", "list"], { cwd: PROJECT_ROOT });
    if (!/^html-report\s+.*enabled/m.test(mcpList.stdout)) throw new Error(`html-report MCP is not enabled: ${mcpList.output}`);
    runNode(path.join(pluginRoot, "mcp", "server.mjs"), ["--self-test"]);

    console.log("");
    console.log("Harness Data Plugin 开发环境初始化完成。");
    console.log(`CODEX_HOME: ${CODEX_HOME}`);
    console.log(`PROJECT_ROOT: ${PROJECT_ROOT}`);
    console.log(`SOURCE_PLUGIN_ROOT: ${pluginRootSource}`);
    console.log(`PLUGIN_ROOT: ${pluginRoot}`);
    console.log("");
    console.log("按 Enter 后将在固定普通项目目录启动 Codex。");
    if (process.env.QDM_PLUGIN_DEV_NO_LAUNCH !== "1") {
      if (!readline) throw new Error("interactive Codex launch requires a terminal; set QDM_PLUGIN_DEV_NO_LAUNCH=1 for automation");
      await readline.question("");
      runInteractive("codex", [], PROJECT_ROOT);
    }
    return { pluginRoot, sourcePluginRoot: pluginRootSource, projectRoot: PROJECT_ROOT, codexHome: CODEX_HOME };
  } finally {
    readline?.close();
  }
}

function installedPluginPath(addOutput) {
  const parsed = JSON.parse(addOutput);
  if (!parsed?.installedPath) throw new Error(`codex plugin add did not return installedPath: ${addOutput}`);
  return path.resolve(parsed.installedPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializeCodexDev().catch((error) => {
    process.stderr.write(`plugin dev init failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
