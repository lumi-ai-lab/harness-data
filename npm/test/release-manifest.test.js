import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  materializeReleaseManifest,
  realIndicatorsRelease
} from "../../bootstrap/materialize-cli-manifest.mjs";
import { lumiReleaseSet, lumiReleaseSetDigest } from "../src/lib/profile.js";

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
  return { archiveSha256: sha256(archive), binarySha256: sha256(binaryMarker) };
}

function catalogFixture() {
  return `${JSON.stringify({
    version: 1,
    generatedFrom: "qdm-indicators-cli-v0.0.4-contract",
    indicators: {
      saleAmt: {
        supportedDimensions: ["manageAreaId", "categoryLevel1Id"],
        dictionaryRefs: []
      }
    }
  }, null, 2)}\n`;
}

function writeApprovedWikisFixture(root) {
  const source = path.join(root, "approved-lumi-wikis");
  const manifest = path.join(root, "approved-lumi-wikis-manifest.json");
  const files = {
    "dims/批准.md": "# Approved dim\n",
    "index.md": "# Approved Lumi Wikis\n",
    "metrics/a.md": "# Prefix file\n",
    "metrics/a/x.md": "# Prefix directory file\n",
    "reports/approved.md": "# Approved report\n",
    "rules/approved.md": "# Approved rule\n"
  };
  const entries = Object.entries(files)
    .map(([file, value]) => ({ path: file, sha256: sha256(value) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const [file, value] of Object.entries(files)) {
    const destination = path.join(source, ...file.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, value);
  }
  fs.writeFileSync(manifest, `${JSON.stringify({ version: 1, files: entries }, null, 2)}\n`);
  return { source, manifest };
}

test("the shipped authorization config schema is strict and version-pinned", () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(repository, "bootstrap", "authz-config-v1.schema.json"),
    "utf8"
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.version.const, 1);
  assert.equal(schema.properties.piVersion.const, "0.81.1");
  assert.equal(schema.properties.realIndicatorsCli.properties.version.const, "0.0.4");
  assert.equal(schema.properties.realIndicatorsCli.additionalProperties, false);
  assert.equal(schema.properties.limits.additionalProperties, false);
  assert.equal(schema.$defs.sha256.pattern, "^[0-9a-f]{64}$");
});

test("release manifest materializer binds archives, binaries, catalog, and the frozen real CLI", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-release-manifest-"));
  const dist = path.join(fixture, "dist");
  const output = path.join(fixture, "runtime", "bootstrap", "cli-manifest.json");
  const catalog = path.join(fixture, "approved-indicators-v1.json");
  const catalogOutput = path.join(fixture, "runtime", "bootstrap", "approved-indicators-v1.json");
  const version = "v1.2.3";
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(catalog, catalogFixture());
  const approvedWikis = writeApprovedWikisFixture(fixture);

  for (const [platform, archive] of [
    ["darwin-arm64", "tar.gz"],
    ["darwin-amd64", "tar.gz"],
    ["linux-amd64", "tar.gz"],
    ["windows-amd64", "zip"]
  ]) {
    writeReleaseAsset(dist, `data-harness-cli-${version}-${platform}.${archive}`, `helper:${platform}`);
  }
  const facadeAssets = {};
  for (const [platform, archive] of [
    ["darwin-arm64", "tar.gz"],
    ["darwin-amd64", "tar.gz"],
    ["linux-amd64", "tar.gz"],
    ["windows-amd64", "zip"]
  ]) {
    facadeAssets[platform] = writeReleaseAsset(
      dist,
      `qdm-indicators-facade-${version}-${platform}.${archive}`,
      `facade:${platform}`
    );
  }

  const manifest = materializeReleaseManifest({
    manifest: path.join(repository, "bootstrap", "cli-manifest.json"),
    output,
    version,
    dist,
    catalog,
    catalogOutput,
    approvedWikisSource: approvedWikis.source,
    approvedWikisManifest: approvedWikis.manifest
  });
  const releaseSet = lumiReleaseSet(manifest);
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const helper = byName.get("data-harness-cli");
  const facadeTool = byName.get("qdm-indicators-facade");
  const real = byName.get("qdm-indicators-cli-real");

  assert.equal(helper.tracking, "fixed");
  assert.equal(helper.version, version);
  assert.match(helper.platforms["linux-amd64"].url, new RegExp(`${version}/data-harness-cli-${version}-linux-amd64\\.tar\\.gz$`));
  assert.equal(helper.platforms["linux-amd64"].binarySha256, sha256("helper:linux-amd64"));
  for (const [platform, asset] of Object.entries(facadeAssets)) {
    assert.equal(facadeTool.platforms[platform].sha256, asset.archiveSha256);
    assert.equal(facadeTool.platforms[platform].binarySha256, asset.binarySha256);
  }
  assert.equal(releaseSet.facadeSha256, facadeAssets["linux-amd64"].binarySha256);
  assert.equal(real.version, realIndicatorsRelease.version);
  assert.equal(real.platforms["linux-amd64"].url, realIndicatorsRelease.platforms["linux-amd64"].url);
  assert.equal(real.platforms["linux-amd64"].sha256, realIndicatorsRelease.platforms["linux-amd64"].sha256);
  assert.equal(real.platforms["darwin-arm64"].url, realIndicatorsRelease.platforms["darwin-arm64"].url);
  assert.equal(real.platforms["windows-amd64"].archive, "zip");
  assert.equal(releaseSet.realIndicatorsSha256, realIndicatorsRelease.platforms["linux-amd64"].binarySha256);
  assert.equal(releaseSet.catalogSha256, sha256(fs.readFileSync(catalog)));
  assert.equal(releaseSet.sha256, lumiReleaseSetDigest(releaseSet));
  assert.deepEqual(fs.readFileSync(catalogOutput), fs.readFileSync(catalog));
  assert.deepEqual(
    fs.readFileSync(path.join(path.dirname(output), "approved-lumi-wikis-manifest.json")),
    fs.readFileSync(approvedWikis.manifest)
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), manifest);
});

test("release manifest materialization fails when the approved catalog is absent", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-release-manifest-"));
  assert.throws(() => materializeReleaseManifest({
    manifest: path.join(repository, "bootstrap", "cli-manifest.json"),
    output: path.join(fixture, "output.json"),
    version: "v1.2.3",
    dist: fixture,
    catalog: path.join(fixture, "missing.json")
  }), /business-approved indicator catalog is required/);
});

test("release manifest materialization fails without an approved Wikis allowlist artifact", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "harness-release-manifest-"));
  const catalog = path.join(fixture, "approved-indicators-v1.json");
  fs.writeFileSync(catalog, catalogFixture());
  assert.throws(() => materializeReleaseManifest({
    manifest: path.join(repository, "bootstrap", "cli-manifest.json"),
    output: path.join(fixture, "output.json"),
    version: "v1.2.3",
    dist: fixture,
    catalog
  }), /business-approved Wikis source and allowlist manifest are required/);
});
