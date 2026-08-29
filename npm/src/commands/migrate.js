import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readAuthzFromHarnessConfig } from "../lib/config.js";
import { packageVersion } from "../lib/package.js";
import { readWorkspaceState } from "../lib/paths.js";
import { binaryName, isExecutable, platformKey } from "../lib/platform.js";
import { normalizeRootContext, workspaceIdentity } from "../lib/root-context.js";
import { collectRootDoctor } from "./doctor.js";

const MIGRATION_SCHEMA_VERSION = 1;
const MIGRATION_POINTER_FILE = "migration.json";
const MIGRATION_DIR = "migrations";

export class MigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Plan a legacy install --dir migration without modifying either source or
 * target. The returned report is intentionally safe to print: it contains
 * paths, hashes, and metadata but never secret contents or prompt text.
 */
export function planMigration(options = {}) {
  const checkOnly = options.check === true;
  const report = {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    mode: checkOnly ? "check" : "migrate",
    ok: false,
    ready: false,
    sourceValid: false,
    idempotent: false,
    source: {},
    target: {},
    items: [],
    blockers: [],
    warnings: [],
  };
  try {
    const sourceRoot = canonicalExistingDirectory(options.from, "--from");
    const host = String(options.host || "codex").trim() || "codex";
    const targetPlatform = platformKey(options.platform || process.platform, options.architecture || process.arch);
    const targetOS = platformFromKey(targetPlatform);
    const dataRoot = options.to ? canonicalFutureDirectory(options.to, "--to") : "";
    const workspaceRoot = options.workspaceRoot ? canonicalExistingDirectory(options.workspaceRoot, "--workspace-root") : "";
    const secretRoot = options.secretRoot ? canonicalFutureDirectory(options.secretRoot, "--secret-root") : "";
    const pluginRoot = options.pluginRoot ? canonicalExistingDirectory(options.pluginRoot, "--plugin-root") : "";
    if (pluginRoot) validateMigrationPluginRoot(pluginRoot);
    const legacy = inspectLegacyRuntime(sourceRoot);
    const metricCli = inspectMetricCli(sourceRoot, targetOS);
    const resource = inspectResources(sourceRoot);
    const sourceAuth = inspectLegacyAuth(sourceRoot, legacy.authz);
    const sourceFingerprint = migrationSourceFingerprint({ legacy, metricCli, resource, auth: sourceAuth });
    const sourceId = sha256([sourceRoot, sourceFingerprint].join("\n")).slice(0, 32);
    const auth = bindLegacyAuth(sourceAuth, secretRoot, sourceId);
    const runtimeVersion = safeRuntimeVersion(
      legacy.installerState.runtimeTag || legacy.manifest.releaseTag || legacy.manifest.version || legacy.installerState.packageVersion,
    );
    const stateRoot = dataRoot && workspaceRoot
      ? path.join(dataRoot, "state", "workspaces", workspaceIdentity({ host, workspaceRoot, schemaVersion: 1 }))
      : "";

    report.source = {
      root: sourceRoot,
      id: sourceId,
      fingerprint: sourceFingerprint,
      manifestSha256: legacy.manifestSha256,
      manifestSchemaVersion: legacy.manifest.schemaVersion ?? null,
      legacyInstallerVersion: String(legacy.installerState.packageVersion || ""),
      runtimeTag: String(legacy.installerState.runtimeTag || legacy.manifest.releaseTag || legacy.manifest.version || ""),
      runtimeVersion,
      wikiContentVersion: resource.ok ? resource.wikisSha256 : "",
      platform: targetPlatform,
    };
    report.target = {
      dataRoot,
      secretRoot,
      pluginRoot,
      workspaceRoot,
      stateRoot,
      host,
      platform: targetPlatform,
    };

    if (!dataRoot) {
      if (checkOnly) report.warnings.push("--to <data-root> was not supplied; dry run can validate the legacy source but cannot calculate writable targets");
      else report.blockers.push(blocker("QDM_DATA_ROOT_UNAVAILABLE", "--to <data-root> is required for migration"));
    }
    if (!workspaceRoot) {
      if (checkOnly) report.warnings.push("--workspace-root was not supplied; dry run will not infer a workspace or stateRoot from cwd or .harness");
      else report.blockers.push(blocker("QDM_WORKSPACE_REQUIRED", "--workspace-root is required; migration will not infer a workspace from cwd or .harness"));
    }
    if (!pluginRoot) report.warnings.push("--plugin-root was not supplied; the migrated install manifest will not bind to the legacy runtime and post-migration doctor can only validate the legacy runtime transiently");
    if (dataRoot && workspaceRoot) validateDistinctRoots({ sourceRoot, dataRoot, workspaceRoot, secretRoot, pluginRoot });

    report.warnings.push(...auth.warnings);
    if (auth.blocker) {
      if (checkOnly && auth.requiresSecretRoot) report.warnings.push(auth.blocker.message);
      else report.blockers.push(auth.blocker);
    }

    if (!metricCli.ok) report.blockers.push(metricCli.blocker);
    if (!resource.ok) report.blockers.push(resource.blocker);
    report.sourceValid = Boolean(metricCli.ok && resource.ok && !sourceAuth.blocker);

    if (dataRoot && workspaceRoot) {
      const rootTarget = path.join(dataRoot, "resources", "legacy", sourceId);
      report.items.push(
        item("legacy-config", path.join(sourceRoot, "config", "harness-config.yaml"), path.join(dataRoot, "config", "settings.json"), "rewrite", {
          sourceSha256: legacy.configSha256,
        }),
        item("metric-cli", metricCli.path || "", path.join(dataRoot, "runtimes", targetPlatform, runtimeVersion, binaryName("qdm-metric-cli", targetOS)), "copy", {
          sourceSha256: metricCli.sha256,
          bytes: metricCli.bytes,
        }),
        item("wikis", path.join(sourceRoot, "wikis"), path.join(rootTarget, "wikis"), "copy", {
          sourceTreeSha256: resource.wikisSha256,
          entries: resource.wikisEntries,
        }),
      );
      if (resource.indexPath) {
        report.items.push(item("legacy-index", resource.indexPath, path.join(rootTarget, "index"), "copy", {
          sourceTreeSha256: resource.indexSha256,
          entries: resource.indexEntries,
        }));
      }
      if (legacy.statePath) {
        report.items.push(item("legacy-state", legacy.statePath, stateRoot, "copy", {
          sourceTreeSha256: legacy.stateSha256,
          entries: legacy.stateEntries,
          skips: ["*.lock"],
        }));
      }
      if (auth.secret) {
        report.items.push(item("auth-secret", auth.secret.source, auth.secret.target, "copy-secret", {
          sourceSha256: auth.secret.sha256,
          bytes: auth.secret.bytes,
          mode: "0600",
        }));
      }
      report.items.push(item("install-manifest", "", path.join(dataRoot, "install-manifest.json"), "write", {}));
      report.items.push(item("migration-record", "", path.join(dataRoot, MIGRATION_DIR, `${sourceId}.json`), "write", {}));
      report.items.push(item("migration-pointer", "", path.join(dataRoot, MIGRATION_POINTER_FILE), "write", {}));

      const existing = readExistingMigration(dataRoot);
      if (existing) {
        if (existing.sourceId === sourceId && existing.sourceRoot === sourceRoot && existing.workspaceRoot === workspaceRoot) {
          const verified = verifyCompletedMigration({ source: report.source, target: report.target, items: report.items, auth, pointer: existing });
          if (verified.ok) {
            report.idempotent = true;
            report.warnings.push("matching completed migration already exists and its records still verify; migrate will perform no writes");
          } else {
            report.blockers.push(blocker("QDM_MIGRATION_REQUIRED", `completed migration is damaged or stale: ${verified.message}`));
          }
        } else {
          report.blockers.push(blocker("QDM_MIGRATION_REQUIRED", "dataRoot already contains a migration from a different source or workspace; refusing to merge data"));
        }
      } else if (fs.existsSync(dataRoot)) {
        report.blockers.push(blocker("QDM_DATA_ROOT_UNAVAILABLE", "dataRoot already exists; migration requires a new, non-existent target directory"));
      }
    }

    report.ready = report.blockers.length === 0 && Boolean(dataRoot && workspaceRoot) && !auth.requiresSecretRoot;
    report.ok = report.ready;
    report.auth = auth.public;
    report.legacy = {
      installerState: publicInstallerState(legacy.installerState),
      config: { authz: publicAuthz(legacy.authz) },
    };
    Object.defineProperty(report, "_migrationAuth", { value: auth, enumerable: false });
    return report;
  } catch (error) {
    const code = error?.code || "QDM_MIGRATION_REQUIRED";
    report.blockers.push(blocker(code, error?.message || String(error)));
    return report;
  }
}

