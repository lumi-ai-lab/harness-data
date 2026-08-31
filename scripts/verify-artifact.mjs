#!/usr/bin/env node

// Internal artifact verifier used by compatibility tests. The public Codex
// distribution is the source repository Marketplace plus plugins/harness-data.
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPluginManifest } from "../packages/data-harness-cli/src/lib/plugin-manifest.js";
import {
  hostArtifactKind,
  hostFromArtifactKind,
  isHostArtifactKind,
  requiredPathsForHost,
  requireHostArtifactSpec,
} from "./host-artifact-contract.mjs";

const KINDS = new Set([
  "auto",
  "runtime",
  "pi",
  "npm",
  "host-claude",
  "host-codex",
  "host-workbuddy",
  "host-pi",
  "host-qwenpaw",
]);
const FORBIDDEN_DIRECTORIES = new Set([".git", ".harness", "node_modules", "state", "sessions", "diagnostics", "jobs", "test", "tests"]);
const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;

const REQUIRED_PATHS = {
  runtime: [
    "agents",
    "bootstrap/cli-manifest.json",
    "config",
    "packages/data-harness-cli/src/main.js",
    "packages/data-harness-cli/package.json",
    "packages/html-report-kernel/src/index.mjs",
    "packages/html-report-kernel/package.json",
    "packages/harness-runtime-node/src/index.mjs",
    "packages/harness-runtime-node/package.json",
    "plugins",
    "plugins/harness-data/.codex-plugin/plugin.json",
    "plugins/harness-data/bootstrap/cli-manifest.json",
    "plugins/harness-data/hooks/hooks.json",
    "plugins/harness-data/scripts/setup.mjs",
    "plugins/harness-data/scripts/context-store.mjs",
    "plugins/harness-data/scripts/data-harness-cli",
    "plugins/harness-data/dist/harness-data-installer/src/cli.js",
    "plugins/harness-data/dist/data-harness-cli/src/main.js",
    "plugins/harness-data/plugin-manifest.json",
    "plugin-manifest.json",
  ],
  pi: [
    "manifest.json",
    "plugin-manifest.json",
    "extensions",
    "skills",
    "agents",
    "vendor/html-report-kernel/src/index.mjs",
    "vendor/html-report-kernel/package.json",
    "vendor/harness-runtime-node/src/index.mjs",
    "vendor/harness-runtime-node/package.json",
  ],
  npm: ["package.json"],
};

export function verifyArtifact(root, { kind = "auto" } = {}) {
  const errors = [];
  const requestedKind = String(kind || "auto").trim().toLowerCase();
  if (!KINDS.has(requestedKind)) return { root: "", kind: requestedKind, errors: [`unsupported artifact kind: ${requestedKind}`] };
  if (!root || !path.isAbsolute(root)) return { root: "", kind: requestedKind, errors: ["artifact root must be an absolute path"] };
  const resolved = path.resolve(root);
  if (!existsSync(resolved)) return { root: resolved, kind: requestedKind, errors: [`artifact root does not exist: ${resolved}`] };
  if (!statSync(resolved).isDirectory()) return { root: resolved, kind: requestedKind, errors: [`artifact root must be a directory: ${resolved}`] };

  const effectiveKind = requestedKind === "auto" ? detectKind(resolved) : requestedKind;
  validateRequiredPaths(resolved, effectiveKind, errors);
  validatePluginManifest(resolved, effectiveKind, errors);
  walkArtifact(resolved, "", errors);
  return { root: resolved, kind: effectiveKind, errors };
}

function detectKind(root) {
  if (existsSync(path.join(root, "host-artifact.json"))) {
    try {
      return hostArtifactKind(JSON.parse(readFileSync(path.join(root, "host-artifact.json"), "utf8")).host);
    } catch {
      return "auto";
    }
  }
  if (existsSync(path.join(root, "bootstrap", "cli-manifest.json"))) return "runtime";
  if (existsSync(path.join(root, "manifest.json")) && existsSync(path.join(root, "vendor"))) return "pi";
  if (existsSync(path.join(root, "package.json"))) return "npm";
  return "auto";
}

function validateRequiredPaths(root, kind, errors) {
  const required = isHostArtifactKind(kind)
    ? requiredPathsForHost(hostFromArtifactKind(kind))
    : REQUIRED_PATHS[kind] || [];
  for (const relative of required) {
    if (!existsSync(path.join(root, relative))) errors.push(`missing required ${kind} path: ${relative}`);
  }
}

function validatePluginManifest(root, kind, errors) {
  const expectedHost = isHostArtifactKind(kind) ? hostFromArtifactKind(kind) : kind;
  if (kind !== "runtime" && kind !== "pi" && !isHostArtifactKind(kind)) return;
  try {
    const manifest = loadPluginManifest(root, { required: true });
    if (manifest.host !== expectedHost) errors.push(`${kind} plugin manifest host must be ${expectedHost}: ${manifest.host}`);
    if (kind === "runtime") validateNestedCodexManifest(root, errors);
  } catch (error) {
    errors.push(`invalid plugin manifest: ${error?.message || error}`);
  }
  if (isHostArtifactKind(kind)) validateHostArtifactDescriptor(root, expectedHost, errors);
}

