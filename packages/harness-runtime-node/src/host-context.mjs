import {
  ROOT_CONTEXT_ERROR_CODES,
  RootContextError,
  normalizeRootContext,
  publicRootContext,
} from "./root-context.mjs";

/**
 * Surfaces are intentionally small and host-neutral.  A desktop Chat/Work
 * invocation uses the same runtime as Codex; only the surface and host
 * capabilities differ.
 */
export const HOST_SURFACES = Object.freeze({
  CODEX: "codex",
  DESKTOP: "desktop",
  CHAT: "chat",
  WORK: "work",
});

export const HOST_CONTEXT_ERROR_CODES = Object.freeze({
  ...ROOT_CONTEXT_ERROR_CODES,
  SURFACE_INVALID: "QDM_HOST_SURFACE_INVALID",
  CAPABILITY_INVALID: "QDM_HOST_CAPABILITY_INVALID",
});

const BOOLEAN_CAPABILITIES = Object.freeze([
  "canWriteWorkspace",
  "canWriteData",
  "supportsLocalUi",
  "supportsHooks",
  "hasStableSessionId",
  "supportsSecretReference",
]);

function invalid(message, code = ROOT_CONTEXT_ERROR_CODES.INVALID) {
  return new RootContextError(code, message);
}

export function normalizeHostSurface(surface, host = "unknown") {
  const value = String(surface || "").trim().toLowerCase();
  if (value && !["codex", "desktop", "chat", "work", "cli"].includes(value)) {
    throw invalid(`surface must be one of codex, desktop, chat, work, cli: ${value}`, HOST_CONTEXT_ERROR_CODES.SURFACE_INVALID);
  }
  if (value === "cli") return "codex";
  if (value) return value;
  const normalizedHost = String(host || "").trim().toLowerCase();
  if (normalizedHost === "codex") return "codex";
  if (normalizedHost === "chatgpt-desktop" || normalizedHost === "chatgpt") return "desktop";
  return "unknown";
}

/**
 * Build the host-facing capability envelope without changing the historical
 * Root Context capability object.  Keeping the two layers separate preserves
 * compatibility with older CLI callers while giving Chat/Work an explicit
 * contract.
 */
export function normalizeHostCapabilities(context = null, overrides = {}) {
  const directCapabilities = context && typeof context === "object" && !context.capabilities &&
    Object.hasOwn(context, "canWriteWorkspace");
  const source = directCapabilities ? { ...context, capabilities: context } : context;
  const rootCapabilities = source?.capabilities && typeof source.capabilities === "object"
    ? source.capabilities
    : {};
  const host = String(overrides.host || source?.host || "unknown").trim() || "unknown";
  const surface = normalizeHostSurface(overrides.surface || source?.surface, host);
  const values = {
    host,
    surface,
    workspaceRoot: String(overrides.workspaceRoot ?? source?.workspaceRoot ?? ""),
    sessionId: String(overrides.sessionId ?? source?.sessionId ?? ""),
    canWriteWorkspace: overrides.canWriteWorkspace ?? rootCapabilities.canWriteWorkspace ?? false,
    canWriteData: overrides.canWriteData ?? rootCapabilities.canWriteData ?? false,
    supportsLocalUi: overrides.supportsLocalUi ?? rootCapabilities.supportsLocalUi ?? (surface === "codex" || surface === "desktop" || surface === "chat" || surface === "work"),
    supportsHooks: overrides.supportsHooks ?? rootCapabilities.supportsHooks ?? (host === "codex"),
    hasStableSessionId: overrides.hasStableSessionId ?? rootCapabilities.hasStableSessionId ?? false,
    supportsSecretReference: overrides.supportsSecretReference ?? rootCapabilities.supportsSecretReference ?? false,
  };
  for (const name of BOOLEAN_CAPABILITIES) {
    if (typeof values[name] !== "boolean") {
      throw invalid(`capabilities.${name} must be boolean`, HOST_CONTEXT_ERROR_CODES.CAPABILITY_INVALID);
    }
  }
  if (values.canWriteWorkspace && !values.workspaceRoot) {
    throw invalid("capabilities.canWriteWorkspace cannot be true without workspaceRoot", HOST_CONTEXT_ERROR_CODES.CAPABILITY_INVALID);
  }
  if (values.hasStableSessionId && !values.sessionId) {
    throw invalid("capabilities.hasStableSessionId cannot be true without sessionId", HOST_CONTEXT_ERROR_CODES.CAPABILITY_INVALID);
  }
  return values;
}

export const buildHostCapabilities = normalizeHostCapabilities;

