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
  const source = path.join(root, "source");
  const archive = path.join(root, assetName);
  const binary = path.join(source, binaryName("fixture-cli"));
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(binary, content, { mode: 0o755 });
  const result = spawnSync("tar", ["-czf", archive, "-C", source, path.basename(binary)], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return { archive, binarySha256: sha256(binary), archiveSha256: sha256(archive) };
}

function manifestFor(asset, options = {}) {
  return {
    schemaVersion: 3,
    tools: [{
      name: options.name || "fixture-cli",
      binary: "fixture-cli",
      repo: options.private ? "pengmide/fixture-cli" : "lumi-ai-lab/fixture-cli",
      ...(options.private ? { private: true } : {}),
      destination: options.destination || "bin/fixture-cli",
      tracking: "fixed",
      version: "v0.1.0",
      requireAssetSha256: true,
      requireBinarySha256: true,
      platforms: {
        [platformKey()]: {
          archive: "tar.gz",
          url: `https://github.com/${options.private ? "pengmide" : "lumi-ai-lab"}/fixture-cli/releases/download/v0.1.0/${path.basename(asset.archive)}`,
          sha256: asset.archiveSha256,
          binarySha256: asset.binarySha256
        }
      }
    }]
  };
}

test("asset-dir installs a public release asset locally", async () => {
  if (process.platform === "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-public-asset-"));
  const assetDir = path.join(fixture, "assets");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  fs.mkdirSync(assetDir, { recursive: true });
  const asset = createArchive(assetDir, assetName, "#!/bin/sh\necho public\n");
  const workspace = path.join(fixture, "runtime");

  await installToolsFromManifest(workspace, "", {
    manifestOverride: manifestFor(asset),
    assetDir,
    log: false
  });

  assert.equal(fs.readFileSync(path.join(workspace, "bin", binaryName("fixture-cli")), "utf8"), "#!/bin/sh\necho public\n");
});

test("archive extraction rejects a symlink in place of the CLI", async () => {
  if (process.platform === "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-archive-symlink-"));
  const source = path.join(fixture, "source");
  const target = path.join(fixture, "target");
  const assetDir = path.join(fixture, "assets");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  const archive = path.join(assetDir, assetName);
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.symlinkSync(target, path.join(source, binaryName("fixture-cli")));
  const result = spawnSync("tar", ["-czf", archive, "-C", source, binaryName("fixture-cli")], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const asset = {
    archive,
    archiveSha256: sha256(archive),
    binarySha256: sha256(target)
  };

  await assert.rejects(
    () => installToolsFromManifest(path.join(fixture, "runtime"), "", {
      manifestOverride: manifestFor(asset),
      assetDir,
      log: false
    }),
    /extracted artifact is not a regular file/
  );
});

test("asset-dir falls back to gh for a missing private release asset", async () => {
  if (process.platform === "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-private-asset-"));
  const assetDir = path.join(fixture, "assets");
  const fakeBin = path.join(fixture, "fake-bin");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  fs.mkdirSync(assetDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  const sourceAsset = createArchive(fixture, assetName, "#!/bin/sh\necho private\n");
  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(fakeGh, `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  exit 0
fi
if [ "$1 $2" = "auth token" ]; then
  exit 1
fi
if [ "$1 $2" = "release download" ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$FAKE_GH_ASSET" "$dir/$pattern"
  exit 0
fi
exit 1
`, { mode: 0o755 });

  const previousPath = process.env.PATH;
  const previousAsset = process.env.FAKE_GH_ASSET;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  process.env.FAKE_GH_ASSET = sourceAsset.archive;
  try {
    const workspace = path.join(fixture, "runtime");
    await installToolsFromManifest(workspace, "", {
      manifestOverride: manifestFor(sourceAsset, { private: true }),
      assetDir,
      log: false
    });
    const installed = path.join(workspace, "bin", binaryName("fixture-cli"));
    assert.equal(fs.readFileSync(installed, "utf8"), "#!/bin/sh\necho private\n");
    assert.equal(fs.statSync(installed).mode & 0o777, 0o500);
    assert.equal(fs.statSync(path.dirname(installed)).mode & 0o777, 0o700);
    assert.deepEqual(
      fs.readdirSync(path.join(workspace, ".bootstrap-cache"))
        .filter((name) => name.startsWith(".private-install-")),
      []
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed))
        .filter((name) => name.startsWith(".private-install-")),
      []
    );
    assert.equal(
      fs.existsSync(path.join(workspace, ".bootstrap-cache", assetName)),
      false,
      "private release archive must not remain in the Agent-visible cache"
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousAsset === undefined) delete process.env.FAKE_GH_ASSET;
    else process.env.FAKE_GH_ASSET = previousAsset;
  }
});

