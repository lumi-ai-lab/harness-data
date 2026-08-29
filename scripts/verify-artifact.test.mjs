import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyArtifact } from "./verify-artifact.mjs";

function write(root, relative, value = "ok\n") {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function runtimeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "qdm-artifact-"));
  mkdirSync(path.join(root, "agents"), { recursive: true });
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "plugins"), { recursive: true });
  write(root, "bootstrap/cli-manifest.json", "{}\n");
  write(root, "packages/data-harness-cli/src/main.js", "export {};\n");
  return root;
}

test("verifyArtifact accepts a relocatable runtime skeleton", () => {
  const root = runtimeFixture();
  const report = verifyArtifact(root, { kind: "runtime" });
  assert.deepEqual(report.errors, []);
});

test("verifyArtifact rejects secrets, mutable state, binaries, symlinks, and build paths", () => {
  const root = runtimeFixture();
  write(root, "config/dev-auth.blob", "qdm1enc.fixture-secret-value\n");
  write(root, "state/workspace/session.json", "{}\n");
  write(root, "bin/qdm-metric-cli", "binary\n");
  write(root, "agent.md", "built at /Users/example/worktree\n");
  symlinkSync(path.join(root, "agent.md"), path.join(root, "linked.md"));

  const report = verifyArtifact(root, { kind: "runtime" });
  assert.equal(report.errors.some((line) => line.includes("secret-like file") && line.includes("dev-auth.blob")), true);
  assert.equal(report.errors.some((line) => line.includes("forbidden directory") && line.includes("state")), true);
  assert.equal(report.errors.some((line) => line.includes("downloaded metric CLI")), true);
  assert.equal(report.errors.some((line) => line.includes("build-machine absolute path") && line.includes("agent.md")), true);
  assert.equal(report.errors.some((line) => line.includes("symlink is not allowed") && line.includes("linked.md")), true);
});
