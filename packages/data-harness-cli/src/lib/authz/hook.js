import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import { authzEnabled, loadConfig, normalizeResolverOwners } from "../harness.js";
import { assertWorkspaceAllowed } from "../workspace-policy.js";
import { resolveAuthBlob } from "./auth-blob.js";
import {
  ADAPTER_ALLOW,
  ADAPTER_DENY,
  ADAPTER_DISABLED,
  ADAPTER_NOOP,
  ADAPTER_SCHEMA_VERSION,
  AUTH_SOURCE_ENV_KEYS,
  SHELL_BASH,
  SHELL_CMD,
  SHELL_POWERSHELL,
} from "./constants.js";
import { authSourceEnvPresent, scrubAuthSourceEnvCommand, scrubAuthSourceEnvPowerShellCommand } from "./env.js";
import {
  commandHasModelAuthFlags,
  isMetricAuthDescribe,
  isMetricAuthzGatedCommand,
  looksLikeGatedMetricCommand,
  metricInvocationCount,
  rewriteGatedMetricCommands,
} from "./metric-command.js";
import {
  isPowerShellMetricAuthDescribe,
  isPowerShellMetricAuthzGatedCommand,
  powerShellCommandHasModelAuthFlags,
  powerShellMetricInvocationCount,
} from "./powershell-command.js";

export function run(rootOrContext, agent, input) {
  const cfg = loadConfig(rootOrContext);
  const resourceRoot = normalizeResolverOwners(rootOrContext).resourceRoot;
  if (!authzEnabled(cfg.authz)) {
    return { ok: false, output: emptyHookOutput() };
  }
  return runEnabled(cfg, resourceRoot, agent, input, false, rootOrContext);
}

export function runAdapterEnvelope(rootOrContext, agent, input) {
  const cfg = loadConfig(rootOrContext);
  const resourceRoot = normalizeResolverOwners(rootOrContext).resourceRoot;
  if (!authzEnabled(cfg.authz)) {
    return adapterEnvelope(ADAPTER_DISABLED, {});
  }
  const { ok, output } = runEnabled(cfg, resourceRoot, agent, input, true, rootOrContext);
  if (!ok) return adapterEnvelope(ADAPTER_NOOP, {});
  const decision = output.hookSpecificOutput.permissionDecision;
  if (decision === "allow") return adapterEnvelope(ADAPTER_ALLOW, output);
  if (decision === "deny") return adapterEnvelope(ADAPTER_DENY, output);
  throw new Error(`unsupported authorization decision: ${JSON.stringify(decision)}`);
}

function adapterEnvelope(status, output) {
  return { schemaVersion: ADAPTER_SCHEMA_VERSION, status, hookOutput: output };
}

// authz-v2 携带授权的维度, 预检校验请求值是否在授权范围内。
// 不在契约里的维度(如 storeId) 原样透传, 门店链约束由 qdm-metric-cli 兜底。
const QWENPAW_SCOPE_DIMENSIONS = Object.freeze({
  categoryLevel1Id: { code: "QDM_CATEGORY_OUTSIDE_DATA_SCOPE", message: "请求的商品分类不在当前用户授权范围内" },
  sapArea2Id: { code: "QDM_AREA_OUTSIDE_DATA_SCOPE", message: "请求的管理区域不在当前用户授权范围内" },
  dcSapArea2Id: { code: "QDM_AREA_OUTSIDE_DATA_SCOPE", message: "请求的管理区域不在当前用户授权范围内" },
});

/**
 * QwenPaw has no shell tools, so the adapter authorizes the structured
 * qdm_query payload directly: the decision, the authorized scope and the
 * normalized (label-to-id) filters are produced by the JS CLI and returned
 * in one envelope.  The Python bridge only executes the analysis afterwards.
 */
