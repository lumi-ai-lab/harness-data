#!/usr/bin/env node

// Build the QwenPaw native Plugin ZIP from the repository source tree.
//
// The ZIP follows the QwenPaw plugin contract (plugin.json at the archive
// root) and ships only executable plugin code: adapter sources, skills, the
// bundled JS packages under dist/, bootstrap/cli-manifest.json and a
// generated plugin-manifest.json binding the Harness core.  Private wikis,
// metric-cli, secrets, state, config and tests are intentionally excluded;
// setup downloads/creates them into the instanceRoot after install.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePluginManifest } from "./build-plugin-manifest.mjs";
import { validatePluginManifest } from "../packages/data-harness-cli/src/lib/plugin-manifest.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QWENPAW_SOURCE = path.join(REPO_ROOT, ".agents", "qwenpaw");
const PLUGIN_NAME = "qdm-harness-qwenpaw";
const INSTALLER_PACKAGE = "harness-data-installer";

const ADAPTER_REQUIRED = [
  "plugin.json",
  "plugin.py",
  "qdm_cli.py",
  "qdm_harness_context.py",
  "qdm_channel_auth.py",
  "qdm_config.py",
  "qdm_identity.py",
  "qdm_report_lifecycle.py",
  "qdm_runtime_hooks.py",
  "skills/qdm-harness/SKILL.md",
];

const CORE_PACKAGES = ["data-harness-cli", "harness-runtime-node", "html-report-kernel"];

const FORBIDDEN_TOP_LEVEL = [
  "resources",
  "wikis",
  ".harness",
  "config",
  "secrets",
  "state",
  "context.json",
  "install-manifest.json",
  "resource-manifest.json",
];

function includeAdapterFile(source) {
  const name = path.basename(source);
  if (name === "__pycache__" || name === "tests") return false;
  if (name.endsWith(".pyc")) return false;
  if (name === "config") return false;
  if (/^(INSTALL-|prepare-)/.test(name)) return false;
  if (name === "install-qwenpaw-plugin.py") return false;
  if (/\.(ps1|cmd)$/i.test(name)) return false;
  if (name.startsWith("DOCKER-") || name === "QWENPAW-PRODUCTION-INSTALL-GUIDE.md") return false;
  if (/\.(test|spec)\.py$/i.test(name)) return false;
  return true;
}

function includeDistFile(source) {
  const name = path.basename(source);
  return name !== "test" && name !== "tests" && !/\.(?:test|spec)\.(?:[cm]?[jt]s|ts)$/i.test(name);
}

