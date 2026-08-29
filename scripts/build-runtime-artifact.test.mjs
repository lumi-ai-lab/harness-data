import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
});