test("asset-dir still rejects a missing public release asset", async () => {
  if (process.platform === "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-missing-public-"));
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  const sourceAsset = createArchive(fixture, assetName, "#!/bin/sh\nexit 0\n");
  const assetDir = path.join(fixture, "empty-assets");
  fs.mkdirSync(assetDir, { recursive: true });

  await assert.rejects(
    () => installToolsFromManifest(path.join(fixture, "runtime"), "", {
      manifestOverride: manifestFor(sourceAsset),
      assetDir,
      log: false
    }),
    /local release asset is missing/
  );
});

test("asset-dir rejects an existing private symlink", async () => {
  if (process.platform === "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-private-symlink-"));
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  const sourceAsset = createArchive(fixture, assetName, "#!/bin/sh\nexit 0\n");
  const assetDir = path.join(fixture, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.symlinkSync(sourceAsset.archive, path.join(assetDir, assetName));

  await assert.rejects(
    () => installToolsFromManifest(path.join(fixture, "runtime"), "", {
      manifestOverride: manifestFor(sourceAsset, { private: true }),
      assetDir,
      log: false
    }),
    /local release asset is not a regular file/
  );
});

test("asset-dir rejects an Agent-visible private release archive", async () => {
  if (process.platform === "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-private-local-"));
  const assetDir = path.join(fixture, "assets");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  fs.mkdirSync(assetDir, { recursive: true });
  const sourceAsset = createArchive(assetDir, assetName, "#!/bin/sh\nexit 0\n");

  await assert.rejects(
    () => installToolsFromManifest(path.join(fixture, "runtime"), "", {
      manifestOverride: manifestFor(sourceAsset, { private: true }),
      assetDir,
      log: false
    }),
    /private release assets cannot be loaded from --asset-dir/
  );
});

test("private extraction cleans its protected cache after a checksum failure", async () => {
  if (process.platform === "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-private-cleanup-"));
  const fakeBin = path.join(fixture, "fake-bin");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  fs.mkdirSync(fakeBin, { recursive: true });
  const asset = createArchive(fixture, assetName, "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  exit 0
fi
if [ "$1 $2" = "auth token" ]; then
  exit 1
fi
if [ "$1 $2" = "release download" ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  cp "$FAKE_GH_ASSET" "$dir/$pattern"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  const manifest = manifestFor(asset, { private: true });
  manifest.tools[0].platforms[platformKey()].binarySha256 = "f".repeat(64);
  const workspace = path.join(fixture, "runtime");

  const previousPath = process.env.PATH;
  const previousAsset = process.env.FAKE_GH_ASSET;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  process.env.FAKE_GH_ASSET = asset.archive;
  try {
    await assert.rejects(
      () => installToolsFromManifest(workspace, "", {
        manifestOverride: manifest,
        log: false
      }),
      /binary sha256 mismatch/
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousAsset === undefined) delete process.env.FAKE_GH_ASSET;
    else process.env.FAKE_GH_ASSET = previousAsset;
  }
  assert.deepEqual(
    fs.readdirSync(path.join(workspace, ".bootstrap-cache"))
      .filter((name) => name.startsWith(".private-install-")),
    []
  );
  assert.deepEqual(
    fs.readdirSync(path.join(workspace, "bin"))
      .filter((name) => name.startsWith(".private-install-")),
    []
  );
  assert.equal(fs.existsSync(path.join(workspace, "bin", binaryName("fixture-cli"))), false);
});

test("binary checksum failure preserves an existing installed CLI", async () => {
  if (process.platform === "win32") return;
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-existing-binary-"));
  const assetDir = path.join(fixture, "assets");
  const assetName = `fixture-cli-v0.1.0-${platformKey()}.tar.gz`;
  fs.mkdirSync(assetDir, { recursive: true });
  const asset = createArchive(assetDir, assetName, "#!/bin/sh\necho replacement\n");
  const workspace = path.join(fixture, "runtime");
  const destination = path.join(workspace, "bin", binaryName("fixture-cli"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "#!/bin/sh\necho existing\n", { mode: 0o755 });
  const manifest = manifestFor(asset);
  manifest.tools[0].platforms[platformKey()].binarySha256 = "f".repeat(64);

  await assert.rejects(
    () => installToolsFromManifest(workspace, "", {
      manifestOverride: manifest,
      assetDir,
      log: false
    }),
    /binary sha256 mismatch/
  );

  assert.equal(
    fs.readFileSync(destination, "utf8"),
    "#!/bin/sh\necho existing\n"
  );
  assert.equal(fs.statSync(destination).mode & 0o777, 0o755);
});
