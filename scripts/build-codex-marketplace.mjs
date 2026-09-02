#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDistBuildLock } from "../plugins/harness-data/scripts/dist-build-lock.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_REL = path.join("plugins", "harness-data");
const MARKETPLACE_BUNDLE_NAME = "harness-data-codex-marketplace";
const SOURCE_PLUGIN_PATHS = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  "mcp/kernel-loader.mjs",
  "mcp/runtime-resolver.mjs",
  "mcp/host-adapter.mjs",
  "mcp/local-bridge.mjs",
  "mcp/bridge-server.mjs",
  "mcp/chatgpt-desktop-adapter.mjs",
  "mcp/codex-host-adapter.mjs",
  "mcp/bridge.mjs",
  "mcp/server.mjs",
  "scripts/setup.mjs",
  "scripts/context-store.mjs",
  "scripts/dist-build-lock.mjs",
  "scripts/data-harness-cli",
  "skills/html-report/SKILL.md",
];
const RELEASE_PLUGIN_PATHS = [
  ...SOURCE_PLUGIN_PATHS,
  "bootstrap/cli-manifest.json",
  "dist/harness-data-installer/src/cli.js",
  "dist/data-harness-cli/src/main.js",
  "dist/harness-runtime-node/src/root-context.mjs",
  "dist/harness-runtime-node/src/host-context.mjs",
  "dist/harness-runtime-node/src/local-bridge.mjs",
  "dist/html-report-kernel/src/index.mjs",
];
const SETUP_MANAGED_PATHS = new Set([
  ".harness",
  ".bootstrap-cache",
  "config",
  "context.json",
  "install-manifest.json",
  "resource-manifest.json",
  "runtimes",
  "secrets",
  "resources",
]);

/**
 * Build a Codex Marketplace directory for a Release ZIP or local add.
 * The snapshot includes dist/ and must not embed private Wikis.
 */