export function runQwenPawAdapterEnvelope(rootOrContext, input) {
  const cfg = loadConfig(rootOrContext);
  if (!authzEnabled(cfg.authz)) {
    return adapterEnvelope(ADAPTER_DISABLED, {});
  }
  const payload = parseQwenPawPayload(input);
  if (!payload.ok) {
    return adapterEnvelope(ADAPTER_DENY, denyOutput("QDM_AUTHZ_INPUT_INVALID: QwenPaw provided invalid PreToolUse JSON"));
  }
  if (payload.toolName !== "qdm_query") {
    return adapterEnvelope(ADAPTER_DENY, denyOutput("QDM_AUTHZ_TOOL_UNSUPPORTED: only qdm_query is authorized through the QwenPaw adapter"));
  }
  const query = payload.toolInput || {};
  if (typeof query !== "object" || Array.isArray(query)) {
    return adapterEnvelope(ADAPTER_DENY, denyOutput("QDM_AUTHZ_INPUT_INVALID: QwenPaw qdm_query toolInput must be an object"));
  }
  let metricCliPath;
  try {
    metricCliPath = resolveMetricCLIPath(rootOrContext, cfg);
  } catch {
    return adapterEnvelope(ADAPTER_DENY, denyOutput("QDM_AUTHZ_CLI_UNAVAILABLE: authz mode is on but no trusted qdm-metric-cli is available"));
  }
  const blob = String(payload.blob || "").trim();
  if (!/^qdm1enc\.[A-Za-z0-9_-]+$/.test(blob)) {
    return adapterEnvelope(ADAPTER_DENY, denyOutput("QDM_AUTHZ_BLOB_INVALID: the QwenPaw adapter requires a valid per-requester auth blob"));
  }
  let scope;
  try {
    scope = describeScope(metricCliPath, blob);
  } catch (error) {
    if (error?.qdmCode) {
      return adapterEnvelope(ADAPTER_DENY, denyOutput(`${error.qdmCode}: ${error.qdmMessage}`));
    }
    const code = /AUTH_BLOB|DECRYPT/i.test(String(error?.message || "")) ? "QDM_CHANNEL_AUTH_DENIED" : "QDM_AUTHZ_DESCRIBE_FAILED";
    return adapterEnvelope(ADAPTER_DENY, denyOutput(`${code}: ${safeDiagnostic(error)}`));
  }
  if (!scope.enabled) {
    return adapterEnvelope(ADAPTER_DENY, denyOutput("QDM_AUTH_CAPABILITY_DENIED: 当前用户没有 QDM 数据查询权限"));
  }
  if (!scope.capabilities.includes("qdm.metric.query")) {
    return adapterEnvelope(ADAPTER_DENY, denyOutput("QDM_AUTH_CAPABILITY_DENIED: 当前用户没有 QDM 数据查询权限"));
  }
  let normalized;
  try {
    normalized = normalizeQwenPawFilters(query.filters, scope);
  } catch (error) {
    if (error?.qdmCode) {
      return adapterEnvelope(ADAPTER_DENY, denyOutput(`${error.qdmCode}: ${error.qdmMessage}`));
    }
    throw error;
  }
  return adapterEnvelope(ADAPTER_ALLOW, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      scope: {
        enabled: scope.enabled,
        capabilities: scope.capabilities,
        labelsResolved: scope.labelsResolved,
        dataScope: scope.dataScope,
      },
      normalizedFilters: normalized,
    },
  });
}

function parseQwenPawPayload(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  try {
    const raw = JSON.parse(text);
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
    return {
      ok: true,
      toolName: String(raw.tool_name || raw.toolName || "").trim(),
      blob: String(raw.blob || raw.auth_blob || "").trim(),
      toolInput: raw.tool_input || raw.toolInput,
    };
  } catch {
    return { ok: false };
  }
}

function describeScope(metricCliPath, blob) {
  const result = spawnSync(metricCliPath, ["auth", "describe", "--auth-blob", blob], {
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `auth describe exited ${result.status}`);
  }
  const parsed = parseSafeJSON(result.stdout);
  if (!parsed || parsed.enabled !== true) throw new Error("auth describe did not return an enabled scope");
  const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((item) => typeof item === "string") : [];
  const dataScope = normalizeScopeEntries(parsed.dataScope);
  if (!Object.keys(dataScope).length) throw new QwenPawDeny("QDM_EMPTY_DATA_SCOPE", "当前用户的数据授权范围为空或未配置完整");
  return {
    enabled: true,
    capabilities,
    labelsResolved: parsed.labelsResolved !== false,
    dataScope,
  };
}

