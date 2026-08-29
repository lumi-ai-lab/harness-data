#!/usr/bin/env node

// Internal adapter validation helper. The current public installation path is
// the Codex Plugin from the main repository Marketplace.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildHostArtifact } from "./host-artifact.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MARKETPLACE_NAME = "lumi-ai-lab";
const EXCLUDED_STAGE_ENTRIES = new Set([
  "adapter",
  "host-artifact-contract.mjs",
  "host-artifact.json",
  "self-test.mjs",
]);

/**
 * Build a Claude Code marketplace directory containing a native plugin root
 * and the common runtime/core files required by its hooks.
 *
 * The generic host-artifact envelope remains useful for the cross-host matrix,
 * but Claude installs a plugin from its own root. This builder flattens the
 * Claude adapter into that root and emits the marketplace manifest alongside
 * it, so `claude plugin marketplace add <output>` is directly usable.
 */
export function buildClaudeMarketplace({
  outputDir,
  version,
  marketplaceName = DEFAULT_MARKETPLACE_NAME,
  repoRoot = REPO_ROOT,
} = {}) {
  const root = requireAbsoluteDirectory(repoRoot, "repoRoot");
  const output = requireAbsolutePath(outputDir, "outputDir");
  const pluginVersion = requiredString(version, "version");
  const name = requiredString(marketplaceName, "marketplaceName");
  mkdirSync(output, { recursive: true });

  const stagingRoot = mkdtempSync(path.join(tmpdir(), "qdm-claude-marketplace-stage-"));
  const genericRoot = path.join(stagingRoot, "claude");
  const pluginRoot = path.join(output, "qdm-harness-claude");
  try {
    buildHostArtifact({
      host: "claude",
      artifactRoot: genericRoot,
      version: pluginVersion,
      selfTest: true,
      repoRoot: root,
    });

    rmSync(pluginRoot, { recursive: true, force: true });
    mkdirSync(pluginRoot, { recursive: true });
    copyStageFiles(genericRoot, pluginRoot);
    copyTree(path.join(genericRoot, "adapter", ".claude-plugin"), path.join(pluginRoot, ".claude-plugin"));
    copyTree(path.join(genericRoot, "adapter", "hooks"), path.join(pluginRoot, "hooks"));
    copyFile(path.join(genericRoot, "adapter", "settings.json"), path.join(pluginRoot, "settings.json"));

    const pluginManifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
    const pluginManifest = readJSON(pluginManifestPath, "Claude plugin manifest");
    if (pluginManifest.version !== pluginVersion) {
      throw new Error(`Claude plugin version mismatch: ${pluginManifest.version} !== ${pluginVersion}`);
    }

    const marketplaceRoot = path.join(output, ".claude-plugin");
    mkdirSync(marketplaceRoot, { recursive: true });
    writeJSON(path.join(marketplaceRoot, "marketplace.json"), {
      name,
      owner: { name: "Lumi AI Lab" },
      plugins: [{
        name: pluginManifest.name,
        source: "./qdm-harness-claude",
        description: pluginManifest.description,
        author: pluginManifest.author,
        category: "Engineering",
      }],
    });

    const report = verifyClaudeMarketplace(output, { marketplaceName: name, pluginVersion });
    if (report.errors.length) {
      throw new Error(`Claude marketplace verification failed: ${report.errors.join("; ")}`);
    }
    return { outputDir: output, pluginRoot, marketplaceRoot, marketplaceName: name, pluginVersion, ...report };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function verifyClaudeMarketplace(outputDir, { marketplaceName = "", pluginVersion = "" } = {}) {
  const root = requireAbsoluteDirectory(outputDir, "outputDir");
  const errors = [];
  const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
  const pluginRoot = path.join(root, "qdm-harness-claude");
  const pluginManifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const marketplace = readJSONOptional(marketplacePath, "Claude marketplace manifest", errors);
  const plugin = readJSONOptional(pluginManifestPath, "Claude plugin manifest", errors);

  if (marketplace) {
    if (marketplaceName && marketplace.name !== marketplaceName) errors.push(`marketplace name must be ${marketplaceName}`);
    if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) errors.push("marketplace must declare exactly one plugin");
    const entry = marketplace.plugins?.[0];
    if (entry?.source !== "./qdm-harness-claude") errors.push("marketplace plugin source must be ./qdm-harness-claude");
  }
  if (plugin) {
    if (plugin.name !== "qdm-harness-claude") errors.push(`unexpected Claude plugin name: ${plugin.name}`);
    if (pluginVersion && plugin.version !== pluginVersion) errors.push(`plugin version must be ${pluginVersion}`);
  }

  for (const relative of [
    "qdm-harness-claude/.claude-plugin/plugin.json",
    "qdm-harness-claude/hooks/hooks.json",
    "qdm-harness-claude/settings.json",
    "qdm-harness-claude/scripts/data-harness-cli",
    "qdm-harness-claude/bin/data-harness-cli",
    "qdm-harness-claude/vendor/data-harness-cli/src/main.js",
    "qdm-harness-claude/vendor/html-report-kernel/src/index.mjs",
    "qdm-harness-claude/vendor/harness-runtime-node/src/index.mjs",
    "qdm-harness-claude/skills/html-report/SKILL.md",
    "qdm-harness-claude/skills/qdm-harness/SKILL.md",
    "qdm-harness-claude/plugin-manifest.json",
  ]) {
    if (!existsSync(path.join(root, relative))) errors.push(`missing required Claude marketplace path: ${relative}`);
  }

  return { root, pluginRoot, errors };
}

function copyStageFiles(source, destination) {
  for (const name of readdirSync(source)) {
    if (EXCLUDED_STAGE_ENTRIES.has(name)) continue;
    copyEntry(path.join(source, name), path.join(destination, name));
  }
}

function copyEntry(source, destination) {
  const info = statSync(source);
  if (info.isDirectory()) copyTree(source, destination);
  else copyFile(source, destination);
}

function copyTree(source, destination) {
  if (!existsSync(source)) throw new Error(`missing source tree: ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function copyFile(source, destination) {
  if (!existsSync(source)) throw new Error(`missing source file: ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination);
}

function writeJSON(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJSON(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error?.message || error}`);
  }
}

function readJSONOptional(filePath, label, errors) {
  if (!existsSync(filePath)) {
    errors.push(`missing ${label}: ${filePath}`);
    return null;
  }
  try {
    return readJSON(filePath, label);
  } catch (error) {
    errors.push(error.message);
    return null;
  }
}

function requireAbsoluteDirectory(value, label) {
  const root = requireAbsolutePath(value, label);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${label} does not exist: ${root}`);
  return root;
}

