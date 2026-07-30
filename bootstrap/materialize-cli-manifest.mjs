#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { verifyApprovedWikisSource } from "../npm/src/lib/approved-wikis.js";

export const realIndicatorsRelease = Object.freeze({
  version: "v0.0.4",
  url: "https://github.com/pengmide/qdm-indicators-cli/releases/download/v0.0.4/qdm-indicators-cli-v0.0.4-linux-amd64.tar.gz",
  archiveSha256: "c1082702ccd8a968dbb3ebb0fdc6a5043eff2fa5586bd180c78f5292308492a1",
  binarySha256: "45a7537669fb4950b7b812fe14815ab002ea7dc66efed6ce7876b24c98ce731f"
});

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
  const actualArchiveSha256 = sha256(fs.readFileSync(archive));
  if (archiveSha256 !== actualArchiveSha256) {
    throw new Error(`release archive checksum does not match: ${name}`);
  }
  const binarySha256 = readChecksum(`${archive}.binary.sha256`);
  return { name, archiveSha256, binarySha256 };
}

function requireTool(manifest, name) {
  const tool = manifest.tools?.find((entry) => entry.name === name);
  if (!tool) throw new Error(`manifest tool is missing: ${name}`);
  return tool;
}

export function validateApprovedIndicatorCatalog(raw, file) {
  if (raw.length === 0 || raw.length > 4 * 1024 * 1024) {
    throw new Error(`approved indicator catalog has an invalid size: ${file}`);
  }
  let catalog;
  try {
    catalog = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`approved indicator catalog is not valid JSON: ${error.message}`);
  }
  if (catalog?.version !== 1 || catalog?.generatedFrom !== "qdm-indicators-cli-v0.0.4-contract") {
    throw new Error("approved indicator catalog does not target the frozen v0.0.4 contract");
  }
  const indicators = catalog?.indicators;
  if (!indicators || typeof indicators !== "object" || Array.isArray(indicators) || Object.keys(indicators).length === 0) {
    throw new Error("approved indicator catalog must contain at least one approved indicator");
  }
  for (const [code, indicator] of Object.entries(indicators)) {
    if (!code || !indicator || typeof indicator !== "object" || Array.isArray(indicator)) {
      throw new Error("approved indicator catalog contains an invalid indicator entry");
    }
    const dimensions = indicator.supportedDimensions;
    if (!Array.isArray(dimensions) || !dimensions.includes("manageAreaId") || !dimensions.includes("categoryLevel1Id")) {
      throw new Error(`approved indicator ${code} does not support both protected dimensions`);
    }
  }
}

function validateCatalogWithHarnessCLI(executable, catalogPath, catalogSha256) {
  const result = spawnSync(path.resolve(executable), [
    "authz-validate-catalog",
    "--path",
    catalogPath,
    "--sha256",
    catalogSha256
  ], { encoding: "utf8" });
  let body = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {}
  if (result.status !== 0 || body?.valid !== true) {
    throw new Error("business-approved indicator catalog failed the Harness strict catalog contract");
  }
}

function releaseSetDigest(releaseSet) {
  const canonical = {
    version: releaseSet.version,
    facadeVersion: releaseSet.facadeVersion,
    facadeSha256: releaseSet.facadeSha256,
    realIndicatorsVersion: releaseSet.realIndicatorsVersion,
    realIndicatorsSha256: releaseSet.realIndicatorsSha256,
    catalogSha256: releaseSet.catalogSha256,
    authzSchemaVersion: releaseSet.authzSchemaVersion,
    piVersion: releaseSet.piVersion
  };
  return sha256(JSON.stringify(canonical));
}

function fixedReleaseURL(repo, version, name) {
  return `https://github.com/${repo}/releases/download/${version}/${name}`;
}

