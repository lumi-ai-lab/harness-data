import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { findWorkspaceDir, readInstallerState } from "../lib/paths.js";
import { binaryName, platformKey } from "../lib/platform.js";
import { concreteAgentNames, qdmCliBinariesForProfile } from "../lib/config.js";
import { verifyApprovedWikisSource } from "../lib/approved-wikis.js";
import { readManifest, toolDestination } from "../lib/manifest.js";
import {
  authzConfigPathFor,
  installerStateSchemaVersion,
  lumiApprovedWikisArtifact,
  lumiCatalogArtifact,
  localUnrestrictedProfile,
  lumiReleaseSet,
  lumiReleaseSetDigest,
  lumiRequiredProfile,
  profileFromState,
  sameLumiReleaseSet,
  selectManifestProfile
} from "../lib/profile.js";

const removedLocalBinaries = ["qdm-cmr-cli", "qdm-indicators-cli", "qdm-sql-cli", "cas-cli"];
const removedLocalEnvironmentVariables = [
  "QDM_CMR_CLI",
  "QDM_INDICATORS_CLI",
  "QDM_SQL_CLI",
  "QDM_CAS_CLI",
  "QDM_CAS_CONFIG_DIR"
];
const removedLocalYamlKeys = [
  "qdm_cmr_cli",
  "qdm_indicators_cli",
  "qdm_sql_cli",
  "qdm_cas_cli",
  "qdm_metric_cli"
];

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
  const values = new Map([...envContent.matchAll(/^export\s+([A-Z0-9_]+)="([^"]+)"/gm)].map((match) => [match[1], match[2]]));
  if (profile === lumiRequiredProfile) {
    if (!values.has("QDM_INDICATORS_CLI") || !fs.existsSync(values.get("QDM_INDICATORS_CLI"))) return false;
    const forbiddenEnv = ["QDM_CMR_CLI", "QDM_SQL_CLI", "QDM_CAS_CLI", "QDM_CAS_CONFIG_DIR"];
    const forbiddenYaml = ["qdm_cmr_cli", "qdm_sql_cli", "qdm_cas_cli"];
    if (forbiddenEnv.some((name) => values.has(name))) return false;
    if (forbiddenYaml.some((name) => yamlCliPath(harnessContent, name))) return false;
    const expected = path.resolve(workspace, "bin", binaryName("qdm-indicators-cli"));
    return path.resolve(values.get("QDM_INDICATORS_CLI")) === expected &&
      path.resolve(yamlCliPath(harnessContent, "qdm_indicators_cli")) === expected;
  }
  const expectedMetric = path.join("bin", binaryName("qdm-metric-cli")).replaceAll("\\", "/");
  return values.size === 1 &&
    values.get("QDM_METRIC_CLI") === expectedMetric &&
    existsExecutable(path.join(workspace, expectedMetric)) &&
    removedLocalEnvironmentVariables.every((name) => !values.has(name)) &&
    removedLocalYamlKeys.every((name) => !yamlCliPath(harnessContent, name));
}

