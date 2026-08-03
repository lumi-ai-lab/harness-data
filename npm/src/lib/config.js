import fs from "node:fs";
import path from "node:path";
import { binaryName } from "./platform.js";
import { localUnrestrictedProfile, lumiRequiredProfile, normalizeProfile } from "./profile.js";

export const agentChoices = ["claude", "codex", "pi", "openclaw", "hermes", "both", "all"];
export const concreteAgentNames = ["claude", "codex", "pi", "openclaw", "hermes"];
const generatedAgentRoot = ".harness/generated/agents";
const agentNamesByChoice = {
  claude: ["claude"],
  codex: ["codex"],
  pi: ["pi"],
  openclaw: ["openclaw"],
  hermes: ["hermes"],
  both: ["claude", "codex"],
  all: [...concreteAgentNames],
};
export const agentLinks = Object.fromEntries(
  Object.entries(agentNamesByChoice).map(([choice, names]) => [
    choice,
    names.map((name) => [`${generatedAgentRoot}/${name}`, `.${name}`]),
  ]),
);
export const agentChoiceText = agentChoices.join(", ");
export const qdmCliBinaries = ["data-harness-cli", "qdm-cmr-cli", "qdm-indicators-cli", "qdm-sql-cli", "cas-cli"];
export const localPathToolNames = ["cas-cli", "qdm-indicators-cli", "qdm-cmr-cli", "qdm-sql-cli"];

export function qdmCliBinariesForProfile(profile) {
  return normalizeProfile(profile) === lumiRequiredProfile
    ? ["data-harness-cli", "qdm-indicators-cli"]
    : [...qdmCliBinaries];
}

export function localPathToolNamesForProfile(profile) {
  return normalizeProfile(profile) === localUnrestrictedProfile ? [...localPathToolNames] : [];
}

export function hasAnyAgentHook(workspace) {
  return concreteAgentNames.some((name) => fs.existsSync(path.join(workspace, `.${name}`)));
}

function pathExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export function expandAgentSelection(selection) {
  const values = Array.isArray(selection) ? selection : [selection];
  const names = [];
  for (const value of values) {
    const normalized = String(value || "").trim().toLowerCase();
    const expanded = agentNamesByChoice[normalized];
    if (!expanded) throw new Error(`agent must be ${agentChoiceText}`);
    for (const name of expanded) if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) throw new Error(`agent must be ${agentChoiceText}`);
  return names;
}

export function configuredAgentNames(workspace) {
  return concreteAgentNames.filter((name) => {
    const target = path.join(workspace, `.${name}`);
    if (!pathExists(target)) return false;
    const managedSources = [
      path.join(workspace, generatedAgentRoot, name),
      path.join(workspace, "agents", name),
    ];
    try {
      const targetRealPath = fs.realpathSync(target);
      if (managedSources.some((source) => pathExists(source) && fs.realpathSync(source) === targetRealPath)) return true;
    } catch {}
    try {
      if (!fs.lstatSync(target).isSymbolicLink()) return false;
      const linked = path.resolve(path.dirname(target), fs.readlinkSync(target));
      return managedSources.some((source) => path.resolve(source) === linked);
    } catch {
      return false;
    }
  });
}

export function resolveHarnessExecutable(workspace, options = {}) {
  const platform = options.platform || process.platform;
  const executable = path.resolve(workspace, "bin", binaryName("data-harness-cli", platform));
  if (!fs.existsSync(executable)) throw new Error(`data-harness-cli executable missing: ${executable}`);
  return {
    executable,
    binary: path.basename(executable),
    platform,
  };
}