export async function migrateCommand(options = {}, io = process) {
  const plan = planMigration(options);
  if (options.check === true) {
    writeReport(plan, options, io);
    if (!plan.ready && io === process) process.exitCode = 1;
    return plan;
  }
  if (!plan.ready) throw new MigrationError(firstBlockerCode(plan), firstBlockerMessage(plan));
  if (plan.idempotent) {
    const report = { ...plan, mode: "migrate", ok: true, idempotent: true, migrated: false };
    writeReport(report, options, io);
    return report;
  }
  const result = await executeMigration(plan);
  writeReport(result, options, io);
  return result;
}

async function executeMigration(plan) {
  const { source, target, legacy } = plan;
  const auth = plan._migrationAuth || { secret: null, public: { type: "none", status: "unconfigured" } };
  verifyMigrationSourceUnchanged(plan);
  const parent = existingParent(target.dataRoot);
  assertWritable(parent, "dataRoot parent");
  const stageContainer = fs.mkdtempSync(path.join(parent, `.qdm-harness-migrate-${path.basename(target.dataRoot)}-`));
  const stagedDataRoot = path.join(stageContainer, "data");
  const stagedStateRoot = stagePath(target.dataRoot, stagedDataRoot, target.stateRoot);
  let committedData = false;
  let secretTemp = "";
  let secretCreated = false;
  let secretFinal = "";
  try {
    fs.mkdirSync(stagedDataRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stagedStateRoot, { recursive: true, mode: 0o700 });

    const records = [];
    const metricItem = findItem(plan, "metric-cli");
    const metricTarget = stagePath(target.dataRoot, stagedDataRoot, metricItem.target);
    copyFileVerified(metricItem.source, metricTarget, {
      executable: true,
      expectedSha256: metricItem.sourceSha256,
      sourceRoot: source.root,
    });
    records.push(recordFromItem(metricItem, metricTarget));

    const wikisItem = findItem(plan, "wikis");
    const stagedWikis = stagePath(target.dataRoot, stagedDataRoot, wikisItem.target);
    copyTreeVerified(wikisItem.source, stagedWikis, {
      skip: skipGitMetadata,
      expectedTreeSha256: wikisItem.sourceTreeSha256,
      expectedEntries: wikisItem.entries,
      sourceRoot: source.root,
    });
    records.push(recordFromItem(wikisItem, stagedWikis, { skip: skipGitMetadata }));

    const indexItem = findOptionalItem(plan, "legacy-index");
    if (indexItem) {
      const stagedIndex = stagePath(target.dataRoot, stagedDataRoot, indexItem.target);
      copyTreeVerified(indexItem.source, stagedIndex, {
        expectedTreeSha256: indexItem.sourceTreeSha256,
        expectedEntries: indexItem.entries,
        sourceRoot: source.root,
      });
      records.push(recordFromItem(indexItem, stagedIndex));
    }

    const stateItem = findOptionalItem(plan, "legacy-state");
    if (stateItem) {
      copyTreeVerified(stateItem.source, stagedStateRoot, {
        skip: skipStateLock,
        expectedTreeSha256: stateItem.sourceTreeSha256,
        expectedEntries: stateItem.entries,
        sourceRoot: source.root,
      });
      records.push(recordFromItem(stateItem, stagedStateRoot, { skip: skipStateLock }));
    }

    const secretRef = prepareSecret(auth, source.id);
    secretTemp = secretRef.tempPath || "";
    secretFinal = secretRef.path || "";
    secretCreated = Boolean(secretRef.created);
    if (auth.secret) {
      records.push({
        name: "auth-secret",
        target: auth.secret.target,
        sha256: auth.secret.sha256,
        bytes: auth.secret.bytes,
        status: "copied-secret",
      });
    }

    const settings = {
      schemaVersion: 1,
      host: target.host,
      dataRoot: target.dataRoot,
      stateRoot: target.stateRoot,
      pluginRoot: target.pluginRoot || "",
      legacyPluginRoot: source.root,
      migratedFrom: source.root,
      migrationSourceId: source.id,
      secretRef: secretRef.publicRef,
      legacy: {
        runtimeTag: source.runtimeTag,
        runtimeVersion: source.runtimeVersion,
        resource: {
          wikiContentVersion: source.wikiContentVersion,
          indexTreeSha256: findOptionalItem(plan, "legacy-index")?.sourceTreeSha256 || "",
        },
        installerState: legacy.installerState,
        authz: publicAuthz(legacy.config.authz),
      },
    };
    const settingsTarget = path.join(stagedDataRoot, "config", "settings.json");
    writeJsonAtomic(settingsTarget, settings, 0o600);
    records.push({ name: "legacy-config", target: path.join(target.dataRoot, "config", "settings.json"), sha256: sha256File(settingsTarget), status: "rewritten" });

    const installManifest = {
      schemaVersion: 1,
      contextSchemaVersion: 1,
      host: target.host,
      pluginRoot: target.pluginRoot || "",
      legacyPluginRoot: source.root,
      dataRoot: target.dataRoot,
      stateRoot: target.stateRoot,
      configPath: path.join(target.dataRoot, "config", "settings.json"),
      installerVersion: packageVersion(),
      runtimeTag: source.runtimeTag,
      runtimeVersion: source.runtimeVersion,
      pluginVersion: "",
      resourceVersion: source.wikiContentVersion,
      metricCli: {
        path: findItem(plan, "metric-cli").target,
        source: findItem(plan, "metric-cli").source,
        platform: target.platform,
        sha256: findItem(plan, "metric-cli").sourceSha256,
        status: "ready",
      },
      secret: { type: secretRef.publicRef?.kind || "none", status: secretRef.publicRef ? "configured" : "unconfigured" },
      secretSourceType: secretRef.publicRef?.kind || "none",
      migratedFrom: { sourceId: source.id, sourceRoot: source.root },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const installManifestTarget = path.join(stagedDataRoot, "install-manifest.json");
    writeJsonAtomic(installManifestTarget, installManifest, 0o600);
    records.push({
      name: "install-manifest",
      target: path.join(target.dataRoot, "install-manifest.json"),
      sha256: sha256File(installManifestTarget),
      status: "written",
    });

    const migrationRecord = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      status: "complete",
      sourceId: source.id,
      sourceRoot: source.root,
      sourceManifestSha256: source.manifestSha256,
      sourceFingerprint: source.fingerprint,
      legacyResourceVersion: source.wikiContentVersion,
      targetDataRoot: target.dataRoot,
      workspaceRoot: target.workspaceRoot,
      stateRoot: target.stateRoot,
      host: target.host,
      pluginRoot: target.pluginRoot || "",
      legacyPluginRoot: source.root,
      legacyInstallerState: publicInstallerState(legacy.installerState),
      records,
      completedAt: new Date().toISOString(),
    };
    const migrationRelative = path.join(MIGRATION_DIR, `${source.id}.json`);
    writeJsonAtomic(path.join(stagedDataRoot, migrationRelative), migrationRecord, 0o600);
    writeJsonAtomic(path.join(stagedDataRoot, MIGRATION_POINTER_FILE), {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      status: "complete",
      sourceId: source.id,
      sourceRoot: source.root,
      sourceFingerprint: source.fingerprint,
      targetDataRoot: target.dataRoot,
      workspaceRoot: target.workspaceRoot,
      host: target.host,
      manifest: migrationRelative.split(path.sep).join("/"),
      completedAt: migrationRecord.completedAt,
    }, 0o600);

    fs.renameSync(stagedDataRoot, target.dataRoot);
    committedData = true;
    if (secretTemp) {
      fs.renameSync(secretTemp, secretFinal);
      secretTemp = "";
    }

    const doctor = await collectRootDoctor(normalizeRootContext({
      schemaVersion: 1,
      host: target.host,
      pluginRoot: target.pluginRoot || source.root,
      dataRoot: target.dataRoot,
      secretRoot: target.secretRoot,
      workspaceRoot: target.workspaceRoot,
      secretRef: secretRef.publicRef,
      capabilities: {
        canWriteWorkspace: true,
        canWriteData: true,
        hasStableSessionId: false,
        supportsSecretReference: Boolean(secretRef.publicRef),
      },
    }));
    if (!doctor.ok) {
      const failures = doctor.checks
        .filter((item) => !item.ok && item.status !== "warning")
        .map((item) => `${item.name}${item.detail ? ` (${item.detail})` : ""}`);
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `post-migration doctor failed: ${failures.join(", ")}`);
    }
    return { ...plan, mode: "migrate", ok: true, ready: true, migrated: true, idempotent: false, doctor };
  } catch (error) {
    let rollbackFailure = null;
    if (committedData && fs.existsSync(target.dataRoot)) {
      try {
        fs.renameSync(target.dataRoot, stagedDataRoot);
        committedData = false;
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
    }
    if (secretTemp) fs.rmSync(secretTemp, { force: true });
    if (!rollbackFailure && secretCreated && secretFinal) fs.rmSync(secretFinal, { force: true });
    if (rollbackFailure) {
      try {
        writeJsonAtomic(path.join(target.dataRoot, "migration-incomplete.json"), {
          schemaVersion: MIGRATION_SCHEMA_VERSION,
          status: "rollback-required",
          sourceId: source.id,
          sourceFingerprint: source.fingerprint,
          errorCode: error?.code || "QDM_MIGRATION_REQUIRED",
          recordedAt: new Date().toISOString(),
        }, 0o600);
      } catch {
        // The explicit rollback error below remains the safe signal for callers.
      }
      throw new MigrationError(
        "QDM_MIGRATION_ROLLBACK_FAILED",
        `migration failed and rollback could not restore dataRoot: ${rollbackFailure.message || rollbackFailure}`,
        { causeCode: error?.code || "QDM_MIGRATION_REQUIRED" },
      );
    }
    throw error;
  } finally {
    fs.rmSync(stageContainer, { recursive: true, force: true });
  }
}