function fileSha256(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

function installedToolValid(state, name, expectedDestination = "") {
  const tool = state.tools?.[name];
  if (!tool?.destination || !tool.sha256) return false;
  if (expectedDestination && path.resolve(tool.destination) !== path.resolve(expectedDestination)) return false;
  return existsExecutable(tool.destination) && fileSha256(tool.destination) === tool.sha256;
}

function releaseSetStateValid(state, expected) {
  const releaseSet = state.releaseSet;
  const required = ["version", "facadeVersion", "facadeSha256", "realIndicatorsVersion", "realIndicatorsSha256", "catalogSha256", "piVersion"];
  return Boolean(
    releaseSet &&
    required.every((field) => String(releaseSet[field] || "").trim()) &&
    releaseSet.realIndicatorsVersion === "v0.0.4" &&
    Number.isInteger(releaseSet.authzSchemaVersion) &&
    releaseSet.authzSchemaVersion > 0 &&
    /^[a-f0-9]{64}$/.test(String(releaseSet.facadeSha256 || "")) &&
    /^[a-f0-9]{64}$/.test(String(releaseSet.realIndicatorsSha256 || "")) &&
    /^[a-f0-9]{64}$/.test(String(releaseSet.catalogSha256 || "")) &&
    releaseSet.sha256 === lumiReleaseSetDigest(releaseSet) &&
    (!expected || sameLumiReleaseSet(releaseSet, expected))
  );
}

function readLumiContract(workspace) {
  try {
    const manifestPath = path.join(workspace, "bootstrap", "cli-manifest.json");
    const manifest = readManifest(manifestPath);
    const selected = selectManifestProfile(manifest, lumiRequiredProfile);
    const releaseSet = lumiReleaseSet(manifest);
    const catalog = lumiCatalogArtifact(manifest);
    const approvedWikis = lumiApprovedWikisArtifact(manifest);
    const helper = selected.tools.find((tool) => tool.name === "data-harness-cli");
    const facade = selected.tools.find((tool) => tool.name === "qdm-indicators-facade");
    const real = selected.tools.find((tool) => tool.name === "qdm-indicators-cli-real");
    if (!helper || !facade || !real) throw new Error("manifest is missing fixed Harness authorization artifacts");
    if (helper.tracking !== "fixed" || facade.tracking !== "fixed" || real.tracking !== "fixed") {
      throw new Error("Harness authorization artifacts are not fixed");
    }
    if (!String(helper.version || "").trim()) throw new Error("Harness helper version is not fixed");
    const key = platformKey();
    const helperBinarySha256 = String(helper.platforms?.[key]?.binarySha256 || "");
    if (!/^[a-f0-9]{64}$/.test(helperBinarySha256)) throw new Error("Harness helper binary sha256 is not fixed");
    const facadeBinarySha256 = String(facade.platforms?.[key]?.binarySha256 || "");
    if (!/^[a-f0-9]{64}$/.test(facadeBinarySha256)) throw new Error("Facade binary sha256 is not fixed for the current platform");
    const realBinarySha256 = String(real.platforms?.[key]?.binarySha256 || "");
    if (!/^[a-f0-9]{64}$/.test(realBinarySha256)) throw new Error("real Indicators CLI binary sha256 is not fixed for the current platform");
    if (facade.version !== releaseSet.facadeVersion || real.version !== releaseSet.realIndicatorsVersion) {
      throw new Error("Indicators artifact versions do not match release-set");
    }
    const publicFacade = path.join(workspace, "bin", binaryName("qdm-indicators-cli"));
    const publicHelper = path.join(workspace, "bin", binaryName("data-harness-cli"));
    const helperDestination = toolDestination(workspace, helper);
    const facadeDestination = toolDestination(workspace, facade);
    const realDestination = toolDestination(workspace, real);
    if (path.resolve(facadeDestination) !== path.resolve(publicFacade)) throw new Error("Facade destination is not public qdm-indicators-cli");
    if (path.resolve(helperDestination) !== path.resolve(publicHelper)) throw new Error("Harness helper destination is not public data-harness-cli");
    if (!path.isAbsolute(String(real.destination || ""))) throw new Error("real Indicators CLI destination is not absolute");
    return {
      authzConfigPath: authzConfigPathFor(manifest, lumiRequiredProfile),
      facadeDestination,
      facadeBinarySha256,
      helperDestination,
      helperBinarySha256,
      helperVersion: helper.version,
      realDestination,
      realBinarySha256,
      catalogDestination: catalog.destination,
      approvedWikis,
      manifestSha256: fileSha256(manifestPath),
      releaseSet
    };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

function versionWithoutPrefix(value) {
  return String(value || "").replace(/^v/, "");
}

function authzConfigMatchesState(file, state, expectedRealDestination, expectedCatalogDestination, expectedRealBinarySha256 = "") {
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const releaseSet = state.releaseSet || {};
    const realSha = expectedRealBinarySha256 || releaseSet.realIndicatorsSha256;
    return config?.mode === lumiRequiredProfile &&
      config.version === releaseSet.authzSchemaVersion &&
      config.piVersion === releaseSet.piVersion &&
      path.resolve(config.realIndicatorsCli?.path || "") === path.resolve(expectedRealDestination || "") &&
      versionWithoutPrefix(config.realIndicatorsCli?.version) === versionWithoutPrefix(releaseSet.realIndicatorsVersion) &&
      config.realIndicatorsCli?.artifactSha256 === realSha &&
      path.resolve(config.approvedIndicatorCatalog?.path || "") === path.resolve(expectedCatalogDestination || "") &&
      config.approvedIndicatorCatalog?.sha256 === releaseSet.catalogSha256;
  } catch {
    return false;
  }
}

function pathDirectories(options = {}) {
  const value = options.env && Object.hasOwn(options.env, "PATH") ? options.env.PATH : process.env.PATH;
  return String(value || "").split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry));
}

function binaryVisibleOnPath(binary, options = {}) {
  return pathDirectories(options).some((dir) => existsExecutable(path.join(dir, binaryName(binary))));
}

function nonEmptyRegularFile(file) {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch {
    return false;
  }
}

