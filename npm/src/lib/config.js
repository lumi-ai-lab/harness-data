import fs from "node:fs";
import path from "node:path";
import { binaryName } from "./platform.js";

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
  fs.writeFileSync(harness, `paths:\n  spec: wikis/spec\n  playbooks: wikis/playbooks\n  templates: wikis/templates\n\ncli:\n  qdm_cmr_cli: ${bin("qdm-cmr-cli")}\n  qdm_indicators_cli: ${bin("qdm-indicators-cli")}\n  qdm_cas_cli: ${bin("cas-cli")}\n`);
  fs.writeFileSync(env, `export QDM_CMR_CLI="${bin("qdm-cmr-cli")}"\nexport QDM_INDICATORS_CLI="${bin("qdm-indicators-cli")}"\nexport QDM_CAS_CLI="${bin("cas-cli")}"\nexport QDM_CAS_CONFIG_DIR="${casConfigDir}"\n`);
}

export function validateCasConfigDir(dir) {
  const file = path.join(dir, "config.json");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`CAS config is missing or invalid: ${file}`);
  }
  if (!config?.cas?.username || !config?.cas?.password) {
    throw new Error(`CAS config must contain non-empty cas.username and cas.password: ${file}`);
  }
}

export function linkAgents(workspace, agent) {
  const pairs = [];
  if (agent === "claude" || agent === "all") pairs.push(["agents/claude", ".claude"]);
  if (agent === "codex" || agent === "all") pairs.push(["agents/codex", ".codex"]);
  if (agent === "pi" || agent === "all") pairs.push(["agents/pi", ".pi"]);
  for (const [sourceRel, targetRel] of pairs) {
    const source = path.join(workspace, sourceRel);
    const target = path.join(workspace, targetRel);
    if (!fs.existsSync(source)) throw new Error(`agent template missing: ${sourceRel}`);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(source, target, "junction");
  }
}
