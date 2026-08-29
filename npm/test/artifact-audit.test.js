import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyArtifact } from "../../scripts/verify-artifact.mjs";

const npmRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("npm pack extracts to an artifact without mutable data, secrets, or build paths", (t) => {
  const work = mkdtempSync(path.join(tmpdir(), "qdm-npm-artifact-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  const packed = spawnSync("npm", ["pack", "--pack-destination", work], {
    cwd: npmRoot,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, packed.stdout);

  const unpacked = path.join(work, "unpacked");
  mkdirSync(unpacked, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", path.join(work, tarball), "-C", unpacked], { encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
  const report = verifyArtifact(path.join(unpacked, "package"), { kind: "npm" });
  assert.deepEqual(report.errors, []);
});
