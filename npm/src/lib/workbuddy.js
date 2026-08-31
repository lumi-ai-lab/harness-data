import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { packageVersion } from "./package.js";

export const workBuddyMinimumVersion = "5.3.5";
export const workBuddyAuthMinimumVersion = "5.3.11";
export const codeBuddyMinimumVersion = "2.115.0";
export const workBuddyMarketplaceName = "lumi-ai-lab";
export const workBuddyMarketplaceRel = "agents";
export const workBuddyPluginRel = "agents/workbuddy";

export function agentIncludesWorkBuddy(agent) {
  // WorkBuddy remains explicit until the project-owned desktop E2E matrix has
  // passed. `both` and the existing `all` selection keep their old semantics.
  return String(agent || "").toLowerCase() === "workbuddy";
}

export function assertWorkBuddyAuthPlatform(agent, authEnabled, platform = process.platform) {
  if (authEnabled && agentIncludesWorkBuddy(agent) && !["darwin", "win32"].includes(platform)) {
    throw new Error("WorkBuddy auth currently supports macOS and Windows only; use --no-auth on this platform");
  }
}

export function inspectWorkBuddyPlugin(workspace) {
  const root = path.join(workspace, workBuddyPluginRel);
  const marketplaceRoot = path.join(workspace, workBuddyMarketplaceRel);
  const files = {
    marketplace: path.join(marketplaceRoot, ".codebuddy-plugin", "marketplace.json"),
    manifest: path.join(root, ".codebuddy-plugin", "plugin.json"),
    hooks: path.join(root, "hooks", "hooks.json"),
    adapter: path.join(root, "scripts", "harness-hook.mjs"),
    runNode: path.join(root, "bin", "run-node"),
    runNodeWindows: path.join(root, "bin", "run-node.cmd"),
    skill: path.join(root, "skills", "qdm-harness", "SKILL.md"),
    readme: path.join(root, "README.md"),
  };
  const errors = [];
  for (const [name, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) errors.push(`missing ${name}: ${path.relative(workspace, file)}`);
  }

  let marketplace = null;
  let manifest = null;
  let hooks = null;
  if (fs.existsSync(files.marketplace)) {
    try {
      marketplace = JSON.parse(fs.readFileSync(files.marketplace, "utf8"));
    } catch {
      errors.push("invalid agents/.codebuddy-plugin/marketplace.json");
    }
  }
  if (fs.existsSync(files.manifest)) {
    try {
      manifest = JSON.parse(fs.readFileSync(files.manifest, "utf8"));
    } catch {
      errors.push("invalid .codebuddy-plugin/plugin.json");
    }
  }
  if (fs.existsSync(files.hooks)) {
    try {
      hooks = JSON.parse(fs.readFileSync(files.hooks, "utf8"));
    } catch {
      errors.push("invalid hooks/hooks.json");
    }
  }

  const marketplaceEntry = marketplace?.plugins?.find((plugin) => plugin?.name === "qdm-harness");
  if (marketplace) {
    if (marketplace.name !== workBuddyMarketplaceName) errors.push(`marketplace name must be ${workBuddyMarketplaceName}`);
    if (!marketplaceEntry) errors.push("marketplace must declare qdm-harness");
    if (marketplaceEntry?.source !== "./workbuddy") errors.push("qdm-harness marketplace source must be ./workbuddy");
  }

  if (manifest) {
    if (manifest.name !== "qdm-harness") errors.push("plugin name must be qdm-harness");
    if (manifest.hooks !== "./hooks/hooks.json") errors.push("plugin hooks path must be ./hooks/hooks.json");
    if (manifest.skills !== "./skills") errors.push("plugin skills path must be ./skills");
  }

  if (hooks) {
    const preTool = hooks.hooks?.PreToolUse;
    const userPrompt = hooks.hooks?.UserPromptSubmit;
    const postTool = hooks.hooks?.PostToolUse;
    if (!Array.isArray(preTool) || preTool.length !== 1) errors.push("PreToolUse hook must be declared once");
    if (!Array.isArray(userPrompt) || userPrompt.length !== 1) errors.push("UserPromptSubmit hook must be declared once");
    if (!Array.isArray(postTool) || postTool.length !== 1) errors.push("PostToolUse hook must be declared once");
    if ((preTool?.[0]?.matcher || "") !== "Bash|PowerShell|execute_command") errors.push("PreToolUse matcher must be Bash|PowerShell|execute_command");
    if ((postTool?.[0]?.matcher || "") !== "Bash|PowerShell|execute_command") errors.push("PostToolUse matcher must be Bash|PowerShell|execute_command");
    const commands = [
      preTool?.[0]?.hooks?.[0]?.command || "",
      userPrompt?.[0]?.hooks?.[0]?.command || "",
      postTool?.[0]?.hooks?.[0]?.command || "",
    ];
    if (!commands[0].includes("harness-hook.mjs\" authz")) errors.push("PreToolUse must call adapter authz mode");
    if (!commands[1].includes("harness-hook.mjs\" context")) errors.push("UserPromptSubmit must call adapter context mode");
    if (!commands[2].includes("harness-hook.mjs\" posttool")) errors.push("PostToolUse must call adapter posttool mode");
    if (commands.some((command) => !command.includes("bin/run-node"))) errors.push("hooks must use the managed Node launcher");
  }
  if (fs.existsSync(files.runNode) && process.platform !== "win32") {
    try {
      fs.accessSync(files.runNode, fs.constants.X_OK);
    } catch {
      errors.push("bin/run-node must be executable");
    }
  }
  if (fs.existsSync(files.adapter)) {
    const adapter = fs.readFileSync(files.adapter, "utf8");
    if (!adapter.includes("authz-hook") || !adapter.includes("updatedInput")) errors.push("adapter must validate WorkBuddy authz output");
  }

  const version = manifest?.version || "";
  const marketplaceVersion = marketplaceEntry?.version || "";
  return {
    root,
    marketplaceRoot,
    marketplaceName: marketplace?.name || "",
    files,
    prepared: errors.length === 0,
    errors,
    version,
    marketplaceVersion,
    versionMatchesPackage: version === packageVersion() && marketplaceVersion === packageVersion(),
  };
}

