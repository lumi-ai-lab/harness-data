#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDistBuildLock } from "./dist-build-lock.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));
const outputIndex = process.argv.indexOf("--output-dir");
const outputValue = outputIndex >= 0 ? String(process.argv[outputIndex + 1] || "").trim() : "";
if (outputIndex >= 0 && !outputValue) throw new Error("--output-dir requires a path");
const dist = outputValue ? resolve(outputValue) : join(pluginRoot, "dist");

function includeArtifactFile(source) {
  const name = basename(source);
  return name !== "test" && name !== "tests" && !/\.(?:test|spec)\.(?:[cm]?[jt]s|ts)$/i.test(name);
}

const lock = acquireDistBuildLock(dist);
const temporaryDist = `${dist}.tmp-${process.pid}-${Date.now()}`;
const previousDist = `${dist}.previous-${process.pid}-${Date.now()}`;
try {
  rmSync(temporaryDist, { recursive: true, force: true });
  mkdirSync(temporaryDist, { recursive: true });
  for (const name of ["html-report-kernel", "harness-runtime-node", "data-harness-cli"]) {
    cpSync(join(repoRoot, "packages", name), join(temporaryDist, name), { recursive: true, filter: includeArtifactFile });
  }
  cpSync(join(repoRoot, "npm"), join(temporaryDist, "harness-data-installer"), {
    recursive: true,
    filter: includeArtifactFile,
  });
  const bootstrapDir = join(pluginRoot, "bootstrap");
  mkdirSync(bootstrapDir, { recursive: true });
  cpSync(join(repoRoot, "bootstrap", "cli-manifest.json"), join(bootstrapDir, "cli-manifest.json"));
  atomicReplace(temporaryDist, dist, previousDist);
  console.log(`bundled ${dist}`);
} finally {
  rmSync(temporaryDist, { recursive: true, force: true });
  rmSync(previousDist, { recursive: true, force: true });
  lock.release();
}

function atomicReplace(source, target, backup) {
  let movedPrevious = false;
  let installed = false;
  try {
    if (existsSync(target)) {
      rmSync(backup, { recursive: true, force: true });
      renameSync(target, backup);
      movedPrevious = true;
    }
    renameSync(source, target);
    installed = true;
    if (movedPrevious) rmSync(backup, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (installed) rmSync(target, { recursive: true, force: true });
    if (movedPrevious && existsSync(backup) && !existsSync(target)) renameSync(backup, target);
    throw error;
  }
}
