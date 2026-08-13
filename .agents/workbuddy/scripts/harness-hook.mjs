#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_TIMEOUT_MS = 8_500;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SHELL_TOOL_NAMES = new Set(["Bash", "PowerShell", "execute_command"]);
export const WORKBUDDY_AUTH_MINIMUM_VERSION = "5.3.11";
export const CODEBUDDY_AUTH_MINIMUM_VERSION = "2.115.0";

class RawJSONNumber {
  constructor(value) {
    this.value = value;
  }
}

export function parseLosslessJSON(text) {
  const source = String(text);
  let markerPrefix = "__QDM_HARNESS_RAW_NUMBER_";
  while (source.includes(markerPrefix)) markerPrefix = `_${markerPrefix}`;
  const numbers = [];
  let protectedJSON = "";
  for (let index = 0; index < source.length;) {
    if (source[index] === '"') {
      const start = index++;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index++] === '"') break;
      }
      protectedJSON += source.slice(start, index);
      continue;
    }
    if (source[index] === "-" || /[0-9]/.test(source[index])) {
      const match = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) {
        const marker = `${markerPrefix}${numbers.length}__`;
        numbers.push(match[0]);
        protectedJSON += JSON.stringify(marker);
        index += match[0].length;
        continue;
      }
    }
    protectedJSON += source[index++];
  }
  return JSON.parse(protectedJSON, (_key, value) => {
    if (typeof value !== "string" || !value.startsWith(markerPrefix) || !value.endsWith("__")) return value;
    const numberIndex = Number.parseInt(value.slice(markerPrefix.length, -2), 10);
    return Number.isInteger(numberIndex) && numbers[numberIndex] !== undefined
      ? new RawJSONNumber(numbers[numberIndex])
      : value;
  });
}

export function stringifyLosslessJSON(value) {
  const markerPrefix = `__QDM_HARNESS_RAW_NUMBER_${randomUUID()}_`;
  const numbers = [];
  let output = JSON.stringify(value, (_key, item) => {
    if (!(item instanceof RawJSONNumber)) return item;
    const marker = `${markerPrefix}${numbers.length}__`;
    numbers.push(item.value);
    return marker;
  });
  for (let index = 0; index < numbers.length; index += 1) {
    output = output.replaceAll(JSON.stringify(`${markerPrefix}${index}__`), numbers[index]);
  }
  return output;
}

function isLosslessDeepEqual(left, right) {
  if (left instanceof RawJSONNumber || right instanceof RawJSONNumber) {
    const leftValue = left instanceof RawJSONNumber ? left.value : (typeof left === "number" ? JSON.stringify(left) : null);
    const rightValue = right instanceof RawJSONNumber ? right.value : (typeof right === "number" ? JSON.stringify(right) : null);
    return leftValue !== null && leftValue === rightValue;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => isLosslessDeepEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
      Object.hasOwn(right, key) && isLosslessDeepEqual(left[key], right[key]));
  }
  return isDeepStrictEqual(left, right);
}

function expectedEvent(mode) {
  if (mode === "authz") return "PreToolUse";
  return mode === "posttool" ? "PostToolUse" : "UserPromptSubmit";
}

export function safeOutput(mode, message) {
  if (mode === "authz") {
    return {
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    };
  }
  return {
    continue: true,
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: expectedEvent(mode),
      additionalContext: message,
    },
  };
}

export function normalizePayload(mode, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const sessionID = typeof payload.session_id === "string" ? payload.session_id.trim() : "";

  if (mode === "context") {
    const rawPrompt = typeof payload.prompt === "string"
      ? payload.prompt
      : (typeof payload.user_prompt === "string" ? payload.user_prompt : "");
    if (!rawPrompt.trim()) return null;
    return { session_id: sessionID, prompt: rawPrompt };
  }

  if (mode === "posttool") {
    const rawToolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
    if (!SHELL_TOOL_NAMES.has(rawToolName)) return null;
    const toolInput = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : {};
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!command.trim()) return null;
    return {
      session_id: sessionID,
      tool_name: "Bash",
      tool_input: { command },
    };
  }

  if (mode === "authz") {
    const rawToolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
    if (!SHELL_TOOL_NAMES.has(rawToolName)) return null;
    const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name.trim() : "";
    if (eventName && eventName !== "PreToolUse") return null;
    const toolInput = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : {};
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!command.trim()) return null;
    const canonical = {
      session_id: sessionID,
      hook_event_name: "PreToolUse",
      tool_name: rawToolName,
      tool_input: { ...toolInput },
    };
    if (typeof payload.cwd === "string") canonical.cwd = payload.cwd;
    return canonical;
  }

  return null;
}

function isDirectory(pathname) {
  try {
    return statSync(pathname).isDirectory();
  } catch {
    return false;
  }
}

