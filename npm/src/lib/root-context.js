import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT_CONTEXT_SCHEMA_VERSION = 1;

export const ROOT_CONTEXT_ERROR_CODES = Object.freeze({
  INVALID: "QDM_CONTEXT_INVALID",
  PLUGIN_ROOT_UNAVAILABLE: "QDM_PLUGIN_ROOT_UNAVAILABLE",
  DATA_ROOT_UNAVAILABLE: "QDM_DATA_ROOT_UNAVAILABLE",
  WORKSPACE_REQUIRED: "QDM_WORKSPACE_REQUIRED",
  SECRET_UNAVAILABLE: "QDM_SECRET_UNAVAILABLE",
  SESSION_UNAVAILABLE: "QDM_SESSION_UNAVAILABLE",
  SETUP_REQUIRED: "QDM_SETUP_REQUIRED",
});

const optionFields = [
  "contextFile",
  "pluginRoot",
  "resourceRoot",
  "dataRoot",
  "secretRoot",
  "workspaceRoot",
  "stateRoot",
  "configPath",
  "workspacePolicyPath",
  "secretRef",
  "sessionId",
  "host",
  "surface",
];

const envFields = [
  ["HARNESS_PLUGIN_ROOT", "pluginRoot"],
  ["HARNESS_DATA_ROOT", "dataRoot"],
  ["HARNESS_RESOURCE_ROOT", "resourceRoot"],
  ["HARNESS_SECRET_ROOT", "secretRoot"],
  ["HARNESS_WORKSPACE_ROOT", "workspaceRoot"],
  ["HARNESS_STATE_ROOT", "stateRoot"],
  ["HARNESS_CONFIG_PATH", "configPath"],
  ["HARNESS_CONFIG", "configPath"],
  ["HARNESS_WORKSPACE_POLICY", "workspacePolicyPath"],
  ["HARNESS_SESSION_ID", "sessionId"],
  ["HARNESS_HOST", "host"],
  ["CHATGPT_HOST", "host"],
  ["HARNESS_SURFACE", "surface"],
  ["CHATGPT_SURFACE", "surface"],
  ["CODEX_WORKSPACE_ROOT", "workspaceRoot"],
  ["CHATGPT_WORKSPACE_ROOT", "workspaceRoot"],
  ["OPENAI_WORKSPACE_ROOT", "workspaceRoot"],
];

export class RootContextError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RootContextError";
    this.code = code;
    this.details = details;
  }
}

export function hasStructuredRootContext(options = {}, env = process.env) {
  return optionFields.some((name) => hasValue(options[name])) || Boolean(
    env?.HARNESS_PLUGIN_ROOT ||
    env?.HARNESS_DATA_ROOT ||
    env?.HARNESS_CONTEXT_FILE ||
    env?.CODEX_CONTEXT_FILE ||
    env?.CHATGPT_CONTEXT_FILE ||
    env?.OPENAI_CONTEXT_FILE ||
    env?.CHATGPT_WORKSPACE_ROOT ||
    env?.OPENAI_WORKSPACE_ROOT ||
    env?.CODEX_HOME,
  );
}

/**
 * Resolve the installer-facing Root Context. This is deliberately side-effect
 * free: setup is responsible for creating dataRoot, while doctor/paths only
 * inspect the normalized locations.
 */
export function resolveRootContext(options = {}, { env = process.env, requirePluginRoot = true } = {}) {
  const envContext = contextFromEnv(env);
  const contextFile = stringValue(options.contextFile) || envContext.contextFile;
  const fileContext = contextFile ? loadContextFile(contextFile) : {};
  const explicit = pickOptions(options);
  const source = contextFile || "explicit options";
  const merged = {
    ...envContext.values,
    ...fileContext,
    ...explicit,
  };

  if (!merged.host && (env?.CODEX_HOME || env?.CODEX_WORKSPACE_ROOT || options.host === "codex")) {
    merged.host = "codex";
  }
  if (!merged.pluginRoot && options.dir) merged.pluginRoot = path.resolve(String(options.dir));
  const codexHome = stringValue(env?.CODEX_HOME) || path.join(os.homedir(), ".codex");
  if (!merged.dataRoot && merged.host === "codex") merged.dataRoot = path.join(codexHome, "qdm-harness", "data");
  if (!merged.dataRoot) merged.dataRoot = defaultDataRoot(merged.host || "codex");
  if (!merged.secretRoot && merged.host === "codex" && merged.pluginRoot) merged.secretRoot = path.join(merged.pluginRoot, "secrets");
  if (!merged.secretRoot) merged.secretRoot = defaultSecretRoot(merged.host || "codex");
  if (!merged.resourceRoot) merged.resourceRoot = merged.pluginRoot || merged.dataRoot;
  if (!merged.configPath && merged.host === "codex" && merged.pluginRoot) merged.configPath = path.join(merged.pluginRoot, "config", "settings.json");
  if (!merged.workspacePolicyPath && merged.host === "codex" && merged.pluginRoot) merged.workspacePolicyPath = path.join(merged.pluginRoot, "config", "workspace-policy.json");

  return normalizeRootContext(merged, { source, requirePluginRoot });
}

