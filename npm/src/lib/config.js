import fs from "node:fs";
import path from "node:path";
import { binaryName } from "./platform.js";

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

export function hasAnyAgentHook(workspace) {
  return concreteAgentNames.some((name) => fs.existsSync(path.join(workspace, `.${name}`)));
}

export function writeLocalConfig(workspace, options = {}) {
  const configDir = path.join(workspace, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const harness = path.join(configDir, "harness-config.yaml");
  const env = path.join(configDir, "qdm-cli-paths.env");
  if ((fs.existsSync(harness) || fs.existsSync(env)) && !options.overwrite) {
    throw new Error("local config already exists; rerun interactively and confirm overwrite or remove the files");
  }
  const bin = (name) => path.join(workspace, "bin", binaryName(name)).replaceAll("\\", "/");
  const casConfigDir = path.join(workspace, ".qdm-auth", "cas").replaceAll("\\", "/");
  fs.writeFileSync(harness, `paths:\n  knowledge: wikis\n\ncli:\n  qdm_cmr_cli: ${bin("qdm-cmr-cli")}\n  qdm_indicators_cli: ${bin("qdm-indicators-cli")}\n  qdm_cas_cli: ${bin("cas-cli")}\n`);
  fs.writeFileSync(env, `export QDM_CMR_CLI="${bin("qdm-cmr-cli")}"\nexport QDM_INDICATORS_CLI="${bin("qdm-indicators-cli")}"\nexport QDM_CAS_CLI="${bin("cas-cli")}"\nexport QDM_CAS_CONFIG_DIR="${casConfigDir}"\n`);
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
  for (const [sourceRel, targetRel] of pairs) {
    const source = path.join(workspace, sourceRel);
    const target = path.join(workspace, targetRel);
    if (!fs.existsSync(source)) throw new Error(`agent template missing: ${sourceRel}`);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(source, target, "junction");
  }
  return pairs;
}
