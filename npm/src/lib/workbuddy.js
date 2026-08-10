import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageVersion } from "./package.js";

export const workBuddyMinimumVersion = "5.3.5";
export const workBuddyMarketplaceName = "lumi-harness-data";
export const workBuddyMarketplaceRel = "agents";
export const workBuddyPluginRel = "agents/workbuddy";

export function agentIncludesWorkBuddy(agent) {
  // WorkBuddy remains explicit until the project-owned desktop E2E matrix has
  // passed. `both` and the existing `all` selection keep their old semantics.
  return String(agent || "").toLowerCase() === "workbuddy";
}

export function assertWorkBuddyAuthCompatibility(agent, dataAuth) {
  if (dataAuth && agentIncludesWorkBuddy(agent)) {
    throw new Error("WorkBuddy integration does not support --data-auth yet; install with authz.mode=off");
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
    const userPrompt = hooks.hooks?.UserPromptSubmit;
    const postTool = hooks.hooks?.PostToolUse;
    if (!Array.isArray(userPrompt) || userPrompt.length !== 1) errors.push("UserPromptSubmit hook must be declared once");
    if (!Array.isArray(postTool) || postTool.length !== 1) errors.push("PostToolUse hook must be declared once");
    const matcher = postTool?.[0]?.matcher || "";
    if (matcher !== "Bash|PowerShell|execute_command") errors.push("PostToolUse matcher must be Bash|PowerShell|execute_command");
    const commands = [
      userPrompt?.[0]?.hooks?.[0]?.command || "",
      postTool?.[0]?.hooks?.[0]?.command || "",
    ];
    if (!commands[0].includes("harness-hook.mjs\" context")) errors.push("UserPromptSubmit must call adapter context mode");
    if (!commands[1].includes("harness-hook.mjs\" posttool")) errors.push("PostToolUse must call adapter posttool mode");
    if (commands.some((command) => !command.includes("bin/run-node"))) errors.push("hooks must use the managed Node launcher");
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
    let root = appRoot;
    try {
      if (fs.statSync(appRoot).isFile()) root = path.dirname(appRoot);
    } catch {
      // Candidate does not exist or is inaccessible; file reads below will skip it.
    }
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

export function versionAtLeast(actual, minimum = workBuddyMinimumVersion) {
  const parseVersion = (value) => String(value || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
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
