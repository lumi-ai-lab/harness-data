import fs from "node:fs";
import path from "node:path";
import { binaryName } from "./platform.js";
import { normalizeProfile } from "./profile.js";

export const agentChoices = ["claude", "codex", "qwen", "pi", "openclaw", "hermes", "both", "all"];
export const concreteAgentNames = ["claude", "codex", "qwen", "pi", "openclaw", "hermes"];
export const agentLinks = {
  claude: [["agents/claude", ".claude"]],
  codex: [["agents/codex", ".codex"]],
  qwen: [["agents/qwen", ".qwen"]],
  pi: [["agents/pi", ".pi"]],
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
export const localPathToolNames = ["qdm-metric-cli"];

export function qdmCliBinariesForProfile(profile) {
  normalizeProfile(profile);
  return [...qdmCliBinaries];
}

export function localPathToolNamesForProfile(profile) {
  normalizeProfile(profile);
  return [...localPathToolNames];
}

export function hasAnyAgentHook(workspace) {
  return concreteAgentNames.some((name) => fs.existsSync(path.join(workspace, `.${name}`)));
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
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(source, target, "junction");
  }
  return pairs;
}