function quotePosixArgument(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function quoteWindowsArgument(value, force = false) {
  const input = String(value);
  if (!force && input && !/[\s"]/u.test(input)) return input;
  let output = '"';
  let backslashes = 0;
  for (const character of input) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      output += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    output += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return output + "\\".repeat(backslashes * 2) + '"';
}

export function serializeHookCommand(executable, args, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return [quoteWindowsArgument(executable, true), ...args.map((arg) => quoteWindowsArgument(arg))].join(" ");
  }
  return [executable, ...args].map(quotePosixArgument).join(" ");
}

function writeDeterministicJSON(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceHookCommands(document, eventName, command, platform, windowsOverride) {
  for (const group of document.hooks?.[eventName] || []) {
    for (const handler of group.hooks || []) {
      if (handler.type !== "command") continue;
      handler.command = command;
      if (platform === "win32" && windowsOverride) handler.commandWindows = command;
      else delete handler.commandWindows;
    }
  }
}

function renderDeclarativeHooks(stage, agent, executable, platform) {
  const contextCommand = serializeHookCommand(
    executable,
    ["context", "--format", agent === "codex" ? "codex-hook" : "claude-hook"],
    { platform },
  );
  const posttoolCommand = serializeHookCommand(
    executable,
    ["posttool", "--format", agent === "codex" ? "codex-hook" : "claude-hook"],
    { platform },
  );
  const file = path.join(stage, agent === "codex" ? "hooks.json" : "settings.json");
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  replaceHookCommands(document, "UserPromptSubmit", contextCommand, platform, agent === "codex");
  replaceHookCommands(document, "PostToolUse", posttoolCommand, platform, agent === "codex");
  if (agent === "codex") {
    for (const group of document.hooks?.PostToolUse || []) group.matcher = "^(Bash|shell|shell_command|functions\\.shell_command|powershell|PowerShell)$";
  }
  writeDeterministicJSON(file, document);
}

function copyTemplateTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const targetEntry = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTemplateTree(sourceEntry, targetEntry);
      continue;
    }
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourceEntry), targetEntry);
      continue;
    }
    if (!entry.isFile()) throw new Error(`unsupported agent template entry: ${sourceEntry}`);
    fs.copyFileSync(sourceEntry, targetEntry);
    if (process.platform !== "win32") fs.chmodSync(targetEntry, fs.statSync(sourceEntry).mode & 0o777);
  }
}

function treeSignature(root) {
  if (!fs.existsSync(root)) return "";
  const entries = [];
  const walk = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push([rel, "dir"]);
        walk(full, rel);
      } else if (entry.isSymbolicLink()) {
        entries.push([rel, "link", fs.readlinkSync(full)]);
      } else {
        const stat = fs.statSync(full);
        entries.push([rel, "file", stat.mode & 0o777, fs.readFileSync(full).toString("base64")]);
      }
    }
  };
  walk(root);
  return JSON.stringify(entries);
}