function inspectLegacyRuntime(sourceRoot) {
  const manifestPath = path.join(sourceRoot, "bootstrap", "cli-manifest.json");
  assertNoSymlinkPath(sourceRoot, manifestPath, "legacy bootstrap manifest");
  const manifest = readJsonRequired(manifestPath, "legacy bootstrap/cli-manifest.json");
  if (!Number.isInteger(Number(manifest.schemaVersion)) || Number(manifest.schemaVersion) < 1 || Number(manifest.schemaVersion) > 2) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", `unsupported legacy CLI manifest schema: ${manifest.schemaVersion}`);
  }
  const agentsPath = path.join(sourceRoot, "agents");
  assertNoSymlinkPath(sourceRoot, agentsPath, "legacy agents directory");
  assertDirectory(agentsPath, "legacy runtime agents/");
  const configPath = path.join(sourceRoot, "config", "harness-config.yaml");
  assertNoSymlinkPath(sourceRoot, configPath, "legacy harness config");
  assertRegularFile(configPath, "legacy runtime config/harness-config.yaml");
  const harnessRoot = path.join(sourceRoot, ".harness");
  const statePath = path.join(sourceRoot, ".harness", "state");
  const indexPath = path.join(sourceRoot, ".harness", "index");
  const installerStatePath = path.join(sourceRoot, ".harness", "installer-state.json");
  assertNoSymlinkPath(sourceRoot, harnessRoot, "legacy .harness directory");
  assertNoSymlinkPath(sourceRoot, statePath, "legacy state directory");
  assertNoSymlinkPath(sourceRoot, indexPath, "legacy index directory");
  assertNoSymlinkPath(sourceRoot, installerStatePath, "legacy installer state");
  const authz = readAuthzFromHarnessConfig(configPath);
  const state = isDirectory(statePath) ? treeDigest(statePath, { skip: skipStateLock }) : null;
  return {
    manifest,
    manifestSha256: sha256File(manifestPath),
    configSha256: sha256File(configPath),
    configPath,
    authz,
    installerState: isDirectory(harnessRoot) ? readWorkspaceState(sourceRoot) : {},
    installerStateSha256: fs.existsSync(installerStatePath) ? sha256File(installerStatePath) : "",
    statePath: state ? statePath : "",
    stateSha256: state?.sha256 || "",
    stateEntries: state?.entries || 0,
    indexPath: isDirectory(indexPath) ? indexPath : "",
  };
}

