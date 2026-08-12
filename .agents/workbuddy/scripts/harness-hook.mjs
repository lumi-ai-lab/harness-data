#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_TIMEOUT_MS = 8_500;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SHELL_TOOL_NAMES = new Set(["Bash", "PowerShell", "execute_command"]);

function expectedEvent(mode) {
  return mode === "posttool" ? "PostToolUse" : "UserPromptSubmit";
}

export function safeOutput(mode, message) {
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

function hookTimeout(env = process.env) {
  const parsed = Number.parseInt(env.QDM_HARNESS_HOOK_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed < 10) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, DEFAULT_TIMEOUT_MS);
}

function validateHookOutput(mode, stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  let output;
  try {
    output = JSON.parse(text);
  } catch {
    return null;
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  if (Object.keys(output).length === 0) return {};
  if (typeof output.continue !== "boolean") return null;
  if (output.systemMessage !== undefined && typeof output.systemMessage !== "string") return null;
  const hook = output.hookSpecificOutput;
  if (!hook || typeof hook !== "object") return null;
  if (hook.hookEventName !== expectedEvent(mode) || typeof hook.additionalContext !== "string") return null;
  return output;
}

export function runCanonicalHook(mode, canonicalPayload, root, env = process.env) {
  const cli = resolveHarnessCLI(root, env);
  if (!cli || !existsSync(cli)) {
    return safeOutput(
      mode,
      "QDM_HARNESS_UNAVAILABLE: data-harness-cli is missing or not executable for this WorkBuddy project. " +
        "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates until Harness is repaired.",
    );
  }

  const command = mode === "posttool" ? "posttool" : "context";
  const result = spawnSync(cli, [command, "--format", "workbuddy-hook"], {
    cwd: root,
    env: { ...env, CODEBUDDY_PROJECT_DIR: root },
    input: `${JSON.stringify(canonicalPayload)}\n`,
    encoding: "utf8",
    timeout: hookTimeout(env),
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT" ? "timed out" : "failed";
    process.stderr.write(`[qdm-harness] data-harness-cli ${command} ${reason}\n`);
    return safeOutput(
      mode,
      `QDM_HARNESS_UNAVAILABLE: WorkBuddy Harness ${command} ${reason}. ` +
        "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
    );
  }

  const output = validateHookOutput(mode, result.stdout);
  if (output) return output;
  process.stderr.write(`[qdm-harness] data-harness-cli ${command} returned invalid JSON\n`);
  return safeOutput(
    mode,
    `QDM_HARNESS_UNAVAILABLE: WorkBuddy Harness ${command} returned an invalid response. ` +
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
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const mode = argv[0];
  if (mode !== "context" && mode !== "posttool") {
    emit({});
    return;
  }

  let payload;
  try {
    const raw = await readStdin();
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    emit({});
    return;
  }

  const canonical = normalizePayload(mode, payload);
  if (!canonical) {
    emit({});
    return;
  }
  const root = resolveWorkspace(payload, env);
  if (!root) {
    // The plugin may be enabled globally; outside a Harness workspace it must
    // not change ordinary WorkBuddy behavior.
    emit({});
    return;
  }
  emit(runCanonicalHook(mode, canonical, root, env));
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch(() => emit(safeOutput(
    process.argv[2] === "posttool" ? "posttool" : "context",
    "QDM_HARNESS_UNAVAILABLE: The WorkBuddy Harness adapter failed unexpectedly. " +
      "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
  )));
}