export function detectWorkBuddyVersion(options = {}) {
  if (options.workBuddyVersion) return String(options.workBuddyVersion);

  const explicitPath = options.workBuddyAppPath || process.env.WORKBUDDY_APP_PATH;
  const appRoots = explicitPath
    ? [explicitPath]
    : process.platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy"),
          path.join(process.env.LOCALAPPDATA || "", "WorkBuddy"),
          path.join(process.env.PROGRAMFILES || "", "WorkBuddy"),
        ]
      : ["/Applications/WorkBuddy.app"];

  for (const appRoot of appRoots.filter(Boolean)) {
    const root = normalizeWorkBuddyAppRoot(appRoot);
    const productFiles = [
      path.join(root, "Contents", "Resources", "app.asar.unpacked", "cli", "product.json"),
      path.join(root, "resources", "app.asar.unpacked", "cli", "product.json"),
      path.join(root, "Resources", "app.asar.unpacked", "cli", "product.json"),
    ];
    for (const productFile of productFiles) {
      try {
        const product = JSON.parse(fs.readFileSync(productFile, "utf8"));
        if (product.genieVersion) return String(product.genieVersion).trim();
      } catch {
        // Try the next platform layout.
      }
    }

    const plist = appRoot.endsWith("Info.plist") ? appRoot : path.join(root, "Contents", "Info.plist");
    try {
      const content = fs.readFileSync(plist, "utf8");
      const version = content.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim() ||
        content.match(/CFBundleShortVersionString[^0-9]+([0-9]+(?:\.[0-9]+){1,3})/)?.[1] || "";
      if (version) return version;
    } catch {
      // Continue to the next candidate installation.
    }
  }
  return "";
}