/** Value object form for hosts that prefer a nominal capability type. */
export class HostCapabilities {
  constructor(context = null, overrides = {}) {
    const directCapabilities = context && typeof context === "object" && !context.pluginRoot && !context.dataRoot &&
      Object.hasOwn(context, "canWriteWorkspace");
    const source = directCapabilities
      ? {
        host: context.host,
        surface: context.surface,
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        capabilities: context,
      }
      : context;
    Object.assign(this, normalizeHostCapabilities(source, overrides));
  }
}

export const createHostCapabilities = (context = null, overrides = {}) =>
  new HostCapabilities(context, overrides);

/**
 * Small synchronous provider interface shared by MCP, hooks and local
 * bridges.  A provider may be backed by a context file, environment envelope,
 * or a host SDK; the core only consumes this interface.
 */
export class HostContextProvider {
  constructor({
    host = "unknown",
    surface = "",
    resolver = null,
    contextResolver = null,
    context = null,
    policyValidator = null,
    capabilities = {},
    diagnosticsProvider = null,
  } = {}) {
    this.host = String(host || "unknown").trim() || "unknown";
    this.surface = normalizeHostSurface(surface, this.host);
    this._resolver = resolver || contextResolver || (() => context);
    this._policyValidator = typeof policyValidator === "function" ? policyValidator : null;
    this._capabilityOverrides = { ...(capabilities || {}) };
    this._diagnosticsProvider = typeof diagnosticsProvider === "function" ? diagnosticsProvider : null;
    this._lastContext = null;
    this._lastError = null;
  }

  setResolver(resolver) {
    if (typeof resolver !== "function") throw invalid("HostContextProvider resolver must be a function");
    this._resolver = resolver;
    return this;
  }

  resolveContext({ requireWorkspace = false } = {}) {
    try {
      const raw = this._resolver({ requireWorkspace });
      if (raw && typeof raw.then === "function") {
        throw invalid("HostContextProvider resolver must return a synchronous Root Context");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new RootContextError(
          ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED,
          "Host Root Context is unavailable; configure the host adapter before invoking Harness Data",
        );
      }
      const input = {
        ...raw,
        host: raw.host || this.host,
        surface: raw.surface || this.surface,
      };
      const context = normalizeRootContext(input, {
        source: `${this.host} ${this.surface} host context`,
        requireWorkspace,
      });
      context.hostCapabilities = normalizeHostCapabilities(context, {
        host: this.host,
        surface: this.surface,
        ...this._capabilityOverrides,
      });
      if (requireWorkspace && this._policyValidator) {
        const allowed = this._policyValidator(context);
        if (allowed === false) {
          throw new RootContextError(
            ROOT_CONTEXT_ERROR_CODES.WORKSPACE_NOT_ALLOWED,
            "Host policy rejected the workspace",
          );
        }
      }
      if (requireWorkspace && !normalizeHostCapabilities(context, {
        host: this.host,
        surface: this.surface,
        ...this._capabilityOverrides,
      }).canWriteWorkspace) {
        throw new RootContextError(
          ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED,
          "Host does not grant workspace write capability",
        );
      }
      this._lastContext = context;
      this._lastError = null;
      return context;
    } catch (error) {
      this._lastContext = null;
      this._lastError = error;
      throw error;
    }
  }

  requireWorkspace() {
    return this.resolveContext({ requireWorkspace: true });
  }

  getSessionId() {
    try {
      return this.resolveContext().sessionId || "";
    } catch {
      return this._lastContext?.sessionId || "";
    }
  }

  getCapabilities() {
    let context = this._lastContext;
    try {
      context = this.resolveContext();
    } catch {
      // Diagnostics and host discovery must remain useful before setup.
    }
    return normalizeHostCapabilities(context, {
      host: this.host,
      surface: this.surface,
      ...this._capabilityOverrides,
    });
  }

  getSecretReference() {
    try {
      return this.resolveContext().secretRef || null;
    } catch {
      return this._lastContext?.secretRef || null;
    }
  }

  diagnostics() {
    let context = this._lastContext;
    let error = this._lastError;
    try {
      context = this.resolveContext();
      error = null;
    } catch (caught) {
      error = caught;
    }
    const result = {
      ok: !error,
      host: this.host,
      surface: this.surface,
      capabilities: this.getCapabilities(),
      context: context ? publicRootContext(context) : null,
      secretReference: context?.secretRef ? { kind: context.secretRef.kind } : null,
      error: error
        ? { code: error.code || ROOT_CONTEXT_ERROR_CODES.INVALID, message: error.message || String(error) }
        : null,
    };
    if (this._diagnosticsProvider) {
      const extra = this._diagnosticsProvider({ context, error });
      if (extra && typeof extra === "object" && !Array.isArray(extra)) Object.assign(result, extra);
    }
    return result;
  }
}

export function createHostContextProvider(options = {}) {
  return new HostContextProvider(options);
}