function isHarnessRoot(pathname) {
  if (!isDirectory(pathname)) return false;
  const markers = [
    join(pathname, "config", "harness-config.yaml"),
    join(pathname, "config", "harness-paths.yaml"),
    join(pathname, "bootstrap", "cli-manifest.json"),
    join(pathname, "cli", "cmd", "data-harness-cli", "main.go"),
  ];
  return markers.some((marker) => existsSync(marker));
}

export function findHarnessRoot(start) {
  if (!start || typeof start !== "string") return "";
  let current = resolve(start);
  if (!isDirectory(current)) current = dirname(current);
  for (;;) {
    if (isHarnessRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return "";
    current = parent;
  }
}

export function resolveWorkspace(payload, env = process.env) {
  const declared = [
    env.CODEBUDDY_PROJECT_DIR,
    env.CLAUDE_PROJECT_DIR,
    payload && typeof payload.cwd === "string" ? payload.cwd : "",
  ].filter((candidate) => typeof candidate === "string" && candidate.trim());
  const candidates = declared.length > 0 ? declared : [process.cwd()];
  for (const candidate of candidates) {
    const root = findHarnessRoot(candidate);
    if (root) return root;
  }
  return "";
}

export function resolveHarnessCLI(root, env = process.env) {
  const explicit = typeof env.QDM_HARNESS_CLI === "string" ? env.QDM_HARNESS_CLI.trim() : "";
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(root || process.cwd(), explicit);

  const binary = process.platform === "win32" ? "data-harness-cli.exe" : "data-harness-cli";
  const candidates = [
    root ? join(root, "bin", binary) : "",
    join(PLUGIN_ROOT, "..", "..", "bin", binary),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

export function readAuthzMode(root) {
  if (!root) return "unknown";
  try {
    const lines = readFileSync(join(root, "config", "harness-config.yaml"), "utf8").split(/\r?\n/);
    let inAuthz = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) {
        inAuthz = /^authz\s*:\s*(?:#.*)?$/.test(trimmed);
        continue;
      }
      if (!inAuthz) continue;
      const match = trimmed.match(/^mode\s*:\s*["']?(on|off)["']?(?:\s+#.*)?$/i);
      if (match) return match[1].toLowerCase();
    }
  } catch {
    // Unknown configuration must fail closed for authz transport errors.
  }
  return "unknown";
}

function readJSON(pathname) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

function versionAtLeast(actual, minimum) {
  const parseVersion = (value) => String(value || "").trim().replace(/^v(?=\d)/i, "")
    .split(".").map((part) => Number.parseInt(part, 10) || 0);
  const current = parseVersion(actual);
  const required = parseVersion(minimum);
  for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
    if ((current[index] || 0) > (required[index] || 0)) return true;
    if ((current[index] || 0) < (required[index] || 0)) return false;
  }
  return true;
}

function normalizeWorkBuddyAppRoot(value) {
  let candidate = resolve(value);
  const resources = dirname(candidate);
  const parent = dirname(resources);
  if (parse(candidate).base.toLowerCase() === "app.asar" && parse(resources).base.toLowerCase() === "resources") {
    return parse(parent).base.toLowerCase() === "contents" ? dirname(parent) : parent;
  }
  try {
    if (statSync(candidate).isFile()) candidate = dirname(candidate);
  } catch {
    // Missing candidates are ignored by the caller.
  }
  return candidate;
}

export function detectAuthRuntime(env = process.env, platform = process.platform) {
  if (!["darwin", "win32"].includes(platform)) {
    return { supported: false, workBuddyVersion: "", codeBuddyVersion: "" };
  }
  const declared = typeof env.WORKBUDDY_APP_PATH === "string" && env.WORKBUDDY_APP_PATH.trim()
    ? [env.WORKBUDDY_APP_PATH]
    : platform === "win32"
      ? [
          join(env.LOCALAPPDATA || "", "Programs", "WorkBuddy"),
          join(env.LOCALAPPDATA || "", "WorkBuddy"),
          join(env.PROGRAMFILES || "", "WorkBuddy"),
        ]
      : ["/Applications/WorkBuddy.app"];
  let workBuddyVersion = String(env.WORKBUDDY_VERSION || "").trim();
  let codeBuddyVersion = String(env.CODEBUDDY_CLI_VERSION || "").trim();
  for (const declaredRoot of declared.filter(Boolean)) {
    const appRoot = normalizeWorkBuddyAppRoot(declaredRoot);
    const cliRoots = [
      join(appRoot, "Contents", "Resources", "app.asar.unpacked", "cli"),
      join(appRoot, "resources", "app.asar.unpacked", "cli"),
      join(appRoot, "Resources", "app.asar.unpacked", "cli"),
    ];
    for (const cliRoot of cliRoots) {
      const product = readJSON(join(cliRoot, "product.json"));
      const packageJSON = readJSON(join(cliRoot, "package.json"));
      workBuddyVersion ||= String(product?.genieVersion || "").trim();
      codeBuddyVersion ||= String(packageJSON?.publishConfig?.customPackage?.version || "").trim();
    }
    if (workBuddyVersion && codeBuddyVersion) break;
  }
  return {
    supported: Boolean(workBuddyVersion && codeBuddyVersion &&
      versionAtLeast(workBuddyVersion, WORKBUDDY_AUTH_MINIMUM_VERSION) &&
      versionAtLeast(codeBuddyVersion, CODEBUDDY_AUTH_MINIMUM_VERSION)),
    workBuddyVersion,
    codeBuddyVersion,
  };
}

function hookTimeout(env = process.env) {
  const parsed = Number.parseInt(env.QDM_HARNESS_HOOK_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed < 10) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, DEFAULT_TIMEOUT_MS);
}

export function validateHookOutput(mode, stdout, canonicalPayload = null) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  let output;
  try {
    output = parseLosslessJSON(text);
  } catch {
    return null;
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  if (Object.keys(output).length === 0) return {};
  if (mode === "authz") {
    const hook = output.hookSpecificOutput;
    if (!hook || typeof hook !== "object" || Array.isArray(hook)) return null;
    if (hook.hookEventName !== "PreToolUse") return null;
    if (hook.permissionDecision !== "allow" && hook.permissionDecision !== "deny") return null;
    if (output.systemMessage !== undefined && typeof output.systemMessage !== "string") return null;
    if (hook.permissionDecisionReason !== undefined && typeof hook.permissionDecisionReason !== "string") return null;
    if (hook.permissionDecision === "deny") {
      if (!hook.permissionDecisionReason?.trim()) return null;
      if (hook.updatedInput !== undefined) return null;
      return output;
    }
    if (hook.updatedInput === undefined) return null;
    if (!hook.updatedInput || typeof hook.updatedInput !== "object" || Array.isArray(hook.updatedInput)) return null;
    if (typeof hook.updatedInput.command !== "string" || !hook.updatedInput.command.trim()) return null;
    const originalCommand = canonicalPayload?.tool_input?.command;
    const gatedCommand = typeof originalCommand === "string" &&
      /(?:qdm-metric-cli(?:\.exe)?|%QDM_METRIC_CLI%|\$env:QDM_METRIC_CLI|\$\{?QDM_METRIC_CLI(?::-[^}]*)?\}?)/i.test(originalCommand) &&
      /(?:analysis\s+execute|auth\s+describe)/i.test(originalCommand);
    if (gatedCommand && hook.updatedInput.command === originalCommand) return null;
    // Direct injection intentionally matches the merged macOS WorkBuddy
    // contract. The encrypted Blob is required in updatedInput.command.
    const original = canonicalPayload?.tool_input || {};
    for (const [key, value] of Object.entries(original)) {
      if (key === "command") continue;
      if (!(key in hook.updatedInput) || !isLosslessDeepEqual(hook.updatedInput[key], value)) return null;
    }
    return output;
  }
  if (typeof output.continue !== "boolean") return null;
  if (output.systemMessage !== undefined && typeof output.systemMessage !== "string") return null;
  const hook = output.hookSpecificOutput;
  if (!hook || typeof hook !== "object") return null;
  if (hook.hookEventName !== expectedEvent(mode) || typeof hook.additionalContext !== "string") return null;
  return output;
}

export function runCanonicalHook(mode, canonicalPayload, root, env = process.env) {
  const authzMode = mode === "authz" ? readAuthzMode(root) : "off";
  const failureOutput = (message) => mode === "authz" && authzMode === "off" ? {} : safeOutput(mode, message);
  const cli = resolveHarnessCLI(root, env);
  if (!cli || !existsSync(cli)) {
    const code = mode === "authz" ? "QDM_AUTHZ_HOOK_UNAVAILABLE" : "QDM_HARNESS_UNAVAILABLE";
    return failureOutput(
      `${code}: data-harness-cli is missing or not executable for this WorkBuddy project. ` +
        "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates until Harness is repaired.",
    );
  }

  const command = mode === "authz" ? "authz-hook" : (mode === "posttool" ? "posttool" : "context");
  const args = mode === "authz" ? [command, "--agent", "workbuddy"] : [command, "--format", "workbuddy-hook"];
  const result = spawnSync(cli, args, {
    cwd: root,
    env: { ...env, CODEBUDDY_PROJECT_DIR: root },
    input: `${stringifyLosslessJSON(canonicalPayload)}\n`,
    encoding: "utf8",
    timeout: hookTimeout(env),
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT" ? "timed out" : "failed";
    const code = mode === "authz" ? "QDM_AUTHZ_HOOK_UNAVAILABLE" : "QDM_HARNESS_UNAVAILABLE";
    process.stderr.write(`[qdm-harness] data-harness-cli ${command} ${reason}\n`);
    return failureOutput(
      `${code}: WorkBuddy Harness ${command} ${reason}. ` +
        "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
    );
  }

  const output = validateHookOutput(mode, result.stdout, canonicalPayload);
  if (output) {
    if (mode === "authz" && output.hookSpecificOutput?.permissionDecision === "deny" && !output.systemMessage) {
      output.systemMessage = output.hookSpecificOutput.permissionDecisionReason;
    }
    const noDecision = mode === "authz" && Object.keys(output).length === 0;
    const commandText = canonicalPayload?.tool_input?.command || "";
    const authEnvPresent = ["HARNESS_AUTH_BLOB", "HARNESS_AUTH_BLOB_FILE", "HARNESS_AUTH_USER_ID", "LUMI_REQUESTER_CONTEXT_DIR"]
      .some((key) => typeof env[key] === "string" && env[key].trim());
    const gatedMarker = /(?:qdm-metric-cli(?:\.exe)?|%QDM_METRIC_CLI%|\$env:QDM_METRIC_CLI|\$\{?QDM_METRIC_CLI(?::-[^}]*)?\}?)/i;
    const gatedCommand = gatedMarker.test(commandText) && /(?:analysis\s+execute|auth\s+describe)/i.test(commandText);
    if (!noDecision || authzMode === "off" || (!gatedCommand && !authEnvPresent)) return output;
  }
  process.stderr.write(`[qdm-harness] data-harness-cli ${command} returned invalid JSON\n`);
  const code = mode === "authz" ? "QDM_AUTHZ_HOOK_UNAVAILABLE" : "QDM_HARNESS_UNAVAILABLE";
  return failureOutput(
    `${code}: WorkBuddy Harness ${command} returned an invalid response. ` +
      "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
  );
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function emit(output) {
  process.stdout.write(`${stringifyLosslessJSON(output)}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const mode = argv[0];
  if (mode !== "context" && mode !== "posttool" && mode !== "authz") {
    emit({});
    return;
  }

  let payload;
  try {
    const raw = await readStdin();
    payload = raw.trim() ? parseLosslessJSON(raw) : {};
  } catch {
    if (mode !== "authz") {
      emit({});
      return;
    }
    const root = resolveWorkspace({}, env);
    emit(!root || readAuthzMode(root) === "off"
      ? {}
      : safeOutput("authz", "QDM_AUTHZ_INPUT_INVALID: WorkBuddy provided invalid PreToolUse JSON"));
    return;
  }

  let root = "";
  if (mode === "authz") {
    root = resolveWorkspace(payload, env);
    if (!root || readAuthzMode(root) === "off") {
      emit({});
      return;
    }
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
    if (toolName && !SHELL_TOOL_NAMES.has(toolName)) {
      emit({});
      return;
    }
  }
  const canonical = normalizePayload(mode, payload);
  if (!canonical) {
    emit(mode === "authz" ? safeOutput("authz", "QDM_AUTHZ_INPUT_INVALID: WorkBuddy provided an incomplete PreToolUse payload") : {});
    return;
  }
  if (!root) root = resolveWorkspace(payload, env);
  if (!root) {
    // The plugin may be enabled globally; outside a Harness workspace it must
    // not change ordinary WorkBuddy behavior.
    emit({});
    return;
  }
  const output = runCanonicalHook(mode, canonical, root, env);
  if (mode === "authz" && Object.keys(output).length > 0 && !detectAuthRuntime(env).supported) {
    emit(safeOutput(
      mode,
      `QDM_AUTHZ_RUNTIME_UNSUPPORTED: WorkBuddy ${WORKBUDDY_AUTH_MINIMUM_VERSION}+ with CodeBuddy CLI ${CODEBUDDY_AUTH_MINIMUM_VERSION}+ is required for auth command rewriting.`,
    ));
    return;
  }
  emit(output);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  const failedMode = ["context", "posttool", "authz"].includes(process.argv[2]) ? process.argv[2] : "context";
  main().catch(() => {
    if (failedMode === "authz") {
      const root = resolveWorkspace({}, process.env);
      if (!root || readAuthzMode(root) === "off") {
        emit({});
        return;
      }
    }
    emit(safeOutput(
      failedMode,
      `${failedMode === "authz" ? "QDM_AUTHZ_HOOK_UNAVAILABLE" : "QDM_HARNESS_UNAVAILABLE"}: The WorkBuddy Harness adapter failed unexpectedly. ` +
        "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
    ));
  });
}
