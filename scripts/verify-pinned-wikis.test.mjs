import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readPinnedWikisConfig, verifyPinnedWikis } from "./verify-pinned-wikis.mjs";

test("embedded Wikis config records a validated content version", () => {
  const config = readPinnedWikisConfig();
  assert.match(config.contentVersion, /^[a-f0-9]{64}$/);
  assert.equal(config.repository, "embedded");
  assert.equal(config.status, "passed");
  assert.deepEqual(config.checks, ["check-all"]);
});

test("verifyPinnedWikis reports a missing embedded Wiki directory without throwing", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qdm-embedded-wikis-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config", "wikis-revision.json"), JSON.stringify({
    contentVersion: "a".repeat(64),
    checkedAt: "2026-08-31",
    checks: ["check-all"],
    status: "passed",
  }));
  const report = verifyPinnedWikis({
    repoRoot: root,
    wikisRoot: path.join(root, "plugins", "harness-data", "resources", "wikis"),
    configPath: path.join(root, "config", "wikis-revision.json"),
  });
  assert.equal(report.ok, false);
  assert.match(report.message, /missing/);
});
