import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodexMarketplace, packCodexMarketplaceZip, verifyCodexMarketplace, verifyCodexRepository } from "./build-codex-marketplace.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const releaseVersion = JSON.parse(readFileSync(path.join(repoRoot, "plugins", "harness-data", ".codex-plugin", "plugin.json"), "utf8")).version;

function bundleDist() {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "plugins", "harness-data", "scripts", "bundle-dist.mjs"),
    "--output-dir",
    path.join(repoRoot, "plugins", "harness-data", "dist"),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("Git repository Marketplace source does not require dist or Wikis", () => {
  const report = verifyCodexRepository({ repoRoot, version: releaseVersion });
  assert.equal(report.version, releaseVersion);
  assert.equal(report.pluginRoot, path.join(repoRoot, "plugins", "harness-data"));
});

test("Marketplace verifier accepts --repo-root without a temporary output directory", () => {
  const script = path.join(repoRoot, "scripts", "build-codex-marketplace.mjs");
  const result = spawnSync(process.execPath, [script, "verify", "--repo-root", repoRoot, "--version", releaseVersion], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /codex marketplace verify ok/);
});

test("Release Marketplace snapshot includes dist and excludes Wikis", (t) => {
  bundleDist();
  const root = mkdtempSync(path.join(os.tmpdir(), "qdm-codex-marketplace-"));
  const outputDir = path.join(root, "marketplace");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = buildCodexMarketplace({ outputDir, version: "ci-test", repo: repoRoot });
  assert.equal(built.version, "ci-test");
  const report = verifyCodexMarketplace({ outputDir, version: "ci-test" });
  assert.equal(report.requiredPaths >= 14, true);
  assert.equal(existsSync(path.join(outputDir, "plugins", "harness-data", "dist", "data-harness-cli", "src", "main.js")), true);
  assert.equal(existsSync(path.join(outputDir, "plugins", "harness-data", "bootstrap", "cli-manifest.json")), true);
  assert.equal(existsSync(path.join(outputDir, "plugins", "harness-data", "resources", "wikis")), false);
});

test("pack writes a ZIP whose top-level directory is a local Marketplace root", (t) => {
  bundleDist();
  const root = mkdtempSync(path.join(os.tmpdir(), "qdm-codex-marketplace-zip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const zipPath = path.join(root, "harness-data-codex-marketplace-vci-test.zip");
  const packed = packCodexMarketplaceZip({ zipPath, version: "ci-test", repo: repoRoot, stageDir: path.join(root, "stage") });
  assert.equal(existsSync(packed.zipPath), true);
  const listing = spawnSync("zipinfo", ["-1", zipPath], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr || listing.stdout);
  assert.match(listing.stdout, /^harness-data-codex-marketplace\/\.agents\/plugins\/marketplace\.json$/m);
  assert.match(listing.stdout, /harness-data-codex-marketplace\/plugins\/harness-data\/dist\/data-harness-cli\/src\/main\.js/);
  assert.doesNotMatch(listing.stdout, /resources\/wikis/);
});