export function normalizeRootContext(input, { source = "root context", requirePluginRoot = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid(`${source} must be a JSON object`);
  }
  const schemaVersion = input.schemaVersion == null ? ROOT_CONTEXT_SCHEMA_VERSION : Number(input.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion !== ROOT_CONTEXT_SCHEMA_VERSION) {
    throw invalid(`${source}.schemaVersion must be ${ROOT_CONTEXT_SCHEMA_VERSION}`);
  }

  const pluginRoot = normalizeDirectory(input.pluginRoot, "pluginRoot", {
    required: requirePluginRoot,
    requireExisting: requirePluginRoot,
    code: ROOT_CONTEXT_ERROR_CODES.PLUGIN_ROOT_UNAVAILABLE,
  });
  const dataRoot = normalizeDirectory(input.dataRoot, "dataRoot", {
    required: true,
    code: ROOT_CONTEXT_ERROR_CODES.DATA_ROOT_UNAVAILABLE,
  });
  const resourceRoot = normalizeDirectory(input.resourceRoot, "resourceRoot") || pluginRoot || dataRoot;
  const secretRoot = normalizeDirectory(input.secretRoot, "secretRoot");
  const workspaceRoot = normalizeDirectory(input.workspaceRoot, "workspaceRoot");
  const host = stringValue(input.host) || "unknown";
  const surface = normalizeSurface(input.surface, host);
  const stateRoot = normalizeDirectory(input.stateRoot, "stateRoot") || (workspaceRoot
    ? path.join(dataRoot, "state", "workspaces", workspaceIdentity({ host, workspaceRoot, schemaVersion }))
    : path.join(dataRoot, "state"));
  const configPath = normalizeFilePath(input.configPath, "configPath") || (
    host === "codex" && pluginRoot
      ? path.join(pluginRoot, "config", "settings.json")
      : path.join(dataRoot, "config", "settings.json")
  );
  const workspacePolicyPath = normalizeFilePath(input.workspacePolicyPath, "workspacePolicyPath") || (
    host === "codex" && pluginRoot
      ? path.join(pluginRoot, "config", "workspace-policy.json")
      : ""
  );
  const secretRef = normalizeSecretRef(input.secretRef);
  const sessionId = stringValue(input.sessionId);

  validateRootRelationships({ pluginRoot, dataRoot, secretRoot, workspaceRoot, stateRoot, configPath, workspacePolicyPath, secretRef });
  const supplied = input.capabilities || {};
  if (typeof supplied !== "object" || Array.isArray(supplied)) throw invalid("capabilities must be an object");
  const capabilities = {
    canWriteWorkspace: supplied.canWriteWorkspace ?? Boolean(workspaceRoot && canAccess(workspaceRoot, fs.constants.W_OK)),
    canWriteData: supplied.canWriteData ?? canAccessExistingOrParent(dataRoot, fs.constants.W_OK),
    hasStableSessionId: supplied.hasStableSessionId ?? Boolean(sessionId),
    supportsSecretReference: supplied.supportsSecretReference ?? Boolean(secretRef),
  };
  for (const name of ["supportsLocalUi", "supportsHooks"]) {
    if (supplied[name] !== undefined) capabilities[name] = supplied[name];
  }
  for (const [name, value] of Object.entries(capabilities)) {
    if (typeof value !== "boolean") throw invalid(`capabilities.${name} must be boolean`);
  }
  if (capabilities.canWriteWorkspace && !workspaceRoot) {
    throw invalid("capabilities.canWriteWorkspace cannot be true without workspaceRoot");
  }
  if (capabilities.hasStableSessionId && !sessionId) {
    throw invalid("capabilities.hasStableSessionId cannot be true without sessionId");
  }
  if (capabilities.supportsSecretReference && !secretRef) {
    throw invalid("capabilities.supportsSecretReference cannot be true without secretRef");
  }

  return {
    schemaVersion,
    host,
    surface,
    pluginRoot,
    resourceRoot,
    dataRoot,
    secretRoot,
    workspaceRoot,
    stateRoot,
    configPath,
    workspacePolicyPath,
    secretRef,
    sessionId,
    capabilities,
  };
}

