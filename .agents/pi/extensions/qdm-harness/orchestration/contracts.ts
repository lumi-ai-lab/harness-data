export const HTML_REPORT_KERNEL_API_VERSION = "v1";
export const HTML_REPORT_ADAPTER_VERSION = "0.0.46";

export type JsonObject = Record<string, unknown>;

export type ReportAgentStage =
  | "B2_WRITER"
  | "B25_EDITOR"
  | "B3_RESEARCH"
  | "B4_REVIEW"
  | "B5_DESIGN";

export type ReportAgentTransportKind =
  | "legacy-chain"
  | "delegation-v2"
  | "delegation-canonical";

export interface ReportAgentTurnBudget {
  maxTurns: number;
  graceTurns?: number;
}

export interface ReportAgentToolBudget {
  soft?: number;
  hard: number;
  block?: string[] | "*";
}

export interface ReportAgentInvocation {
  invocationId: string;
  ownerRunId: string;
  nodeId: string;
  sessionId: string;
  stage: ReportAgentStage;
  attempt: string;
  agent: string;
  task: string;
  cwd: string;
  context: "fresh" | "fork";
  resultSchema: JsonObject;
  timeoutMs: number;
  turnBudget?: ReportAgentTurnBudget;
  toolBudget?: ReportAgentToolBudget;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  skill?: string | string[] | boolean;
  artifacts?: boolean;
}

export interface ReportAgentProgress {
  requestId: string;
  transport: ReportAgentTransportKind;
  started: boolean;
  runId?: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string;
  recentOutputLines?: string[];
  recentTools?: Array<{ tool: string; args: string }>;
  model?: string;
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
}

export interface ReportAgentUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  turns?: number;
  toolCalls?: number;
  durationMs?: number;
}

export type ReportAgentFailureCode =
  | "invalid_request"
  | "unavailable_context"
  | "duplicate_node"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "turn_budget_exhausted"
  | "tool_budget_exhausted"
  | "structured_output_failed"
  | "acceptance_failed"
  | "transport_unavailable"
  | "transport_timeout"
  | "transport_protocol_error";

export type ReportAgentOutcome =
  | {
      status: "completed";
      value: unknown;
      requestId: string;
      started: true;
      transport: ReportAgentTransportKind;
      runId?: string;
      usage?: ReportAgentUsage;
    }
  | {
      status: "failed";
      code: ReportAgentFailureCode;
      message: string;
      requestId: string;
      started: boolean;
      transport: ReportAgentTransportKind;
      runId?: string;
      usage?: ReportAgentUsage;
      rawCause?: unknown;
    };

export interface ReportAgentLifecycleEvent {
  state: "EMITTED" | "STARTED" | "TERMINAL";
  requestId: string;
  invocationId: string;
  sessionId: string;
  stage: ReportAgentStage;
  attempt: string;
  transport: ReportAgentTransportKind;
  at: string;
  outcome?: ReportAgentOutcome;
}