function requireAbsolutePath(value, label) {
  const text = requiredString(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(text);
}

function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const [command = "", ...rest] = argv;
    const options = parseArgs(rest);
    if (command === "build") {
      const report = buildClaudeMarketplace(options);
      process.stdout.write(`Claude marketplace built: ${report.outputDir}\n`);
      return 0;
    }
    if (command === "verify") {
      const report = verifyClaudeMarketplace(options.outputDir, options);
      if (report.errors.length) throw new Error(report.errors.join("; "));
      process.stdout.write(`Claude marketplace verified: ${report.root}\n`);
      return 0;
    }
    throw new Error("usage: node scripts/build-claude-marketplace.mjs <build|verify> --output-dir PATH --version VERSION [--marketplace-name NAME]");
  } catch (error) {
    process.stderr.write(`error: ${error?.message || error}\n`);
    return 1;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--output-dir") options.outputDir = String(argv[++index] || "");
    else if (token === "--version") options.version = String(argv[++index] || "");
    else if (token === "--marketplace-name") options.marketplaceName = String(argv[++index] || "");
    else if (token === "-h" || token === "--help") throw new Error("usage: node scripts/build-claude-marketplace.mjs <build|verify> --output-dir PATH --version VERSION [--marketplace-name NAME]");
    else throw new Error(`unknown option: ${token}`);
  }
  if (!options.outputDir) throw new Error("--output-dir is required");
  if (!options.version) throw new Error("--version is required");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
