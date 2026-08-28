import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  JsonObject,
  ReportAgentFailureCode,
  ReportAgentInvocation,
  ReportAgentLifecycleEvent,
  ReportAgentOutcome,
  ReportAgentProgress,
  ReportAgentTransportKind,
  ReportAgentUsage,
} from "./contracts.ts";

const DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const DELEGATION_STARTED_EVENT = "prompt-template:subagent:started";
const DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
const DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
const DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

const SLASH_REQUEST_EVENT = "subagent:slash:request";
const SLASH_STARTED_EVENT = "subagent:slash:started";
const SLASH_UPDATE_EVENT = "subagent:slash:update";
const SLASH_RESPONSE_EVENT = "subagent:slash:response";
const SLASH_CANCEL_EVENT = "subagent:slash:cancel";

const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_SETTLEMENT_GRACE_MS = 5_000;

export interface ReportAgentEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

export interface SubagentTransportOptions {
  probeTimeoutMs?: number;
  settlementGraceMs?: number;
  now?: () => Date;
  requestId?: () => string;
  onLifecycle?: (event: ReportAgentLifecycleEvent) => void;
}

export interface ReportAgentTransport {
  readonly kind: ReportAgentTransportKind;
  invoke(
    invocation: ReportAgentInvocation,
    signal?: AbortSignal,
    onProgress?: (progress: ReportAgentProgress) => void,
  ): Promise<ReportAgentOutcome>;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => isObject(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
    .trim();
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function asUsage(value: unknown): ReportAgentUsage | undefined {
  if (!isObject(value)) return undefined;
  const usage: ReportAgentUsage = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns", "toolCalls", "durationMs"] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) usage[key] = value[key] as number;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function failureCode(value: unknown): ReportAgentFailureCode {
  const code = String(value || "failed") as ReportAgentFailureCode;
  return new Set<ReportAgentFailureCode>([
    "invalid_request",
    "unavailable_context",
    "duplicate_node",
    "failed",
    "timed_out",
    "cancelled",
    "interrupted",
    "turn_budget_exhausted",
    "tool_budget_exhausted",
    "structured_output_failed",
    "acceptance_failed",
  ]).has(code) ? code : "failed";
}

function validateInvocation(invocation: ReportAgentInvocation): string | null {
  for (const [field, value] of Object.entries({
    invocationId: invocation.invocationId,
    ownerRunId: invocation.ownerRunId,
    nodeId: invocation.nodeId,
    sessionId: invocation.sessionId,
    stage: invocation.stage,
    attempt: invocation.attempt,
    agent: invocation.agent,
    task: invocation.task,
    cwd: invocation.cwd,
  })) {
    if (typeof value !== "string" || !value.trim()) return `${field} must be a non-empty string`;
  }
  if (!isObject(invocation.resultSchema)) return "resultSchema must be one JSON Schema object";
  if (invocation.context !== "fresh" && invocation.context !== "fork") return "context must be fresh or fork";
  if (!Number.isSafeInteger(invocation.timeoutMs) || invocation.timeoutMs < 1) return "timeoutMs must be an integer >= 1";
  return null;
}

function subscribe(
  events: ReportAgentEventBus,
  event: string,
  handler: (data: unknown) => void,
  unsubscribers: Array<() => void>,
): void {
  const unsubscribe = events.on(event, handler);
  if (typeof unsubscribe !== "function") {
    throw new Error(`Pi event bus cannot unsubscribe ${event} listener`);
  }
  unsubscribers.push(unsubscribe);
}

function cancelPayload(kind: ReportAgentTransportKind, requestId: string, invocation: ReportAgentInvocation): JsonObject {
  if (kind === "legacy-chain") return { requestId };
  if (kind === "delegation-v2") {
    return { version: 2, requestId, ownerRunId: invocation.ownerRunId, nodeId: invocation.nodeId };
  }
  return { requestId, ownerRunId: invocation.ownerRunId, nodeId: invocation.nodeId };
}

function delegationRequest(
  kind: "delegation-v2" | "delegation-canonical",
  requestId: string,
  invocation: ReportAgentInvocation,
): JsonObject {
  return {
    ...(kind === "delegation-v2" ? { version: 2 } : {}),
    requestId,
    ownerRunId: invocation.ownerRunId,
    nodeId: invocation.nodeId,
    agent: invocation.agent,
    task: invocation.task,
    context: invocation.context,
    cwd: resolve(invocation.cwd),
    ...(invocation.model ? { model: invocation.model } : {}),
    ...(invocation.thinking ? { thinking: invocation.thinking } : {}),
    timeoutMs: invocation.timeoutMs,
    ...(invocation.turnBudget ? { turnBudget: invocation.turnBudget } : {}),
    ...(invocation.toolBudget ? { toolBudget: invocation.toolBudget } : {}),
    ...(invocation.skill !== undefined ? { skill: invocation.skill } : {}),
    ...(invocation.artifacts !== undefined ? { artifacts: invocation.artifacts } : {}),
    result: { kind: "structured", schema: invocation.resultSchema },
  };
}

function legacyRequest(requestId: string, invocation: ReportAgentInvocation): JsonObject {
  const step: JsonObject = {
    agent: invocation.agent,
    task: invocation.task,
    cwd: resolve(invocation.cwd),
    outputSchema: invocation.resultSchema,
    ...(invocation.model ? { model: invocation.model } : {}),
    ...(invocation.toolBudget ? { toolBudget: invocation.toolBudget } : {}),
    acceptance: {
      level: "none",
      reason: "qdm-harness validates the exact structured return and persisted artifacts.",
    },
  };
  return {
    requestId,
    params: {
      chain: [step],
      agentScope: "project",
      context: invocation.context,
      cwd: resolve(invocation.cwd),
      async: false,
      clarify: false,
      ...(invocation.turnBudget ? { turnBudget: invocation.turnBudget } : {}),
      maxRuntimeMs: invocation.timeoutMs,
    },
  };
}

function matchesDelegationIdentity(data: JsonObject, requestId: string, invocation: ReportAgentInvocation): boolean {
  return data.requestId === requestId &&
    data.ownerRunId === invocation.ownerRunId &&
    data.nodeId === invocation.nodeId;
}

function matchesDelegationResponseIdentity(data: JsonObject, requestId: string, invocation: ReportAgentInvocation): boolean {
  if (data.requestId !== requestId) return false;
  if (data.status !== "invalid_request") return matchesDelegationIdentity(data, requestId, invocation);
  if (data.ownerRunId !== undefined && data.ownerRunId !== invocation.ownerRunId) return false;
  if (data.nodeId !== undefined && data.nodeId !== invocation.nodeId) return false;
  return true;
}

function lifecycle(
  options: SubagentTransportOptions,
  invocation: ReportAgentInvocation,
  requestId: string,
  transport: ReportAgentTransportKind,
  state: ReportAgentLifecycleEvent["state"],
  outcome?: ReportAgentOutcome,
): void {
  options.onLifecycle?.({
    state,
    requestId,
    invocationId: invocation.invocationId,
    sessionId: invocation.sessionId,
    stage: invocation.stage,
    attempt: invocation.attempt,
    transport,
    at: (options.now?.() ?? new Date()).toISOString(),
    ...(outcome ? { outcome } : {}),
  });
}

function invokeDelegation(
  events: ReportAgentEventBus,
  kind: "delegation-v2" | "delegation-canonical",
  invocation: ReportAgentInvocation,
  options: SubagentTransportOptions,
  signal?: AbortSignal,
  onProgress?: (progress: ReportAgentProgress) => void,
): Promise<ReportAgentOutcome> {
  const requestId = options.requestId?.() ?? randomUUID();
  const invalid = validateInvocation(invocation);
  if (invalid) {
    return Promise.resolve({
      status: "failed",
      code: "invalid_request",
      message: invalid,
      requestId,
      started: false,
      transport: kind,
    });
  }
  if (signal?.aborted) {
    return Promise.resolve({
      status: "failed",
      code: "cancelled",
      message: "Report agent invocation was cancelled before emission.",
      requestId,
      started: false,
      transport: kind,
    });
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    let started = false;
    let lifecycleEmitted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      while (unsubscribers.length) {
        try { unsubscribers.pop()?.(); } catch { /* best-effort terminal cleanup */ }
      }
    };
    const finish = (outcome: ReportAgentOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      let finalOutcome = outcome;
      if (lifecycleEmitted) {
        try {
          lifecycle(options, invocation, requestId, kind, "TERMINAL", outcome);
        } catch (error) {
          finalOutcome = {
            status: "failed",
            code: "transport_protocol_error",
            message: `Cannot persist terminal transport lifecycle: ${error instanceof Error ? error.message : String(error)}`,
            requestId,
            started,
            transport: kind,
            rawCause: error,
          };
        }
      }
      resolvePromise(finalOutcome);
    };
    const fail = (code: ReportAgentFailureCode, message: string, rawCause?: unknown, runId?: string, usage?: ReportAgentUsage): void => {
      finish({
        status: "failed",
        code,
        message,
        requestId,
        started,
        transport: kind,
        ...(runId ? { runId } : {}),
        ...(usage ? { usage } : {}),
        ...(rawCause !== undefined ? { rawCause } : {}),
      });
    };
    const onAbort = (): void => {
      if (settled) return;
      try { events.emit(DELEGATION_CANCEL_EVENT, cancelPayload(kind, requestId, invocation)); } catch { /* cancellation remains terminal */ }
      fail("cancelled", started ? "Report agent invocation was cancelled." : "Report agent invocation was cancelled before STARTED.");
    };
    const emitProgress = (progress: ReportAgentProgress): void => {
      try { onProgress?.(progress); } catch { /* progress UI must not fail the child */ }
    };
    const onStarted = (data: unknown): void => {
      if (settled || started || !isObject(data) || !matchesDelegationIdentity(data, requestId, invocation)) return;
      if (kind === "delegation-v2" ? data.version !== 2 : Object.hasOwn(data, "version")) return;
      started = true;
      try {
        lifecycle(options, invocation, requestId, kind, "STARTED");
      } catch (error) {
        try { events.emit(DELEGATION_CANCEL_EVENT, cancelPayload(kind, requestId, invocation)); } catch { /* fail closed below */ }
        fail("transport_protocol_error", `Cannot persist STARTED transport lifecycle: ${error instanceof Error ? error.message : String(error)}`, error);
        return;
      }
      emitProgress({
        requestId,
        transport: kind,
        started: true,
        ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
      });
    };
    const onUpdate = (data: unknown): void => {
      if (settled || !isObject(data) || !matchesDelegationIdentity(data, requestId, invocation)) return;
      emitProgress({
        requestId,
        transport: kind,
        started,
        ...(typeof data.runId === "string" ? { runId: data.runId } : {}),
        ...(typeof data.currentTool === "string" ? { currentTool: data.currentTool } : {}),
        ...(typeof data.currentToolArgs === "string" ? { currentToolArgs: data.currentToolArgs } : {}),
        ...(typeof data.recentOutput === "string" ? { recentOutput: data.recentOutput } : {}),
        ...(Array.isArray(data.recentOutputLines) ? { recentOutputLines: data.recentOutputLines.filter((line): line is string => typeof line === "string") } : {}),
        ...(Array.isArray(data.recentTools) ? { recentTools: data.recentTools.filter(isObject).map((item) => ({ tool: String(item.tool || ""), args: String(item.args || "") })) } : {}),
        ...(typeof data.model === "string" ? { model: data.model } : {}),
        ...(typeof data.toolCount === "number" ? { toolCount: data.toolCount } : {}),
        ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
        ...(typeof data.tokens === "number" ? { tokens: data.tokens } : {}),
      });
    };
    const onResponse = (data: unknown): void => {
      if (settled || !isObject(data) || !matchesDelegationResponseIdentity(data, requestId, invocation)) return;
      if (kind === "delegation-v2" ? data.version !== 2 : Object.hasOwn(data, "version")) return;
      const status = String(data.status || "failed");
      const runId = typeof data.runId === "string" ? data.runId : undefined;
      const usage = asUsage(data.usage);
      if (status === "completed") {
        if (!started) {
          fail("transport_protocol_error", "Delegation completed before STARTED.", data, runId, usage);
          return;
        }
        if (!isObject(data.result) || data.result.kind !== "structured" || !("value" in data.result)) {
          fail("structured_output_failed", "Delegation completed without the requested structured result.", data, runId, usage);
          return;
        }
        finish({
          status: "completed",
          value: data.result.value,
          requestId,
          started: true,
          transport: kind,
          ...(runId ? { runId } : {}),
          ...(usage ? { usage } : {}),
        });
        return;
      }
      const code = failureCode(status);
      fail(code, typeof data.error === "string" && data.error.trim() ? data.error : `Delegation ended with status ${status}.`, data, runId, usage);
    };

    try {
      subscribe(events, DELEGATION_STARTED_EVENT, onStarted, unsubscribers);
      subscribe(events, DELEGATION_UPDATE_EVENT, onUpdate, unsubscribers);
      subscribe(events, DELEGATION_RESPONSE_EVENT, onResponse, unsubscribers);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (settled) return;
        try { events.emit(DELEGATION_CANCEL_EVENT, cancelPayload(kind, requestId, invocation)); } catch { /* timeout remains terminal */ }
        fail("transport_timeout", `No terminal delegation response arrived within ${invocation.timeoutMs + positiveTimeout(options.settlementGraceMs, DEFAULT_SETTLEMENT_GRACE_MS)}ms.`);
      }, invocation.timeoutMs + positiveTimeout(options.settlementGraceMs, DEFAULT_SETTLEMENT_GRACE_MS));
      try {
        lifecycle(options, invocation, requestId, kind, "EMITTED");
        lifecycleEmitted = true;
      } catch (error) {
        fail(
          "transport_protocol_error",
          `Cannot persist EMITTED transport lifecycle: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
        return;
      }
      events.emit(DELEGATION_REQUEST_EVENT, delegationRequest(kind, requestId, invocation));
    } catch (error) {
      fail("transport_unavailable", `Delegation event bridge failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  });
}

function invokeLegacy(
  events: ReportAgentEventBus,
  invocation: ReportAgentInvocation,
  options: SubagentTransportOptions,
  signal?: AbortSignal,
  onProgress?: (progress: ReportAgentProgress) => void,
): Promise<ReportAgentOutcome> {
  const kind = "legacy-chain" as const;
  const requestId = options.requestId?.() ?? randomUUID();
  const invalid = validateInvocation(invocation);
  if (invalid) {
    return Promise.resolve({ status: "failed", code: "invalid_request", message: invalid, requestId, started: false, transport: kind });
  }
  if (signal?.aborted) {
    return Promise.resolve({ status: "failed", code: "cancelled", message: "Report agent invocation was cancelled before emission.", requestId, started: false, transport: kind });
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    let started = false;
    let lifecycleEmitted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      while (unsubscribers.length) {
        try { unsubscribers.pop()?.(); } catch { /* best-effort terminal cleanup */ }
      }
    };
    const finish = (outcome: ReportAgentOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      let finalOutcome = outcome;
      if (lifecycleEmitted) {
        try {
          lifecycle(options, invocation, requestId, kind, "TERMINAL", outcome);
        } catch (error) {
          finalOutcome = {
            status: "failed",
            code: "transport_protocol_error",
            message: `Cannot persist terminal transport lifecycle: ${error instanceof Error ? error.message : String(error)}`,
            requestId,
            started,
            transport: kind,
            rawCause: error,
          };
        }
      }
      resolvePromise(finalOutcome);
    };
    const fail = (code: ReportAgentFailureCode, message: string, rawCause?: unknown, runId?: string, usage?: ReportAgentUsage): void => {
      finish({ status: "failed", code, message, requestId, started, transport: kind, ...(runId ? { runId } : {}), ...(usage ? { usage } : {}), ...(rawCause !== undefined ? { rawCause } : {}) });
    };
    const onAbort = (): void => {
      if (settled) return;
      try { events.emit(SLASH_CANCEL_EVENT, { requestId }); } catch { /* cancellation remains terminal */ }
      fail("cancelled", started ? "Report agent invocation was cancelled." : "Report agent invocation was cancelled before STARTED.");
    };
    const emitProgress = (progress: ReportAgentProgress): void => {
      try { onProgress?.(progress); } catch { /* progress UI must not fail the child */ }
    };
    const onStarted = (data: unknown): void => {
      if (settled || started || !isObject(data) || data.requestId !== requestId) return;
      started = true;
      try {
        lifecycle(options, invocation, requestId, kind, "STARTED");
      } catch (error) {
        try { events.emit(SLASH_CANCEL_EVENT, { requestId }); } catch { /* fail closed below */ }
        fail(
          "transport_protocol_error",
          `Cannot persist STARTED transport lifecycle: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
        return;
      }
      emitProgress({ requestId, transport: kind, started: true });
    };
    const onUpdate = (data: unknown): void => {
      if (settled || !isObject(data) || data.requestId !== requestId) return;
      emitProgress({
        requestId,
        transport: kind,
        started,
        ...(typeof data.currentTool === "string" ? { currentTool: data.currentTool } : {}),
        ...(typeof data.toolCount === "number" ? { toolCount: data.toolCount } : {}),
      });
    };
    const onResponse = (data: unknown): void => {
      if (settled || !isObject(data) || data.requestId !== requestId) return;
      const resultEnvelope = isObject(data.result) ? data.result : {};
      const contentText = textContent(resultEnvelope.content);
      const details = isObject(resultEnvelope.details) ? resultEnvelope.details : {};
      const results = Array.isArray(details.results) ? details.results : [];
      const child = results.length === 1 && isObject(results[0]) ? results[0] : null;
      const removedChain = data.isError === true && !started && /legacy top-level chain|use workflowScript|chain.*removed/i.test(
        [String(data.errorText || ""), contentText].filter(Boolean).join("\n"),
      );
      if (removedChain) {
        fail("invalid_request", String(data.errorText || contentText || "Legacy chain request was rejected."), data);
        return;
      }
      if (!started) {
        fail("transport_protocol_error", "Legacy chain bridge responded before STARTED.", data);
        return;
      }
      const runId = child && typeof child.runId === "string" ? child.runId : undefined;
      const usage = child ? asUsage(child.usage) : undefined;
      if (data.isError === true || resultEnvelope.isError === true || !child || child.exitCode !== 0) {
        fail("failed", String(child?.error || data.errorText || contentText || "Legacy chain execution failed."), data, runId, usage);
        return;
      }
      if (!("structuredOutput" in child)) {
        fail("structured_output_failed", "Legacy chain completed without the requested structured output.", data, runId, usage);
        return;
      }
      finish({ status: "completed", value: child.structuredOutput, requestId, started: true, transport: kind, ...(runId ? { runId } : {}), ...(usage ? { usage } : {}) });
    };

    try {
      subscribe(events, SLASH_STARTED_EVENT, onStarted, unsubscribers);
      subscribe(events, SLASH_UPDATE_EVENT, onUpdate, unsubscribers);
      subscribe(events, SLASH_RESPONSE_EVENT, onResponse, unsubscribers);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (settled) return;
        try { events.emit(SLASH_CANCEL_EVENT, { requestId }); } catch { /* timeout remains terminal */ }
        fail("transport_timeout", `No terminal legacy chain response arrived within ${invocation.timeoutMs + positiveTimeout(options.settlementGraceMs, DEFAULT_SETTLEMENT_GRACE_MS)}ms.`);
      }, invocation.timeoutMs + positiveTimeout(options.settlementGraceMs, DEFAULT_SETTLEMENT_GRACE_MS));
      try {
        lifecycle(options, invocation, requestId, kind, "EMITTED");
        lifecycleEmitted = true;
      } catch (error) {
        fail(
          "transport_protocol_error",
          `Cannot persist EMITTED transport lifecycle: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
        return;
      }
      events.emit(SLASH_REQUEST_EVENT, legacyRequest(requestId, invocation));
      if (!settled && !started) {
        fail("transport_protocol_error", "Legacy chain bridge did not emit STARTED synchronously.");
      }
    } catch (error) {
      fail("transport_unavailable", `Legacy chain event bridge failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
  });
}

export async function probeSubagentTransport(
  events: ReportAgentEventBus,
  options: Pick<SubagentTransportOptions, "probeTimeoutMs" | "requestId"> = {},
): Promise<ReportAgentTransportKind> {
  if (!events || typeof events.on !== "function" || typeof events.emit !== "function") {
    throw new Error("pi-subagents event bridge is unavailable");
  }
  const requestId = options.requestId?.() ?? randomUUID();
  const ownerRunId = `qdm-probe-owner-${requestId}`;
  const nodeId = `qdm-probe-node-${requestId}`;
  const probe = { version: 2, requestId, ownerRunId, nodeId };

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      while (unsubscribers.length) {
        try { unsubscribers.pop()?.(); } catch { /* best-effort probe cleanup */ }
      }
    };
    const finish = (next: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      next();
    };
    const reject = (message: string): void => finish(() => rejectPromise(new Error(message)));
    const onStarted = (data: unknown): void => {
      if (settled || !isObject(data) || data.requestId !== requestId) return;
      const payload = data.version === 1
        ? { version: 1, requestId }
        : data.version === 2
          ? probe
          : { requestId, ownerRunId, nodeId };
      try { events.emit(DELEGATION_CANCEL_EVENT, payload); } catch { /* fail closed below */ }
      reject("pi-subagents capability probe unexpectedly STARTED a child; the request was cancelled");
    };
    const onResponse = (data: unknown): void => {
      if (settled || !isObject(data) || data.requestId !== requestId || data.status !== "invalid_request") return;
      if (data.version === 1) {
        finish(() => resolvePromise("legacy-chain"));
        return;
      }
      if (data.version === 2 && data.ownerRunId === ownerRunId && data.nodeId === nodeId) {
        finish(() => resolvePromise("delegation-v2"));
        return;
      }
      if (!Object.hasOwn(data, "version") && data.ownerRunId === ownerRunId && data.nodeId === nodeId) {
        finish(() => resolvePromise("delegation-canonical"));
        return;
      }
      reject("pi-subagents capability probe returned an unknown invalid_request shape");
    };

    try {
      subscribe(events, DELEGATION_STARTED_EVENT, onStarted, unsubscribers);
      subscribe(events, DELEGATION_RESPONSE_EVENT, onResponse, unsubscribers);
      timer = setTimeout(
        () => reject(`pi-subagents capability probe timed out after ${positiveTimeout(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS)}ms`),
        positiveTimeout(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
      );
      events.emit(DELEGATION_REQUEST_EVENT, probe);
    } catch (error) {
      reject(`pi-subagents capability probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export class SubagentTransportManager {
  #kind: ReportAgentTransportKind | null = null;
  #negotiating: Promise<ReportAgentTransportKind> | null = null;
  private readonly events: ReportAgentEventBus;
  private readonly options: SubagentTransportOptions;

  constructor(events: ReportAgentEventBus, options: SubagentTransportOptions = {}) {
    this.events = events;
    this.options = options;
  }

  get negotiatedKind(): ReportAgentTransportKind | null {
    return this.#kind;
  }

  reset(): void {
    this.#kind = null;
    this.#negotiating = null;
  }

  async negotiate(): Promise<ReportAgentTransportKind> {
    if (this.#kind) return this.#kind;
    if (!this.#negotiating) {
      this.#negotiating = probeSubagentTransport(this.events, this.options)
        .then((kind) => {
          this.#kind = kind;
          return kind;
        })
        .finally(() => {
          this.#negotiating = null;
        });
    }
    return this.#negotiating;
  }

  transport(kind: ReportAgentTransportKind): ReportAgentTransport {
    return {
      kind,
      invoke: (invocation, signal, onProgress) => kind === "legacy-chain"
        ? invokeLegacy(this.events, invocation, this.options, signal, onProgress)
        : invokeDelegation(this.events, kind, invocation, this.options, signal, onProgress),
    };
  }

  async invoke(
    invocation: ReportAgentInvocation,
    signal?: AbortSignal,
    onProgress?: (progress: ReportAgentProgress) => void,
  ): Promise<ReportAgentOutcome> {
    let kind: ReportAgentTransportKind;
    try {
      kind = await this.negotiate();
    } catch (error) {
      return {
        status: "failed",
        code: "transport_unavailable",
        message: error instanceof Error ? error.message : String(error),
        requestId: this.options.requestId?.() ?? randomUUID(),
        started: false,
        transport: "delegation-canonical",
        rawCause: error,
      };
    }
    const first = await this.transport(kind).invoke(invocation, signal, onProgress);
    if (first.status !== "failed" || first.started || first.code !== "invalid_request" || signal?.aborted) return first;

    this.reset();
    let renegotiated: ReportAgentTransportKind;
    try {
      renegotiated = await this.negotiate();
    } catch {
      return first;
    }
    if (renegotiated === kind) return first;
    return this.transport(renegotiated).invoke(invocation, signal, onProgress);
  }
}
