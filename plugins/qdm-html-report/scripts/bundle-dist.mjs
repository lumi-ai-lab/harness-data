#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));
const dist = join(pluginRoot, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
function includeArtifactFile(source) {
  const name = basename(source);
  return name !== "test" && name !== "tests" && !/\.(?:test|spec)\.(?:[cm]?[jt]s|ts)$/i.test(name);
}

for (const name of ["html-report-kernel", "harness-runtime-node"]) {
  cpSync(join(repoRoot, "packages", name), join(dist, name), { recursive: true, filter: includeArtifactFile });
}
console.log(`bundled ${dist}`);
