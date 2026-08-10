import fs from "node:fs";
import path from "node:path";
import { findWorkspaceDir, readWorkspaceState } from "../lib/paths.js";
import { binaryName, isExecutable } from "../lib/platform.js";
import { concreteAgentNames, qdmCliBinaries, readAuthzFromHarnessConfig } from "../lib/config.js";
import { packageVersion } from "../lib/package.js";
import {
  detectWorkBuddyPluginEnabled,
  detectWorkBuddyVersion,
  inspectWorkBuddyPlugin,
  versionAtLeast,
  workBuddyMinimumVersion,
  workBuddyPluginRel,
} from "../lib/workbuddy.js";

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

function selectedAgent(workspace, options = {}) {
  if (options.agent) return String(options.agent).toLowerCase();
  const state = readWorkspaceState(workspace, { userState: options.userState });
  return String(state.agent || "").toLowerCase();
}

export async function collectDoctor(workspace, options = {}) {
  const checks = [];
  const add = (name, ok, detail = "", status = ok ? "pass" : "fail") => checks.push({ name, ok, detail, status });

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
  const authz = readAuthzFromHarnessConfig(path.join(workspace, "config", "harness-config.yaml"));
  if (authz && authz.mode === "on" && !authz.allowLocalBlob) {
    add("authz allow_local_blob", false, "mode:on requires allow_local_blob:true (Host/Lumi fallback removed)");
  } else {
    add("authz allow_local_blob", true);
  }
  add("config/qdm-cli-paths.env", fs.existsSync(path.join(workspace, "config", "qdm-cli-paths.env")));
  add("config CLI paths", configPathsValid(workspace));
  add("legacy qdm-cmr-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-cmr-cli"))));
  add("legacy qdm-indicators-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-indicators-cli"))));
  add("legacy qdm-sql-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("qdm-sql-cli"))));
  add("legacy cas-cli absent", !isExecutable(path.join(workspace, "bin", binaryName("cas-cli"))));

  const configuredAgent = selectedAgent(workspace, options);
  const workBuddySelected = configuredAgent === "workbuddy";
  if (workBuddySelected) {
    add("WorkBuddy authz.mode=off", authz?.mode !== "on", authz?.mode === "on" ? "data-auth is not supported" : "off");
  }
  let workBuddy = null;
  if (fs.existsSync(path.join(workspace, workBuddyPluginRel))) {
    workBuddy = inspectWorkBuddyPlugin(workspace);
    add("WorkBuddy plugin package", workBuddy.prepared, workBuddy.prepared ? `${workBuddyPluginRel} v${workBuddy.version}; marketplace=${workBuddy.marketplaceName}` : workBuddy.errors.join("; "));
    add(
      "WorkBuddy plugin version",
      workBuddy.versionMatchesPackage || !workBuddySelected,
      workBuddy.versionMatchesPackage
        ? workBuddy.version
        : `${workBuddy.version || "missing"}; installer=${packageVersion()} (update runtime before selecting WorkBuddy)`,
    );
    if (workBuddySelected) {
      const clientVersion = detectWorkBuddyVersion(options);
      if (clientVersion) {
        const supported = versionAtLeast(clientVersion);
        add(
          `WorkBuddy version >= ${workBuddyMinimumVersion}`,
          supported,
          supported ? clientVersion : `${clientVersion}; upgrade required before selecting WorkBuddy`,
        );
      } else {
        add(`WorkBuddy version >= ${workBuddyMinimumVersion}`, true, "client not detected; verify manually", "warning");
      }
      const enablement = detectWorkBuddyPluginEnabled({ ...options, workspace });
      if (enablement.enabled) {
        add("WorkBuddy plugin enablement", true, `enabled in ${enablement.settingsPath}`);
      } else if (enablement.explicitlyDisabled) {
        add("WorkBuddy plugin enablement", false, `explicitly disabled in ${enablement.settingsPath}; enable qdm-harness and reload plugins`);
      } else {
        add(
          "WorkBuddy plugin enablement",
          true,
          `not detected; install and enable qdm-harness in WorkBuddy, then reload plugins (${enablement.settingsPath})`,
          "warning",
        );
      }
    }
  }

  add("Agent hook", concreteAgentNames.some((name) => agentOk(workspace, name)) || (workBuddySelected && Boolean(workBuddy?.prepared)));
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
      const label = check.status === "warning" ? "WARN" : (check.ok ? "PASS" : "FAIL");
      console.log(`${label} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
    }
  }
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
  return report;
}
