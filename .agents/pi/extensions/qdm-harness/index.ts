import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAsyncCommand } from "./async-cli.mjs";
import { loadAuthzConfig, resolveAuthBlob, resolveMetricCliPath } from "./authz-config.mjs";
import { applyAuthzToToolCall } from "./authz-inject.mjs";
import { AuthzStateStore } from "./authz-store.mjs";
import { appendHarnessContext, ContextCache, latestUserMessage } from "./context-cache.mjs";
import {
  applyGateInput,
  classifyGateInput,
  gateContextBanner,
  gateToolDecision,
  htmlReportSessionDir,
  initializeGateForHtmlReport,
  inspectGateState,
  normalizeStandaloneStageGateCommand,
  parseStandaloneStageGateCommand,
  readGateState,
  runStageGate,
  stageGateScriptPath,
} from "./gate-control.mjs";
import {
  STAGE_DEFINITIONS,
  formatGateMessage,
} from "../../skills/html-report/scripts/stage-gate.mjs";
import { checkSessionLayout } from "../../skills/html-report/scripts/check-session-layout.mjs";

type JsonObject = Record<string, unknown>;

interface PiExtensionContext {
  cwd?: string;
  hasUI?: boolean;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, text: string | undefined) => void;
  };
}

interface PiEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
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
  toolCallId?: string;
  toolName?: string;
  input?: JsonObject;
}

interface PiToolResultEvent {
  toolCallId?: string;
  toolName?: string;
  input?: JsonObject;
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

interface RuntimeAgentListRecord {
  key: string;
  sessionId: string;
  stageId: "A_CONFIG" | "B0_PREFLIGHT";
  attempt: string;
  toolCallId: string;
  mechanism: string;
  status: "inflight" | "passed" | "failed";
  observedAgents?: string[];
  missingAgents?: string[];
  error?: string;
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

// --- B0 Gate constants ---

export const HTML_REPORT_GATE_CUSTOM_TYPE = "html-report-gate";

// Runtime contract constants (stubs for B0; full implementation in later issues)
export const HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH = join("debug", "runtime-contract.json");
export const HTML_REPORT_RUNTIME_SOURCE_FILES: string[] = [];

const REQUIRED_REPORT_AGENTS = [
  "report-writer",
  "report-researcher",
  "report-reviewer",
  "report-designer",
] as const;

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
const RUNTIME_AGENT_LIST_BRIDGE_TIMEOUT_MS = 5_000;

// --- Utility functions ---

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

function envelopeSessionId(ctx?: PiExtensionContext): string | null {
  const id =
    ctx?.sessionManager?.getSessionId?.() ||
    process.env.PI_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "";
  return id || null;
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
    "- If you need the selected playbook body, read the matching `wikis/.../playbook.md` entry from `contextFiles`.",
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
      "Do not run `qdm-metric-cli analysis execute` or `qdm-metric-cli auth describe` until auth is available.",
    ].join("\n");
  }
  return [
    "# QDM Data Auth",
    "",
    "Authz mode is on. Runtime injects `--data-auth --auth-blob` for `qdm-metric-cli analysis execute`,",
    "and `--auth-blob` for `qdm-metric-cli auth describe`.",
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
    "{", command, ";", "}", ";",
    "__qdm_status=$?", ";",
    "printf %s", shellQuote(payload), "|", shellQuote(cli),
    "posttool --format agent-hook", "| node", shellQuote(extractContextScript), ";",
    "exit $__qdm_status",
  ].join(" ");
}

function bindAuthzForTurn(
  projectRoot: string,
  store: AuthzStateStore,
  ctx: PiExtensionContext | undefined,
  event?: PiContextEvent,
): { mode: "off" | "on"; bound: boolean; error?: string; source?: string } {
  const config = loadAuthzConfig(projectRoot);
  if (config.mode !== "on") return { mode: "off", bound: false };
  const resolved = resolveAuthBlob({
    projectRoot,
    config,
    hostAuth: event?._auth,
    hostUserId: event?._auth_user_id,
    sessionId: envelopeSessionId(ctx),
  });
  if (!resolved.ok) return { mode: "on", bound: false, error: resolved.error };
  store.bind(sessionId(ctx), resolved.userId, resolved.blob, resolved.source);
  return { mode: "on", bound: true, source: resolved.source };
}

// --- B0 Gate helper functions ---

