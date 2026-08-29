#!/usr/bin/env node
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePluginManifest } from "./build-plugin-manifest.mjs";
import {
  HOST_ARTIFACT_HOSTS,
  hostArtifactKind,
  requiredPathsForHost,
  requireHostArtifactSpec,
} from "./host-artifact-contract.mjs";
import { selfTestHostArtifact } from "./host-artifact-self-test.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT_NAMES = new Set([".agents", "bootstrap", "config", "npm", "packages", "plugins", "scripts", "wikis"]);
const PRUNED_DIRECTORIES = new Set([".git", ".harness", "node_modules", "test", "tests"]);

export function buildHostArtifacts({ host, outputDir, version, selfTest = true, repoRoot = REPO_ROOT } = {}) {
  const selectedHosts = selectHosts(host);
  const root = requireAbsoluteDirectory(repoRoot, "repoRoot");
  const output = requireOutputDirectory(outputDir, root);
  const pluginVersion = requireString(version, "version");
  const reports = [];
  for (const selectedHost of selectedHosts) {
    reports.push(buildHostArtifact({
      host: selectedHost,
      artifactRoot: path.join(output, selectedHost),
      version: pluginVersion,
      selfTest,
      repoRoot: root,
    }));
  }
  return reports;
}

export function buildHostArtifact({ host, artifactRoot, version, selfTest = true, repoRoot = REPO_ROOT } = {}) {
  const spec = requireHostArtifactSpec(host);
  const root = requireAbsoluteDirectory(repoRoot, "repoRoot");
  const target = requireArtifactTarget(artifactRoot, root);
  const pluginVersion = requireString(version, "version");

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  stageCommonFiles(root, target);
  stageAdapter(root, target, spec);
  copyFileSync(path.join(root, "scripts", "host-artifact-contract.mjs"), path.join(target, "host-artifact-contract.mjs"));
  copyFileSync(path.join(root, "scripts", "host-artifact-self-test.mjs"), path.join(target, "self-test.mjs"));

  const descriptor = {
    schemaVersion: 1,
    host: spec.host,
    plugin: { name: spec.pluginName, version: pluginVersion },
    adapter: { root: "adapter", manifest: spec.adapterManifest },
    requiredPaths: requiredPathsForHost(spec.host),
  };
  writeJSON(path.join(target, "host-artifact.json"), descriptor);
  writePluginManifest({
    artifactRoot: target,
    host: spec.host,
    pluginName: spec.pluginName,
    pluginVersion,
    resourceMode: "external",
  });

  const verification = verifyArtifact(target, { kind: hostArtifactKind(spec.host) });
  if (verification.errors.length) {
    throw new Error(`host artifact verification failed for ${spec.host}: ${verification.errors.join("; ")}`);
  }
  const selfTestReport = selfTest ? selfTestHostArtifact({ artifactRoot: target, host: spec.host }) : null;
  return { host: spec.host, artifactRoot: target, verification, selfTest: selfTestReport };
}

export function verifyHostArtifacts({ host, artifactRoot } = {}) {
  const selectedHosts = selectHosts(host);
  const root = requireAbsoluteDirectory(artifactRoot, "artifactRoot");
  return selectedHosts.map((selectedHost) => {
    const target = selectedHosts.length === 1 ? root : path.join(root, selectedHost);
    const report = verifyArtifact(target, { kind: hostArtifactKind(selectedHost) });
    if (report.errors.length) throw new Error(`host artifact verification failed for ${selectedHost}: ${report.errors.join("; ")}`);
    return { host: selectedHost, artifactRoot: target, verification: report };
  });
}

export function selfTestHostArtifacts({ host, artifactRoot } = {}) {
  const selectedHosts = selectHosts(host);
  const root = requireAbsoluteDirectory(artifactRoot, "artifactRoot");
  return selectedHosts.map((selectedHost) => {
    const target = selectedHosts.length === 1 ? root : path.join(root, selectedHost);
    return selfTestHostArtifact({ artifactRoot: target, host: selectedHost });
  });
}

function stageCommonFiles(repoRoot, target) {
  copyTree(path.join(repoRoot, "packages", "data-harness-cli"), path.join(target, "vendor", "data-harness-cli"));
  copyTree(path.join(repoRoot, "packages", "html-report-kernel"), path.join(target, "vendor", "html-report-kernel"));
  copyTree(path.join(repoRoot, "packages", "harness-runtime-node"), path.join(target, "vendor", "harness-runtime-node"));
  copyFile(path.join(repoRoot, "bootstrap", "cli-manifest.json"), path.join(target, "bootstrap", "cli-manifest.json"));
  copyTree(path.join(repoRoot, "plugins", "qdm-html-report", "skills", "html-report"), path.join(target, "skills", "html-report"));
  copyTree(path.join(repoRoot, ".agents", "workbuddy", "skills", "qdm-harness"), path.join(target, "skills", "qdm-harness"));
}

