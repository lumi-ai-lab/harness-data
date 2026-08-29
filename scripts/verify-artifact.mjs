#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = new Set(["auto", "runtime", "pi", "npm"]);
const FORBIDDEN_DIRECTORIES = new Set([".git", ".harness", "node_modules", "state", "sessions", "diagnostics", "jobs", "test", "tests"]);
const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;

const REQUIRED_PATHS = {
  runtime: [
    "agents",
    "bootstrap/cli-manifest.json",
    "config",
    "packages/data-harness-cli/src/main.js",
    "plugins",
  ],
  pi: [
    "manifest.json",
    "extensions",
    "skills",
    "agents",
    "vendor/html-report-kernel/src/index.mjs",
    "vendor/harness-runtime-node/src/index.mjs",
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
  walkArtifact(resolved, "", errors);
  return { root: resolved, kind: effectiveKind, errors };
}

function detectKind(root) {
  if (existsSync(path.join(root, "bootstrap", "cli-manifest.json"))) return "runtime";
  if (existsSync(path.join(root, "manifest.json")) && existsSync(path.join(root, "vendor"))) return "pi";
  if (existsSync(path.join(root, "package.json"))) return "npm";
  return "auto";
}

function validateRequiredPaths(root, kind, errors) {
  for (const relative of REQUIRED_PATHS[kind] || []) {
    if (!existsSync(path.join(root, relative))) errors.push(`missing required ${kind} path: ${relative}`);
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
      return { error: "usage: node scripts/verify-artifact.mjs <artifact-root> [--kind runtime|pi|npm]" };
    }
    if (value.startsWith("--")) return { error: `unknown option: ${value}` };
    if (root) return { error: "only one artifact root is allowed" };
    root = value;
  }
  if (!root) return { error: "usage: node scripts/verify-artifact.mjs <artifact-root> [--kind runtime|pi|npm]" };
  return { root, kind };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
