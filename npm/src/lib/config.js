import fs from "node:fs";
import path from "node:path";
import { binaryName } from "./platform.js";
import { normalizeProfile } from "./profile.js";

export const agentChoices = ["claude", "codex", "qwen", "pi", "lumi", "openclaw", "hermes", "both", "all"];
export const concreteAgentNames = ["claude", "codex", "qwen", "pi", "openclaw", "hermes"];
export const agentLinks = {
  claude: [["agents/claude", ".claude"]],
  codex: [["agents/codex", ".codex"]],
  qwen: [["agents/qwen", ".qwen"]],
  pi: [["agents/pi", ".pi"]],
  lumi: [
    ["agents/pi", ".pi"],
    ["agents/claude", ".claude"],
    ["agents/codex", ".codex"],
  ],
  openclaw: [["agents/openclaw", ".openclaw"]],
  hermes: [["agents/hermes", ".hermes"]],
  both: [["agents/claude", ".claude"], ["agents/codex", ".codex"]],
  all: [
    ["agents/claude", ".claude"],
    ["agents/codex", ".codex"],
    ["agents/qwen", ".qwen"],
    ["agents/pi", ".pi"],
    ["agents/openclaw", ".openclaw"],
    ["agents/hermes", ".hermes"],
  ],
};
export const agentChoiceText = agentChoices.join(", ");
export const qdmCliBinaries = ["data-harness-cli", "qdm-metric-cli"];
export const localPathToolNames = [];

export function qdmCliBinariesForProfile(profile) {
  normalizeProfile(profile);
  return [...qdmCliBinaries];
}

export function localPathToolNamesForProfile(profile, options = {}) {
  normalizeProfile(profile);
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
  const bin = (name) => {
    const relative = path.join("bin", binaryName(name)).replaceAll("\\", "/");
    if (profile === "local-unrestricted") return relative;
    return path.join(workspace, relative).replaceAll("\\", "/");
  };
  fs.writeFileSync(harness, `paths:\n  knowledge: wikis\n\ncli:\n  qdm_metric_cli: ${bin("qdm-metric-cli")}\n`);
  fs.writeFileSync(env, `export QDM_METRIC_CLI="${bin("qdm-metric-cli")}"\n`);
}

export function linkAgents(workspace, agent) {
  const pairs = agentLinks[agent];
  if (!pairs) throw new Error(`agent must be ${agentChoiceText}`);
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