function normalizeScopeEntries(dataScope) {
  const scope = {};
  if (!dataScope || typeof dataScope !== "object" || Array.isArray(dataScope)) return scope;
  for (const [dimension, entries] of Object.entries(dataScope)) {
    if (!Array.isArray(entries)) continue;
    const normalized = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = String(entry.id || "").trim();
      if (id) normalized.push({ id, name: String(entry.name || "").trim() });
    }
    if (normalized.length) scope[dimension] = normalized;
  }
  return scope;
}

class QwenPawDeny extends Error {
  constructor(code, message) {
    super(message);
    this.qdmCode = code;
    this.qdmMessage = message;
  }
}

function normalizeQwenPawFilters(filters, scope) {
  if (filters == null || typeof filters !== "object" || Array.isArray(filters)) return null;
  const normalized = {};
  for (const [dimension, values] of Object.entries(filters)) {
    if (!Array.isArray(values)) continue;
    const contract = QWENPAW_SCOPE_DIMENSIONS[dimension];
    if (!contract) {
      normalized[dimension] = values.map(String);
      continue;
    }
    const entries = scope.dataScope[dimension];
    if (!entries || !entries.length) {
      throw new QwenPawDeny(contract.code, contract.message);
    }
    const result = [];
    for (const raw of values) {
      const value = String(raw);
      const byId = entries.find((entry) => value === entry.id);
      if (byId) {
        result.push(value);
        continue;
      }
      const byName = entries.filter((entry) => value === entry.name);
      if (byName.length !== 1) {
        throw new QwenPawDeny(contract.code, contract.message);
      }
      result.push(byName[0].id);
    }
    if (new Set(result).size !== result.length) {
      throw new QwenPawDeny("QDM_FILTER_VALUE_INVALID", "筛选值重复");
    }
    normalized[dimension] = result;
  }
  return normalized;
}