export function stageQwenPawPlugin({ artifactRoot, version = "", repoRoot = REPO_ROOT } = {}) {
  const target = resolveAbsolutePath(artifactRoot, "artifactRoot");
  const source = requireAbsoluteDirectory(QWENPAW_SOURCE, "QwenPaw source");
  const root = requireAbsoluteDirectory(repoRoot, "repoRoot");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  cpSync(source, target, { recursive: true, filter: includeAdapterFile });

  const requestedVersion = String(version || "").trim().replace(/^v/, "");
  if (requestedVersion) {
    const pluginPath = path.join(target, "plugin.json");
    const plugin = readJSON(pluginPath, "plugin.json");
    writeFileSync(pluginPath, `${JSON.stringify({ ...plugin, version: requestedVersion }, null, 2)}\n`);
  }

  const dist = path.join(target, "dist");
  mkdirSync(dist, { recursive: true });
  for (const name of CORE_PACKAGES) {
    cpSync(path.join(root, "packages", name), path.join(dist, name), { recursive: true, filter: includeDistFile });
  }
  cpSync(path.join(root, "npm"), path.join(dist, INSTALLER_PACKAGE), {
    recursive: true,
    filter: includeDistFile,
  });

  const bootstrap = path.join(target, "bootstrap");
  mkdirSync(bootstrap, { recursive: true });
  copyFileSync(path.join(root, "bootstrap", "cli-manifest.json"), path.join(bootstrap, "cli-manifest.json"));

  const scripts = path.join(target, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const [name, content] of [
    ["data-harness-cli", coreCliShim()],
    ["harness-data", lifecycleCliShim()],
  ]) {
    writeFileSync(path.join(scripts, name), content, { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(path.join(scripts, name), 0o755);
  }

  const manifest = path.join(target, "plugin-manifest.json");
  writeFileSync(manifest, `${JSON.stringify(buildPluginManifestRecord({ artifactRoot: target, version }), null, 2)}\n`);
  return { artifactRoot: target, version: resolvedVersion(target, version) };
}

function buildPluginManifestRecord({ artifactRoot, version }) {
  return writePluginManifest({
    artifactRoot,
    host: "qwenpaw",
    pluginVersion: resolvedVersion(artifactRoot, version),
    resourceMode: "external",
  }).manifest;
}

function executableNodeShim(relativeEntry, { host = "", fullArgv = false } = {}) {
  return [
    "#!/usr/bin/env node",
    'const path = require("node:path");',
    'const { pathToFileURL } = require("node:url");',
    "(async () => {",
    "  const pluginRoot = path.dirname(path.dirname(__filename));",
    '  process.env.HARNESS_PLUGIN_ROOT = pluginRoot;',
    ...(host ? [`  process.env.HARNESS_HOST = ${JSON.stringify(host)};`] : []),
    `  const entry = pathToFileURL(path.join(pluginRoot, ...${JSON.stringify(relativeEntry.split("/"))})).href;`,
    "  const { main } = await import(entry);",
    `  await main(${fullArgv ? "process.argv" : ""});`,
    "})().catch((error) => {",
    '  process.stderr.write(`error: ${error?.message || error}\\n`);',
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n");
}

function coreCliShim() {
  return executableNodeShim("dist/data-harness-cli/src/main.js", { host: "qwenpaw" });
}

function lifecycleCliShim() {
  return executableNodeShim(`dist/${INSTALLER_PACKAGE}/src/cli.js`, { fullArgv: true });
}

export function resolvedVersion(artifactRoot, version) {
  if (String(version || "").trim()) return String(version).trim().replace(/^v/, "");
  const plugin = readJSON(path.join(artifactRoot, "plugin.json"), "plugin.json");
  return requiredString(plugin.version, "plugin.json.version");
}

export function verifyQwenPawPlugin({ artifactRoot, version = "" } = {}) {
  const root = requireAbsoluteDirectory(artifactRoot, "artifactRoot");
  const expectedVersion = String(version || "").trim().replace(/^v/, "");
  const plugin = readJSON(path.join(root, "plugin.json"), "plugin.json");
  if (expectedVersion && String(plugin.version || "") !== expectedVersion) {
    throw new Error(`plugin.json version ${plugin.version} does not match ${expectedVersion}`);
  }
  for (const relative of ADAPTER_REQUIRED) {
    if (!existsSync(path.join(root, ...relative.split("/")))) {
      throw new Error(`QwenPaw plugin is missing required path: ${relative}`);
    }
  }
  const cliMain = path.join(root, "dist", "data-harness-cli", "src", "main.js");
  if (!existsSync(cliMain)) throw new Error(`QwenPaw plugin is missing dist CLI main: ${cliMain}`);
  const lifecycleMain = path.join(root, "dist", INSTALLER_PACKAGE, "src", "cli.js");
  if (!existsSync(lifecycleMain)) {
    throw new Error(`QwenPaw plugin is missing lifecycle CLI main: ${lifecycleMain}`);
  }
  for (const name of ["harness-runtime-node", "html-report-kernel"]) {
    if (!existsSync(path.join(root, "dist", name, "package.json"))) {
      throw new Error(`QwenPaw plugin is missing dist package: ${name}`);
    }
  }
  const shim = path.join(root, "scripts", "data-harness-cli");
  if (!existsSync(shim)) throw new Error("QwenPaw plugin is missing scripts/data-harness-cli");
  if (!existsSync(path.join(root, "scripts", "harness-data"))) {
    throw new Error("QwenPaw plugin is missing scripts/harness-data");
  }

  const manifestPath = path.join(root, "plugin-manifest.json");
  const manifest = readJSON(manifestPath, "plugin-manifest.json");
  if (manifest.host !== "qwenpaw") throw new Error(`plugin manifest host must be qwenpaw: ${manifest.host}`);
  if (expectedVersion && String(manifest.plugin?.version || "") !== expectedVersion) {
    throw new Error(`plugin manifest version ${manifest.plugin?.version} does not match ${expectedVersion}`);
  }
  if (manifest.resource?.mode !== "external") {
    throw new Error(`QwenPaw plugin resource mode must be external: ${manifest.resource?.mode}`);
  }
  validatePluginManifest(manifest);

  const forbidden = findForbidden(root);
  if (forbidden.length) {
    throw new Error(`QwenPaw plugin contains non-release content: ${forbidden.join(", ")}`);
  }
  return { artifactRoot: root, version: String(plugin.version), requiredPaths: ADAPTER_REQUIRED.length };
}

function findForbidden(root) {
  const found = [];
  for (const name of readdirSync(root)) {
    if (name === ".git") continue;
    if (FORBIDDEN_TOP_LEVEL.includes(name) || name === "tests" || name === "__pycache__") {
      found.push(name);
    }
  }
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      if (name === ".git") continue;
      const entry = path.join(directory, name);
      if (name === "__pycache__" || name.endsWith(".pyc")) {
        found.push(path.relative(root, entry));
        continue;
      }
      if (name === "tests" && statSync(entry).isDirectory()) {
        found.push(path.relative(root, entry));
        continue;
      }
      if (statSync(entry).isDirectory()) visit(entry);
    }
  };
  for (const name of readdirSync(root)) {
    const entry = path.join(root, name);
    if (statSync(entry).isDirectory() && !["dist", "scripts", "bootstrap", "skills"].includes(name)) visit(entry);
  }
  return found;
}

export function packQwenPawZip({ artifactRoot, zipPath, version = "" } = {}) {
  const root = requireAbsoluteDirectory(artifactRoot, "artifactRoot");
  const target = requireAbsolutePath(zipPath, "zipPath");
  mkdirSync(path.dirname(target), { recursive: true });
  rmSync(target, { force: true });
  const packed = spawnSync("zip", ["-q", "-r", target, "."], { cwd: root, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`zip failed: ${(packed.stderr || packed.stdout || "").trim() || packed.status}`);
  return { zipPath: target, version: resolvedVersion(root, version) };
}

function requireAbsoluteDirectory(value, label) {
  const text = requiredString(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be an absolute path`);
  const resolved = path.resolve(text);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`${label} does not exist: ${resolved}`);
  return resolved;
}

function resolveAbsolutePath(value, label) {
  const text = requiredString(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(text);
}

function requireAbsolutePath(value, label) {
  const text = requiredString(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(text);
}

function readJSON(filePath, label) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error?.message || error}`);
  }
}

function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--")) throw new Error(`unknown argument: ${token}`);
    const [name, inline] = token.slice(2).split("=", 2);
    if (!["version", "output-dir", "zip", "stage-only", "verify"].includes(name)) {
      throw new Error(`unknown option: --${name}`);
    }
    if (name === "stage-only" || name === "verify") {
      options[name] = inline === undefined ? true : inline !== "false";
      continue;
    }
    const value = inline ?? argv[++index];
    if (value == null || String(value).startsWith("--")) throw new Error(`--${name} requires a value`);
    options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const outputDir = options.outputDir ? path.resolve(options.outputDir) : path.join(REPO_ROOT, "dist");
    const stage = path.join(outputDir, PLUGIN_NAME);
    const report = stageQwenPawPlugin({ artifactRoot: stage, version: options.version });
    verifyQwenPawPlugin({ artifactRoot: stage, version: options.version });
    if (options.verify) {
      process.stdout.write(`verified ${stage} (v${report.version})\n`);
      return 0;
    }
    const zipPath = options.zip ? path.resolve(options.zip) : path.join(outputDir, `harness-data-qwenpaw-plugin-v${report.version}.zip`);
    packQwenPawZip({ artifactRoot: stage, zipPath, version: report.version });
    process.stdout.write(`built ${zipPath} (v${report.version})\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`error: ${error?.message || error}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