function approvedWikisValid(workspace, contract) {
  try {
    const manifestPath = path.resolve(workspace, contract.manifest);
    const expectedManifest = path.join(path.resolve(workspace), "bootstrap", "approved-lumi-wikis-manifest.json");
    if (manifestPath !== expectedManifest) return false;
    const bundledSource = path.resolve(workspace, contract.source);
    const expectedSource = path.join(path.resolve(workspace), "bootstrap", "approved-lumi-wikis");
    if (bundledSource !== expectedSource) return false;
    verifyApprovedWikisSource(bundledSource, manifestPath, contract.manifestSha256);
    verifyApprovedWikisSource(path.join(workspace, "wikis"), manifestPath, contract.manifestSha256);
    return true;
  } catch {
    return false;
  }
}

async function runAuthzReadiness(workspace, configPath, options = {}) {
  const helper = path.join(workspace, "bin", binaryName("data-harness-cli"));
  if (!existsExecutable(helper)) return { ok: false, detail: "Harness helper is unavailable" };
  try {
    const result = await run(helper, ["authz-readiness", "--config", configPath], {
      cwd: workspace,
      env: options.env,
      allowFailure: true
    });
    let body = null;
    try {
      body = JSON.parse(result.stdout);
    } catch {}
    if (result.code === 0 && body?.ready === true) return { ok: true, detail: "ready" };
    const code = String(body?.error?.code || "AUTHZ_READINESS_FAILED");
    return { ok: false, detail: code };
  } catch {
    return { ok: false, detail: "AUTHZ_READINESS_FAILED" };
  }
}