function inspectMetricCli(sourceRoot, platform = process.platform) {
  const filePath = path.join(sourceRoot, "bin", binaryName("qdm-metric-cli", platform));
  assertNoSymlinkPath(sourceRoot, filePath, "legacy qdm-metric-cli");
  if (!isExecutable(filePath, platform)) {
    return { ok: false, blocker: blocker("QDM_SETUP_REQUIRED", `legacy qdm-metric-cli is unavailable: ${filePath}`) };
  }
  assertRegularFile(filePath, "legacy qdm-metric-cli");
  return { ok: true, path: filePath, sha256: sha256File(filePath), bytes: fs.statSync(filePath).size };
}

function inspectResources(sourceRoot) {
  const wikisPath = path.join(sourceRoot, "wikis");
  assertNoSymlinkPath(sourceRoot, wikisPath, "legacy wikis directory");
  if (!isDirectory(wikisPath)) return { ok: false, blocker: blocker("QDM_MIGRATION_REQUIRED", "legacy runtime is missing wikis/") };
  for (const name of ["index.md", "metrics", "reports", "dims", "rules"]) {
    const requiredPath = path.join(wikisPath, name);
    assertNoSymlinkPath(sourceRoot, requiredPath, `legacy wiki resource ${name}`);
    if (!fs.existsSync(requiredPath)) {
      return { ok: false, blocker: blocker("QDM_MIGRATION_REQUIRED", `legacy wikis are missing ${name}`) };
    }
  }
  const wikis = treeDigest(wikisPath, { skip: skipGitMetadata });
  const indexPath = path.join(sourceRoot, ".harness", "index");
  assertNoSymlinkPath(sourceRoot, indexPath, "legacy index directory");
  const index = isDirectory(indexPath) ? treeDigest(indexPath) : null;
  return {
    ok: true,
    wikisSha256: wikis.sha256,
    wikisEntries: wikis.entries,
    indexPath: index ? indexPath : "",
    indexSha256: index?.sha256 || "",
    indexEntries: index?.entries || 0,
  };
}

function inspectLegacyAuth(sourceRoot, authz) {
  const warnings = [];
  if (!authz || authz.mode !== "on") {
    return { warnings, public: { type: "none", status: "unconfigured" }, secret: null, requiresSecretRoot: false };
  }
  if (!authz.blobFile || !authz.devUserId) {
    return {
      warnings,
      public: { type: "file", status: "blocked" },
      blocker: blocker("QDM_SECRET_UNAVAILABLE", "legacy auth is enabled but blob_file or dev_user_id is missing"),
      secret: null,
      requiresSecretRoot: false,
    };
  }
  const blobPath = resolveInside(sourceRoot, authz.blobFile, "legacy auth blob path");
  try {
    assertRegularFile(blobPath, "legacy auth blob", "QDM_SECRET_UNAVAILABLE");
    if (process.platform !== "win32" && (fs.statSync(blobPath).mode & 0o777) !== 0o600) {
      throw new MigrationError("QDM_SECRET_UNAVAILABLE", "legacy auth blob permissions must be 0600");
    }
    const content = fs.readFileSync(blobPath, "utf8").trim();
    if (!content.startsWith("qdm1enc.")) {
      throw new MigrationError("QDM_SECRET_UNAVAILABLE", "legacy auth blob must start with qdm1enc.");
    }
  } catch (error) {
    return {
      warnings,
      public: { type: "file", status: "blocked" },
      blocker: blocker(error.code || "QDM_SECRET_UNAVAILABLE", error.message || String(error)),
      secret: null,
      requiresSecretRoot: false,
    };
  }
  return {
    warnings,
    public: { type: "file", status: "pending-secret-root" },
    requiresSecretRoot: false,
    secret: { source: blobPath, sourceRoot, sha256: sha256File(blobPath), bytes: fs.statSync(blobPath).size },
  };
}

