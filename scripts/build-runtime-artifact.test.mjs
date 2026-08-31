import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyArtifact } from "./verify-artifact.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(repoRoot, "scripts", "build-runtime-artifact.sh");

test("runtime artifact script builds a self-contained verified staging tree", (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "qdm-runtime-artifact-"));
  const output = path.join(parent, "runtime");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const result = spawnSync("bash", [script, "--output-dir", output, "--version", "v-test"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = verifyArtifact(output, { kind: "runtime" });
  assert.deepEqual(report.errors, []);
  const nativeManifest = JSON.parse(readFileSync(
    path.join(output, "plugins", "harness-data", ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  assert.equal(nativeManifest.version, "v-test");
  const productManifest = JSON.parse(readFileSync(
    path.join(output, "plugins", "harness-data", "plugin-manifest.json"),
    "utf8",
  ));
  assert.equal(productManifest.plugin.version, "v-test");
  assert.equal(
    readFileSync(path.join(output, "plugins", "harness-data", "bootstrap", "cli-manifest.json"), "utf8"),
    readFileSync(path.join(output, "bootstrap", "cli-manifest.json"), "utf8"),
  );
});