export function detectCodeBuddyVersion(options = {}) {
  if (options.codeBuddyVersion) return String(options.codeBuddyVersion);
  const explicitPath = options.workBuddyAppPath || process.env.WORKBUDDY_APP_PATH;
  const appRoots = explicitPath
    ? [explicitPath]
    : process.platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy"),
          path.join(process.env.LOCALAPPDATA || "", "WorkBuddy"),
          path.join(process.env.PROGRAMFILES || "", "WorkBuddy"),
        ]
      : ["/Applications/WorkBuddy.app"];
  for (const appRoot of appRoots.filter(Boolean)) {
    const root = normalizeWorkBuddyAppRoot(appRoot);
    const packageFiles = [
      path.join(root, "Contents", "Resources", "app.asar.unpacked", "cli", "package.json"),
      path.join(root, "resources", "app.asar.unpacked", "cli", "package.json"),
      path.join(root, "Resources", "app.asar.unpacked", "cli", "package.json"),
    ];
    for (const packageFile of packageFiles) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
        const version = pkg.publishConfig?.customPackage?.version;
        if (version) return String(version).trim();
      } catch {
        // Try the next platform layout.
      }
    }
  }
  return "";
}

function normalizeWorkBuddyAppRoot(value) {
  let root = path.resolve(value);
  const resources = path.dirname(root);
  const contents = path.dirname(resources);
  if (path.basename(root).toLowerCase() === "app.asar" &&
      path.basename(resources).toLowerCase() === "resources" &&
      path.basename(contents).toLowerCase() === "contents") {
    return path.dirname(contents);
  }
  try {
    if (fs.statSync(root).isFile()) root = path.dirname(root);
  } catch {
    // Candidate does not exist or is inaccessible; file reads will skip it.
  }
  return root;
}

export function versionAtLeast(actual, minimum = workBuddyMinimumVersion) {
  const parseVersion = (value) => String(value || "").trim().replace(/^v(?=\d)/i, "")
    .split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parseVersion(actual);
  const b = parseVersion(minimum);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return true;
    if ((a[index] || 0) < (b[index] || 0)) return false;
  }
  return true;
}

export function detectWorkBuddyPluginEnabled(options = {}) {
  const home = options.homeDir || os.homedir();
  const workspace = options.workspace ? path.resolve(options.workspace) : "";
  const configDir = options.workBuddyConfigDir || process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR;
  const settingsPaths = options.workBuddySettingsPath
    ? [options.workBuddySettingsPath]
    : [
        configDir ? path.join(configDir, "settings.json") : path.join(home, ".workbuddy", "settings.json"),
        ...(workspace ? [
          path.join(workspace, ".codebuddy", "settings.json"),
          path.join(workspace, ".workbuddy", "settings.json"),
          path.join(workspace, ".codebuddy", "settings.local.json"),
          path.join(workspace, ".workbuddy", "settings.local.json"),
        ] : []),
      ];

  const merged = new Map();
  const sources = new Map();
  const parsedPaths = [];
  for (const settingsPath of settingsPaths) {
    if (!fs.existsSync(settingsPath)) continue;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      parsedPaths.push(settingsPath);
      for (const [name, value] of Object.entries(settings.enabledPlugins || {})) {
        merged.set(name, value);
        sources.set(name, settingsPath);
      }
    } catch {
      // Invalid settings cannot prove enablement; continue checking other scopes.
    }
  }

  const targetPluginID = `qdm-harness@${workBuddyMarketplaceName}`;
  const matching = [...merged.entries()].filter(([name]) => name === targetPluginID);
  const enabledEntry = matching.find(([, value]) => value === true);
  const settingsPath = enabledEntry
    ? sources.get(enabledEntry[0])
    : parsedPaths.at(-1) || settingsPaths[0];
  return {
    detected: parsedPaths.length > 0,
    configured: matching.length > 0,
    enabled: Boolean(enabledEntry),
    explicitlyDisabled: matching.length > 0 && !enabledEntry,
    settingsPath,
    settingsPaths: parsedPaths,
  };
}

