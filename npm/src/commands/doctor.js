import fs from "node:fs";
import path from "node:path";
import { findWorkspaceDir } from "../lib/paths.js";
import { binaryName, isExecutable } from "../lib/platform.js";
import { concreteAgentNames, qdmCliBinaries } from "../lib/config.js";

function agentOk(workspace, name) {
  const target = path.join(workspace, `.${name}`);
  const source = path.join(workspace, "agents", name);
  if (!fs.existsSync(target) || !fs.existsSync(source)) return false;
  try {
    return fs.realpathSync(target) === fs.realpathSync(source);
  } catch {
    return false;
  }
}

function configPathsValid(workspace) {
  const configDir = path.join(workspace, "config");

  // .env (POSIX export — all platforms)
  const envFile = path.join(configDir, "qdm-cli-paths.env");
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf8");
    const values = new Map([...content.matchAll(/^export\s+([A-Z0-9_]+)="([^"]+)"/gm)].map((m) => [m[1], m[2]]));
    if (values.has("QDM_METRIC_CLI") && fs.existsSync(values.get("QDM_METRIC_CLI"))) return true;
  }

  return false;
}

export async function collectDoctor(workspace, options = {}) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("runtime", fs.existsSync(path.join(workspace, "bootstrap", "cli-manifest.json")) && fs.existsSync(path.join(workspace, "agents")), workspace);
  add("wikis/index.md", fs.existsSync(path.join(workspace, "wikis", "index.md")));
  add("wikis/metrics", fs.existsSync(path.join(workspace, "wikis", "metrics")));
  add("wikis/reports", fs.existsSync(path.join(workspace, "wikis", "reports")));
  add("wikis/dims", fs.existsSync(path.join(workspace, "wikis", "dims")));
  add("wikis/rules", fs.existsSync(path.join(workspace, "wikis", "rules")));
  for (const binary of qdmCliBinaries) {
    add(`bin/${binary}`, isExecutable(path.join(workspace, "bin", binaryName(binary))));
  }
  add("config/harness-config.yaml", fs.existsSync(path.join(workspace, "config", "harness-config.yaml")));
  add("config/qdm-cli-paths.env", fs.existsSync(path.join(workspace, "config", "qdm-cli-paths.env")));
  add("config CLI paths", configPathsValid(workspace));
  add("legacy qdm-cmr-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-cmr-cli"))));
  add("legacy qdm-indicators-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-indicators-cli"))));
  add("legacy qdm-sql-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-sql-cli"))));
  add("legacy cas-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("cas-cli"))));
  add("Agent hook", concreteAgentNames.some((name) => agentOk(workspace, name)));
  for (const name of ["openclaw", "hermes"]) {
    if (fs.existsSync(path.join(workspace, `.${name}`))) {
      add(`Agent hook .${name}`, agentOk(workspace, name), `agents/${name}`);
    }
  }
  if (!fs.existsSync(path.join(workspace, ".harness", "index", "wikis-index.json")) &&
      !fs.existsSync(path.join(workspace, ".harness", "index", "wikis-runtime-index.json"))) {
    checks.push({ name: "wikis index", ok: true, detail: "missing; run data-harness-cli wikis build-index --skip-checks" });
  }

  return {
    workspace,
    checks
  };
}

export async function doctorCommand(options = {}) {
  const workspace = findWorkspaceDir(options.dir);
  const report = await collectDoctor(workspace, options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Harness Data runtime doctor: ${report.workspace}`);
    for (const check of report.checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    }
  }
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
  return report;
}
