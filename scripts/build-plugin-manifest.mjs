#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CORE_API_VERSION,
  PLUGIN_MANIFEST_REL,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  QDM_HARNESS_PRODUCT,
  STATE_SCHEMA_VERSION,
  validatePluginManifest,
} from "../packages/data-harness-cli/src/lib/plugin-manifest.js";

const PACKAGE_CANDIDATES = {
  dataHarnessCli: [
    "packages/data-harness-cli/package.json",
    "vendor/data-harness-cli/package.json",
    "vendor/data-harness-cli/package.json",
  ],
  htmlReportKernel: [
    "packages/html-report-kernel/package.json",
    "vendor/html-report-kernel/package.json",
    "dist/html-report-kernel/package.json",
    "html-report-kernel/package.json",
  ],
  harnessRuntimeNode: [
    "packages/harness-runtime-node/package.json",
    "vendor/harness-runtime-node/package.json",
    "dist/harness-runtime-node/package.json",
    "harness-runtime-node/package.json",
  ],
};

export function buildPluginManifest({
  artifactRoot,
  host,
  pluginName = "",
  pluginVersion = "",
  resourceMode = "auto",
  resourceRoot = "",
} = {}) {
  const root = requireAbsoluteDirectory(artifactRoot, "artifactRoot");
  const selectedHost = requiredString(host, "host");
  const plugin = discoverPlugin(root, { pluginName, pluginVersion });
  const packages = discoverCorePackages(root);
  assertRequiredCorePackages(selectedHost, packages, root);
  const resource = discoverResource(root, { resourceMode, resourceRoot });
  const metricCli = discoverMetricCli(root);
  const manifest = {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    product: QDM_HARNESS_PRODUCT,
    host: selectedHost,
    plugin,
    core: {
      apiVersion: CORE_API_VERSION,
      packages,
    },
    resource,
    metricCli,
    state: { schemaVersion: STATE_SCHEMA_VERSION },
    compatibility: {
      node: ">=18",
      coreApi: CORE_API_VERSION,
      resourceSchema: 1,
      stateSchema: STATE_SCHEMA_VERSION,
    },
  };
  validatePluginManifest(manifest);
  return manifest;
}

export function writePluginManifest(options = {}) {
  const root = requireAbsoluteDirectory(options.artifactRoot, "artifactRoot");
  const manifest = buildPluginManifest({ ...options, artifactRoot: root });
  const output = options.out ? resolveOutput(root, options.out) : path.join(root, PLUGIN_MANIFEST_REL);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: output, manifest };
}

function discoverPlugin(root, overrides) {
  const hostManifest = readJSONOptional(root, [
    ".codex-plugin/plugin.json",
    "agents/codex/.codex-plugin/plugin.json",
    "manifest.json",
  ]);
  return {
    name: requiredString(overrides.pluginName || hostManifest?.name || "", "pluginName"),
    version: requiredString(overrides.pluginVersion || hostManifest?.version || "", "pluginVersion"),
  };
}

function discoverCorePackages(root) {
  const packages = {};
  for (const [key, candidates] of Object.entries(PACKAGE_CANDIDATES)) {
    const pkg = readJSONOptional(root, candidates);
    if (!pkg?.name || !pkg?.version) continue;
    packages[key] = { name: String(pkg.name), version: String(pkg.version) };
  }
  return packages;
}

function assertRequiredCorePackages(host, packages, root) {
  const required = {
    runtime: ["dataHarnessCli", "htmlReportKernel", "harnessRuntimeNode"],
    pi: ["htmlReportKernel", "harnessRuntimeNode"],
    codex: ["htmlReportKernel", "harnessRuntimeNode"],
    claude: ["dataHarnessCli", "htmlReportKernel", "harnessRuntimeNode"],
    workbuddy: ["dataHarnessCli", "htmlReportKernel", "harnessRuntimeNode"],
    qwenpaw: ["dataHarnessCli", "htmlReportKernel", "harnessRuntimeNode"],
    hermes: ["dataHarnessCli", "htmlReportKernel", "harnessRuntimeNode"],
    openclaw: ["dataHarnessCli", "htmlReportKernel", "harnessRuntimeNode"],
  }[host] || [];
  if (!Object.keys(packages).length) {
    throw new Error(`cannot build plugin manifest: no core package metadata found in ${root}`);
  }
  const missing = required.filter((name) => !packages[name]);
  if (missing.length) {
    throw new Error(`cannot build plugin manifest: missing required core package metadata for ${host}: ${missing.join(", ")}`);
  }
}

function discoverResource(root, { resourceMode, resourceRoot }) {
  const selectedRoot = resourceRoot ? requireAbsoluteDirectory(resourceRoot, "resourceRoot") : root;
  const filePath = path.join(selectedRoot, "resource-manifest.json");
  const hasManifest = existsSync(filePath);
  const mode = String(resourceMode || "auto").trim().toLowerCase();
  if (!["auto", "embedded", "external"].includes(mode)) {
    throw new Error(`resourceMode must be auto, embedded, or external: ${resourceMode}`);
  }
  if (mode === "embedded" && !hasManifest) {
    throw new Error(`embedded resource manifest is missing: ${filePath}`);
  }
  if (mode === "external" || (!hasManifest && mode === "auto")) {
    return {
      mode: "external",
      resourceId: "qdm-harness-wiki",
      schemaVersion: 1,
      contentVersion: "",
    };
  }

  const resourceManifest = readJSON(filePath, "resource manifest");
  const relative = toSafeRelative(root, filePath);
  return {
    mode: "embedded",
    manifest: `./${relative}`,
    resourceId: requiredString(resourceManifest.resourceId, "resourceManifest.resourceId"),
    schemaVersion: Number(resourceManifest.resourceSchemaVersion),
    contentVersion: requiredString(resourceManifest.wikiContentVersion, "resourceManifest.wikiContentVersion"),
  };
}

function discoverMetricCli(root) {
  const manifest = readJSONOptional(root, ["bootstrap/cli-manifest.json"]);
  const tool = (manifest?.tools || []).find((item) => item?.name === "qdm-metric-cli") || {};
  return {
    binary: String(tool.binary || "qdm-metric-cli"),
    version: String(tool.version || ""),
  };
}

function readJSONOptional(root, candidates) {
  for (const relative of candidates) {
    const filePath = path.join(root, ...relative.split("/"));
    if (!existsSync(filePath)) continue;
    return readJSON(filePath, relative);
  }
  return null;
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

function requireAbsoluteDirectory(value, label) {
  const text = requiredString(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be an absolute path`);
  const resolved = path.resolve(text);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  return resolved;
}

function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function resolveOutput(root, output) {
  const target = path.isAbsolute(output) ? path.resolve(output) : path.resolve(root, output);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("output path must stay inside artifactRoot");
  }
  return target;
}

function toSafeRelative(root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("resource manifest must be inside artifactRoot for embedded resource mode");
  }
  return relative;
}

function parseArgs(argv) {
  const options = { resourceMode: "auto" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--")) throw new Error(`unknown argument: ${token}`);
    const [name, inline] = token.slice(2).split("=", 2);
    if (!["artifact-root", "host", "plugin-name", "plugin-version", "resource-mode", "resource-root", "out"].includes(name)) {
      throw new Error(`unknown option: --${name}`);
    }
    const value = inline ?? argv[++index];
    if (value == null || String(value).startsWith("--")) throw new Error(`--${name} requires a value`);
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = String(value);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const result = writePluginManifest(parseArgs(argv));
    process.stdout.write(`built ${result.path}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`error: ${error?.message || error}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
