import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const ROOT_CONTEXT_SCHEMA_VERSION = 1;
export const ROOT_CONTEXT_ERROR_CODES = Object.freeze({
  INVALID: "QDM_CONTEXT_INVALID",
  PLUGIN_ROOT_UNAVAILABLE: "QDM_PLUGIN_ROOT_UNAVAILABLE",
  DATA_ROOT_UNAVAILABLE: "QDM_DATA_ROOT_UNAVAILABLE",
  WORKSPACE_REQUIRED: "QDM_WORKSPACE_REQUIRED",
  STATE_LOCKED: "QDM_STATE_LOCKED",
  RESOURCE_MISMATCH: "QDM_RESOURCE_MISMATCH",
  WORKSPACE_NOT_ALLOWED: "QDM_WORKSPACE_NOT_ALLOWED",
  SECRET_UNAVAILABLE: "QDM_SECRET_UNAVAILABLE",
  SESSION_UNAVAILABLE: "QDM_SESSION_UNAVAILABLE",
  SETUP_REQUIRED: "QDM_SETUP_REQUIRED",
  MIGRATION_REQUIRED: "QDM_MIGRATION_REQUIRED",
});

const ROOT_FLAG_FIELDS = Object.freeze({
  "plugin-root": "pluginRoot",
  "artifact-root": "artifactRoot",
  "resource-root": "resourceRoot",
  "data-root": "dataRoot",
  "workspace-root": "workspaceRoot",
  "state-root": "stateRoot",
  config: "configPath",
  "workspace-policy": "workspacePolicyPath",
  "secret-ref": "secretRef",
  "session-id": "sessionId",
  surface: "surface",
});

const ENV_FIELDS = Object.freeze([
  ["HARNESS_PLUGIN_ROOT", "pluginRoot"],
  ["HARNESS_ARTIFACT_ROOT", "artifactRoot"],
  ["HARNESS_RESOURCE_ROOT", "resourceRoot"],
  ["HARNESS_DATA_ROOT", "dataRoot"],
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
]);

export class RootContextError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RootContextError";
    this.code = code;
    this.details = details;
  }
}

export function parseRootContextArgs(argv = []) {
  const fields = {};
  const seen = new Set();
  let contextFile = "";
  let command = "";
  const commandArgs = [];
  let positional = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    const flag = parseLongFlag(token);
    if (!command) {
      if (token === "--") throw invalid("a command is required before --");
      if (flag) {
        if (!Object.hasOwn(ROOT_FLAG_FIELDS, flag.name) && flag.name !== "context-file") {
          throw invalid(`unknown global flag --${flag.name}`);
        }
        const value = readFlagValue(argv, index, flag);
        index = value.nextIndex;
        if (flag.name === "context-file") {
          if (seen.has(flag.name)) throw invalid(`duplicate global flag --${flag.name}`);
          seen.add(flag.name);
          contextFile = String(value.value);
        } else {
          setExplicitField(fields, seen, flag.name, value.value);
        }
        continue;
      }
      if (token.startsWith("-")) throw invalid(`unknown global flag ${token}`);
      command = token;
      continue;
    }
    if (!positional && token === "--") {
      positional = true;
      commandArgs.push(token);
      continue;
    }
    if (!positional && flag && Object.hasOwn(ROOT_FLAG_FIELDS, flag.name)) {
      const value = readFlagValue(argv, index, flag);
      index = value.nextIndex;
      setExplicitField(fields, seen, flag.name, value.value);
      continue;
    }
    commandArgs.push(token);
  }
  return {
    command,
    commandArgs,
    contextFile,
    fields,
    hasStructuredOptions: Boolean(contextFile || Object.keys(fields).length),
  };
}