function bindLegacyAuth(sourceAuth, secretRoot, sourceId) {
  if (!sourceAuth.secret) return sourceAuth;
  if (!secretRoot) {
    return {
      ...sourceAuth,
      public: { type: "file", status: "blocked" },
      blocker: blocker("QDM_SECRET_UNAVAILABLE", "legacy auth is enabled; --secret-root is required for a file secret reference"),
      requiresSecretRoot: true,
    };
  }
  return {
    ...sourceAuth,
    public: { type: "file", status: "configured" },
    requiresSecretRoot: false,
    secret: {
      ...sourceAuth.secret,
      secretRoot,
      target: path.join(secretRoot, "profiles", `migrated-${sourceId}`, "auth.blob"),
    },
  };
}

function prepareSecret(auth, sourceId) {
  if (!auth.secret) return { publicRef: null, path: "", tempPath: "", created: false };
  const secretRoot = ensureDirectoryNoSymlinks(auth.secret.secretRoot, "secretRoot");
  const requestedDirectory = path.dirname(auth.secret.target);
  assertNoSymlinkPath(secretRoot, requestedDirectory, "migrated auth directory", "QDM_SECRET_UNAVAILABLE");
  const directory = ensureDirectoryNoSymlinks(requestedDirectory, "migrated auth directory");
  if (!isWithin(secretRoot, directory)) {
    throw new MigrationError("QDM_SECRET_UNAVAILABLE", "migrated auth directory escapes secretRoot");
  }
  const target = path.join(directory, path.basename(auth.secret.target));
  assertNoSymlinkPath(secretRoot, target, "migrated auth blob", "QDM_SECRET_UNAVAILABLE");
  if (fs.existsSync(target)) {
    assertRegularFile(target, "existing migrated auth blob", "QDM_SECRET_UNAVAILABLE");
    if (process.platform !== "win32" && (fs.statSync(target).mode & 0o777) !== 0o600) {
      throw new MigrationError("QDM_SECRET_UNAVAILABLE", "existing migrated auth blob permissions must be 0600");
    }
    if (sha256File(target) !== auth.secret.sha256) {
      throw new MigrationError("QDM_SECRET_UNAVAILABLE", "existing migrated auth blob differs from legacy source; refusing to overwrite it");
    }
    return { publicRef: { kind: "file", path: target }, path: target, tempPath: "", created: false };
  }
  const tempPath = path.join(directory, `.auth.blob.migrate-${sourceId}-${process.pid}-${Date.now()}`);
  assertNoSymlinkPath(auth.secret.sourceRoot, auth.secret.source, "legacy auth blob", "QDM_SECRET_UNAVAILABLE");
  assertRegularFile(auth.secret.source, "legacy auth blob", "QDM_SECRET_UNAVAILABLE");
  if (sha256File(auth.secret.source) !== auth.secret.sha256) {
    throw new MigrationError("QDM_SECRET_UNAVAILABLE", "legacy auth blob changed after migration planning");
  }
  fs.copyFileSync(auth.secret.source, tempPath);
  if (process.platform !== "win32") fs.chmodSync(tempPath, 0o600);
  if (sha256File(tempPath) !== auth.secret.sha256) {
    fs.rmSync(tempPath, { force: true });
    throw new MigrationError("QDM_SECRET_UNAVAILABLE", "copied auth blob hash does not match legacy source");
  }
  return { publicRef: { kind: "file", path: target }, path: target, tempPath, created: true };
}

function copyFileVerified(source, target, { executable = false, expectedSha256 = "", sourceRoot = "" } = {}) {
  if (sourceRoot) assertNoSymlinkPath(sourceRoot, source, "migration source file");
  assertRegularFile(source, "migration source file");
  const expected = expectedSha256 || sha256File(source);
  if (sha256File(source) !== expected) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration source changed after planning: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target);
  if (process.platform !== "win32") fs.chmodSync(target, executable ? 0o755 : (fs.statSync(source).mode & 0o777));
  if (sha256File(target) !== expected) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", `copy verification failed: ${source}`);
  }
}

function copyTreeVerified(source, target, { skip = null, expectedTreeSha256 = "", expectedEntries = null, sourceRoot = "" } = {}) {
  if (sourceRoot) assertNoSymlinkPath(sourceRoot, source, "migration source tree");
  const sourceDigest = treeDigest(source, { skip });
  if ((expectedTreeSha256 && sourceDigest.sha256 !== expectedTreeSha256)
    || (Number.isInteger(expectedEntries) && sourceDigest.entries !== expectedEntries)) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration source changed after planning: ${source}`);
  }
  copyTree(source, target, { skip });
  const targetDigest = treeDigest(target, { skip });
  const expectedSha256 = expectedTreeSha256 || sourceDigest.sha256;
  const expectedCount = Number.isInteger(expectedEntries) ? expectedEntries : sourceDigest.entries;
  if (targetDigest.sha256 !== expectedSha256 || targetDigest.entries !== expectedCount) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", `tree copy verification failed: ${source}`);
  }
}

function copyTree(source, target, { skip = null } = {}) {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw new MigrationError("QDM_MIGRATION_REQUIRED", `symbolic links are not supported in migration input: ${source}`);
  if (info.isFile()) {
    copyFileVerified(source, target, { executable: Boolean(info.mode & 0o111) });
    return;
  }
  if (!info.isDirectory()) throw new MigrationError("QDM_MIGRATION_REQUIRED", `unsupported migration input type: ${source}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(target, info.mode & 0o777);
  for (const name of fs.readdirSync(source).sort()) {
    if (skip?.(name, source)) continue;
    copyTree(path.join(source, name), path.join(target, name), { skip });
  }
}

function recordFromItem(planItem, stagedPath, { skip = null } = {}) {
  const info = fs.statSync(stagedPath);
  if (info.isFile()) return { name: planItem.name, target: planItem.target, sha256: sha256File(stagedPath), bytes: info.size, status: "copied" };
  const digest = treeDigest(stagedPath, { skip });
  return { name: planItem.name, target: planItem.target, treeSha256: digest.sha256, entries: digest.entries, status: "copied" };
}