function parseSafeJSON(text) {
  try {
    const value = JSON.parse(String(text || ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function safeDiagnostic(error) {
  const text = String(error?.message || error || "").replace(/qdm1enc\.[A-Za-z0-9_-]+/g, "[REDACTED]");
  return text.slice(0, 200);
}

function emptyHookOutput() {
  return { hookSpecificOutput: { hookEventName: "", permissionDecision: "" } };
}

function runEnabled(cfg, root, agent, input, strictInput, rootContext = null) {
  const parsed = parseHookPayload(input);
  if (!parsed.ok) {
    if (!strictInput) return { ok: false, output: emptyHookOutput() };
    return { ok: true, output: denyOutput("QDM_AUTHZ_INPUT_INVALID: WorkBuddy provided invalid PreToolUse JSON") };
  }
  const payload = parsed.payload;
  const toolName = String(payload.toolName || "").trim().toLowerCase();
  const command = payload.toolInput?.command;
  const workspaceDecision = checkWorkspacePolicy(rootContext, payload);
  if (workspaceDecision === "denied") {
    if (typeof command === "string" && looksLikeGatedMetricCommand(command)) {
      return { ok: true, output: denyOutput("QDM_WORKSPACE_NOT_ALLOWED: the current workspace is not in the Harness Data allowlist") };
    }
    return { ok: false, output: emptyHookOutput() };
  }
  if (workspaceDecision === "unavailable" && typeof command === "string" && looksLikeGatedMetricCommand(command)) {
    return { ok: true, output: denyOutput("QDM_SETUP_REQUIRED: configure the Harness Data workspace allowlist before using QDM data commands") };
  }
  if (
    String(agent || "").trim().toLowerCase() === "workbuddy" &&
    toolName !== "" &&
    toolName !== "bash" &&
    toolName !== "powershell" &&
    toolName !== "execute_command"
  ) {
    return { ok: false, output: emptyHookOutput() };
  }
  const { dialect, accepted } = resolveDialect(agent, payload.toolName, payload.toolInput);
  if (!accepted) {
    throw new Error(`unsupported authz agent: ${agent}`);
  }
  if (payload.hookEventName && payload.hookEventName !== "PreToolUse") {
    if (!strictInput) return { ok: false, output: emptyHookOutput() };
    return { ok: true, output: denyOutput("QDM_AUTHZ_INPUT_INVALID: WorkBuddy provided an invalid PreToolUse event") };
  }
  if (typeof command !== "string" || !command.trim()) {
    if (!strictInput) return { ok: false, output: emptyHookOutput() };
    return { ok: true, output: denyOutput("QDM_AUTHZ_INPUT_INVALID: WorkBuddy provided an incomplete PreToolUse payload") };
  }
  if (!dialect) {
    if (authSourceEnvPresent() || looksLikeGatedMetricCommand(command)) {
      return { ok: true, output: denyOutput("QDM_AUTHZ_DIALECT_UNSUPPORTED: the command executor cannot be authorized safely") };
    }
    return { ok: false, output: emptyHookOutput() };
  }

  if (!isMetricAuthzGatedCommandFor(dialect, command)) {
    if (looksLikeGatedMetricCommand(command)) {
      if (String(agent || "").trim().toLowerCase() === "workbuddy" && dialect === SHELL_POWERSHELL) {
        return {
          ok: true,
          output: denyOutput(
            "QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED: Windows WorkBuddy PowerShell sandbox cannot return command output reliably; retry with the Bash tool",
          ),
        };
      }
      return {
        ok: true,
        output: denyOutput("QDM_AUTHZ_COMMAND_UNSUPPORTED: the QDM data command shape cannot be authorized safely"),
      };
    }
    if (authSourceEnvPresent()) {
      return {
        ok: true,
        output: allowOutput(
          replaceCommand(payload.toolInput, scrubAuthSourceEnvCommandFor(dialect, command)),
          "Auth source environment scrubbed for non-gated shell command",
        ),
      };
    }
    return { ok: false, output: emptyHookOutput() };
  }
  if (metricInvocationCountFor(dialect, command) !== 1) {
    return {
      ok: true,
      output: denyOutput("QDM_AUTHZ_COMMAND_AMBIGUOUS: split multiple or ambiguous QDM data invocations into separate tool calls"),
    };
  }
  if (String(agent || "").trim().toLowerCase() === "workbuddy" && dialect === SHELL_POWERSHELL) {
    return {
      ok: true,
      output: denyOutput(
        "QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED: Windows WorkBuddy PowerShell sandbox cannot return command output reliably; retry with the Bash tool",
      ),
    };
  }

  let resolved;
  try {
    resolved = resolveAuthBlob({ projectRoot: root, config: cfg.authz, secretRef: rootContext?.secretRef });
  } catch (error) {
    return { ok: true, output: denyOutput(missingAuthReason(dialect, command, cfg.authz, error)) };
  }

  let metricCliPath;
  try {
    metricCliPath = resolveMetricCLIPath(rootContext || root, cfg);
  } catch {
    return {
      ok: true,
      output: denyOutput("QDM_AUTHZ_CLI_UNAVAILABLE: authz mode is on but no trusted qdm-metric-cli is available"),
    };
  }

  let rewritten;
  try {
    const authArgument = process.platform === "win32" || !resolved.sourcePath ? resolved.blob : resolved.sourcePath;
    rewritten = rewriteGatedMetricCommands(command, authArgument, metricCliPath, dialect);
  } catch {
    rewritten = "";
  }
  if (!rewritten.trim() || rewritten === command) {
    return {
      ok: true,
      output: denyOutput("QDM_AUTHZ_REWRITE_FAILED: refusing to execute a QDM data command whose authorization could not be rewritten safely"),
    };
  }
  if (authSourceEnvPresent()) {
    rewritten = scrubAuthSourceEnvCommandFor(dialect, rewritten);
  }
  return {
    ok: true,
    output: allowOutput(replaceCommand(payload.toolInput, rewritten), "Configured authorization is bound to this QDM data command"),
  };
}

function resolveDialect(agent, toolName, toolInput) {
  agent = String(agent || "").trim().toLowerCase();
  const tool = String(toolName || "").trim().toLowerCase();
  if (agent !== "codex" && agent !== "workbuddy") {
    return { dialect: "", accepted: false };
  }
  if (agent === "codex") {
    const command = typeof toolInput?.command === "string" ? toolInput.command : "";
    const { dialect, supported } = shellDialect(toolName, command);
    if (!supported) return { dialect: "", accepted: true };
    return { dialect, accepted: true };
  }
  if (agent === "workbuddy" && tool !== "bash" && tool !== "powershell" && tool !== "execute_command") {
    return { dialect: "", accepted: true };
  }
  if (tool === "powershell") return { dialect: SHELL_POWERSHELL, accepted: true };
  for (const key of ["shell", "shell_name", "executor"]) {
    const value = String(toolInput?.[key] || "").trim().toLowerCase();
    if (value.includes("powershell") || value.includes("pwsh")) {
      return { dialect: SHELL_POWERSHELL, accepted: true };
    }
    if (value === "bash" || value === "sh" || value.includes("git-bash")) {
      return { dialect: SHELL_BASH, accepted: true };
    }
    if (value === "cmd" || value.includes("cmd.exe")) {
      return { dialect: "", accepted: true };
    }
  }
  if (tool === "bash") return { dialect: SHELL_BASH, accepted: true };
  return { dialect: "", accepted: true };
}

function isMetricAuthzGatedCommandFor(dialect, command) {
  if (dialect === SHELL_POWERSHELL) return isPowerShellMetricAuthzGatedCommand(command);
  return isMetricAuthzGatedCommand(command);
}

function shellDialect(toolName, command) {
  if (process.platform !== "win32") return { dialect: SHELL_BASH, supported: true };
  const normalizedTool = String(toolName || "").trim().toLowerCase();
  if (/^\s*cmd(?:\.exe)?\s+\/(?:c|k)\b/i.test(command)) {
    return { dialect: SHELL_CMD, supported: true };
  }
  switch (normalizedTool) {
    case "bash":
    case "git bash":
    case "shell":
    case "sh":
      return { dialect: SHELL_BASH, supported: true };
    case "powershell":
    case "pwsh":
    case "powershell.exe":
    case "shell_command":
    case "functions.shell_command":
      return { dialect: SHELL_POWERSHELL, supported: true };
    case "cmd":
    case "cmd.exe":
    case "command prompt":
    case "commandprompt":
      return { dialect: SHELL_CMD, supported: true };
    default:
      return { dialect: "", supported: false };
  }
}

function metricInvocationCountFor(dialect, command) {
  if (dialect === SHELL_POWERSHELL) return powerShellMetricInvocationCount(command);
  return metricInvocationCount(command);
}

function scrubAuthSourceEnvCommandFor(dialect, command) {
  if (dialect === SHELL_POWERSHELL) return scrubAuthSourceEnvPowerShellCommand(command);
  if (dialect === SHELL_CMD) {
    const parts = AUTH_SOURCE_ENV_KEYS.map((key) => `set "${key}="`);
    return `${parts.join(" && ")} && ${command}`;
  }
  return scrubAuthSourceEnvCommand(command);
}

function parseHookPayload(input) {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
  try {
    const raw = JSON.parse(text);
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
    const toolInput = raw.tool_input && typeof raw.tool_input === "object" ? raw.tool_input : undefined;
    return {
      ok: true,
      payload: {
        hookEventName: typeof raw.hook_event_name === "string" ? raw.hook_event_name : "",
        toolName: typeof raw.tool_name === "string" ? raw.tool_name : "",
        cwd: typeof raw.cwd === "string" ? raw.cwd : (typeof raw.workspace_root === "string" ? raw.workspace_root : ""),
        toolInput,
      },
    };
  } catch {
    return { ok: false };
  }
}

function checkWorkspacePolicy(rootContext, payload) {
  if (!rootContext || typeof rootContext !== "object" || !rootContext.pluginRoot) return "ok";
  const workspaceRoot = String(payload?.cwd || rootContext.workspaceRoot || process.env.HARNESS_WORKSPACE_ROOT || process.cwd()).trim();
  if (!workspaceRoot) return "unavailable";
  try {
    assertWorkspaceAllowed({ ...rootContext, workspaceRoot });
    return "ok";
  } catch (error) {
    if (error?.code === "QDM_WORKSPACE_NOT_ALLOWED") return "denied";
    if (error?.code === "QDM_SETUP_REQUIRED") return "unavailable";
    throw error;
  }
}

function allowOutput(updated, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
      updatedInput: updated,
    },
  };
}

function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function replaceCommand(input, command) {
  return { ...(input || {}), command };
}

function missingAuthReason(dialect, command, cfg, sourceErr) {
  let hasModelFlags = commandHasModelAuthFlags(command);
  if (dialect === SHELL_POWERSHELL) hasModelFlags = powerShellCommandHasModelAuthFlags(command);
  if (cfg && cfg.allowLocalBlob === false && hasModelFlags) {
    return "QDM_AUTHZ_SOURCE_MISSING: refusing model-supplied --auth-blob or related authorization flags while local authorization is disabled";
  }
  if (sourceErr) {
    const reason = String(sourceErr.message || sourceErr);
    if (
      reason.includes("must be an encrypted qdm1enc blob") ||
      reason.includes("must contain a qdm1enc blob") ||
      reason.includes("auth blob file is empty") ||
      reason.includes("auth blob file must be a regular file")
    ) {
      return "QDM_AUTHZ_SOURCE_INVALID: the configured authorization source is invalid";
    }
  }
  let isDescribe = isMetricAuthDescribe(command);
  if (dialect === SHELL_POWERSHELL) isDescribe = isPowerShellMetricAuthDescribe(command);
  if (isDescribe) {
    return "QDM_AUTHZ_SOURCE_MISSING: authz mode is on but no encrypted auth blob is bound with an explicit user ID; cannot run qdm-metric-cli auth describe";
  }
  return "QDM_AUTHZ_SOURCE_MISSING: authz mode is on but no encrypted auth blob is bound with an explicit user ID; cannot run qdm-metric-cli analysis execute";
}

export function resolveMetricCLIPath(root, cfg) {
  const candidates = [];
  const envPath = String(process.env.QDM_METRIC_CLI || "").trim();
  if (envPath) candidates.push(envPath);
  if (cfg?.cli?.qdmMetricCli) candidates.push(resolveProjectPath(root, cfg.cli.qdmMetricCli));
  let metricName = "qdm-metric-cli";
  if (process.platform === "win32") metricName += ".exe";
  const context = root && typeof root === "object" ? root : null;
  if (context?.pluginRoot) candidates.push(path.join(context.pluginRoot, "runtimes", runtimePlatformKey(), metricName));
  candidates.push(path.join(root && typeof root === "string" ? root : context?.pluginRoot || "", "bin", metricName));
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate);
      if (!info.isFile()) continue;
      if (process.platform !== "win32") {
        try {
          accessSync(candidate, constants.X_OK);
        } catch {
          continue;
        }
      }
      return path.resolve(candidate);
    } catch {
      // try next
    }
  }
  throw new Error("configured and runtime CLI paths are missing or not executable");
}

function runtimePlatformKey() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-amd64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-amd64";
  if (process.platform === "win32" && process.arch === "arm64") return "windows-arm64";
  return `${process.platform}-${process.arch}`;
}

function resolveProjectPath(root, value) {
  if (path.isAbsolute(value) || value.startsWith("/")) return value;
  const base = root && typeof root === "object" ? (root.pluginRoot || root.resourceRoot || root.dataRoot) : root;
  return path.join(base || "", value);
}

export function toGoHookJSON(output) {
  if (!output?.hookSpecificOutput) return output;
  const hook = output.hookSpecificOutput;
  const body = {
    hookEventName: hook.hookEventName,
    permissionDecision: hook.permissionDecision,
  };
  if (hook.permissionDecisionReason) body.permissionDecisionReason = hook.permissionDecisionReason;
  if (hook.updatedInput) body.updatedInput = hook.updatedInput;
  return { hookSpecificOutput: body };
}

export function toGoEnvelopeJSON(envelope) {
  return {
    schemaVersion: envelope.schemaVersion,
    status: envelope.status,
    hookOutput: envelope.hookOutput && envelope.hookOutput.hookSpecificOutput
      ? toGoHookJSON(envelope.hookOutput)
      : envelope.hookOutput,
  };
}
