#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requiredPathsForHost, requireHostArtifactSpec } from "./host-artifact-contract.mjs";

export function selfTestHostArtifact({ artifactRoot = "", host = "" } = {}) {
  const root = requireAbsoluteDirectory(artifactRoot || path.dirname(fileURLToPath(import.meta.url)));
  const descriptor = readJSON(path.join(root, "host-artifact.json"), "host artifact descriptor");
  const descriptorHost = requireHostArtifactSpec(descriptor.host).host;
  if (host && descriptorHost !== requireHostArtifactSpec(host).host) {
    throw new Error(`host artifact mismatch: expected ${host}, got ${descriptorHost}`);
  }
  const spec = requireHostArtifactSpec(descriptorHost);
  if (descriptor.schemaVersion !== 1) throw new Error(`unsupported host artifact schema: ${descriptor.schemaVersion}`);
  if (descriptor.adapter?.manifest !== spec.adapterManifest) {
    throw new Error(`host artifact adapter manifest mismatch: ${descriptor.adapter?.manifest || "missing"}`);
  }

  const declared = Array.isArray(descriptor.requiredPaths) ? descriptor.requiredPaths : [];
  for (const relative of requiredPathsForHost(descriptorHost)) {
    if (!declared.includes(relative)) throw new Error(`host artifact descriptor is missing required path: ${relative}`);
    if (!existsSync(path.join(root, ...safeRelative(relative).split("/")))) {
      throw new Error(`host artifact is missing required path: ${relative}`);
    }
  }

  const manifest = readJSON(path.join(root, "plugin-manifest.json"), "plugin manifest");
  if (manifest.host !== descriptorHost) throw new Error(`plugin manifest host mismatch: ${manifest.host || "missing"}`);
  if (manifest.plugin?.name !== descriptor.plugin?.name || manifest.plugin?.version !== descriptor.plugin?.version) {
    throw new Error("plugin manifest binding does not match host artifact descriptor");
  }
  if (!manifest.core?.packages || !Object.keys(manifest.core.packages).length) {
    throw new Error("plugin manifest does not bind core packages");
  }

  return { root, host: descriptorHost, requiredPathCount: requiredPathsForHost(descriptorHost).length };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const report = selfTestHostArtifact(options);
    process.stdout.write(`host artifact self-test ok: ${report.host} ${report.root}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`error: ${error?.message || error}\n`);
    return 1;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--artifact-root") {
      options.artifactRoot = String(argv[++index] || "");
      continue;
    }
    if (token === "--host") {
      options.host = String(argv[++index] || "");
      continue;
    }
    if (token === "-h" || token === "--help") throw new Error("usage: node self-test.mjs [--artifact-root PATH] [--host HOST]");
    throw new Error(`unknown option: ${token}`);
  }
  return options;
}

function requireAbsoluteDirectory(value) {
  const root = path.resolve(String(value || ""));
  if (!existsSync(root)) throw new Error(`artifact root does not exist: ${root}`);
  return root;
}

function readJSON(filePath, label) {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must be an object");
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid: ${error?.message || error}`);
  }
}

function safeRelative(value) {
  const text = String(value || "").replaceAll("\\", "/");
  if (!text || text.startsWith("/") || text === "." || text === ".." || text.startsWith("../") || text.includes("/../")) {
    throw new Error(`unsafe artifact path: ${value}`);
  }
  return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
