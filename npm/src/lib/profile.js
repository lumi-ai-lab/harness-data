import crypto from "node:crypto";
import path from "node:path";
import { platformKey } from "./platform.js";

export const installerStateSchemaVersion = 4;
export const localUnrestrictedProfile = "local-unrestricted";
export const piRequesterAuthorizedProfile = "pi-requester-authorized";
export const installProfiles = [localUnrestrictedProfile, piRequesterAuthorizedProfile];

export function normalizeProfile(value, options = {}) {
  const fallback = options.defaultLocal === false ? "" : localUnrestrictedProfile;
  const profile = String(value || fallback).trim().toLowerCase();
  if (!installProfiles.includes(profile)) {
    throw new Error(`profile must be ${installProfiles.join(" or ")}`);
  }
  return profile;
}

function plainRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function supportedRealMetricVersion(value) {
  return /^v\d+\.\d+\.\d+$/.test(String(value || ""));
}

function validPiRequesterReleaseState(state) {
  const release = state.releaseSet;
  let currentPlatform;
  try {
    currentPlatform = platformKey();
  } catch {
    return false;
  }
  return plainRecord(release) &&
    ["key", "platform", "version", "publicMetricVersion", "publicMetricSha256", "realMetricVersion",
      "realMetricSha256", "catalogSha256", "piVersion", "sha256"]
      .every((field) => nonEmptyText(release[field])) &&
    ["publicMetricSha256", "realMetricSha256", "catalogSha256", "sha256"]
      .every((field) => validSha256(release[field])) &&
    release.platform === currentPlatform &&
    release.authzSchemaVersion === 1 &&
    supportedRealMetricVersion(release.realMetricVersion) &&
    release.sha256 === piRequesterReleaseSetDigest(release) &&
    (state.authzConfigPath === undefined || state.authzConfigPath === "");
}

function commonV3StateIsValid(state) {
  return nonEmptyText(state.agent) &&
    ["github-token", "local-path"].includes(state.installMode) &&
    typeof state.runtimeTag === "string" &&
    plainRecord(state.localTools) &&
    plainRecord(state.tools) &&
    validSha256(state.manifestSha256) &&
    nonEmptyText(state.packageVersion);
}

function legacyLocalStateIsUnambiguous(state, schemaVersion) {
  if (state.profile !== undefined || state.releaseSet !== undefined || state.authzConfigPath !== undefined) return false;
  if (!plainRecord(state.tools)) return false;
  if (schemaVersion === 2) return true;
  return ["github-token", "local-path"].includes(state.installMode);
}

export function profileFromState(state, options = {}) {
  if (!plainRecord(state)) return "";
  if (state.schemaVersion === installerStateSchemaVersion) {
    let profile;
    try {
      profile = normalizeProfile(state.profile, { defaultLocal: false });
    } catch {
      return "";
    }
    if (!commonV3StateIsValid(state)) return "";
    if (profile === localUnrestrictedProfile) {
      if (state.releaseSet != null || String(state.authzConfigPath || "") !== "") return "";
      return profile;
    }
    if (state.agent !== "pi" || state.installMode !== "github-token" ||
        !state.runtimeTag || Object.keys(state.localTools).length !== 0 ||
        !validPiRequesterReleaseState(state)) {
      return "";
    }
    return profile;
  }
  if (options.allowLegacyLocal !== false &&
      (state.schemaVersion === 2 || state.schemaVersion === undefined) &&
      legacyLocalStateIsUnambiguous(state, state.schemaVersion)) {
    return localUnrestrictedProfile;
  }
  return "";
}

export function manifestProfile(manifest, profile) {
  if (manifest?.schemaVersion !== 3) {
    if (profile === localUnrestrictedProfile && manifest?.schemaVersion === 2) {
      return { tools: (manifest.tools || []).map((tool) => tool.name) };
    }
    throw new Error(`manifest schemaVersion 3 is required for profile ${profile}`);
  }
  const entry = manifest.profiles?.[profile];
  if (!entry || !Array.isArray(entry.tools) || entry.tools.length === 0) {
    throw new Error(`manifest profile ${profile} must declare a non-empty tools list`);
  }
  if (profile === piRequesterAuthorizedProfile && entry.agent !== "pi") {
    throw new Error("pi-requester-authorized manifest must declare agent pi");
  }
  return entry;
}

export function selectManifestProfile(manifest, profile) {
  const entry = manifestProfile(manifest, profile);
  const names = new Set(entry.tools);
  const tools = (manifest.tools || []).filter((tool) => names.has(tool.name));
  const missing = entry.tools.filter((name) => !tools.some((tool) => tool.name === name));
  if (missing.length) throw new Error(`manifest profile ${profile} references missing tools: ${missing.join(", ")}`);
  return { ...manifest, tools };
}