function isHtmlReportSkillPrompt(prompt: string): boolean {
  return (
    /<skill\s+name=["']html-report["']/i.test(prompt) ||
    /\/skill:\s*html-report\b/i.test(prompt) ||
    /\bskill:\s*html-report\b/i.test(prompt)
  );
}

function isExactRuntimeAgentList(event: unknown): boolean {
  if (!isObject(event) || String(event.toolName || "").toLowerCase() !== "subagent") return false;
  if (!isObject(event.input)) return false;
  return event.input.action === "list" && Object.keys(event.input).length === 1;
}

function runtimeAgentListAttempt(state: unknown): {
  stageId: "A_CONFIG" | "B0_PREFLIGHT";
  attempt: string;
} | null {
  if (!isObject(state) || !["A_CONFIG", "B0_PREFLIGHT"].includes(String(state.currentStage))) {
    return null;
  }
  const stageId = state.currentStage as "A_CONFIG" | "B0_PREFLIGHT";
  const stageStatusAllowed = stageId === "A_CONFIG"
    ? state.status === "running" || state.status === "awaiting_approval"
    : state.status === "running";
  if (!stageStatusAllowed) return null;
  const stages = isObject(state.stages) ? state.stages : {};
  const stage = isObject(stages[stageId]) ? stages[stageId] : {};
  const attempts = Array.isArray(stage.attempts) ? stage.attempts : [];
  const latest = attempts.length && isObject(attempts.at(-1)) ? attempts.at(-1) as JsonObject : {};
  const number = latest.number;
  const startedAt = latest.startedAt || stage.startedAt;
  if (!Number.isSafeInteger(number) || typeof startedAt !== "string" || !startedAt) return null;
  return { stageId, attempt: `${stageId}:${number}:${startedAt}` };
}

function runtimeAgentListText(event: PiToolResultEvent): string {
  return Array.isArray(event.content)
    ? event.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text || "")
        .join("\n")
    : "";
}