function treeDigest(root, { skip = null } = {}) {
  const hash = crypto.createHash("sha256");
  let entries = 0;
  const visit = (current, relative = "") => {
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) throw new MigrationError("QDM_MIGRATION_REQUIRED", `symbolic links are not supported in migration input: ${current}`);
    if (info.isFile()) {
      entries += 1;
      hash.update(`F\0${relative}\0${sha256File(current)}\0${info.size}\0`);
      return;
    }
    if (!info.isDirectory()) throw new MigrationError("QDM_MIGRATION_REQUIRED", `unsupported migration input type: ${current}`);
    entries += 1;
    hash.update(`D\0${relative}\0`);
    for (const name of fs.readdirSync(current).sort()) {
      if (skip?.(name, current)) continue;
      const childRelative = relative ? `${relative}/${name}` : name;
      visit(path.join(current, name), childRelative);
    }
  };
  visit(root);
  return { sha256: hash.digest("hex"), entries };
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.platform !== "win32") fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
}

function readExistingMigration(dataRoot) {
  const incomplete = path.join(dataRoot, "migration-incomplete.json");
  if (fs.existsSync(incomplete)) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", "dataRoot contains a failed migration rollback marker; resolve it manually before retrying");
  }
  const pointer = path.join(dataRoot, MIGRATION_POINTER_FILE);
  if (!fs.existsSync(pointer)) return null;
  assertNoSymlinkPath(dataRoot, pointer, "migration pointer");
  const value = readJsonRequired(pointer, "migration pointer");
  if (value.status !== "complete" || !value.sourceId || !value.sourceRoot || !value.workspaceRoot || !value.targetDataRoot || !value.sourceFingerprint || !value.manifest) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", "dataRoot contains an incomplete or invalid migration pointer");
  }
  return value;
}

