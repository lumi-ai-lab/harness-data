import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadRuntime } from "./kernel-loader.mjs";
import { readPersistedContext, PluginContextError } from "../scripts/context-store.mjs";

const [hostRuntime, rootRuntime, policyRuntime, bridgeRuntime] = await Promise.all([
  loadRuntime("host-context.mjs"),
  loadRuntime("root-context.mjs"),
  loadRuntime("workspace-policy.mjs"),
  loadRuntime("local-bridge.mjs"),
]);

const {
  HostContextProvider,
  normalizeHostSurface,
} = hostRuntime;
const {
  ROOT_CONTEXT_ERROR_CODES,
  RootContextError,
} = rootRuntime;
const { assertWorkspaceAllowed } = policyRuntime;
const { LocalBridge } = bridgeRuntime;

function firstValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function boolValue(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `boolean value is invalid: ${value}`);
}

function desktopDataRoot(env = process.env) {
  if (env.HARNESS_DESKTOP_DATA_ROOT) return path.resolve(String(env.HARNESS_DESKTOP_DATA_ROOT));
  if (env.LOCALAPPDATA) return path.join(path.resolve(String(env.LOCALAPPDATA)), "Harness Data");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Harness Data");
  if (process.platform === "win32") return path.join(os.homedir(), "AppData", "Local", "Harness Data");
  return path.join(path.resolve(String(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"))), "harness-data");
}

function explicitWorkspace(env, options) {
  return firstValue(
    options.workspaceRoot,
    env.HARNESS_WORKSPACE_ROOT,
    env.CODEX_WORKSPACE_ROOT,
    env.CHATGPT_WORKSPACE_ROOT,
    env.OPENAI_WORKSPACE_ROOT,
    env.WORKSPACE_ROOT,
  );
}

function explicitSession(env, options) {
  return firstValue(
    options.sessionId,
    env.HARNESS_SESSION_ID,
    env.CHATGPT_SESSION_ID,
    env.OPENAI_SESSION_ID,
  );
}

class HarnessHostAdapter extends HostContextProvider {
  constructor({
    host,
    surface,
    env = process.env,
    pluginRoot = "",
    dataRoot = "",
    contextFile = "",
    context = null,
    workspaceRoot = "",
    sessionId = "",
    secretRef = null,
    supportsLocalUi = true,
    supportsHooks = false,
    allowLegacyCwd = false,
    allowPersistedWorkspace = true,
    allowUnpersistedContext = false,
    allowDataRootOverride = false,
    allowRootOverrides = false,
    bridgeHandler = null,
    bridgeOptions = {},
  } = {}) {
    super({
      host,
      surface,
      capabilities: {
        supportsLocalUi,
        supportsHooks,
      },
    });
    this.env = { ...env };
    if (this.env.HARNESS_SUPPORTS_LOCAL_UI != null) {
      this._capabilityOverrides.supportsLocalUi = boolValue(this.env.HARNESS_SUPPORTS_LOCAL_UI, true);
    }
    if (this.env.HARNESS_SUPPORTS_HOOKS != null) {
      this._capabilityOverrides.supportsHooks = boolValue(this.env.HARNESS_SUPPORTS_HOOKS, false);
    }
    this.pluginRootOption = String(pluginRoot || "").trim();
    this.dataRootOption = String(dataRoot || "").trim();
    this.contextFileOption = String(contextFile || "").trim();
    this.contextOption = context && typeof context === "object" ? { ...context } : null;
    this.workspaceRootOption = String(workspaceRoot || "").trim();
    this.sessionIdOption = String(sessionId || "").trim();
    this.secretRefOption = secretRef;
    this.allowLegacyCwd = Boolean(allowLegacyCwd);
    this.allowPersistedWorkspace = Boolean(allowPersistedWorkspace);
    this.allowUnpersistedContext = Boolean(allowUnpersistedContext);
    this.allowDataRootOverride = Boolean(allowDataRootOverride);
    this.allowRootOverrides = Boolean(allowRootOverrides);
    this.bridgeHandler = typeof bridgeHandler === "function" ? bridgeHandler : null;
    this.bridgeOptions = {
      ...(bridgeOptions || {}),
      token: firstValue(bridgeOptions?.token, this.env.HARNESS_BRIDGE_TOKEN, this.env.CHATGPT_BRIDGE_TOKEN),
    };
    this.transport = boolValue(this.env.HARNESS_DESKTOP_BRIDGE, false)
      ? "bridge"
      : firstValue(this.env.HARNESS_DESKTOP_TRANSPORT, "stdio").toLowerCase();
    this.bridge = null;
    this.contextPath = "";
    this._resolver = ({ requireWorkspace = false } = {}) => this._resolveRawContext({ requireWorkspace });
    this._policyValidator = (context) => {
      if (this.env.HARNESS_WORKSPACE_TRUSTED != null && !boolValue(this.env.HARNESS_WORKSPACE_TRUSTED, true)) {
        throw new RootContextError(
          ROOT_CONTEXT_ERROR_CODES.WORKSPACE_NOT_ALLOWED,
          "host did not mark the workspace as trusted",
        );
      }
      return assertWorkspaceAllowed(context);
    };
  }

  _resolveRawContext() {
    const env = this.env;
    const pluginRootHint = this.pluginRootOption || env.HARNESS_PLUGIN_ROOT || "";
    const contextEnv = { ...env };
    if (this.contextFileOption) contextEnv.HARNESS_CONTEXT_FILE = this.contextFileOption;
    if (!contextEnv.HARNESS_CONTEXT_FILE) {
      contextEnv.HARNESS_CONTEXT_FILE = firstValue(env.CHATGPT_CONTEXT_FILE, env.OPENAI_CONTEXT_FILE);
    }
    const loaded = this.contextOption
      ? { contextPath: "inline host context", context: this.contextOption }
      : readPersistedContext({
        env: contextEnv,
        required: false,
        pluginRoot: pluginRootHint,
      });
    this.contextPath = loaded.contextPath;
    const persistedContext = loaded.context;
    if (this.host === "codex" && !persistedContext && !this.allowUnpersistedContext) {
      throw new PluginContextError(
        ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED,
        `Harness Data setup is required; run the installed plugin's scripts/setup.mjs (${loaded.contextPath})`,
      );
    }
    const persisted = persistedContext || {};
    const rootOverrides = this.allowRootOverrides || (!persistedContext && this.allowUnpersistedContext);
    const pluginRoot = firstValue(
      this.pluginRootOption,
      rootOverrides ? env.HARNESS_PLUGIN_ROOT : "",
      persisted.pluginRoot,
    );
    const dataRoot = firstValue(
      this.dataRootOption,
      (this.allowDataRootOverride || rootOverrides) ? env.HARNESS_DATA_ROOT : "",
      persisted.dataRoot,
      !persisted.dataRoot ? env.HARNESS_DATA_ROOT : "",
      this.host === "codex" && env.CODEX_HOME ? path.join(String(env.CODEX_HOME), "qdm-harness", "data") : "",
      this.host === "codex" ? "" : desktopDataRoot(env),
    );
    const hasExplicitDataRoot = Boolean(this.dataRootOption || ((this.allowDataRootOverride || rootOverrides) && env.HARNESS_DATA_ROOT));
    const workspace = explicitWorkspace(env, { workspaceRoot: this.workspaceRootOption });
    const persistedWorkspace = (this.contextOption || this.allowPersistedWorkspace)
      ? String(persisted.workspaceRoot || "").trim()
      : "";
    const legacyWorkspace = this.allowLegacyCwd || boolValue(env.HARNESS_ALLOW_LEGACY_PWD, false)
      ? firstValue(env.PWD)
      : "";
    const workspaceRoot = workspace || persistedWorkspace || legacyWorkspace;
    const sessionId = explicitSession(env, { sessionId: this.sessionIdOption });
    const secretRef = this.secretRefOption || persisted.secretRef || (rootOverrides ? env.HARNESS_SECRET_REF : "") || null;
    const canWriteWorkspace = boolValue(
      env.HARNESS_CAN_WRITE_WORKSPACE,
      Boolean(workspaceRoot) && !boolValue(env.HARNESS_READ_ONLY, false),
    );
    const canWriteData = boolValue(env.HARNESS_CAN_WRITE_DATA, true);
    const supportsLocalUi = boolValue(env.HARNESS_SUPPORTS_LOCAL_UI, this._capabilityOverrides.supportsLocalUi);
    const hasStableSessionId = boolValue(env.HARNESS_HAS_STABLE_SESSION_ID, Boolean(sessionId));
    const supportsSecretReference = boolValue(env.HARNESS_SUPPORTS_SECRET_REFERENCE, Boolean(secretRef));
    if (!pluginRoot || !dataRoot) {
      throw new PluginContextError(
        ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED,
        "Harness Data host context is incomplete; configure pluginRoot and dataRoot before invoking the runtime",
      );
    }
    const context = {
      ...persisted,
      schemaVersion: persisted.schemaVersion || 1,
      host: this.host,
      surface: this.surface,
      pluginRoot: path.resolve(pluginRoot),
      resourceRoot: firstValue(rootOverrides ? env.HARNESS_RESOURCE_ROOT : "", persisted.resourceRoot, pluginRoot),
      dataRoot: path.resolve(dataRoot),
      secretRoot: firstValue(rootOverrides ? env.HARNESS_SECRET_ROOT : "", persisted.secretRoot),
      configPath: firstValue(rootOverrides ? env.HARNESS_CONFIG_PATH : "", hasExplicitDataRoot ? "" : persisted.configPath),
      workspacePolicyPath: firstValue(
        rootOverrides ? env.HARNESS_WORKSPACE_POLICY : "",
        persisted.workspacePolicyPath,
        path.join(path.resolve(pluginRoot), "config", "workspace-policy.json"),
      ),
      workspaceRoot,
      sessionId,
      secretRef,
      capabilities: {
        ...(persisted.capabilities || {}),
        canWriteWorkspace,
        canWriteData,
        supportsLocalUi,
        supportsHooks: this._capabilityOverrides.supportsHooks,
        hasStableSessionId,
        supportsSecretReference,
      },
    };
    const explicitStateRoot = firstValue(env.HARNESS_STATE_ROOT, persisted.stateRoot);
    if (explicitStateRoot) context.stateRoot = explicitStateRoot;
    else delete context.stateRoot;
    return context;
  }

  diagnostics() {
    const result = super.diagnostics();
    result.transport = this.transport;
    result.bridge = this.bridge ? this.bridge.status() : { state: "not_started" };
    result.contextPath = this.contextPath || null;
    result.versions = readHostVersions(result.context?.pluginRoot || this.pluginRootOption, result.context?.resourceRoot);
    result.pluginVersion = result.versions.plugin;
    result.runtimeVersion = result.versions.runtimeApi;
    result.resourceVersion = result.versions.resource;
    result.workspaceReady = Boolean(result.capabilities?.workspaceRoot && result.capabilities?.canWriteWorkspace);
    result.workspaceTrusted = this.env.HARNESS_WORKSPACE_TRUSTED == null
      ? null
      : boolValue(this.env.HARNESS_WORKSPACE_TRUSTED, true);
    if (this._lastContext?.workspaceRoot) {
      try {
        assertWorkspaceAllowed(this._lastContext);
        result.workspaceAllowed = true;
      } catch (error) {
        result.workspaceAllowed = false;
        result.workspaceError = { code: error.code || ROOT_CONTEXT_ERROR_CODES.INVALID, message: error.message || String(error) };
        result.ok = false;
        if (!result.error) result.error = result.workspaceError;
      }
    } else {
      result.workspaceAllowed = null;
    }
    return result;
  }

  async startBridge({ handler = this.bridgeHandler, ...options } = {}) {
    if (!handler) {
      handler = async () => ({
        ok: false,
        error: "No bridge request handler is configured; use the html-report MCP stdio server directly",
      });
    }
    if (!this.bridge) {
      this.bridge = new LocalBridge({
        ...this.bridgeOptions,
        ...options,
        handler,
        provider: this,
      });
    }
    return this.bridge.start();
  }

  /** Start the built-in bridge backed by the shared MCP dispatcher. */
  async startMcpBridge(options = {}) {
    if (this.bridge) return this.bridge.start();
    const { createMcpBridge } = await import("./bridge-server.mjs");
    this.bridge = createMcpBridge({
      ...this.bridgeOptions,
      ...options,
      provider: this,
    });
    return this.bridge.start();
  }

  async stopBridge() {
    return this.bridge ? this.bridge.stop() : { state: "stopped", transport: "streamable-http", url: null };
  }

  bridgeStatus(options = {}) {
    return this.bridge ? this.bridge.status(options) : { state: "not_started", transport: "streamable-http", url: null };
  }

  supportsNativeStdio() {
    return this.transport === "stdio";
  }

  requiresBridge() {
    return !this.supportsNativeStdio();
  }
}

function readHostVersions(pluginRoot = "", resourceRoot = "") {
  const plugin = readJson(path.join(String(pluginRoot || ""), ".codex-plugin", "plugin.json"));
  const resource = readJson(path.join(String(resourceRoot || pluginRoot || ""), "resource-manifest.json"));
  return {
    plugin: String(plugin?.version || ""),
    runtimeApi: "1",
    resource: String(resource?.contentVersion || resource?.resourceVersion || resource?.version || ""),
  };
}

function readJson(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export class CodexHostAdapter extends HarnessHostAdapter {
  constructor(options = {}) {
    super({
      ...options,
      host: "codex",
      surface: options.surface || "codex",
      supportsLocalUi: options.supportsLocalUi ?? true,
      supportsHooks: true,
      allowLegacyCwd: options.allowLegacyCwd ?? false,
      allowPersistedWorkspace: options.allowPersistedWorkspace ?? false,
      allowUnpersistedContext: options.allowUnpersistedContext ?? false,
      allowDataRootOverride: options.allowDataRootOverride ?? false,
      allowRootOverrides: options.allowRootOverrides ?? false,
    });
  }
}

export class ChatGPTDesktopAdapter extends HarnessHostAdapter {
  constructor(options = {}) {
    const surface = normalizeHostSurface(options.surface || options.env?.HARNESS_SURFACE || options.env?.CHATGPT_SURFACE || "chat", "chatgpt-desktop");
    if (!["chat", "work", "desktop"].includes(surface)) {
      throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `ChatGPT Desktop surface must be chat or work: ${surface}`);
    }
    super({
      ...options,
      host: ["chatgpt", "desktop", "chat", "work"].includes(String(options.host || "").toLowerCase())
        ? "chatgpt-desktop"
        : (options.host || "chatgpt-desktop"),
      surface: surface === "desktop" ? "chat" : surface,
      supportsLocalUi: options.supportsLocalUi ?? true,
      supportsHooks: false,
      allowLegacyCwd: false,
      allowPersistedWorkspace: options.allowPersistedWorkspace ?? false,
      allowUnpersistedContext: options.allowUnpersistedContext ?? true,
      allowDataRootOverride: options.allowDataRootOverride ?? true,
      allowRootOverrides: options.allowRootOverrides ?? true,
    });
    // Chat/Work never depend on Codex Hooks, even when a shared environment
    // happens to advertise a hook capability.
    this._capabilityOverrides.supportsHooks = false;
  }
}

export function createHostAdapter(env = process.env, options = {}) {
  const host = firstValue(options.host, env.HARNESS_HOST, env.CHATGPT_HOST, "codex").toLowerCase();
  const isDesktop = ["chat", "work", "chatgpt", "chatgpt-desktop", "desktop"].includes(host) ||
    ["desktop", "chat", "work"].includes(String(options.surface || env.HARNESS_SURFACE || env.CHATGPT_SURFACE || "").toLowerCase());
  if (isDesktop) return new ChatGPTDesktopAdapter({ ...options, env, surface: options.surface || env.HARNESS_SURFACE || env.CHATGPT_SURFACE || (host === "work" ? "work" : "chat") });
  return new CodexHostAdapter({ ...options, env });
}

export { HarnessHostAdapter };