function normalizeSurface(value, host) {
  const surface = String(value || "").trim().toLowerCase();
  if (surface && !["codex", "desktop", "chat", "work", "cli"].includes(surface)) {
    throw invalid(`surface must be one of codex, desktop, chat, work, cli: ${surface}`);
  }
  if (surface === "cli") return "codex";
  if (surface) return surface;
  const normalizedHost = String(host || "").trim().toLowerCase();
  if (normalizedHost === "codex") return "codex";
  if (normalizedHost === "chatgpt" || normalizedHost === "chatgpt-desktop") return "desktop";
  return "unknown";
}

export function publicRootContext(context) {
  return {
    schemaVersion: context.schemaVersion,
    host: context.host,
    surface: context.surface,
    pluginRoot: context.pluginRoot,
    resourceRoot: context.resourceRoot,
    dataRoot: context.dataRoot,
    secretRoot: context.secretRoot,
    workspaceRoot: context.workspaceRoot,
    stateRoot: context.stateRoot,
    configPath: context.configPath,
    workspacePolicyPath: context.workspacePolicyPath,
    secretRef: context.secretRef ? { kind: context.secretRef.kind } : null,
    sessionId: context.sessionId,
    capabilities: context.capabilities,
  };
}

export function workspaceIdentity({ workspaceRoot, host = "unknown", schemaVersion = ROOT_CONTEXT_SCHEMA_VERSION } = {}) {
  if (!workspaceRoot) return "";
  return crypto.createHash("sha256").update(`${workspaceRoot}\n${host}\n${schemaVersion}`).digest("hex");
}