function verifyCompletedMigration({ source, target, items, auth, pointer }) {
  try {
    if (pointer.sourceId !== source.id
      || pointer.sourceRoot !== source.root
      || pointer.sourceFingerprint !== source.fingerprint
      || pointer.targetDataRoot !== target.dataRoot
      || pointer.workspaceRoot !== target.workspaceRoot
      || pointer.host !== target.host) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", "migration pointer identity does not match the requested source and roots");
    }
    const expectedManifest = path.posix.join(MIGRATION_DIR, `${source.id}.json`);
    if (pointer.manifest !== expectedManifest) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", "migration pointer does not reference its canonical migration record");
    }
    const recordPath = resolveRelativeInside(target.dataRoot, pointer.manifest, "migration record path");
    assertNoSymlinkPath(target.dataRoot, recordPath, "migration record");
    const record = readJsonRequired(recordPath, "migration record");
    if (record.status !== "complete"
      || record.sourceId !== source.id
      || record.sourceRoot !== source.root
      || record.sourceFingerprint !== source.fingerprint
      || record.targetDataRoot !== target.dataRoot
      || record.workspaceRoot !== target.workspaceRoot
      || record.host !== target.host
      || !Array.isArray(record.records)) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", "migration record identity or schema is invalid");
    }

    const records = new Map();
    for (const entry of record.records) {
      if (!entry?.name || records.has(entry.name)) {
        throw new MigrationError("QDM_MIGRATION_REQUIRED", "migration record contains duplicate or invalid entries");
      }
      records.set(entry.name, entry);
    }
    for (const expected of items) {
      if (expected.name === "migration-record" || expected.name === "migration-pointer") continue;
      const entry = records.get(expected.name);
      if (!entry) throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record is missing ${expected.name}`);
      if (entry.target !== expected.target) {
        throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record target changed for ${expected.name}`);
      }
      verifyMigrationRecord(entry, expected, target.dataRoot, auth);
    }

    const settingsPath = path.join(target.dataRoot, "config", "settings.json");
    const settings = readJsonRequired(settingsPath, "migrated settings");
    if (settings.dataRoot !== target.dataRoot
      || settings.stateRoot !== target.stateRoot
      || settings.migrationSourceId !== source.id
      || settings.pluginRoot !== (target.pluginRoot || "")
      || settings.legacyPluginRoot !== source.root) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", "migrated settings do not match the completed migration");
    }
    const installPath = path.join(target.dataRoot, "install-manifest.json");
    const install = readJsonRequired(installPath, "migrated install manifest");
    if (install.dataRoot !== target.dataRoot
      || install.stateRoot !== target.stateRoot
      || install.pluginRoot !== (target.pluginRoot || "")
      || install.legacyPluginRoot !== source.root
      || install.migratedFrom?.sourceId !== source.id
      || install.resourceVersion !== source.wikiContentVersion
      || install.metricCli?.path !== findItem({ items }, "metric-cli").target
      || install.metricCli?.platform !== target.platform) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", "migrated install manifest does not match the completed migration");
    }
    if (auth.secret && install.secret?.status !== "configured") {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", "migrated install manifest lost its secret reference");
    }
    if (!auth.secret && install.secret?.status !== "unconfigured") {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", "migrated install manifest has an unexpected secret reference");
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

function verifyMigrationRecord(record, expected, dataRoot, auth) {
  const isSecret = expected.name === "auth-secret";
  if (isSecret) {
    if (!auth.secret || record.target !== auth.secret.target || !isDirectory(auth.secret.secretRoot)) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", "migration secret record is invalid");
    }
    assertNoSymlinkPath(auth.secret.secretRoot, record.target, "migrated auth blob", "QDM_SECRET_UNAVAILABLE");
  } else {
    if (!isWithin(dataRoot, record.target)) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record target escapes dataRoot: ${record.name}`);
    }
    assertNoSymlinkPath(dataRoot, record.target, `migration record ${record.name}`);
  }
  if (record.sha256) {
    if ((expected.action === "copy" || expected.action === "copy-secret") && expected.sourceSha256 && record.sha256 !== expected.sourceSha256) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record source hash changed: ${record.name}`);
    }
    if ((expected.action === "copy" || expected.action === "copy-secret") && Number.isInteger(expected.bytes) && record.bytes !== expected.bytes) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record source size changed: ${record.name}`);
    }
    assertRegularFile(record.target, `migrated ${record.name}`, isSecret ? "QDM_SECRET_UNAVAILABLE" : "QDM_MIGRATION_REQUIRED");
    if (sha256File(record.target) !== record.sha256) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record hash mismatch: ${record.name}`);
    }
    if (Number.isInteger(record.bytes) && fs.statSync(record.target).size !== record.bytes) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record size mismatch: ${record.name}`);
    }
    return;
  }
  if (record.treeSha256) {
    if (expected.action === "copy" && expected.sourceTreeSha256 && record.treeSha256 !== expected.sourceTreeSha256) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record source tree changed: ${record.name}`);
    }
    if (expected.action === "copy" && Number.isInteger(expected.entries) && record.entries !== expected.entries) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record source entry count changed: ${record.name}`);
    }
    assertDirectory(record.target, `migrated ${record.name}`);
    const skip = record.name === "wikis" ? skipGitMetadata : (record.name === "legacy-state" ? skipStateLock : null);
    const digest = treeDigest(record.target, { skip });
    if (digest.sha256 !== record.treeSha256 || digest.entries !== record.entries) {
      throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record tree mismatch: ${record.name}`);
    }
    return;
  }
  throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration record lacks an integrity value: ${record.name}`);
}

function verifyMigrationSourceUnchanged(plan) {
  const legacy = inspectLegacyRuntime(plan.source.root);
  const metricCli = inspectMetricCli(plan.source.root, platformFromKey(plan.target.platform));
  const resource = inspectResources(plan.source.root);
  const auth = inspectLegacyAuth(plan.source.root, legacy.authz);
  if (!metricCli.ok) throw new MigrationError(metricCli.blocker.code, metricCli.blocker.message);
  if (!resource.ok) throw new MigrationError(resource.blocker.code, resource.blocker.message);
  if (auth.blocker) throw new MigrationError(auth.blocker.code, auth.blocker.message);
  const fingerprint = migrationSourceFingerprint({ legacy, metricCli, resource, auth });
  if (fingerprint !== plan.source.fingerprint) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", "legacy migration source changed after planning; rerun migrate --check before copying");
  }
}

function migrationSourceFingerprint({ legacy, metricCli, resource, auth }) {
  return sha256(JSON.stringify({
    manifest: legacy.manifestSha256,
    config: legacy.configSha256,
    metricCli: metricCli.ok ? metricCli.sha256 : "",
    wikis: resource.ok ? resource.wikisSha256 : "",
    index: resource.ok ? resource.indexSha256 : "",
    state: legacy.stateSha256,
    installerState: legacy.installerStateSha256,
    auth: auth.secret?.sha256 || auth.blocker?.code || "none",
  }));
}

function safeRuntimeVersion(value) {
  const candidate = String(value || "legacy").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate)) return candidate;
  return `legacy-${sha256(candidate || "legacy").slice(0, 12)}`;
}

function platformFromKey(value) {
  const os = String(value || "").split("-", 1)[0];
  if (os === "darwin") return "darwin";
  if (os === "linux") return "linux";
  if (os === "windows") return "win32";
  throw new MigrationError("QDM_CONTEXT_INVALID", `unsupported migration platform: ${value}`);
}

function publicInstallerState(value) {
  const selected = {};
  for (const key of ["schemaVersion", "agent", "runtimeTag", "wikisTag", "packageVersion", "releaseSource", "wikisMode", "toolInstallModes", "tools", "manifestSha256"]) {
    if (value?.[key] != null) selected[key] = value[key];
  }
  return selected;
}

function publicAuthz(authz) {
  if (!authz) return { mode: "off" };
  return {
    mode: authz.mode === "on" ? "on" : "off",
    devUserId: authz.devUserId || "",
    allowLocalBlob: authz.allowLocalBlob !== false,
  };
}

function item(name, source, target, action, extra) {
  return { name, source, target, action, ...extra };
}

function blocker(code, message) {
  return { code, message };
}

function findItem(plan, name) {
  const value = plan.items.find((item) => item.name === name);
  if (!value) throw new MigrationError("QDM_MIGRATION_REQUIRED", `migration plan is missing ${name}`);
  return value;
}

function findOptionalItem(plan, name) {
  return plan.items.find((item) => item.name === name) || null;
}

function firstBlockerCode(plan) {
  return plan.blockers[0]?.code || "QDM_MIGRATION_REQUIRED";
}

function firstBlockerMessage(plan) {
  return plan.blockers[0]?.message || "migration plan is blocked";
}

function canonicalExistingDirectory(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new MigrationError("QDM_CONTEXT_INVALID", `${label} is required`);
  if (!path.isAbsolute(text)) throw new MigrationError("QDM_CONTEXT_INVALID", `${label} must be an absolute path`);
  const resolved = path.resolve(text);
  assertNoSymlinkComponents(resolved, label, "QDM_CONTEXT_INVALID");
  if (!isDirectory(resolved)) throw new MigrationError("QDM_MIGRATION_REQUIRED", `${label} is unavailable: ${resolved}`);
  return fs.realpathSync.native(resolved);
}

function canonicalFutureDirectory(value, label) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!path.isAbsolute(text)) throw new MigrationError("QDM_CONTEXT_INVALID", `${label} must be an absolute path`);
  let current = path.resolve(text);
  assertNoSymlinkComponents(current, label, "QDM_CONTEXT_INVALID");
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  if (!fs.existsSync(current) || !isDirectory(current)) {
    throw new MigrationError("QDM_CONTEXT_INVALID", `${label} must resolve from an existing directory`);
  }
  const base = fs.realpathSync.native(current);
  return path.join(base, ...suffix);
}

function validateDistinctRoots({ sourceRoot, dataRoot, workspaceRoot, secretRoot, pluginRoot }) {
  const roots = [["legacy runtime", sourceRoot], ["dataRoot", dataRoot], ["workspaceRoot", workspaceRoot], ["secretRoot", secretRoot], ["pluginRoot", pluginRoot]].filter(([, value]) => value);
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (overlaps(roots[left][1], roots[right][1])) {
        throw new MigrationError("QDM_CONTEXT_INVALID", `${roots[left][0]} and ${roots[right][0]} must not overlap`);
      }
    }
  }
}

function validateMigrationPluginRoot(pluginRoot) {
  const manifestPath = path.join(pluginRoot, "bootstrap", "cli-manifest.json");
  const agentsPath = path.join(pluginRoot, "agents");
  assertNoSymlinkPath(pluginRoot, manifestPath, "migration plugin runtime manifest");
  assertNoSymlinkPath(pluginRoot, agentsPath, "migration plugin agents directory");
  assertRegularFile(manifestPath, "migration plugin runtime manifest");
  assertDirectory(agentsPath, "migration plugin agents directory");
  readJsonRequired(manifestPath, "migration plugin runtime manifest");
}

function resolveInside(root, relative, label) {
  const text = String(relative || "").trim();
  if (!text || path.isAbsolute(text)) throw new MigrationError("QDM_SECRET_UNAVAILABLE", `${label} must be a non-empty relative path`);
  const target = path.resolve(root, text);
  if (!isWithin(root, target)) throw new MigrationError("QDM_SECRET_UNAVAILABLE", `${label} escapes the legacy runtime`);
  assertNoSymlinkPath(root, target, label, "QDM_SECRET_UNAVAILABLE");
  return target;
}

function resolveRelativeInside(root, relative, label) {
  const text = String(relative || "").trim();
  if (!text || path.isAbsolute(text)) throw new MigrationError("QDM_MIGRATION_REQUIRED", `${label} must be a non-empty relative path`);
  const target = path.resolve(root, text);
  if (!isWithin(root, target)) throw new MigrationError("QDM_MIGRATION_REQUIRED", `${label} escapes dataRoot`);
  return target;
}

function stagePath(finalDataRoot, stagedDataRoot, targetPath) {
  const relative = path.relative(finalDataRoot, targetPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", "migration target escapes dataRoot");
  }
  return path.join(stagedDataRoot, relative);
}

function existingParent(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new MigrationError("QDM_DATA_ROOT_UNAVAILABLE", `cannot find parent for ${target}`);
    current = parent;
  }
  return current;
}

function assertWritable(directory, label) {
  try {
    fs.accessSync(directory, fs.constants.W_OK);
  } catch {
    throw new MigrationError("QDM_DATA_ROOT_UNAVAILABLE", `${label} is not writable: ${directory}`);
  }
}

function assertDirectory(directory, label, code = "QDM_MIGRATION_REQUIRED") {
  let info;
  try {
    info = fs.lstatSync(directory);
  } catch {
    throw new MigrationError(code, `${label} is missing: ${directory}`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new MigrationError(code, `${label} must be a directory and not a symbolic link`);
  }
}

function assertRegularFile(filePath, label, code = "QDM_MIGRATION_REQUIRED") {
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch {
    throw new MigrationError(code, `${label} is missing: ${filePath}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new MigrationError(code, `${label} must be a regular non-symlink file`);
  }
}