export function buildCodexMarketplace({ outputDir, version, repo = repoRoot } = {}) {
  const sourceRoot = requireAbsoluteDirectory(repo, "repo");
  const output = requireAbsolutePath(outputDir, "outputDir");
  const pluginVersion = requireString(version, "version");
  const dist = path.join(sourceRoot, PLUGIN_REL, "dist");
  const lock = acquireDistBuildLock(dist);
  try {
    verifyCodexRepository({ repoRoot: sourceRoot });
    ensureReleaseInputs(sourceRoot);

    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    copyTree(path.join(sourceRoot, ".agents", "plugins"), path.join(output, ".agents", "plugins"));
    copyTree(path.join(sourceRoot, PLUGIN_REL), path.join(output, PLUGIN_REL));
    const targetPlugin = path.join(output, PLUGIN_REL);
    stripReleaseExcluded(targetPlugin);
    copyPluginDist(sourceRoot, targetPlugin);
    copyPluginBootstrap(sourceRoot, targetPlugin);
    const manifestPath = path.join(targetPlugin, ".codex-plugin", "plugin.json");
    const manifest = readJSON(manifestPath);
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: pluginVersion }, null, 2)}\n`);
    verifyCodexMarketplace({ outputDir: output, version: pluginVersion });
    return { outputDir: output, pluginRoot: targetPlugin, version: pluginVersion };
  } finally {
    lock.release();
  }
}

export function packCodexMarketplaceZip({ zipPath, version, repo = repoRoot, stageDir = "" } = {}) {
  const pluginVersion = requireString(version, "version");
  const zip = requireAbsolutePath(zipPath, "zipPath");
  const stage = stageDir ? requireAbsolutePath(stageDir, "stageDir") : path.join(path.dirname(zip), `${MARKETPLACE_BUNDLE_NAME}-stage`);
  const bundleDir = path.join(stage, MARKETPLACE_BUNDLE_NAME);
  rmSync(stage, { recursive: true, force: true });
  const built = buildCodexMarketplace({ outputDir: bundleDir, version: pluginVersion, repo });
  mkdirSync(path.dirname(zip), { recursive: true });
  rmSync(zip, { force: true });
  const packed = spawnSync("zip", ["-q", "-r", zip, MARKETPLACE_BUNDLE_NAME], { cwd: stage, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`zip failed: ${(packed.stderr || packed.stdout || "").trim() || packed.status}`);
  return { zipPath: zip, version: pluginVersion, outputDir: built.outputDir, pluginRoot: built.pluginRoot };
}

/** Validate Plugin source in the Git repository. dist/ and wikis are not required. */
export function verifyCodexRepository({ repoRoot: root = repoRoot, version = "" } = {}) {
  const sourceRoot = requireAbsoluteDirectory(root, "repoRoot");
  const report = verifyMarketplaceRoot(sourceRoot, {
    version,
    requiredPluginPaths: SOURCE_PLUGIN_PATHS,
    requireReleaseBundle: false,
    forbidWikis: false,
  });
  return { ...report, repoRoot: sourceRoot };
}

/** Validate a built Marketplace directory that users unzip and add locally. */
export function verifyCodexMarketplace({ outputDir, version = "" } = {}) {
  const output = requireAbsoluteDirectory(outputDir, "outputDir");
  return verifyMarketplaceRoot(output, {
    version,
    requiredPluginPaths: RELEASE_PLUGIN_PATHS,
    requireReleaseBundle: true,
    forbidWikis: true,
  });
}

function verifyMarketplaceRoot(root, { version, requiredPluginPaths, requireReleaseBundle, forbidWikis }) {
  const marketplacePath = path.join(root, ".agents", "plugins", "marketplace.json");
  const pluginRoot = path.join(root, PLUGIN_REL);
  const missing = [marketplacePath, pluginRoot]
    .filter((target) => !existsSync(target))
    .map((target) => path.relative(root, target));
  if (missing.length) throw new Error(`Codex Marketplace is incomplete: ${missing.join(", ")}`);

  const marketplace = readJSON(marketplacePath);
  if (marketplace.name !== "lumi-ai-lab") throw new Error("Marketplace name must be lumi-ai-lab");
  const plugin = marketplace.plugins?.find((item) => item?.name === "harness-data");
  if (!plugin || plugin.source?.path !== "./plugins/harness-data") {
    throw new Error("Marketplace must point to ./plugins/harness-data");
  }

  const required = requiredPluginPaths.map((relative) => path.join(PLUGIN_REL, relative));
  const missingPlugin = required.filter((relative) => !existsSync(path.join(root, relative)));
  if (missingPlugin.length) throw new Error(`Codex Plugin is missing: ${missingPlugin.join(", ")}`);

  if (forbidWikis && existsSync(path.join(pluginRoot, "resources", "wikis"))) {
    throw new Error("Codex Marketplace ZIP must not embed private Wikis");
  }

  const nativeManifest = readJSON(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  if (nativeManifest.name !== "harness-data") throw new Error(`Plugin name must be harness-data: ${nativeManifest.name || "missing"}`);
  if (version && nativeManifest.version !== version) {
    throw new Error(`Plugin version mismatch: ${nativeManifest.version} != ${version}`);
  }
  if (requireReleaseBundle) assertNoUnsafePluginEntries(pluginRoot);
  return {
    outputDir: root,
    pluginRoot,
    version: String(nativeManifest.version || ""),
    requiredPaths: required.length,
  };
}

function ensureReleaseInputs(sourceRoot) {
  const distMain = path.join(sourceRoot, PLUGIN_REL, "dist", "data-harness-cli", "src", "main.js");
  if (!existsSync(distMain)) {
    throw new Error("Plugin dist is missing; run plugins/harness-data/scripts/bundle-dist.mjs first");
  }
  const bootstrap = path.join(sourceRoot, "bootstrap", "cli-manifest.json");
  const pluginBootstrap = path.join(sourceRoot, PLUGIN_REL, "bootstrap", "cli-manifest.json");
  if (!existsSync(bootstrap) && !existsSync(pluginBootstrap)) {
    throw new Error("missing bootstrap/cli-manifest.json");
  }
}

function copyPluginDist(sourceRoot, targetPlugin) {
  const dest = path.join(targetPlugin, "dist");
  rmSync(dest, { recursive: true, force: true });
  copyTree(path.join(sourceRoot, PLUGIN_REL, "dist"), dest);
}

function copyPluginBootstrap(sourceRoot, targetPlugin) {
  const dest = path.join(targetPlugin, "bootstrap", "cli-manifest.json");
  const source = [
    path.join(sourceRoot, PLUGIN_REL, "bootstrap", "cli-manifest.json"),
    path.join(sourceRoot, "bootstrap", "cli-manifest.json"),
  ].find((candidate) => existsSync(candidate));
  if (!source) throw new Error("missing bootstrap/cli-manifest.json");
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(source, dest);
}

function stripReleaseExcluded(pluginRoot) {
  for (const relative of SETUP_MANAGED_PATHS) {
    rmSync(path.join(pluginRoot, relative), { recursive: true, force: true });
  }
}

function assertNoUnsafePluginEntries(pluginRoot) {
  for (const relative of SETUP_MANAGED_PATHS) {
    if (existsSync(path.join(pluginRoot, relative))) {
      throw new Error(`Plugin source contains setup-managed path: ${path.join(PLUGIN_REL, relative)}`);
    }
  }
  walkPlugin(pluginRoot, "");
}

function walkPlugin(root, relative) {
  const directory = path.join(root, relative);
  for (const name of readdirSync(directory).sort()) {
    const childRelative = relative ? path.join(relative, name) : name;
    const child = path.join(root, childRelative);
    const info = lstatSync(child);
    if (info.isSymbolicLink()) throw new Error(`Plugin source must not contain a symlink: ${childRelative}`);
    if (info.isDirectory()) {
      if (name === "test" || name === "tests" || name === "node_modules" || name === ".git") continue;
      walkPlugin(root, childRelative);
      continue;
    }
    if (!info.isFile()) throw new Error(`Plugin source entry must be a regular file: ${childRelative}`);
    if (info.size > 2 * 1024 * 1024) continue;
    const content = readFileSync(child, "utf8");
    if (/qdm1enc\.[A-Za-z0-9_-]+/.test(content)) throw new Error(`Plugin source contains secret-like content: ${childRelative}`);
    if (findBuildMachinePath(content)) throw new Error(`Plugin source contains a build-machine path: ${childRelative}`);
  }
}

function findBuildMachinePath(text) {
  return text.match(/(?:\/Users\/[A-Za-z0-9._-]+\/[^\s"'`]+|\/home\/[A-Za-z0-9._-]+\/[^\s"'`]+|[A-Za-z]:[\\/]Users[\\/][^\s"'`]+)/i)?.[0] || "";
}

