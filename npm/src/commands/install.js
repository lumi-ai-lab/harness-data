import fs from "node:fs";
import path from "node:path";
import { commandExists, run } from "../lib/exec.js";
import { writeLocalConfig, validateCasConfigDir, linkAgents } from "../lib/config.js";
import { confirm, chooseAgent } from "../lib/prompt.js";
import { defaultWorkspaceDir, looksLikeWorkspace, resolveWorkspaceDir, writeState } from "../lib/paths.js";
import { isGitRepo, currentCommit, submoduleCommit } from "../lib/git.js";
import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { platformKey } from "../lib/platform.js";
import { collectDoctor } from "./doctor.js";
import { checkUpdates } from "./update.js";
import { packageVersion } from "../lib/package.js";
import { gitUrls, repoProtocol, repoUrl, resolveInstallProtocol, runGitWithProtocol, syncWikisSubmodule } from "../lib/git-auth.js";

async function requireCommands(commands) {
  for (const command of commands) {
    if (!(await commandExists(command))) throw new Error(`missing required command: ${command}`);
  }
}

async function prepareWorkspace(options) {
  const target = resolveWorkspaceDir(options.dir || (looksLikeWorkspace(process.cwd()) ? process.cwd() : defaultWorkspaceDir()));
  const branch = options.branch || "master";
  if (!fs.existsSync(target)) {
    const protocol = await resolveInstallProtocol(options);
    const repo = options.repo || gitUrls[protocol].repo;
    if (!(await confirm(`Clone ${repo} to ${target}?`, { yes: options.yes }))) throw new Error("install cancelled");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await runGitWithProtocol(protocol, ["clone", "--branch", branch, repo, target], { ...options, stdio: "inherit" });
    await syncWikisSubmodule(target, protocol);
    await runGitWithProtocol(protocol, ["submodule", "update", "--init", "--recursive", "wikis"], { ...options, cwd: target, stdio: "inherit" });
    return { workspace: target, gitProtocol: protocol, repoUrl: repo };
  }
  if (!(await isGitRepo(target)) || !looksLikeWorkspace(target)) {
    throw new Error(`${target} exists but is not a valid harness-data workspace; pass --dir or move the directory`);
  }
  if (!(await confirm(`Reuse existing workspace ${target}?`, { yes: options.yes }))) throw new Error("install cancelled");
  return { workspace: target, gitProtocol: await repoProtocol(target), repoUrl: await repoUrl(target) };
}

async function configureAuth(workspace, options) {
  const casConfigDir = path.resolve(options.casConfigDir || path.join(workspace, ".qdm-auth", "cas"));
  fs.mkdirSync(casConfigDir, { recursive: true, mode: 0o700 });
  const env = { QDM_CAS_CONFIG_DIR: casConfigDir };
  if (options.casConfigDir) {
    validateCasConfigDir(casConfigDir);
  } else if (options.yes) {
    throw new Error("non-interactive install requires --cas-config-dir with existing CAS credentials");
  } else {
    await run(path.join(workspace, "bin", "cas-cli"), ["config", "set-credentials"], { cwd: workspace, env, stdio: "inherit" });
    validateCasConfigDir(casConfigDir);
  }
  await run("sh", ["-c", `"${path.join(workspace, "bin", "qdm-cmr-cli")}" config set-token "$("${path.join(workspace, "bin", "cas-cli")}" token --app cmr)"`], {
    cwd: workspace,
    env,
    stdio: "inherit"
  });
  await run("sh", ["-c", `"${path.join(workspace, "bin", "qdm-indicators-cli")}" config set-token "$("${path.join(workspace, "bin", "cas-cli")}" token --app indicators)"`], {
    cwd: workspace,
    env,
    stdio: "inherit"
  });
  await run(path.join(workspace, "bin", "qdm-cmr-cli"), ["config", "check-token"], { cwd: workspace, env, stdio: "inherit" });
  await run(path.join(workspace, "bin", "qdm-indicators-cli"), ["config", "check-token"], { cwd: workspace, env, stdio: "inherit" });
  return casConfigDir;
}

export async function buildAndCheck(workspace, options) {
  const cli = path.join(workspace, "bin", "data-harness-cli");
  const buildIndexArgs = ["wikis", "build-index"];
  if (options.skipWikisCheck) buildIndexArgs.push("--skip-checks");
  await run(cli, buildIndexArgs, { cwd: workspace, stdio: "inherit" });
  await run(cli, ["context", "--question", "会员复购为什么下降？", "--json"], { cwd: workspace, stdio: "inherit" });
  let runFullCheck = !options.skipWikisCheck;
  if (!options.yes && !options.skipWikisCheck) {
    runFullCheck = await confirm("Run wikis check-all?", { defaultNo: false });
  }
  if (runFullCheck) {
    const result = await run(cli, ["wikis", "check-all"], { cwd: workspace, stdio: "inherit", allowFailure: true });
    if (result.code !== 0) console.warn("warning: wikis check-all reported issues");
  } else {
    console.warn("warning: wikis check-all skipped");
  }
}

export async function installCommand(options = {}) {
  platformKey();
  await requireCommands(["git", "curl", "tar", "unzip"]);
  const prepared = await prepareWorkspace(options);
  const workspace = prepared.workspace;
  const manifestPath = path.resolve(options.manifest || path.join(workspace, "bootstrap", "cli-manifest.json"));
  if (!(await confirm("Download or refresh CLI binaries?", { yes: options.yes }))) throw new Error("install cancelled");
  const manifest = await installToolsFromManifest(workspace, manifestPath, options);
  const configExists = fs.existsSync(path.join(workspace, "config", "harness-config.yaml")) ||
    fs.existsSync(path.join(workspace, "config", "qdm-cli-paths.env"));
  const overwrite = configExists && !options.yes ? await confirm("Overwrite existing local config files?", { defaultNo: true }) : !configExists;
  if (configExists && !overwrite) {
    console.log("Reusing existing local config files");
  } else {
    writeLocalConfig(workspace, { overwrite: true });
  }
  const casConfigDir = await configureAuth(workspace, options);
  await buildAndCheck(workspace, options);
  const agent = await chooseAgent(options);
  linkAgents(workspace, agent);
  const doctor = await collectDoctor(workspace, { ...options, casConfigDir });
  for (const check of doctor.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
  if (doctor.checks.some((check) => !check.ok)) throw new Error("doctor failed; install is incomplete");
  const gitProtocol = prepared.gitProtocol || await repoProtocol(workspace) || "ssh";
  const updates = await checkUpdates(workspace, { ...options, gitProtocol });
  if (updates.hasUpdates) {
    console.log(`Updates available. Next step: npx @lumi-ai-lab/harness-data update --dir "${workspace}"`);
  }
  writeState(workspace, {
    mainCommit: await currentCommit(workspace),
    wikisCommit: await submoduleCommit(workspace),
    manifestSha256: manifestDigest(manifest),
    lastCheckAt: new Date().toISOString(),
    packageVersion: packageVersion(),
    gitProtocol,
    repoUrl: prepared.repoUrl
  });
  console.log(`Harness Data installed: ${workspace}`);
}
