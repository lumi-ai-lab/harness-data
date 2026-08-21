#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));
const dist = join(pluginRoot, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const name of ["html-report-kernel", "harness-runtime-node"]) {
  cpSync(join(repoRoot, "packages", name), join(dist, name), { recursive: true });
}
console.log(`bundled ${dist}`);
