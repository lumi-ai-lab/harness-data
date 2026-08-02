import crypto from "node:crypto";
import path from "node:path";

export const installerStateSchemaVersion = 3;
export const localUnrestrictedProfile = "local-unrestricted";
export const lumiRequiredProfile = "lumi-mvp-required";
export const installProfiles = [localUnrestrictedProfile, lumiRequiredProfile];
export const lumiAuthorizedAgents = ["pi", "claude", "codex", "qwen"];
export const lumiAuthorizedAgentChoices = [...lumiAuthorizedAgents, "lumi"];

export function lumiAgentSupportedOnPlatform() {
  return true;
}

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

function validLumiReleaseState(state) {
  const release = state.releaseSet;
  return plainRecord(release) &&
    ["version", "publicMetricVersion", "publicMetricSha256", "realMetricVersion",
      "realMetricSha256", "catalogSha256", "piVersion", "sha256"]
      .every((field) => nonEmptyText(release[field])) &&
    ["publicMetricSha256", "realMetricSha256", "catalogSha256", "sha256"]
      .every((field) => validSha256(release[field])) &&
    release.authzSchemaVersion === 1 &&
    release.realMetricVersion === "v0.1.0" &&
    state.authzConfigPath === "/etc/harness-data/authz.json";
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
    if (!lumiAuthorizedAgentChoices.includes(state.agent) || state.installMode !== "github-token" ||
        !state.runtimeTag || Object.keys(state.localTools).length !== 0 ||
        !validLumiReleaseState(state)) {
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
  if (profile === lumiRequiredProfile) {
    const agents = Array.isArray(entry.agents) ? entry.agents : [];
    if (agents.length !== lumiAuthorizedAgents.length ||
        new Set(agents).size !== agents.length ||
        !lumiAuthorizedAgents.every((agent) => agents.includes(agent))) {
      throw new Error(`manifest profile ${profile} must declare authorized agents: ${lumiAuthorizedAgents.join(", ")}`);
    }
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

export function lumiReleaseSetDigest(releaseSet) {
  return sha256JSON({
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

export function lumiReleaseSet(manifest) {
  const profile = manifestProfile(manifest, lumiRequiredProfile);
  const key = String(profile.releaseSet || "");
  const releaseSet = key ? manifest.releaseSets?.[key] : null;
  if (!releaseSet) throw new Error("lumi-mvp-required manifest is missing its release-set");
  const required = [
    "version", "publicMetricVersion", "publicMetricSha256",
    "realMetricVersion", "realMetricSha256", "catalogSha256",
    "authzSchemaVersion", "piVersion"
  ];
  const missing = required.filter((field) => !String(releaseSet[field] || "").trim());
  if (missing.length) throw new Error(`lumi-mvp-required release-set is incomplete: ${missing.join(", ")}`);
  for (const field of ["publicMetricSha256", "realMetricSha256", "catalogSha256"]) {
    if (!validSha256(releaseSet[field])) throw new Error(`lumi-mvp-required release-set has invalid ${field}`);
  }
  if (releaseSet.realMetricVersion !== "v0.1.0") {
    throw new Error("lumi-mvp-required release-set must pin realMetricVersion to v0.1.0");
  }
  if (!Number.isInteger(releaseSet.authzSchemaVersion) || releaseSet.authzSchemaVersion < 1) {
    throw new Error("lumi-mvp-required release-set has invalid authzSchemaVersion");
  }
  const expected = lumiReleaseSetDigest(releaseSet);
  if (!validSha256(releaseSet.sha256) || releaseSet.sha256 !== expected) {
    throw new Error("lumi-mvp-required release-set sha256 is missing or does not match its canonical fields");
  }
  return { key, ...releaseSet };
}

export function lumiMetricCatalogArtifact(manifest) {
  const profile = manifestProfile(manifest, lumiRequiredProfile);
  const catalog = profile.approvedMetricCatalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("lumi-mvp-required manifest is missing its approved Metric catalog artifact");
  }
  if (catalog.source !== "bootstrap/approved-metrics-v1.json" ||
      !path.isAbsolute(String(catalog.destination || "")) ||
      !validSha256(catalog.sha256)) {
    throw new Error("lumi-mvp-required approved Metric catalog artifact is invalid");
  }
  const releaseSet = lumiReleaseSet(manifest);
  if (catalog.sha256 !== releaseSet.catalogSha256) {
    throw new Error("lumi-mvp-required approved Metric catalog does not match release-set");
  }
  return { ...catalog };
}

export function lumiApprovedWikisArtifact(manifest) {
  const profile = manifestProfile(manifest, lumiRequiredProfile);
  const approved = profile.approvedWikis;
  if (!approved || typeof approved !== "object" || Array.isArray(approved)) {
    throw new Error("lumi-mvp-required manifest is missing its approved Wikis content artifact");
  }
  if (approved.source !== "bootstrap/approved-lumi-wikis" ||
      approved.manifest !== "bootstrap/approved-lumi-wikis-manifest.json" ||
      !validSha256(approved.manifestSha256)) {
    throw new Error("lumi-mvp-required approved Wikis content artifact is invalid");
  }
  return { ...approved };
}

export function validateProfileAgent(profile, agent, options = {}) {
  if (profile === lumiRequiredProfile && !lumiAuthorizedAgentChoices.includes(agent)) {
    throw new Error(`lumi-mvp-required profile requires --agent ${lumiAuthorizedAgentChoices.join(", ")}`);
  }
  if (profile === lumiRequiredProfile && !lumiAgentSupportedOnPlatform(agent, options.platform)) {
    throw new Error("selected Agent is not supported on this platform");
  }
}

export function authzConfigPathFor(manifest, profile) {
  if (profile !== lumiRequiredProfile) return "";
  const value = String(manifestProfile(manifest, profile).authzConfigPath || "");
  if (!path.isAbsolute(value)) throw new Error("lumi-mvp-required authzConfigPath must be absolute");
  return value;
}