function launchctlValue(name, options) {
  if (options.launchctlEnv && Object.prototype.hasOwnProperty.call(options.launchctlEnv, name)) {
    return { value: String(options.launchctlEnv[name] || "").trim(), source: "launchctl" };
  }
  if ((options.platform || process.platform) !== "darwin") return { value: "", source: "" };
  const result = spawnSync(options.launchctlPath || "/bin/launchctl", ["getenv", name], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
  });
  return result.status === 0
    ? { value: String(result.stdout || "").trim(), source: "launchctl" }
    : { value: "", source: "" };
}

function authEnvironmentValue(name, options) {
  const env = options.env || process.env;
  const inherited = typeof env[name] === "string" ? env[name].trim() : "";
  return inherited ? { value: inherited, source: "environment" } : launchctlValue(name, options);
}

function validateAuthBlobFile(workspace, file, options = {}) {
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(workspace, file);
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, detail: `${absolute} must be a regular file` };
    if ((options.platform || process.platform) !== "win32" && (stat.mode & 0o777) !== 0o600) {
      return { ok: false, detail: `${absolute} must use mode 0600` };
    }
    if (options.requireOutsideWorkspace) {
      const relative = path.relative(path.resolve(workspace), absolute);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return { ok: false, detail: `${absolute} must be outside the Harness workspace` };
      }
    }
    const blob = fs.readFileSync(absolute, "utf8").trim();
    if (!blob.startsWith("qdm1enc.")) return { ok: false, detail: `${absolute} must contain an encrypted qdm1enc blob` };
    return { ok: true, detail: absolute };
  } catch {
    return { ok: false, detail: `${absolute} is missing or unreadable` };
  }
}

export function inspectWorkBuddyAuth(workspace, authz, options = {}) {
  if (!authz || authz.mode !== "on") return { ok: true, detail: "authz.mode=off", source: "off" };
  if (!authz.allowLocalBlob) return { ok: false, detail: "authz.mode=on requires allow_local_blob=true", source: "" };

  const blob = authEnvironmentValue("HARNESS_AUTH_BLOB", options);
  const blobFile = authEnvironmentValue("HARNESS_AUTH_BLOB_FILE", options);
  const userID = authEnvironmentValue("HARNESS_AUTH_USER_ID", options);
  const resolvedUserID = userID.value || String(authz.devUserId || "").trim();
  if (blob.value) {
    if (!blob.value.startsWith("qdm1enc.")) return { ok: false, detail: "HARNESS_AUTH_BLOB must be an encrypted qdm1enc blob", source: blob.source };
    if (!resolvedUserID) return { ok: false, detail: "HARNESS_AUTH_USER_ID or authz.dev_user_id is required", source: blob.source };
    return { ok: true, detail: `${blob.source} encrypted blob; user id configured`, source: blob.source };
  }
  if (blobFile.value) {
    if (!resolvedUserID) return { ok: false, detail: "HARNESS_AUTH_USER_ID or authz.dev_user_id is required", source: blobFile.source };
    const checked = validateAuthBlobFile(workspace, blobFile.value, { ...options, requireOutsideWorkspace: true });
    return { ...checked, detail: checked.ok ? `${blobFile.source} file ${checked.detail}; user id configured` : checked.detail, source: blobFile.source };
  }
  if (authz.blobFile) {
    if (!String(authz.devUserId || "").trim()) return { ok: false, detail: "authz.blob_file requires authz.dev_user_id", source: "config" };
    const checked = validateAuthBlobFile(workspace, authz.blobFile, options);
    return { ...checked, detail: checked.ok ? `config file ${checked.detail}; dev user id configured` : checked.detail, source: "config" };
  }
  return { ok: false, detail: "no HARNESS_AUTH_BLOB, HARNESS_AUTH_BLOB_FILE, or authz.blob_file is configured", source: "" };
}