function sha256JSON(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function piRequesterReleaseSetDigest(releaseSet) {
  return sha256JSON({
    platform: releaseSet?.platform,
    version: releaseSet?.version,
    publicMetricVersion: releaseSet?.publicMetricVersion,
    publicMetricSha256: releaseSet?.publicMetricSha256,
    realMetricVersion: releaseSet?.realMetricVersion,
    realMetricSha256: releaseSet?.realMetricSha256,
    catalogSha256: releaseSet?.catalogSha256,
    authzSchemaVersion: releaseSet?.authzSchemaVersion,
    piVersion: releaseSet?.piVersion
  });
}

export function piRequesterReleaseSet(manifest, platform = platformKey()) {
  const profile = manifestProfile(manifest, piRequesterAuthorizedProfile);
  const key = String(profile.releaseSet || "");
  const releaseSet = key ? manifest.releaseSets?.[key] : null;
  if (!releaseSet) throw new Error("pi-requester-authorized manifest is missing its release-set");
  const required = [
    "version", "publicMetricVersion", "realMetricVersion",
    "catalogSha256", "authzSchemaVersion", "piVersion"
  ];
  const missing = required.filter((field) => !String(releaseSet[field] || "").trim());
  if (missing.length) throw new Error(`pi-requester-authorized release-set is incomplete: ${missing.join(", ")}`);
  if (!plainRecord(releaseSet.platforms)) {
    throw new Error("pi-requester-authorized release-set must declare per-platform artifacts");
  }
  const platformReleaseSet = releaseSet.platforms[platform];
  if (!plainRecord(platformReleaseSet)) {
    throw new Error(`pi-requester-authorized release-set does not support ${platform}`);
  }
  for (const field of ["publicMetricSha256", "realMetricSha256", "sha256"]) {
    if (!validSha256(platformReleaseSet[field])) {
      throw new Error(`pi-requester-authorized release-set has invalid ${field} for ${platform}`);
    }
  }
  if (!validSha256(releaseSet.catalogSha256)) {
    throw new Error("pi-requester-authorized release-set has invalid catalogSha256");
  }
  if (!supportedRealMetricVersion(releaseSet.realMetricVersion)) {
    throw new Error("pi-requester-authorized release-set must pin realMetricVersion to a semver tag (vMAJOR.MINOR.PATCH)");
  }
  if (!Number.isInteger(releaseSet.authzSchemaVersion) || releaseSet.authzSchemaVersion < 1) {
    throw new Error("pi-requester-authorized release-set has invalid authzSchemaVersion");
  }
  const selected = {
    key,
    platform,
    version: releaseSet.version,
    publicMetricVersion: releaseSet.publicMetricVersion,
    publicMetricSha256: platformReleaseSet.publicMetricSha256,
    realMetricVersion: releaseSet.realMetricVersion,
    realMetricSha256: platformReleaseSet.realMetricSha256,
    catalogSha256: releaseSet.catalogSha256,
    authzSchemaVersion: releaseSet.authzSchemaVersion,
    piVersion: releaseSet.piVersion,
    sha256: platformReleaseSet.sha256
  };
  const expected = piRequesterReleaseSetDigest(selected);
  if (selected.sha256 !== expected) {
    throw new Error(`pi-requester-authorized release-set sha256 does not match ${platform}`);
  }
  return selected;
}

export function piRequesterMetricCatalogArtifact(manifest) {
  const profile = manifestProfile(manifest, piRequesterAuthorizedProfile);
  const catalog = profile.approvedMetricCatalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("pi-requester-authorized manifest is missing its approved Metric catalog artifact");
  }
  if (catalog.source !== "bootstrap/approved-metrics-v1.json" ||
      catalog.destination !== "bootstrap/approved-metrics-v1.json" ||
      !validSha256(catalog.sha256)) {
    throw new Error("pi-requester-authorized approved Metric catalog artifact is invalid");
  }
  const releaseSet = piRequesterReleaseSet(manifest);
  if (catalog.sha256 !== releaseSet.catalogSha256) {
    throw new Error("pi-requester-authorized approved Metric catalog does not match release-set");
  }
  return { ...catalog };
}

export function piRequesterApprovedWikisArtifact(manifest) {
  const profile = manifestProfile(manifest, piRequesterAuthorizedProfile);
  const approved = profile.approvedWikis;
  if (!approved || typeof approved !== "object" || Array.isArray(approved)) {
    throw new Error("pi-requester-authorized manifest is missing its approved Wikis content artifact");
  }
  if (approved.source !== "bootstrap/approved-lumi-wikis" ||
      approved.manifest !== "bootstrap/approved-lumi-wikis-manifest.json" ||
      !validSha256(approved.manifestSha256)) {
    throw new Error("pi-requester-authorized approved Wikis content artifact is invalid");
  }
  return { ...approved };
}

export function validateProfileAgent(profile, agent) {
  if (profile === piRequesterAuthorizedProfile && agent !== "pi") {
    throw new Error("pi-requester-authorized profile requires --agent pi");
  }
}

export function authzConfigPathFor(manifest, profile) {
	return "";
}
