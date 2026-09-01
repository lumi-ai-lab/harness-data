import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installToolsFromManifest, manifestDigest, readManifest } from "../lib/manifest.js";
import { packageVersion } from "../lib/package.js";
import { inspectLegacyRuntime } from "../lib/legacy-runtime.js";
import { binaryName, isExecutable, platformKey } from "../lib/platform.js";
import { run } from "../lib/exec.js";
import { ask, askSecret } from "../lib/prompt.js";
import { downloadReleaseAsset, resolveLatestRelease, resolveReleaseSource } from "../lib/release-source.js";
import { resolveLatestManifest } from "../lib/tool-release.js";
import { collectReleaseArchivePassword, releaseArchivePassword } from "../lib/release-password.js";
import {
  ROOT_CONTEXT_ERROR_CODES,
  RootContextError,
  publicRootContext,
  resolveRootContext,
} from "../lib/root-context.js";
import {
  applyCodexPluginScope,
  ensureWorkspaceDirectory,
  resolveCodexHome,
  resolveCodexPluginSelector,
} from "../lib/codex-plugin-scope.js";

const INSTALL_MANIFEST_SCHEMA_VERSION = 1;

export function isCodexPluginLayout(context) {
  const pluginRoot = String(context?.pluginRoot || "").trim();
  const resourceRoot = String(context?.resourceRoot || "").trim();
  return String(context?.host || "").toLowerCase() === "codex" &&
    Boolean(pluginRoot && resourceRoot) &&
    path.resolve(pluginRoot) === path.resolve(resourceRoot);
}

/**
 * Hosts whose setup owns a writable plugin-style layout (resources, config,
 * runtimes, index and manifests) instead of the legacy dataRoot layout.
 */
export function isPluginLayout(context) {
  return isCodexPluginLayout(context) || String(context?.host || "").toLowerCase() === "qwenpaw";
}

/**
 * The writable root that owns plugin-style resources for the current host.
 * Codex keeps them inside pluginRoot; QwenPaw keeps them inside resourceRoot
 * because the host plugin directory (artifactRoot) is replaced on upgrade.
 * Legacy installs keep everything under dataRoot.
 */
export function pluginLayoutRoot(context) {
  if (String(context?.host || "").toLowerCase() === "qwenpaw") return context.resourceRoot;
  if (isCodexPluginLayout(context)) return context.pluginRoot;
  return context.dataRoot;
}

function assertCodexPluginLayout(context) {
  if (String(context?.host || "").toLowerCase() !== "codex") return false;
  const pluginRoot = path.resolve(String(context.pluginRoot || ""));
  const expectedResourceRoot = pluginRoot;
  const expectedConfigPath = path.join(pluginRoot, "config", "settings.json");
  const expectedSecretRoot = path.join(pluginRoot, "secrets");
  const expectedWorkspacePolicyPath = path.join(pluginRoot, "config", "workspace-policy.json");
  if (path.resolve(String(context.resourceRoot || "")) !== expectedResourceRoot) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `Codex Plugin setup requires resourceRoot ${expectedResourceRoot}; got ${context.resourceRoot || "(missing)"}`);
  }
  if (path.resolve(String(context.configPath || "")) !== expectedConfigPath) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `Codex Plugin setup requires configPath ${expectedConfigPath}; got ${context.configPath || "(missing)"}`);
  }
  if (path.resolve(String(context.secretRoot || "")) !== expectedSecretRoot) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `Codex Plugin setup requires secretRoot ${expectedSecretRoot}; got ${context.secretRoot || "(missing)"}`);
  }
  if (path.resolve(String(context.workspacePolicyPath || "")) !== expectedWorkspacePolicyPath) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `Codex Plugin setup requires workspacePolicyPath ${expectedWorkspacePolicyPath}; got ${context.workspacePolicyPath || "(missing)"}`);
  }
  return true;
}

export function installManifestPath(context) {
  return path.join(pluginLayoutRoot(context), "install-manifest.json");
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
  const env = io.env || process.env;
  const contextOptions = { ...options };
  delete contextOptions.secretRef;
  const contextEnv = { ...env };
  delete contextEnv.HARNESS_SECRET_REF;
  const context = resolveRootContext(contextOptions, { env: contextEnv, requirePluginRoot: true });
  const report = await setupRootContext(context, { ...options, env });
  writeOutput(report, options, io);
  return report;
}