function assertNoSymlinkPath(root, target, label, code = "QDM_MIGRATION_REQUIRED") {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync.native(root);
  } catch {
    throw new MigrationError(code, `${label} cannot be resolved because its root is unavailable`);
  }
  const resolved = path.resolve(target);
  if (!isWithin(canonicalRoot, resolved)) {
    throw new MigrationError(code, `${label} escapes its permitted root`);
  }
  const relative = path.relative(canonicalRoot, resolved);
  let current = canonicalRoot;
  if (relative) {
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      let info;
      try {
        info = fs.lstatSync(current);
      } catch (error) {
        if (error?.code === "ENOENT") return resolved;
        throw new MigrationError(code, `${label} cannot be inspected: ${current}`);
      }
      if (info.isSymbolicLink()) {
        throw new MigrationError(code, `${label} contains a symbolic link: ${current}`);
      }
    }
  }
  const real = fs.realpathSync.native(resolved);
  if (!isWithin(canonicalRoot, real)) {
    throw new MigrationError(code, `${label} resolves outside its permitted root`);
  }
  return resolved;
}

function assertNoSymlinkComponents(value, label, code = "QDM_CONTEXT_INVALID") {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const remainder = resolved.slice(parsed.root.length);
  for (const part of remainder.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new MigrationError(code, `${label} cannot be inspected: ${current}`);
    }
    if (info.isSymbolicLink() && !isApprovedSystemPathSymlink(current)) {
      throw new MigrationError(code, `${label} must not contain symbolic-link path components: ${current}`);
    }
  }
}

function isApprovedSystemPathSymlink(value) {
  return process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(value);
}

function ensureDirectoryNoSymlinks(directory, label) {
  const requested = path.resolve(directory);
  const suffix = [];
  let current = requested;
  let info;
  while (true) {
    try {
      info = fs.lstatSync(current);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new MigrationError("QDM_SECRET_UNAVAILABLE", `${label} cannot be inspected: ${current}`);
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new MigrationError("QDM_SECRET_UNAVAILABLE", `${label} cannot be created: ${requested}`);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new MigrationError("QDM_SECRET_UNAVAILABLE", `${label} contains a non-directory or symbolic link: ${current}`);
  }
  let created = fs.realpathSync.native(current);
  for (const part of suffix) {
    created = path.join(created, part);
    try {
      fs.mkdirSync(created, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let createdInfo;
    try {
      createdInfo = fs.lstatSync(created);
    } catch {
      throw new MigrationError("QDM_SECRET_UNAVAILABLE", `${label} could not be verified after creation: ${created}`);
    }
    if (!createdInfo.isDirectory() || createdInfo.isSymbolicLink()) {
      throw new MigrationError("QDM_SECRET_UNAVAILABLE", `${label} contains a non-directory or symbolic link: ${created}`);
    }
  }
  return fs.realpathSync.native(created);
}

function readJsonRequired(filePath, label) {
  assertRegularFile(filePath, label);
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("must contain an object");
    return value;
  } catch (error) {
    throw new MigrationError("QDM_MIGRATION_REQUIRED", `${label} is invalid: ${error?.message || error}`);
  }
}

function directoryHasEntries(directory) {
  try {
    return fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function overlaps(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function skipGitMetadata(name) {
  return name === ".git";
}

function skipStateLock(name) {
  return name.endsWith(".lock");
}

function writeReport(report, options, io) {
  const output = io.stdout || process.stdout;
  if (options.json) {
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  output.write(`Migration ${report.mode}: ${report.ok ? "ready" : "blocked"}\n`);
  if (report.source?.root) output.write(`from: ${report.source.root}\n`);
  if (report.target?.dataRoot) output.write(`to: ${report.target.dataRoot}\n`);
  if (report.target?.workspaceRoot) output.write(`workspace: ${report.target.workspaceRoot}\n`);
  for (const entry of report.items || []) output.write(`- ${entry.name}: ${entry.action}\n`);
  for (const warning of report.warnings || []) output.write(`WARN ${warning}\n`);
  for (const issue of report.blockers || []) output.write(`BLOCK ${issue.code}: ${issue.message}\n`);
  if (report.idempotent) output.write("Migration already completed; no writes required.\n");
}