async function runCatalogContract(workspace, catalogPath, catalogSha256, options = {}) {
  const helper = path.join(workspace, "bin", binaryName("data-harness-cli"));
  if (!existsExecutable(helper)) return { ok: false, detail: "Harness helper is unavailable" };
  try {
    const result = await run(helper, [
      "authz-validate-catalog",
      "--path",
      catalogPath,
      "--sha256",
      catalogSha256
    ], { cwd: workspace, env: options.env, allowFailure: true });
    let body = null;
    try {
      body = JSON.parse(result.stdout);
    } catch {}
    return {
      ok: result.code === 0 && body?.valid === true,
      detail: result.code === 0 && body?.valid === true
        ? "valid"
        : String(body?.error?.code || "CATALOG_CONTRACT_FAILED")
    };
  } catch {
    return { ok: false, detail: "CATALOG_CONTRACT_FAILED" };
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
  const effectiveProfile = profile === lumiRequiredProfile ? lumiRequiredProfile : localUnrestrictedProfile;
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

  add("installer profile", Boolean(profile) && !profileError, profileError || profile || "missing");
  const lumiContract = effectiveProfile === lumiRequiredProfile ? readLumiContract(workspace) : null;
  if (effectiveProfile === lumiRequiredProfile) {
    add("installer state v3", state.schemaVersion === installerStateSchemaVersion);
    add("Pi-only profile", state.agent === "pi");
    add("manifest release-set", !lumiContract.error, lumiContract.error || lumiContract.releaseSet.version);
    add("manifest sha256", Boolean(!lumiContract.error && state.manifestSha256 === lumiContract.manifestSha256));
    add("release-set", releaseSetStateValid(state, lumiContract.error ? null : lumiContract.releaseSet));
  }
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
    add("approved Wikis content", Boolean(lumiContract && !lumiContract.error && approvedWikisValid(workspace, lumiContract.approvedWikis)));
  } else {
    add("wikis index", nonEmptyRegularFile(wikisIndex), wikisIndex);
    add("wikis runtime index", nonEmptyRegularFile(wikisRuntimeIndex), wikisRuntimeIndex);
  }
  for (const binary of qdmCliBinariesForProfile(effectiveProfile)) {
    add(`bin/${binary}`, existsExecutable(path.join(workspace, "bin", binaryName(binary))));
  }
  add("config/harness-config.yaml", fs.existsSync(path.join(workspace, "config", "harness-config.yaml")));
  add("config/qdm-cli-paths.env", fs.existsSync(path.join(workspace, "config", "qdm-cli-paths.env")));
  add("config CLI paths", configPathsValid(workspace, effectiveProfile));
  if (effectiveProfile === lumiRequiredProfile) {
    const forbidden = ["qdm-cmr-cli", "qdm-sql-cli", "cas-cli"];
    for (const binary of forbidden) {
      add(`bin/${binary} absent`, !fs.existsSync(path.join(workspace, "bin", binaryName(binary))));
      add(`PATH/${binary} absent`, !binaryVisibleOnPath(binary, options));
    }
    const installedNames = new Set([
      ...Object.keys(state.tools || {}),
      ...Object.keys(state.localTools || {})
    ]);
    add("forbidden CLI state absent", forbidden.every((name) => !installedNames.has(name)));
    add("authorized installer tool set", [
      "data-harness-cli",
      "qdm-indicators-cli-real",
      "qdm-indicators-facade"
    ].every((name) => installedNames.has(name)) && installedNames.size === 3);
    const publicFacade = lumiContract?.facadeDestination || path.join(workspace, "bin", binaryName("qdm-indicators-cli"));
    const helperDestination = lumiContract?.helperDestination || path.join(workspace, "bin", binaryName("data-harness-cli"));
    const helperTool = state.tools?.["data-harness-cli"];
    const helperValid = Boolean(
      installedToolValid(state, "data-harness-cli", helperDestination) &&
      helperTool?.version === lumiContract?.helperVersion &&
      helperTool?.sha256 === lumiContract?.helperBinarySha256
    );
    add("Harness helper", helperValid, helperDestination);
    const facadeTool = state.tools?.["qdm-indicators-facade"];
    add("public Indicators Facade", Boolean(
      installedToolValid(state, "qdm-indicators-facade", publicFacade) &&
      facadeTool?.version === state.releaseSet?.facadeVersion &&
      facadeTool?.sha256 === (lumiContract?.facadeBinarySha256 || state.releaseSet?.facadeSha256)
    ), publicFacade);
    const realTool = state.tools?.["qdm-indicators-cli-real"];
    const realDestination = lumiContract?.realDestination || realTool?.destination || "";
    add("private real Indicators CLI", Boolean(
      installedToolValid(state, "qdm-indicators-cli-real", realDestination) &&
      realTool?.version === state.releaseSet?.realIndicatorsVersion &&
      realTool?.sha256 === (lumiContract?.realBinarySha256 || state.releaseSet?.realIndicatorsSha256)
    ), realDestination);
    add("private real Indicators CLI outside PATH", Boolean(
      realDestination && !pathDirectories(options).includes(path.resolve(path.dirname(realDestination)))
    ), realDestination);
    const catalogDestination = lumiContract?.catalogDestination || "";
    add("approved indicator catalog", Boolean(
      catalogDestination && nonEmptyRegularFile(catalogDestination) &&
      fileSha256(catalogDestination) === state.releaseSet?.catalogSha256
    ), catalogDestination);
    const catalogContract = helperValid
      ? await runCatalogContract(
          workspace,
          catalogDestination,
          state.releaseSet?.catalogSha256 || "",
          options
        )
      : { ok: false, detail: "Harness helper integrity failed" };
    add("approved indicator catalog contract", catalogContract.ok, catalogContract.detail);
    const authzPath = state.authzConfigPath || "";
    add("authz config path", Boolean(
      path.isAbsolute(authzPath) &&
      (!lumiContract?.authzConfigPath || path.resolve(authzPath) === path.resolve(lumiContract.authzConfigPath))
    ), authzPath);
    const pendingRuntimeMount = Boolean(options.buildTime && path.isAbsolute(authzPath) && !fs.existsSync(authzPath));
    add("authz config", pendingRuntimeMount || authzConfigMatchesState(authzPath, state, realDestination, catalogDestination, lumiContract?.realBinarySha256),
      pendingRuntimeMount ? "runtime mount pending" : authzPath);
    if (options.buildTime) {
      add("authorization readiness", true, "runtime mounts, control state, context directory, and credentials pending");
    } else {
      const readiness = helperValid
        ? await runAuthzReadiness(workspace, authzPath, options)
        : { ok: false, detail: "Harness helper integrity failed" };
      add("authorization readiness", readiness.ok, readiness.detail);
    }
    add("Agent hook .pi", agentOk(workspace, "pi"), "agents/pi");
    for (const name of concreteAgentNames.filter((name) => name !== "pi")) {
      add(`Agent hook .${name} absent`, !fs.existsSync(path.join(workspace, `.${name}`)));
    }
  } else {
    for (const binary of removedLocalBinaries) {
      add(`bin/${binary} absent`, !fs.existsSync(path.join(workspace, "bin", binaryName(binary))));
    }
    add("legacy auth directory absent", !fs.existsSync(path.join(workspace, ".qdm-auth")));
    const installedNames = new Set([
      ...Object.keys(state.tools || {}),
      ...Object.keys(state.localTools || {})
    ]);
    add("installer tool set", installedNames.size === 2 &&
      installedNames.has("data-harness-cli") &&
      installedNames.has("qdm-metric-cli"));
    add("legacy CLI state absent", removedLocalBinaries.every((name) => !installedNames.has(name)));
    add("Agent hook", concreteAgentNames.some((name) => agentOk(workspace, name)));
    for (const name of ["openclaw", "hermes"]) {
      if (fs.existsSync(path.join(workspace, `.${name}`))) {
        add(`Agent hook .${name}`, agentOk(workspace, name), `agents/${name}`);
      }
    }
  }
  return {
    workspace,
    profile,
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
