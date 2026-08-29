#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultConfig = path.join(repoRoot, "config", "wikis-revision.json");
const defaultWikisRoot = path.join(repoRoot, "wikis");

export function readPinnedWikisConfig(configPath = defaultConfig) {
  const resolved = path.resolve(configPath);
  if (!existsSync(resolved)) throw new Error(`pinned Wikis config is missing: ${resolved}`);
  let value;
  try {
    value = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`pinned Wikis config is invalid JSON: ${error?.message || error}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pinned Wikis config must be an object");
  }
  const revision = String(value.revision || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("pinned Wikis revision must be a 40-character commit SHA");
  }
  if (String(value.status || "").trim() !== "passed") {
    throw new Error("pinned Wikis config status must be passed");
  }
  return { ...value, revision };
}

export function verifyPinnedWikis({ repoRoot: root = repoRoot, wikisRoot = path.join(root, "wikis"), configPath = path.join(root, "config", "wikis-revision.json") } = {}) {
  const config = readPinnedWikisConfig(configPath);
  const resolvedWikis = path.resolve(wikisRoot);
  if (!existsSync(resolvedWikis)) {
    return { ok: false, expected: config.revision, actual: "", wikisRoot: resolvedWikis, message: "Wikis submodule directory is missing" };
  }
  let actual;
  try {
    actual = execFileSync("git", ["-C", resolvedWikis, "rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
  } catch (error) {
    return { ok: false, expected: config.revision, actual: "", wikisRoot: resolvedWikis, message: `cannot read Wikis revision: ${error?.message || error}` };
  }
  return {
    ok: actual === config.revision,
    expected: config.revision,
    actual,
    wikisRoot: resolvedWikis,
    repository: config.repository,
    checks: config.checks || [],
    message: actual === config.revision
      ? "pinned Wikis revision verified"
      : `Wikis revision mismatch: expected ${config.revision}, got ${actual}`,
  };
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
  else process.stdout.write(`${report.ok ? "pinned Wikis ok" : "pinned Wikis failed"}: ${report.message}\n`);
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