export function isPathWithin(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function defaultDataRoot(_host = "unknown") {
  return path.join(os.homedir(), ".lumi-ai-lab", "qdm-harness", "data");
}

export function defaultSecretRoot(_host = "unknown") {
  return path.join(os.homedir(), ".lumi-ai-lab", "qdm-harness", "secrets");
}

function contextFromEnv(env = process.env) {
  const values = {};
  for (const [name, field] of envFields) {
    if (hasValue(env?.[name]) && values[field] == null) values[field] = String(env[name]);
  }
  if (hasValue(env?.HARNESS_SECRET_REF)) values.secretRef = parseSecretRef(env.HARNESS_SECRET_REF);
  return {
    values,
    contextFile: stringValue(env?.HARNESS_CONTEXT_FILE) || stringValue(env?.CODEX_CONTEXT_FILE) || stringValue(env?.CHATGPT_CONTEXT_FILE) || stringValue(env?.OPENAI_CONTEXT_FILE),
  };
}

function pickOptions(options = {}) {
  const values = {};
  for (const name of optionFields) {
    if (!hasValue(options[name])) continue;
    values[name] = name === "secretRef" ? parseSecretRef(options[name]) : options[name];
  }
  return values;
}

function loadContextFile(filePath) {
  const resolved = path.resolve(String(filePath));
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw invalid(`cannot read context file ${resolved}: ${error?.message || error}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must contain an object");
    return parsed;
  } catch (error) {
    throw invalid(`context file is not valid JSON: ${error?.message || error}`);
  }
}

function normalizeDirectory(value, name, options = {}) {
  if (!hasValue(value)) {
    if (options.required) throw new RootContextError(options.code || ROOT_CONTEXT_ERROR_CODES.INVALID, `${name} is required`);
    return "";
  }
  const normalized = canonicalizePath(value, name);
  if (fs.existsSync(normalized) && !isDirectory(normalized)) {
    throw new RootContextError(options.code || ROOT_CONTEXT_ERROR_CODES.INVALID, `${name} must be a directory: ${normalized}`);
  }
  if (options.requireExisting && !isDirectory(normalized)) {
    throw new RootContextError(options.code || ROOT_CONTEXT_ERROR_CODES.INVALID, `${name} is unavailable: ${normalized}`);
  }
  return normalized;
}

function normalizeFilePath(value, name) {
  if (!hasValue(value)) return "";
  const normalized = canonicalizePath(value, name);
  if (fs.existsSync(normalized) && isDirectory(normalized)) throw invalid(`${name} must be a file: ${normalized}`);
  return normalized;
}

function normalizeSecretRef(value) {
  if (!hasValue(value)) return null;
  const ref = parseSecretRef(value);
  const kind = stringValue(ref.kind).toLowerCase();
  if (!["file", "host", "stdin", "fd"].includes(kind)) throw invalid(`secretRef.kind is unsupported: ${kind || "missing"}`);
  if (kind === "file") {
    const filePath = normalizeFilePath(ref.path, "secretRef.path");
    if (!filePath) throw invalid("secretRef.path is required");
    validateSecretFile(filePath);
    return { kind, path: filePath };
  }
  if (kind === "host") {
    const id = stringValue(ref.id) || stringValue(ref.name);
    if (!id) throw invalid("secretRef host requires id");
    return { kind, id };
  }
  if (kind === "fd") {
    const fd = Number(ref.fd);
    if (!Number.isInteger(fd) || fd < 0) throw invalid("secretRef fd must be a non-negative integer");
    return { kind, fd };
  }
  return { kind };
}

function parseSecretRef(value) {
  if (value && typeof value === "object") return value;
  const text = stringValue(value);
  if (!text) throw invalid("secretRef must not be empty");
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be an object");
      return parsed;
    } catch (error) {
      throw invalid(`secretRef JSON is invalid: ${error?.message || error}`);
    }
  }
  return { kind: "file", path: text };
}

function validateSecretFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch {
    return;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "secretRef.path must be a regular file");
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.SECRET_UNAVAILABLE, "secretRef.path permissions must be 0600");
  }
}

function validateRootRelationships({ pluginRoot, dataRoot, secretRoot, workspaceRoot, stateRoot, configPath, workspacePolicyPath, secretRef }) {
  const disjoint = [["pluginRoot", pluginRoot], ["dataRoot", dataRoot], ["workspaceRoot", workspaceRoot]].filter(([, value]) => value);
  for (let i = 0; i < disjoint.length; i += 1) {
    for (let j = i + 1; j < disjoint.length; j += 1) {
      const [leftName, left] = disjoint[i];
      const [rightName, right] = disjoint[j];
      if (isPathWithin(left, right) || isPathWithin(right, left)) throw invalid(`${leftName} and ${rightName} overlap`);
    }
  }
  if (secretRoot && dataRoot && isPathWithin(secretRoot, dataRoot) || secretRoot && dataRoot && isPathWithin(dataRoot, secretRoot)) {
    throw invalid("secretRoot and dataRoot overlap");
  }
  if (secretRoot && workspaceRoot && (isPathWithin(secretRoot, workspaceRoot) || isPathWithin(workspaceRoot, secretRoot))) {
    throw invalid("secretRoot and workspaceRoot overlap");
  }
  if (!isPathWithin(dataRoot, stateRoot)) throw invalid("stateRoot must be inside dataRoot");
  if (!isPathWithin(pluginRoot, configPath) && !isPathWithin(dataRoot, configPath)) throw invalid("configPath must be inside pluginRoot or dataRoot");
  if (workspacePolicyPath && !isPathWithin(pluginRoot, workspacePolicyPath) && !isPathWithin(dataRoot, workspacePolicyPath)) {
    throw invalid("workspacePolicyPath must be inside pluginRoot or dataRoot");
  }
  if (secretRef?.kind === "file") {
    if (secretRoot && !isPathWithin(secretRoot, secretRef.path)) throw invalid("secretRef.path must be inside secretRoot");
    if (!secretRoot && isPathWithin(dataRoot, secretRef.path)) throw invalid("file secretRef must not be inside dataRoot without secretRoot");
  }
}

function canonicalizePath(value, name) {
  const text = stringValue(value);
  if (!text || text.includes("\0") || !path.isAbsolute(text)) throw invalid(`${name} must be an absolute path`);
  let current = path.resolve(text);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(text);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let real;
  try {
    real = fs.realpathSync.native(current);
  } catch {
    real = path.resolve(current);
  }
  return path.join(real, ...suffix);
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function canAccess(filePath, mode) {
  try {
    fs.accessSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

function canAccessExistingOrParent(filePath, mode) {
  let candidate = filePath;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
  return canAccess(candidate, mode);
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function hasValue(value) {
  return stringValue(value) !== "";
}

function invalid(message) {
  return new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, message);
}
