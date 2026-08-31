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
