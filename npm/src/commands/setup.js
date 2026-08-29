import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { packageVersion } from "../lib/package.js";
import { inspectLegacyRuntime } from "../lib/legacy-runtime.js";
import { binaryName, isExecutable, platformKey } from "../lib/platform.js";
import {
  ROOT_CONTEXT_ERROR_CODES,
  RootContextError,
  publicRootContext,
  resolveRootContext,
} from "../lib/root-context.js";

const INSTALL_MANIFEST_SCHEMA_VERSION = 1;

export function installManifestPath(context) {
  return path.join(context.dataRoot, "install-manifest.json");
}

export function settingsPath(context) {
  return context.configPath;
}

export function readInstallManifest(context) {
  const file = installManifestPath(context);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function setupCommand(options = {}, io = process) {
  const context = resolveRootContext(options, { env: io.env || process.env, requirePluginRoot: true });
  const report = await setupRootContext(context, { ...options, env: io.env || process.env });
  writeOutput(report, options, io);
  return report;
}

export async function setupRootContext(context, options = {}) {
  assertWritableParent(context.dataRoot);
  fs.mkdirSync(context.dataRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(context.configPath), { recursive: true, mode: 0o700 });
  if (context.secretRoot) fs.mkdirSync(context.secretRoot, { recursive: true, mode: 0o700 });

  const metricCli = await ensureMetricCli(context, options);
  const secret = inspectSecretReference(context);
  if (secret.status === "invalid") {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, secret.detail);
  }

  const prior = readInstallManifest(context) || {};
  const legacyMigration = inspectLegacyRuntime(options.legacyRuntime || options.legacyDir || options.env?.HARNESS_LEGACY_RUNTIME || process.env.HARNESS_LEGACY_RUNTIME || "");
  const now = new Date().toISOString();
  const manifest = {
    ...prior,
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    contextSchemaVersion: context.schemaVersion,
    host: context.host,
    pluginRoot: context.pluginRoot,
    dataRoot: context.dataRoot,
    stateRoot: context.stateRoot,
    configPath: context.configPath,
    installerVersion: packageVersion(),
    runtimeTag: prior.runtimeTag || discoverRuntimeTag(context.pluginRoot),
    pluginVersion: prior.pluginVersion || discoverPluginVersion(context.pluginRoot),
    resourceVersion: prior.resourceVersion || discoverResourceVersion(context.pluginRoot),
    metricCli,
    secret: { type: secret.type, status: secret.status },
    secretSourceType: secret.type,
    createdAt: prior.createdAt || now,
    updatedAt: now,
  };
  writeJsonAtomic(installManifestPath(context), manifest, 0o600);

  const settings = {
    schemaVersion: context.schemaVersion,
    host: context.host,
    pluginRoot: context.pluginRoot,
    dataRoot: context.dataRoot,
    stateRoot: context.stateRoot,
    metricCliPath: metricCli.path || "",
    secretRefType: secret.type,
    updatedAt: now,
  };
  writeJsonAtomic(context.configPath, settings, 0o600);

  return {
    ok: true,
    idempotent: Boolean(prior.updatedAt),
    context: publicRootContext(context),
    metricCli,
    secret: { type: secret.type, status: secret.status },
    manifestPath: installManifestPath(context),
    configPath: context.configPath,
    workspaceStatePath: context.workspaceRoot ? path.join(context.workspaceRoot, ".harness") : "",
    migration: legacyMigration.detected
      ? { status: "available", sourceRoot: legacyMigration.root, hint: legacyMigration.hint }
      : { status: "none" },
  };
}

export function inspectSecretReference(context) {
  const ref = context.secretRef;
  if (!ref) return { type: "none", status: "unconfigured", detail: "no secret reference configured" };
  if (ref.kind !== "file") return { type: ref.kind, status: "configured" };
  if (!fs.existsSync(ref.path)) return { type: "file", status: "invalid", detail: `secretRef.path does not exist: ${ref.path}` };
  let info;
  try {
    info = fs.lstatSync(ref.path);
  } catch (error) {
    return { type: "file", status: "invalid", detail: `cannot inspect secretRef.path: ${error?.message || error}` };
  }
  if (!info.isFile() || info.isSymbolicLink()) return { type: "file", status: "invalid", detail: "secretRef.path must be a regular file" };
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) return { type: "file", status: "invalid", detail: "secretRef.path permissions must be 0600" };
  return { type: "file", status: "configured" };
}

