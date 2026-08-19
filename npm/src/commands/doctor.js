import fs from "node:fs";
import path from "node:path";
import { findWorkspaceDir, readWorkspaceState } from "../lib/paths.js";
import { binaryName } from "../lib/platform.js";
import { concreteAgentNames, qdmCliBinaries, readAuthzFromHarnessConfig } from "../lib/config.js";
import { packageVersion } from "../lib/package.js";
import {
  codeBuddyMinimumVersion,
  detectCodeBuddyVersion,
  detectWorkBuddyPluginEnabled,
  detectWorkBuddyVersion,
  inspectWorkBuddyAuth,
  inspectWorkBuddyPlugin,
  versionAtLeast,
  workBuddyAuthMinimumVersion,
  workBuddyMinimumVersion,
  workBuddyPluginRel,
} from "../lib/workbuddy.js";

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
  const source = path.join(workspace, "agents", name);
  if (!fs.existsSync(target) || !fs.existsSync(source)) return false;
  try {
    return fs.realpathSync(target) === fs.realpathSync(source);
  } catch {
    return false;
  }
}

function configPathsValid(workspace) {
  const file = path.join(workspace, "config", "qdm-cli-paths.env");
  if (!fs.existsSync(file)) return false;
  const content = fs.readFileSync(file, "utf8");
  const required = ["QDM_METRIC_CLI"];
  const values = new Map([...content.matchAll(/^export\s+([A-Z0-9_]+)="([^"]+)"/gm)].map((match) => [match[1], match[2]]));
  return required.every((name) => values.has(name) && fs.existsSync(values.get(name)));
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
  {
    const hasPlugins = fs.existsSync(path.join(workspace, "agents", "plugins", "marketplace.json"));
    add("agents/plugins", true, hasPlugins ? undefined : "not found; html-report plugin unavailable for Codex CLI/ChatGPT App", hasPlugins ? "pass" : "warning");
  }
  add("wikis/index.md", fs.existsSync(path.join(workspace, "wikis", "index.md")));
  add("wikis/metrics", fs.existsSync(path.join(workspace, "wikis", "metrics")));
  add("wikis/reports", fs.existsSync(path.join(workspace, "wikis", "reports")));
  add("wikis/dims", fs.existsSync(path.join(workspace, "wikis", "dims")));
  add("wikis/rules", fs.existsSync(path.join(workspace, "wikis", "rules")));
  for (const binary of qdmCliBinaries) {
    add(`bin/${binary}`, existsExecutable(path.join(workspace, "bin", binaryName(binary))));
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
  add("legacy qdm-cmr-cli absent", !existsExecutable(path.join(workspace, "bin", binaryName("qdm-cmr-cli"))));
  add("legacy qdm-indicators-cli absent", !existsExecutable(path.join(workspace, "bin", binaryName("qdm-indicators-cli"))));
  add("legacy qdm-sql-cli absent", !existsExecutable(path.join(workspace, "bin", binaryName("qdm-sql-cli"))));
  add("legacy cas-cli absent", !existsExecutable(path.join(workspace, "bin", binaryName("cas-cli"))));

  const configuredAgent = selectedAgent(workspace, options);
  const workBuddySelected = configuredAgent === "workbuddy";
  if (workBuddySelected && authz?.mode === "on") {
    const platform = options.platform || process.platform;
    add("WorkBuddy auth platform", platform === "darwin", platform === "darwin" ? "macOS" : `${platform}; auth hook currently supports macOS only`);
    const auth = inspectWorkBuddyAuth(workspace, authz, { ...options, platform });
    add("WorkBuddy auth source", auth.ok, auth.detail);
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
      if (authz?.mode === "on") {
        add(
          `WorkBuddy auth version >= ${workBuddyAuthMinimumVersion}`,
          Boolean(clientVersion && versionAtLeast(clientVersion, workBuddyAuthMinimumVersion)),
          clientVersion || "client not detected",
        );
        const codeBuddyVersion = detectCodeBuddyVersion(options);
        if (codeBuddyVersion) {
          const supported = versionAtLeast(codeBuddyVersion, codeBuddyMinimumVersion);
          add(
            `CodeBuddy CLI version >= ${codeBuddyMinimumVersion}`,
            supported,
            supported ? codeBuddyVersion : `${codeBuddyVersion}; upgrade WorkBuddy before enabling authz`,
          );
        } else {
          add(`CodeBuddy CLI version >= ${codeBuddyMinimumVersion}`, false, "embedded CLI not detected");
        }
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
