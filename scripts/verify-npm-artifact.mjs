#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyArtifact } from "./verify-artifact.mjs";

const npmRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "npm");

export function verifyNpmArtifact({ packageRoot = npmRoot } = {}) {
  const root = path.resolve(packageRoot);
  const work = mkdtempSync(path.join(os.tmpdir(), "qdm-npm-artifact-"));
  try {
    const packed = spawnSync("npm", ["pack", "--pack-destination", work], {
      cwd: root,
      encoding: "utf8",
    });
    if (packed.status !== 0) {
      return { ok: false, packageRoot: root, message: packed.stderr || packed.stdout || "npm pack failed" };
    }
    const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
    if (!tarball) return { ok: false, packageRoot: root, message: "npm pack did not produce a tarball" };
    const unpacked = path.join(work, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    const extracted = spawnSync("tar", ["-xzf", path.join(work, tarball), "-C", unpacked], { encoding: "utf8" });
    if (extracted.status !== 0) {
      return { ok: false, packageRoot: root, message: extracted.stderr || extracted.stdout || "tar extraction failed" };
    }
    const artifactRoot = path.join(unpacked, "package");
    const report = verifyArtifact(artifactRoot, { kind: "npm" });
    return {
      ok: report.errors.length === 0,
      packageRoot: root,
      tarball,
      files: report.errors.length ? 0 : countFiles(artifactRoot),
      errors: report.errors,
      message: report.errors.length ? "npm artifact verification failed" : "npm artifact verified",
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function countFiles(root) {
  let count = 0;
  const visit = (directory) => {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, name.name);
      if (name.isDirectory()) visit(child);
      else count += 1;
    }
  };
  visit(root);
  return count;
}

export function main() {
  const report = verifyNpmArtifact();
  if (report.ok) {
    process.stdout.write(`npm artifact ok: files=${report.files}\n`);
    return 0;
  }
  process.stderr.write(`npm artifact failed: ${report.message}\n`);
  for (const error of report.errors || []) process.stderr.write(`error: ${error}\n`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