function validateHostArtifactDescriptor(root, host, errors) {
  const filePath = path.join(root, "host-artifact.json");
  try {
    const descriptor = JSON.parse(readFileSync(filePath, "utf8"));
    const spec = requireHostArtifactSpec(host);
    if (descriptor?.schemaVersion !== 1) errors.push(`host artifact schema must be 1: ${descriptor?.schemaVersion}`);
    if (descriptor?.host !== host) errors.push(`host artifact descriptor host must be ${host}: ${descriptor?.host || "missing"}`);
    if (descriptor?.adapter?.manifest !== spec.adapterManifest) {
      errors.push(`host artifact adapter manifest must be ${spec.adapterManifest}: ${descriptor?.adapter?.manifest || "missing"}`);
    }
    const declared = Array.isArray(descriptor?.requiredPaths) ? descriptor.requiredPaths : [];
    for (const relative of declared) {
      if (!isSafeRelative(relative)) errors.push(`host artifact required path must be relative: ${relative}`);
    }
    for (const relative of requiredPathsForHost(host)) {
      if (!declared.includes(relative)) errors.push(`host artifact descriptor missing required path: ${relative}`);
    }
  } catch (error) {
    errors.push(`invalid host artifact descriptor: ${error?.message || error}`);
  }
}

function validateNestedCodexManifest(root, errors) {
  const nestedRoot = path.join(root, "plugins", "harness-data");
  const nestedPath = path.join(nestedRoot, "plugin-manifest.json");
  if (!existsSync(nestedPath)) {
    errors.push("missing required nested Codex plugin manifest: plugins/harness-data/plugin-manifest.json");
    return;
  }
  try {
    const manifest = loadPluginManifest(nestedRoot, { required: true });
    if (manifest.host !== "codex") errors.push(`nested Codex plugin manifest host must be codex: ${manifest.host}`);
    const nativePath = path.join(nestedRoot, ".codex-plugin", "plugin.json");
    const native = JSON.parse(readFileSync(nativePath, "utf8"));
    if (native.name !== manifest.plugin.name) {
      errors.push(`nested Codex native manifest name must match product manifest: ${native.name || "missing"} != ${manifest.plugin.name}`);
    }
    if (native.version !== manifest.plugin.version) {
      errors.push(`nested Codex native manifest version must match product manifest: ${native.version || "missing"} != ${manifest.plugin.version}`);
    }
  } catch (error) {
    errors.push(`invalid nested Codex plugin manifest: ${error?.message || error}`);
  }
}

function walkArtifact(root, relative, errors) {
  const directory = path.join(root, relative);
  for (const name of readdirSync(directory).sort()) {
    const childRelative = relative ? path.join(relative, name) : name;
    const child = path.join(root, childRelative);
    const info = lstatSync(child);
    const display = toPosix(childRelative);
    if (info.isSymbolicLink()) {
      errors.push(`symlink is not allowed: ${display}`);
      continue;
    }
    if (info.isDirectory()) {
      if (FORBIDDEN_DIRECTORIES.has(name)) {
        errors.push(`forbidden directory: ${display}`);
        continue;
      }
      walkArtifact(root, childRelative, errors);
      continue;
    }
    validateFile(display, child, errors);
  }
}

function validateFile(relative, filePath, errors) {
  const name = path.basename(relative).toLowerCase();
  if (name.endsWith(".sha256")) errors.push(`checksum sidecar is not allowed: ${relative}`);
  if (name.endsWith(".blob") || name.endsWith(".secret") || name.endsWith(".pem") || name.endsWith(".key")) {
    errors.push(`secret-like file is not allowed: ${relative}`);
  }
  if (["auth-ref.json", "local-test-auth.json"].includes(name)) errors.push(`auth fixture is not allowed: ${relative}`);
  if (/^qdm-metric-cli(?:\.[a-z0-9]+)?$/i.test(name)) errors.push(`downloaded metric CLI is not allowed: ${relative}`);
  if (statSync(filePath).size > TEXT_LIMIT_BYTES) return;
  const content = readFileSync(filePath);
  if (content.includes(0)) return;
  const text = content.toString("utf8");
  if (/\bqdm1enc\.[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)*/.test(text)) {
    errors.push(`secret-like content is not allowed: ${relative}`);
  }
  const absolutePath = findAbsolutePath(text);
  if (absolutePath) errors.push(`build-machine absolute path is not allowed: ${relative} (${absolutePath})`);
}

function findAbsolutePath(text) {
  const match = text.match(/(?:\/Users\/[A-Za-z0-9._-]+\/[^\s"'`]+|\/home\/[A-Za-z0-9._-]+\/[^\s"'`]+|\/private\/var\/folders\/[A-Za-z0-9._-]+\/[^\s"'`]+|[A-Za-z]:[\\/]Users[\\/][^\s"'`]+)/i);
  return match ? match[0] : "";
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isSafeRelative(value) {
  const text = String(value || "").replaceAll("\\", "/");
  return Boolean(text) && !text.startsWith("/") && !path.win32.isAbsolute(text) && text !== "." && text !== ".." && !text.startsWith("../") && !text.includes("/../");
}

export function main(argv = process.argv.slice(2)) {
  const { root, kind, error } = parseArgs(argv);
  if (error) {
    process.stderr.write(`error: ${error}\n`);
    return 2;
  }
  const report = verifyArtifact(path.resolve(root), { kind });
  if (report.errors.length) {
    process.stderr.write(`${report.errors.map((item) => `error: ${item}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`artifact ok: ${report.kind} ${report.root}\n`);
  return 0;
}

function parseArgs(argv) {
  let root = "";
  let kind = "auto";
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index]);
    if (value === "--kind") {
      kind = String(argv[++index] || "");
      continue;
    }
    if (value === "-h" || value === "--help") {
      return { error: "usage: node scripts/verify-artifact.mjs <artifact-root> [--kind runtime|pi|npm|host-<host>]" };
    }
    if (value.startsWith("--")) return { error: `unknown option: ${value}` };
    if (root) return { error: "only one artifact root is allowed" };
    root = value;
  }
  if (!root) return { error: "usage: node scripts/verify-artifact.mjs <artifact-root> [--kind runtime|pi|npm|host-<host>]" };
  return { root, kind };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
