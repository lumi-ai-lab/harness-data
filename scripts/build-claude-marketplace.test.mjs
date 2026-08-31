import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClaudeMarketplace, verifyClaudeMarketplace } from "./build-claude-marketplace.mjs";

test("Claude marketplace builder emits a directly installable native plugin", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdm-claude-marketplace-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "marketplace");

  const report = buildClaudeMarketplace({
    outputDir,
    version: "0.0.54-test",
    marketplaceName: "lumi-ai-lab-test",
  });
  assert.deepEqual(report.errors, []);
  assert.equal(existsSync(path.join(outputDir, ".claude-plugin", "marketplace.json")), true);
  assert.equal(existsSync(path.join(outputDir, "qdm-harness-claude", ".claude-plugin", "plugin.json")), true);
  assert.equal(existsSync(path.join(outputDir, "qdm-harness-claude", "scripts", "data-harness-cli")), true);
  assert.equal(existsSync(path.join(outputDir, "qdm-harness-claude", "vendor", "data-harness-cli", "src", "main.js")), true);

  const marketplace = JSON.parse(readFileSync(path.join(outputDir, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].source, "./qdm-harness-claude");
  assert.deepEqual(verifyClaudeMarketplace(outputDir, {
    marketplaceName: "lumi-ai-lab-test",
    pluginVersion: "0.0.54-test",
  }).errors, []);
});
