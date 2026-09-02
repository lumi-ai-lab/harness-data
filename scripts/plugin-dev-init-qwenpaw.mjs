#!/usr/bin/env node

// QwenPaw plugin development environment initializer.
//
// Builds the formal plugin artifact, installs it into an isolated QwenPaw
// working directory (QWENPAW_WORKING_DIR), runs the unified setup to build
// the instanceRoot, and verifies the result with `qwenpaw doctor --json`.
// Nothing outside the fixed /tmp development paths is modified.
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stageQwenPawPlugin, verifyQwenPawPlugin } from "./build-qwenpaw-plugin.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKING_DIR = "/tmp/qwenpaw-home/dev-harness-plugin";
const INSTANCE_ROOT = path.join(WORKING_DIR, "instance");
const DATA_ROOT = path.join(WORKING_DIR, "data");
const PROJECT_ROOT = path.join(WORKING_DIR, "project");
const SECRET_DIR = path.join(WORKING_DIR, "secrets");
const DEFAULT_SECRET_SOURCE = path.join(repoRoot, "config", "fixtures", "local-test-auth.blob");
const DEFAULT_AUTH_USER_ID = "local-test-user";

function run(command, args, { allowFailure = false, cwd = repoRoot, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, QWENPAW_WORKING_DIR: WORKING_DIR, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}`);
  }
  return result;
}

function resetFixedDirectory(directory) {
  const normalized = path.resolve(directory);
  if (!normalized.startsWith(path.resolve("/tmp/qwenpaw-home/"))) {
    throw new Error(`refusing to reset an unexpected development path: ${directory}`);
  }
  rmSync(normalized, { recursive: true, force: true });
  mkdirSync(normalized, { recursive: true, mode: 0o700 });
}

function prepareDevSecret() {
  const source = process.env.QDM_SECRET_SOURCE || DEFAULT_SECRET_SOURCE;
  const resolved = path.resolve(source);
  const info = lstatSync(resolved, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`secret must be a regular file: ${resolved}`);
  const target = path.join(SECRET_DIR, "auth.blob");
  mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  copyFileSync(resolved, target);
  chmodSync(target, 0o600);
  return target;
}

function resolveDevWikisSource() {
  const candidates = [
    process.env.QDM_WIKIS_SOURCE,
    path.join(repoRoot, "plugins", "harness-data", "resources", "wikis"),
    "/Users/pengmd/c/qdm/harness-data-wikis",
  ].filter(Boolean).map((value) => path.resolve(String(value)));
  return candidates.find((candidate) => existsSync(path.join(candidate, "index.md"))) || "";
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

export async function initializeQwenPawDev() {
  resetFixedDirectory(path.dirname(WORKING_DIR));
  mkdirSync(WORKING_DIR, { recursive: true });
  mkdirSync(PROJECT_ROOT, { recursive: true, mode: 0o700 });
  const secret = prepareDevSecret();

  const python = process.env.QWENPAW_PYTHON || "python";
  const wikisSource = resolveDevWikisSource();
  if (!wikisSource) throw new Error("no local wikis source found; set QDM_WIKIS_SOURCE");
  const metricCli = resolveDevMetricCli();
  if (!metricCli) throw new Error("no qdm-metric-cli found; set QDM_METRIC_CLI");

  console.log("[1/4] 构建 QwenPaw 原生插件产物");
  const artifactRoot = path.join(WORKING_DIR, "artifact");
  stageQwenPawPlugin({ artifactRoot, repoRoot });
  verifyQwenPawPlugin({ artifactRoot });

  console.log("[2/4] 通过 QwenPaw 原生安装机制安装插件");
  const pluginSource = path.join(WORKING_DIR, "plugin-source");
  rmSync(pluginSource, { recursive: true, force: true });
  cpSync(artifactRoot, pluginSource, { recursive: true });

  console.log("[3/4] 执行 harness-data qwenpaw setup 建立 instanceRoot");
  const setupArgs = [
    "qwenpaw", "setup",
    "--source", pluginSource,
    "--qwenpaw-python", python,
    "--qwenpaw-working-dir", WORKING_DIR,
    "--instance-root", INSTANCE_ROOT,
    "--data-root", DATA_ROOT,
    "--workspace-root", PROJECT_ROOT,
    "--workspace-allowlist", PROJECT_ROOT,
    "--wikis-source", wikisSource,
    "--metric-cli", metricCli,
    "--auth-blob-file", secret,
    "--auth-user-id", DEFAULT_AUTH_USER_ID,
    "--secret-dir", SECRET_DIR,
    "--plugin-config-file", path.join(WORKING_DIR, "plugin-config.json"),
    // The development instance talks to QwenPaw's built-in agent, so opt it in
    // explicitly — the plugin's own default is the `harness-data-*` convention.
    "--enabled-agents", "harness-data-*",
    "--enabled-agents", "default",
    "--json",
  ];
  const setup = run(process.execPath, [path.join(repoRoot, "npm", "bin", "harness-data.js"), ...setupArgs], { cwd: PROJECT_ROOT });
  if (setup.stdout) process.stdout.write(setup.stdout);

  console.log("[4/4] 验证插件实例");
  const doctor = run(
    process.execPath,
    [
      path.join(repoRoot, "npm", "bin", "harness-data.js"), "qwenpaw", "doctor", "--json",
      "--plugin-config-file", path.join(WORKING_DIR, "plugin-config.json"),
      // Pin the agent list to this isolated home; the default would read the
      // developer's own ~/.qwenpaw.
      "--qwenpaw-working-dir", WORKING_DIR,
    ],
    { cwd: PROJECT_ROOT, allowFailure: true },
  );
  const report = JSON.parse(doctor.stdout || "{}");
  if (report.ok !== true) {
    throw new Error(`qwenpaw doctor failed:\n${doctor.stdout}`);
  }

  console.log("");
  console.log("QwenPaw Harness Data 插件开发环境初始化完成。");
  console.log(`QWENPAW_WORKING_DIR: ${WORKING_DIR}`);
  console.log(`INSTANCE_ROOT: ${INSTANCE_ROOT}`);
  console.log(`DATA_ROOT: ${DATA_ROOT}`);
  console.log(`PROJECT_ROOT: ${PROJECT_ROOT}`);
  console.log("");
  console.log("启动命令:");
  console.log(`  QWENPAW_WORKING_DIR=${WORKING_DIR} ${python} -m qwenpaw`);
  return { workingDir: WORKING_DIR, instanceRoot: INSTANCE_ROOT, dataRoot: DATA_ROOT, projectRoot: PROJECT_ROOT };
}

function copyTree(source, target) {
  cpSync(source, target, { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializeQwenPawDev()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error) => {
      process.stderr.write(`qwenpaw plugin dev init failed: ${error?.message || error}\n`);
      process.exitCode = 1;
    });
}