async function ensureMetricCli(context, options = {}) {
  const platform = platformKey();
  const destination = path.join(context.dataRoot, "runtimes", platform, binaryName("qdm-metric-cli"));
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });

  const explicit = options.metricCliPath || options.metricCli;
  const candidates = [
    explicit ? path.resolve(String(explicit)) : "",
    destination,
    path.join(context.pluginRoot, "bin", binaryName("qdm-metric-cli")),
    path.join(context.pluginRoot, "runtimes", platform, binaryName("qdm-metric-cli")),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!isExecutable(candidate)) continue;
    if (path.resolve(candidate) !== path.resolve(destination)) {
      fs.copyFileSync(candidate, destination);
      if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
    }
    return {
      path: destination,
      source: path.resolve(candidate),
      platform,
      sha256: fileSha256(destination),
      status: "ready",
    };
  }

  if (options.skipMetricCli === true) {
    return { path: "", source: "", platform, sha256: "", status: "skipped" };
  }

  if (options.downloadMetricCli === false) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, "qdm-metric-cli is unavailable; provide --metric-cli PATH or enable download");
  }

  const manifestPath = path.resolve(String(options.manifest || path.join(context.pluginRoot, "bootstrap", "cli-manifest.json")));
  if (!fs.existsSync(manifestPath)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, `qdm-metric-cli is unavailable and manifest is missing: ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (error) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, `cannot read CLI manifest: ${error?.message || error}`);
  }
  try {
    await installToolsFromManifest(path.join(context.dataRoot, "runtimes", platform), manifestPath, {
      manifestOverride: manifest,
      tools: ["qdm-metric-cli"],
      log: false,
    });
  } catch (error) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, `qdm-metric-cli download failed: ${error?.message || error}`);
  }
  const downloaded = path.join(context.dataRoot, "runtimes", platform, "bin", binaryName("qdm-metric-cli"));
  const fallback = path.join(context.dataRoot, "runtimes", platform, binaryName("qdm-metric-cli"));
  const installed = isExecutable(downloaded) ? downloaded : (isExecutable(fallback) ? fallback : "");
  if (!installed) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, "qdm-metric-cli download completed without an executable");
  if (path.resolve(installed) !== path.resolve(destination)) {
    fs.copyFileSync(installed, destination);
    if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
  }
  return {
    path: destination,
    source: installed,
    platform,
    sha256: fileSha256(destination),
    manifestSha256: manifestDigest(manifest),
    status: "ready",
  };
}

function assertWritableParent(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.DATA_ROOT_UNAVAILABLE, `cannot find parent for dataRoot: ${target}`);
    current = parent;
  }
  try {
    fs.accessSync(current, fs.constants.W_OK);
  } catch {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.DATA_ROOT_UNAVAILABLE, `dataRoot parent is not writable: ${current}`);
  }
}

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJsonAtomic(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.platform !== "win32") fs.chmodSync(temp, mode);
  fs.renameSync(temp, filePath);
}

function writeOutput(report, options, io) {
  const text = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : [
      `Harness Data setup: ${report.context.host}`,
      `dataRoot: ${report.context.dataRoot}`,
      `metric-cli: ${report.metricCli.status}${report.metricCli.path ? ` (${report.metricCli.path})` : ""}`,
      `secret: ${report.secret.type} (${report.secret.status})`,
      `install manifest: ${report.manifestPath}`,
      ...(report.migration?.status === "available" ? [`migration: ${report.migration.hint}`] : []),
    ].join("\n") + "\n";
  (io.stdout || process.stdout).write(text);
}

function discoverRuntimeTag(pluginRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(pluginRoot, "bootstrap", "cli-manifest.json"), "utf8"));
    return String(value.releaseTag || value.version || "");
  } catch {
    return "";
  }
}

function discoverPluginVersion(pluginRoot) {
  for (const candidate of [
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    path.join(pluginRoot, "agents", "codex", ".codex-plugin", "plugin.json"),
    path.join(pluginRoot, "agents", "workbuddy", ".codebuddy-plugin", "plugin.json"),
  ]) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (value?.version) return String(value.version);
    } catch {
      // optional host manifest
    }
  }
  return "";
}

function discoverResourceVersion(pluginRoot) {
  for (const candidate of [
    path.join(pluginRoot, ".harness", "index", "wikis-runtime-index.json"),
    path.join(pluginRoot, ".harness", "index", "wikis-index.json"),
  ]) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const version = value?.meta?.resourceVersion || value?.meta?.contentVersion || value?.meta?.version;
      if (version) return String(version);
    } catch {
      // optional resource metadata
    }
  }
  return "";
}
