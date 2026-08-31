#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));
const outputIndex = process.argv.indexOf("--output-dir");
const outputValue = outputIndex >= 0 ? String(process.argv[outputIndex + 1] || "").trim() : "";
if (outputIndex >= 0 && !outputValue) throw new Error("--output-dir requires a path");
const dist = outputValue ? resolve(outputValue) : join(pluginRoot, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
function includeArtifactFile(source) {
  const name = basename(source);
  return name !== "test" && name !== "tests" && !/\.(?:test|spec)\.(?:[cm]?[jt]s|ts)$/i.test(name);
}

for (const name of ["html-report-kernel", "harness-runtime-node", "data-harness-cli"]) {
  cpSync(join(repoRoot, "packages", name), join(dist, name), { recursive: true, filter: includeArtifactFile });
}
cpSync(join(repoRoot, "npm"), join(dist, "harness-data-installer"), {
  recursive: true,
  filter: includeArtifactFile,
});
const bootstrapDir = join(pluginRoot, "bootstrap");
mkdirSync(bootstrapDir, { recursive: true });
cpSync(join(repoRoot, "bootstrap", "cli-manifest.json"), join(bootstrapDir, "cli-manifest.json"));
console.log(`bundled ${dist}`);