export function loadRootContextFile(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!filePath) throw invalid("context file path is empty");
  let raw;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch (error) {
    throw invalid(`cannot read context file ${resolved}: ${error?.message || error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalid(`context file is not valid JSON: ${error?.message || error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("context file must contain a JSON object");
  return parsed;
}

export function resolveRootContext({ contextFile = "", explicit = {}, env = process.env } = {}) {
  const fromEnv = contextFromEnv(env);
  const selectedContextFile = contextFile || fromEnv.contextFile;
  const fromFile = selectedContextFile ? loadRootContextFile(selectedContextFile) : {};
  const hasStructured = Boolean(selectedContextFile || fromEnv.hasStructuredOptions || (explicit && Object.keys(explicit).length));
  if (!hasStructured) return null;
  const merged = { ...fromEnv.values, ...fromFile, ...explicit };
  if (explicit.dataRoot && explicit.configPath == null) delete merged.configPath;
  if ((explicit.dataRoot || explicit.workspaceRoot || explicit.host) && explicit.stateRoot == null) delete merged.stateRoot;
  if (fromEnv.values.capabilities || fromFile.capabilities || explicit.capabilities) {
    merged.capabilities = {
      ...(fromEnv.values.capabilities || {}),
      ...(fromFile.capabilities || {}),
      ...(explicit.capabilities || {}),
    };
  }
  return normalizeRootContext(merged, { source: selectedContextFile || "explicit context" });
}

/** Convert a host hook envelope into a normalized runtime Root Context. */
export function contextFromHookPayload(payload, { root = "", env = process.env, baseContext = null } = {}) {
  if (!payload || typeof payload !== "object") return null;
  const declared = payload.rootContext || payload.root_context || payload.context || {};
  const explicit = {
    ...(baseContext && typeof baseContext === "object" ? baseContext : {}),
    ...(declared && typeof declared === "object" && !Array.isArray(declared) ? declared : {}),
  };
  if (!explicit.pluginRoot && env?.HARNESS_PLUGIN_ROOT) explicit.pluginRoot = env.HARNESS_PLUGIN_ROOT;
  if (!explicit.resourceRoot && env?.HARNESS_RESOURCE_ROOT) explicit.resourceRoot = env.HARNESS_RESOURCE_ROOT;
  if (!explicit.dataRoot && env?.HARNESS_DATA_ROOT) explicit.dataRoot = env.HARNESS_DATA_ROOT;
  if (!explicit.dataRoot && env?.CODEX_HOME) explicit.dataRoot = path.join(env.CODEX_HOME, "qdm-harness", "data");
  if (!explicit.secretRoot && env?.HARNESS_SECRET_ROOT) explicit.secretRoot = env.HARNESS_SECRET_ROOT;
  if (!explicit.stateRoot && env?.HARNESS_STATE_ROOT) explicit.stateRoot = env.HARNESS_STATE_ROOT;
  if (!explicit.configPath && env?.HARNESS_CONFIG_PATH) explicit.configPath = env.HARNESS_CONFIG_PATH;
  if (!explicit.workspacePolicyPath && env?.HARNESS_WORKSPACE_POLICY) explicit.workspacePolicyPath = env.HARNESS_WORKSPACE_POLICY;
  if (!explicit.host && payload.host) explicit.host = payload.host;
  if (!explicit.surface && (payload.surface || payload.surface_id)) explicit.surface = payload.surface || payload.surface_id;
  if (!explicit.surface && env?.HARNESS_SURFACE) explicit.surface = env.HARNESS_SURFACE;
  if (!explicit.sessionId && (payload.session_id || payload.sessionId)) explicit.sessionId = payload.session_id || payload.sessionId;
  const payloadWorkspace = payload.workspaceRoot || payload.workspace_root || payload.cwd || "";
  if (payloadWorkspace) {
    explicit.workspaceRoot = payloadWorkspace;
    if (!declared.stateRoot) delete explicit.stateRoot;
  }
  const hasStructuredRoots = Boolean(explicit.pluginRoot || explicit.dataRoot || explicit.workspaceRoot);
  if (!hasStructuredRoots) return null;
  if (!explicit.pluginRoot && root) explicit.pluginRoot = root;
  if (!explicit.workspaceRoot && payload.cwd && explicit.dataRoot) explicit.workspaceRoot = payload.cwd;
  if (!explicit.pluginRoot || !explicit.dataRoot) throw invalid("hook envelope must declare pluginRoot and dataRoot");
  if (explicit.capabilities && typeof explicit.capabilities === "object") {
    explicit.capabilities = { ...explicit.capabilities };
    if (explicit.workspaceRoot && payload.cwd && explicit.capabilities.canWriteWorkspace === false) delete explicit.capabilities.canWriteWorkspace;
    if (explicit.sessionId && (payload.session_id || payload.sessionId) && explicit.capabilities.hasStableSessionId === false) delete explicit.capabilities.hasStableSessionId;
  }
  return normalizeRootContext(explicit, { source: "hook envelope" });
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

export function normalizeRootContext(input, { source = "root context", requireWorkspace = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`${source} must be a JSON object`);
  const schemaVersion = input.schemaVersion == null ? ROOT_CONTEXT_SCHEMA_VERSION : Number(input.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion !== ROOT_CONTEXT_SCHEMA_VERSION) {
    throw invalid(`${source}.schemaVersion must be ${ROOT_CONTEXT_SCHEMA_VERSION}`);
  }
  const pluginRoot = normalizeRootPath(input.pluginRoot, "pluginRoot", {
    required: true,
    errorCode: ROOT_CONTEXT_ERROR_CODES.PLUGIN_ROOT_UNAVAILABLE,
    requireExistingDirectory: true,
  });
  const artifactRoot = normalizeRootPath(input.artifactRoot, "artifactRoot") || pluginRoot;
  const dataRoot = normalizeRootPath(input.dataRoot, "dataRoot", {
    required: true,
    errorCode: ROOT_CONTEXT_ERROR_CODES.DATA_ROOT_UNAVAILABLE,
  });
  const resourceRoot = normalizeRootPath(input.resourceRoot, "resourceRoot") || pluginRoot;
  const secretRoot = normalizeRootPath(input.secretRoot, "secretRoot");
  const workspaceRoot = normalizeRootPath(input.workspaceRoot, "workspaceRoot");
  if (requireWorkspace && !workspaceRoot) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED, "workspaceRoot is required for this operation");
  const host = String(input.host || "unknown").trim() || "unknown";
  const surface = normalizeSurface(input.surface, host);
  const stateRoot = normalizeRootPath(input.stateRoot, "stateRoot") ||
    (workspaceRoot ? path.join(dataRoot, "state", "workspaces", workspaceIdentity({ host, schemaVersion, workspaceRoot })) : "");
  const configPath = normalizeRootPath(input.configPath, "configPath") || (
    host === "codex" && pluginRoot
      ? path.join(pluginRoot, "config", "settings.json")
      : host === "qwenpaw" && resourceRoot
        ? path.join(resourceRoot, "config", "settings.json")
        : path.join(dataRoot, "config", "settings.json")
  );
  const workspacePolicyPath = normalizeRootPath(input.workspacePolicyPath, "workspacePolicyPath") || (
    host === "codex" && pluginRoot
      ? path.join(pluginRoot, "config", "workspace-policy.json")
      : host === "qwenpaw" && resourceRoot
        ? path.join(resourceRoot, "config", "workspace-policy.json")
        : ""
  );
  const secretRef = normalizeSecretRef(input.secretRef);
  const sessionId = input.sessionId == null ? "" : String(input.sessionId).trim();
  validateRootRelationships({ pluginRoot, resourceRoot, dataRoot, secretRoot, workspaceRoot, stateRoot, configPath, workspacePolicyPath, secretRef });

  const suppliedCapabilities = input.capabilities;
  if (suppliedCapabilities != null && (typeof suppliedCapabilities !== "object" || Array.isArray(suppliedCapabilities))) {
    throw invalid("capabilities must be an object");
  }
  const capabilities = {
    canWriteWorkspace: suppliedCapabilities?.canWriteWorkspace ?? Boolean(workspaceRoot && isDirectory(workspaceRoot)),
    canWriteData: suppliedCapabilities?.canWriteData ?? true,
    hasStableSessionId: suppliedCapabilities?.hasStableSessionId ?? Boolean(sessionId),
    supportsSecretReference: suppliedCapabilities?.supportsSecretReference ?? Boolean(secretRef),
  };
  for (const name of ["supportsLocalUi", "supportsHooks"]) {
    if (suppliedCapabilities?.[name] !== undefined) capabilities[name] = suppliedCapabilities[name];
  }
  for (const [name, value] of Object.entries(capabilities)) {
    if (typeof value !== "boolean") throw invalid(`capabilities.${name} must be boolean`);
  }
  if (capabilities.canWriteWorkspace && !workspaceRoot) throw invalid("capabilities.canWriteWorkspace cannot be true without workspaceRoot");
  if (capabilities.hasStableSessionId && !sessionId) throw invalid("capabilities.hasStableSessionId cannot be true without sessionId");
  if (capabilities.supportsSecretReference && !secretRef) throw invalid("capabilities.supportsSecretReference cannot be true without secretRef");
  return {
    schemaVersion,
    host,
    surface,
    pluginRoot,
    artifactRoot,
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

export function workspaceIdentity({ workspaceRoot, host = "unknown", schemaVersion = ROOT_CONTEXT_SCHEMA_VERSION } = {}) {
  if (!workspaceRoot) return "";
  return createHash("sha256").update(`${workspaceRoot}\n${host}\n${schemaVersion}`).digest("hex");
}

export function isPathWithin(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function contextFromEnv(env = process.env) {
  const values = {};
  for (const [name, field] of ENV_FIELDS) {
    const value = env?.[name];
    if (value != null && String(value).trim() !== "" && values[field] == null) values[field] = String(value);
  }
  if (!values.dataRoot && env?.CODEX_HOME) values.dataRoot = path.join(String(env.CODEX_HOME), "qdm-harness", "data");
  if (env?.HARNESS_SECRET_REF && !values.secretRef) values.secretRef = parseSecretRefValue(env.HARNESS_SECRET_REF);
  const contextFile = env?.HARNESS_CONTEXT_FILE || env?.CODEX_CONTEXT_FILE || env?.CHATGPT_CONTEXT_FILE || env?.OPENAI_CONTEXT_FILE || "";
  return { values, contextFile, hasStructuredOptions: Boolean(values.pluginRoot || values.dataRoot || contextFile) };
}

function setExplicitField(fields, seen, flagName, rawValue) {
  if (seen.has(flagName)) throw invalid(`duplicate global flag --${flagName}`);
  seen.add(flagName);
  const field = ROOT_FLAG_FIELDS[flagName];
  fields[field] = flagName === "secret-ref" ? parseSecretRefValue(rawValue) : String(rawValue);
}

function parseSecretRefValue(value) {
  if (value && typeof value === "object") return value;
  const text = String(value ?? "").trim();
  if (!text) throw invalid("secret-ref must not be empty");
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be an object");
      return parsed;
    } catch (error) {
      throw invalid(`secret-ref JSON is invalid: ${error?.message || error}`);
    }
  }
  return { kind: "file", path: text };
}

function normalizeSecretRef(value) {
  if (value == null || value === "") return null;
  const ref = parseSecretRefValue(value);
  const kind = String(ref.kind || "").trim().toLowerCase();
  if (!["file", "host", "stdin", "fd"].includes(kind)) throw invalid(`secretRef.kind is unsupported: ${kind || "missing"}`);
  if (kind === "file") {
    validateSecretFileRef(ref.path);
    return { kind, path: normalizeRootPath(ref.path, "secretRef.path", { required: true }) };
  }
  if (kind === "host") {
    const id = String(ref.id || ref.name || "").trim();
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

function validateSecretFileRef(value) {
  const filePath = String(value || "").trim();
  if (!filePath || !path.isAbsolute(filePath) || !existsSync(filePath)) return;
  let info;
  try {
    info = lstatSync(filePath);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw invalid("secretRef.path must be a regular file");
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) throw invalid("secretRef.path permissions must be 0600");
}

function normalizeRootPath(value, name, options = {}) {
  if (value == null || String(value).trim() === "") {
    if (options.required) throw new RootContextError(options.errorCode || ROOT_CONTEXT_ERROR_CODES.INVALID, `${name} is required`);
    return "";
  }
  const text = String(value).trim();
  if (text.includes("\0") || !path.isAbsolute(text)) throw invalid(`${name} must be an absolute path`);
  const normalized = canonicalizePath(text);
  if (options.requireExistingDirectory && !isDirectory(normalized)) {
    throw new RootContextError(options.errorCode || ROOT_CONTEXT_ERROR_CODES.INVALID, `${name} is unavailable: ${normalized}`);
  }
  if (existsSync(normalized) && !isDirectory(normalized) && !name.endsWith("Path") && name !== "secretRef.path") {
    throw new RootContextError(options.errorCode || ROOT_CONTEXT_ERROR_CODES.INVALID, `${name} must be a directory: ${normalized}`);
  }
  if (existsSync(normalized) && (name === "configPath" || name === "workspacePolicyPath" || name === "secretRef.path") && isDirectory(normalized)) {
    throw invalid(`${name} must be a file: ${normalized}`);
  }
  return normalized;
}

function canonicalizePath(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let real;
  try {
    real = realpathSync.native(current);
  } catch {
    real = path.resolve(current);
  }
  return path.join(real, ...suffix);
}

function validateRootRelationships({ pluginRoot, resourceRoot, dataRoot, secretRoot, workspaceRoot, stateRoot, configPath, workspacePolicyPath, secretRef }) {
  const disjoint = [
    ["pluginRoot", pluginRoot],
    ["dataRoot", dataRoot],
    ["workspaceRoot", workspaceRoot],
  ].filter(([, value]) => value);
  for (let i = 0; i < disjoint.length; i += 1) {
    for (let j = i + 1; j < disjoint.length; j += 1) {
      const [leftName, left] = disjoint[i];
      const [rightName, right] = disjoint[j];
      if (isPathWithin(left, right) || isPathWithin(right, left)) throw invalid(`${leftName} and ${rightName} overlap`);
    }
  }
  if (secretRoot && dataRoot && (isPathWithin(secretRoot, dataRoot) || isPathWithin(dataRoot, secretRoot))) {
    throw invalid("secretRoot and dataRoot overlap");
  }
  if (secretRoot && workspaceRoot && (isPathWithin(secretRoot, workspaceRoot) || isPathWithin(workspaceRoot, secretRoot))) {
    throw invalid("secretRoot and workspaceRoot overlap");
  }
  if (stateRoot && !isPathWithin(dataRoot, stateRoot)) throw invalid("stateRoot must be inside dataRoot");
  if (configPath && !isPathWithin(pluginRoot, configPath) && !isPathWithin(dataRoot, configPath) && !isPathWithin(resourceRoot, configPath)) {
    throw invalid("configPath must be inside pluginRoot, resourceRoot or dataRoot");
  }
  if (workspacePolicyPath && !isPathWithin(pluginRoot, workspacePolicyPath) && !isPathWithin(dataRoot, workspacePolicyPath) && !isPathWithin(resourceRoot, workspacePolicyPath)) {
    throw invalid("workspacePolicyPath must be inside pluginRoot, resourceRoot or dataRoot");
  }
  if (secretRef?.kind === "file") {
    if (secretRoot && !isPathWithin(secretRoot, secretRef.path)) throw invalid("secretRef.path must be inside secretRoot");
    if (!secretRoot && isPathWithin(dataRoot, secretRef.path)) throw invalid("file secretRef must not be inside dataRoot without secretRoot");
  }
}

function readFlagValue(argv, index, flag) {
  if (flag.inline != null) return { value: flag.inline, nextIndex: index };
  const next = argv[index + 1];
  if (next == null || String(next).startsWith("--")) throw invalid(`flag --${flag.name} needs an argument`);
  return { value: next, nextIndex: index + 1 };
}

function parseLongFlag(token) {
  if (!token.startsWith("--") || token === "--") return null;
  const raw = token.slice(2);
  const equals = raw.indexOf("=");
  return equals >= 0 ? { name: raw.slice(0, equals), inline: raw.slice(equals + 1) } : { name: raw, inline: null };
}

function isDirectory(filePath) {
  if (!filePath || !existsSync(filePath)) return false;
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function invalid(message) {
  return new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, message);
}
