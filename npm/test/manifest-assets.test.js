import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { installToolsFromManifest } from "../src/lib/manifest.js";
import { binaryName, platformKey } from "../src/lib/platform.js";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createArchive(root, assetName, content) {
  const source = fs.mkdtempSync(path.join(root, "source-"));
  const archive = path.join(root, assetName);
  const binary = path.join(source, binaryName("fixture-cli"));
  fs.writeFileSync(binary, content, { mode: 0o755 });
  const result = spawnSync("tar", ["-czf", archive, "-C", source, path.basename(binary)], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return { archive, binarySha256: sha256(binary), archiveSha256: sha256(archive) };
}

function latestManifest(assetName) {
  return {
    schemaVersion: 3,
    tools: [{
      name: "fixture-cli",
      binary: "fixture-cli",
      repo: "example/fixture-cli",
      destination: "bin/fixture-cli",
      tracking: "latest",
      version: "v0.1.0",
      requireAssetSha256: true,
      cleanupArchive: true,
      platforms: {
        [platformKey()]: {
          url: `https://github.com/example/fixture-cli/releases/download/v0.1.0/${assetName}`
        }
      }
    }]
  };
}

test("latest release tools require and verify a downloaded archive checksum", async (t) => {
  if (process.platform === "win32") {
    t.skip("tar fixture is Unix-only");
    return;
  }
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-latest-checksum-"));
  const assetDir = path.join(fixture, "assets");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  fs.mkdirSync(assetDir, { recursive: true });
  const asset = createArchive(assetDir, assetName, "#!/bin/sh\necho latest\n");
  fs.writeFileSync(
    path.join(assetDir, `${assetName}.sha256`),
    `${asset.archiveSha256}  ${assetName}\n`
  );

  const workspace = path.join(fixture, "runtime");
  await installToolsFromManifest(workspace, "", {
    manifestOverride: latestManifest(assetName),
    assetDir,
    log: false
  });

  assert.equal(
    fs.readFileSync(path.join(workspace, "bin", binaryName("fixture-cli")), "utf8"),
    "#!/bin/sh\necho latest\n"
  );
  assert.equal(fs.existsSync(path.join(workspace, ".bootstrap-cache", assetName)), false);
});

test("latest release tools fail when their required checksum is unavailable", async (t) => {
  if (process.platform === "win32") {
    t.skip("tar fixture is Unix-only");
    return;
  }
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-missing-checksum-"));
  const assetDir = path.join(fixture, "assets");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  fs.mkdirSync(assetDir, { recursive: true });
  createArchive(assetDir, assetName, "#!/bin/sh\necho latest\n");

  await assert.rejects(
    () => installToolsFromManifest(path.join(fixture, "runtime"), "", {
      manifestOverride: latestManifest(assetName),
      assetDir,
      log: false
    }),
    /required sha256 is unavailable/
  );
});

test("reusing an installed tool removes a stale cached release archive", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-reuse-cleanup-"));
  const workspace = path.join(fixture, "runtime");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  const binary = path.join(workspace, "bin", binaryName("fixture-cli"));
  const archive = path.join(workspace, ".bootstrap-cache", assetName);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(binary, "#!/bin/sh\necho reused\n", { mode: 0o755 });
  fs.writeFileSync(archive, "stale archive\n");

  const binarySha256 = sha256(binary);
  const installed = await installToolsFromManifest(workspace, "", {
    manifestOverride: latestManifest(assetName),
    state: {
      tools: {
        "fixture-cli": {
          version: "v0.1.0",
          asset: assetName,
          sha256: binarySha256,
          destination: binary
        }
      }
    },
    log: false
  });

  assert.equal(installed.installedTools["fixture-cli"].sha256, binarySha256);
  assert.equal(fs.existsSync(archive), false);
});
