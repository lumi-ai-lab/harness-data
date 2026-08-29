import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readPinnedWikisConfig, verifyPinnedWikis } from "./verify-pinned-wikis.mjs";

test("pinned Wikis config records a passed immutable revision", () => {
  const config = readPinnedWikisConfig();
  assert.match(config.revision, /^[a-f0-9]{40}$/);
  assert.equal(config.status, "passed");
  assert.deepEqual(config.checks, ["check-all"]);
});

test("verifyPinnedWikis reports a missing submodule without throwing", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qdm-pinned-wikis-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config", "wikis-revision.json"), JSON.stringify({
    repository: "fixture",
    revision: "a".repeat(40),
    checkedAt: "2026-08-29",
    checks: ["check-all"],
    status: "passed",
  }));
  const report = verifyPinnedWikis({
    repoRoot: root,
    wikisRoot: path.join(root, "wikis"),
    configPath: path.join(root, "config", "wikis-revision.json"),
  });
  assert.equal(report.ok, false);
  assert.match(report.message, /missing/);
});
