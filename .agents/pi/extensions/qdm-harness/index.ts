import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAsyncCommand } from "./async-cli.mjs";
import { loadAuthzConfig, resolveAuthBlob, resolveMetricCliPath } from "./authz-config.mjs";
import { applyAuthzToToolCall } from "./authz-inject.mjs";
import { AuthzStateStore } from "./authz-store.mjs";
import { appendHarnessContext, ContextCache, latestUserMessage } from "./context-cache.mjs";

type JsonObject = Record<string, unknown>;

interface PiExtensionContext {
  cwd?: string;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}

interface PiContextEvent {
  messages?: unknown[];
  /** Host may attach encrypted auth blob here (not user prompt text). */
  _auth?: string;
  _auth_user_id?: string;
}

interface PiBeforeAgentStartEvent {
  systemPrompt?: string;
}

interface PiToolCallEvent {
  toolName?: string;
  input?: JsonObject;
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const extractContextScript = join(extensionDir, "extract-additional-context.mjs");
const CONTEXT_STATUS_KEY = "qdm-harness";
const CONTEXT_STATUS_DELAY_MS = 120;
const DEFAULT_CONTEXT_TIMEOUT_MS = 5_000;
const MIN_CONTEXT_TIMEOUT_MS = 1_000;
const MAX_CONTEXT_TIMEOUT_MS = 30_000;
const CONTEXT_CACHE_LIMIT = 64;

const STATIC_SYSTEM_GUIDANCE = [
  "QDM Harness context is attached to the active user turn before each model request.",
  "Treat its contextFiles, instructions, and constraints as required.",
].join(" ");

const HARNESS_FAILURE_CONTEXT = [
  "# QDM Harness Unavailable",
  "",
  "The QDM Harness context could not be prepared for this turn.",
  "Do not run QDM data CLIs, estimate values, or produce data-backed conclusions.",
  "Explain that Harness context loading failed.",
].join("\n");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cliMissingMessage(cli: string): string {
  return `missing ${cli}; run \`go build -o bin/data-harness-cli ./cli/cmd/data-harness-cli\` or reinstall harness-data`;
}

function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, "bin", "data-harness-cli"))) return current;
    if (existsSync(join(current, ".agents")) && existsSync(join(current, "wikis"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function sessionId(ctx?: PiExtensionContext): string {
  return (
    ctx?.sessionManager?.getSessionId?.() ||
    ctx?.sessionManager?.getSessionFile?.() ||
    process.env.PI_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "unknown"
  );
}

function contextTimeoutMs(): number {
  const configured = process.env.QDM_PI_CONTEXT_TIMEOUT_MS?.trim();
  if (!configured) return DEFAULT_CONTEXT_TIMEOUT_MS;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed)) return DEFAULT_CONTEXT_TIMEOUT_MS;
  return Math.min(MAX_CONTEXT_TIMEOUT_MS, Math.max(MIN_CONTEXT_TIMEOUT_MS, Math.floor(parsed)));
}

function concise(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function commandFailureMessage(result: JsonObject, timeoutMs: number): string {
  if (result.timedOut === true) return `timed out after ${timeoutMs} ms`;
  if (result.aborted === true) return "aborted";
  if (result.truncated === true) return "output exceeded the 2 MiB safety limit";

  const error = result.error instanceof Error ? result.error.message : "";
  const detail = concise(result.stderr) || concise(result.stdout) || concise(error);
  const code = typeof result.code === "number" ? result.code : null;
  if (code !== null) return detail ? `exit ${code}: ${detail}` : `exit ${code}`;
  return detail || "unknown error";
}

function notifyContextFailure(ctx: PiExtensionContext | undefined, message: string): string {
  ctx?.ui?.notify?.(`QDM Harness context failed: ${message}`, "warning");
  return HARNESS_FAILURE_CONTEXT;
}

function extractAdditionalContext(output: string): string {
  const payload = JSON.parse(output) as unknown;
  if (!isObject(payload) || !isObject(payload.hookSpecificOutput)) return "";
  const context = payload.hookSpecificOutput.additionalContext;
  return typeof context === "string" ? context.trim() : "";
}

function addPiPathGuidance(context: string): string {
  if (!context) return "";
  const selectedReadPath = context.match(/^- (wikis\/.+?\/playbook\.md) \(selected playbook\)$/m)?.[1];
  return [
    "# Pi Path Guidance",
    "",
    "- `selectedPlaybook` and `selectedTemplate` are Harness logical IDs, not direct filesystem paths.",
    "- Read only the paths listed under `contextFiles`; those are already resolved through `config/harness-config.yaml` and usually start with `wikis/`.",
    "- If you need the selected playbook body, read the matching `wikis/.../playbook.md` entry from `contextFiles`; examples include `wikis/metrics/.../playbook.md` and `wikis/reports/.../playbook.md`.",
    selectedReadPath ? `- Selected playbook read path: \`${selectedReadPath}\`.` : "",
    "",
    context,
  ]
    .filter(Boolean)
    .join("\n");
}

function authzGuidance(mode: "off" | "on", bound: boolean): string {
  if (mode !== "on") return "";
  if (!bound) {
    return [
      "# QDM Data Auth",
      "",
      "Authz mode is on but no encrypted auth blob is bound for this turn.",
      "Do not run `qdm-metric-cli analysis execute` until auth is available.",
    ].join("\n");
  }
  return [
    "# QDM Data Auth",
    "",
    "Authz mode is on. Runtime injects `--data-auth --auth-blob` for `qdm-metric-cli analysis execute`.",
    "Do not invent, omit, or override auth flags; the hook replaces them.",
  ].join("\n");
}

async function runHarnessContext(
  projectRoot: string,
  prompt: string,
  ctx?: PiExtensionContext,
): Promise<string> {
  if (!prompt) return "";

  const cli = join(projectRoot, "bin", "data-harness-cli");
  if (!existsSync(cli)) return notifyContextFailure(ctx, cliMissingMessage(cli));

  const timeoutMs = contextTimeoutMs();
  let statusVisible = false;
  const statusTimer = setTimeout(() => {
    statusVisible = true;
    ctx?.ui?.setStatus?.(CONTEXT_STATUS_KEY, "QDM Harness: loading context…");
  }, CONTEXT_STATUS_DELAY_MS);
  statusTimer.unref?.();

  try {
    const result = (await runAsyncCommand(cli, ["context", "--format", "agent-hook"], {
      cwd: projectRoot,
      input: JSON.stringify({ session_id: sessionId(ctx), prompt }),
      timeoutMs,
    })) as JsonObject;

    if (result.error || result.timedOut || result.aborted || result.truncated || result.code !== 0) {
      return notifyContextFailure(ctx, commandFailureMessage(result, timeoutMs));
    }

    try {
      const context = extractAdditionalContext(String(result.stdout ?? ""));
      if (!context) return notifyContextFailure(ctx, "agent-hook returned no additionalContext");
      return addPiPathGuidance(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid JSON";
      return notifyContextFailure(ctx, `invalid agent-hook output: ${concise(message)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return notifyContextFailure(ctx, concise(message) || "unknown error");
  } finally {
    clearTimeout(statusTimer);
    if (statusVisible) ctx?.ui?.setStatus?.(CONTEXT_STATUS_KEY, undefined);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isTemplateCommand(command: string): boolean {
  return /\bdata-harness-cli\b/.test(command) && /\b(inject-template|stage\s+template)\b/.test(command);
}

function injectPosttool(projectRoot: string, event: unknown, ctx?: PiExtensionContext): void {
  const toolCall = event as PiToolCallEvent;
  if (!["bash", "Bash"].includes(toolCall.toolName ?? "") || !isObject(toolCall.input)) return;
  const command = toolCall.input.command;
  if (typeof command !== "string" || !isTemplateCommand(command)) return;

  const payload = JSON.stringify({
    session_id: sessionId(ctx),
    tool_name: "Bash",
    tool_input: { command },
  });
  const cli = join(projectRoot, "bin", "data-harness-cli");
  if (!existsSync(cli)) {
    ctx?.ui?.notify?.(`QDM Harness posttool failed: ${cliMissingMessage(cli)}`, "warning");
    return;
  }
  toolCall.input.command = [
    "{",
    command,
    ";",
    "}",
    ";",
    "__qdm_status=$?",
    ";",
    "printf %s",
    shellQuote(payload),
    "|",
    shellQuote(cli),
    "posttool --format agent-hook",
    "| node",
    shellQuote(extractContextScript),
    ";",
    "exit $__qdm_status",
  ].join(" ");
}

/**
 * Bind auth for this turn: Host _auth wins; else local env/file when allowed.
 * Test stage uses blob_file only (no env).
 */
function bindAuthzForTurn(
  projectRoot: string,
  store: AuthzStateStore,
  ctx: PiExtensionContext | undefined,
  event?: PiContextEvent,
): { mode: "off" | "on"; bound: boolean; error?: string } {
  const config = loadAuthzConfig(projectRoot);
  if (config.mode !== "on") {
    return { mode: "off", bound: false };
  }

  const resolved = resolveAuthBlob({
    projectRoot,
    config,
    hostAuth: event?._auth,
    hostUserId: event?._auth_user_id,
  });

  if (!resolved.ok) {
    return { mode: "on", bound: false, error: resolved.error };
  }

  store.bind(sessionId(ctx), resolved.userId, resolved.blob, resolved.source);
  return { mode: "on", bound: true };
}

export default function qdmHarnessExtension(pi: {
  on?: (event: string, handler: (event: unknown, ctx?: PiExtensionContext) => unknown) => void;
  cwd?: string;
}): void {
  const contextCache = new ContextCache(CONTEXT_CACHE_LIMIT);
  const authzStore = new AuthzStateStore();
  let projectRoot = findProjectRoot(pi.cwd ?? process.cwd());

  const resetSessionState = (ctx?: PiExtensionContext): void => {
    contextCache.clear();
    authzStore.clear(sessionId(ctx));
    ctx?.ui?.setStatus?.(CONTEXT_STATUS_KEY, undefined);
  };

  pi.on?.("session_start", (_event, ctx) => {
    projectRoot = findProjectRoot(ctx?.cwd ?? pi.cwd ?? process.cwd());
    resetSessionState(ctx);
    return undefined;
  });

  pi.on?.("session_shutdown", (_event, ctx) => {
    resetSessionState(ctx);
    return undefined;
  });

  pi.on?.("before_agent_start", (event) => {
    const current = (event as PiBeforeAgentStartEvent).systemPrompt ?? "";
    return {
      systemPrompt: [current, STATIC_SYSTEM_GUIDANCE].filter(Boolean).join("\n\n"),
    };
  });

  pi.on?.("context", async (event, ctx) => {
    const payload = event as PiContextEvent;
    const messages = payload.messages;
    if (!Array.isArray(messages)) return undefined;

    const authz = bindAuthzForTurn(projectRoot, authzStore, ctx, payload);

    const userMessage = latestUserMessage(messages);
    if (!userMessage) return { messages };

    const context = await contextCache.getOrCreate(userMessage.key, () =>
      runHarnessContext(projectRoot, userMessage.prompt, ctx),
    );

    const parts = [context, authzGuidance(authz.mode, authz.bound)].filter(Boolean);
    if (authz.mode === "on" && !authz.bound && authz.error) {
      ctx?.ui?.notify?.(`QDM Authz: ${authz.error}`, "warning");
    }
    if (!parts.length) return { messages };
    return { messages: appendHarnessContext(messages, userMessage.index, parts.join("\n\n")) };
  });

  pi.on?.("tool_call", (event, ctx) => {
    const config = loadAuthzConfig(projectRoot);
    const metricCliPath = resolveMetricCliPath(projectRoot, config);
    const turn = authzStore.getCurrentTurn(sessionId(ctx));
    const authzResult = applyAuthzToToolCall(event as PiToolCallEvent, {
      mode: config.mode,
      blob: turn?.blob ?? null,
      metricCliPath,
      missingReason: turn
        ? undefined
        : "authz mode is on but no encrypted auth blob is bound for this turn; cannot run qdm-metric-cli analysis execute",
    });
    if (authzResult?.block) {
      return authzResult;
    }

    injectPosttool(projectRoot, event, ctx);
    return undefined;
  });
}