export function materializeReleaseManifest(options) {
  const version = String(options.version || "").trim();
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`release version must match vMAJOR.MINOR.PATCH: ${version || "missing"}`);
  }
  const templatePath = path.resolve(options.manifest);
  const outputPath = path.resolve(options.output);
  const distDir = path.resolve(options.dist);
  const catalogPath = path.resolve(options.catalog);
  if (!fs.existsSync(catalogPath) || !fs.statSync(catalogPath).isFile()) {
    throw new Error(`business-approved indicator catalog is required for release: ${catalogPath}`);
  }
  const catalogRaw = fs.readFileSync(catalogPath);
  validateApprovedIndicatorCatalog(catalogRaw, catalogPath);
  const catalogSha256 = sha256(catalogRaw);
  if (options.catalogValidator) {
    validateCatalogWithHarnessCLI(options.catalogValidator, catalogPath, catalogSha256);
  }
  if (!options.approvedWikisSource || !options.approvedWikisManifest) {
    throw new Error("business-approved Wikis source and allowlist manifest are required for release");
  }
  const approvedWikisSource = path.resolve(options.approvedWikisSource);
  const approvedWikisManifest = path.resolve(options.approvedWikisManifest);
  if (!fs.existsSync(approvedWikisSource) || !fs.existsSync(approvedWikisManifest)) {
    throw new Error("business-approved Wikis source and allowlist manifest are required for release");
  }
  const approvedWikisManifestRaw = fs.readFileSync(approvedWikisManifest);
  const approvedWikisManifestSha256 = sha256(approvedWikisManifestRaw);
  verifyApprovedWikisSource(approvedWikisSource, approvedWikisManifest, approvedWikisManifestSha256);

  const manifest = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  if (manifest.schemaVersion !== 3) throw new Error("release manifest template must use schemaVersion 3");
  const profile = manifest.profiles?.["lumi-mvp-required"];
  if (!profile) throw new Error("release manifest template is missing lumi-mvp-required");
  const releaseSetKey = String(profile.releaseSet || "");
  const releaseSet = manifest.releaseSets?.[releaseSetKey];
  if (!releaseSet) throw new Error("release manifest template is missing its Lumi release-set");

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

  const facade = requireTool(manifest, "qdm-indicators-facade");
  facade.tracking = "fixed";
  facade.version = version;
  facade.requireAssetSha256 = true;
  facade.requireBinarySha256 = true;
  const facadePlatforms = Object.keys(facade.platforms || {});
  if (!facadePlatforms.includes("linux-amd64")) {
    throw new Error("Lumi Facade must declare linux-amd64");
  }
  let facadeBinarySha256 = "";
  for (const platform of facadePlatforms) {
    const metadata = releaseAssetMetadata(distDir, facade, version, platform);
    facade.platforms[platform] = {
      ...facade.platforms[platform],
      url: fixedReleaseURL(facade.repo, version, metadata.name),
      sha256: metadata.archiveSha256,
      binarySha256: metadata.binarySha256
    };
    if (platform === "linux-amd64") facadeBinarySha256 = metadata.binarySha256;
  }

  const real = requireTool(manifest, "qdm-indicators-cli-real");
  real.tracking = "fixed";
  real.version = realIndicatorsRelease.version;
  real.requireAssetSha256 = true;
  real.requireBinarySha256 = true;
  real.platforms = {
    "linux-amd64": {
      archive: "tar.gz",
      url: realIndicatorsRelease.url,
      sha256: realIndicatorsRelease.archiveSha256,
      binarySha256: realIndicatorsRelease.binarySha256
    }
  };
  if (options.realCliArchive) {
    const actual = sha256(fs.readFileSync(path.resolve(options.realCliArchive)));
    if (actual !== realIndicatorsRelease.archiveSha256) {
      throw new Error("real Indicators CLI v0.0.4 archive checksum does not match the frozen contract");
    }
  }

  profile.approvedIndicatorCatalog = {
    source: "bootstrap/approved-indicators-v1.json",
    destination: "/etc/harness-data/approved-indicators-v1.json",
    sha256: catalogSha256
  };
  profile.approvedWikis = {
    source: "bootstrap/approved-lumi-wikis",
    manifest: "bootstrap/approved-lumi-wikis-manifest.json",
    manifestSha256: approvedWikisManifestSha256
  };
  releaseSet.version = `lumi-mvp-${version}`;
  releaseSet.facadeVersion = version;
  releaseSet.facadeSha256 = facadeBinarySha256;
  releaseSet.realIndicatorsVersion = realIndicatorsRelease.version;
  releaseSet.realIndicatorsSha256 = realIndicatorsRelease.binarySha256;
  releaseSet.catalogSha256 = catalogSha256;
  releaseSet.sha256 = releaseSetDigest(releaseSet);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const approvedWikisOutput = path.join(path.dirname(outputPath), "approved-lumi-wikis");
  if (path.resolve(approvedWikisOutput) === approvedWikisSource) {
    throw new Error("approved Wikis release output must not overwrite its source");
  }
  fs.rmSync(approvedWikisOutput, { recursive: true, force: true });
  fs.cpSync(approvedWikisSource, approvedWikisOutput, { recursive: true });
  fs.copyFileSync(approvedWikisManifest, path.join(path.dirname(outputPath), "approved-lumi-wikis-manifest.json"));
  if (options.catalogOutput) {
    const catalogOutput = path.resolve(options.catalogOutput);
    fs.mkdirSync(path.dirname(catalogOutput), { recursive: true });
    fs.writeFileSync(catalogOutput, catalogRaw, { mode: 0o644 });
  }
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
  for (const key of ["manifest", "output", "version", "dist", "catalog", "catalogValidator", "approvedWikisSource", "approvedWikisManifest"]) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    materializeReleaseManifest(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`release manifest materialization failed: ${error.message}`);
    process.exitCode = 1;
  }
}
