import fs from "node:fs";
import path from "node:path";
import { commandExists, run } from "../lib/exec.js";
import { writeLocalConfig, linkAgents } from "../lib/config.js";
import { ask, askSecret, chooseAgent } from "../lib/prompt.js";
import { resolveWorkspaceDir, writeState } from "../lib/paths.js";
import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { binaryName, platformKey } from "../lib/platform.js";
import { collectDoctor } from "./doctor.js";
import { packageVersion } from "../lib/package.js";
import { downloadReleaseAsset, findReleaseAsset, githubToken, hasGithubAuth, latestRelease } from "../lib/github.js";

const runtimeRepo = "lumi-ai-lab/harness-data";
const wikisRepo = "lumi-ai-lab/harness-data-wikis";

async function requireCommands(commands) {
  for (const command of commands) {
    if (!(await commandExists(command))) throw new Error(`missing required command: ${command}`);
  }
}

async function prepareRuntimeDir(options) {
  const runtimeDir = resolveWorkspaceDir(options.dir || process.cwd());
  fs.mkdirSync(runtimeDir, { recursive: true });
  return runtimeDir;
}

export async function installRuntimeBundle(runtimeDir, options = {}) {
  if (!options.force && fs.existsSync(path.join(runtimeDir, "agents")) &&
      fs.existsSync(path.join(runtimeDir, "config")) &&
      fs.existsSync(path.join(runtimeDir, "bootstrap", "cli-manifest.json"))) {
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
  await downloadReleaseAsset(asset, archive, options);
  if (shaAsset) {
    const shaFile = `${archive}.sha256`;
    await downloadReleaseAsset(shaAsset, shaFile, options);
    const expected = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
    const crypto = await import("node:crypto");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    if (expected && actual !== expected) throw new Error("runtime bundle sha256 mismatch");
  } else {
    console.warn("warning: runtime bundle has no sha256 asset; continuing without checksum");
  }

  const extractDir = fs.mkdtempSync(path.join(cacheDir, "runtime-"));
  await run("tar", ["-xzf", archive, "-C", extractDir], { stdio: "inherit" });
  for (const dir of ["agents", "bootstrap"]) {
    const source = path.join(extractDir, dir);
    if (!fs.existsSync(source)) throw new Error(`runtime bundle missing ${dir}/`);
    fs.rmSync(path.join(runtimeDir, dir), { recursive: true, force: true });
    fs.cpSync(source, path.join(runtimeDir, dir), { recursive: true });
  }
  const configSource = path.join(extractDir, "config");
  if (!fs.existsSync(configSource)) throw new Error("runtime bundle missing config/");
  fs.mkdirSync(path.join(runtimeDir, "config"), { recursive: true });
  for (const file of fs.readdirSync(configSource)) {
    fs.copyFileSync(path.join(configSource, file), path.join(runtimeDir, "config", file));
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
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
  if (executable(auto)) return auto;
  const value = await ask(`Path to ${name}:`, options);
  const file = path.resolve(value);
  if (!executable(file)) throw new Error(`${name} path is missing or not executable: ${file}`);
  return file;
}

async function installLocalTools(runtimeDir, options = {}) {
  const binDir = path.join(runtimeDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const installed = {};
  for (const name of ["cas-cli", "qdm-indicators-cli", "qdm-cmr-cli"]) {
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
      await run("git", ["-C", target, "pull", "--ff-only"], { stdio: "inherit" });
    } else {
      fs.rmSync(target, { recursive: true, force: true });
      await run("git", ["clone", `https://x-access-token:${githubToken(options)}@github.com/${wikisRepo}.git`, target], { stdio: "inherit" });
    }
    return { mode: "github", path: target };
  }
  if (await hasGithubAuth(options)) {
    if (fs.existsSync(path.join(target, ".git"))) {
      await run("git", ["-C", target, "pull", "--ff-only"], { stdio: "inherit" });
    } else {
      fs.rmSync(target, { recursive: true, force: true });
      await run("gh", ["repo", "clone", wikisRepo, target], { stdio: "inherit" });
    }
    return { mode: "github", path: target };
  }

  const auto = path.join(runtimeDir, "harness-data-wikis");
  const source = fs.existsSync(auto) ? auto : path.resolve(await ask("Path to harness-data-wikis:", options));
  for (const dir of ["spec", "playbooks", "templates"]) {
    if (!fs.existsSync(path.join(source, dir))) throw new Error(`harness-data-wikis missing ${dir}/: ${source}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  return { mode: "local-path", source, path: target };
}

function casConfigDir(runtimeDir) {
  return path.join(runtimeDir, ".qdm-auth", "cas");
}

async function writeCasCredentials(runtimeDir, options = {}) {
  const username = await ask("CAS username:", options);
  const password = await askSecret("CAS password:", options);
  if (!username || !password) throw new Error("CAS username and password are required");
  const dir = casConfigDir(runtimeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ cas: { username, password } }, null, 2)}\n`, { mode: 0o600 });
  return dir;
}

async function configureTokens(runtimeDir, casDir) {
  const env = { QDM_CAS_CONFIG_DIR: casDir };
  const bin = (name) => path.join(runtimeDir, "bin", binaryName(name));
  const cmrToken = (await run(bin("cas-cli"), ["token", "--app", "cmr"], { cwd: runtimeDir, env })).stdout.trim();
  await run(bin("qdm-cmr-cli"), ["config", "set-token", cmrToken], { cwd: runtimeDir, env, stdio: "inherit" });
  const indicatorsToken = (await run(bin("cas-cli"), ["token", "--app", "indicators"], { cwd: runtimeDir, env })).stdout.trim();
  await run(bin("qdm-indicators-cli"), ["config", "set-token", indicatorsToken], { cwd: runtimeDir, env, stdio: "inherit" });
  await run(bin("qdm-cmr-cli"), ["config", "check-token"], { cwd: runtimeDir, env, stdio: "inherit" });
  await run(bin("qdm-indicators-cli"), ["config", "check-token"], { cwd: runtimeDir, env, stdio: "inherit" });
}

export async function buildAndCheck(runtimeDir, options = {}) {
  const cli = path.join(runtimeDir, "bin", binaryName("data-harness-cli"));
  const result = await run(cli, ["wikis", "build-index", "--skip-checks"], { cwd: runtimeDir, stdio: "inherit", allowFailure: true });
  if (result.code !== 0) console.warn("warning: wikis build-index --skip-checks failed; continue install and retry manually later");
}

export async function installCommand(options = {}) {
  platformKey();
  await requireCommands(["git", "tar", "unzip"]);
  const runtimeDir = await prepareRuntimeDir(options);
  const bundle = await installRuntimeBundle(runtimeDir, options);
  const manifestPath = path.resolve(options.manifest || path.join(runtimeDir, "bootstrap", "cli-manifest.json"));
  const tokenMode = await hasGithubAuth(options);

  let manifest;
  let localTools = {};
  if (tokenMode) {
    manifest = await installToolsFromManifest(runtimeDir, manifestPath, options);
  } else {
    manifest = readManifest(manifestPath);
    await installToolsFromManifest(runtimeDir, manifestPath, { ...options, tools: ["data-harness-cli"] });
    localTools = await installLocalTools(runtimeDir, options);
  }

  await installWikis(runtimeDir, options);
  writeLocalConfig(runtimeDir, { overwrite: true });
  const casDir = await writeCasCredentials(runtimeDir, options);
  await configureTokens(runtimeDir, casDir);
  await buildAndCheck(runtimeDir, options);
  linkAgents(runtimeDir, await chooseAgent(options));

  const doctor = await collectDoctor(runtimeDir, { ...options, casConfigDir: casDir });
  for (const check of doctor.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
  if (doctor.checks.some((check) => !check.ok)) throw new Error("doctor failed; install is incomplete");

  writeState(runtimeDir, {
    installMode: tokenMode ? "github-token" : "local-path",
    runtimeTag: bundle.tag,
    localTools,
    tools: manifest.installedTools || {},
    manifestSha256: manifestDigest(manifest),
    packageVersion: packageVersion(),
    lastCheckAt: new Date().toISOString()
  });
  console.log(`Harness Data runtime installed: ${runtimeDir}`);
}