function replaceGeneratedDirectory(target, stage) {
  if (treeSignature(target) === treeSignature(stage)) {
    fs.rmSync(stage, { recursive: true, force: true });
    return false;
  }
  const backup = `${target}.backup-${process.pid}-${Date.now()}`;
  try {
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(stage, target);
    fs.rmSync(backup, { recursive: true, force: true });
    return true;
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function ensureAgentLink(workspace, name) {
  const source = path.join(workspace, generatedAgentRoot, name);
  const target = path.join(workspace, `.${name}`);
  if (pathExists(target)) {
    try {
      if (fs.realpathSync(target) === fs.realpathSync(source)) return false;
    } catch {}
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.symlinkSync(source, target, "junction");
  return true;
}

export function reconcileAgentIntegrations(workspace, selection, options = {}) {
  const agents = expandAgentSelection(selection);
  const { executable, platform } = resolveHarnessExecutable(workspace, options);
  const generatedRoot = path.join(workspace, generatedAgentRoot);
  fs.mkdirSync(generatedRoot, { recursive: true });
  const changes = [];
  let codexTrustReviewRequired = false;

  for (const name of agents) {
    const template = path.join(workspace, "agents", name);
    if (!fs.existsSync(template)) throw new Error(`agent template missing: agents/${name}`);
    const stage = fs.mkdtempSync(path.join(generatedRoot, `.render-${name}-`));
    copyTemplateTree(template, stage);
    if (name === "claude" || name === "codex") {
      renderDeclarativeHooks(stage, name, executable, platform);
    }
    if (name === "hermes" && platform === "win32") {
      fs.rmSync(path.join(stage, "agent-hooks"), { recursive: true, force: true });
    }

    const target = path.join(generatedRoot, name);
    const previousCodexHooks = name === "codex" && fs.existsSync(path.join(target, "hooks.json"))
      ? fs.readFileSync(path.join(target, "hooks.json"), "utf8")
      : "";
    const nextCodexHooks = name === "codex" ? fs.readFileSync(path.join(stage, "hooks.json"), "utf8") : "";
    const configChanged = replaceGeneratedDirectory(target, stage);
    const linkChanged = ensureAgentLink(workspace, name);
    if (name === "codex" && previousCodexHooks !== nextCodexHooks) codexTrustReviewRequired = true;
    changes.push({ agent: name, configChanged, linkChanged });
  }

  return {
    agents,
    linkedAgents: agents.map((name) => [`${generatedAgentRoot}/${name}`, `.${name}`]),
    changes,
    changed: changes.some((change) => change.configChanged || change.linkChanged),
    codexTrustReviewRequired,
  };
}

export function writeLocalConfig(workspace, options = {}) {
  const profile = normalizeProfile(options.profile);
  const platform = options.platform || process.platform;
  const configDir = path.join(workspace, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const harness = path.join(configDir, "harness-config.yaml");
  const env = path.join(configDir, "qdm-cli-paths.env");
  const powershell = path.join(configDir, "qdm-cli-paths.ps1");
  if ((fs.existsSync(harness) || fs.existsSync(env) || fs.existsSync(powershell)) && !options.overwrite) {
    throw new Error("local config already exists; rerun interactively and confirm overwrite or remove the files");
  }
  const nativeBin = (name) => path.join(workspace, "bin", binaryName(name, platform));
  const bin = (name) => nativeBin(name).replaceAll("\\", "/");
  const nativeCasConfigDir = path.join(workspace, ".qdm-auth", "cas");
  const writeEnvironmentFiles = (variables) => {
    fs.writeFileSync(
      env,
      `${Object.entries(variables).map(([name, value]) => `export ${name}="${String(value).replaceAll('"', '\\"')}"`).join("\n")}\n`,
    );
    fs.writeFileSync(
      powershell,
      `\uFEFF${Object.entries(variables).map(([name, value]) => `$env:${name} = '${String(value).replaceAll("'", "''")}'`).join("\n")}\n`,
    );
  };
  if (profile === lumiRequiredProfile) {
    fs.writeFileSync(harness, `paths:\n  knowledge: wikis\n\ncli:\n  qdm_indicators_cli: ${bin("qdm-indicators-cli")}\n`);
    writeEnvironmentFiles({ QDM_INDICATORS_CLI: nativeBin("qdm-indicators-cli") });
    return;
  }
  fs.writeFileSync(harness, `paths:\n  knowledge: wikis\n\ncli:\n  qdm_cmr_cli: ${bin("qdm-cmr-cli")}\n  qdm_indicators_cli: ${bin("qdm-indicators-cli")}\n  qdm_sql_cli: ${bin("qdm-sql-cli")}\n  qdm_cas_cli: ${bin("cas-cli")}\n`);
  writeEnvironmentFiles({
    QDM_CMR_CLI: nativeBin("qdm-cmr-cli"),
    QDM_INDICATORS_CLI: nativeBin("qdm-indicators-cli"),
    QDM_SQL_CLI: nativeBin("qdm-sql-cli"),
    QDM_CAS_CLI: nativeBin("cas-cli"),
    QDM_CAS_CONFIG_DIR: nativeCasConfigDir,
  });
}

export function validateCasConfigDir(dir) {
  const encrypted = path.join(dir, "credentials.enc");
  try {
    if (fs.statSync(encrypted).size > 0) return;
  } catch {}

  const legacy = path.join(dir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(legacy, "utf8"));
    if (config?.cas?.username && config?.cas?.password) return;
  } catch {}
  throw new Error(`CAS credentials are missing or invalid in: ${dir}`);
}

export function linkAgents(workspace, agent, options = {}) {
  return reconcileAgentIntegrations(workspace, agent, options).linkedAgents;
}