function stageAdapter(repoRoot, target, spec) {
  const adapter = path.join(target, "adapter");
  if (spec.host !== "pi") {
    copyTree(path.join(repoRoot, spec.source), adapter);
    return;
  }

  const piRoot = path.join(repoRoot, spec.source);
  const piDist = mkdtempSync(path.join(tmpdir(), "qdm-host-pi-artifact-"));
  try {
    const env = { PI_HTML_REPORT_OUTPUT_DIR: piDist };
    runNode(piRoot, ["scripts/build-package.mjs"], { env });
    runNode(piRoot, ["scripts/verify-package.mjs"], { env });
    copyFile(path.join(piRoot, "package.json"), path.join(adapter, "package.json"));
    if (existsSync(path.join(piRoot, "README.md"))) copyFile(path.join(piRoot, "README.md"), path.join(adapter, "README.md"));
    copyTree(piDist, path.join(adapter, "dist"));
  } finally {
    rmSync(piDist, { recursive: true, force: true });
  }
}

function runNode(cwd, args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (result.status === 0) return;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(`command failed (${process.execPath} ${args.join(" ")}): ${output || `exit ${result.status}`}`);
}

function copyTree(source, destination) {
  if (!existsSync(source)) throw new Error(`missing source tree: ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (current) => shouldCopy(path.basename(current)),
  });
}

function copyFile(source, destination) {
  if (!existsSync(source)) throw new Error(`missing source file: ${source}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function shouldCopy(name) {
  if (PRUNED_DIRECTORIES.has(name)) return false;
  if (/\.(?:test|spec)\.(?:[cm]?[jt]s|ts)$/i.test(name)) return false;
  return true;
}

function writeJSON(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function selectHosts(host) {
  const value = String(host || "").trim().toLowerCase();
  if (value === "all") return [...HOST_ARTIFACT_HOSTS];
  return [requireHostArtifactSpec(value).host];
}

function requireOutputDirectory(value, repoRoot) {
  const output = requireAbsolutePath(value, "outputDir");
  const relative = path.relative(repoRoot, output);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return output;
  if (SOURCE_ROOT_NAMES.has(relative.split(path.sep)[0])) {
    throw new Error(`outputDir must not replace a source directory: ${output}`);
  }
  return output;
}

function requireArtifactTarget(value, repoRoot) {
  const target = requireAbsolutePath(value, "artifactRoot");
  const relative = path.relative(repoRoot, target);
  if (!relative) throw new Error(`artifactRoot must not replace the repository root: ${target}`);
  if (!(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
    if (SOURCE_ROOT_NAMES.has(relative.split(path.sep)[0])) {
      throw new Error(`artifactRoot must not replace a source directory: ${target}`);
    }
  }
  return target;
}

function requireAbsoluteDirectory(value, label) {
  const root = requireAbsolutePath(value, label);
  if (!existsSync(root)) throw new Error(`${label} does not exist: ${root}`);
  return root;
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

export function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArgs(argv);
    if (command === "build") {
      const reports = buildHostArtifacts({
        host: options.host,
        outputDir: options.outputDir,
        version: options.version,
        selfTest: !options.noSelfTest,
      });
      for (const report of reports) process.stdout.write(`host artifact built: ${report.host} ${report.artifactRoot}\n`);
      return 0;
    }
    if (command === "verify") {
      for (const report of verifyHostArtifacts({ host: options.host, artifactRoot: options.artifactRoot })) {
        process.stdout.write(`host artifact verified: ${report.host} ${report.artifactRoot}\n`);
      }
      return 0;
    }
    if (command === "self-test") {
      for (const report of selfTestHostArtifacts({ host: options.host, artifactRoot: options.artifactRoot })) {
        process.stdout.write(`host artifact self-test: ${report.host} ${report.root}\n`);
      }
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    process.stderr.write(`error: ${error?.message || error}\n`);
    return 1;
  }
}

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = String(rest[index]);
    if (token === "--host") {
      options.host = String(rest[++index] || "");
      continue;
    }
    if (token === "--output-dir") {
      options.outputDir = String(rest[++index] || "");
      continue;
    }
    if (token === "--artifact-root") {
      options.artifactRoot = String(rest[++index] || "");
      continue;
    }
    if (token === "--version") {
      options.version = String(rest[++index] || "");
      continue;
    }
    if (token === "--no-self-test") {
      options.noSelfTest = true;
      continue;
    }
    if (token === "-h" || token === "--help") {
      throw new Error("usage: node scripts/host-artifact.mjs <build|verify|self-test> --host <host|all> [--output-dir PATH --version VERSION | --artifact-root PATH]");
    }
    throw new Error(`unknown option: ${token}`);
  }
  if (!["build", "verify", "self-test"].includes(command)) {
    throw new Error("usage: node scripts/host-artifact.mjs <build|verify|self-test> --host <host|all> [--output-dir PATH --version VERSION | --artifact-root PATH]");
  }
  if (!options.host) throw new Error("--host is required");
  if (command === "build") {
    if (!options.outputDir) throw new Error("--output-dir is required for build");
    if (!options.version) throw new Error("--version is required for build");
  } else if (!options.artifactRoot) {
    throw new Error("--artifact-root is required");
  }
  return { command, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
