import fs from "node:fs";
import path from "node:path";
import { binaryName } from "./platform.js";
import { localUnrestrictedProfile, lumiRequiredProfile, normalizeProfile } from "./profile.js";

export const agentChoices = ["claude", "codex", "pi", "openclaw", "hermes", "both", "all"];
export const concreteAgentNames = ["claude", "codex", "pi", "openclaw", "hermes"];
export const agentLinks = {
  claude: [["agents/claude", ".claude"]],
  codex: [["agents/codex", ".codex"]],
  pi: [["agents/pi", ".pi"]],
  openclaw: [["agents/openclaw", ".openclaw"]],
  hermes: [["agents/hermes", ".hermes"]],
  both: [["agents/claude", ".claude"], ["agents/codex", ".codex"]],
  all: [
    ["agents/claude", ".claude"],
    ["agents/codex", ".codex"],
    ["agents/pi", ".pi"],
    ["agents/openclaw", ".openclaw"],
    ["agents/hermes", ".hermes"],
  ],
};
export const agentChoiceText = agentChoices.join(", ");
export const qdmCliBinaries = ["data-harness-cli", "qdm-metric-cli"];
export const localPathToolNames = [];
const legacyCredentialInstruction = "- If CMR or Indicators token is invalid, use the configured `cas-cli` credential flow; do not start QR login from an automated hook.";
const legacyMetricInstruction = "- Use only commands exposed by the installed `qdm-metric-cli --help` and its subcommand help.";
const localMetricInstruction = [
  "- Run Metric commands through `bin/qdm-metric-cli`; do not invoke bare `qdm-metric-cli` or rely on PATH.",
  "- Use only commands exposed by `bin/qdm-metric-cli --help` and its subcommand help.",
  "- Do not call legacy data CLIs or run credential/token setup."
].join("\n");

export function qdmCliBinariesForProfile(profile) {
  return normalizeProfile(profile) === lumiRequiredProfile
    ? ["data-harness-cli", "qdm-indicators-cli"]
    : [...qdmCliBinaries];
}

export function localPathToolNamesForProfile(profile, options = {}) {
  if (normalizeProfile(profile) !== localUnrestrictedProfile) return [];
  return options.metricCliPath ? ["qdm-metric-cli"] : [...localPathToolNames];
}

export function hasAnyAgentHook(workspace) {
  return concreteAgentNames.some((name) => fs.existsSync(path.join(workspace, `.${name}`)));
}

function pathEntryExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function agentNamesForChoice(agent) {
  const pairs = agentLinks[agent];
  if (!pairs) throw new Error(`agent must be ${agentChoiceText}`);
  return pairs.map(([, target]) => target.replace(/^\./, ""));
}

export function writeLocalConfig(workspace, options = {}) {
  const profile = normalizeProfile(options.profile);
  const configDir = path.join(workspace, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const harness = path.join(configDir, "harness-config.yaml");
  const env = path.join(configDir, "qdm-cli-paths.env");
  if ((fs.existsSync(harness) || fs.existsSync(env)) && !options.overwrite) {
    throw new Error("local config already exists; rerun interactively and confirm overwrite or remove the files");
  }
  const bin = (name) => path.join(workspace, "bin", binaryName(name)).replaceAll("\\", "/");
  if (profile === lumiRequiredProfile) {
    fs.writeFileSync(harness, `paths:\n  knowledge: wikis\n\ncli:\n  qdm_indicators_cli: ${bin("qdm-indicators-cli")}\n`);
    fs.writeFileSync(env, `export QDM_INDICATORS_CLI="${bin("qdm-indicators-cli")}"\n`);
    return;
  }
  const metric = path.join("bin", binaryName("qdm-metric-cli")).replaceAll("\\", "/");
  fs.writeFileSync(harness, "paths:\n  knowledge: wikis\n");
  fs.writeFileSync(env, `export QDM_METRIC_CLI="${metric}"\n`);
}

export function migrateLegacyLocalAgentInstructions(workspace) {
  const agentsDir = path.join(workspace, "agents");
  if (!fs.existsSync(agentsDir)) return [];
  const changed = [];
  const pending = [agentsDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const content = fs.readFileSync(file, "utf8");
      const duplicateNoLegacy = "- Do not call legacy data CLIs or run credential/token setup.\n- Do not call legacy data CLIs or run credential/token setup.";
      if (!content.includes(legacyCredentialInstruction) &&
          !content.includes(legacyMetricInstruction) &&
          !content.includes(duplicateNoLegacy)) {
        continue;
      }
      const migrated = content
        .replaceAll(legacyCredentialInstruction, localMetricInstruction)
        .replaceAll(legacyMetricInstruction, localMetricInstruction)
        .replaceAll(
          duplicateNoLegacy,
          "- Do not call legacy data CLIs or run credential/token setup."
        );
      fs.writeFileSync(file, migrated);
      changed.push(path.relative(workspace, file).replaceAll("\\", "/"));
    }
  }
  return changed.sort();
}

export function removeUnselectedAgentLinks(workspace, agent) {
  const selected = new Set(agentNamesForChoice(agent));
  const removed = [];
  for (const name of concreteAgentNames) {
    if (selected.has(name)) continue;
    const target = path.join(workspace, `.${name}`);
    let info;
    try {
      info = fs.lstatSync(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isSymbolicLink()) continue;
    const expectedPath = path.resolve(workspace, "agents", name);
    let expected;
    try {
      expected = fs.realpathSync(expectedPath);
    } catch {
      continue;
    }
    let actual;
    try {
      actual = fs.realpathSync(target);
    } catch {
      actual = path.resolve(path.dirname(target), fs.readlinkSync(target));
    }
    if (actual !== expected) continue;
    fs.rmSync(target, { force: true });
    removed.push(`.${name}`);
  }
  return removed;
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

export function linkAgents(workspace, agent) {
  const pairs = agentLinks[agent];
  if (!pairs) throw new Error(`agent must be ${agentChoiceText}`);
  removeUnselectedAgentLinks(workspace, agent);
  for (const [sourceRel, targetRel] of pairs) {
    const source = path.join(workspace, sourceRel);
    const target = path.join(workspace, targetRel);
    if (!fs.existsSync(source)) throw new Error(`agent template missing: ${sourceRel}`);
    if (pathEntryExists(target)) fs.rmSync(target, { recursive: true, force: true });
    const linkSource = process.platform === "win32"
      ? source
      : path.relative(path.dirname(target), source);
    fs.symlinkSync(linkSource, target, "junction");
  }
  return pairs;
}
