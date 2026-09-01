import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  packQwenPawZip,
  resolvedVersion,
  stageQwenPawPlugin,
  verifyQwenPawPlugin,
} from "./build-qwenpaw-plugin.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "qdm-qwenpaw-build-")), "qdm-harness-qwenpaw");
  return root;
}

test("stage + verify QwenPaw plugin artifact", () => {
  const root = fixture();
  try {
    const report = stageQwenPawPlugin({ artifactRoot: root });
    const verified = verifyQwenPawPlugin({ artifactRoot: root });
    assert.equal(verified.version, report.version);
    assert.equal(verified.version, resolvedVersion(root, ""));
    const plugin = JSON.parse(readFileSync(path.join(root, "plugin.json"), "utf8"));
    assert.equal(plugin.version, verified.version);
    const manifest = JSON.parse(readFileSync(path.join(root, "plugin-manifest.json"), "utf8"));
    assert.equal(manifest.host, "qwenpaw");
    assert.equal(manifest.plugin.version, verified.version);
    assert.equal(manifest.resource.mode, "external");
    assert.ok(manifest.core.packages.dataHarnessCli?.version, "core package binding required");
    assert.ok(existsSync(path.join(root, "scripts", "data-harness-cli")));
    assert.ok(existsSync(path.join(root, "dist", "data-harness-cli", "src", "main.js")));
    assert.ok(!existsSync(path.join(root, "tests")));
    assert.ok(!existsSync(path.join(root, "install-qwenpaw-plugin.py")));
    assert.ok(!existsSync(path.join(root, "__pycache__")));
  } finally {
    rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test("verify rejects a version mismatch", () => {
  const root = fixture();
  try {
    stageQwenPawPlugin({ artifactRoot: root });
    assert.throws(() => verifyQwenPawPlugin({ artifactRoot: root, version: "0.0.999" }), /does not match/);
  } finally {
    rmSync(path.dirname(root), { recursive: true, force: true });
  }
});

test("pack produces a zip and keeps the stage relocatable", () => {
  const root = fixture();
  const zip = path.join(path.dirname(root), "qwenpaw.zip");
  try {
    stageQwenPawPlugin({ artifactRoot: root });
    const packed = packQwenPawZip({ artifactRoot: root, zipPath: zip });
    assert.ok(existsSync(zip));
    assert.ok(packed.version);
  } finally {
    rmSync(path.dirname(root), { recursive: true, force: true });
  }
});
