import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { materializeReleaseManifest } from "../../bootstrap/materialize-cli-manifest.mjs";
import { piRequesterReleaseSet, piRequesterReleaseSetDigest } from "../src/lib/profile.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const releasePlatforms = [
  ["darwin-arm64", "tar.gz"],
  ["darwin-amd64", "tar.gz"],
  ["linux-amd64", "tar.gz"],
  ["windows-amd64", "zip"]
];

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

function writeReleaseAssets(dist, qdmMetricDist, version, qdmMetricVersion) {
  for (const [platform, archive] of releasePlatforms) {
    writeReleaseAsset(dist, `data-harness-cli-${version}-${platform}.${archive}`, `helper:${platform}`);
    writeReleaseAsset(dist, `qdm-metric-cli-${version}-${platform}.${archive}`, `authorized-metric:${platform}`);
    writeReleaseAsset(qdmMetricDist, `qdm-metric-cli-${qdmMetricVersion}-${platform}.${archive}`, `metric:${platform}`);
  }
}

test("release-set digest matches the cross-language canonical vector", () => {
  assert.equal(piRequesterReleaseSetDigest({
    platform: "darwin-arm64",
    version: "v1.2.3",
    publicMetricVersion: "v1.2.3",
    publicMetricSha256: "a".repeat(64),
    realMetricVersion: "v0.1.0",
    realMetricSha256: "b".repeat(64),
    catalogSha256: "c".repeat(64),
    authzSchemaVersion: 1,
    piVersion: "0.81.1"
  }), "143590d13fd20b776d7cd1403349b28403feb7a796d791fd55fad122f5a5bdb5");
});

test("release manifest materializer fixes both runtime CLIs", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-release-manifest-"));
  const dist = path.join(fixture, "dist");
  const qdmMetricDist = path.join(fixture, "qdm-metric-dist");
  const output = path.join(fixture, "runtime", "bootstrap", "cli-manifest.json");
  const version = "v1.2.3";
  const qdmMetricVersion = "v0.1.0";
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(qdmMetricDist, { recursive: true });
  const approvedWikis = writeApprovedWikisFixture(fixture);

  writeReleaseAssets(dist, qdmMetricDist, version, qdmMetricVersion);

  const manifest = materializeReleaseManifest({
    manifest: path.join(repository, "bootstrap", "cli-manifest.json"),
    output,
    version,
    dist,
    qdmMetricVersion,
    qdmMetricDist,
    approvedWikisSource: approvedWikis.source,
    approvedWikisManifest: approvedWikis.manifest
  });

  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]);
  assert.deepEqual(manifest.profiles["local-unrestricted"].tools, ["data-harness-cli", "qdm-metric-cli"]);
  assert.equal(manifest.profiles["pi-requester-authorized"].agent, "pi");
  assert.deepEqual(manifest.profiles["pi-requester-authorized"].tools, ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]);
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
  assert.equal(manifest.tools[2].version, qdmMetricVersion);
  assert.equal(manifest.tools[2].destination, `/opt/harness-data/private/qdm-metric-cli-${qdmMetricVersion}`);
  assert.match(
    manifest.tools[2].platforms["linux-amd64"].url,
    /pengmide\/qdm-metric-cli\/releases\/download\/v0\.1\.0\/qdm-metric-cli-v0\.1\.0-linux-amd64\.tar\.gz$/
  );
  const releaseSet = manifest.releaseSets["pi-requester-v1"];
  assert.equal(releaseSet.sha256, undefined);
  assert.equal(releaseSet.publicMetricSha256, undefined);
  assert.equal(releaseSet.realMetricSha256, undefined);
  assert.equal(releaseSet.realMetricVersion, qdmMetricVersion);
  const platformDigests = new Set();
  for (const platform of Object.keys(releaseSet.platforms)) {
    const platformReleaseSet = releaseSet.platforms[platform];
    assert.equal(platformReleaseSet.publicMetricSha256, sha256(`authorized-metric:${platform}`));
    assert.equal(platformReleaseSet.realMetricSha256, sha256(`metric:${platform}`));
    const selected = piRequesterReleaseSet(manifest, platform);
    assert.equal(selected.key, "pi-requester-v1");
    assert.equal(selected.platform, platform);
    assert.equal(selected.publicMetricSha256, platformReleaseSet.publicMetricSha256);
    assert.equal(selected.realMetricSha256, platformReleaseSet.realMetricSha256);
    assert.equal(selected.sha256, piRequesterReleaseSetDigest(selected));
    platformDigests.add(selected.sha256);
  }
  assert.equal(platformDigests.size, Object.keys(releaseSet.platforms).length);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), manifest);
});

test("release manifest rejects missing and extra release-set platforms", () => {
  for (const [name, mutate, pattern] of [
    [
      "missing platform",
      (manifest) => delete manifest.releaseSets["pi-requester-v1"].platforms["linux-amd64"],
      /does not declare linux-amd64/
    ],
    [
      "extra platform",
      (manifest) => {
        manifest.releaseSets["pi-requester-v1"].platforms["linux-arm64"] = {
          sha256: "",
          publicMetricSha256: "",
          realMetricSha256: ""
        };
      },
      /artifacts are incomplete for linux-arm64/
    ]
  ]) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), `harness-release-platform-${name.replaceAll(" ", "-")}-`));
    const dist = path.join(fixture, "dist");
    const qdmMetricDist = path.join(fixture, "qdm-metric-dist");
    const template = path.join(fixture, "cli-manifest.json");
    const version = "v1.2.3";
    const qdmMetricVersion = "v0.1.0";
    fs.mkdirSync(dist, { recursive: true });
    fs.mkdirSync(qdmMetricDist, { recursive: true });
    const approvedWikis = writeApprovedWikisFixture(fixture);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repository, "bootstrap", "cli-manifest.json"), "utf8")
    );
    mutate(manifest);
    fs.writeFileSync(template, `${JSON.stringify(manifest, null, 2)}\n`);
    writeReleaseAssets(dist, qdmMetricDist, version, qdmMetricVersion);

    assert.throws(() => materializeReleaseManifest({
      manifest: template,
      output: path.join(fixture, "runtime", "bootstrap", "cli-manifest.json"),
      version,
      dist,
      qdmMetricVersion,
      qdmMetricDist,
      approvedWikisSource: approvedWikis.source,
      approvedWikisManifest: approvedWikis.manifest,
      approvedMetricCatalog: path.join(repository, "bootstrap", "approved-metrics-v1.json")
    }), pattern);
  }
});

test("release manifest rejects a Metric CLI other than v0.1.0", () => {
  assert.throws(() => materializeReleaseManifest({
    version: "v1.2.3",
    qdmMetricVersion: "v0.1.1"
  }), /must be pinned to v0\.1\.0/);
});

test("release manifest materialization requires pinned Wikis source and manifest", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-release-manifest-"));
  assert.throws(() => materializeReleaseManifest({
    manifest: path.join(repository, "bootstrap", "cli-manifest.json"),
    output: path.join(fixture, "output.json"),
    version: "v1.2.3",
    dist: fixture,
    qdmMetricVersion: "v0.1.0",
    qdmMetricDist: fixture
  }), /pinned Wikis source.*allowlist manifest/);
});
