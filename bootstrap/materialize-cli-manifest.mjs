#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyApprovedWikisSource } from "../npm/src/lib/approved-wikis.js";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function readChecksum(file) {
  if (!fs.existsSync(file)) throw new Error(`release checksum is missing: ${file}`);
  const value = fs.readFileSync(file, "utf8").trim().split(/\s+/)[0];
  if (!validSha256(value)) throw new Error(`release checksum is invalid: ${file}`);
  return value;
}

function archiveSuffix(asset, platform) {
  if (asset?.archive) return asset.archive;
  return platform.startsWith("windows-") ? "zip" : "tar.gz";
}

function releaseAssetMetadata(distDir, tool, version, platform) {
  const asset = tool.platforms?.[platform];
  if (!asset) throw new Error(`${tool.name} does not declare ${platform}`);
  const name = `${tool.binary}-${version}-${platform}.${archiveSuffix(asset, platform)}`;
  const archive = path.join(distDir, name);
  if (!fs.existsSync(archive) || !fs.statSync(archive).isFile()) {
    throw new Error(`release archive is missing: ${archive}`);
  }
  const archiveSha256 = readChecksum(`${archive}.sha256`);
  if (archiveSha256 !== sha256(fs.readFileSync(archive))) {
    throw new Error(`release archive checksum does not match: ${name}`);
  }
  return {
    name,
    archiveSha256,
    binarySha256: readChecksum(`${archive}.binary.sha256`)
  };
}

function requireTool(manifest, name) {
  const tool = manifest.tools?.find((entry) => entry.name === name);
  if (!tool) throw new Error(`manifest tool is missing: ${name}`);
  return tool;
}

function fixedReleaseURL(repo, version, name) {
  return `https://github.com/${repo}/releases/download/${version}/${name}`;
}

function releaseSetDigest(releaseSet) {
  return sha256(JSON.stringify({
    platform: releaseSet.platform,
    version: releaseSet.version,
    publicMetricVersion: releaseSet.publicMetricVersion,
    publicMetricSha256: releaseSet.publicMetricSha256,
    realMetricVersion: releaseSet.realMetricVersion,
    realMetricSha256: releaseSet.realMetricSha256,
    catalogSha256: releaseSet.catalogSha256,
    authzSchemaVersion: releaseSet.authzSchemaVersion,
    piVersion: releaseSet.piVersion
  }));
}

