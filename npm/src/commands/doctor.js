import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findWorkspaceDir, readInstallerState } from "../lib/paths.js";
import { binaryName } from "../lib/platform.js";
import { concreteAgentNames, qdmCliBinariesForProfile } from "../lib/config.js";
import {
  installerStateSchemaVersion,
  localUnrestrictedProfile,
  piRequesterApprovedWikisArtifact,
  piRequesterAuthorizedProfile,
  profileFromState
} from "../lib/profile.js";
import { readManifest } from "../lib/manifest.js";
import { verifyApprovedWikisSource } from "../lib/approved-wikis.js";

const removedBinaries = ["qdm-cmr-cli", "qdm-indicators-cli", "qdm-sql-cli", "cas-cli"];
const removedEnvironmentVariables = [
  "QDM_CMR_CLI",
  "QDM_INDICATORS_CLI",
  "QDM_SQL_CLI",
  "QDM_CAS_CLI",
  "QDM_CAS_CONFIG_DIR"
];
const removedYamlKeys = [
  "qdm_cmr_cli",
  "qdm_indicators_cli",
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

function executableLaunches(file, args, requiredStatus = null) {
  if (!existsExecutable(file)) return false;
  const result = spawnSync(file, args, {
    encoding: "utf8",
    timeout: 10_000,
  });
  return !result.error && !result.signal && Number.isInteger(result.status) &&
    (requiredStatus === null || result.status === requiredStatus);
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
  const expected = profile === piRequesterAuthorizedProfile
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
    const approved = piRequesterApprovedWikisArtifact(manifest);
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
  const effectiveProfile = profile === piRequesterAuthorizedProfile ? piRequesterAuthorizedProfile : localUnrestrictedProfile;
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("installer profile", Boolean(profile) && !profileError, profileError || profile || "missing");
  add(`installer state v${installerStateSchemaVersion}`, state.schemaVersion === installerStateSchemaVersion);
  add("runtime", fs.existsSync(path.join(workspace, "bootstrap", "cli-manifest.json")) && fs.existsSync(path.join(workspace, "agents")), workspace);
  add("wikis/index.md", fs.existsSync(path.join(workspace, "wikis", "index.md")));
  add("wikis/metrics", fs.existsSync(path.join(workspace, "wikis", "metrics")));
  add("wikis/reports", fs.existsSync(path.join(workspace, "wikis", "reports")));
  add("wikis/dims", fs.existsSync(path.join(workspace, "wikis", "dims")));
  add("wikis/rules", fs.existsSync(path.join(workspace, "wikis", "rules")));

  const wikisIndex = path.join(workspace, ".harness", "index", "wikis-index.json");
  const wikisRuntimeIndex = path.join(workspace, ".harness", "index", "wikis-runtime-index.json");
  if (effectiveProfile === piRequesterAuthorizedProfile) {
    add("wikis index", nonEmptyRegularFile(wikisIndex), wikisIndex);
    add("wikis runtime index", nonEmptyRegularFile(wikisRuntimeIndex), wikisRuntimeIndex);
    add("release-pinned Wikis content", approvedWikisValid(workspace));
  } else {
    add("wikis index", nonEmptyRegularFile(wikisIndex), wikisIndex);
    add("wikis runtime index", nonEmptyRegularFile(wikisRuntimeIndex), wikisRuntimeIndex);
  }

  for (const binary of qdmCliBinariesForProfile(effectiveProfile)) {
    const file = path.join(workspace, "bin", binaryName(binary));
    add(`bin/${binary}`, existsExecutable(file));
    const authzProbe = effectiveProfile === piRequesterAuthorizedProfile && binary === "qdm-metric-cli";
    const probeArgs = binary === "qdm-metric-cli" ? ["version"] : ["wikis"];
    const requiredStatus = binary !== "qdm-metric-cli"
      ? null
      : authzProbe
        ? 77
        : 0;
    add(
      `bin/${binary} runnable`,
      executableLaunches(file, probeArgs, requiredStatus),
      authzProbe
        ? "fails closed without Lumi requester JSON"
        : ""
    );
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
  const expectedTools = effectiveProfile === piRequesterAuthorizedProfile
    ? ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]
    : ["data-harness-cli", "qdm-metric-cli"];
  add("installer tool set", installedNames.size === expectedTools.length &&
    expectedTools.every((name) => installedNames.has(name)));
  add("legacy CLI state absent", removedBinaries.every((name) => !installedNames.has(name)));

  if (effectiveProfile === piRequesterAuthorizedProfile) {
    add("Pi-only profile", state.agent === "pi");
    add("authorization config absent", !state.authzConfigPath);
    add("Metric authorization catalog", nonEmptyRegularFile(path.join(workspace, "bootstrap", "approved-metrics-v1.json")));
    add("direct Metric CLI", existsExecutable(path.join(workspace, "bin", binaryName("qdm-metric-cli-real"))));
    add("Agent hook .pi", agentOk(workspace, "pi"), "agents/pi");
    for (const name of concreteAgentNames.filter((name) => name !== "pi")) {
      add(`Agent hook .${name} absent`, !fs.existsSync(path.join(workspace, `.${name}`)));
    }
  } else {
    add("Agent hook", concreteAgentNames.some((name) => agentOk(workspace, name)));
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