function runtimeAgentListObservedAgents(event: PiToolResultEvent): string[] {
  const text = runtimeAgentListText(event);
  return REQUIRED_REPORT_AGENTS.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)\\s*-\\s*${escaped}(?:\\s|\\()`, "m").test(text);
  });
}

export function inspectRuntimeAgentListResult(event: PiToolResultEvent): {
  ok: boolean;
  missingAgents: string[];
  error?: string;
} {
  const text = runtimeAgentListText(event);
  if (event.isError === true) {
    return { ok: false, missingAgents: [...REQUIRED_REPORT_AGENTS], error: text.trim() || "subagent list failed" };
  }
  const missingAgents = REQUIRED_REPORT_AGENTS.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`(?:^|\\n)\\s*-\\s*${escaped}(?:\\s|\\()`, "m").test(text);
  });
  return missingAgents.length
    ? { ok: false, missingAgents, error: `runtime list 缺少 Agent：${missingAgents.join(", ")}` }
    : { ok: true, missingAgents: [] };
}

/**
 * Execute one real foreground pi-subagents request without a parent-model tool
 * turn. The slash bridge emits STARTED synchronously while handling REQUEST;
 * absence of that acknowledgement means the extension is not loaded and must
 * fail closed immediately.
 */
export function requestSubagentViaEventBridge({
  events,
  ctx,
  projectRoot,
  params,
  requestId = randomUUID(),
  timeoutMs,
  label = "subagent",
}: {
  events?: PiEventBus;
  ctx?: PiExtensionContext;
  projectRoot: string;
  params: JsonObject;
  requestId?: string;
  timeoutMs?: number;
  label?: string;
}): Promise<{ requestId: string; event: PiToolResultEvent }> {
  if (!events || typeof events.on !== "function" || typeof events.emit !== "function") {
    return Promise.reject(new Error("pi-subagents slash event bridge is unavailable"));
  }
  if (!isAbsolute(projectRoot)) {
    return Promise.reject(new Error(`${label} projectRoot must be absolute`));
  }
  if (!isObject(params) || !Object.keys(params).length) {
    return Promise.reject(new Error(`${label} params must be one non-empty object`));
  }
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(Math.trunc(timeoutMs), 725_000)
    : RUNTIME_AGENT_LIST_BRIDGE_TIMEOUT_MS;
  const requestContext = Object.assign({}, ctx || {}, { cwd: resolve(projectRoot) });

  return new Promise((resolvePromise, rejectPromise) => {
    let done = false;
    let started = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      while (unsubscribers.length) {
        try { unsubscribers.pop()?.(); } catch { /* best effort */ }
      }
    };
    const finish = (next: () => void): void => { if (done) return; done = true; cleanup(); next(); };
    const reject = (error: Error): void => finish(() => rejectPromise(error));

    const onStarted = (data: unknown): void => {
      if (done || !isObject(data) || data.requestId !== requestId) return;
      started = true;
    };
    const onResponse = (data: unknown): void => {
      if (done || !isObject(data) || data.requestId !== requestId) return;
      if (!started) { reject(new Error("pi-subagents slash bridge responded before STARTED")); return; }
      if (!isObject(data.result) || !Array.isArray(data.result.content)) {
        reject(new Error("pi-subagents slash bridge returned a malformed response"));
        return;
      }
      const result = data.result as PiToolResultEvent;
      const event: PiToolResultEvent = {
        ...result,
        toolCallId: requestId,
        toolName: "subagent",
        input: params,
        isError: data.isError === true || result.isError === true,
      };
      finish(() => resolvePromise({ requestId, event }));
    };

    try {
      const unsubStarted = events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted);
      if (typeof unsubStarted !== "function") {
        reject(new Error("pi event bus cannot unsubscribe STARTED listener"));
        return;
      }
      unsubscribers.push(unsubStarted);
      const unsubResponse = events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse);
      if (typeof unsubResponse !== "function") {
        reject(new Error("pi event bus cannot unsubscribe RESPONSE listener"));
        return;
      }
      unsubscribers.push(unsubResponse);
      timer = setTimeout(() => {
        if (done) return;
        finish(() => {
          try { events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId }); } catch { /* timeout is authoritative */ }
          rejectPromise(new Error(`${label} event bridge timed out after ${boundedTimeout}ms`));
        });
      }, boundedTimeout);
      events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params, ctx: requestContext });
      if (!started && !done) {
        reject(new Error(`no pi-subagents slash bridge received the ${label} request`));
      }
    } catch (error) {
      reject(new Error(`${label} event bridge failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

export function requestRuntimeAgentListViaEventBridge({
  events,
  ctx,
  projectRoot,
  requestId = randomUUID(),
  timeoutMs = RUNTIME_AGENT_LIST_BRIDGE_TIMEOUT_MS,
}: {
  events?: PiEventBus;
  ctx?: PiExtensionContext;
  projectRoot: string;
  requestId?: string;
  timeoutMs?: number;
}): Promise<{ requestId: string; event: PiToolResultEvent }> {
  return requestSubagentViaEventBridge({
    events, ctx, projectRoot,
    params: { action: "list" },
    requestId, timeoutMs,
    label: "runtime agent list",
  });
}

// --- Main extension ---

export default function qdmHarnessExtension(pi: {
  on?: (event: string, handler: (event: unknown, ctx?: PiExtensionContext) => unknown) => void;
  events?: PiEventBus;
  cwd?: string;
  sendMessage?: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    options?: { triggerTurn?: boolean },
  ) => void;
}): void {
  const contextCache = new ContextCache(CONTEXT_CACHE_LIMIT);
  const authzStore = new AuthzStateStore();
  let projectRoot = findProjectRoot(pi.cwd ?? process.cwd());
  const runtimeAgentLists = new Map<string, RuntimeAgentListRecord>();
  const runtimeAgentListPromises = new Map<string, Promise<void>>();
  const finishingSessions = new Set<string>();
  const suppressHarnessRecallForSkillSessions = new Set<string>();

  const resetSessionState = (ctx?: PiExtensionContext): void => {
    contextCache.clear();
    authzStore.clear(sessionId(ctx));
    ctx?.ui?.setStatus?.(CONTEXT_STATUS_KEY, undefined);
  };

  const existingHtmlReportSession = (sid: string): boolean => {
    return Boolean(
      sid && sid !== "unknown" &&
      inspectGateState(projectRoot, sid).kind !== "absent",
    );
  };

  const runtimeAgentListKey = (sid: string, gateState: unknown): string | null => {
    const identity = runtimeAgentListAttempt(gateState);
    return identity && sid && sid !== "unknown" ? `${sid}|${identity.attempt}` : null;
  };

  const successfulRuntimeAgentList = (sid: string, gateState: unknown): boolean => {
    const key = runtimeAgentListKey(sid, gateState);
    return Boolean(key && runtimeAgentLists.get(key)?.status === "passed");
  };

  // --- B0: Fail B0 stage with reason ---
  const failRuntimeAgentListStage = (
    sid: string,
    record: RuntimeAgentListRecord,
    reason: string,
  ): string => {
    record.status = "failed";
    record.error = reason;
    runtimeAgentLists.set(record.key, record);
    const current = readGateState(projectRoot, sid);
    if (runtimeAgentListKey(sid, current) !== record.key) {
      return `runtime agent list 已失败，但迟到结果属于 ${record.attempt}，未修改当前 Gate：${reason}`;
    }
    const failed = runStageGate(projectRoot, sid, "fail", [
      "--stage", record.stageId, "--reason", reason,
    ]);
    return failed.ok && failed.payload?.state
      ? `${reason}\n${formatGateMessage(failed.payload.state, { stageId: record.stageId })}`
      : `${reason}\n无法自动 fail ${record.stageId}：${failed.error || "unknown stage-gate error"}`;
  };

  // --- B0: Settle runtime agent list — verify agents + phase-a layout + finish/fail B0 ---
  const settleRuntimeAgentList = async (
    sid: string,
    record: RuntimeAgentListRecord,
    event: PiToolResultEvent,
  ): Promise<{ isError: boolean; text: string }> => {
    if (runtimeAgentListKey(sid, readGateState(projectRoot, sid)) !== record.key) {
      const reason = `runtime agent list 结果迟到：${record.attempt} 已不是当前 Gate attempt`;
      record.observedAgents = runtimeAgentListObservedAgents(event);
      record.missingAgents = REQUIRED_REPORT_AGENTS.filter((name) => !record.observedAgents?.includes(name));
      record.status = "failed";
      record.error = reason;
      runtimeAgentLists.set(record.key, record);
      return { isError: true, text: reason };
    }

    const inspected = inspectRuntimeAgentListResult(event);
    record.observedAgents = runtimeAgentListObservedAgents(event);
    record.missingAgents = inspected.missingAgents;
    if (!inspected.ok) {
      const reason = inspected.error || `${record.stageId} runtime agent list failed`;
      return { isError: true, text: failRuntimeAgentListStage(sid, record, reason) };
    }

    // B0_PREFLIGHT: run phase-a layout check
    if (record.stageId === "B0_PREFLIGHT") {
      const sessionDir = htmlReportSessionDir(projectRoot, sid);
      let layout;
      try {
        layout = await checkSessionLayout(sessionDir, { phase: "a" });
      } catch (error) {
        layout = { ok: false, errors: [String((error as Error)?.message || error)] };
      }
      if (!layout.ok) {
        const reason = `B0 phase-a layout failed: ${(layout.errors || []).join("; ") || "unknown layout error"}`;
        return { isError: true, text: failRuntimeAgentListStage(sid, record, reason) };
      }
    }

    // Finish B0 if all checks passed
    if (record.stageId === "B0_PREFLIGHT") {
      const finished = runStageGate(projectRoot, sid, "finish", ["--stage", record.stageId]);
      if (!finished.ok) {
        const reason = `runtime list and phase-a layout passed but B0 finish failed: ${finished.error}`;
        return { isError: true, text: failRuntimeAgentListStage(sid, record, reason) };
      }
    }

    record.status = "passed";
    delete record.error;
    runtimeAgentLists.set(record.key, record);
    const completedState = readGateState(projectRoot, sid);
    const gateText = completedState
      ? formatGateMessage(completedState, { stageId: record.stageId })
      : `${record.stageId} runtime agent list passed`;
    const deterministicAcceptance = record.stageId === "B0_PREFLIGHT"
      ? "\nphase-a layout：passed（扩展已确定性检查并完成 B0）"
      : "";
    return {
      isError: false,
      text: `${gateText}\nruntime agent list：passed（四个 report-* Agent 均存在）${deterministicAcceptance}`,
    };
  };

  // --- B0: Ensure automatic runtime agent list for B0 ---
  const ensureAutomaticRuntimeAgentList = async (
    sid: string,
    gateState: unknown,
    ctx?: PiExtensionContext,
  ): Promise<void> => {
    const identity = runtimeAgentListAttempt(gateState);
    const key = runtimeAgentListKey(sid, gateState);
    if (!identity || !key) return;
    const remembered = runtimeAgentLists.get(key);
    if (remembered?.status === "passed" || remembered?.status === "failed") return;
    const pending = runtimeAgentListPromises.get(key);
    if (pending) return pending;

    const run = (async (): Promise<void> => {
      const requestId = randomUUID();
      const startedAt = new Date().toISOString();
      const record: RuntimeAgentListRecord = {
        key, sessionId: sid, stageId: identity.stageId, attempt: identity.attempt,
        toolCallId: requestId, mechanism: "extension-event-bridge", status: "inflight",
      };
      runtimeAgentLists.set(key, record);

      let resultEvent: PiToolResultEvent;
      try {
        const response = await requestRuntimeAgentListViaEventBridge({
          events: pi.events, ctx, projectRoot, requestId,
        });
        resultEvent = response.event;
      } catch (error) {
        resultEvent = {
          toolCallId: requestId, toolName: "subagent", input: { action: "list" },
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }

      const settled = await settleRuntimeAgentList(sid, record, resultEvent);
      ctx?.ui?.notify?.(
        settled.text,
        settled.isError ? "error" : "info",
      );
    })();
    runtimeAgentListPromises.set(key, run);
    try { await run; } finally { runtimeAgentListPromises.delete(key); }
  };

  // --- B0: Handle deterministic A_CONFIG → B0 approval ---
  const handleDeterministicB0Approval = async (
    sid: string,
    before: unknown,
    afterApproval: unknown,
    ctx?: PiExtensionContext,
  ): Promise<boolean> => {
    if (
      typeof pi.sendMessage !== "function" ||
      !isObject(before) ||
      before.mode !== "step" ||
      before.status !== "awaiting_approval" ||
      before.currentStage !== "A_CONFIG" ||
      !isObject(afterApproval) ||
      afterApproval.mode !== "step" ||
      afterApproval.status !== "running" ||
      afterApproval.currentStage !== "B0_PREFLIGHT"
    ) return false;

    try {
      await ensureAutomaticRuntimeAgentList(sid, afterApproval, ctx);
    } catch (error) {
      const reason = `B0 扩展自动验收异常，已 fail closed：${error instanceof Error ? error.message : String(error)}`;
      runStageGate(projectRoot, sid, "fail", ["--stage", "B0_PREFLIGHT", "--reason", reason]);
    }

    let terminal = readGateState(projectRoot, sid);
    if (
      isObject(terminal) &&
      terminal.mode === "step" &&
      terminal.currentStage === "B0_PREFLIGHT" &&
      terminal.status === "running"
    ) {
      const reason = "B0 扩展自动验收未产生 completed/failed 终态，已 fail closed；未启动 B2";
      const failed = runStageGate(projectRoot, sid, "fail", ["--stage", "B0_PREFLIGHT", "--reason", reason]);
      terminal = failed.payload?.state || readGateState(projectRoot, sid);
    }

    const stage = isObject(terminal?.stages?.B0_PREFLIGHT) ? terminal.stages.B0_PREFLIGHT : null;
    const accepted = isObject(terminal) && terminal.status === "awaiting_approval" &&
      isObject(stage) && stage.status === "awaiting_approval";
    const rejected = isObject(terminal) && terminal.status === "failed" &&
      isObject(stage) && stage.status === "failed";
    if (!terminal || (isObject(terminal) && terminal.currentStage !== "B0_PREFLIGHT") || (!accepted && !rejected)) {
      ctx?.ui?.notify?.(
        "B0 确定性验收没有得到可显示的 completed/failed Gate；保留父模型回显作为兼容回退。",
        "error",
      );
      return false;
    }

    const gateText = formatGateMessage(terminal, { stageId: "B0_PREFLIGHT" });
    try {
      pi.sendMessage({
        customType: HTML_REPORT_GATE_CUSTOM_TYPE,
        content: gateText,
        display: true,
        details: {
          version: 1, producer: "qdm-harness", sessionId: sid,
          stageId: "B0_PREFLIGHT",
          currentStage: isObject(terminal) ? terminal.currentStage : "B0_PREFLIGHT",
          pipelineStatus: isObject(terminal) ? terminal.status : "unknown",
          stageStatus: isObject(stage) ? stage.status : "unknown",
        },
      }, { triggerTurn: false });
      return true;
    } catch (error) {
      ctx?.ui?.notify?.(
        `B0 确定性 Gate 消息写入失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    }
  };

  // --- B0 test mode: auto-setup session with test result.json + A_CONFIG completed ---
  const setupTestB0Session = (sid: string): void => {
    const sessionDir = htmlReportSessionDir(projectRoot, sid);
    const debugDir = join(sessionDir, "debug");
    try { mkdirSync(debugDir, { recursive: true }); } catch { /* already exists */ }
    if (!existsSync(join(sessionDir, "result.json"))) {
      writeFileSync(
        join(sessionDir, "result.json"),
        JSON.stringify({
          version: 1, sessionId: sid, mode: "free",
          userQuestion: "门店101001的客流和客单价趋势如何？",
          title: "门店101001客流与客单价分析",
          status: "confirmed",
          confirmedAt: new Date().toISOString(),
          cards: [{
            id: "test-card-001",
            title: "门店101001客流与客单价日趋势",
            analysisFocus: "分析门店101001的客流和客单价日趋势",
            chartType: "table",
            indicatorFieldList: ["custNum", "perCustAmt"],
            aggDimUniqueCodeList: ["incDate"],
            startDate: "2026-08-01", endDate: "2026-08-10",
            storeCollectType: 2,
            filters: [{ type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] }],
            requestBody: {
              indicatorFieldList: ["custNum", "perCustAmt"],
              aggDimUniqueCodeList: ["incDate"],
              startDate: "2026-08-01", endDate: "2026-08-10",
              storeCollectType: 2,
              filters: [{ type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] }],
            },
          }],
          validation: [],
        }, null, 2),
      );
    }
    if (!existsSync(join(debugDir, "pipeline-state.json"))) {
      runStageGate(projectRoot, sid, "init", ["--mode", "step"]);
      runStageGate(projectRoot, sid, "start", ["--stage", "A_CONFIG"]);
      runStageGate(projectRoot, sid, "finish", ["--stage", "A_CONFIG"]);
    }
  };

  // --- Event handlers ---

  pi.on?.("session_start", (_event, ctx) => {
    projectRoot = findProjectRoot(ctx?.cwd ?? pi.cwd ?? process.cwd());
    resetSessionState(ctx);
    // B0 test mode: auto-create session so "继续" can trigger B0 immediately
    if (process.env.HTML_REPORT_TEST_B0 === "1") {
      const sid = sessionId(ctx);
      if (sid && sid !== "unknown") {
        setupTestB0Session(sid);
      }
    }
    return undefined;
  });

  pi.on?.("session_shutdown", (_event, ctx) => {
    resetSessionState(ctx);
    return undefined;
  });

  // --- B0: Input handler — A_CONFIG → B0 deterministic transition ---
  pi.on?.("input", async (event, ctx) => {
    const sid = sessionId(ctx);
    const text = isObject(event) && typeof event.text === "string" ? event.text : "";
    const htmlReportSession = isHtmlReportSkillPrompt(text);

    if (sid && sid !== "unknown") {
      if (htmlReportSession) {
        suppressHarnessRecallForSkillSessions.add(sid);
      } else {
        suppressHarnessRecallForSkillSessions.delete(sid);
      }
    }

    const gateAction = classifyGateInput(text);
    if (sid && sid !== "unknown" && gateAction) {
      const gateState = readGateState(projectRoot, sid);

      // Check if A_CONFIG approval should be blocked (no runtime list yet)
      if (
        isObject(gateState) &&
        gateState.currentStage === "A_CONFIG" &&
        gateState.status === "awaiting_approval" &&
        !successfulRuntimeAgentList(sid, gateState) &&
        process.env.HTML_REPORT_TEST_B0 !== "1"
      ) {
        ctx?.ui?.notify?.(
          "A_CONFIG 尚未通过本 Pi 进程的 runtime agent list；已阻止批准进入 B0。请先让当前 Agent 执行一次 subagent({\"action\":\"list\"})。",
          "warning",
        );
        return { action: "continue" };
      }

      const result = applyGateInput(projectRoot, sid, text);
      if (result.result && !result.result.ok) {
        ctx?.ui?.notify?.(`html-report Gate 未变更：${result.result.error}`, "warning");
      } else if (result.rejected === "failed_stage_requires_retry") {
        ctx?.ui?.notify?.(`当前阶段失败；请回复\u201c重试当前阶段\u201d，普通\u201c继续\u201d不会跳过 Gate。`, "warning");
      } else if (result.rejected === "current_stage_not_failed") {
        ctx?.ui?.notify?.(`当前阶段不是 failed，无需重试。`, "info");
      } else if (result.rejected === "confirm_only_approves_A_CONFIG") {
        ctx?.ui?.notify?.(`\u201c确认生成报告\u201d仅用于批准 A_CONFIG；后续 Gate 请回复\u201c继续\u201d。`, "warning");
      }

      // B0 deterministic transition
      const afterGateInput = readGateState(projectRoot, sid);
      const idleInput = !isObject(event) || event.streamingBehavior === undefined;
      if (
        idleInput &&
        (gateAction === "continue" || gateAction === "confirm") &&
        result.result?.ok === true &&
        await handleDeterministicB0Approval(sid, gateState, afterGateInput, ctx)
      ) {
        return { action: "handled" };
      }
    }
    return { action: "continue" };
  });

  // --- B0: before_agent_start — Gate initialization ---
  pi.on?.("before_agent_start", async (event, ctx) => {
    const rawPrompt = isObject(event) && typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    const sid = sessionId(ctx);
    const htmlReportPrompt = isHtmlReportSkillPrompt(rawPrompt);

    if (sid && sid !== "unknown" && htmlReportPrompt) {
      process.env.PI_SESSION_ID = sid;
    }

    // Initialize Gate for html-report sessions
    if (sid && sid !== "unknown" && (htmlReportPrompt || existingHtmlReportSession(sid))) {
      const gateBeforeInitialization = readGateState(projectRoot, sid);
      if (!gateBeforeInitialization) {
        const defaultMode = process.env.HTML_REPORT_GATE_MODE === "auto" ? "auto" : "step";
        const initialized = initializeGateForHtmlReport(projectRoot, sid, defaultMode);
        if (!initialized.ok) {
          ctx?.ui?.notify?.(`html-report Gate 初始化失败：${initialized.error}`, "error");
        }
      }
    }

    // Inject Gate context banner ONLY for active html-report skill prompts.
    // Do NOT inject for sessions that merely have leftover Gate state —
    // that would pollute non-html-report turns (including /q) with Gate
    // instructions like "当前必须立即停止工具调用", breaking Pi's quit flow.
    if (sid && sid !== "unknown" && htmlReportPrompt && existingHtmlReportSession(sid)) {
      const gateState = readGateState(projectRoot, sid);
      if (gateState) {
        const banner = gateContextBanner(projectRoot, sid, gateState);
        if (banner) {
          const current = (event as PiBeforeAgentStartEvent).systemPrompt ?? "";
          return {
            systemPrompt: [current, banner].filter(Boolean).join("\n\n"),
          };
        }
      }
    }

    const current = (event as PiBeforeAgentStartEvent).systemPrompt ?? "";
    return {
      systemPrompt: [current, STATIC_SYSTEM_GUIDANCE].filter(Boolean).join("\n\n"),
    };
  });

  // --- Context handler (existing + Gate context) ---
  pi.on?.("context", async (event, ctx) => {
    const payload = event as PiContextEvent;
    const messages = payload.messages;
    if (!Array.isArray(messages)) return undefined;

    const authz = bindAuthzForTurn(projectRoot, authzStore, ctx, payload);

    const userMessage = latestUserMessage(messages);
    if (!userMessage) return { messages };

    // Skip harness recall for html-report skill sessions
    const sid = sessionId(ctx);
    const skipRecall = sid && sid !== "unknown" && suppressHarnessRecallForSkillSessions.has(sid);

    const context = skipRecall ? "" : await contextCache.getOrCreate(userMessage.key, () =>
      runHarnessContext(projectRoot, userMessage.prompt, ctx),
    );

    // Add Gate context banner only for active html-report skill turns.
    // Leftover Gate state from a previous session must not pollute
    // non-html-report turns (including /q) with Gate instructions.
    let gateBanner = "";
    if (sid && sid !== "unknown" && suppressHarnessRecallForSkillSessions.has(sid) && existingHtmlReportSession(sid)) {
      const gateState = readGateState(projectRoot, sid);
      if (gateState) {
        gateBanner = gateContextBanner(projectRoot, sid, gateState);
      }
    }

    const parts = [context, gateBanner, authzGuidance(authz.mode, authz.bound)].filter(Boolean);
    if (authz.mode === "on" && !authz.bound && authz.error) {
      ctx?.ui?.notify?.(`QDM Authz: ${authz.error}`, "warning");
    }
    if (!parts.length) return { messages };
    return { messages: appendHarnessContext(messages, userMessage.index, parts.join("\n\n")) };
  });

  // --- B0: tool_call handler — Gate decision + existing authz/posttool ---
  pi.on?.("tool_call", (event, ctx) => {
    const toolCall = event as PiToolCallEvent;

    // Normalize stage-gate commands (fix common model drifts)
    if (
      String(toolCall.toolName || "").toLowerCase() === "bash" &&
      isObject(toolCall.input) &&
      typeof toolCall.input.command === "string"
    ) {
      toolCall.input.command = normalizeStandaloneStageGateCommand(toolCall.input.command);
    }

    // Gate tool decision — only for active html-report skill turns.
    // Leftover Gate state must not block tools in non-html-report sessions.
    const sid = sessionId(ctx);
    const gateState = (sid && sid !== "unknown" && suppressHarnessRecallForSkillSessions.has(sid))
      ? readGateState(projectRoot, sid)
      : null;

    // Gate tool decision — block/allow based on Gate state
    if (gateState) {
      // Track finishing sessions
      const command = String(toolCall.input?.command || "");
      const parsed = parseStandaloneStageGateCommand(command);
      if (parsed && (parsed.operation === "finish" || parsed.operation === "fail")) {
        finishingSessions.add(sid);
      }

      const decision = gateToolDecision(gateState, toolCall, {
        finishInFlight: finishingSessions.has(sid),
      });
      if (decision) return decision;

      // Clear finishing flag after successful pass
      if (parsed && (parsed.operation === "finish" || parsed.operation === "fail")) {
        finishingSessions.delete(sid);
      }
    }

    // Existing authz logic
    const config = loadAuthzConfig(projectRoot);
    const metricCliPath = resolveMetricCliPath(projectRoot, config);
    let turn = authzStore.getCurrentTurn(sessionId(ctx));
    if (config.mode === "on" && !turn?.blob) {
      const rebound = bindAuthzForTurn(projectRoot, authzStore, ctx);
      turn = authzStore.getCurrentTurn(sessionId(ctx));
      if (process.env.QDM_HARNESS_DIAG === "1" && rebound.mode === "on") {
        const sidEnv = envelopeSessionId(ctx) || "(empty)";
        if (rebound.bound) {
          ctx?.ui?.notify?.(
            `QDM Authz diag: tool_call re-bind ok source=${rebound.source} sid=${sidEnv}`,
            "info",
          );
        } else {
          ctx?.ui?.notify?.(
            `QDM Authz diag: tool_call re-bind failed sid=${sidEnv} err=${rebound.error || "unknown"}`,
            "warning",
          );
        }
      }
    }

    const authzResult = applyAuthzToToolCall(event as PiToolCallEvent, {
      mode: config.mode,
      blob: turn?.blob ?? null,
      metricCliPath,
      allowLocalBlob: config.allowLocalBlob,
      missingReason: turn?.blob
        ? undefined
        : config.allowLocalBlob === false
          ? "authz: host blob not bound; cannot run gated metric-cli under allow_local_blob=false"
          : "authz mode is on but no encrypted auth blob is bound for this turn",
    });
    if (authzResult?.block) return authzResult;

    injectPosttool(projectRoot, event, ctx);
    return undefined;
  });

  // --- B0: Pause running gate on agent_settled ---
  pi.on?.("agent_settled", () => {
    // Best-effort: pause any running gate to prevent stale execution
    return undefined;
  });
}

// --- Additional exports needed by tests (B2-B5 stubs) ---

export function writeHtmlReportRuntimeContract(): void {
  // Stub — full implementation in later issues
}

export function isWaitingAConfigAgentList(gateState: unknown, event: unknown): boolean {
  if (!isObject(gateState) || !isObject(event)) return false;
  if (
    gateState.mode !== "step" ||
    gateState.status !== "awaiting_approval" ||
    gateState.currentStage !== "A_CONFIG"
  ) return false;
  return isExactRuntimeAgentList(event);
}

export function runningGateSubagentDecision(): unknown {
  // Stub — B2-B5 specific
  return undefined;
}

export function harnessQuestion(prompt: string): string {
  const match = prompt.match(/<\/skill>\s*([\s\S]+)$/i);
  return match ? match[1].trim() : prompt;
}

export function compactHtmlReportGateHistory(): string {
  return "[html-report prior Gate compacted]";
}

export function compactHtmlReportSkillHistory(prompt: string): string {
  return prompt;
}

export function normalizeResearcherEvidencePathLabel(): string {
  return "";
}

export function ensureResearcherCitationCommitRule(): unknown {
  return undefined;
}
