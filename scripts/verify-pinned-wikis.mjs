#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultConfig = path.join(repoRoot, "config", "wikis-revision.json");
const defaultWikisRoot = path.join(repoRoot, "plugins", "harness-data", "resources", "wikis");
const REQUIRED_DIRECTORIES = ["metrics", "reports", "dims", "rules"];

/**
 * Read the embedded Wiki metadata. The legacy export name is retained because
 * existing validation callers use this script name, but no Git submodule is
 * required or inspected.
 */
export function readPinnedWikisConfig(configPath = defaultConfig) {
  const resolved = path.resolve(configPath);
  if (!existsSync(resolved)) throw new Error(`embedded Wikis config is missing: ${resolved}`);
  let value;
  try {
    value = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`embedded Wikis config is invalid JSON: ${error?.message || error}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("embedded Wikis config must be an object");
  }
  if (String(value.status || "").trim() !== "passed") {
    throw new Error("embedded Wikis config status must be passed");
  }
  if (!Array.isArray(value.checks) || !value.checks.includes("check-all")) {
    throw new Error("embedded Wikis config must record the check-all validation");
  }
  return { ...value };
}

export function verifyPinnedWikis({ repoRoot: root = repoRoot, wikisRoot = path.join(root, "plugins", "harness-data", "resources", "wikis"), configPath = path.join(root, "config", "wikis-revision.json") } = {}) {
  const config = readPinnedWikisConfig(configPath);
  const resolvedWikis = path.resolve(wikisRoot);
  if (!existsSync(resolvedWikis) || !statSync(resolvedWikis).isDirectory()) {
    return {
      ok: false,
      expected: String(config.contentVersion || config.revision || ""),
      actual: "",
      wikisRoot: resolvedWikis,
      message: "embedded Wikis directory is missing",
    };
  }
  for (const required of ["index.md", ...REQUIRED_DIRECTORIES]) {
    const target = path.join(resolvedWikis, required);
    if (!existsSync(target)) {
      return {
        ok: false,
        expected: String(config.contentVersion || config.revision || ""),
        actual: "",
        wikisRoot: resolvedWikis,
        message: `embedded Wikis is missing ${required}`,
      };
    }
  }
  const actual = contentDigest(resolvedWikis);
  const expected = String(config.contentVersion || "").trim().toLowerCase();
  return {
    ok: !expected || actual === expected,
    expected,
    actual,
    revision: actual,
    wikisRoot: resolvedWikis,
    repository: "embedded",
    checks: config.checks || [],
    message: !expected || actual === expected
      ? "embedded Wikis verified"
      : `embedded Wikis content mismatch: expected ${expected}, got ${actual}`,
  };
}

function contentDigest(root) {
  const hash = createHash("sha256");
  function visit(directory, relative = "") {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git" || name === ".harness" || name === "node_modules" || /^__pycache__$/.test(name) || /\.py[cod]$/.test(name)) continue;
      const file = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const info = statSync(file);
      if (info.isDirectory()) {
        visit(file, childRelative);
      } else if (info.isFile()) {
        hash.update(childRelative);
        hash.update("\0");
        hash.update(readFileSync(file));
        hash.update("\0");
      }
    }
  }
  visit(root);
  return hash.digest("hex");
}

export function main(argv = process.argv.slice(2)) {
  let configPath = defaultConfig;
  let wikisRoot = defaultWikisRoot;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--config") {
      configPath = String(argv[++index] || "");
      continue;
    }
    if (token === "--wikis-root") {
      wikisRoot = String(argv[++index] || "");
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }
  const report = verifyPinnedWikis({ configPath, wikisRoot });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${report.ok ? "embedded Wikis ok" : "embedded Wikis failed"}: ${report.message}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`error: ${error?.message || error}\n`);
    process.exitCode = 2;
  }
}
