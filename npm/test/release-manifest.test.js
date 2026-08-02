import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { materializeReleaseManifest } from "../../bootstrap/materialize-cli-manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeReleaseAsset(dist, name, binaryMarker) {
  const archive = Buffer.from(`archive:${name}\n`);
  const file = path.join(dist, name);
  fs.writeFileSync(file, archive);
  fs.writeFileSync(`${file}.sha256`, `${sha256(archive)}  ${name}\n`);
  fs.writeFileSync(`${file}.binary.sha256`, `${sha256(binaryMarker)}  binary\n`);
}

function writeApprovedWikisFixture(root) {
  const source = path.join(root, "approved-lumi-wikis");
  const manifest = path.join(root, "approved-lumi-wikis-manifest.json");
  const files = {
    "dims/approved.md": "# Approved dim\n",
    "index.md": "# Approved Lumi Wikis\n",
    "metrics/approved.md": "# Approved metric\n",
    "reports/approved.md": "# Approved report\n",
    "rules/approved.md": "# Approved rule\n"
  };
  const entries = Object.entries(files)
    .map(([file, value]) => ({ path: file, sha256: sha256(value) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const [file, value] of Object.entries(files)) {
    const destination = path.join(source, ...file.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, value);
  }
  fs.writeFileSync(manifest, `${JSON.stringify({ version: 1, files: entries }, null, 2)}\n`);
  return { source, manifest };
}

test("release manifest materializer fixes both runtime CLIs", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-release-manifest-"));
  const dist = path.join(fixture, "dist");
  const qdmMetricDist = path.join(fixture, "qdm-metric-dist");
  const output = path.join(fixture, "runtime", "bootstrap", "cli-manifest.json");
  const version = "v1.2.3";
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(qdmMetricDist, { recursive: true });
  const approvedWikis = writeApprovedWikisFixture(fixture);

  for (const [platform, archive] of [
    ["darwin-arm64", "tar.gz"],
    ["darwin-amd64", "tar.gz"],
    ["linux-amd64", "tar.gz"],
    ["windows-amd64", "zip"]
  ]) {
    writeReleaseAsset(dist, `data-harness-cli-${version}-${platform}.${archive}`, `helper:${platform}`);
    writeReleaseAsset(dist, `qdm-metric-cli-${version}-${platform}.${archive}`, `authorized-metric:${platform}`);
    writeReleaseAsset(qdmMetricDist, `qdm-metric-cli-v0.1.0-${platform}.${archive}`, `metric:${platform}`);
  }

  const manifest = materializeReleaseManifest({
    manifest: path.join(repository, "bootstrap", "cli-manifest.json"),
    output,
    version,
    dist,
    qdmMetricVersion: "v0.1.0",
    qdmMetricDist,
    approvedWikisSource: approvedWikis.source,
    approvedWikisManifest: approvedWikis.manifest
  });

  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]);
  assert.deepEqual(manifest.profiles["local-unrestricted"].tools, ["data-harness-cli", "qdm-metric-cli"]);
  assert.deepEqual(manifest.profiles["lumi-mvp-required"].tools, ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]);
  assert.equal(manifest.tools[0].tracking, "fixed");
  assert.equal(manifest.tools[0].version, version);
  assert.match(
    manifest.tools[0].platforms["linux-amd64"].url,
    /data-harness-cli-v1\.2\.3-linux-amd64\.tar\.gz$/
  );
  assert.equal(manifest.tools[1].tracking, "fixed");
  assert.equal(manifest.tools[1].version, version);
  assert.match(
    manifest.tools[1].platforms["linux-amd64"].url,
    /lumi-ai-lab\/harness-data\/releases\/download\/v1\.2\.3\/qdm-metric-cli-v1\.2\.3-linux-amd64\.tar\.gz$/
  );
  assert.match(manifest.tools[1].platforms["linux-amd64"].sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.tools[1].platforms["linux-amd64"].binarySha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.tools[2].tracking, "fixed");
  assert.equal(manifest.tools[2].version, "v0.1.0");
  assert.match(
    manifest.tools[2].platforms["linux-amd64"].url,
    /pengmide\/qdm-metric-cli\/releases\/download\/v0\.1\.0\/qdm-metric-cli-v0\.1\.0-linux-amd64\.tar\.gz$/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), manifest);
});

test("release manifest materialization requires approved Wikis", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-release-manifest-"));
  assert.throws(() => materializeReleaseManifest({
    manifest: path.join(repository, "bootstrap", "cli-manifest.json"),
    output: path.join(fixture, "output.json"),
    version: "v1.2.3",
    dist: fixture,
    qdmMetricVersion: "v0.1.0",
    qdmMetricDist: fixture
  }), /approved Wikis/);
});
