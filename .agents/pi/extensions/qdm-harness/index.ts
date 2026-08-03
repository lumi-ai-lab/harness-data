import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAsyncCommand } from "./async-cli.mjs";
import { registerAuthzBashOverride } from "./authz-bash.mjs";
import { AuthorizationStateStore, parseAuthzBindOutput } from "./authz-state.mjs";
import {
  ContextCache,
  latestUserMessage,
  replaceUserPrompt,
  upsertHarnessContext,
} from "./context-cache.mjs";

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
}

interface PiBeforeAgentStartEvent {
  systemPrompt?: string;
}

interface PiMessageEvent {
  message?: unknown;
}

interface PiToolCallEvent {
  toolCallId?: string;
  toolName?: string;
  input?: JsonObject;
}

interface PiToolResultEvent {
  toolCallId?: string;
}

interface PiToolExecutionEndEvent {
  toolCallId?: string;
}

interface PiRuntime {
  VERSION?: string;
  createBashTool?: (cwd: string, options?: JsonObject) => JsonObject & {
    execute: (...args: unknown[]) => Promise<unknown>;
  };
}

interface AuthorizationBindingSnapshot {
  sessionId: string;
  bindingBase64url?: string;
}

interface PendingAssistantBinding {
  conflicted: boolean;
  messages: Set<JsonObject>;
  snapshot?: AuthorizationBindingSnapshot;
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const extractContextScript = join(extensionDir, "extract-additional-context.mjs");
const CONTEXT_STATUS_KEY = "qdm-harness";
const CONTEXT_STATUS_DELAY_MS = 120;
const DEFAULT_CONTEXT_TIMEOUT_MS = 5_000;
const MIN_CONTEXT_TIMEOUT_MS = 1_000;
const MAX_CONTEXT_TIMEOUT_MS = 30_000;
const CONTEXT_CACHE_LIMIT = 64;
const EXPECTED_PI_VERSION = "0.81.1";
const LUMI_AUTHORIZATION_PROFILE = "lumi-mvp-required";

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

const AUTHZ_FAILURE_CONTEXT = [
  "# Request Authorization Unavailable",
  "",
  "No valid requester authorization is bound to this turn.",
  "Do not run QDM data CLIs or produce data-backed conclusions for this request.",
].join("\n");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantMessage(value: unknown): JsonObject | undefined {
  return isObject(value) && value.role === "assistant" ? value : undefined;
}

function assistantTimestamp(message: JsonObject): number | undefined {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? message.timestamp
    : undefined;
}

function assistantToolCallIds(message: JsonObject): string[] {
  if (!Array.isArray(message.content)) return [];
  const ids = new Set<string>();
  for (const part of message.content) {
    if (isObject(part) && part.type === "toolCall" && typeof part.id === "string" && part.id) {
      ids.add(part.id);
    }
  }
  return [...ids];
}

function sameBindingSnapshot(
  first: AuthorizationBindingSnapshot,
  second: AuthorizationBindingSnapshot,
): boolean {
  return (
    first.sessionId === second.sessionId && first.bindingBase64url === second.bindingBase64url
  );
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

function usesLumiAuthorizationProfile(projectRoot: string): boolean {
  const statePath = join(projectRoot, ".harness", "installer-state.json");
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    return (
      isObject(state) &&
      state.schemaVersion === 3 &&
      state.profile === LUMI_AUTHORIZATION_PROFILE &&
      state.agent === "pi"
    );
  } catch {
    // Authorization is activated only by an explicit, valid immutable-image
    // profile. Lumi readiness rejects missing or malformed installer state;
    // legacy and local workspaces retain their unrestricted behavior here.
    return false;
  }
}

function nativeSessionId(ctx?: PiExtensionContext): string | undefined {
  const value = ctx?.sessionManager?.getSessionId?.();
  return typeof value === "string" && value ? value : undefined;
}

function contextSessionId(ctx?: PiExtensionContext): string {
  return (
    nativeSessionId(ctx) ||
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
      input: JSON.stringify({ session_id: contextSessionId(ctx), prompt }),
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

async function runHarnessAuthzBind(
  projectRoot: string,
  requestedSessionId: string,
): Promise<ReturnType<typeof parseAuthzBindOutput>> {
  const cli = join(projectRoot, "bin", "data-harness-cli");
  if (!existsSync(cli)) throw new Error(cliMissingMessage(cli));

  const timeoutMs = contextTimeoutMs();
  const result = (await runAsyncCommand(cli, ["authz-bind", "--session-id", requestedSessionId], {
    cwd: projectRoot,
    timeoutMs,
  })) as JsonObject;
  if (result.error || result.timedOut || result.aborted || result.truncated || result.code !== 0) {
    throw new Error(commandFailureMessage(result, timeoutMs));
  }

  return parseAuthzBindOutput(String(result.stdout ?? ""), requestedSessionId);
}

async function loadProductionPiRuntime(): Promise<PiRuntime> {
  return (await import("@earendil-works/pi-coding-agent")) as PiRuntime;
}

function assertPiRuntime(runtime: PiRuntime): asserts runtime is Required<PiRuntime> {
  if (runtime.VERSION !== EXPECTED_PI_VERSION) {
    throw new Error(
      `qdm-harness authorization requires Pi ${EXPECTED_PI_VERSION}; found ${runtime.VERSION ?? "unknown"}`,
    );
  }
  if (typeof runtime.createBashTool !== "function") {
    throw new Error("Pi runtime does not expose createBashTool(..., spawnHook)");
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
    session_id: contextSessionId(ctx),
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

interface ExtensionDependencies {
  piRuntime?: PiRuntime;
  bindAuthorization?: (options: {
    projectRoot: string;
    sessionId: string;
    ctx?: PiExtensionContext;
  }) => Promise<ReturnType<typeof parseAuthzBindOutput>>;
}

interface PiExtensionApi {
  on?: (event: string, handler: (event: unknown, ctx?: PiExtensionContext) => unknown) => void;
  registerTool?: (tool: JsonObject) => void;
  cwd?: string;
}

export async function installQdmHarnessExtension(
  pi: PiExtensionApi,
  dependencies: ExtensionDependencies = {},
): Promise<void> {
  let projectRoot = findProjectRoot(pi.cwd ?? process.cwd());
  const authorizationEnabled = usesLumiAuthorizationProfile(projectRoot);
  const contextCache = new ContextCache(CONTEXT_CACHE_LIMIT);
  const authorizationState = authorizationEnabled ? new AuthorizationStateStore() : undefined;
  const assistantMessageBindings = new WeakMap<object, AuthorizationBindingSnapshot>();
  const pendingAssistantBindings = new Map<string, Map<number, PendingAssistantBinding>>();
  const refreshQueues = new Map<string, Promise<{ ok: boolean; summary: string }>>();
  const sessionGenerations = new Map<string, number>();
  const bindAuthorization =
    dependencies.bindAuthorization ??
    ((options: { projectRoot: string; sessionId: string; ctx?: PiExtensionContext }) =>
      runHarnessAuthzBind(options.projectRoot, options.sessionId));
  if (authorizationEnabled) {
    const piRuntime = dependencies.piRuntime ?? (await loadProductionPiRuntime());
    assertPiRuntime(piRuntime);
    if (typeof pi.registerTool !== "function") {
      throw new Error("Pi runtime does not support same-name Bash tool registration");
    }
    registerAuthzBashOverride(pi, {
      createBashTool: piRuntime.createBashTool,
      cwd: pi.cwd ?? process.cwd(),
      projectRoot,
      stateStore: authorizationState,
    });
  }

  const generation = (id: string): number => sessionGenerations.get(id) ?? 0;

  const clearAssistantBindings = (id?: string): void => {
    const clearEntries = (entries: Map<number, PendingAssistantBinding>): void => {
      for (const entry of entries.values()) {
        for (const message of entry.messages) assistantMessageBindings.delete(message);
      }
      entries.clear();
    };

    if (id) {
      const entries = pendingAssistantBindings.get(id);
      if (entries) clearEntries(entries);
      pendingAssistantBindings.delete(id);
      return;
    }
    for (const entries of pendingAssistantBindings.values()) clearEntries(entries);
    pendingAssistantBindings.clear();
  };

  const clearAuthorization = (id?: string): void => {
    if (!id) {
      authorizationState?.clearAll();
      clearAssistantBindings();
      for (const sessionId of sessionGenerations.keys()) {
        sessionGenerations.set(sessionId, generation(sessionId) + 1);
      }
      return;
    }
    sessionGenerations.set(id, generation(id) + 1);
    authorizationState?.clearSession(id);
    clearAssistantBindings(id);
  };

  const snapshotAssistantMessage = (event: unknown, ctx?: PiExtensionContext): void => {
    const message = assistantMessage((event as PiMessageEvent).message);
    const requestedSessionId = nativeSessionId(ctx);
    if (!authorizationState || !message || !requestedSessionId) return;

    const snapshot = authorizationState.snapshotSession(requestedSessionId) as
      | AuthorizationBindingSnapshot
      | undefined;
    if (!snapshot) return;

    // Pi 0.81.1 emits a shallow copy at message_start and the finalized object
    // at message_end, so object identity alone cannot correlate a streamed
    // assistant message. Its required timestamp is stable across that stream.
    const timestamp = assistantTimestamp(message);
    if (timestamp === undefined) return;
    assistantMessageBindings.set(message, snapshot);
    let entries = pendingAssistantBindings.get(requestedSessionId);
    if (!entries) {
      entries = new Map();
      pendingAssistantBindings.set(requestedSessionId, entries);
    }

    const existing = entries.get(timestamp);
    if (!existing) {
      entries.set(timestamp, {
        conflicted: false,
        messages: new Set([message]),
        snapshot,
      });
      return;
    }

    existing.messages.add(message);
    if (
      existing.messages.size > 1 ||
      !existing.snapshot ||
      !sameBindingSnapshot(existing.snapshot, snapshot)
    ) {
      existing.conflicted = true;
      existing.snapshot = undefined;
    }
  };

  const finalizeAssistantMessage = (event: unknown, ctx?: PiExtensionContext): void => {
    const message = assistantMessage((event as PiMessageEvent).message);
    const requestedSessionId = nativeSessionId(ctx);
    if (!authorizationState || !message || !requestedSessionId) return;

    let snapshot = assistantMessageBindings.get(message);
    assistantMessageBindings.delete(message);
    const timestamp = assistantTimestamp(message);
    if (timestamp !== undefined) {
      const entries = pendingAssistantBindings.get(requestedSessionId);
      const pending = entries?.get(timestamp);
      if (pending) {
        entries?.delete(timestamp);
        if (entries?.size === 0) pendingAssistantBindings.delete(requestedSessionId);
        for (const startMessage of pending.messages) {
          assistantMessageBindings.delete(startMessage);
        }

        if (
          pending.conflicted ||
          !pending.snapshot ||
          (snapshot !== undefined && !sameBindingSnapshot(snapshot, pending.snapshot))
        ) {
          snapshot = undefined;
        } else {
          snapshot ??= pending.snapshot;
        }
      }
    }

    if (!snapshot || snapshot.sessionId !== requestedSessionId) return;
    for (const toolCallId of assistantToolCallIds(message)) {
      authorizationState.bindToolCall(toolCallId, snapshot);
    }
  };

  const authorizationFailure = (ctx?: PiExtensionContext): { ok: false; summary: string } => {
    ctx?.ui?.notify?.("QDM Harness authorization is unavailable for this request", "warning");
    return { ok: false, summary: AUTHZ_FAILURE_CONTEXT };
  };

  const refreshAuthorization = (
    requestedSessionId: string,
    ctx?: PiExtensionContext,
  ): Promise<{ ok: boolean; summary: string }> => {
    if (!sessionGenerations.has(requestedSessionId)) sessionGenerations.set(requestedSessionId, 0);
    // Every context event represents a fresh authorization observation. If
    // two observations for one ACP Session overlap, the later one invalidates
    // the earlier generation: without a requestId in the Pi event, assigning
    // the newly published Lumi file to the older turn would be unsafe.
    const requestedGeneration = generation(requestedSessionId) + 1;
    sessionGenerations.set(requestedSessionId, requestedGeneration);
    const previous = refreshQueues.get(requestedSessionId) ?? Promise.resolve({ ok: true, summary: "" });
    let queued: Promise<{ ok: boolean; summary: string }>;
    queued = previous
      .catch(() => ({ ok: false, summary: AUTHZ_FAILURE_CONTEXT }))
      .then(async () => {
        if (generation(requestedSessionId) !== requestedGeneration) return authorizationFailure(ctx);

        let candidate;
        try {
          candidate = await bindAuthorization({
            projectRoot,
            sessionId: requestedSessionId,
            ctx,
          });
        } catch {
          if (generation(requestedSessionId) === requestedGeneration) {
            // A transient read failure clears executable binding material, but
            // must not erase a fingerprint-conflict tombstone for this request.
            authorizationState?.dropSessionBinding(requestedSessionId);
          }
          return authorizationFailure(ctx);
        }

        if (generation(requestedSessionId) !== requestedGeneration) return authorizationFailure(ctx);
        const applied = authorizationState?.apply(requestedSessionId, candidate);
        if (!applied) return authorizationFailure(ctx);
        if (!applied.accepted) return authorizationFailure(ctx);
        return { ok: true, summary: candidate.summary };
      })
      .finally(() => {
        if (refreshQueues.get(requestedSessionId) === queued) refreshQueues.delete(requestedSessionId);
      });
    refreshQueues.set(requestedSessionId, queued);
    return queued;
  };

  const resetSessionState = (ctx?: PiExtensionContext): void => {
    contextCache.clear();
    clearAuthorization(nativeSessionId(ctx));
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
    const messages = (event as PiContextEvent).messages;
    const requestedSessionId = nativeSessionId(ctx);
    const authorization = authorizationEnabled
      ? requestedSessionId
        ? await refreshAuthorization(requestedSessionId, ctx)
        : (() => {
            clearAuthorization();
            return authorizationFailure(ctx);
          })()
      : { ok: true, summary: "" };

    if (!Array.isArray(messages)) return undefined;

    const userMessage = latestUserMessage(messages);
    if (!userMessage) return { messages };

    const effectiveMessages =
      userMessage.prompt === userMessage.rawPrompt
        ? messages
        : replaceUserPrompt(messages, userMessage.index, userMessage.prompt);
    const cacheKey = `${requestedSessionId ?? "missing-session"}:${userMessage.key}`;
    const wikiContext = await contextCache.getOrCreate(cacheKey, () =>
      runHarnessContext(projectRoot, userMessage.prompt, ctx),
    );
    const context = [authorization.summary, wikiContext].filter(Boolean).join("\n\n");
    if (!context) return { messages: effectiveMessages };
    return { messages: upsertHarnessContext(effectiveMessages, userMessage.index, context) };
  });

  pi.on?.("message_start", (event, ctx) => {
    snapshotAssistantMessage(event, ctx);
    return undefined;
  });

  pi.on?.("message_end", (event, ctx) => {
    finalizeAssistantMessage(event, ctx);
    return undefined;
  });

  pi.on?.("tool_call", (event, ctx) => {
    injectPosttool(projectRoot, event, ctx);
    return undefined;
  });

  pi.on?.("tool_result", (event) => {
    authorizationState?.clearToolCall((event as PiToolResultEvent).toolCallId ?? "");
    return undefined;
  });

  pi.on?.("tool_execution_end", (event) => {
    authorizationState?.clearToolCall((event as PiToolExecutionEndEvent).toolCallId ?? "");
    return undefined;
  });
}

export default async function qdmHarnessExtension(pi: PiExtensionApi): Promise<void> {
  await installQdmHarnessExtension(pi);
}
