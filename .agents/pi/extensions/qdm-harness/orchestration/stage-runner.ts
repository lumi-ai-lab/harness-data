import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type {
  JsonObject,
  ReportAgentLifecycleEvent,
  ReportAgentStage,
  ReportAgentTransportKind,
} from "./contracts.ts";

const STATE_VERSION = 1;
const STATE_PRODUCER = "qdm-harness-stage-runner";

export interface HtmlReportStageRunIdentity {
  sessionId: string;
  sessionDir: string;
  stage: ReportAgentStage;
  attempt: string;
  reservation: string;
}

export interface HtmlReportStageRunResult {
  status: "completed" | "failed";
  text: string;
  transport?: ReportAgentTransportKind;
  details?: JsonObject;
}

interface StageRunRecord extends JsonObject {
  version: 1;
  producer: typeof STATE_PRODUCER;
  sessionId: string;
  sessionDir: string;
  stage: ReportAgentStage;
  attempt: string;
  reservation: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  transport?: ReportAgentTransportKind;
  message?: string;
  details?: JsonObject;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

function runtimeDir(sessionDir: string): string {
  return join(sessionDir, "debug", "contract-runtime");
}

export function stageRunMarkerPath(identity: HtmlReportStageRunIdentity): string {
  return join(
    runtimeDir(identity.sessionDir),
    "stage-runs",
    `${digest(JSON.stringify([identity.sessionId, identity.stage, identity.attempt, identity.reservation]))}.json`,
  );
}

export function settlementMarkerPath(sessionDir: string, invocationId: string, requestId: string): string {
  return join(runtimeDir(sessionDir), "settlements", `${digest(JSON.stringify([invocationId, requestId]))}.json`);
}

function validateIdentity(identity: HtmlReportStageRunIdentity): string | null {
  for (const [field, value] of Object.entries(identity)) {
    if (typeof value !== "string" || !value.trim()) return `${field} must be a non-empty string`;
  }
  return null;
}

function readRecord(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain one JSON object`);
  return value as JsonObject;
}

function sameStageRun(record: JsonObject, identity: HtmlReportStageRunIdentity): boolean {
  return record.version === STATE_VERSION &&
    record.producer === STATE_PRODUCER &&
    record.sessionId === identity.sessionId &&
    record.sessionDir === identity.sessionDir &&
    record.stage === identity.stage &&
    record.attempt === identity.attempt &&
    record.reservation === identity.reservation;
}

export function persistReportAgentLifecycle(
  sessionDir: string,
  event: ReportAgentLifecycleEvent,
): void {
  const path = settlementMarkerPath(sessionDir, event.invocationId, event.requestId);
  if (event.state === "EMITTED") {
    const initial = {
      version: STATE_VERSION,
      producer: STATE_PRODUCER,
      invocationId: event.invocationId,
      sessionId: event.sessionId,
      stage: event.stage,
      attempt: event.attempt,
      requestId: event.requestId,
      transport: event.transport,
      state: event.state,
      emittedAt: event.at,
      history: [{ state: event.state, at: event.at }],
    };
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const existing = readRecord(path);
      if (
        existing.invocationId === event.invocationId &&
        existing.sessionId === event.sessionId &&
        existing.stage === event.stage &&
        existing.attempt === event.attempt &&
        existing.requestId === event.requestId &&
        existing.transport === event.transport &&
        existing.state === "EMITTED"
      ) return;
      throw new Error(`report agent invocation ${event.invocationId} already has a durable settlement record`);
    }
  }

  if (!existsSync(path)) throw new Error(`report agent invocation ${event.invocationId} has no EMITTED settlement`);
  const current = readRecord(path);
  if (
    current.version !== STATE_VERSION ||
    current.producer !== STATE_PRODUCER ||
    current.invocationId !== event.invocationId ||
    current.sessionId !== event.sessionId ||
    current.stage !== event.stage ||
    current.attempt !== event.attempt ||
    current.requestId !== event.requestId ||
    current.transport !== event.transport
  ) {
    throw new Error(`report agent invocation ${event.invocationId} settlement identity mismatch`);
  }
  if (current.state === "TERMINAL") return;
  if (event.state === "STARTED" && current.state !== "EMITTED") {
    throw new Error(`report agent invocation ${event.invocationId} STARTED from invalid state ${String(current.state)}`);
  }
  if (event.state === "TERMINAL" && current.state !== "EMITTED" && current.state !== "STARTED") {
    throw new Error(`report agent invocation ${event.invocationId} TERMINAL from invalid state ${String(current.state)}`);
  }
  const history = Array.isArray(current.history) ? current.history : [];
  atomicJson(path, {
    ...current,
    state: event.state,
    ...(event.state === "STARTED" ? { startedAt: event.at } : {}),
    ...(event.state === "TERMINAL" ? { terminalAt: event.at, outcome: event.outcome } : {}),
    history: [...history, { state: event.state, at: event.at }],
  });
}

export class HtmlReportStageRunner {
  async run(
    identity: HtmlReportStageRunIdentity,
    execute: () => Promise<HtmlReportStageRunResult>,
  ): Promise<HtmlReportStageRunResult> {
    const invalid = validateIdentity(identity);
    if (invalid) return { status: "failed", text: `html-report stage reservation is invalid: ${invalid}` };
    const markerPath = stageRunMarkerPath(identity);
    const startedAt = new Date().toISOString();
    const record: StageRunRecord = {
      version: STATE_VERSION,
      producer: STATE_PRODUCER,
      sessionId: identity.sessionId,
      sessionDir: identity.sessionDir,
      stage: identity.stage,
      attempt: identity.attempt,
      reservation: identity.reservation,
      status: "running",
      startedAt,
    };

    mkdirSync(dirname(markerPath), { recursive: true });
    try {
      writeFileSync(markerPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") {
        return { status: "failed", text: `cannot reserve html-report stage run: ${error instanceof Error ? error.message : String(error)}` };
      }
      try {
        const existing = readRecord(markerPath);
        if (!sameStageRun(existing, identity)) {
          return { status: "failed", text: "html-report stage reservation collides with a different durable run" };
        }
        return {
          status: "failed",
          text: existing.status === "running"
            ? "html-report stage run is already reserved; its STARTED state is unknown, so it will not be replayed"
            : `html-report stage run is already ${String(existing.status)} and cannot be replayed`,
          ...(typeof existing.transport === "string" ? { transport: existing.transport as ReportAgentTransportKind } : {}),
        };
      } catch (readError) {
        return { status: "failed", text: `html-report stage reservation is unreadable: ${readError instanceof Error ? readError.message : String(readError)}` };
      }
    }

    let result: HtmlReportStageRunResult;
    try {
      result = await execute();
    } catch (error) {
      result = {
        status: "failed",
        text: `html-report stage runner failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    atomicJson(markerPath, {
      ...record,
      status: result.status,
      endedAt: new Date().toISOString(),
      ...(result.transport ? { transport: result.transport } : {}),
      message: result.text,
      ...(result.details ? { details: result.details } : {}),
    });
    return result;
  }
}
