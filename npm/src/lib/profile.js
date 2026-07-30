export const installerStateSchemaVersion = 3;
export const localUnrestrictedProfile = "local-unrestricted";
export const lumiRequiredProfile = "lumi-mvp-required";
export const installProfiles = [localUnrestrictedProfile, lumiRequiredProfile];
export const lumiAuthorizedAgents = ["pi", "claude", "codex", "qwen"];

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

function commonV3StateIsValid(state) {
  return nonEmptyText(state.agent) &&
    ["github-token", "local-path"].includes(state.installMode) &&
    typeof state.runtimeTag === "string" &&
    plainRecord(state.localTools) &&
    plainRecord(state.tools) &&
    validSha256(state.manifestSha256) &&
    nonEmptyText(state.packageVersion) &&
    state.releaseSet === undefined &&
    state.authzConfigPath === undefined;
}

function legacyLocalStateIsUnambiguous(state, schemaVersion) {
  if (state.profile !== undefined) return false;
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
    if (profile === lumiRequiredProfile && !lumiAuthorizedAgents.includes(state.agent)) return "";
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
  if (profile === lumiRequiredProfile && !lumiAuthorizedAgents.includes(agent)) {
    throw new Error(`lumi-mvp-required profile requires --agent ${lumiAuthorizedAgents.join(", ")}`);
  }
  if (profile === lumiRequiredProfile && !lumiAgentSupportedOnPlatform(agent, options.platform)) {
    throw new Error("selected Agent is not supported on this platform");
  }
}