function copyTree(source, destination) {
  if (!existsSync(source)) throw new Error(`missing source tree: ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (current) => {
      const name = path.basename(current);
      return name !== ".git" && name !== ".harness" && name !== "node_modules" && name !== "test" && name !== "tests" &&
        name !== "dist.lock" && !name.startsWith("dist.tmp-") && !name.startsWith("dist.previous-");
    },
  });
}

function requireAbsoluteDirectory(value, label) {
  const resolved = requireAbsolutePath(value, label);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`${label} does not exist: ${resolved}`);
  return resolved;
}

function requireAbsolutePath(value, label) {
  const text = requireString(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(text);
}

function requireString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function readJSON(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = String(rest[index]);
    if (token === "--output-dir") {
      options.outputDir = String(rest[++index] || "");
      continue;
    }
    if (token === "--version") {
      options.version = String(rest[++index] || "");
      continue;
    }
    if (token === "--repo-root") {
      options.repoRoot = String(rest[++index] || "");
      continue;
    }
    if (token === "--zip") {
      options.zipPath = String(rest[++index] || "");
      continue;
    }
    if (token === "-h" || token === "--help") {
      throw new Error("usage: node scripts/build-codex-marketplace.mjs <build|pack|verify> [--output-dir PATH | --repo-root PATH] [--zip PATH] [--version VERSION]");
    }
    throw new Error(`unknown option: ${token}`);
  }
  if (!["build", "pack", "verify"].includes(command)) {
    throw new Error("usage: node scripts/build-codex-marketplace.mjs <build|pack|verify> [--output-dir PATH | --repo-root PATH] [--zip PATH] [--version VERSION]");
  }
  if (command === "build" && !options.outputDir) throw new Error("--output-dir is required for build");
  if (command === "pack" && !options.zipPath) throw new Error("--zip is required for pack");
  if (command === "verify" && !options.outputDir && !options.repoRoot) {
    throw new Error("verify requires --output-dir or --repo-root");
  }
  if ((command === "build" || command === "pack") && !options.version) throw new Error("--version is required");
  return { command, options };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArgs(argv);
    const result = command === "build"
      ? buildCodexMarketplace(options)
      : command === "pack"
        ? packCodexMarketplaceZip(options)
        : (options.repoRoot ? verifyCodexRepository({ repoRoot: options.repoRoot, version: options.version }) : verifyCodexMarketplace(options));
    process.stdout.write(`codex marketplace ${command} ok: ${result.zipPath || result.outputDir || result.repoRoot}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`error: ${error?.message || error}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