async function prepareSetupSecret(context, options = {}) {
  if (options.noAuth === true || options.channelAuthOnly === true) return null;
  const secretRoot = context.secretRoot;
  if (!secretRoot) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "secretRoot is required for persisted setup");
  }
  const env = options.env || process.env;
  const target = path.join(secretRoot, "auth.blob");
  let blob = "";
  const sourceFile = options.authBlobFile || env.HARNESS_AUTH_BLOB_FILE || "";
  if (sourceFile) blob = readAuthBlobFile(sourceFile);

  const sourceRef = options.secretRef || env.HARNESS_SECRET_REF || context.secretRef || "";
  if (!blob && sourceRef) {
    const parsed = typeof sourceRef === "object" ? sourceRef : String(sourceRef).trim().startsWith("{")
      ? JSON.parse(String(sourceRef))
      : { kind: "file", path: String(sourceRef) };
    if (String(parsed.kind || "file").toLowerCase() !== "file") {
      throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "persisted setup requires a file secretRef pointing to an auth.blob file");
    }
    blob = readAuthBlobFile(parsed.path);
  }

  if (!blob) {
    const inline = String(options.authBlob || env.HARNESS_AUTH_BLOB || "").trim();
    if (inline) blob = inline;
  }
  if (!blob && fs.existsSync(target)) blob = readAuthBlobFile(target);
  if (!blob) {
    if (options.yes || options.noAuthPrompt) {
      throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "auth.blob is required; use --auth-blob-file, --auth-blob, or interactive setup");
    }
    blob = String(await askSecret("请输入 QDM auth.blob（qdm1enc...）：", options)).trim();
  }
  if (!/^qdm1enc\.[A-Za-z0-9_-]+$/.test(blob)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "auth.blob must contain an encrypted qdm1enc blob");
  }
  fs.mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, `${blob}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  return { kind: "file", path: path.resolve(target) };
}

function readAuthBlobFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  let info;
  try {
    info = fs.lstatSync(resolved);
  } catch (error) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, `auth.blob file is unavailable: ${resolved}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, `auth.blob file must be a regular file: ${resolved}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, `auth.blob file permissions must be 0600: ${resolved}`);
  }
  const blob = fs.readFileSync(resolved, "utf8").trim();
  if (!blob) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, `auth.blob file is empty: ${resolved}`);
  return blob;
}

export async function setupRootContext(context, options = {}) {
  assertCodexPluginLayout(context);
  if (options.channelAuthOnly === true && String(context.host || "").toLowerCase() !== "qwenpaw") {
    throw new RootContextError(
      ROOT_CONTEXT_ERROR_CODES.INVALID,
      "--channel-auth-only is only supported for host=qwenpaw (channel authorization via channel-auth.json)",
    );
  }
  const snapshot = createSetupSnapshot(context);
  try {
    const preparedSecret = await prepareSetupSecret(context, options);
    const effectiveContext = preparedSecret
      ? {
        ...context,
        secretRef: preparedSecret,
        capabilities: { ...context.capabilities, supportsSecretReference: true },
      }
      : context;
    const report = await setupRootContextInner(effectiveContext, options);
    snapshot.commit();
    return report;
  } catch (error) {
    snapshot.rollback();
    throw error;
  }
}

async function setupRootContextInner(context, options = {}) {
  const layoutRoot = pluginLayoutRoot(context);
  const expectedConfigPath = path.join(layoutRoot, "config", "settings.json");
  if (path.resolve(context.configPath) !== path.resolve(expectedConfigPath)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `Plugin setup requires configPath ${expectedConfigPath}`);
  }
  const secret = inspectSecretReference(context);
  // --channel-auth-only (host=qwenpaw) keeps authz enabled but authorizes via
  // channel-auth.json at runtime, so the auth.blob file contract does not apply.
  const authzBlobRequired = options.noAuth !== true && options.channelAuthOnly !== true;
  if (authzBlobRequired && context.secretRef?.kind !== "file") {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "persisted setup requires a file secretRef");
  }
  if (secret.status === "invalid" || (authzBlobRequired && secret.status !== "configured")) {
    throw new RootContextError(
      ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE,
      secret.detail || "a valid --secret-ref is required unless --no-auth is explicit",
    );
  }
  const authUserId = await resolveAuthUserId(context, options);
  const workspacePlan = await resolveSetupWorkspaceRoots(context, options);

  const writableRoot = layoutRoot;
  assertWritableParent(writableRoot);
  fs.mkdirSync(writableRoot, { recursive: true, mode: 0o700 });
  if (isPluginLayout(context)) fs.mkdirSync(context.dataRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(context.configPath), { recursive: true, mode: 0o700 });
  if (context.secretRoot) fs.mkdirSync(context.secretRoot, { recursive: true, mode: 0o700 });

  const metricCli = await ensureMetricCli(context, options);
  if (metricCli.status !== "ready") {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, "qdm-metric-cli is required for a usable setup");
  }
  const wikis = await ensureWikis(context, options);
  if (!["synced", "exists", "embedded"].includes(wikis.status)) {
    throw new RootContextError(
      ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED,
      wikis.error || "Wikis are required for a usable setup",
    );
  }
  // The index builder reads config/harness-config.yaml to resolve the embedded
  // resources/wikis tree, so write that mapping before building the index.
  writeHarnessConfigYaml(context, metricCli, { mode: options.noAuth ? "off" : "on", userId: authUserId });
  const index = await buildWikisIndex(context, options);
  const resourceManifestPath = path.join(context.resourceRoot, "resource-manifest.json");
  if (!index.ok || !fs.existsSync(index.indexPath || "") || !fs.existsSync(resourceManifestPath)) {
    throw new RootContextError(
      ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED,
      index.reason || "Wikis index/resource manifest was not created",
    );
  }
  index.resourceManifestPath = resourceManifestPath;

  const prior = readInstallManifest(context) || {};
  const legacyMigration = inspectLegacyRuntime(options.legacyRuntime || options.legacyDir || options.env?.HARNESS_LEGACY_RUNTIME || process.env.HARNESS_LEGACY_RUNTIME || "");
  const now = new Date().toISOString();
  const manifest = {
    ...prior,
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    contextSchemaVersion: context.schemaVersion,
    host: context.host,
    pluginRoot: context.pluginRoot,
    resourceRoot: context.resourceRoot,
    dataRoot: context.dataRoot,
    secretRoot: context.secretRoot,
    stateRoot: context.stateRoot,
    configPath: context.configPath,
    workspacePolicyPath: context.workspacePolicyPath,
    installerVersion: packageVersion(),
    runtimeTag: discoverRuntimeTag(context.pluginRoot) || prior.runtimeTag || "",
    pluginVersion: discoverPluginVersion(context.pluginRoot) || prior.pluginVersion || "",
    resourceVersion: discoverResourceVersion(context.resourceRoot) || prior.resourceVersion || "",
    metricCli,
    secret: { type: secret.type, status: secret.status },
    secretSourceType: secret.type,
    createdAt: prior.createdAt || now,
    updatedAt: now,
  };
  const previousWorkspaces = readPreviousEnabledWorkspaces(context, prior);
  const workspacePolicy = writeWorkspacePolicy(context, options, workspacePlan);
  const pluginScope = writeCodexPluginScope(context, options, {
    roots: workspacePolicy.roots,
    previousRoots: previousWorkspaces,
  });
  if (pluginScope.status !== "skipped") {
    manifest.codexPluginScope = {
      selector: pluginScope.selector,
      userConfigPath: pluginScope.userConfigPath,
      workspaces: pluginScope.enabled,
    };
  }
  writeJsonAtomic(installManifestPath(context), manifest, 0o600);

  const settings = {
    schemaVersion: context.schemaVersion,
    host: context.host,
    pluginRoot: context.pluginRoot,
    resourceRoot: context.resourceRoot,
    dataRoot: context.dataRoot,
    secretRoot: context.secretRoot,
    stateRoot: context.stateRoot,
    workspacePolicyPath: context.workspacePolicyPath,
    metricCliPath: metricCli.path || "",
    authz: {
      mode: options.noAuth === true ? "off" : "on",
      userId: authUserId,
    },
    secretRef: options.noAuth === true || options.channelAuthOnly === true ? null : context.secretRef,
    secretRefType: secret.type,
    updatedAt: now,
  };
  writeJsonAtomic(context.configPath, settings, 0o600);
  const persistedContextPath = writePersistedContext(context, options);

  return {
    ok: true,
    idempotent: Boolean(prior.updatedAt),
    context: publicRootContext(context),
    metricCli,
    secret: { type: secret.type, status: secret.status },
    wikis,
    index,
    manifestPath: installManifestPath(context),
    configPath: context.configPath,
    workspacePolicy,
    pluginScope,
    persistedContextPath,
    workspaceStatePath: "",
    migration: legacyMigration.detected
      ? { status: "available", sourceRoot: legacyMigration.root, hint: legacyMigration.hint }
      : { status: "none" },
  };
}

async function resolveAuthUserId(context, options = {}) {
  if (options.noAuth === true || options.channelAuthOnly === true) return "";
  const env = options.env || process.env;
  const supplied = String(options.authUserId || env.HARNESS_AUTH_USER_ID || "").trim();
  if (supplied) return supplied;

  const existing = readPersistedAuthUserId(context.configPath);
  if (existing) return existing;

  if (options.yes || options.noAuthPrompt || (!process.stdin.isTTY && options.interactivePrompt !== true)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "--auth-user-id or HARNESS_AUTH_USER_ID is required when authz is on");
  }
  const prompted = String(await ask("请输入 QDM_AUTH_USER_ID：", options)).trim();
  if (!prompted) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "QDM_AUTH_USER_ID cannot be empty when authz is on");
  }
  return prompted;
}

function readPersistedAuthUserId(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return "";
  try {
    const settings = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return String(settings?.authz?.userId || "").trim();
  } catch {
    return "";
  }
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
  try {
    if (!fs.readFileSync(ref.path, "utf8").trim().startsWith("qdm1enc.")) {
      return { type: "file", status: "invalid", detail: "secretRef.path must contain an encrypted qdm1enc blob" };
    }
  } catch (error) {
    return { type: "file", status: "invalid", detail: `cannot read secretRef.path: ${error?.message || error}` };
  }
  return { type: "file", status: "configured" };
}

async function resolveLatestManifestForSetup(manifest, platform, options = {}) {
  const resolver = options._resolveLatestManifest || resolveLatestManifest;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await resolver(manifest, platform, options);
    } catch (error) {
      if (options.yes || options.noReleaseCredentialPrompt) throw error;
      const env = options.env || process.env;
      const message = String(error?.message || error);
      if (!options.giteeToken && !env.GITEE_TOKEN && /Gitee[^;]*(?:401|403|404|unauthorized|forbidden|not found)/i.test(message)) {
        options.giteeToken = String(await askSecret("请输入 Gitee Release Token：", options)).trim();
        continue;
      }
      if (!options.githubToken && !env.GITHUB_TOKEN && /GitHub[^;]*(?:401|403|404|unauthorized|forbidden|requires gh auth|not found)/i.test(message)) {
        options.githubToken = String(await askSecret("请输入 GitHub Release Token：", options)).trim();
        continue;
      }
      throw error;
    }
  }
  throw new Error("Release lookup exceeded credential retry limit");
}

export async function ensureMetricCli(context, options = {}) {
  const platform = platformKey();
  const root = pluginLayoutRoot(context);
  const destination = path.join(root, "runtimes", platform, binaryName("qdm-metric-cli"));
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
  let latestManifest;
  try {
    latestManifest = await resolveLatestManifestForSetup(manifest, platform, options);
  } catch (error) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, `qdm-metric-cli Release lookup failed: ${error?.message || error}`);
  }
  const installRoot = path.join(root, "runtimes", platform);
  const metricTool = (latestManifest.tools || []).find((tool) => tool?.name === "qdm-metric-cli");
  if (!metricTool) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, `qdm-metric-cli is not declared in ${manifestPath}`);
  }
  let archivePassword;
  try {
    archivePassword = await collectReleaseArchivePassword(options);
    options._releaseArchivePassword = archivePassword;
  } catch (error) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, error?.message || String(error));
  }

  let selectedManifest = latestManifest;
  let installError = null;
  const providerFailures = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const selectedTool = (selectedManifest.tools || []).find((tool) => tool?.name === "qdm-metric-cli");
    const selectedSource = releaseSourceForTool(selectedTool, platform);
    try {
      const installer = options._installToolsFromManifest || installToolsFromManifest;
      await installer(installRoot, manifestPath, {
        ...options,
        _releaseArchivePassword: archivePassword,
        manifestOverride: selectedManifest,
        tools: ["qdm-metric-cli"],
        log: false,
      });
      installError = null;
      latestManifest = selectedManifest;
      break;
    } catch (error) {
      installError = error;
      const message = error?.message || String(error);
      providerFailures.push(`${releaseSourceLabel(selectedSource)}: ${message}`);
      cleanupMetricCliInstall(installRoot);

      const credentialSource = releaseCredentialSource(selectedSource, error);
      if (credentialSource && await promptReleaseCredential(credentialSource, options)) continue;

      if (selectedSource === "gitee" && isAutomaticReleaseSource(options) && !isArchiveExtractionFailure(error)) {
        const fallbackOptions = { ...options, releaseSource: "github" };
        try {
          selectedManifest = await resolveLatestManifestForSetup(manifest, platform, fallbackOptions);
          copyReleaseCredentials(options, fallbackOptions);
          continue;
        } catch (fallbackError) {
          copyReleaseCredentials(options, fallbackOptions);
          installError = fallbackError;
          providerFailures.push(`GitHub: ${fallbackError?.message || fallbackError}`);
        }
      }
      break;
    }
  }
  if (installError) {
    throw new RootContextError(
      ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED,
      `qdm-metric-cli download failed: ${providerFailures.join("; ") || installError.message || installError}`,
    );
  }
  const downloaded = path.join(installRoot, "bin", binaryName("qdm-metric-cli"));
  const fallback = path.join(installRoot, binaryName("qdm-metric-cli"));
  const installed = isExecutable(downloaded) ? downloaded : (isExecutable(fallback) ? fallback : "");
  if (!installed) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED, "qdm-metric-cli download completed without an executable");
  if (path.resolve(installed) !== path.resolve(destination)) {
    fs.copyFileSync(installed, destination);
    if (process.platform !== "win32") fs.chmodSync(destination, 0o755);
  }
  fs.rmSync(path.join(installRoot, "bin"), { recursive: true, force: true });
  fs.rmSync(path.join(installRoot, ".bootstrap-cache"), { recursive: true, force: true });
  const installedTool = (latestManifest.tools || []).find((tool) => tool?.name === "qdm-metric-cli");
  const releaseUrl = installedTool?.platforms?.[platform]?.url || "";
  return {
    path: destination,
    source: releaseUrl || installed,
    platform,
    sha256: fileSha256(destination),
    manifestSha256: manifestDigest(latestManifest),
    status: "ready",
  };
}

function releaseSourceForTool(tool, platform) {
  const declared = String(tool?.platforms?.[platform]?.releaseSource || "").trim().toLowerCase();
  if (declared === "gitee" || declared === "github") return declared;
  const url = String(tool?.platforms?.[platform]?.url || "").toLowerCase();
  if (url.includes("gitee.com")) return "gitee";
  if (url.includes("github.com")) return "github";
  return "unknown";
}

function releaseSourceLabel(source) {
  if (source === "gitee") return "Gitee";
  if (source === "github") return "GitHub";
  return "Release";
}

function isAutomaticReleaseSource(options = {}) {
  try {
    return resolveReleaseSource(options) === "auto";
  } catch {
    return false;
  }
}

function releaseCredentialSource(source, error) {
  const message = String(error?.message || error);
  if (source === "gitee" && /401|403|404|unauthorized|forbidden|token/i.test(message)) return "gitee";
  if (source === "github" && /401|403|404|unauthorized|forbidden|private GitHub Release asset requires|gh auth/i.test(message)) return "github";
  return "";
}

async function promptReleaseCredential(source, options = {}) {
  if (options.yes || options.noReleaseCredentialPrompt) return false;
  const env = options.env || process.env;
  if (source === "gitee") {
    if (options.giteeToken || env.GITEE_TOKEN) return false;
    const token = String(await askSecret("请输入 Gitee Release Token：", options)).trim();
    if (!token) return false;
    options.giteeToken = token;
    return true;
  }
  if (source === "github") {
    if (options.githubToken || env.GITHUB_TOKEN) return false;
    const token = String(await askSecret("请输入 GitHub Release Token：", options)).trim();
    if (!token) return false;
    options.githubToken = token;
    return true;
  }
  return false;
}

function copyReleaseCredentials(target, source) {
  for (const name of ["giteeToken", "githubToken"]) {
    if (source?.[name] && !target?.[name]) target[name] = source[name];
  }
}

function isArchiveExtractionFailure(error) {
  return /\b(?:unzip|tar)\b.*(?:failed|error)|(?:archive|password).*?(?:failed|invalid|incorrect)|not extracted/i.test(
    String(error?.message || error),
  );
}

function cleanupMetricCliInstall(installRoot) {
  fs.rmSync(path.join(installRoot, "bin"), { recursive: true, force: true });
  fs.rmSync(path.join(installRoot, ".bootstrap-cache"), { recursive: true, force: true });
}

const WIKIS_REPO = "lumi-ai-lab/harness-data";
const WIKIS_ASSET_PREFIX = "harness-data-wikis-";

export async function ensureWikis(context, options = {}) {
  const layout = isPluginLayout(context);
  const target = layout
    ? path.join(pluginLayoutRoot(context), "resources", "wikis")
    : path.join(context.dataRoot, "wikis");
  if (options.skipWikis === true) return { status: "skipped", mode: layout ? "plugin" : "legacy", path: target };

  const bundledSources = [
    path.join(context.pluginRoot, "resources", "wikis"),
    path.join(context.pluginRoot, "wikis"),
  ];
  const bundledSource = bundledSources.find((candidate) => isWikisRoot(candidate)) || "";

  if (!options.force && isWikisRoot(target) && !options.wikisSource) {
    try {
      validateWikisSource(target);
      return { status: layout ? "embedded" : "exists", mode: bundledSource === target ? "bundled" : "exists", path: target };
    } catch (error) {
      return { status: "failed", error: error?.message || String(error), path: target };
    }
  }

  const selectedSource = options.wikisSource || (bundledSource && path.resolve(bundledSource) !== path.resolve(target) ? bundledSource : "");
  if (selectedSource) {
    try {
      const source = path.resolve(String(selectedSource));
      validateWikisSource(source);
      if (path.resolve(source) !== path.resolve(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.cpSync(source, target, { recursive: true });
      }
      validateWikisSource(target);
      return { status: "synced", mode: options.wikisSource ? "local" : "bundled", source, path: target };
    } catch (error) {
      return { status: "failed", error: error?.message || String(error), path: target };
    }
  }

  try {
    const resolved = await (options._resolveLatestRelease || resolveLatestRelease)(
      WIKIS_REPO,
      (tag) => [WIKIS_ASSET_PREFIX + tag + ".zip"],
      options,
    );
    const { tag, asset } = resolved;
    const cacheRoot = layout ? pluginLayoutRoot(context) : context.dataRoot;
    const cacheDir = path.join(cacheRoot, ".bootstrap-cache");
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const archive = path.join(cacheDir, asset.name || `${WIKIS_ASSET_PREFIX}${tag}.zip`);
    await (options._downloadReleaseAsset || downloadReleaseAsset)(asset, archive, { ...options, progressLabel: asset.name || path.basename(archive) });
    if (!options._releaseArchivePassword) {
      options._releaseArchivePassword = await collectReleaseArchivePassword(options);
    }
    const extractDir = fs.mkdtempSync(path.join(cacheDir, "wikis-"));
    await extractWikisArchive(archive, extractDir, options);
    const unpacked = findWikisRoot(extractDir) || extractDir;
    validateWikisSource(unpacked);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.renameSync(unpacked, target);
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    return { status: "synced", mode: "release", tag, path: target };
  } catch (error) {
    return { status: "failed", error: error?.message || String(error), path: target };
  }
}

async function extractWikisArchive(archive, dest, options) {
  if (typeof options._extractArchive === "function") {
    await options._extractArchive(archive, dest, options);
    return;
  }
  const password = releaseArchivePassword(options);
  await run("unzip", ["-P", password, "-o", archive, "-d", dest], { cwd: path.dirname(dest), sensitiveArgs: [1] });
}

function isWikisRoot(source) {
  return Boolean(source) && fs.existsSync(path.join(source, "index.md"));
}

function findWikisRoot(root) {
  if (isWikisRoot(root)) return root;
  try {
    for (const name of fs.readdirSync(root)) {
      const child = path.join(root, name);
      if (fs.statSync(child).isDirectory() && isWikisRoot(child)) return child;
    }
  } catch {
    return "";
  }
  return "";
}

function validateWikisSource(source) {
  if (!fs.existsSync(path.join(source, "index.md"))) throw new Error(`wikis source missing index.md: ${source}`);
  for (const dir of ["metrics", "reports", "dims", "rules"]) {
    if (!fs.existsSync(path.join(source, dir))) throw new Error(`wikis source missing ${dir}/: ${source}`);
  }
}

function writeHarnessConfigYaml(context, metricCli, authz = {}) {
  const configDir = path.dirname(context.configPath);
  const filePath = path.join(configDir, "harness-config.yaml");
  const content = [
    "# Harness Data configuration generated by setup.",
    "paths:",
    `  knowledge: ${isPluginLayout(context) ? "resources/wikis" : "wikis"}`,
    "cli:",
    `  qdm_metric_cli: ${metricCli.path || ""}`,
    "authz:",
    `  mode: ${authz.mode === "off" ? "off" : "on"}`,
    `  dev_user_id: ${authz.userId || ""}`,
    "  allow_local_blob: true",
    "",
  ].join("\n");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, filePath);
}

export async function resolveSetupWorkspaceRoots(context, options = {}) {
  if (!context.workspacePolicyPath) return { roots: [], reuseExisting: false };
  const explicit = explicitWorkspacePolicyValues(options, context);
  if (explicit.length) {
    return {
      roots: uniqueCanonicalWorkspaceRoots(explicit, context, options),
      reuseExisting: false,
    };
  }
  if (options.force !== true) {
    const existing = readExistingPolicyRoots(context);
    if (existing.length) return { roots: existing, reuseExisting: true };
  }
  if (options.useCurrentWorkspace !== false) {
    for (const candidate of currentWorkspaceCandidates(options)) {
      const canonical = tryCanonicalWorkspaceRoot(candidate, context, options);
      if (canonical) return { roots: [canonical], reuseExisting: false };
    }
  }
  if (canPromptWorkspace(options)) {
    const prompted = String(await (options._ask || ask)("请输入要启用插件的项目目录：", options)).trim();
    if (!prompted) throw missingWorkspaceAllowlistError();
    return {
      roots: [canonicalWorkspaceRoot(prompted, context, options)],
      reuseExisting: false,
    };
  }
  throw missingWorkspaceAllowlistError(currentWorkspaceCandidates(options)[0] || "");
}

function writeWorkspacePolicy(context, options = {}, plan = null) {
  if (!context.workspacePolicyPath) return { status: "skipped", path: "", roots: [] };
  const policyPath = context.workspacePolicyPath;
  const resolved = plan || { roots: [], reuseExisting: false };
  if (resolved.reuseExisting) {
    return { status: "exists", path: policyPath, roots: resolved.roots };
  }
  const policy = {
    schemaVersion: 1,
    mode: "allowlist",
    includeChildren: options.workspaceAllowChildren !== false,
    roots: [...new Set(resolved.roots)].sort(),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(policyPath, policy, 0o600);
  return { status: "written", path: policyPath, roots: policy.roots, includeChildren: policy.includeChildren };
}

function explicitWorkspacePolicyValues(options, context) {
  const raw = [];
  for (const value of [options.workspaceAllowlist, options.allowedWorkspace, options.enableWorkspace, options.workspaceRoot, context.workspaceRoot, options.env?.HARNESS_WORKSPACE_ALLOWLIST, options.env?.HARNESS_ALLOWED_WORKSPACES, options.env?.HARNESS_WORKSPACE_ROOT, options.env?.CODEX_WORKSPACE_ROOT]) {
    if (Array.isArray(value)) raw.push(...value);
    else if (value != null && String(value).trim()) raw.push(...String(value).split(/[\n,;]+/));
  }
  return [...new Set(raw.map((value) => String(value).trim()).filter(Boolean))];
}

function currentWorkspaceCandidates(options = {}) {
  const env = options.env || process.env;
  const pwd = String(env.PWD || "").trim();
  if (pwd) return [pwd];
  const cwd = String(options.cwd || process.cwd() || "").trim();
  return cwd ? [cwd] : [];
}

function uniqueCanonicalWorkspaceRoots(values, context, options) {
  return [...new Set(values.map((value) => canonicalWorkspaceRoot(value, context, options)))];
}

function tryCanonicalWorkspaceRoot(value, context, options) {
  try {
    return canonicalWorkspaceRoot(value, context, options);
  } catch (error) {
    if (error instanceof RootContextError && error.code === ROOT_CONTEXT_ERROR_CODES.INVALID) return "";
    throw error;
  }
}

function readExistingPolicyRoots(context) {
  try {
    const existing = JSON.parse(fs.readFileSync(context.workspacePolicyPath, "utf8"));
    if (!Array.isArray(existing?.roots)) return [];
    return existing.roots.map((value) => path.resolve(String(value))).filter(Boolean);
  } catch {
    return [];
  }
}

function canPromptWorkspace(options = {}) {
  if (options.yes || options.noAuthPrompt) return false;
  return Boolean(process.stdin.isTTY || options.interactivePrompt === true);
}

function missingWorkspaceAllowlistError(currentDir = "") {
  const suffix = currentDir ? ` (current directory ${currentDir} is not a valid project root)` : "";
  return new RootContextError(
    ROOT_CONTEXT_ERROR_CODES.INVALID,
    `pass --workspace-allowlist /path/to/your/project; do not enable the plugin inside the Codex plugin cache or dataRoot${suffix}`,
  );
}

function canonicalWorkspaceRoot(value, context, options = {}) {
  return ensureWorkspaceDirectory(value, {
    pluginRoot: context.pluginRoot,
    dataRoot: context.dataRoot,
    codexHome: resolveCodexHome(options.env || process.env),
  });
}

function readPreviousEnabledWorkspaces(context, prior) {
  const fromManifest = prior?.codexPluginScope?.workspaces;
  if (Array.isArray(fromManifest) && fromManifest.length) {
    return fromManifest.map((value) => path.resolve(String(value)));
  }
  try {
    const existing = JSON.parse(fs.readFileSync(context.workspacePolicyPath, "utf8"));
    if (Array.isArray(existing?.roots)) return existing.roots.map((value) => path.resolve(String(value)));
  } catch {
    // First setup has no previous project-enable list.
  }
  return [];
}

function writeCodexPluginScope(context, options, { roots = [], previousRoots = [] } = {}) {
  if (String(context.host || "").toLowerCase() !== "codex") {
    return { status: "skipped", selector: "", userConfigPath: "", enabled: [], disabled: [] };
  }
  return applyCodexPluginScope({
    codexHome: resolveCodexHome(options.env || process.env),
    selector: resolveCodexPluginSelector(context.pluginRoot, options),
    enableRoots: roots,
    disableRoots: previousRoots,
  });
}

async function buildWikisIndex(context, options = {}) {
  const mainPath = [
    path.join(context.pluginRoot, "packages", "data-harness-cli", "src", "main.js"),
    path.join(context.pluginRoot, "dist", "data-harness-cli", "src", "main.js"),
    path.join(context.pluginRoot, "vendor", "data-harness-cli", "src", "main.js"),
  ].find((p) => fs.existsSync(p));
  if (!mainPath) return { ok: false, reason: "data-harness-cli not found in pluginRoot" };

  const env = {
    ...process.env,
    HARNESS_PLUGIN_ROOT: context.pluginRoot,
    HARNESS_RESOURCE_ROOT: context.resourceRoot,
    HARNESS_DATA_ROOT: context.dataRoot,
    HARNESS_WORKSPACE_POLICY: context.workspacePolicyPath || "",
    HARNESS_HOST: context.host,
  };
  const result = await run(process.execPath, [mainPath, "wikis", "build-index", "--skip-checks"], {
    cwd: context.resourceRoot,
    env,
    allowFailure: true,
  });
  if (result.code !== 0) {
    return { ok: false, reason: `build-index exited ${result.code}` };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const docs = output.match(/\bdocs=(\d+)/)?.[1] || "";
  return { ok: true, docs, indexPath: path.join(context.resourceRoot, ".harness", "index", "wikis-index.json") };
}

function createSetupSnapshot(context) {
  const pluginLayout = isPluginLayout(context);
  const roots = pluginLayout
    ? [
      {
        root: path.resolve(pluginLayoutRoot(context)),
        managed: ["config", "secrets", "runtimes", ".harness", ".bootstrap-cache", "resource-manifest.json", "install-manifest.json", "context.json", "resources/wikis"],
      },
      { root: path.resolve(context.dataRoot), managed: [] },
    ]
    : [{
      root: path.resolve(context.dataRoot),
      managed: ["runtimes", "wikis", ".harness", "config", ".bootstrap-cache", "resource-manifest.json", "install-manifest.json"],
    }];
  if (String(context.host || "").toLowerCase() === "qwenpaw" && context.secretRoot) {
    roots.push({ root: path.resolve(context.secretRoot), managed: ["auth.blob"] });
  }
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qdm-setup-backup-"));
  const snapshots = roots.map((entry, index) => ({
    ...entry,
    existed: fs.existsSync(entry.root),
    backup: path.join(backupRoot, String(index)),
    entries: new Set(),
  }));
  for (const snapshot of snapshots) {
    for (const relative of snapshot.managed) {
      const source = path.join(snapshot.root, relative);
      if (!fs.existsSync(source)) continue;
      snapshot.entries.add(relative);
      fs.cpSync(source, path.join(snapshot.backup, relative), { recursive: true });
    }
  }
  let finished = false;
  const cleanup = () => fs.rmSync(backupRoot, { recursive: true, force: true });
  return {
    commit() {
      if (finished) return;
      finished = true;
      cleanup();
    },
    rollback() {
      if (finished) return;
      finished = true;
      for (const snapshot of snapshots) {
        if (!snapshot.existed && snapshot.managed.length === 0) continue;
        for (const relative of snapshot.managed) {
          const target = path.join(snapshot.root, relative);
          fs.rmSync(target, { recursive: true, force: true });
          if (snapshot.entries.has(relative)) fs.cpSync(path.join(snapshot.backup, relative), target, { recursive: true });
        }
        if (!snapshot.existed && snapshot.managed.length > 0 && fs.existsSync(snapshot.root)) {
          try {
            if (fs.readdirSync(snapshot.root).length === 0) fs.rmdirSync(snapshot.root);
          } catch {
            // Keep a concurrently populated root intact.
          }
        }
      }
      cleanup();
    },
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

function writePersistedContext(context, options = {}) {
  const host = String(context.host || "").toLowerCase();
  let filePath = "";
  if (host === "codex") {
    const env = options.env || process.env;
    if (!env.CODEX_HOME && options.persistContext !== true && !isCodexPluginLayout(context)) return "";
    const codexHome = path.resolve(String(env.CODEX_HOME || path.join(os.homedir(), ".codex")));
    filePath = isCodexPluginLayout(context)
      ? path.join(context.pluginRoot, "context.json")
      : path.join(codexHome, "qdm-harness", "context.json");
  } else if (host === "qwenpaw" && context.resourceRoot) {
    filePath = path.join(context.resourceRoot, "context.json");
  } else {
    return "";
  }
  writeJsonAtomic(filePath, persistedContextValue(context, options), 0o600);
  return filePath;
}

function persistedContextValue(context, options = {}) {
  return {
    schemaVersion: context.schemaVersion,
    host: context.host,
    pluginRoot: context.pluginRoot,
    artifactRoot: context.artifactRoot,
    resourceRoot: context.resourceRoot,
    dataRoot: context.dataRoot,
    secretRoot: context.secretRoot,
    configPath: context.configPath,
    workspacePolicyPath: context.workspacePolicyPath,
    secretRef: options.noAuth === true || options.channelAuthOnly === true ? null : context.secretRef,
    capabilities: {
      canWriteWorkspace: false,
      canWriteData: context.capabilities.canWriteData,
      hasStableSessionId: false,
      supportsSecretReference: options.noAuth === true || options.channelAuthOnly === true ? false : Boolean(context.secretRef),
    },
  };
}

function writeOutput(report, options, io) {
  const text = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : [
      `Harness Data setup: ${report.context.host}`,
      `dataRoot: ${report.context.dataRoot}`,
      `metric-cli: ${report.metricCli.status}${report.metricCli.path ? ` (${report.metricCli.path})` : ""}`,
      `secret: ${report.secret.type} (${report.secret.status})`,
      `wikis: ${report.wikis.status}${report.wikis.tag ? ` (${report.wikis.tag})` : ""}`,
      `index: ${report.index.ok ? `built${report.index.docs ? ` docs=${report.index.docs}` : ""}` : "skipped"}`,
      `install manifest: ${report.manifestPath}`,
      ...(report.pluginScope?.status === "written"
        ? [`plugin enable: ${report.pluginScope.selector} in ${report.pluginScope.enabled.length} workspace(s)`]
        : []),
      ...(report.persistedContextPath ? [`root context: ${report.persistedContextPath}`] : []),
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
    path.join(pluginRoot, "plugin.json"),
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
