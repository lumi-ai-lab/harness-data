#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { verifyApprovedWikisSource } from "../npm/src/lib/approved-wikis.js";

export const realIndicatorsRelease = Object.freeze({
  version: "v0.0.4",
  platforms: {
    "darwin-amd64": {
      archive: "tar.gz",
      url: "https://github.com/pengmide/qdm-indicators-cli/releases/download/v0.0.4/qdm-indicators-cli-v0.0.4-darwin-amd64.tar.gz",
      sha256: "beb93f03413d2563cc2b5a4349ecf3b0fe382fbc33ed8c999dfddf4d686a29a8",
      binarySha256: "390a193653915e0e7ac9d31d72a3ab2966f495a9127247ab565ec185b38452d9"
    },
    "darwin-arm64": {
      archive: "tar.gz",
      url: "https://github.com/pengmide/qdm-indicators-cli/releases/download/v0.0.4/qdm-indicators-cli-v0.0.4-darwin-arm64.tar.gz",
      sha256: "82a864570ed78df05c749a8c598498b0cdb3fe37a4051ed86dd88b4042eba823",
      binarySha256: "253bf6e8bbd9ceb802248d48b9985b67a1a9e6ec611209fa08440da84e7f440d"
    },
    "linux-amd64": {
      archive: "tar.gz",
      url: "https://github.com/pengmide/qdm-indicators-cli/releases/download/v0.0.4/qdm-indicators-cli-v0.0.4-linux-amd64.tar.gz",
      sha256: "c1082702ccd8a968dbb3ebb0fdc6a5043eff2fa5586bd180c78f5292308492a1",
      binarySha256: "45a7537669fb4950b7b812fe14815ab002ea7dc66efed6ce7876b24c98ce731f"
    },
    "windows-amd64": {
      archive: "zip",
      url: "https://github.com/pengmide/qdm-indicators-cli/releases/download/v0.0.4/qdm-indicators-cli-v0.0.4-windows-amd64.zip",
      sha256: "7d5d822d381ae3d09723fc67dfdfe32c6c08c201cbd63fe119a1527a55934cb4",
      binarySha256: "9d745d0eaee4f63032e38b216fab525f1e5f3e320d25bde694f3c9dfc3147661"
    }
  }
});

const REAL_INDICATORS_LINUX_AMD64 = realIndicatorsRelease.platforms["linux-amd64"];

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
  real.platforms = {};
  for (const [platform, meta] of Object.entries(realIndicatorsRelease.platforms)) {
    real.platforms[platform] = { ...meta };
  }
  if (options.realCliArchive) {
    const archives = Array.isArray(options.realCliArchive) ? options.realCliArchive : [options.realCliArchive];
    for (const archive of archives) {
      const resolved = path.resolve(archive);
      const basename = path.basename(resolved);
      const matched = Object.entries(realIndicatorsRelease.platforms).find(
        ([, meta]) => meta.url.endsWith(`/${basename}`)
      );
      if (!matched) {
        throw new Error(`real Indicators CLI archive does not match any frozen platform: ${basename}`);
      }
      const [platform, meta] = matched;
      const actual = sha256(fs.readFileSync(resolved));
      if (actual !== meta.sha256) {
        throw new Error(`real Indicators CLI v0.0.4 archive checksum does not match the frozen contract for ${platform}: ${basename}`);
      }
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
  releaseSet.realIndicatorsSha256 = REAL_INDICATORS_LINUX_AMD64.binarySha256;
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

const repeatableArgs = new Set(["realCliArchive"]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (repeatableArgs.has(key)) {
      (options[key] ||= []).push(value);
    } else {
      options[key] = value;
    }
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
