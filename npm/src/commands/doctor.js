import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findWorkspaceDir, readInstallerState } from "../lib/paths.js";
import { binaryName } from "../lib/platform.js";
import { agentNamesForChoice, concreteAgentNames, qdmCliBinariesForProfile } from "../lib/config.js";
import {
  installerStateSchemaVersion,
  localUnrestrictedProfile,
  lumiApprovedWikisArtifact,
  lumiRequiredProfile,
  profileFromState
} from "../lib/profile.js";
import { readManifest } from "../lib/manifest.js";
import { verifyApprovedWikisSource } from "../lib/approved-wikis.js";

const removedBinaries = ["qdm-cmr-cli", "qdm-sql-cli", "cas-cli"];
const removedEnvironmentVariables = [
  "QDM_CMR_CLI",
  "QDM_SQL_CLI",
  "QDM_CAS_CLI",
  "QDM_CAS_CONFIG_DIR"
];
const removedYamlKeys = [
  "qdm_cmr_cli",
  "qdm_sql_cli",
  "qdm_cas_cli"
];

function existsExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableLaunches(file, args) {
  if (!existsExecutable(file)) return false;
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 10_000,
  });
  return !result.error && !result.signal && Number.isInteger(result.status);
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

function yamlCliPath(content, name) {
  const match = content.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m"));
  return String(match?.[1] || "").replace(/^["']|["']$/g, "");
}

function configPathsValid(workspace, profile) {
  const envFile = path.join(workspace, "config", "qdm-cli-paths.env");
  const harnessFile = path.join(workspace, "config", "harness-config.yaml");
  if (!fs.existsSync(envFile) || !fs.existsSync(harnessFile)) return false;

  const envContent = fs.readFileSync(envFile, "utf8");
  const harnessContent = fs.readFileSync(harnessFile, "utf8");
  const values = new Map(
    [...envContent.matchAll(/^export\s+([A-Z0-9_]+)="([^"]+)"/gm)]
      .map((match) => [match[1], match[2]])
  );
  const expected = profile === lumiRequiredProfile
    ? path.resolve(workspace, "bin", binaryName("qdm-metric-cli"))
    : path.join("bin", binaryName("qdm-metric-cli")).replaceAll("\\", "/");
  return values.size === 1 &&
    values.get("QDM_METRIC_CLI") === expected &&
    yamlCliPath(harnessContent, "qdm_metric_cli") === expected &&
    existsExecutable(path.join(workspace, "bin", binaryName("qdm-metric-cli"))) &&
    removedEnvironmentVariables.every((name) => !values.has(name)) &&
    removedYamlKeys.every((name) => !yamlCliPath(harnessContent, name));
}

function nonEmptyRegularFile(file) {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch {
    return false;
  }
}

function approvedWikisValid(workspace) {
  try {
    const manifest = readManifest(path.join(workspace, "bootstrap", "cli-manifest.json"));
    const approved = lumiApprovedWikisArtifact(manifest);
    const manifestPath = path.resolve(workspace, approved.manifest);
    const expectedManifest = path.join(path.resolve(workspace), "bootstrap", "approved-lumi-wikis-manifest.json");
    if (manifestPath !== expectedManifest) return false;
    verifyApprovedWikisSource(path.join(workspace, "wikis"), manifestPath, approved.manifestSha256);
    return true;
  } catch {
    return false;
  }
}

export async function collectDoctor(workspace, options = {}) {
  const state = readInstallerState(workspace);
  let profile = "";
  let profileError = "";
  try {
    profile = profileFromState(state);
  } catch (error) {
    profileError = String(error?.message || error);
  }
  const effectiveProfile = profile || localUnrestrictedProfile;
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("installer profile", Boolean(profile) && !profileError, profileError || profile || "missing");
  add("installer state v3", state.schemaVersion === installerStateSchemaVersion);
  add("runtime", fs.existsSync(path.join(workspace, "bootstrap", "cli-manifest.json")) && fs.existsSync(path.join(workspace, "agents")), workspace);
  add("wikis/index.md", fs.existsSync(path.join(workspace, "wikis", "index.md")));
  add("wikis/metrics", fs.existsSync(path.join(workspace, "wikis", "metrics")));
  add("wikis/reports", fs.existsSync(path.join(workspace, "wikis", "reports")));
  add("wikis/dims", fs.existsSync(path.join(workspace, "wikis", "dims")));
  add("wikis/rules", fs.existsSync(path.join(workspace, "wikis", "rules")));

  const wikisIndex = path.join(workspace, ".harness", "index", "wikis-index.json");
  const wikisRuntimeIndex = path.join(workspace, ".harness", "index", "wikis-runtime-index.json");
  if (effectiveProfile === lumiRequiredProfile) {
    add("wikis index", nonEmptyRegularFile(wikisIndex), wikisIndex);
    add("wikis runtime index", nonEmptyRegularFile(wikisRuntimeIndex), wikisRuntimeIndex);
    add("approved Wikis content", approvedWikisValid(workspace));
  }

  for (const binary of qdmCliBinariesForProfile(effectiveProfile)) {
    const file = path.join(workspace, "bin", binaryName(binary));
    add(`bin/${binary}`, existsExecutable(file));
    const probeArgs = binary === "qdm-metric-cli" ? ["version"] : ["wikis"];
    add(`bin/${binary} runnable`, executableLaunches(file, probeArgs));
  }
  for (const binary of removedBinaries) {
    add(`bin/${binary} absent`, !fs.existsSync(path.join(workspace, "bin", binaryName(binary))));
  }
  add("legacy auth directory absent", !fs.existsSync(path.join(workspace, ".qdm-auth")));
  add("config/harness-config.yaml", fs.existsSync(path.join(workspace, "config", "harness-config.yaml")));
  add("config/qdm-cli-paths.env", fs.existsSync(path.join(workspace, "config", "qdm-cli-paths.env")));
  add("config CLI paths", configPathsValid(workspace, effectiveProfile));

  const installedNames = new Set([
    ...Object.keys(state.tools || {}),
    ...Object.keys(state.localTools || {})
  ]);
  const expectedTools = effectiveProfile === lumiRequiredProfile
    ? ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]
    : ["data-harness-cli", "qdm-metric-cli"];
  add("installer tool set", installedNames.size === expectedTools.length &&
    expectedTools.every((name) => installedNames.has(name)));
  add("legacy CLI state absent", removedBinaries.every((name) => !installedNames.has(name)));

  if (effectiveProfile === lumiRequiredProfile) {
    add("authorization config path", state.authzConfigPath === "/etc/harness-data/authz.json");
    add("Metric authorization catalog", fs.existsSync("/etc/harness-data/approved-metrics-v1.json"));
    add("private qdm-metric-cli", Boolean(state.tools?.["qdm-metric-cli-real"]?.destination) &&
      existsExecutable(state.tools["qdm-metric-cli-real"].destination));
    let selectedAgents = [];
    try {
      selectedAgents = agentNamesForChoice(state.agent);
    } catch {
      selectedAgents = [];
    }
    for (const name of selectedAgents) {
      add(`Agent hook .${name}`, agentOk(workspace, name), `agents/${name}`);
    }
    for (const name of concreteAgentNames.filter((name) => !selectedAgents.includes(name))) {
      add(`Agent hook .${name} absent`, !fs.existsSync(path.join(workspace, `.${name}`)));
    }
  } else {
    add("Agent hook", concreteAgentNames.some((name) => agentOk(workspace, name)));
  }
  if (effectiveProfile !== lumiRequiredProfile && !fs.existsSync(wikisIndex) && !fs.existsSync(wikisRuntimeIndex)) {
    checks.push({ name: "wikis index", ok: true, detail: "missing; run data-harness-cli wikis build-index --skip-checks" });
  }

  return { workspace, profile, checks };
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
