import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { findWorkspaceDir } from "../lib/paths.js";
import { currentCommit, submoduleCommit } from "../lib/git.js";
import { validateCasConfigDir } from "../lib/config.js";

function existsExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function agentOk(workspace, name) {
  const target = path.join(workspace, `.${name}`);
  const source = path.join(workspace, ".agents", name);
  if (!fs.existsSync(target) || !fs.existsSync(source)) return false;
  try {
    return fs.realpathSync(target) === fs.realpathSync(source);
  } catch {
    return false;
  }
}

async function tokenCheck(workspace, binary, env) {
  const file = path.join(workspace, "bin", binary);
  if (!existsExecutable(file)) return false;
  const result = await run(file, ["config", "check-token"], { cwd: workspace, env, allowFailure: true });
  return result.code === 0;
}

function configPathsValid(workspace) {
  const file = path.join(workspace, "config", "qdm-cli-paths.env");
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, "utf8");
  const matches = [...content.matchAll(/="([^"]+)"/g)].map((match) => match[1]);
  return matches.length >= 3 && matches.every((entry) => fs.existsSync(entry));
}

function casCredentialsValid(dir) {
  try {
    validateCasConfigDir(dir);
    return true;
  } catch {
    return false;
  }
}

export async function collectDoctor(workspace, options = {}) {
  const casConfigDir = options.casConfigDir || path.join(workspace, ".qdm-auth", "cas");
  const env = { QDM_CAS_CONFIG_DIR: casConfigDir };
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("workspace", fs.existsSync(path.join(workspace, "bootstrap", "cli-manifest.json")), workspace);
  add("wikis submodule", fs.existsSync(path.join(workspace, "wikis", ".git")) || fs.existsSync(path.join(workspace, ".git", "modules", "wikis")));
  for (const binary of ["data-harness-cli", "qdm-cmr-cli", "qdm-indicators-cli", "cas-cli"]) {
    add(`bin/${binary}`, existsExecutable(path.join(workspace, "bin", binary)));
  }
  add("config/harness-config.yaml", fs.existsSync(path.join(workspace, "config", "harness-config.yaml")));
  add("config/qdm-cli-paths.env", fs.existsSync(path.join(workspace, "config", "qdm-cli-paths.env")));
  add("config CLI paths", configPathsValid(workspace));
  add("CAS credentials", casCredentialsValid(casConfigDir), casConfigDir);
  add("CMR token", await tokenCheck(workspace, "qdm-cmr-cli", env));
  add("Indicators token", await tokenCheck(workspace, "qdm-indicators-cli", env));
  add("wikis index", fs.existsSync(path.join(workspace, ".harness", "index", "wikis-index.json")) || fs.existsSync(path.join(workspace, ".harness", "index", "wikis-runtime-index.json")));
  add("Agent hook", agentOk(workspace, "claude") || agentOk(workspace, "codex") || agentOk(workspace, "pi"));

  return {
    workspace,
    mainCommit: await currentCommit(workspace),
    wikisCommit: await submoduleCommit(workspace),
    checks
  };
}

export async function doctorCommand(options = {}) {
  const workspace = findWorkspaceDir(options.dir);
  const report = await collectDoctor(workspace, options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Harness Data doctor: ${report.workspace}`);
    for (const check of report.checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    }
  }
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
  return report;
}