export function materializeReleaseManifest(options) {
  const version = String(options.version || "").trim();
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`release version must match vMAJOR.MINOR.PATCH: ${version || "missing"}`);
  }
  const qdmMetricVersion = String(options.qdmMetricVersion || "").trim();
  if (qdmMetricVersion !== "v0.1.0") {
    throw new Error(`qdm-metric-cli release must be pinned to v0.1.0: ${qdmMetricVersion || "missing"}`);
  }
  if (!options.approvedWikisSource || !options.approvedWikisManifest) {
    throw new Error("business-approved Wikis source and allowlist manifest are required for release");
  }

  const templatePath = path.resolve(options.manifest);
  const outputPath = path.resolve(options.output);
  const distDir = path.resolve(options.dist);
  const qdmMetricDist = path.resolve(options.qdmMetricDist);
  const approvedWikisSource = path.resolve(options.approvedWikisSource);
  const approvedWikisManifest = path.resolve(options.approvedWikisManifest);
  const approvedMetricCatalog = path.resolve(
    options.approvedMetricCatalog || path.join(templatePath, "..", "approved-metrics-v1.json")
  );
  if (!fs.existsSync(approvedMetricCatalog)) {
    throw new Error(`approved Metric catalog is missing: ${approvedMetricCatalog}`);
  }
  const approvedMetricCatalogSha256 = sha256(fs.readFileSync(approvedMetricCatalog));
  const approvedWikisManifestRaw = fs.readFileSync(approvedWikisManifest);
  const approvedWikisManifestSha256 = sha256(approvedWikisManifestRaw);
  verifyApprovedWikisSource(
    approvedWikisSource,
    approvedWikisManifest,
    approvedWikisManifestSha256
  );

  const manifest = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  if (manifest.schemaVersion !== 3) {
    throw new Error("release manifest template must use schemaVersion 3");
  }
  const profile = manifest.profiles?.["lumi-mvp-required"];
  if (!profile) throw new Error("release manifest template is missing lumi-mvp-required");
  if (profile.agent !== "pi") {
    throw new Error("release manifest lumi-mvp-required profile must declare agent pi");
  }

  const helper = requireTool(manifest, "data-harness-cli");
  helper.tracking = "fixed";
  helper.version = version;
  helper.requireAssetSha256 = true;
  helper.requireBinarySha256 = true;
  for (const platform of Object.keys(helper.platforms || {})) {
    const metadata = releaseAssetMetadata(distDir, helper, version, platform);
    helper.platforms[platform] = {
      ...helper.platforms[platform],
      url: fixedReleaseURL(helper.repo, version, metadata.name),
      sha256: metadata.archiveSha256,
      binarySha256: metadata.binarySha256
    };
  }

  const publicMetric = requireTool(manifest, "qdm-metric-cli");
  publicMetric.tracking = "fixed";
  publicMetric.version = version;
  publicMetric.requireAssetSha256 = true;
  publicMetric.requireBinarySha256 = true;
  for (const platform of Object.keys(publicMetric.platforms || {})) {
    const metadata = releaseAssetMetadata(distDir, publicMetric, version, platform);
    publicMetric.platforms[platform] = {
      ...publicMetric.platforms[platform],
      url: fixedReleaseURL(publicMetric.repo, version, metadata.name),
      sha256: metadata.archiveSha256,
      binarySha256: metadata.binarySha256
    };
  }
  const realMetric = requireTool(manifest, "qdm-metric-cli-real");
  realMetric.tracking = "fixed";
  realMetric.version = qdmMetricVersion;
  realMetric.destination = `/opt/harness-data/private/qdm-metric-cli-${qdmMetricVersion}`;
  realMetric.requireAssetSha256 = true;
  realMetric.requireBinarySha256 = true;
  for (const platform of Object.keys(realMetric.platforms || {})) {
    const metadata = releaseAssetMetadata(qdmMetricDist, realMetric, qdmMetricVersion, platform);
    realMetric.platforms[platform] = {
      ...realMetric.platforms[platform],
      url: fixedReleaseURL(realMetric.repo, qdmMetricVersion, metadata.name),
      sha256: metadata.archiveSha256,
      binarySha256: metadata.binarySha256
    };
  }

  const releaseSet = manifest.releaseSets?.["lumi-mvp-v1"];
  if (!releaseSet) throw new Error("release manifest template is missing lumi-mvp-v1 release-set");
  releaseSet.version = version;
  releaseSet.publicMetricVersion = version;
  releaseSet.realMetricVersion = realMetric.version;
  releaseSet.catalogSha256 = approvedMetricCatalogSha256;
  const releasePlatforms = Object.keys(releaseSet.platforms || {});
  if (releasePlatforms.length === 0) {
    throw new Error("lumi-mvp-v1 release-set must declare per-platform artifacts");
  }
  for (const tool of [publicMetric, realMetric]) {
    for (const platform of Object.keys(tool.platforms || {})) {
      if (!releaseSet.platforms[platform]) {
        throw new Error(`lumi-mvp-v1 release-set does not declare ${platform}`);
      }
    }
  }
  for (const platform of releasePlatforms) {
    const publicMetricSha256 = publicMetric.platforms?.[platform]?.binarySha256;
    const realMetricSha256 = realMetric.platforms?.[platform]?.binarySha256;
    if (!validSha256(publicMetricSha256) || !validSha256(realMetricSha256)) {
      throw new Error(`lumi-mvp-v1 release-set artifacts are incomplete for ${platform}`);
    }
    const platformReleaseSet = {
      platform,
      version: releaseSet.version,
      publicMetricVersion: releaseSet.publicMetricVersion,
      publicMetricSha256,
      realMetricVersion: releaseSet.realMetricVersion,
      realMetricSha256,
      catalogSha256: releaseSet.catalogSha256,
      authzSchemaVersion: releaseSet.authzSchemaVersion,
      piVersion: releaseSet.piVersion
    };
    releaseSet.platforms[platform] = {
      sha256: releaseSetDigest(platformReleaseSet),
      publicMetricSha256,
      realMetricSha256
    };
  }

  profile.approvedWikis = {
    source: "bootstrap/approved-lumi-wikis",
    manifest: "bootstrap/approved-lumi-wikis-manifest.json",
    manifestSha256: approvedWikisManifestSha256
  };
  profile.approvedMetricCatalog = {
    source: "bootstrap/approved-metrics-v1.json",
    destination: "/etc/harness-data/approved-metrics-v1.json",
    sha256: approvedMetricCatalogSha256
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const approvedWikisOutput = path.join(path.dirname(outputPath), "approved-lumi-wikis");
  if (path.resolve(approvedWikisOutput) === approvedWikisSource) {
    throw new Error("approved Wikis release output must not overwrite its source");
  }
  fs.rmSync(approvedWikisOutput, { recursive: true, force: true });
  fs.cpSync(approvedWikisSource, approvedWikisOutput, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git"
  });
  fs.copyFileSync(
    approvedWikisManifest,
    path.join(path.dirname(outputPath), "approved-lumi-wikis-manifest.json")
  );
  fs.copyFileSync(
    approvedMetricCatalog,
    path.join(path.dirname(outputPath), "approved-metrics-v1.json")
  );
  return manifest;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options[key] = value;
  }
  for (const key of [
    "manifest",
    "output",
    "version",
    "dist",
    "qdmMetricVersion",
    "qdmMetricDist",
    "approvedWikisSource",
    "approvedWikisManifest"
  ]) {
    if (!options[key]) {
      const flag = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      throw new Error(`--${flag} is required`);
    }
  }
  return options;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  try {
    materializeReleaseManifest(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
