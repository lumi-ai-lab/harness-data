import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { stat, lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { loadAuthzConfig, resolveAuthBlob, resolveMetricCliPath } from "./authz-config.mjs";
import { applyAuthzToToolCall } from "./authz-inject.mjs";
import { AuthzStateStore } from "./authz-store.mjs";
import {
  applyGateInput,
  b25EditorBootstrapContract,
  classifyGateInput,
  gateAttemptToken as gateAttemptTokenFromState,
  gateContextBanner,
  gateToolDecision,
  htmlReportSessionDir,
  b2WriterMainWorkAccepted,
  htmlReportStageReservation,
  HTML_REPORT_RUNNER_STAGES,
  HTML_REPORT_STAGE_TOOL,
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
import {
  buildWriterReturnSchema,
  captionPathFor,
  extractWriterReceipt,
  isWriterEmptyOutputError,
  isWriterMissingStructuredOutputError,
  validateWriterReturn,
  writerReturnPathsForResult,
} from "../../skills/html-report/scripts/writer-return.mjs";
import { reusableEntry, fetchAllEntries } from "../../skills/html-report/scripts/fetch-entry.mjs";
import {
  buildResearcherReturnSchema,
  researcherExpectedFromAssignment,
  validateResearcherArtifacts,
} from "../../skills/html-report/scripts/researcher-return.mjs";
import { canonicalizeJson } from "../../skills/html-report/scripts/prepare-research-evidence.mjs";
import {
  buildReviewerReturnSchema,
  reviewerExpectedFromAssignment,
  validateReviewerArtifacts,
} from "../../skills/html-report/scripts/reviewer-return.mjs";
import {
  buildDesignerReturnSchema,
  designerExpectedFromAssignment,
  validateDesignerArtifacts,
} from "../../skills/html-report/scripts/designer-return.mjs";
import { checkSessionLayout } from "../../skills/html-report/scripts/check-session-layout.mjs";
import {
  REPORT_AGENT_ROLES,
  isReportAgentName,
  rememberObservedReportAgentsFromListText,
  reportAgentDispatchName,
  runtimeListHasReportAgent,
} from "../shared/report-agents.mjs";
import {
  HTML_REPORT_ADAPTER_VERSION,
  HTML_REPORT_KERNEL_API_VERSION,
} from "./orchestration/contracts.ts";
import { composeMain } from "../../skills/html-report/scripts/compose-main.mjs";
import {
  PARENT_REVIEWER_SCAN_MARKER,
  REVIEWER_INPUT_MAX_BYTES,
} from "../report-reviewer-guard/guard.mjs";
import {
  EDITOR_PLANNER_MARKER,
  buildEditorPlanSchema,
  editorPlannerExpectedFromAssignment,
  isEditorPlannerAssignment,
  normalizeEditorPlan,
  requiredColumnsForOperations,
  persistEditorWriterReturn,
  validateEditorPlan,
} from "../../skills/html-report/scripts/editor-plan-contract.mjs";
import { materializeEditorPlan } from "../../skills/html-report/scripts/editor-plan.mjs";
import type { ReportAgentInvocation, ReportAgentOutcome, ReportAgentProgress, ReportAgentStage } from "./orchestration/contracts.ts";
import { SubagentTransportManager } from "./orchestration/subagent-transport.ts";
import {
  HtmlReportStageRunner,
  persistReportAgentLifecycle,
  type HtmlReportStageRunResult,
} from "./orchestration/stage-runner.ts";
import {
  HtmlReportStageProgressSession,
  STAGE_PROGRESS_PHASE,
  extractStageProgress,
  renderStageProgressCall,
  renderStageProgressResult,
  researcherProgressSeed,
  writerProgressSeed,
  type HtmlReportProgressItemSeed,
} from "./orchestration/stage-progress.ts";

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
    setWidget?: (key: string, content: string[] | undefined) => void;
  };
}

interface PiEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | void;
  emit(event: string, data: unknown): void;
}

interface PiContextEvent {
  messages?: unknown[];
  /** Host may attach encrypted auth material outside user-visible prompt text. */
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

interface GateToolInFlight {
  sessionId: string;
  stageId: string;
  operation: "finish" | "fail";
}

interface B2StartupStatusRecord {
  key: string;
  sessionId: string;
  attempt: string;
  phase: "inflight" | "passed" | "dispatched" | "failed";
  toolCallId?: string;
  nextTool?: DeterministicNextTool;
}

interface DeterministicNextTool {
  toolName: "subagent" | "bash";
  input: JsonObject;
  invocation: string;
}

interface B3HandoffToolRecord extends DeterministicNextTool {
  key: string;
  sessionId: string;
  attempt: string;
}

interface B3FinalizerInFlight {
  toolCallId: string;
  sessionId: string;
  attempt: string;
  input: JsonObject;
}

interface B3FinalizerReservation extends JsonObject {
  version: 1;
  producer: "qdm-harness";
  sessionId: string;
  stageId: "B3_RESEARCH";
  attempt: string;
  toolCallId: string;
  command: string;
  resultPath: string;
  inputSha256: string;
  createdAt: string;
}

interface RuntimeAgentListRecord {
  key: string;
  sessionId: string;
  stageId: "A_CONFIG" | "B0_PREFLIGHT";
  attempt: string;
  toolCallId: string;
  mechanism: "model-tool" | "extension-event-bridge";
  status: "inflight" | "passed" | "failed";
  observedAgents?: string[];
  missingAgents?: string[];
  error?: string;
}

interface RuntimeAgentListAudit extends JsonObject {
  version: 1;
  producer: "qdm-harness";
  mechanism: "extension-event-bridge";
  sessionId: string;
  stageId: "A_CONFIG" | "B0_PREFLIGHT";
  attempt: string;
  requestId: string;
  status: "inflight" | "passed" | "failed";
  required: string[];
  observed: string[];
  missing: string[];
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  result?: {
    isError: boolean;
    text: string;
    sha256: string;
  };
  error?: string;
  auditSha256: string;
}

interface B25BootstrapRecord {
  key: string;
  sessionId: string;
  attempt: string;
  statusToolCallId?: string;
  sourceFieldsToolCallId?: string;
  statusResult: "pending" | "passed" | "failed";
  sourceFieldsResult: "pending" | "passed" | "failed";
  plannerStarted: boolean;
}

interface ContractDispatchIdentity {
  key: string;
  sessionId: string;
  attempt: string;
  taskId?: string;
  researcherTask?: JsonObject;
  role: ContractDispatchRole;
  label: string;
  maxDispatches: number;
}

interface ContractDispatchRecord {
  count: number;
  terminalReason?: string;
}

interface ContractCallInFlight {
  toolCallId: string;
  sessionId: string;
  identity: ContractDispatchIdentity;
  inputFingerprint: string;
  input: JsonObject;
}

interface ReviewerParentTerminal {
  attempt: string;
  status: "passed" | "failed" | "infrastructure_error" | "contract_error";
  sessionDir: string;
  stageId: "B4_REVIEW";
  repairLogPath: string;
}

type ResearcherParentFailureCode =
  | "runtime_timeout"
  | "missing_structured_output"
  | "invalid_return_or_artifacts"
  | "structured_status_failed";

interface ResearcherParentTerminal {
  attempt: string;
  status: "contract_error";
  failureCode: ResearcherParentFailureCode;
  gateFailureReason: string;
  sessionDir: string;
  stageId: "B3_RESEARCH";
}

const CONTRACT_RUNTIME_TIMEOUT = /\bETIMEDOUT\b|\bmaxRuntime(?:Ms)?\b|\btime(?:d)?\s*out\b|\btimeout\b|超时/i;
// B25_EDITOR has a 120s hard budget. Leave enough headroom after the parent
// dispatch and before deterministic materialize/finalize work so the child
// reports its own timeout instead of being killed by the stage watchdog.
const EDITOR_PLANNER_MAX_RUNTIME_MS = 75_000;
// Planner is a one-shot typed decision, so its model is capability-pinned and
// must not inherit an arbitrary parent model. This is role infrastructure,
// independent of the user's question, indicators, dimensions, or card data.
const EDITOR_PLANNER_MODEL = "qdm-market/deepseek-v4-flash";
// B4 is a bounded qualitative judgment over five frozen inputs. The fast role
// model avoids the observed long reasoning stalls while the deterministic scan,
// typed scorecard tool and parent layout remain the authority for artifacts.
const REPORT_REVIEWER_MODEL = "qdm-market/deepseek-v4-flash";
const REPORT_REVIEWER_MAX_RUNTIME_MS = 150_000;
const REQUIRED_REPORT_AGENTS = REPORT_AGENT_ROLES;

type ContextFormat = "agent-hook" | "json";

interface CliContextPayload {
  question?: string;
  contextFiles?: Array<{ path?: unknown }>;
  instruction?: string;
  constraints?: unknown;
}

interface FixedRecommendationSeed {
  preset?: string;
  recommendationsPath?: string;
  markerPath?: string;
  serverUrl?: string | null;
  cardCount?: number;
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageResourceRoot = resolve(extensionDir, "../..");
const extractContextScript = join(extensionDir, "extract-additional-context.mjs");
let contextFormat: ContextFormat | null = null;
let posttoolFormat: "agent-hook" | "claude-hook" = "agent-hook";

/**
 * Files whose behavior is captured by the long-lived Pi process: extension
 * modules, structured-return contracts, and the registered report-agent
 * prompts. If one changes on disk, continuing an html-report run would mix
 * old in-memory code/prompts with new files. Keep this list explicit so a
 * restart is required only for runtime-bearing files, not report artifacts.
 */
export const HTML_REPORT_RUNTIME_SOURCE_FILES = [
  ".agents/pi/extensions/qdm-harness/index.ts",
  ".agents/pi/extensions/qdm-harness/gate-control.mjs",
  ".agents/pi/extensions/qdm-harness/orchestration/contracts.ts",
  ".agents/pi/extensions/qdm-harness/orchestration/subagent-transport.ts",
  ".agents/pi/extensions/qdm-harness/orchestration/stage-runner.ts",
  ".agents/pi/extensions/qdm-harness/extract-additional-context.mjs",
  ".agents/pi/extensions/report-writer-fetch/index.mjs",
  ".agents/pi/extensions/report-writer-fetch/lifecycle.mjs",
  ".agents/pi/extensions/report-researcher-guard/index.mjs",
  ".agents/pi/extensions/report-researcher-guard/guard.mjs",
  ".agents/pi/extensions/shared/subagent-structured-output-capture.mjs",
  ".agents/pi/extensions/shared/report-agents.mjs",
  ".agents/pi/extensions/shared/script-paths.mjs",
  ".agents/pi/extensions/report-reviewer-guard/index.mjs",
  ".agents/pi/extensions/report-reviewer-guard/guard.mjs",
  ".agents/pi/extensions/report-designer-guard/index.mjs",
  ".agents/pi/extensions/report-designer-guard/guard.mjs",
  ".agents/pi/skills/html-report/SKILL.md",
  ".agents/pi/agents/report-writer.md",
  ".agents/pi/agents/report-researcher.md",
  ".agents/pi/agents/report-reviewer.md",
  ".agents/pi/agents/report-designer.md",
  ".agents/pi/skills/html-report/agents/report-writer.md",
  ".agents/pi/skills/html-report/agents/report-researcher.md",
  ".agents/pi/skills/html-report/agents/report-reviewer.md",
  ".agents/pi/skills/html-report/agents/report-designer.md",
  ".agents/pi/skills/html-report-design/SKILL.md",
  ".agents/pi/skills/html-report-design/references/report-design-system.md",
  ".agents/pi/skills/html-report-design/assets/report-shell-starter.html",
  ".agents/pi/skills/html-report/scripts/stage-gate.mjs",
  ".agents/pi/skills/html-report/scripts/open-metric-cli-ui.mjs",
  ".agents/pi/skills/html-report/scripts/writer-return.mjs",
  ".agents/pi/skills/html-report/scripts/fetch-entry.mjs",
  ".agents/pi/skills/html-report/scripts/fetch-explore.mjs",
  ".agents/pi/skills/html-report/scripts/metric-cli-executor.mjs",
  ".agents/pi/skills/html-report/scripts/metric-query-contract.mjs",
  ".agents/pi/skills/html-report/scripts/research-contract.mjs",
  ".agents/pi/skills/html-report/scripts/metric-retry.mjs",
  ".agents/pi/skills/html-report/scripts/metric-timeout.mjs",
  ".agents/pi/skills/html-report/scripts/researcher-return.mjs",
  ".agents/pi/skills/html-report/scripts/submit-research-findings.mjs",
  ".agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs",
  ".agents/pi/skills/html-report/scripts/editor-plan-contract.mjs",
  ".agents/pi/skills/html-report/scripts/editor-plan.mjs",
  ".agents/pi/skills/html-report/scripts/finalize-editor-stage.mjs",
  ".agents/pi/skills/html-report/scripts/finalize-research-stage.mjs",
  ".agents/pi/skills/html-report/scripts/reviewer-return.mjs",
  ".agents/pi/skills/html-report/scripts/designer-return.mjs",
  ".agents/pi/skills/html-report/scripts/assemble-report.mjs",
  ".agents/pi/skills/html-report/scripts/compose-main.mjs",
  ".agents/pi/skills/html-report/scripts/export-main-html.mjs",
  ".agents/pi/skills/html-report/scripts/quality-scan.mjs",
  ".agents/pi/skills/html-report/scripts/submit-review-scorecard.mjs",
  ".agents/pi/skills/html-report/scripts/write-verdict.mjs",
  ".agents/pi/skills/html-report/scripts/render-report.mjs",
  ".agents/pi/skills/html-report/scripts/report-content-binding.mjs",
  ".agents/pi/skills/html-report/scripts/design-artifact-contract.mjs",
  ".agents/pi/skills/html-report/scripts/compile-report-content.mjs",
  ".agents/pi/skills/html-report/scripts/compose-report.mjs",
  ".agents/pi/skills/html-report/scripts/capture-report.mjs",
  ".agents/pi/skills/html-report/scripts/finalize-design.mjs",
  ".agents/pi/skills/html-report/scripts/check-session-layout.mjs",
] as const;

/**
 * Deterministic Gate messages emitted by qdm-harness without starting a model
 * turn. Keep this public so the headless acceptance driver can bind the RPC
 * completion event to the exact extension-owned protocol instead of matching
 * localized display text.
 */
export const HTML_REPORT_GATE_CUSTOM_TYPE = "html-report-gate";
export const HTML_REPORT_UI_CUSTOM_TYPE = "html-report-ui";

export type RuntimeSourceSnapshot = Map<string, string>;

const RUNTIME_CONTRACT_VERSION = 1;
const RUNTIME_CONTRACT_PRODUCER = "qdm-harness";
export const HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH = join("debug", "runtime-contract.json");

function runtimeSourceDigest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unreadable";
    return `!${code}`;
  }
}

function runtimeSourcePath(projectRoot: string, relativePath: string): string {
  const packagePrefix = ".agents/pi/";
  return relativePath.startsWith(packagePrefix)
    ? join(packageResourceRoot, relativePath.slice(packagePrefix.length))
    : join(projectRoot, relativePath);
}

function captureRuntimeSources(projectRoot: string): RuntimeSourceSnapshot {
  return new Map(
    HTML_REPORT_RUNTIME_SOURCE_FILES.map((relativePath) => [
      relativePath,
      runtimeSourceDigest(runtimeSourcePath(projectRoot, relativePath)),
    ])
  );
}

function changedRuntimeSources(
  projectRoot: string,
  snapshot: RuntimeSourceSnapshot
): string[] {
  return HTML_REPORT_RUNTIME_SOURCE_FILES.filter(
    (relativePath) => runtimeSourceDigest(runtimeSourcePath(projectRoot, relativePath)) !== snapshot.get(relativePath)
  );
}

function runtimeSourceFingerprint(snapshot: RuntimeSourceSnapshot): string {
  const payload = HTML_REPORT_RUNTIME_SOURCE_FILES.map((relativePath) => [
    relativePath,
    snapshot.get(relativePath) ?? "!missing",
  ]);
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function invalidRuntimeSources(snapshot: RuntimeSourceSnapshot): string[] {
  return HTML_REPORT_RUNTIME_SOURCE_FILES.filter(
    (relativePath) => !/^[a-f0-9]{64}$/.test(snapshot.get(relativePath) || "")
  );
}

function runtimeContractPath(projectRoot: string, sid: string): string {
  return join(htmlReportSessionDir(projectRoot, sid), HTML_REPORT_RUNTIME_CONTRACT_RELATIVE_PATH);
}

/**
 * Stamp a newly initialized html-report Session with the exact long-lived
 * runtime contract that created it. Existing markers are never overwritten:
 * upgrading an old Session in place would hide mixed-version artifacts.
 */
export function writeHtmlReportRuntimeContract(
  projectRoot: string,
  sid: string,
  snapshot: RuntimeSourceSnapshot = captureRuntimeSources(projectRoot)
): string {
  if (!sid || sid === "unknown") throw new Error("缺少有效 html-report session id");
  const invalid = invalidRuntimeSources(snapshot);
  if (invalid.length) {
    throw new Error(`运行时源码缺失或不可读：${invalid.join(", ")}`);
  }
  const path = runtimeContractPath(projectRoot, sid);
  mkdirSync(dirname(path), { recursive: true });
  const sources = Object.fromEntries(
    HTML_REPORT_RUNTIME_SOURCE_FILES.map((relativePath) => [
      relativePath,
      snapshot.get(relativePath) ?? "!missing",
    ])
  );
  const marker = {
    version: RUNTIME_CONTRACT_VERSION,
    producer: RUNTIME_CONTRACT_PRODUCER,
    sessionId: sid,
    kernelVersion: HTML_REPORT_KERNEL_API_VERSION,
    adapterVersion: HTML_REPORT_ADAPTER_VERSION,
    fingerprint: runtimeSourceFingerprint(snapshot),
    sources,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

function sessionRuntimeContractError(
  projectRoot: string,
  sid: string,
  snapshot: RuntimeSourceSnapshot
): string | null {
  if (!sid || sid === "unknown") return null;
  const invalidSources = invalidRuntimeSources(snapshot);
  if (invalidSources.length) {
    return [
      `html-report 当前 Pi 进程缺少或无法读取运行时源码：${invalidSources.slice(0, 3).join("、")}。`,
      "已禁止创建或继续 Session；请修复安装/拷贝内容并重启 Pi。",
    ].join(" ");
  }
  const inspected = inspectGateState(projectRoot, sid);
  if (inspected.kind === "absent") return null;
  if (inspected.kind === "invalid") {
    return [
      `html-report Session \`${sid}\` 的 Gate 状态缺失或损坏（${inspected.error}）。`,
      "为避免绕过阶段门禁，已禁止原地重建或继续。请不要恢复此 Session；请创建全新的 Pi Session。",
    ].join(" ");
  }
  const path = runtimeContractPath(projectRoot, sid);
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "invalid_json";
    return [
      `html-report Session \`${sid}\` 缺少有效的运行时契约标记（${code}）。`,
      "它由旧版或不完整运行时创建，继续会混用旧产物与新契约，已阻止执行。请不要恢复此 Session；请创建全新的 Pi Session。",
    ].join(" ");
  }
  if (
    !isObject(marker) ||
    marker.version !== RUNTIME_CONTRACT_VERSION ||
    marker.producer !== RUNTIME_CONTRACT_PRODUCER ||
    marker.sessionId !== sid ||
    !isObject(marker.sources) ||
    Object.keys(marker.sources).length !== HTML_REPORT_RUNTIME_SOURCE_FILES.length ||
    HTML_REPORT_RUNTIME_SOURCE_FILES.some(
      (relativePath) => marker.sources[relativePath] !== snapshot.get(relativePath)
    ) ||
    marker.fingerprint !== runtimeSourceFingerprint(snapshot)
  ) {
    return [
      `html-report Session \`${sid}\` 的运行时契约与当前 Pi 进程不一致。`,
      "继续会混用旧产物与新契约，已阻止执行。请不要恢复此 Session；请创建全新的 Pi Session。",
    ].join(" ");
  }
  return null;
}

function runtimeFreshnessError(changed: string[]): string {
  const files = changed.slice(0, 3).map((path) => `\`${path}\``).join("、");
  const remaining = changed.length > 3 ? ` 等 ${changed.length} 个文件` : "";
  return [
    `html-report 运行时代码已在当前 Pi 进程启动后发生变化：${files}${remaining}。`,
    "当前进程仍在使用旧的 qdm-harness / contract 模块，已阻止继续执行。请重启 Pi 后重试。",
  ].join(" ");
}

function runtimeFreshnessBanner(reason: string): string {
  return [
    "# html-report 已阻止：请重启 Pi",
    reason,
    "不要调用任何工具，也不要继续当前 Gate；只向用户说明需要重启 Pi。",
  ].join("\n");
}

function sessionRuntimeMismatchBanner(reason: string): string {
  return [
    "# html-report 已阻止：请创建新 Session",
    reason,
    "不要调用任何工具，也不要继续当前 Gate；只向用户说明当前 Session 不能跨运行时契约恢复。",
  ].join("\n");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubagentToolName(value: unknown): boolean {
  return String(value || "").toLowerCase() === "subagent";
}

const CONTRACT_RUNTIME_STATE_VERSION = 1;
const CONTRACT_RUNTIME_STATE_PRODUCER = "qdm-harness";

function contractRuntimeStateDir(projectRoot: string, sid: string): string {
  return join(htmlReportSessionDir(projectRoot, sid), "debug", "contract-runtime");
}

function researchFinalizerContract(
  projectRoot: string,
  sid: string
): { command: string; input: JsonObject; resultPath: string; scriptPath: string } {
  const scriptPath = join(
    packageResourceRoot,
    "skills/html-report/scripts/finalize-research-stage.mjs"
  );
  const resultPath = join(htmlReportSessionDir(projectRoot, sid), "result.json");
  const command = `node '${scriptPath}' --result '${resultPath}'`;
  return { command, input: { command }, resultPath, scriptPath };
}

function b3FinalizerStatePath(
  projectRoot: string,
  sid: string,
  attempt: string,
  suffix: "reservation" | "settlement"
): string {
  const digest = createHash("sha256")
    .update(`${sid}|${attempt}|B3_RESEARCH|finalize-research-stage`, "utf8")
    .digest("hex");
  return join(
    contractRuntimeStateDir(projectRoot, sid),
    "b3-finalizers",
    `${digest}.${suffix}.json`
  );
}

function readB3FinalizerReservation(
  projectRoot: string,
  sid: string,
  attempt: string
): { reservation?: B3FinalizerReservation; error?: string } {
  const path = b3FinalizerStatePath(projectRoot, sid, attempt, "reservation");
  if (!existsSync(path)) return {};
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      return { error: "B3 finalizer 持久预留不是普通文件" };
    }
    const marker = JSON.parse(readFileSync(path, "utf8"));
    const expected = researchFinalizerContract(projectRoot, sid);
    const input = { command: expected.command };
    if (
      !isObject(marker) ||
      marker.version !== CONTRACT_RUNTIME_STATE_VERSION ||
      marker.producer !== CONTRACT_RUNTIME_STATE_PRODUCER ||
      marker.sessionId !== sid ||
      marker.stageId !== "B3_RESEARCH" ||
      marker.attempt !== attempt ||
      typeof marker.toolCallId !== "string" ||
      !marker.toolCallId ||
      marker.command !== expected.command ||
      marker.resultPath !== expected.resultPath ||
      marker.inputSha256 !== sha256Text(canonicalizeJson(input)) ||
      typeof marker.createdAt !== "string" ||
      !Number.isFinite(Date.parse(marker.createdAt))
    ) {
      return { error: "B3 finalizer 持久预留内容不合法或与当前 Session/attempt 不匹配" };
    }
    return { reservation: marker as B3FinalizerReservation };
  } catch (error) {
    return {
      error: `B3 finalizer 持久预留不可读：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function reserveB3Finalizer(
  projectRoot: string,
  sid: string,
  attempt: string,
  toolCallId: string
): { reservation?: B3FinalizerReservation; error?: string } {
  const contract = researchFinalizerContract(projectRoot, sid);
  const marker: B3FinalizerReservation = {
    version: CONTRACT_RUNTIME_STATE_VERSION,
    producer: CONTRACT_RUNTIME_STATE_PRODUCER,
    sessionId: sid,
    stageId: "B3_RESEARCH",
    attempt,
    toolCallId,
    command: contract.command,
    resultPath: contract.resultPath,
    inputSha256: sha256Text(canonicalizeJson(contract.input)),
    createdAt: new Date().toISOString(),
  };
  const path = b3FinalizerStatePath(projectRoot, sid, attempt, "reservation");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { reservation: marker };
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unknown";
    if (code === "EEXIST") {
      const existing = readB3FinalizerReservation(projectRoot, sid, attempt);
      return {
        error: existing.error || [
          "B3 finalizer 本 Gate attempt 已有持久预留",
          existing.reservation?.toolCallId
            ? `（toolCallId=${existing.reservation.toolCallId}）`
            : "",
          "；禁止重放或再次执行。",
        ].join(""),
      };
    }
    return { error: `B3 finalizer 无法写入持久预留（${code}）` };
  }
}

function persistB3FinalizerSettlement(
  projectRoot: string,
  reservation: B3FinalizerReservation,
  status: "passed" | "failed",
  reason: string
): string | null {
  const path = b3FinalizerStatePath(
    projectRoot,
    reservation.sessionId,
    reservation.attempt,
    "settlement"
  );
  const marker = {
    version: CONTRACT_RUNTIME_STATE_VERSION,
    producer: CONTRACT_RUNTIME_STATE_PRODUCER,
    sessionId: reservation.sessionId,
    stageId: reservation.stageId,
    attempt: reservation.attempt,
    toolCallId: reservation.toolCallId,
    status,
    reason: String(reason || status).slice(0, 500),
    settledAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return null;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unknown";
    return code === "EEXIST" ? "B3 finalizer tool_result 已结算；重复结果已忽略。" : `无法持久化 B3 finalizer 结算（${code}）`;
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The parent model must never inspect or mutate the durable retry ledger. */
function contractRuntimeLedgerDecision(
  projectRoot: string,
  sid: string,
  gateState: unknown,
  event: PiToolCallEvent
): { block: true; reason: string } | undefined {
  if (!isObject(gateState) || gateState.status !== "running" || !sid || sid === "unknown") return undefined;
  const toolName = String(event.toolName || "").toLowerCase();
  const protectedRoot = contractRuntimeStateDir(projectRoot, sid);
  if (["read", "write", "edit"].includes(toolName)) {
    const rawPath = typeof event.input?.path === "string"
      ? event.input.path
      : typeof event.input?.filePath === "string"
        ? event.input.filePath
        : "";
    if (rawPath && pathIsInside(protectedRoot, isAbsolute(rawPath) ? rawPath : resolve(projectRoot, rawPath))) {
      return {
        block: true,
        reason: "html-report contract-runtime 是扩展专用的持久派发账本；运行中的 Gate 禁止模型读取、写入或编辑。",
      };
    }
  }
  if (toolName === "bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    const relativeRoot = relative(resolve(projectRoot), protectedRoot);
    const normalizedCommand = command.toLowerCase();
    if (
      normalizedCommand.includes(protectedRoot.toLowerCase()) ||
      (relativeRoot && normalizedCommand.includes(relativeRoot.toLowerCase())) ||
      normalizedCommand.includes("debug/contract-runtime")
    ) {
      return {
        block: true,
        reason: "html-report contract-runtime 是扩展专用的持久派发账本；运行中的 Gate 禁止 Bash 引用或修改该路径。",
      };
    }
  }
  return undefined;
}

/** Data acquisition belongs exclusively to the bounded Writer/Researcher child chains. */
function parentDataFetchDecision(
  gateState: unknown,
  event: PiToolCallEvent
): { block: true; reason: string } | undefined {
  if (!isObject(gateState) || gateState.status !== "running") return undefined;
  if (String(event.toolName || "").toLowerCase() !== "bash") return undefined;
  const command = typeof event.input?.command === "string" ? event.input.command : "";
  if (
    /\bqdm-(?:metric|indicators)-cli\b/i.test(command) ||
    /\bQDM_METRIC_CLI\b/i.test(command) ||
    /\banalysis\s+execute\b/i.test(command) ||
    /\bfetch-(?:entry|explore)\.mjs\b/i.test(command)
  ) {
    return {
      block: true,
      reason: "running html-report Gate 的父代理禁止直接取数；qdm-metric-cli、analysis execute 与 fetch-entry/fetch-explore 只能由 Writer/Researcher 固定子链执行。",
    };
  }
  return undefined;
}

function contractInputSnapshot(input: JsonObject): { fingerprint: string; input: JsonObject } {
  const canonical = canonicalizeJson(input);
  const snapshot = JSON.parse(canonical);
  if (!isObject(snapshot)) throw new Error("contract subagent input must be one JSON object");
  return {
    fingerprint: createHash("sha256").update(canonical, "utf8").digest("hex"),
    input: snapshot,
  };
}

function contractDispatchReservationPath(
  projectRoot: string,
  identity: ContractDispatchIdentity
): string {
  const digest = createHash("sha256").update(identity.key, "utf8").digest("hex");
  return join(contractRuntimeStateDir(projectRoot, identity.sessionId), "dispatches", `${digest}.json`);
}

/**
 * Atomically reserve one contract-agent dispatch before launching it. `wx`
 * makes the reservation survive Pi restarts and concurrent/replayed tool
 * calls: an existing file always means this Gate attempt already spent its
 * single dispatch.
 */
function reserveContractDispatch(
  projectRoot: string,
  identity: ContractDispatchIdentity,
  mechanism: "model-tool" | "extension-event-bridge" = "model-tool"
): string | null {
  if (identity.maxDispatches !== 1) {
    return `${identity.label} 的持久派发门禁只支持 maxDispatches=1，拒绝执行。`;
  }
  const path = contractDispatchReservationPath(projectRoot, identity);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      version: CONTRACT_RUNTIME_STATE_VERSION,
      producer: CONTRACT_RUNTIME_STATE_PRODUCER,
      sessionId: identity.sessionId,
      attempt: identity.attempt,
      identityKey: identity.key,
      role: identity.role,
      label: identity.label,
      mechanism,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return null;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unknown";
    if (code === "EEXIST") {
      return `${identity.label} 本 Gate attempt 已有持久派发记录；Pi 重启或结果丢失也不得自动重派，请失败当前 Gate 后由用户显式重试。`;
    }
    return `${identity.label} 无法写入持久派发记录（${code}），为避免失控重试已拒绝执行。`;
  }
}

function hasContractDispatchReservation(
  projectRoot: string,
  identity: ContractDispatchIdentity
): boolean {
  return existsSync(contractDispatchReservationPath(projectRoot, identity));
}

function researcherTaskDispatchDir(
  projectRoot: string,
  identity: ContractDispatchIdentity
): string {
  const taskKey = `${identity.sessionId}|${identity.attempt}|report-researcher|${identity.taskId || "missing"}`;
  const digest = createHash("sha256").update(taskKey, "utf8").digest("hex");
  return join(contractRuntimeStateDir(projectRoot, identity.sessionId), "researcher-tasks", digest);
}

function readJsonObject(path: string): JsonObject | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return false;
  }
}

/** Hosts such as OpenAI fill these optional bash fields; they are not part of the command. */
const BASH_HOST_OPTIONAL_KEYS = new Set(["timeout", "workdir", "description"]);

function bashCommandIgnoringHostKeys(input: unknown): string | null {
  if (!isObject(input) || typeof input.command !== "string") return null;
  for (const key of Object.keys(input)) {
    if (key !== "command" && !BASH_HOST_OPTIONAL_KEYS.has(key)) return null;
  }
  return input.command;
}

function objectWithout(value: JsonObject, omitted: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)));
}

function arrayContainsCanonical(values: unknown, expected: unknown): boolean {
  return Array.isArray(values) && values.some((value) => sameCanonicalJson(value, expected));
}

function jsonContainsString(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => jsonContainsString(item, expected));
  return isObject(value) && Object.values(value).some((item) => jsonContainsString(item, expected));
}

/** Validate that a successor changes only the fields authorized by the checked gap. */
function researcherSuccessorTaskError(
  firstTask: unknown,
  successorTask: unknown,
  authorization: JsonObject
): string | null {
  if (!isObject(firstTask) || !isObject(successorTask) || !isObject(authorization.evidenceGap)) {
    return "successor 授权缺少首轮 task 或结构化 evidenceGap";
  }
  const status = String(authorization.status || "");
  const gap = authorization.evidenceGap;
  const firstPlan = firstTask.evidencePlan;
  const successorPlan = successorTask.evidencePlan;
  if (!isObject(firstPlan) || !isObject(successorPlan)) return "successor 缺少有效 evidencePlan";

  if (status === "needs_evidence_plan") {
    if (!sameCanonicalJson(objectWithout(firstTask, ["evidencePlan"]), objectWithout(successorTask, ["evidencePlan"]))) {
      return "needs_evidence_plan successor 只能修正 evidencePlan，不能修改 goal 或其他 task 字段";
    }
    if (!sameCanonicalJson(
      objectWithout(firstPlan, ["requiredColumns", "operations"]),
      objectWithout(successorPlan, ["requiredColumns", "operations"])
    )) {
      return "needs_evidence_plan successor 只能修正 requiredColumns/operations";
    }
    if (sameCanonicalJson(firstPlan, successorPlan)) return "successor 未修改 evidencePlan";

    if (gap.type === "missing_operation") {
      const required = Array.isArray(gap.requiredOperations) ? gap.requiredOperations : [];
      const firstOperations = Array.isArray(firstPlan.operations) ? firstPlan.operations : [];
      const successorOperations = Array.isArray(successorPlan.operations) ? successorPlan.operations : [];
      const firstColumns = Array.isArray(firstPlan.requiredColumns) ? firstPlan.requiredColumns : [];
      const successorColumns = Array.isArray(successorPlan.requiredColumns) ? successorPlan.requiredColumns : [];
      if (firstColumns.some((field) => !arrayContainsCanonical(successorColumns, field))) {
        return "successor 不得删除既有 requiredColumns";
      }
      if (!required.length || firstOperations.some((operation) => !arrayContainsCanonical(successorOperations, operation))) {
        return "successor 不得删除或改写既有 operations";
      }
      if (
        required.some((operation) => !arrayContainsCanonical(successorOperations, operation)) ||
        required.every((operation) => arrayContainsCanonical(firstOperations, operation))
      ) return "successor 未补入 evidenceGap.requiredOperations";
      return null;
    }
    if (gap.type === "field_mismatch") {
      const missing = Array.isArray(gap.missingFields)
        ? gap.missingFields.filter((item): item is JsonObject => isObject(item) && typeof item.field === "string")
        : [];
      const available = Array.isArray(gap.availableFields)
        ? gap.availableFields.filter((field): field is string => typeof field === "string" && field.length > 0)
        : [];
      if (
        !missing.length ||
        missing.some(({ field }) => !jsonContainsString(firstPlan, String(field))) ||
        missing.some(({ field }) => jsonContainsString(successorPlan, String(field))) ||
        !available.some((field) => jsonContainsString(successorPlan, field))
      ) return "successor 未按 field_mismatch 的 missingFields/availableFields 修正 evidencePlan";
      return null;
    }
    return "needs_evidence_plan successor 的 evidenceGap.type 不受支持";
  }

  if (status === "needs_new_query") {
    if (!sameCanonicalJson(
      objectWithout(firstTask, ["evidencePlan", "evidenceGap", "candidateIndicators", "candidateDims"]),
      objectWithout(successorTask, ["evidencePlan", "evidenceGap", "candidateIndicators", "candidateDims"])
    )) return "needs_new_query successor 不能修改 goal 或其他无关 task 字段";
    if (!sameCanonicalJson(objectWithout(firstPlan, ["mode"]), objectWithout(successorPlan, ["mode"]))) {
      return "needs_new_query successor 的 evidencePlan 只能切换 mode";
    }
    if (successorPlan.mode !== "new_query" || !sameCanonicalJson(successorTask.evidenceGap, gap)) {
      return "successor 必须切换为 new_query 并原样绑定获准 evidenceGap";
    }
    for (const [requiredKey, candidateKey] of [
      ["requiredIndicators", "candidateIndicators"],
      ["requiredDims", "candidateDims"],
    ] as const) {
      const required = Array.isArray(gap[requiredKey]) ? gap[requiredKey] : [];
      const before = Array.isArray(firstTask[candidateKey]) ? firstTask[candidateKey] : [];
      const expected = [...before, ...required].filter(
        (value, index, values) => values.findIndex((candidate) => sameCanonicalJson(candidate, value)) === index
      );
      if (!sameCanonicalJson(successorTask[candidateKey] ?? [], expected)) {
        return `successor 的 ${candidateKey} 只能补入 evidenceGap.${requiredKey}`;
      }
    }
    if (
      firstPlan.mode === "new_query" &&
      sameCanonicalJson(firstTask.evidenceGap, successorTask.evidenceGap) &&
      sameCanonicalJson(firstTask.candidateIndicators ?? [], successorTask.candidateIndicators ?? []) &&
      sameCanonicalJson(firstTask.candidateDims ?? [], successorTask.candidateDims ?? [])
    ) return "successor 未修复 needs_new_query gap";
    return null;
  }
  return "successor authorization status 非 needs_*";
}

/**
 * A Researcher task gets one initial dispatch and, only after a parent-checked
 * needs_evidence_plan/needs_new_query result, one materially changed successor.
 * Merely changing task JSON can no longer mint unlimited identities.
 */
function reserveResearcherTaskDispatch(
  projectRoot: string,
  identity: ContractDispatchIdentity
): string | null {
  if (identity.role !== "report-researcher") return null;
  if (!identity.taskId) return "Report Researcher 缺少 taskId，无法建立任务级派发门禁。";
  const dir = researcherTaskDispatchDir(projectRoot, identity);
  const firstPath = join(dir, "dispatch-1.json");
  const authorizationPath = join(dir, "successor-authorization.json");
  const secondPath = join(dir, "dispatch-2.json");
  const marker = {
    version: CONTRACT_RUNTIME_STATE_VERSION,
    producer: CONTRACT_RUNTIME_STATE_PRODUCER,
    sessionId: identity.sessionId,
    attempt: identity.attempt,
    taskId: identity.taskId,
    identityKey: identity.key,
    task: identity.researcherTask,
    createdAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(firstPath)) {
      writeFileSync(firstPath, `${JSON.stringify(marker, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return null;
    }

    const first = readJsonObject(firstPath);
    if (!first || first.identityKey === identity.key) {
      return `Report Researcher taskId=${identity.taskId} 本 Gate attempt 已派发相同任务；禁止原样重试。`;
    }
    const authorization = readJsonObject(authorizationPath);
    if (
      !authorization ||
      authorization.authorizedByIdentity !== first.identityKey ||
      !["needs_evidence_plan", "needs_new_query"].includes(String(authorization.status))
    ) {
      return `Report Researcher taskId=${identity.taskId} 尚无父级验收的 needs_* successor 授权；修改 task 内容不能绕过失败终止。`;
    }
    if (existsSync(secondPath)) {
      return `Report Researcher taskId=${identity.taskId} 本 Gate attempt 已用完一次受权 successor；禁止继续重派。`;
    }
    const successorError = researcherSuccessorTaskError(first.task, identity.researcherTask, authorization);
    if (successorError) {
      return `Report Researcher taskId=${identity.taskId} 未满足受权 successor 修复契约：${successorError}。`;
    }
    writeFileSync(secondPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return null;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unknown";
    return `Report Researcher taskId=${identity.taskId} 无法建立原子任务派发记录（${code}），已拒绝执行。`;
  }
}

function authorizeResearcherTaskSuccessor(
  projectRoot: string,
  identity: ContractDispatchIdentity,
  status: string,
  evidenceGap: unknown
): void {
  if (
    identity.role !== "report-researcher" ||
    !identity.taskId ||
    !["needs_evidence_plan", "needs_new_query"].includes(status)
  ) return;
  const dir = researcherTaskDispatchDir(projectRoot, identity);
  const first = readJsonObject(join(dir, "dispatch-1.json"));
  if (!first || first.identityKey !== identity.key || existsSync(join(dir, "dispatch-2.json"))) return;
  const path = join(dir, "successor-authorization.json");
  try {
    writeFileSync(path, `${JSON.stringify({
      version: CONTRACT_RUNTIME_STATE_VERSION,
      producer: CONTRACT_RUNTIME_STATE_PRODUCER,
      sessionId: identity.sessionId,
      attempt: identity.attempt,
      taskId: identity.taskId,
      status,
      evidenceGap,
      authorizedByIdentity: identity.key,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    // Missing authorization fails closed on the next dispatch; never repair or
    // overwrite task-level state in place.
  }
}

function isResearcherTaskSuccessorDispatch(
  projectRoot: string,
  identity: ContractDispatchIdentity
): boolean {
  if (identity.role !== "report-researcher" || !identity.taskId) return false;
  const marker = readJsonObject(join(researcherTaskDispatchDir(projectRoot, identity), "dispatch-2.json"));
  return marker?.identityKey === identity.key;
}

function researcherTerminalPath(projectRoot: string, sid: string, attempt: string): string {
  const digest = createHash("sha256")
    .update(`${sid}|${attempt}|report-researcher-parent-terminal`, "utf8")
    .digest("hex");
  return join(contractRuntimeStateDir(projectRoot, sid), "researcher-terminals", `${digest}.json`);
}

function derivedResearcherTerminal(
  projectRoot: string,
  sid: string,
  attempt: string,
  failureCode: ResearcherParentFailureCode
): ResearcherParentTerminal {
  return {
    attempt,
    status: "contract_error",
    failureCode,
    gateFailureReason: `B3 Report Researcher contract failure: ${failureCode}`,
    sessionDir: htmlReportSessionDir(projectRoot, sid),
    stageId: "B3_RESEARCH",
  };
}

function readResearcherParentTerminal(
  projectRoot: string,
  sid: string,
  attempt: string
): ResearcherParentTerminal | null {
  const path = researcherTerminalPath(projectRoot, sid, attempt);
  if (!existsSync(path)) return null;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    const failureCode = isObject(marker) &&
      marker.version === CONTRACT_RUNTIME_STATE_VERSION &&
      marker.producer === CONTRACT_RUNTIME_STATE_PRODUCER &&
      marker.sessionId === sid &&
      marker.attempt === attempt &&
      [
        "runtime_timeout",
        "missing_structured_output",
        "invalid_return_or_artifacts",
        "structured_status_failed",
      ].includes(
        String(marker.failureCode)
      )
        ? marker.failureCode as ResearcherParentFailureCode
        : "invalid_return_or_artifacts";
    return derivedResearcherTerminal(projectRoot, sid, attempt, failureCode);
  } catch {
    return derivedResearcherTerminal(projectRoot, sid, attempt, "invalid_return_or_artifacts");
  }
}

/** First rejected Researcher result closes the parent B3 attempt durably. */
function persistResearcherParentTerminal(
  projectRoot: string,
  sid: string,
  attempt: string,
  failureCode: ResearcherParentFailureCode
): ResearcherParentTerminal {
  const terminal = derivedResearcherTerminal(projectRoot, sid, attempt, failureCode);
  const path = researcherTerminalPath(projectRoot, sid, attempt);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      version: CONTRACT_RUNTIME_STATE_VERSION,
      producer: CONTRACT_RUNTIME_STATE_PRODUCER,
      sessionId: sid,
      attempt,
      status: terminal.status,
      failureCode,
      recordedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return terminal;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unknown";
    if (code === "EEXIST") {
      return readResearcherParentTerminal(projectRoot, sid, attempt) || terminal;
    }
    // The in-memory terminal still fails closed for this process. A durable
    // dispatch reservation separately prevents re-launch after a restart.
    return terminal;
  }
}

function reviewerTerminalPath(projectRoot: string, sid: string, attempt: string): string {
  const digest = createHash("sha256")
    .update(`${sid}|${attempt}|report-reviewer-parent-terminal`, "utf8")
    .digest("hex");
  return join(contractRuntimeStateDir(projectRoot, sid), "reviewer-terminals", `${digest}.json`);
}

function derivedReviewerTerminal(
  projectRoot: string,
  sid: string,
  attempt: string,
  status: ReviewerParentTerminal["status"]
): ReviewerParentTerminal {
  const sessionDir = htmlReportSessionDir(projectRoot, sid);
  return {
    attempt,
    status,
    sessionDir,
    stageId: "B4_REVIEW",
    repairLogPath: join(sessionDir, "quality", "repair-log.json"),
  };
}

/** Load only the status from disk; every authority-bearing path is re-derived. */
function readReviewerParentTerminal(
  projectRoot: string,
  sid: string,
  attempt: string
): ReviewerParentTerminal | null {
  const path = reviewerTerminalPath(projectRoot, sid, attempt);
  if (!existsSync(path)) return null;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    const status = isObject(marker) &&
      marker.version === CONTRACT_RUNTIME_STATE_VERSION &&
      marker.producer === CONTRACT_RUNTIME_STATE_PRODUCER &&
      marker.sessionId === sid &&
      marker.attempt === attempt &&
      ["passed", "failed", "infrastructure_error", "contract_error"].includes(String(marker.status))
        ? marker.status as ReviewerParentTerminal["status"]
        : "contract_error";
    return derivedReviewerTerminal(projectRoot, sid, attempt, status);
  } catch {
    // A partial/corrupt marker must never reopen B4 after a crash.
    return derivedReviewerTerminal(projectRoot, sid, attempt, "contract_error");
  }
}

/** First Reviewer result wins durably; later/replayed results cannot replace it. */
function persistReviewerParentTerminal(
  projectRoot: string,
  sid: string,
  attempt: string,
  status: ReviewerParentTerminal["status"]
): ReviewerParentTerminal {
  const terminal = derivedReviewerTerminal(projectRoot, sid, attempt, status);
  const path = reviewerTerminalPath(projectRoot, sid, attempt);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      version: CONTRACT_RUNTIME_STATE_VERSION,
      producer: CONTRACT_RUNTIME_STATE_PRODUCER,
      sessionId: sid,
      attempt,
      status,
      recordedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return terminal;
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unknown";
    if (code === "EEXIST") {
      return readReviewerParentTerminal(projectRoot, sid, attempt) ||
        derivedReviewerTerminal(projectRoot, sid, attempt, "contract_error");
    }
    // If the terminal result cannot be durably recorded, fail closed for the
    // remainder of this process. The dispatch reservation still prevents a
    // later process from launching another Reviewer.
    return derivedReviewerTerminal(projectRoot, sid, attempt, "contract_error");
  }
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
  // getSessionFile() is a filesystem path, not the logical Pi session id.
  // Never use it as the html-report directory name.
  return (
    ctx?.sessionManager?.getSessionId?.() ||
    process.env.PI_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "unknown"
  );
}

/**
 * Raw logical session id for Lumi requester-context lookup.
 * A session file path or the synthetic "unknown" value must never be hashed.
 */
function envelopeSessionId(ctx?: PiExtensionContext): string | null {
  const id =
    ctx?.sessionManager?.getSessionId?.() ||
    process.env.PI_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "";
  return id || null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Detect a pi-subagents run-level timeout even when the child was killed
 * before it could capture its structured result. Only failed/timed-out envelopes
 * are inspected so ordinary successful prose containing "timeout" cannot
 * turn a completed contract into a terminal failure.
 */
function contractRuntimeTimeoutReason(event: PiToolResultEvent): string | null {
  const details = isObject(event.details) ? event.details : null;
  const results = Array.isArray(details?.results)
    ? details.results.filter((result): result is JsonObject => isObject(result))
    : [];
  const timedOut = details?.timedOut === true || results.some((result) => result.timedOut === true);
  const failed = event.isError === true || timedOut || results.some((result) => result.exitCode !== 0);
  if (!failed) return null;

  const candidates = [
    typeof details?.error === "string" ? details.error : "",
    ...results.map((result) => (typeof result.error === "string" ? result.error : "")),
    contentText(event.content),
  ].filter(Boolean);
  const message = candidates.find((candidate) => CONTRACT_RUNTIME_TIMEOUT.test(candidate));
  if (!timedOut && !message) return null;
  return (message || "pi-subagents 标记 timedOut=true").slice(0, 200);
}

interface WriterInvocation {
  task: string;
}

interface ResearcherInvocation {
  task: string;
}

interface EditorPlannerInvocation {
  task: string;
}

interface ReviewerInvocation {
  task: string;
}

interface DesignerInvocation {
  task: string;
}

type ContractedReportAgent =
  | "report-writer"
  | "report-researcher"
  | "report-reviewer"
  | "report-designer";

type ContractDispatchRole = ContractedReportAgent | "report-editor-planner";

/**
 * The structured contracts are defined for one foreground chain step. Pi also
 * supports top-level tasks[] and chain parallel fan-out; neither shape exposes
 * one unambiguous result/path contract, so report agents must fail closed.
 */
function unsupportedParallelReportAgent(
  input: JsonObject | undefined,
  agent: ContractedReportAgent
):
  | "top-level tasks[]"
  | "chain[].parallel[]"
  | "chain[].parallel dynamic fan-out"
  | "a mixed chain parallel step"
  | undefined {
  if (!input) return undefined;
  if (
    Array.isArray(input.tasks) &&
    input.tasks.some((task) => isObject(task) && isReportAgentName(task.agent, agent))
  ) {
    return "top-level tasks[]";
  }
  if (!Array.isArray(input.chain)) return undefined;
  for (const step of input.chain) {
    if (!isObject(step) || !("parallel" in step)) continue;
    if (isReportAgentName(step.agent, agent)) return "a mixed chain parallel step";
    if (
      Array.isArray(step.parallel) &&
      step.parallel.some((task) => isObject(task) && isReportAgentName(task.agent, agent))
    ) {
      return "chain[].parallel[]";
    }
    if (isObject(step.parallel) && isReportAgentName(step.parallel.agent, agent)) {
      return "chain[].parallel dynamic fan-out";
    }
  }
  return undefined;
}

function parallelReportAgentError(label: string, location: string): string {
  return `${label} 禁止通过 ${location} 并行调用；每个任务必须使用独立、串行、单步骤 chain。`;
}

function anyUnsupportedParallelReportAgent(input: JsonObject | undefined): string | undefined {
  const roles: Array<[ContractedReportAgent, string]> = [
    ["report-writer", "Report Writer"],
    ["report-researcher", "Report Researcher"],
    ["report-reviewer", "Report Reviewer"],
    ["report-designer", "Report Designer"],
  ];
  for (const [agent, label] of roles) {
    const location = unsupportedParallelReportAgent(input, agent);
    if (location) return parallelReportAgentError(label, location);
  }
  return undefined;
}

const HTML_REPORT_STAGE_SUBAGENTS: Record<string, readonly string[] | "list" | "none"> = {
  A_CONFIG: "list",
  B0_PREFLIGHT: "list",
  B2_WRITER: ["report-writer"],
  B2_MAIN: "none",
  B25_EDITOR: ["report-researcher"],
  B3_RESEARCH: ["report-researcher"],
  B4_REVIEW: ["report-researcher", "report-reviewer"],
  B5_DESIGN: ["report-designer"],
};

/**
 * A running html-report Gate owns which child role may execute. This closes a
 * gap where a generic worker (or a valid report role used in the wrong stage)
 * did not enter any of the role-specific contract validators below.
 */
export function runningGateSubagentDecision(
  gateState: unknown,
  event: unknown
): { block: true; reason: string } | undefined {
  if (!isObject(gateState) || gateState.status !== "running" || !isObject(event)) return undefined;
  if (String(event.toolName || "").toLowerCase() !== "subagent") return undefined;

  const stageId = typeof gateState.currentStage === "string" ? gateState.currentStage : "unknown";
  const policy = HTML_REPORT_STAGE_SUBAGENTS[stageId];
  const input = isObject(event.input) ? event.input : {};
  const action = typeof input.action === "string" ? input.action : null;
  const declaredAgents: string[] = [];
  // Pi selects one execution shape. Contract chains intentionally sanitize
  // hostile top-level overrides, so only inspect the effective shape here;
  // the stricter contract validators below still reject malformed chains.
  if (Array.isArray(input.chain)) {
    for (const step of input.chain) {
      if (!isObject(step)) continue;
      if (typeof step.agent === "string") declaredAgents.push(step.agent);
      if (Array.isArray(step.parallel)) {
        for (const task of step.parallel) {
          if (isObject(task) && typeof task.agent === "string") declaredAgents.push(task.agent);
        }
      } else if (isObject(step.parallel) && typeof step.parallel.agent === "string") {
        declaredAgents.push(step.parallel.agent);
      }
    }
  } else if (Array.isArray(input.tasks)) {
    for (const task of input.tasks) {
      if (isObject(task) && typeof task.agent === "string") declaredAgents.push(task.agent);
    }
  } else if (typeof input.agent === "string") {
    declaredAgents.push(input.agent);
  }

  const reject = (expected: string) => ({
    block: true as const,
    reason: `html-report ${stageId} Gate 的 subagent 仅允许 ${expected}；当前调用不属于该阶段，已阻止。`,
  });
  const carriesEditorPlannerMarker =
    (isReportAgentName(input.agent, "report-researcher") &&
      typeof input.task === "string" &&
      isEditorPlannerAssignment(input.task)) ||
    (Array.isArray(input.chain) && input.chain.some(
      (step) => isObject(step) &&
        isReportAgentName(step.agent, "report-researcher") &&
        typeof step.task === "string" &&
        isEditorPlannerAssignment(step.task)
    ));
  if (stageId !== "B25_EDITOR" && carriesEditorPlannerMarker) {
    return reject(`本阶段专属子代理；${EDITOR_PLANNER_MARKER} 仅属于 B25_EDITOR`);
  }
  if (policy === "list") {
    return action === "list" && declaredAgents.length === 0
      ? undefined
      : reject('action="list"');
  }
  if (stageId === "B25_EDITOR") {
    const plannerStep = Array.isArray(input.chain) && input.chain.length === 1 &&
      isObject(input.chain[0]) && isReportAgentName(input.chain[0].agent, "report-researcher") &&
      typeof input.chain[0].task === "string" && isEditorPlannerAssignment(input.chain[0].task);
    return action === null && plannerStep
      ? undefined
      : reject(`一次 fresh 单步骤 report-researcher ${EDITOR_PLANNER_MARKER} Planner 调用`);
  }
  if (policy === "none") return reject("不调用任何子代理");
  if (!policy) return reject("已登记的阶段专属子代理");
  if (action !== null || declaredAgents.length === 0) return reject(policy.join(" 或 "));
  const disallowed = declaredAgents.find((agent) => !policy.some((role) => isReportAgentName(agent, role)));
  if (disallowed) return reject(policy.join(" 或 "));
  return undefined;
}

/** Legacy compatibility for an already-running pre-automation A_CONFIG turn. */
export function isWaitingAConfigAgentList(gateState: unknown, event: unknown): boolean {
  if (!isObject(gateState) || !isObject(event)) return false;
  if (
    gateState.mode !== "step" ||
    gateState.status !== "awaiting_approval" ||
    gateState.currentStage !== "A_CONFIG" ||
    String(event.toolName || "").toLowerCase() !== "subagent"
  ) return false;
  if (!isObject(event.input)) return false;
  return event.input.action === "list" && Object.keys(event.input).length === 1;
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

const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
const RUNTIME_AGENT_LIST_BRIDGE_TIMEOUT_MS = 5_000;
const EDITOR_PLANNER_BRIDGE_TIMEOUT_MS = EDITOR_PLANNER_MAX_RUNTIME_MS + 5_000;
const FOREGROUND_SUBAGENT_BRIDGE_TIMEOUT_MAX_MS = 725_000;

function runtimeAgentListObservedAgents(event: PiToolResultEvent): string[] {
  const text = runtimeAgentListText(event);
  return REQUIRED_REPORT_AGENTS.filter((name) => runtimeListHasReportAgent(text, name));
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
  const defaultTimeout = label === "runtime agent list"
    ? RUNTIME_AGENT_LIST_BRIDGE_TIMEOUT_MS
    : EDITOR_PLANNER_BRIDGE_TIMEOUT_MS;
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(Math.trunc(timeoutMs), FOREGROUND_SUBAGENT_BRIDGE_TIMEOUT_MAX_MS)
    : defaultTimeout;
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
        try {
          unsubscribers.pop()?.();
        } catch {
          // Listener cleanup is best effort after the request is terminal.
        }
      }
    };
    const finish = (next: () => void): void => {
      if (done) return;
      done = true;
      cleanup();
      next();
    };
    const reject = (error: Error): void => finish(() => rejectPromise(error));

    const onStarted = (data: unknown): void => {
      if (done || !isObject(data) || data.requestId !== requestId) return;
      started = true;
    };
    const onResponse = (data: unknown): void => {
      if (done || !isObject(data) || data.requestId !== requestId) return;
      if (!started) {
        reject(new Error("pi-subagents slash bridge responded before STARTED"));
        return;
      }
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
      const unsubscribeStarted = events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted);
      if (typeof unsubscribeStarted !== "function") {
        reject(new Error("pi event bus cannot unsubscribe STARTED listener"));
        return;
      }
      unsubscribers.push(unsubscribeStarted);
      const unsubscribeResponse = events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse);
      if (typeof unsubscribeResponse !== "function") {
        reject(new Error("pi event bus cannot unsubscribe RESPONSE listener"));
        return;
      }
      unsubscribers.push(unsubscribeResponse);
      timer = setTimeout(() => {
        if (done) return;
        finish(() => {
          try {
            events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId });
          } catch {
            // The timeout itself is already the authoritative failure.
          }
          rejectPromise(new Error(`${label} event bridge timed out after ${boundedTimeout}ms`));
        });
      }, boundedTimeout);
      events.emit(SLASH_SUBAGENT_REQUEST_EVENT, {
        requestId,
        params,
        ctx: requestContext,
      });
      if (!started && !done) {
        reject(new Error(`no pi-subagents slash bridge received the ${label} request`));
      }
    } catch (error) {
      reject(new Error(`${label} event bridge failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

/** Execute the real runtime discovery through the generic foreground bridge. */
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
    events,
    ctx,
    projectRoot,
    params: { action: "list" },
    requestId,
    timeoutMs,
    label: "runtime agent list",
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
  const missingAgents = REQUIRED_REPORT_AGENTS.filter((name) => !runtimeListHasReportAgent(text, name));
  if (!missingAgents.length) rememberObservedReportAgentsFromListText(text);
  return missingAgents.length
    ? { ok: false, missingAgents, error: `runtime list 缺少 Agent：${missingAgents.join(", ")}` }
    : { ok: true, missingAgents: [] };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runtimeAgentListAuditPath(
  projectRoot: string,
  sessionId: string,
  stageId: "A_CONFIG" | "B0_PREFLIGHT",
  attempt: string
): string {
  return join(
    htmlReportSessionDir(projectRoot, sessionId),
    "debug",
    "runtime-agent-list",
    `${stageId}-${sha256Text(attempt).slice(0, 16)}.json`
  );
}

function runtimeAgentListAuditDirectoryError(
  expectedPath: string,
  stageId: "A_CONFIG" | "B0_PREFLIGHT"
): string | null {
  const directory = dirname(expectedPath);
  if (!existsSync(directory)) return null;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    return `无法读取 runtime agent list audit 目录：${error instanceof Error ? error.message : String(error)}`;
  }
  const validName = new RegExp(`^${stageId}-[a-f0-9]{16}\\.json$`);
  for (const name of names.filter((candidate) => candidate.startsWith(`${stageId}-`))) {
    if (!validName.test(name)) return `runtime agent list audit 文件名非法：${name}`;
    const path = join(directory, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        return `runtime agent list audit 必须是普通非符号链接文件：${name}`;
      }
      JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      return `runtime agent list audit 不可读或不是合法 JSON（${name}）：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

function sealRuntimeAgentListAudit(value: Omit<RuntimeAgentListAudit, "auditSha256">): RuntimeAgentListAudit {
  const auditSha256 = sha256Text(canonicalizeJson(value));
  return { ...value, auditSha256 } as RuntimeAgentListAudit;
}

function writeRuntimeAgentListAudit(
  path: string,
  audit: RuntimeAgentListAudit,
  { reserve = false }: { reserve?: boolean } = {}
): void {
  mkdirSync(dirname(path), { recursive: true });
  const document = `${JSON.stringify(audit, null, 2)}\n`;
  if (reserve) {
    writeFileSync(path, document, { encoding: "utf8", flag: "wx" });
    return;
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, document, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, path);
}

function validatePersistedRuntimeAgentListAudit(
  value: unknown,
  expected: {
    sessionId: string;
    stageId: "A_CONFIG" | "B0_PREFLIGHT";
    attempt: string;
  }
): { ok: true; audit: RuntimeAgentListAudit } | { ok: false; error: string } {
  if (!isObject(value)) return { ok: false, error: "runtime agent list audit is not a JSON object" };
  const audit = value as unknown as RuntimeAgentListAudit;
  const expectedKeys = [
    "version", "producer", "mechanism", "sessionId", "stageId", "attempt", "requestId",
    "status", "required", "observed", "missing", "startedAt", "endedAt", "durationMs",
    "result", "auditSha256",
  ].sort();
  if (canonicalizeJson(Object.keys(audit).sort()) !== canonicalizeJson(expectedKeys)) {
    return { ok: false, error: "runtime agent list audit fields do not match the passed v1 schema" };
  }
  if (
    audit.version !== 1 ||
    audit.producer !== "qdm-harness" ||
    audit.mechanism !== "extension-event-bridge" ||
    audit.sessionId !== expected.sessionId ||
    audit.stageId !== expected.stageId ||
    audit.attempt !== expected.attempt
  ) {
    return { ok: false, error: "runtime agent list audit identity mismatch" };
  }
  if (typeof audit.auditSha256 !== "string" || !/^[a-f0-9]{64}$/.test(audit.auditSha256)) {
    return { ok: false, error: "runtime agent list audit hash is missing" };
  }
  const { auditSha256, ...unsigned } = audit;
  if (sha256Text(canonicalizeJson(unsigned)) !== auditSha256) {
    return { ok: false, error: "runtime agent list audit hash mismatch" };
  }
  if (audit.status !== "passed") {
    return { ok: false, error: `previous automatic runtime list is ${String(audit.status)}` };
  }
  if (
    typeof audit.requestId !== "string" || !audit.requestId.trim() || audit.requestId !== audit.requestId.trim() ||
    typeof audit.startedAt !== "string" || !Number.isFinite(Date.parse(audit.startedAt)) ||
    typeof audit.endedAt !== "string" || !Number.isFinite(Date.parse(audit.endedAt)) ||
    Date.parse(audit.endedAt) < Date.parse(audit.startedAt) ||
    typeof audit.durationMs !== "number" || !Number.isSafeInteger(audit.durationMs) || audit.durationMs < 0 ||
    !Array.isArray(audit.required) || !Array.isArray(audit.observed) || !Array.isArray(audit.missing) ||
    !audit.result || audit.result.isError !== false || typeof audit.result.text !== "string" ||
    canonicalizeJson(Object.keys(audit.result).sort()) !== canonicalizeJson(["isError", "sha256", "text"]) ||
    typeof audit.result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(audit.result.sha256) ||
    sha256Text(audit.result.text) !== audit.result.sha256
  ) {
    return { ok: false, error: "runtime agent list audit result is invalid" };
  }
  const event: PiToolResultEvent = {
    toolName: "subagent",
    input: { action: "list" },
    isError: audit.result.isError,
    content: [{ type: "text", text: audit.result.text }],
  };
  const inspected = inspectRuntimeAgentListResult(event);
  const observed = runtimeAgentListObservedAgents(event);
  if (
    !inspected.ok ||
    canonicalizeJson(audit.required) !== canonicalizeJson([...REQUIRED_REPORT_AGENTS]) ||
    audit.observed.some((name, index) => typeof name !== "string" || !name || audit.observed.indexOf(name) !== index) ||
    canonicalizeJson(audit.observed) !== canonicalizeJson(observed) ||
    canonicalizeJson(audit.missing) !== canonicalizeJson(inspected.missingAgents) ||
    Object.prototype.hasOwnProperty.call(audit, "error")
  ) {
    return { ok: false, error: "runtime agent list audit does not match its raw result" };
  }
  return { ok: true, audit };
}

/**
 * Replace every caller-controlled execution override with the one supported
 * contract envelope. Step acceptance is explicitly disabled because the
 * parent performs stricter structured-output and persisted-artifact checks;
 * inferred acceptance would ask for prose reports and may retry the child.
 */
function resetContractRunEnvelope(
  input: JsonObject,
  step: JsonObject,
  projectRoot?: string
): { error?: string } {
  if (!projectRoot || !isAbsolute(projectRoot)) {
    return { error: "无法固定 contract agent 的项目 cwd，拒绝派发子代理。" };
  }
  const root = resolve(projectRoot);
  for (const key of Object.keys(input)) {
    if (key !== "chain") delete input[key];
  }
  for (const key of Object.keys(step)) {
    if (key !== "agent" && key !== "task") delete step[key];
  }
  input.chain = [step];
  input.agentScope = "project";
  input.context = "fresh";
  input.cwd = root;
  input.async = false;
  input.clarify = false;
  step.cwd = root;
  step.acceptance = {
    level: "none",
    reason: "qdm-harness validates the exact structured return and persisted artifacts.",
  };
  return {};
}

/** Return the sole Writer invocation, or an error that must stop B2. */
function writerInvocationFromSubagentInput(input: JsonObject | undefined): {
  invocation?: WriterInvocation;
  error?: string;
} {
  if (!input) return {};
  const unsupported = unsupportedParallelReportAgent(input, "report-writer");
  if (unsupported) return { error: parallelReportAgentError("Report Writer", unsupported) };
  if (isReportAgentName(input.agent, "report-writer")) {
    return { error: "Report Writer 必须使用单步骤 chain 调用，不能使用自由文本单代理调用。" };
  }
  if (!Array.isArray(input.chain)) return {};
  const writers = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-writer")
  );
  if (!writers.length) return {};
  if (input.chain.length !== 1 || writers.length !== 1) {
    return { error: "每张卡的 Report Writer 必须是独立的一步 chain，且不得混入其他步骤。" };
  }
  const [writer] = writers;
  if (typeof writer.task !== "string" || !writer.task.trim()) {
    return { error: "Report Writer chain 缺少 task，无法校验 cardId 与数据路径。" };
  }
  return { invocation: { task: writer.task } };
}

function writerExpectedFromTask(task: string, {
  projectRoot,
  session,
}: {
  projectRoot?: string;
  session?: string;
} = {}):
  | { cardId: string; dataPath: string; metaPath: string; resultPath: string }
  | { error: string } {
  const cardMatch = task.match(/(?:^|\s)cardId=([^\s`"']+)/);
  const resultMatch = task.match(/(?:^|\n)result\.json=(?:"([^"]+)"|'([^']+)'|([^\s`]+))/);
  const cardId = cardMatch?.[1];
  const resultPath = resultMatch?.[1] ?? resultMatch?.[2] ?? resultMatch?.[3];
  if (!cardId || !resultPath) {
    return { error: "Report Writer task 必须包含 cardId=<ID> 和独占一行的 result.json=<ABS_PATH>。" };
  }
  if (!isAbsolute(resultPath)) {
    return { error: "Report Writer task 的 result.json 必须是绝对路径。" };
  }
  if (projectRoot && session && session !== "unknown") {
    const expectedResult = join(htmlReportSessionDir(projectRoot, session), "result.json");
    if (resolve(resultPath) !== resolve(expectedResult)) {
      return { error: "Report Writer task 的 result.json 必须属于当前 html-report session。" };
    }
  }
  try {
    return {
      ...writerReturnPathsForResult({ cardId, resultPath }),
      resultPath: resolve(resultPath),
    };
  } catch (error) {
    return { error: `无法建立 Report Writer 返回契约：${error instanceof Error ? error.message : String(error)}` };
  }
}

function verifiedB2WriterCardIds(projectRoot: string, session: string, gateState: unknown): string[] {
  if (
    !isObject(gateState) ||
    gateState.currentStage !== "B2_WRITER" ||
    gateState.status !== "running" ||
    !session ||
    session === "unknown"
  ) return [];
  const resultPath = join(htmlReportSessionDir(projectRoot, session), "result.json");
  try {
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    if (!isObject(result) || result.status !== "confirmed" || !Array.isArray(result.cards) || !result.cards.length) {
      return [];
    }
    const ids: string[] = [];
    const paths = new Set<string>();
    for (const card of result.cards) {
      if (!isObject(card) || typeof card.id !== "string" || !card.id.trim()) return [];
      const expected = writerReturnPathsForResult({ resultPath, cardId: card.id });
      if (paths.has(expected.dataPath)) return [];
      paths.add(expected.dataPath);
      ids.push(card.id);
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * The extension owns the Writer run envelope. outputSchema is the receipt
 * schema, generated here from the assignment — never from model JSON.
 */
function attachWriterRunEnvelope(
  input: JsonObject | undefined,
  {
    projectRoot,
    session,
  }: {
    projectRoot?: string;
    session?: string;
  } = {}
): { error?: string } {
  const unsupported = unsupportedParallelReportAgent(input, "report-writer");
  if (unsupported) return { error: parallelReportAgentError("Report Writer", unsupported) };
  if (!input || !Array.isArray(input.chain)) return {};
  const writers = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-writer")
  );
  if (!writers.length || input.chain.length !== 1 || writers.length !== 1) return {};

  const [writer] = writers;
  if (typeof writer.task !== "string" || !writer.task.trim()) return {};

  const expected = writerExpectedFromTask(writer.task, { projectRoot, session });
  if ("error" in expected) return { error: expected.error };
  const envelope = resetContractRunEnvelope(input, writer, projectRoot);
  if (envelope.error) return envelope;
  writer.outputSchema = buildWriterReturnSchema(expected);
  // Writer is deliberately foreground-only. If it cannot return after
  // ack_cli_data + submit_card_caption (one incomplete caption retry) +
  // official structured_output, pi-subagents must terminate it.
  input.turnBudget = { maxTurns: 4, graceTurns: 1 };
  delete input.toolBudget;
  delete input.timeoutMs;
  // The adapter caps CAS + retry sleeps + CLI attempts at 540s. Success
  // uses two domain tools; one rejected caption plus a second submit needs
  // three. structured_output stays unblocked after the hard cap.
  input.maxRuntimeMs = 720_000;
  writer.toolBudget = { hard: 3, block: ["ack_cli_data", "submit_card_caption"] };
  delete writer.async;
  delete writer.turnBudget;
  delete writer.timeoutMs;
  delete writer.maxRuntimeMs;
  return {};
}

type ToolResultPatch = {
  isError?: boolean;
  content?: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

type EditorPlannerToolResultPatch = ToolResultPatch & {
  nextTool?: DeterministicNextTool;
};

type WriterToolResultPatch = ToolResultPatch & {
  nextTool?: DeterministicNextTool;
};

/** Parent-model Writer call shape. Envelope fields are attached later in tool_call. */
function writerDispatchInput(sessionDir: string, cardId: string): JsonObject {
  return {
    chain: [{
      agent: reportAgentDispatchName("report-writer"),
      task: [
        `按 report-writer 处理 cardId=${cardId}`,
        `SESSION=${sessionDir}`,
        `result.json=${join(sessionDir, "result.json")}`,
      ].join("\n"),
    }],
  };
}

function writerNextTool(sessionDir: string, cardId: string): DeterministicNextTool {
  const input = writerDispatchInput(sessionDir, cardId);
  return {
    toolName: "subagent",
    input,
    invocation: `subagent(${JSON.stringify(input)})`,
  };
}

function writerQueueHandoffText(nextTool: DeterministicNextTool, remaining: string[]): string {
  return [
    "B2 已验收当前 Writer。",
    `NEXT_TOOL_ONLY：下一条 assistant 消息只原样调用 \`${nextTool.invocation}\`。`,
    `还剩 ${remaining.length} 张：${remaining.join(", ")}。`,
    "禁止 wait、重复 status、目录诊断、复述或参数重构。",
  ].join("\n");
}

async function remainingWriterCardIds(projectRoot: string, session: string): Promise<string[]> {
  if (!session || session === "unknown") return [];
  const sessionDir = htmlReportSessionDir(projectRoot, session);
  const resultPath = join(sessionDir, "result.json");
  let result: JsonObject;
  let resultMtimeMs: number;
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
    if (!isObject(parsed) || parsed.status !== "confirmed" || !Array.isArray(parsed.cards) || !parsed.cards.length) {
      return [];
    }
    result = parsed;
    resultMtimeMs = (await stat(resultPath)).mtimeMs;
  } catch {
    return [];
  }
  const remaining: string[] = [];
  const seenPaths = new Set<string>();
  try {
    for (const card of result.cards as unknown[]) {
      if (!isObject(card) || typeof card.id !== "string" || !card.id.trim()) return [];
      const expected = writerReturnPathsForResult({ resultPath, cardId: card.id });
      if (seenPaths.has(expected.dataPath)) return [];
      seenPaths.add(expected.dataPath);
      const persisted = await reusableEntry(dirname(expected.dataPath), { notBeforeMs: resultMtimeMs });
      let hasCaption = false;
      if (persisted) {
        try {
          const captionStat = await lstat(captionPathFor(expected.dataPath));
          hasCaption = captionStat.isFile() && !captionStat.isSymbolicLink();
        } catch {
          hasCaption = false;
        }
      }
      if (!persisted || !hasCaption) remaining.push(card.id);
    }
  } catch {
    return [];
  }
  return remaining;
}

/**
 * A Writer chain already exposes its machine-readable result in `details`,
 * but the default pi-subagents text only points the Editor at a temporary
 * artifact directory. Surface the validated payload directly so B2 never
 * needs to discover that directory or re-read its output file.
 */
function writerSuccessText(value: unknown): string {
  return [
    "B2 Report Writer 已通过 ack_cli_data 回执验收。以下 JSON 是本卡唯一可用返回：",
    JSON.stringify(value),
    "不要扫描 .pi-subagents 临时目录，也不要手工 ls/read entry 目录或 entry.meta.json。",
  ].join("\n");
}

function failWriterStage(projectRoot: string, session: string, reason: string): string {
  const failed = runStageGate(projectRoot, session, "fail", [
    "--stage",
    "B2_WRITER",
    "--reason",
    reason,
  ]);
  if (!failed.ok) return `${reason}\n扩展无法自动 fail B2_WRITER：${failed.error || "unknown stage-gate error"}`;
  const state = readGateState(projectRoot, session);
  return state ? `${reason}\n${formatGateMessage(state, { stageId: "B2_WRITER" })}` : reason;
}

function failWriterResult(
  projectRoot: string | undefined,
  session: string | undefined,
  reason: string
): ToolResultPatch {
  const concise = String(reason || "B2 Report Writer 终端失败").trim().slice(0, 500);
  const text = projectRoot && session && session !== "unknown"
    ? failWriterStage(projectRoot, session, concise)
    : `${concise}\n缺少当前项目或 Session，扩展无法自动 fail B2_WRITER。`;
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}

async function finishWriterStageIfReady(
  projectRoot: string,
  session: string,
  value: JsonObject
): Promise<{ ok: boolean; text: string; nextTool?: DeterministicNextTool }> {
  if (value.fetchStatus !== "success") {
    const error = String(value.error || "unknown error");
    const kind = error.startsWith("caption rejected:") ? "交稿失败" : "取数失败";
    const reason = `B2 Writer cardId=${String(value.cardId || "unknown")} ${kind}：${error}`;
    return { ok: false, text: failWriterStage(projectRoot, session, reason) };
  }

  const sessionDir = htmlReportSessionDir(projectRoot, session);
  const resultPath = join(sessionDir, "result.json");
  let result: JsonObject;
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
    if (!isObject(parsed) || parsed.status !== "confirmed" || !Array.isArray(parsed.cards) || !parsed.cards.length) {
      throw new Error("result.json must be confirmed and contain a non-empty cards[]");
    }
    result = parsed;
  } catch (error) {
    const reason = `B2 Writer 无法确定义验收 result.json：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, text: failWriterStage(projectRoot, session, reason) };
  }

  const seenPaths = new Set<string>();
  try {
    for (const card of result.cards as unknown[]) {
      if (!isObject(card) || typeof card.id !== "string" || !card.id.trim()) {
        throw new Error("every result.cards[] item must contain a non-empty string id");
      }
      const expected = writerReturnPathsForResult({ resultPath, cardId: card.id });
      if (seenPaths.has(expected.dataPath)) {
        throw new Error(`result card ids collide after path normalization: ${card.id}`);
      }
      seenPaths.add(expected.dataPath);
    }
  } catch (error) {
    const reason = `B2 Writer 无法建立全部卡片契约：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, text: failWriterStage(projectRoot, session, reason) };
  }

  const remaining = await remainingWriterCardIds(projectRoot, session);
  if (remaining.length) {
    const nextTool = writerNextTool(sessionDir, remaining[0]);
    return {
      ok: true,
      text: writerQueueHandoffText(nextTool, remaining),
      nextTool,
    };
  }

  // Caption gate: scan per-card violations after all Writers complete.
  // If violations exist, B2_WRITER stays running; the parent model presents
  // them to the user for per-card waive/fix decisions via caption-gate.mjs.
  const captionGateScript = join(
    packageResourceRoot, "skills", "html-report", "scripts", "caption-gate.mjs",
  );
  const captionGate = spawnSync(
    process.execPath,
    [captionGateScript, "--check", "--session-dir", sessionDir],
    { cwd: resolve(projectRoot), encoding: "utf8" },
  );
  if (captionGate.status === 0 && captionGate.stdout?.trim()) {
    const gateText = captionGate.stdout.trim();
    if (!gateText.includes("无违规")) {
      return {
        ok: true,
        text: gateText,
      };
    }
  }

  let layout;
  try {
    layout = await checkSessionLayout(sessionDir, { phase: "writer" });
  } catch (error) {
    layout = { ok: false, errors: [String((error as Error)?.message || error)] };
  }
  if (!layout.ok) {
    const reason = `B2 phase-writer layout failed: ${(layout.errors || []).join("; ") || "unknown layout error"}`;
    return { ok: false, text: failWriterStage(projectRoot, session, reason) };
  }

  const finished = runStageGate(projectRoot, session, "finish", ["--stage", "B2_WRITER"]);
  if (!finished.ok) {
    const reason = `B2 Writer 产物已验收，但扩展无法自动 finish：${finished.error || "unknown stage-gate error"}`;
    return { ok: false, text: reason };
  }
  return finalizeMainDraftIfReady(projectRoot, session);
}

function failMainStage(projectRoot: string | undefined, session: string | undefined, reason: string): string {
  const concise = String(reason || "B2 Main compose failed").slice(0, 500);
  if (!projectRoot || !session || session === "unknown") {
    return `${concise}\n缺少当前项目或 Session，扩展无法自动 fail B2_MAIN。`;
  }
  const failed = runStageGate(projectRoot, session, "fail", [
    "--stage",
    "B2_MAIN",
    "--reason",
    concise,
  ]);
  const state = readGateState(projectRoot, session);
  if (!failed.ok) return `${concise}\n扩展无法自动 fail B2_MAIN：${failed.error || "unknown stage-gate error"}`;
  return state ? `${concise}\n${formatGateMessage(state, { stageId: "B2_MAIN" })}` : concise;
}

async function finalizeMainDraftIfReady(
  projectRoot: string,
  session: string,
): Promise<{ ok: boolean; text: string }> {
  const afterWriter = readGateState(projectRoot, session);
  if (!isObject(afterWriter) || afterWriter.currentStage !== "B2_MAIN") {
    const gateText = afterWriter
      ? formatGateMessage(afterWriter, { stageId: String(afterWriter.currentStage || "B2_WRITER") })
      : "B2_WRITER completed";
    return {
      ok: true,
      text: `phase-writer layout：passed（扩展已确定性检查并完成 B2）\n${gateText}`,
    };
  }

  const sessionDir = htmlReportSessionDir(projectRoot, session);
  try {
    await composeMain(sessionDir);
  } catch (error) {
    const reason = `B2 Main 合并 analysis/main.md 失败：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, text: failMainStage(projectRoot, session, reason) };
  }

  const finishedMain = runStageGate(projectRoot, session, "finish", ["--stage", "B2_MAIN"]);
  if (!finishedMain.ok) {
    const reason = `初版 MAIN 已写出，但扩展无法自动 finish B2_MAIN：${finishedMain.error || "unknown stage-gate error"}`;
    return { ok: false, text: reason };
  }
  const state = readGateState(projectRoot, session);
  const gateText = state ? formatGateMessage(state, { stageId: "B2_MAIN" }) : "B2_MAIN completed";
  return {
    ok: true,
    text: `phase-writer layout：passed；初版 analysis/main.md 已由 compose-main 合并\n${gateText}`,
  };
}

async function reportWriterResultDecision(event: PiToolResultEvent, projectRoot?: string, session?: string):
  Promise<WriterToolResultPatch | undefined> {
  if (!isSubagentToolName(event.toolName)) return undefined;
  const invocation = writerInvocationFromSubagentInput(event.input);
  if (invocation.error) {
    return failWriterResult(projectRoot, session, `B2 Report Writer 拒绝：${invocation.error}`);
  }
  if (!invocation.invocation) return undefined;
  const expected = writerExpectedFromTask(invocation.invocation.task, { projectRoot, session });
  if ("error" in expected) {
    return failWriterResult(projectRoot, session, `B2 Report Writer 拒绝：${expected.error}`);
  }
  const details = isObject(event.details) ? event.details : null;
  const results = Array.isArray(details?.results) ? details.results : [];
  const result = results.length === 1 && isObject(results[0]) ? results[0] : null;
  if (!result) {
    return failWriterResult(
      projectRoot,
      session,
      event.isError
        ? `B2 Report Writer 子代理失败：${contentText(event.content) || "顶层 tool_result isError=true"}`
        : "B2 Report Writer 拒绝：子代理没有返回唯一 result。"
    );
  }
  const receipt = isObject(result.structuredOutput)
    ? result.structuredOutput
    : extractWriterReceipt(result);
  const emptyOutput = isWriterEmptyOutputError(
    typeof result.error === "string" ? result.error : contentText(event.content)
  );
  if (!receipt) {
    const childErrorText = typeof result.error === "string" && result.error.trim()
      ? result.error.trim()
      : contentText(event.content);
    if (isWriterMissingStructuredOutputError(childErrorText)) {
      return failWriterResult(
        projectRoot,
        session,
        "B2 Report Writer 拒绝：子代理未提交 outputSchema 回执（未走到 ack 失败 / submit 终态）。"
      );
    }
    if (event.isError || result.exitCode !== 0) {
      const childError = childErrorText
        ? `：${childErrorText}`
        : event.isError
          ? "：顶层 tool_result isError=true"
          : "";
      return failWriterResult(
        projectRoot,
        session,
        `B2 Report Writer 拒绝：子代理 exitCode=${String(result.exitCode ?? "unknown")}${childError}`
      );
    }
    return failWriterResult(
      projectRoot,
      session,
      "B2 Report Writer 拒绝：子代理未通过 ack_cli_data 返回回执。"
    );
  }
  if (!emptyOutput && (event.isError || result.exitCode !== 0)) {
    const childError = typeof result.error === "string" && result.error.trim()
      ? `：${result.error.trim()}`
      : "";
    return failWriterResult(
      projectRoot,
      session,
      `B2 Report Writer 拒绝：子代理 exitCode=${String(result.exitCode)}${childError}`
    );
  }
  const checked = validateWriterReturn(receipt, expected);
  if (!checked.ok) {
    return failWriterResult(
      projectRoot,
      session,
      `B2 Report Writer 拒绝：返回契约不合法：${checked.errors.join("；")}`
    );
  }
  if (receipt.fetchStatus === "success") {
    let persisted = null;
    try {
      const resultMtimeMs = (await stat(expected.resultPath)).mtimeMs;
      persisted = await reusableEntry(dirname(expected.dataPath), { notBeforeMs: resultMtimeMs });
    } catch {
      // Return the deterministic contract error below. The child must never be
      // accepted merely because its structured paths look plausible.
    }
    if (!persisted) {
      return failWriterResult(
        projectRoot,
        session,
        "B2 Report Writer 拒绝：success 返回对应的 entry.json / entry.meta.json 不存在、过期，或 rowCount/rowsSha256 无法复算。"
      );
    }
  }
  if (!projectRoot || !session || session === "unknown") {
    return failWriterResult(
      projectRoot,
      session,
      "B2 Report Writer 拒绝：缺少当前项目或 Session，无法执行确定性验收。"
    );
  }
  if (receipt.fetchStatus === "success") {
    try {
      persistEditorWriterReturn(expected.resultPath, receipt);
    } catch (error) {
      const reason = `B2 Writer 已验收，但无法建立 B2.5 Planner 输入缓存：${error instanceof Error ? error.message : String(error)}`;
      return {
        isError: true,
        content: [{ type: "text", text: failWriterStage(projectRoot, session, reason) }],
      };
    }
  }
  const finalized = await finishWriterStageIfReady(projectRoot, session, receipt);
  return {
    isError: finalized.ok ? false : true,
    content: [{
      type: "text",
      text: `${writerSuccessText(receipt)}\n${finalized.text}`,
    }],
    // Preserve the original result for extensions and diagnostics. The Editor
    // consumes the validated JSON above, rather than navigating this detail.
    details: event.details,
    ...(finalized.ok && finalized.nextTool ? { nextTool: finalized.nextTool } : {}),
  };
}

/** Return the sole B2.5 semantic Planner invocation carried by report-researcher. */
function editorPlannerInvocationFromSubagentInput(input: JsonObject | undefined): {
  invocation?: EditorPlannerInvocation;
  error?: string;
} {
  if (!input) return {};
  const unsupported = unsupportedParallelReportAgent(input, "report-researcher");
  if (unsupported) return { error: parallelReportAgentError("Editor Planner", unsupported) };
  if (isReportAgentName(input.agent, "report-researcher") && typeof input.task === "string" && isEditorPlannerAssignment(input.task)) {
    return { error: "Editor Planner 必须使用 fresh 单步骤 chain，不能使用自由文本单代理调用。" };
  }
  if (!Array.isArray(input.chain)) return {};
  const planners = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-researcher") &&
      typeof step.task === "string" && isEditorPlannerAssignment(step.task)
  );
  if (!planners.length) return {};
  if (input.chain.length !== 1 || planners.length !== 1) {
    return { error: "Editor Planner 必须是独立一步 report-researcher chain。" };
  }
  const [planner] = planners;
  if (!isObject(planner.outputSchema)) {
    return { error: "Editor Planner chain 必须带父扩展附加的 typed outputSchema。" };
  }
  return { invocation: { task: String(planner.task) } };
}

function editorPlannerExpected(
  task: string,
  projectRoot?: string,
  session?: string
): ReturnType<typeof editorPlannerExpectedFromAssignment> {
  if (!projectRoot || !session || session === "unknown") {
    return { error: "无法获取当前 html-report Session，拒绝派发 Editor Planner。" };
  }
  return editorPlannerExpectedFromAssignment(task, {
    sessionDir: htmlReportSessionDir(projectRoot, session),
  });
}

/** Attach the Planner-only schema and replace hostile parent lifecycle overrides. */
function attachEditorPlannerOutputSchema(
  input: JsonObject | undefined,
  { projectRoot, session }: { projectRoot?: string; session?: string } = {}
): { error?: string } {
  if (!input || !Array.isArray(input.chain)) return {};
  const planners = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-researcher") &&
      typeof step.task === "string" && isEditorPlannerAssignment(step.task)
  );
  if (!planners.length) return {};
  if (input.chain.length !== 1 || planners.length !== 1) {
    return { error: "B2.5 Editor Planner 只允许单步骤 report-researcher chain。" };
  }
  const [planner] = planners;
  const expected = editorPlannerExpected(String(planner.task), projectRoot, session);
  if ("error" in expected) return { error: expected.error };
  planner.task = expected.assignment;
  const envelope = resetContractRunEnvelope(input, planner, projectRoot);
  if (envelope.error) return envelope;
  planner.outputSchema = buildEditorPlanSchema(expected.input);
  planner.model = EDITOR_PLANNER_MODEL;
  input.turnBudget = { maxTurns: 2, graceTurns: 1 };
  input.maxRuntimeMs = EDITOR_PLANNER_MAX_RUNTIME_MS;
  delete input.toolBudget;
  delete input.timeoutMs;
  planner.toolBudget = { hard: 1, block: "*" };
  delete planner.async;
  delete planner.turnBudget;
  delete planner.timeoutMs;
  delete planner.maxRuntimeMs;
  return {};
}

function failEditorPlannerStage(projectRoot: string, session: string, reason: string): string {
  const concise = String(reason || "Editor Planner contract failure").slice(0, 500);
  const failed = runStageGate(projectRoot, session, "fail", [
    "--stage",
    "B25_EDITOR",
    "--reason",
    concise,
  ]);
  const state = readGateState(projectRoot, session);
  if (!failed.ok) return `${concise}\n扩展无法自动 fail B25_EDITOR：${failed.error || "unknown stage-gate error"}`;
  return state ? `${concise}\n${formatGateMessage(state, { stageId: "B25_EDITOR" })}` : concise;
}

function deterministicNextTool(toolName: "subagent" | "bash", input: JsonObject): DeterministicNextTool {
  return {
    toolName,
    input,
    invocation: `${toolName}(${JSON.stringify(input)})`,
  };
}

/**
 * Build the B2.5 -> B3 handoff only from the validated Planner materialization.
 * No business field, indicator, entity, or test question participates in this
 * decision: a pending task dispatches Researcher, while an empty task list
 * dispatches the deterministic no-op B3 finalizer.
 */
function editorPlannerNextTool(
  materialized: JsonObject,
  expected: { sessionDir: string; resultPath: string; input: JsonObject },
  projectRoot: string
): DeterministicNextTool {
  const researchTasks = Array.isArray(materialized.researchTasks)
    ? materialized.researchTasks
    : [];
  if (!researchTasks.length) {
    const sid = basename(expected.sessionDir);
    const finalizer = researchFinalizerContract(projectRoot, sid);
    if (finalizer.resultPath !== expected.resultPath) {
      throw new Error("materialized Session/result path does not match the B3 finalizer contract");
    }
    return deterministicNextTool("bash", finalizer.input);
  }

  const first = researchTasks[0];
  if (!isObject(first) || !isObject(first.task)) {
    throw new Error("materialized first Researcher handoff is missing task");
  }
  const taskId = typeof first.task.id === "string" ? first.task.id.trim() : "";
  const evidencePath = typeof first.evidencePath === "string" ? first.evidencePath : "";
  if (!taskId || !isAbsolute(evidencePath) || resolve(evidencePath) !== evidencePath) {
    throw new Error("materialized first Researcher handoff has invalid taskId/evidencePath");
  }
  const userQuestion = String(expected.input.userQuestion || "").replace(/\s+/g, " ").trim();
  if (!userQuestion) throw new Error("Planner input is missing userQuestion for Researcher handoff");
  const task = [
    `按 report-researcher 处理 taskId=${taskId}`,
    `SESSION=${expected.sessionDir}`,
    `result.json=${expected.resultPath}`,
    `完整 task 对象: ${JSON.stringify(first.task)}`,
    `用户问题: ${userQuestion}`,
    `evidencePath=${evidencePath}`,
    "机器契约：由 qdm-harness 根据当前 task、mode、requirements 和 outputSchema 注入；父代理不得在这里展开、转述或追加规则。",
  ].join("\n");
  return deterministicNextTool("subagent", {
    chain: [{ agent: reportAgentDispatchName("report-researcher"), task }],
  });
}

async function reportEditorPlannerResultDecision(
  event: PiToolResultEvent,
  projectRoot?: string,
  session?: string,
  { autoDispatchFirstResearcher = false }: { autoDispatchFirstResearcher?: boolean } = {}
): Promise<EditorPlannerToolResultPatch | undefined> {
  if (!isSubagentToolName(event.toolName)) return undefined;
  const invocation = editorPlannerInvocationFromSubagentInput(event.input);
  if (invocation.error) {
    return { isError: true, content: [{ type: "text", text: `B2.5 Editor Planner 拒绝：${invocation.error}` }] };
  }
  if (!invocation.invocation) return undefined;
  if (!projectRoot || !session || session === "unknown") {
    return { isError: true, content: [{ type: "text", text: "B2.5 Editor Planner 拒绝：当前 Session 不可用。" }] };
  }
  const expected = editorPlannerExpected(invocation.invocation.task, projectRoot, session);
  if ("error" in expected) {
    const text = failEditorPlannerStage(projectRoot, session, `Editor Planner input contract failed: ${expected.error}`);
    return { isError: true, content: [{ type: "text", text }] };
  }
  const details = isObject(event.details) ? event.details : null;
  const results = Array.isArray(details?.results) ? details.results : [];
  const result = results.length === 1 && isObject(results[0]) ? results[0] : null;
  if (event.isError === true || !result || result.exitCode !== 0 || !isObject(result.structuredOutput)) {
    const text = failEditorPlannerStage(
      projectRoot,
      session,
      "Editor Planner did not submit one valid structured_output object"
    );
    return { isError: true, content: [{ type: "text", text }], details: event.details };
  }
  const canonicalPlan = normalizeEditorPlan(result.structuredOutput);
  const checked = validateEditorPlan(canonicalPlan, expected.input);
  if (!checked.ok) {
    const text = failEditorPlannerStage(
      projectRoot,
      session,
      `Editor Planner return is invalid: ${checked.errors.join("; ")}`
    );
    return { isError: true, content: [{ type: "text", text }], details: event.details };
  }
  try {
    const materialized = await materializeEditorPlan(expected.resultPath, canonicalPlan, {
      input: expected.input,
    });
    const finished = runStageGate(projectRoot, session, "finish", ["--stage", "B25_EDITOR"]);
    if (!finished.ok) throw new Error(`materialized B2.5 but stage finish failed: ${finished.error || "unknown error"}`);
    const state = readGateState(projectRoot, session);
    const gateText = state
      ? formatGateMessage(state, { stageId: "B25_EDITOR" })
      : "B25_EDITOR completed; B3_RESEARCH started";
    const nextTool = editorPlannerNextTool(
      materialized as unknown as JsonObject,
      expected as unknown as { sessionDir: string; resultPath: string; input: JsonObject },
      projectRoot
    );
    const handoffText = materialized.researchTasks.length
      ? autoDispatchFirstResearcher
        ? [
          "首个前台 Researcher 将由 qdm-harness 通过同一真实 pi-subagents 事件桥立即派发；父模型不得生成、重复或改写该调用。",
          "Researcher 结果会直接附在本次 bootstrap tool result 后；只按该结果处理剩余 task 或固定 finalizer。",
        ]
        : [
          `NEXT_TOOL_ONLY：下一条 assistant 消息只原样调用 \`${nextTool.invocation}\`。`,
          "这是首个前台 Researcher 调用；禁止 wait、读取 tasks/main/evidence、复述或参数重构。",
        ]
      : [
          "Planner 已证明所有来源均为已校验零行，因此没有 Researcher task。",
          `NEXT_TOOL_ONLY：下一条 assistant 消息只原样调用 \`${nextTool.invocation}\`。`,
          "这是空任务 B3 的固定 finalizer；成功后扩展自动 finish 并进入人工 Gate。禁止伪造 Researcher、读取产物、改写命令或手工调用 stage-gate finish。",
        ];
    return {
      isError: false,
      content: [{
        type: "text",
        text: [
          "B2.5 Editor Planner 已通过 typed contract；扩展已确定性生成 tasks/main、准备复用证据、组装报告、通过 b2 layout 并完成 B25。",
          JSON.stringify({
            taskCount: materialized.taskCount,
            tasksPath: materialized.tasksPath,
            mainPath: materialized.mainPath,
            researchTasks: materialized.researchTasks,
            preparedEvidence: materialized.finalized?.evidence?.prepared || [],
          }),
          gateText,
          "B3_RESEARCH 已自动启动。",
          ...handoffText,
        ].join("\n"),
      }],
      details: event.details,
      nextTool,
    };
  } catch (error) {
    const text = failEditorPlannerStage(
      projectRoot,
      session,
      `Editor Planner materialization failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { isError: true, content: [{ type: "text", text }], details: event.details };
  }
}

/** Return the sole Researcher chain invocation, or reject free-format runs. */
function researcherInvocationFromSubagentInput(input: JsonObject | undefined): {
  invocation?: ResearcherInvocation;
  error?: string;
} {
  if (!input) return {};
  if (Array.isArray(input.chain) && input.chain.some(
    (step) => isObject(step) && typeof step.task === "string" && isEditorPlannerAssignment(step.task)
  )) return {};
  const unsupported = unsupportedParallelReportAgent(input, "report-researcher");
  if (unsupported) return { error: parallelReportAgentError("Report Researcher", unsupported) };
  if (isReportAgentName(input.agent, "report-researcher")) {
    return { error: "Report Researcher 必须使用带固定 outputSchema 的单步骤 chain，不能使用自由文本单代理调用。" };
  }
  if (!Array.isArray(input.chain)) return {};
  const researchers = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-researcher")
  );
  if (!researchers.length) return {};
  if (input.chain.length !== 1 || researchers.length !== 1) {
    return { error: "每个 Report Researcher task 必须是独立的一步 chain，且不得混入其他步骤。" };
  }
  const [researcher] = researchers;
  if (!isObject(researcher.outputSchema)) {
    return { error: "Report Researcher chain 必须提供 outputSchema；父代理不能接受自由文本返回。" };
  }
  if (typeof researcher.task !== "string" || !researcher.task.trim()) {
    return { error: "Report Researcher chain 缺少 task，无法校验 taskId、mode 与固定路径。" };
  }
  return { invocation: { task: researcher.task } };
}

function researcherExpected(
  task: string,
  projectRoot?: string,
  session?: string
): ReturnType<typeof researcherExpectedFromAssignment> {
  if (!projectRoot || !session || session === "unknown") {
    return { error: "无法获取当前 html-report session，拒绝派发 Report Researcher。" };
  }
  return researcherExpectedFromAssignment(task, {
    sessionDir: htmlReportSessionDir(projectRoot, session),
  });
}

/**
 * Repair the single harmless label drift observed from the parent model while
 * keeping the path contract strict. Only the exact observed Chinese label
 * variants below are accepted, only when the canonical label is absent and
 * one variant occurs exactly once.
 * The unchanged value is still checked for a canonical absolute path owned by
 * the current SESSION/task.
 */
export function normalizeResearcherEvidencePathLabel(task: string): string {
  const source = String(task || "");
  const canonicalMatches = source.match(/^evidencePath(?:（reuse_entry）)?\s*[:=]/gm) || [];
  if (canonicalMatches.length > 0) return source;
  const driftMatches = source.match(/^证据路径(?::\s*|=)(?:"[^"]+"|'[^']+'|[^\s]+)\s*$/gm) || [];
  if (driftMatches.length !== 1) return source;
  return source.replace(/^证据路径(?::\s*|=)/m, "evidencePath=");
}

const RESEARCHER_SUMMARY_ARTIFACT_RULE = [
  "SUMMARY ARTIFACT RULE (machine contract):",
  "- Before the first write, build one full status=ok return object with these legacy keys: taskId, status, evidenceModeUsed, evidencePath, sectionPath, summaryPath, summary, noData, evidencePointers, selfCheck, suggestedDeeper. When task.analysisRequirements is non-empty, also include findings exactly as required by the attached outputSchema; legacy tasks must omit findings.",
  "- Write that complete object verbatim to summaryPath, then submit the same object unchanged to structured_output. The summary file is NOT a reduced {taskId, summary} record.",
  "- Low-latency commit: after the evidence read, emit section write first and summary write second as exactly two sibling tool calls in ONE assistant message. Pi preflights them in source order. Wait for BOTH write results, then call structured_output in the next message; never include structured_output beside the writes.",
  "- Tool argument distinction: write uses content=JSON text, but structured_output must use value=<JSON object>. Never quote or JSON.stringify structured_output.value; call it as structured_output({value: envelopeObject}).",
  "- After any failed tool result, do not retry or correct a write; the next and only call is structured_output with status=failed.",
  "- Do not claim significance, causality, a universal threshold, or a global optimum unless the cited evidence node explicitly contains that proof. Avoid 显著、驱动、核心因素、导致、证明、影响、更有利 and do not turn group means into an 当…时/即 threshold; describe only the observed selected group.",
].join("\n");

export function ensureResearcherSummaryArtifactRule(task: string): string {
  const source = String(task || "").trimEnd();
  if (source.includes("SUMMARY ARTIFACT RULE (machine contract):")) return source;
  return `${source}\n\n${RESEARCHER_SUMMARY_ARTIFACT_RULE}`;
}

function jsonPointerSegment(value: unknown): string {
  return String(value ?? "").replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Give the child a deterministic, task-derived citation plan.  The plan uses
 * only analysisRequirements and their contracted evidence view ids; it never
 * branches on a business field, question, store, or test prompt.
 */
export function ensureResearcherCitationCommitRule(
  task: string,
  analysisRequirements: unknown,
  operations: unknown = []
): string {
  const source = String(task || "").trimEnd();
  if (source.includes("TYPED FINDINGS SUBMIT RULE (machine contract):")) return source;
  const requirements = Array.isArray(analysisRequirements) ? analysisRequirements : [];
  if (!requirements.length) return source;
  const operationTypes = new Map(
    (Array.isArray(operations) ? operations : [])
      .filter((operation): operation is JsonObject =>
        isObject(operation) && typeof operation.id === "string" && typeof operation.type === "string"
      )
      .map((operation) => [String(operation.id), String(operation.type)])
  );
  const bindings: Record<string, JsonObject> = {};
  for (const requirement of requirements) {
    if (!isObject(requirement) || typeof requirement.id !== "string") continue;
    const viewIds = Array.isArray(requirement.evidenceViewIds)
      ? requirement.evidenceViewIds.filter((viewId): viewId is string => typeof viewId === "string")
      : [];
    const evidencePointers = viewIds.map((viewId) => {
      const root = `/views/${jsonPointerSegment(viewId)}`;
      return operationTypes.get(viewId) === "jointQuantileBins" ? `${root}/decisionBrief` : root;
    });
    bindings[requirement.id] = { evidencePointers };
    if (typeof requirement.capability === "string") {
      bindings[requirement.id].capability = requirement.capability;
    }
  }
  return [
    source,
    "",
    "TYPED FINDINGS SUBMIT RULE (machine contract):",
    `- Exact requirement bindings: ${JSON.stringify(bindings)}`,
    "- Read the authorized evidence once and use each binding's evidencePointers as-is. For jointQuantileBins, copy /decisionBrief.recommendedClaim verbatim as the whole finding claim: do not preface, append, redraft, or traverse evaluation/grid.",
    "- Call submit_research_findings exactly once, alone, with only {findings, suggestedDeeper}: one compact finding per requirement, using only its bound pointers. Copy numeric values exactly; never calculate, round, derive, or borrow numbers from the question/source metadata.",
    "- Meet the bound capability minimally: ranking=two ranked facts; comparison=both sides; structural_breakdown=two units; association=coefficient plus eligible population; joint_tradeoff=the exact recommendedClaim, which already contains its required decision facts and business implication.",
    "- Write answer-first business prose, not JSON/protocol language. Do not claim causality, significance, a global optimum, or a robust low-support winner. Keep suggestedDeeper=[] unless a concrete unresolved gap requires a different metric, dimension, scope, comparison, or query.",
    "- The submit tool validates, renders, and writes both artifacts. Next call structured_output exactly once with the returned researcherReturn. Do not call write afterward. Any submit error consumes the attempt; then call structured_output once with status=failed.",
  ].join("\n");
}

/** Attach an exact structured-return and bounded foreground lifecycle. */
function attachResearcherOutputSchema(
  input: JsonObject | undefined,
  { projectRoot, session }: { projectRoot?: string; session?: string } = {}
): { error?: string } {
  if (Array.isArray(input?.chain) && input.chain.some(
    (step) => isObject(step) && typeof step.task === "string" && isEditorPlannerAssignment(step.task)
  )) return {};
  const unsupported = unsupportedParallelReportAgent(input, "report-researcher");
  if (unsupported) return { error: parallelReportAgentError("Report Researcher", unsupported) };
  if (!input || !Array.isArray(input.chain)) return {};
  const researchers = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-researcher")
  );
  if (!researchers.length || input.chain.length !== 1 || researchers.length !== 1) return {};
  const [researcher] = researchers;
  if (typeof researcher.task !== "string" || !researcher.task.trim()) return {};
  const normalizedTask = normalizeResearcherEvidencePathLabel(researcher.task);
  const expected = researcherExpected(normalizedTask, projectRoot, session);
  if ("error" in expected) return { error: expected.error };
  researcher.task = Number(expected.task?.analysisContractVersion) === 1
    ? ensureResearcherCitationCommitRule(
      normalizedTask,
      expected.analysisRequirements,
      expected.task?.evidencePlan?.operations
    )
    : ensureResearcherSummaryArtifactRule(normalizedTask);
  const envelope = resetContractRunEnvelope(input, researcher, projectRoot);
  if (envelope.error) return envelope;

  researcher.outputSchema = buildResearcherReturnSchema(expected);
  input.turnBudget = expected.mode === "reuse_entry"
    ? { maxTurns: 7, graceTurns: 1 }
    : { maxTurns: 14, graceTurns: 1 };
  input.maxRuntimeMs = expected.mode === "reuse_entry" ? 240_000 : 720_000;
  delete input.toolBudget;
  delete input.timeoutMs;
  researcher.toolBudget = expected.mode === "reuse_entry"
    ? { hard: 3, block: ["read", "write", "bash", "submit_research_findings"] }
    : { hard: 10, block: ["read", "write", "bash", "submit_research_findings"] };
  delete researcher.async;
  delete researcher.turnBudget;
  delete researcher.timeoutMs;
  delete researcher.maxRuntimeMs;
  return {};
}

function researcherSuccessText(
  value: unknown,
  projectRoot?: string,
  session?: string
): string {
  const finalizeCommand = projectRoot && session && session !== "unknown"
    ? researchFinalizerContract(projectRoot, session).command
    : "node .agents/pi/skills/html-report/scripts/finalize-research-stage.mjs --result '<ABS>/result.json'";
  return [
    "B3 Report Researcher 已通过结构化返回与证据产物契约验证。以下 JSON 是本 task 唯一可用返回：",
    JSON.stringify(value),
    "不要读取 summary/section、不要 edit tasks.json/main.md，也不要手工 assemble/layout。若还有未派发 task，直接派发下一 task；全部 task 成功后只运行一次：",
    finalizeCommand,
    "finalizer 成功后 qdm-harness 会自动 finish B3_RESEARCH 并进入既有人工 Gate；不要再调用 stage-gate finish，也不要输出额外解释。",
  ].join("\n");
}

function reportResearcherResultDecision(
  event: PiToolResultEvent,
  projectRoot?: string,
  session?: string
): ToolResultPatch | undefined {
  if (!isSubagentToolName(event.toolName)) return undefined;
  const invocation = researcherInvocationFromSubagentInput(event.input);
  if (invocation.error) {
    return { isError: true, content: [{ type: "text", text: `B3 Report Researcher 拒绝：${invocation.error}` }] };
  }
  if (!invocation.invocation) return undefined;
  const expected = researcherExpected(invocation.invocation.task, projectRoot, session);
  if ("error" in expected) {
    return { isError: true, content: [{ type: "text", text: `B3 Report Researcher 拒绝：${expected.error}` }] };
  }
  const details = isObject(event.details) ? event.details : null;
  const results = Array.isArray(details?.results) ? details.results : [];
  const result = results.length === 1 && isObject(results[0]) ? results[0] : null;
  if (event.isError === true || !result || result.exitCode !== 0 || !("structuredOutput" in result)) {
    return {
      isError: true,
      content: [{ type: "text", text: "B3 Report Researcher 拒绝：子代理未通过 outputSchema 提交唯一的 structured_output JSON。" }],
    };
  }
  const checked = validateResearcherArtifacts(result.structuredOutput, expected);
  if (!checked.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `B3 Report Researcher 拒绝：返回或产物契约不合法：${checked.errors.join("；")}` }],
    };
  }
  return {
    isError: false,
    content: [{ type: "text", text: researcherSuccessText(result.structuredOutput, projectRoot, session) }],
    details: event.details,
  };
}

/** Return the sole Reviewer chain invocation, or reject a prose-only run. */
function reviewerInvocationFromSubagentInput(input: JsonObject | undefined): {
  invocation?: ReviewerInvocation;
  error?: string;
} {
  if (!input) return {};
  const unsupported = unsupportedParallelReportAgent(input, "report-reviewer");
  if (unsupported) return { error: parallelReportAgentError("Report Reviewer", unsupported) };
  if (isReportAgentName(input.agent, "report-reviewer")) {
    return { error: "Report Reviewer 必须使用带固定 outputSchema 的单步骤 chain，不能使用自由文本单代理调用。" };
  }
  if (!Array.isArray(input.chain)) return {};
  const reviewers = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-reviewer")
  );
  if (!reviewers.length) return {};
  if (input.chain.length !== 1 || reviewers.length !== 1) {
    return { error: "Report Reviewer 必须是独立的一步 chain，且不得混入其他步骤。" };
  }
  const [reviewer] = reviewers;
  if (!isObject(reviewer.outputSchema)) {
    return { error: "Report Reviewer chain 必须提供 outputSchema；父代理不能接受自由文本返回。" };
  }
  if (typeof reviewer.task !== "string" || !reviewer.task.trim()) {
    return { error: "Report Reviewer chain 缺少 task，无法校验 SESSION 与 verdict 路径。" };
  }
  return { invocation: { task: reviewer.task } };
}

function reviewerExpected(
  task: string,
  projectRoot?: string,
  session?: string
): ReturnType<typeof reviewerExpectedFromAssignment> {
  if (!projectRoot || !session || session === "unknown") {
    return { error: "无法获取当前 html-report session，拒绝派发 Report Reviewer。" };
  }
  return reviewerExpectedFromAssignment(task, {
    sessionDir: htmlReportSessionDir(projectRoot, session),
  });
}

function reviewerScanPreflightPath(projectRoot: string, sid: string, attempt: string): string {
  const digest = createHash("sha256")
    .update(`${sid}|${attempt}|reviewer-scan-preflight`, "utf8")
    .digest("hex");
  return join(contractRuntimeStateDir(projectRoot, sid), "reviewer-scans", `${digest}.json`);
}

function reviewerFrozenInputPaths(projectRoot: string, sessionDir: string): string[] {
  return [
    join(sessionDir, "result.json"),
    join(sessionDir, "report", "report.md"),
    join(sessionDir, "report", "render-manifest.json"),
    join(projectRoot, "docs", "html-report-quality-rubric.md"),
    join(sessionDir, "quality", "scan.json"),
  ];
}

function reviewerInputSnapshot(paths: string[]): { bytes: number; fingerprint: string } {
  let bytes = 0;
  const hash = createHash("sha256");
  for (const path of paths) {
    const content = readFileSync(path);
    bytes += content.byteLength;
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  return { bytes, fingerprint: hash.digest("hex") };
}

function appendReviewerScanRepairLog(
  sessionDir: string,
  attempt: string,
  scan: JsonObject
): void {
  const repairLogPath = join(sessionDir, "quality", "repair-log.json");
  let document: JsonObject = { version: 1, maxRepairRounds: 2, rounds: [] };
  if (existsSync(repairLogPath)) {
    const parsed = JSON.parse(readFileSync(repairLogPath, "utf8"));
    if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.rounds)) {
      throw new Error("quality/repair-log.json schema is invalid");
    }
    document = parsed;
  }
  const hardIssues = Array.isArray(scan.hardIssues) ? scan.hardIssues : [];
  const codes = hardIssues
    .map((issue) => isObject(issue) && typeof issue.code === "string" ? issue.code : "DATA_UNTRACEABLE")
    .filter((code, index, all) => all.indexOf(code) === index);
  const rounds = Array.isArray(document.rounds) ? document.rounds : [];
  rounds.push({
    at: new Date().toISOString(),
    attempt,
    source: "quality-scan.mjs",
    pass: false,
    total: 0,
    diagnosis: codes,
    actions: ["reconcile_or_remove_untraceable_claims", "retry_current_stage_after_repair"],
    scan: {
      hard: hardIssues.length,
      soft: Array.isArray(scan.softIssues) ? scan.softIssues.length : 0,
      unmatched: isObject(scan.report) && Number.isSafeInteger(scan.report.unmatchedCount)
        ? scan.report.unmatchedCount
        : 0,
      matched: isObject(scan.report) && Number.isSafeInteger(scan.report.matchedCount)
        ? scan.report.matchedCount
        : 0,
    },
  });
  mkdirSync(dirname(repairLogPath), { recursive: true });
  const tempPath = `${repairLogPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ ...document, rounds }, null, 2)}\n`, "utf8");
  renameSync(tempPath, repairLogPath);
}

function failReviewerScanPreflight(
  projectRoot: string,
  sid: string,
  reason: string
): string {
  const failed = runStageGate(projectRoot, sid, "fail", [
    "--stage",
    "B4_REVIEW",
    "--reason",
    reason.slice(0, 500),
  ]);
  return failed.ok ? reason : `${reason}；自动 fail B4_REVIEW 失败：${failed.error || "unknown error"}`;
}

function runReviewerScanPreflight(
  projectRoot: string,
  sid: string,
  attempt: string
): { ok: true } | { ok: false; reason: string } {
  const sessionDir = htmlReportSessionDir(projectRoot, sid);
  const scanPath = join(sessionDir, "quality", "scan.json");
  const frozenPaths = reviewerFrozenInputPaths(projectRoot, sessionDir);
  const markerPath = reviewerScanPreflightPath(projectRoot, sid, attempt);
  if (existsSync(markerPath)) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      const current = reviewerInputSnapshot(frozenPaths);
      if (
        !isObject(marker) ||
        marker.version !== CONTRACT_RUNTIME_STATE_VERSION ||
        marker.producer !== CONTRACT_RUNTIME_STATE_PRODUCER ||
        marker.sessionId !== sid ||
        marker.attempt !== attempt ||
        marker.status !== "passed" ||
        marker.inputFingerprint !== current.fingerprint ||
        marker.inputBytes !== current.bytes
      ) throw new Error("persisted Reviewer scan preflight does not match the frozen inputs");
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: failReviewerScanPreflight(
          projectRoot,
          sid,
          `Reviewer scan preflight marker invalid: ${error instanceof Error ? error.message : String(error)}`
        ),
      };
    }
  }

  const scanScript = join(packageResourceRoot, "skills", "html-report", "scripts", "quality-scan.mjs");
  const resultPath = join(sessionDir, "result.json");
  const execution = spawnSync(process.execPath, [scanScript, "--result", resultPath], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (execution.status !== 0) {
    const detail = String(execution.stderr || execution.stdout || "quality-scan failed").trim().slice(0, 1000);
    return {
      ok: false,
      reason: failReviewerScanPreflight(projectRoot, sid, `quality-scan infrastructure failure: ${detail}`),
    };
  }

  let scan: JsonObject;
  let input: { bytes: number; fingerprint: string };
  try {
    const parsed = JSON.parse(readFileSync(scanPath, "utf8"));
    if (!isObject(parsed) || !Array.isArray(parsed.hardIssues) || !Array.isArray(parsed.softIssues)) {
      throw new Error("quality/scan.json is missing hardIssues/softIssues arrays");
    }
    scan = parsed;
    input = reviewerInputSnapshot(frozenPaths);
    if (input.bytes > REVIEWER_INPUT_MAX_BYTES) {
      throw new Error(`Reviewer frozen input ${input.bytes} bytes exceeds ${REVIEWER_INPUT_MAX_BYTES}-byte budget`);
    }
  } catch (error) {
    return {
      ok: false,
      reason: failReviewerScanPreflight(
        projectRoot,
        sid,
        `Reviewer scan/input contract failure: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }

  if (scan.hardIssues.length > 0) {
    let repairError = "";
    try {
      appendReviewerScanRepairLog(sessionDir, attempt, scan);
    } catch (error) {
      repairError = `；repair-log 写入失败：${error instanceof Error ? error.message : String(error)}`;
    }
    const codes = scan.hardIssues
      .map((issue) => isObject(issue) && typeof issue.code === "string" ? issue.code : "DATA_UNTRACEABLE")
      .filter((code, index, all) => all.indexOf(code) === index)
      .join(",");
    return {
      ok: false,
      reason: failReviewerScanPreflight(
        projectRoot,
        sid,
        `quality-scan hard > 0 (${scan.hardIssues.length}; ${codes || "DATA_UNTRACEABLE"})；不得派发 Reviewer${repairError}`
      ),
    };
  }

  const marker = {
    version: CONTRACT_RUNTIME_STATE_VERSION,
    producer: CONTRACT_RUNTIME_STATE_PRODUCER,
    sessionId: sid,
    attempt,
    status: "passed",
    inputBytes: input.bytes,
    inputFingerprint: input.fingerprint,
    completedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = isObject(error) && typeof error.code === "string" ? error.code : "unknown";
    if (code === "EEXIST") {
      try {
        const existing = JSON.parse(readFileSync(markerPath, "utf8"));
        if (
          isObject(existing) &&
          existing.version === CONTRACT_RUNTIME_STATE_VERSION &&
          existing.producer === CONTRACT_RUNTIME_STATE_PRODUCER &&
          existing.sessionId === sid &&
          existing.attempt === attempt &&
          existing.status === "passed" &&
          existing.inputFingerprint === input.fingerprint &&
          existing.inputBytes === input.bytes
        ) return { ok: true };
      } catch {
        // Fall through to the deterministic Gate failure below.
      }
    }
    return {
      ok: false,
      reason: failReviewerScanPreflight(
        projectRoot,
        sid,
        `cannot persist Reviewer scan preflight: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
  return { ok: true };
}

function reviewerFirstBatchRule(
  projectRoot: string,
  resultPath: string
): string {
  const rubricPath = join(projectRoot, "docs", "html-report-quality-rubric.md");
  return [
    "REVIEWER FIRST BATCH RULE (machine contract):",
    PARENT_REVIEWER_SCAN_MARKER,
    `- Parent scan path: ${join(dirname(resultPath), "quality", "scan.json")}`,
    `- The parent extension already ran quality-scan and rejected hard issues before this child was dispatched. Do not run Bash or re-run the scan.`,
    `- Input budget: exactly five frozen files with a combined on-disk limit of ${REVIEWER_INPUT_MAX_BYTES} bytes. The parent already enforced this limit.`,
    "- The first and only read batch contains result.json, report/report.md, report/render-manifest.json, the rubric, and quality/scan.json. Read each exactly once; no directory discovery or data/analysis reads.",
    `- Exact rubric read path: ${rubricPath}`,
    "- The rubric is a project-level frozen input outside SESSION. Use that exact absolute path; never prefix SESSION or resolve it as SESSION/docs/html-report-quality-rubric.md.",
    "- No submit_review_scorecard or structured_output may share the read batch. Never retry a rejected or failed call.",
    "- After all five reads succeed, call submit_review_scorecard once with only typed scores/notes/summary/issues/repairHints. On success, call structured_output exactly once with the returned reviewerReturn.",
    "- quality-scan is authoritative for numeric traceability. Do not recalculate table rows, means, medians, ranges, or totals, and do not narrate a number-by-number verification.",
    "- Submission shape is exactly {scores:{R1:{score,note},...,R7:{score,note}},summary,hardBlockers,issues,repairHints}. Close scores immediately after R7; the last four fields are top-level siblings. Emit only that tool call.",
    "- Never hand-write verdict.draft.json, verdict.json, or quality/report.md; never run write-verdict.mjs or read stamped verdict.json in the child. The typed tool owns serialization, stamping, and report rendering.",
    "- Base pass formula: no scan/draft hard issues, total>=10, R1>=1, and R2>=1. write-verdict.mjs then applies additional minimum-score gates derived only from status=done Researcher task analysisRequirements[].targetRubric (legacy task.targetRubric is supported). No dynamic targets preserves the base formula.",
    "- Score only from report evidence; never inflate a rubric score merely to satisfy a task target. The typed tool deterministically returns auditable requiredRubrics/gateFailures and owns the final pass decision.",
    "- The typed tool return is authoritative for status/pass/total/paths/requiredRubrics/gateFailures and is captured automatically. Do not calculate, restate, or manually copy it.",
  ].join("\n");
}

function ensureReviewerFirstBatchRule(
  task: string,
  projectRoot: string,
  resultPath: string
): string {
  const source = String(task || "").trimEnd();
  if (source.includes("REVIEWER FIRST BATCH RULE (machine contract):")) return source;
  return `${source}\n\n${reviewerFirstBatchRule(projectRoot, resultPath)}`;
}

function attachReviewerOutputSchema(
  input: JsonObject | undefined,
  { projectRoot, session }: { projectRoot?: string; session?: string } = {}
): { error?: string } {
  const unsupported = unsupportedParallelReportAgent(input, "report-reviewer");
  if (unsupported) return { error: parallelReportAgentError("Report Reviewer", unsupported) };
  if (!input || !Array.isArray(input.chain)) return {};
  const reviewers = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-reviewer")
  );
  if (!reviewers.length || input.chain.length !== 1 || reviewers.length !== 1) return {};
  const [reviewer] = reviewers;
  if (typeof reviewer.task !== "string" || !reviewer.task.trim()) return {};
  const expected = reviewerExpected(reviewer.task, projectRoot, session);
  if ("error" in expected) return { error: expected.error };
  reviewer.task = ensureReviewerFirstBatchRule(
    reviewer.task,
    projectRoot || "",
    expected.resultPath
  );
  const envelope = resetContractRunEnvelope(input, reviewer, projectRoot);
  if (envelope.error) return envelope;

  reviewer.outputSchema = buildReviewerReturnSchema(expected);
  // B3 owns assembly and the parent performs the authoritative quality layout.
  // Keep bounded headroom for frozen reads, one typed submission, and return.
  reviewer.model = REPORT_REVIEWER_MODEL;
  input.turnBudget = { maxTurns: 4, graceTurns: 1 };
  input.maxRuntimeMs = REPORT_REVIEWER_MAX_RUNTIME_MS;
  delete input.toolBudget;
  delete input.timeoutMs;
  reviewer.toolBudget = {
    hard: 6,
    block: ["read", "submit_review_scorecard"],
  };
  delete reviewer.async;
  delete reviewer.turnBudget;
  delete reviewer.timeoutMs;
  delete reviewer.maxRuntimeMs;
  return {};
}

function conciseReviewerIssue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (!isObject(value)) return String(value).slice(0, 500);
  const concise: JsonObject = {};
  for (const key of ["severity", "code", "rubric", "message", "where"]) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) concise[key] = item.slice(0, 500);
  }
  return concise;
}

function reviewerDiagnostics(verdictPath: string): JsonObject {
  try {
    const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
    if (!isObject(verdict)) return { codes: [], hardBlockers: [], issues: [] };
    const hardBlockers = Array.isArray(verdict.hardBlockers)
      ? verdict.hardBlockers.slice(0, 20).map(conciseReviewerIssue)
      : [];
    const issues = Array.isArray(verdict.issues)
      ? verdict.issues.slice(0, 20).map(conciseReviewerIssue)
      : [];
    const codes = [...hardBlockers, ...issues]
      .map((item) => (isObject(item) && typeof item.code === "string" ? item.code : ""))
      .filter((code, index, all) => Boolean(code) && all.indexOf(code) === index);
    return { codes, hardBlockers, issues };
  } catch (error) {
    return {
      codes: ["VERDICT_DIAGNOSTICS_UNAVAILABLE"],
      hardBlockers: [],
      issues: [],
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
  }
}

function reviewerValidatedText(value: unknown, verdictPath: string): string {
  const pass = isObject(value) && value.pass === true;
  const parentDecision = isObject(value)
    ? { ...value, diagnosis: reviewerDiagnostics(verdictPath) }
    : value;
  return [
    `B4 Report Reviewer 已通过结构化返回与落盘 verdict 契约验证；审核结论：${pass ? "passed" : "failed"}。`,
    JSON.stringify(parentDecision),
    "这是父代理唯一可用的审核与诊断 JSON；禁止再读取/扫描 quality、section、entry 或 .pi-subagents 临时目录。只据 pass/total/diagnosis/repairHints 写 repair-log（若需要）并 finish/fail Gate。",
  ].join("\n");
}

function reviewerInfrastructureErrorText(value: JsonObject): string {
  return [
    `B4 Report Reviewer 已验收结构化 infrastructure_error；失败步骤：${String(value.failedStep || "unknown")}。`,
    JSON.stringify(value),
    "这是本 Gate attempt 的终止结果；不要执行 quality layout，也不要原样重派 Reviewer。",
  ].join("\n");
}

async function reportReviewerResultDecision(
  event: PiToolResultEvent,
  projectRoot?: string,
  session?: string
): Promise<ToolResultPatch | undefined> {
  if (!isSubagentToolName(event.toolName)) return undefined;
  const invocation = reviewerInvocationFromSubagentInput(event.input);
  if (invocation.error) {
    return { isError: true, content: [{ type: "text", text: `B4 Report Reviewer 拒绝：${invocation.error}` }] };
  }
  if (!invocation.invocation || event.isError) return undefined;
  const expected = reviewerExpected(invocation.invocation.task, projectRoot, session);
  if ("error" in expected) {
    return { isError: true, content: [{ type: "text", text: `B4 Report Reviewer 拒绝：${expected.error}` }] };
  }
  const details = isObject(event.details) ? event.details : null;
  const results = Array.isArray(details?.results) ? details.results : [];
  const result = results.length === 1 && isObject(results[0]) ? results[0] : null;
  if (!result || result.exitCode !== 0 || !("structuredOutput" in result)) {
    return {
      isError: true,
      content: [{ type: "text", text: "B4 Report Reviewer 拒绝：子代理未通过 outputSchema 提交唯一的 structured_output JSON。" }],
    };
  }
  const checked = validateReviewerArtifacts(result.structuredOutput, expected);
  if (!checked.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `B4 Report Reviewer 拒绝：返回或 verdict 契约不合法：${checked.errors.join("；")}` }],
    };
  }
  if (isObject(result.structuredOutput) && result.structuredOutput.status === "infrastructure_error") {
    return {
      isError: false,
      content: [{ type: "text", text: reviewerInfrastructureErrorText(result.structuredOutput) }],
      details: event.details,
    };
  }
  let layout;
  try {
    layout = await checkSessionLayout(expected.sessionDir, { phase: "quality" });
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `B4 Report Reviewer 拒绝：quality 布局校验异常：${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  if (!layout.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `B4 Report Reviewer 拒绝：quality 布局不合法：${layout.errors.join("；")}` }],
    };
  }
  return {
    isError: false,
    content: [{ type: "text", text: reviewerValidatedText(result.structuredOutput, expected.verdictPath) }],
    details: event.details,
  };
}

/** Return the sole Designer chain invocation, or reject a prose-only run. */
function designerInvocationFromSubagentInput(input: JsonObject | undefined): {
  invocation?: DesignerInvocation;
  error?: string;
} {
  if (!input) return {};
  const unsupported = unsupportedParallelReportAgent(input, "report-designer");
  if (unsupported) return { error: parallelReportAgentError("Report Designer", unsupported) };
  if (isReportAgentName(input.agent, "report-designer")) {
    return { error: "Report Designer 必须使用带固定 outputSchema 的单步骤 chain，不能使用自由文本单代理调用。" };
  }
  if (!Array.isArray(input.chain)) return {};
  const designers = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-designer")
  );
  if (!designers.length) return {};
  if (input.chain.length !== 1 || designers.length !== 1) {
    return { error: "Report Designer 必须是独立的一步 chain，且不得混入其他步骤。" };
  }
  const [designer] = designers;
  if (!isObject(designer.outputSchema)) {
    return { error: "Report Designer chain 必须提供 outputSchema；父代理不能接受自由文本返回。" };
  }
  if (typeof designer.task !== "string" || !designer.task.trim()) {
    return { error: "Report Designer chain 缺少 task，无法校验 SESSION 与固定 HTML 路径。" };
  }
  return { invocation: { task: designer.task } };
}

function designerExpected(
  task: string,
  projectRoot?: string,
  session?: string
): ReturnType<typeof designerExpectedFromAssignment> {
  if (!projectRoot || !session || session === "unknown") {
    return { error: "无法获取当前 html-report session，拒绝派发 Report Designer。" };
  }
  return designerExpectedFromAssignment(task, {
    sessionDir: htmlReportSessionDir(projectRoot, session),
  });
}

function designerExecutionRule(
  projectRoot: string,
  expected: Exclude<ReturnType<typeof designerExpectedFromAssignment>, { error: string }>
): string {
  const scripts = join(packageResourceRoot, "skills/html-report/scripts");
  const designSkill = join(packageResourceRoot, "skills/html-report-design");
  return [
    "DESIGNER FIXED EXECUTION RULE (machine contract):",
    "- The html-report-design Skill is already injected. Do not read SKILL.md, list/scan directories, search for files, or read any script source.",
    `- Compile exactly once: node '${join(scripts, "compile-report-content.mjs")}' --result '${expected.resultPath}'`,
    "- After compile succeeds, read exactly these four fixed design inputs in one sibling tool batch:",
    `  1) ${join(expected.sessionDir, "report", "design-input.json")}`,
    `  2) ${join(expected.sessionDir, "report", "report.content.html")}`,
    `  3) ${join(designSkill, "references", "report-design-system.md")}`,
    `  4) ${join(designSkill, "assets", "report-shell-starter.html")}`,
    `- Write ${join(expected.sessionDir, "report", "report.design.html")} exactly once with exactly one literal <!-- HTML_REPORT_CONTENT --> slot. report.content.html is context only: never paste, copy, inline, or reproduce it. compose-report.mjs is the sole content inserter.`,
    "- Immediately after that first write succeeds, the next tool call must be the fixed Compose command below. Before Compose then Capture both succeed and both screenshots are read, edit and a second write are forbidden by the child runtime guard.",
    "- Keep the literal content slot permanently untouched. Only a screenshot-visible defect may trigger an edit plus another compose/capture, for at most two repair rounds; edit must never replace the slot or insert compiled business content.",
    `- Compose: node '${join(scripts, "compose-report.mjs")}' --result '${expected.resultPath}'`,
    `- Capture: node '${join(scripts, "capture-report.mjs")}' --result '${expected.resultPath}'`,
    `- Write ${join(expected.sessionDir, "report", "design-result.draft.json")} with exactly this shape after inspecting both screenshots (replace only the notes strings):`,
    JSON.stringify({
      status: "pass",
      viewports: {
        desktop: { pass: true, notes: "<desktop screenshot assessment>" },
        mobile: { pass: true, notes: "<mobile screenshot assessment>" },
      },
      notes: [],
    }),
    "- Draft uses viewports (plural) with nested boolean pass fields. Do not add version/producer/sessionId, viewport (singular), or an assessment wrapper.",
    `- Finalize exactly once after that draft write: node '${join(scripts, "finalize-design.mjs")}' --result '${expected.resultPath}' --assessment-file '${join(expected.sessionDir, "report", "design-result.draft.json")}'`,
    `- Run layout exactly once after finalization: node '${join(scripts, "check-session-layout.mjs")}' --result '${expected.resultPath}' --phase html`,
    "- When layout reports ok=true, do not read design-result.json, render.meta.json, report.html, or any other final file. Immediately call structured_output once with the fixed status=ok object and no prose.",
    "- elapsedMs may be 0; do not add shell/tool calls only to calculate timing. Parent Gate timing is authoritative.",
    "- If any command/read/write fails, do not retry that tool or continue the workflow. Immediately call structured_output once with status=failed, layoutOk=false, a concise error, and at least one residualNotes item.",
    "- structured_output.value must be the JSON object, never quoted or JSON.stringify'd. Do not return an acceptance report, changed-files list, tests, commands-run narrative, Markdown fence, or ordinary chat reply.",
    "- Fixed success paths object:",
    JSON.stringify({
      reportHtml: expected.reportHtml,
      renderMeta: expected.renderMeta,
      designResult: expected.designResult,
      desktopScreenshot: expected.desktopScreenshot,
      mobileScreenshot: expected.mobileScreenshot,
    }),
  ].join("\n");
}

function ensureDesignerExecutionRule(
  task: string,
  projectRoot: string,
  expected: Exclude<ReturnType<typeof designerExpectedFromAssignment>, { error: string }>
): string {
  const source = String(task || "").trimEnd();
  if (source.includes("DESIGNER FIXED EXECUTION RULE (machine contract):")) return source;
  return `${source}\n\n${designerExecutionRule(projectRoot, expected)}`;
}

/** Attach the exact B5 schema and remove generic implementation acceptance. */
function attachDesignerOutputSchema(
  input: JsonObject | undefined,
  { projectRoot, session }: { projectRoot?: string; session?: string } = {}
): { error?: string } {
  const unsupported = unsupportedParallelReportAgent(input, "report-designer");
  if (unsupported) return { error: parallelReportAgentError("Report Designer", unsupported) };
  if (!input) return {};
  if (isReportAgentName(input.agent, "report-designer")) {
    return { error: "Report Designer 必须使用单步骤 chain；请把 agent/task 放入 chain[0]。" };
  }
  if (!Array.isArray(input.chain)) return {};
  const designers = input.chain.filter(
    (step): step is JsonObject => isObject(step) && isReportAgentName(step.agent, "report-designer")
  );
  if (!designers.length || input.chain.length !== 1 || designers.length !== 1) return {};
  const [designer] = designers;
  if (typeof designer.task !== "string" || !designer.task.trim()) return {};
  const expected = designerExpected(designer.task, projectRoot, session);
  if ("error" in expected) return { error: expected.error };
  designer.task = ensureDesignerExecutionRule(designer.task, projectRoot || "", expected);
  const envelope = resetContractRunEnvelope(input, designer, projectRoot);
  if (envelope.error) return envelope;

  designer.outputSchema = buildDesignerReturnSchema(expected);
  // Keep the existing Designer budget. The contract removes directory/script
  // exploration and generic acceptance work instead of buying more retries.
  input.turnBudget = { maxTurns: 14, graceTurns: 2 };
  input.maxRuntimeMs = 300_000;
  delete input.toolBudget;
  delete input.timeoutMs;
  designer.toolBudget = {
    hard: 24,
    block: ["read", "bash", "write", "edit"],
  };
  delete designer.async;
  delete designer.turnBudget;
  delete designer.timeoutMs;
  delete designer.maxRuntimeMs;
  return {};
}

function designerValidatedText(value: unknown): string {
  return [
    "B5 Report Designer 已通过结构化返回、固定产物与 phase-html layout 契约验证。以下 JSON 是唯一可用结果：",
    JSON.stringify(value),
    "不要再次读取 report.html、render.meta.json、design-result.json 或截图，也不要再次运行 layout。直接 finish B5 Gate 并向用户返回上述绝对路径。",
  ].join("\n");
}

function designerFailedText(value: unknown): string {
  return [
    "B5 Report Designer 已验收结构化 status=failed。以下 JSON 是本 Gate attempt 的终止结果：",
    JSON.stringify(value),
    "不要原样重派 Designer；立即 fail B5 Gate。只有用户显式重试当前阶段才能创建新 attempt。",
  ].join("\n");
}

async function reportDesignerResultDecision(
  event: PiToolResultEvent,
  projectRoot?: string,
  session?: string
): Promise<ToolResultPatch | undefined> {
  if (!isSubagentToolName(event.toolName)) return undefined;
  const invocation = designerInvocationFromSubagentInput(event.input);
  if (invocation.error) {
    return { isError: true, content: [{ type: "text", text: `B5 Report Designer 拒绝：${invocation.error}` }] };
  }
  if (!invocation.invocation) return undefined;
  const expected = designerExpected(invocation.invocation.task, projectRoot, session);
  if ("error" in expected) {
    return { isError: true, content: [{ type: "text", text: `B5 Report Designer 拒绝：${expected.error}` }] };
  }
  const details = isObject(event.details) ? event.details : null;
  const results = Array.isArray(details?.results) ? details.results : [];
  const result = results.length === 1 && isObject(results[0]) ? results[0] : null;
  if (event.isError === true || !result || result.exitCode !== 0 || !("structuredOutput" in result)) {
    return {
      isError: true,
      content: [{ type: "text", text: "B5 Report Designer 拒绝：子代理未通过 outputSchema 提交唯一的 structured_output JSON。" }],
    };
  }
  const checked = await validateDesignerArtifacts(result.structuredOutput, expected);
  if (!checked.ok) {
    return {
      isError: true,
      content: [{ type: "text", text: `B5 Report Designer 拒绝：返回或 HTML 产物契约不合法：${checked.errors.join("；")}` }],
    };
  }
  const failed = isObject(result.structuredOutput) && result.structuredOutput.status === "failed";
  return {
    isError: false,
    content: [{
      type: "text",
      text: failed
        ? designerFailedText(result.structuredOutput)
        : designerValidatedText(result.structuredOutput),
    }],
    details: event.details,
  };
}

function latestUserPrompt(event: unknown): string {
  if (typeof event === "string") return event.trim();
  if (!isObject(event)) return "";
  for (const key of ["prompt", "input", "text", "message"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isObject(message) || message.role !== "user") continue;
    const text = contentText(message.content).trim();
    if (text) return text;
  }
  return "";
}

function isHtmlReportSkillPrompt(prompt: string): boolean {
  return (
    /<skill\s+name=["']html-report["']/i.test(prompt) ||
    /\/skill:\s*html-report\b/i.test(prompt) ||
    /\bskill:\s*html-report\b/i.test(prompt)
  );
}

export function harnessQuestion(prompt: string): string {
  // Pi expands the complete SKILL.md inside <skill>...</skill>. The document
  // itself may mention the literal text `</skill>`, so the opening-to-closing
  // part must be greedy and end at Pi's final wrapper tag. A lazy match would
  // leak the remainder of SKILL.md into recommendations.userQuestion.
  const match = prompt.match(/<skill\s+name=["']html-report["'][^>]*>[\s\S]*<\/skill>([\s\S]*)$/i);
  return (match?.[1] ?? prompt).trim();
}

const COMPACT_HTML_REPORT_SKILL_HISTORY = [
  '<skill name="html-report" compacted="phase-b">',
  "Phase A skill instructions are complete. Follow only the current extension-injected Gate contract.",
  "</skill>",
].join("\n");

function compactHtmlReportSkillText(value: string): string {
  if (!/<skill\s+name=["']html-report["']/i.test(value)) return value;
  // Greedy by design: SKILL.md itself mentions the literal closing tag, while
  // Pi's final wrapper is the last </skill>. Preserve everything after it,
  // including the original business question.
  return value.replace(
    /<skill\s+name=["']html-report["'][^>]*>[\s\S]*<\/skill>/i,
    COMPACT_HTML_REPORT_SKILL_HISTORY
  );
}

/** Drop the completed Phase A skill body from model history, not from disk. */
export function compactHtmlReportSkillHistory(messages: unknown[], gateState: unknown): unknown[] {
  if (
    !isObject(gateState) ||
    gateState.currentStage === "A_CONFIG" ||
    !Array.isArray(messages)
  ) return messages;
  let changed = false;
  const compacted = messages.map((message) => {
    if (!isObject(message) || message.role !== "user") return message;
    if (typeof message.content === "string") {
      const content = compactHtmlReportSkillText(message.content);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content };
    }
    if (!Array.isArray(message.content)) return message;
    let contentChanged = false;
    const content = message.content.map((block) => {
      if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return block;
      const text = compactHtmlReportSkillText(block.text);
      if (text === block.text) return block;
      contentChanged = true;
      return { ...block, text };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? compacted : messages;
}

const HTML_REPORT_STAGE_IDS = Object.keys(STAGE_DEFINITIONS);

function terminalGateResponse(
  message: JsonObject
): { stageId: string; terminalStatus: "completed" | "failed" } | null {
  if (message.role === "custom") {
    const details = isObject(message.details) ? message.details : null;
    const stageId = details?.stageId;
    if (!(message.customType === HTML_REPORT_GATE_CUSTOM_TYPE &&
      details?.version === 1 &&
      details?.producer === "qdm-harness" &&
      typeof stageId === "string" &&
      HTML_REPORT_STAGE_IDS.includes(stageId))) return null;
    if (
      details?.pipelineStatus === "awaiting_approval" &&
      details?.stageStatus === "awaiting_approval"
    ) return { stageId, terminalStatus: "completed" };
    if (details?.pipelineStatus === "failed" && details?.stageStatus === "failed") {
      return { stageId, terminalStatus: "failed" };
    }
    return null;
  }
  if (message.role !== "assistant") return null;
  const text = contentText(message.content).trim();
  const match = /^阶段：([^\n]+)\n状态：completed(?:\n|$)/.exec(text);
  if (!match || (!text.includes("\n下一阶段：") && !text.includes("\n报告已完成"))) return null;
  const entry = Object.values(STAGE_DEFINITIONS).find((stage) => stage.gateLabel === match[1]);
  return entry?.id ? { stageId: entry.id, terminalStatus: "completed" } : null;
}

/**
 * Remove completed Gate prose and its hidden reasoning once a later stage is
 * active. Repeated "继续 -> completed" assistant turns otherwise prime some
 * providers to fabricate the next completion instead of following the current
 * NEXT_TOOL_ONLY contract. The short marker preserves audit order without
 * carrying an executable or user-facing Gate response forward.
 */
export function compactHtmlReportGateHistory(messages: unknown[], gateState: unknown): unknown[] {
  if (!isObject(gateState) || !Array.isArray(messages)) return messages;
  const currentIndex = HTML_REPORT_STAGE_IDS.indexOf(String(gateState.currentStage || ""));
  if (currentIndex <= 0) return messages;
  let changed = false;
  const compacted = messages.map((message) => {
    if (!isObject(message)) return message;
    const terminal = terminalGateResponse(message);
    const stageIndex = terminal ? HTML_REPORT_STAGE_IDS.indexOf(terminal.stageId) : -1;
    if (!terminal || stageIndex < 0 || stageIndex >= currentIndex) return message;
    changed = true;
    return {
      ...message,
      content: [{
        type: "text",
        text: `[html-report prior Gate compacted: ${terminal.stageId} ${terminal.terminalStatus}]`,
      }],
    };
  });
  return changed ? compacted : messages;
}

function htmlReportModeBanner(): string {
  return [
    "# html-report mode",
    "- Primary recall: `prepare.mjs` → `data-harness-cli wikis recall-debug --doc-set specs` (Spec-only).",
    "- Read Spec documents for business definitions and indicator codes; do not open playbooks for 取数.",
    "- Do not run `analysis execute` / CMR query; do not answer with business metric values in chat.",
    "- If Spec recall is empty: explore `wikis/metrics/index.md` and `wikis/reports/index.md`, then open only relevant `spec.md` files.",
    "- Finish by opening `qdm-metric-cli ui --session-local-dir $SESSION`. Do not write recommendations.json or start server.mjs.",
  ].join("\n");
}

function useFixedAConfigPreset(): boolean {
  // During the current HTML pipeline debugging period, a known-good preset is
  // safer than asking every manual test command to remember an opt-in flag.
  // Dynamic recommendation remains available only through an explicit opt-out.
  return process.env.HTML_REPORT_A_CONFIG_MODE !== "dynamic";
}

function fixedPresetShouldOpenBrowser(): boolean {
  return process.env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN !== "0";
}

function htmlReportSkillScript(fileName: string): string {
  return join(packageResourceRoot, "skills", "html-report", "scripts", fileName);
}

function stopHtmlReportUi(projectRoot: string, sid: string): void {
  if (!sid || sid === "unknown") return;
  const uiScript = htmlReportSkillScript("open-metric-cli-ui.mjs");
  try {
    spawnSync(
      process.execPath,
      [uiScript, "--stop", "--session-id", sid, "--project-root", projectRoot],
      { cwd: projectRoot, encoding: "utf8", timeout: 5000 }
    );
  } catch {
    // UI cleanup must not throw back into Pi.
  }
}

function stopHtmlReportSidecars(projectRoot: string, sid: string): void {
  if (!sid || sid === "unknown") return;
  stopHtmlReportUi(projectRoot, sid);
  const recommendationsPath = join(htmlReportSessionDir(projectRoot, sid), "recommendations.json");
  if (!existsSync(recommendationsPath)) return;
  const serverScript = htmlReportSkillScript("server.mjs");
  try {
    spawnSync(
      process.execPath,
      [serverScript, "--config", recommendationsPath, "--stop"],
      { cwd: projectRoot, encoding: "utf8", timeout: 5000 }
    );
  } catch {
    // ignore leftover-server stop failures
  }
}

/**
 * Default Phase A: open qdm-metric-cli ui against $SESSION.
 * The user builds cards in that page, clicks 保存, then replies 「继续」.
 * This path does not write recommendations.json or start server.mjs.
 */
function seedFixedAConfig(
  projectRoot: string,
  sid: string,
  question: string
): { ok: true; seed: FixedRecommendationSeed } | { ok: false; error: string } {
  const script = htmlReportSkillScript("open-metric-cli-ui.mjs");
  const args = [
    script,
    "--session-id",
    sid,
    "--question",
    question,
    "--detach",
    "--project-root",
    projectRoot,
  ];
  if (fixedPresetShouldOpenBrowser()) args.push("--open");
  else args.push("--skip-spawn");
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || "qdm-metric-cli ui failed to start").trim() };
  }
  try {
    return { ok: true, seed: JSON.parse(result.stdout) as FixedRecommendationSeed };
  } catch {
    return { ok: false, error: "qdm-metric-cli ui launcher returned invalid JSON" };
  }
}

export function fixedAConfigBanner(seed: FixedRecommendationSeed): string {
  return [
    "# html-report 阶段 A：qdm-metric-cli ui",
    "- 扩展已启动 `qdm-metric-cli ui --session-local-dir $SESSION`。",
    seed.serverUrl ? `- 本地编辑器：${seed.serverUrl}` : "- 本地编辑器已按当前设置启动；测试环境可能跳过真正拉起进程。",
    "- 请在该页面改卡后点击「保存」，写出 `$SESSION/result.json`。",
    "- 保存后回到 Pi 回复一次「继续」。",
    "- 配置校验通过后，本地编辑器服务会自动关闭；浏览器标签页需自行关闭。",
  ]
    .filter(Boolean)
    .join("\n");
}

function fixedAConfigSystemBanner(seed: FixedRecommendationSeed): string {
  return [
    fixedAConfigBanner(seed),
    "- 本轮不做推荐生成，也不打开 public/local-report-builder.html。",
    "- A_CONFIG 获批后自动执行 B0；B0 通过会关闭本地编辑器并直接进入 B2 Writer，失败时才停在 Gate。",
    "- runtime agent list 已由扩展通过真实 pi-subagents 事件桥自动执行；模型无需也不得调用 subagent。",
    "- 不要写 recommendations.json，不要启动 server.mjs。",
  ].join("\n");
}

function fixedAConfigFailureBanner(reason: string): string {
  return [
    "# html-report 阶段 A：qdm-metric-cli ui",
    "- 无法启动 qdm-metric-cli ui；不会回退到旧 HTML 或生成 recommendations.json。",
    `- 原因：${reason || "unknown metric-cli ui startup failure"}`,
    "- 请确认 config/harness-config.yaml 的 cli.qdm_metric_cli 指向已包含 --session-local-dir 的二进制后重试。",
  ].join("\n");
}

function fixedAConfigMessage(sid: string, seed: FixedRecommendationSeed) {
  return {
    customType: HTML_REPORT_UI_CUSTOM_TYPE,
    content: fixedAConfigBanner(seed),
    display: true,
    details: {
      version: 1,
      producer: "qdm-harness",
      sessionId: sid,
      serverUrl: seed.serverUrl || null,
    },
  };
}

function buildContextFromCliJson(payload: CliContextPayload): string {
  const files = Array.isArray(payload.contextFiles)
    ? payload.contextFiles
        .map((entry) => {
          const pathValue = entry?.path;
          return typeof pathValue === "string" && pathValue.trim() ? `- ${pathValue.trim()}` : "";
        })
        .filter(Boolean)
    : [];
  const constraints = Array.isArray(payload.constraints)
    ? payload.constraints
        .map((constraint) => (typeof constraint === "string" ? `- ${constraint}` : ""))
        .filter(Boolean)
    : [];

  return [
    "# Data Harness Context",
    "",
    files.length ? "必须先读取以下 contextFiles：" : "",
    ...files,
    payload.instruction ? "" : "",
    payload.instruction ?? "",
    constraints.length ? "- constraints:" : "",
    ...constraints,
  ]
    .filter(Boolean)
    .join("\n");
}

function detectContextFormat(cli: string): ContextFormat {
  if (contextFormat) return contextFormat;

  const probe = spawnSync(cli, ["context", "--help"], { encoding: "utf8" });
  const output = `${probe.stderr ?? ""}${probe.stdout ?? ""}`;
  if (/agent-hook/.test(output)) {
    contextFormat = "agent-hook";
    return contextFormat;
  }
  contextFormat = "json";
  return contextFormat;
}

function detectPosttoolFormat(cli: string): "agent-hook" | "claude-hook" {
  const probe = spawnSync(cli, ["posttool", "--help"], { encoding: "utf8" });
  const output = `${probe.stderr ?? ""}${probe.stdout ?? ""}`;
  if (/agent-hook/.test(output)) return "agent-hook";
  return "claude-hook";
}

function runHarnessContext(projectRoot: string, prompt: string, ctx?: PiExtensionContext): string {
  if (!prompt) return "";
  const htmlReport = isHtmlReportSkillPrompt(prompt);
  const question = harnessQuestion(prompt);
  if (!question) return htmlReport ? htmlReportModeBanner() : "";

  const cli = join(projectRoot, "bin", "data-harness-cli");
  const format = detectContextFormat(cli);
  const docSet = htmlReport ? "specs" : "default";
  const result =
    format === "agent-hook"
      ? spawnSync(cli, ["context", "--format", "agent-hook"], {
          cwd: projectRoot,
          input: JSON.stringify({
            session_id: sessionId(ctx),
            prompt: question,
            doc_set: docSet,
          }),
          encoding: "utf8",
        })
      : spawnSync(cli, ["context", "--json", "--question", question, "--doc-set", docSet], {
          cwd: projectRoot,
          encoding: "utf8",
        });

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "unknown error").trim();
    ctx?.ui?.notify?.(`QDM Harness context failed: ${message}`, "warning");
    return htmlReport ? htmlReportModeBanner() : "";
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    let context = "";
    if (format === "json") {
      context = buildContextFromCliJson(payload as CliContextPayload);
    } else {
      const hookPayload = payload as JsonObject;
      const hookOutput = isObject(hookPayload.hookSpecificOutput) ? hookPayload.hookSpecificOutput : null;
      const additional = isObject(hookOutput) ? hookOutput.additionalContext : undefined;
      context = typeof additional === "string" ? addPiPathGuidance(additional.trim(), htmlReport) : "";
    }
    if (htmlReport) {
      return [htmlReportModeBanner(), context].filter(Boolean).join("\n\n");
    }
    return context;
  } catch {
    return htmlReport ? htmlReportModeBanner() : "";
  }
}

function addPiPathGuidance(context: string, htmlReport = false): string {
  if (!context) return "";
  if (htmlReport) {
    const selectedSpec = context.match(/^- (wikis\/.+?\/spec\.md) \([^)]+\)$/m)?.[1];
    return [
      "# Pi Path Guidance (html-report)",
      "",
      "- Read only Spec paths under contextFiles (usually `wikis/.../spec.md`).",
      "- Do not treat selectedPlaybook as a file you must execute; Specs define codes and business meaning.",
      selectedSpec ? `- Selected Spec read path: \`${selectedSpec}\`.` : "",
      "",
      context,
    ]
      .filter(Boolean)
      .join("\n");
  }
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
  ].filter(Boolean).join("\n");
}

function qdmContextMessage(text: string): JsonObject {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
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
    "The runtime dynamically injects only scope dimensions applicable to the requested metric's supported dimensions and filters; it does not inject every scope dimension on every query.",
    "After every successful `analysis execute`, disclose the applicable scope and that results are scoped by 账号数据权限.",
    "Obtain applicable sapArea2Id, dcSapArea2Id, and/or categoryLevel1Id scope with `qdm-metric-cli auth describe`; do not guess scope IDs or labels.",
  ].join("\n");
}

/** Bind the current Pi turn to Host/Lumi auth, with local fallback only when allowed. */
function bindAuthzForTurn(
  projectRoot: string,
  store: AuthzStateStore,
  ctx: PiExtensionContext | undefined,
  event?: PiContextEvent,
): { mode: "off" | "on"; bound: boolean; error?: string; source?: string } {
  const config = loadAuthzConfig(projectRoot);
  const sid = sessionId(ctx);
  if (config.mode !== "on") {
    store.clear(sid);
    return { mode: "off", bound: false };
  }

  // A failed bind must never leave another user's previous turn active.
  store.clear(sid);
  const resolved = resolveAuthBlob({
    projectRoot,
    config,
    hostAuth: event?._auth,
    hostUserId: event?._auth_user_id,
    sessionId: envelopeSessionId(ctx),
  });
  if (!resolved.ok) return { mode: "on", bound: false, error: resolved.error };

  store.bind(sid, resolved.userId, resolved.blob, resolved.source);
  return { mode: "on", bound: true, source: resolved.source };
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
  if (posttoolFormat === "agent-hook") {
    const resolvedFormat = detectPosttoolFormat(cli);
    posttoolFormat = resolvedFormat;
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
    `posttool --format ${posttoolFormat}`,
    "| node",
    shellQuote(extractContextScript),
    ";",
    "exit $__qdm_status",
  ].join(" ");
}

export default function qdmHarnessExtension(pi: {
  on?: (event: string, handler: (event: unknown, ctx?: PiExtensionContext) => unknown) => void;
  events?: PiEventBus;
  cwd?: string;
  getActiveTools?: () => string[];
  setActiveTools?: (toolNames: string[]) => void;
  registerTool?: (definition: {
    name: string;
    label: string;
    description: string;
    parameters: JsonObject;
    execute: (
      toolCallId: string,
      params: JsonObject,
      signal?: AbortSignal,
      onUpdate?: (update: unknown) => void,
      ctx?: PiExtensionContext
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>;
    renderCall?: (args: JsonObject, theme?: unknown, context?: unknown) => { render: (width: number) => string[] };
    renderResult?: (
      result: { content?: Array<{ type?: string; text?: string }>; details?: unknown; isError?: boolean },
      options?: { expanded?: boolean; isPartial?: boolean },
      theme?: unknown,
      context?: unknown
    ) => { render: (width: number) => string[] };
  }) => void;
  sendMessage?: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ) => void;
}): void {
  const projectRoot = findProjectRoot(pi.cwd ?? process.cwd());
  const runtimeSourcesAtLoad = captureRuntimeSources(projectRoot);
  const authzStore = new AuthzStateStore();
  const b2StartupStatuses = new Map<string, B2StartupStatusRecord>();
  const b2StartupStatusCalls = new Map<string, string>();
  const b2StartupToolSnapshots = new Map<string, string[]>();
  const b25Bootstraps = new Map<string, B25BootstrapRecord>();
  const b25BootstrapCalls = new Map<string, { key: string; kind: "status" | "source_fields" }>();
  const b3HandoffTools = new Map<string, B3HandoffToolRecord>();
  const b3HandoffToolSnapshots = new Map<string, string[]>();
  const b2WriterQueueTools = new Map<string, B3HandoffToolRecord>();
  const b2WriterQueueToolSnapshots = new Map<string, string[]>();
  const b3FinalizersInFlight = new Map<string, B3FinalizerInFlight>();
  const settledB3FinalizerToolCalls = new Set<string>();
  let staleRuntimeError: string | null = null;
  let staleUnknownHtmlReportTurn = false;
  const staleHtmlReportSessions = new Set<string>();
  const incompatibleSessionErrors = new Map<string, string>();
  const freshnessNotifiedSessions = new Set<string>();
  let injectedPromptThisTurn = "";
  // `context` can receive a normalized user message without the expanded
  // <skill> wrapper. Keep this per-session marker so a fixed html-report
  // skill invocation cannot accidentally recall there after Phase A was
  // already seeded. A later non-skill user turn clears the marker.
  const suppressHarnessRecallForSkillSessions = new Set<string>();
  const finishingSessions = new Set<string>();
  const finishingToolCalls = new Map<string, GateToolInFlight>();
  const contractDispatches = new Map<string, ContractDispatchRecord>();
  const inFlightContractCalls = new Map<string, ContractCallInFlight>();
  const settledContractToolCalls = new Set<string>();
  const researcherParentTerminals = new Map<string, ResearcherParentTerminal>();
  const reviewerParentTerminals = new Map<string, ReviewerParentTerminal>();
  const fixedAConfigSessions = new Set<string>();
  const runtimeAgentLists = new Map<string, RuntimeAgentListRecord>();
  const runtimeAgentListCalls = new Map<string, string>();
  const runtimeAgentListPromises = new Map<string, Promise<void>>();
  const stageRunnerToolSnapshots = new Map<string, string[]>();
  const stageRunnerInFlightSessions = new Set<string>();
  const stageProgressSessions = new Map<string, HtmlReportStageProgressSession>();
  const stageRunner = new HtmlReportStageRunner();
  const transportManager = pi.events
    ? new SubagentTransportManager(pi.events, {
        onLifecycle(event) {
          persistReportAgentLifecycle(htmlReportSessionDir(projectRoot, event.sessionId), event);
        },
      })
    : null;

  /**
   * The fixed A_CONFIG preset is the current end-to-end debug path.  It is
   * deliberately tracked per live Pi session instead of inferred from a
   * process environment variable: a normal/dynamic session in the same Pi
   * process must continue to use the real Designer contract.
   */
  function shouldSkipB5DesignForFixedDebugSession(sid: string): boolean {
    if (!sid || sid === "unknown") return false;
    if (fixedAConfigSessions.has(sid)) return true;
    // Preserve the Debug B5 rule across a same-version Pi/extension restart.
    // This marker is produced only by the deterministic fixed-preset seeder.
    const sessionDir = htmlReportSessionDir(projectRoot, sid);
    const markers = [
      join(sessionDir, "debug", "metric-cli-ui.json"),
      join(sessionDir, "debug", "fixed-recommendation.json"),
    ];
    for (const markerPath of markers) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        const knownProducer = marker?.producer === "open-metric-cli-ui.mjs" ||
          marker?.producer === "seed-debug-recommendations.mjs";
        if (
          marker?.version === 1 &&
          knownProducer &&
          marker?.sessionId === sid &&
          marker?.b5Design === "skip"
        ) {
          return true;
        }
      } catch {
        // try the next marker
      }
    }
    return false;
  }

  /**
   * Finish B5 without dispatching Report Designer for the fixed-preset debug
   * path.  The Markdown + quality artifacts remain available; this switch
   * intentionally does not create HTML, screenshots, or an html layout stamp.
   */
  function autoSkipB5DesignForFixedDebugSession(
    sid: string,
    ctx?: PiExtensionContext,
    { sendGateMessage = false }: { sendGateMessage?: boolean } = {}
  ): { handled: boolean; ok: boolean; text: string; sent: boolean } | null {
    if (!shouldSkipB5DesignForFixedDebugSession(sid)) return null;
    const before = readGateState(projectRoot, sid);
    if (
      before?.status !== "running" ||
      before.currentStage !== "B5_DESIGN" ||
      before.stages?.B5_DESIGN?.status !== "running"
    ) return null;

    const finished = runStageGate(projectRoot, sid, "finish", ["--stage", "B5_DESIGN"]);
    const after = finished.payload?.state || readGateState(projectRoot, sid);
    const complete = Boolean(
      finished.ok &&
      after?.status === "completed" &&
      after.currentStage === "B5_DESIGN" &&
      after.stages?.B5_DESIGN?.status === "completed"
    );
    const text = complete
      ? [
          "固定推荐调试模式：已自动跳过 B5 Report Designer。",
          "未生成 report.html、截图或 phase=html 布局签章；当前仅验收到 Markdown 报告与 B4 质量结果。",
          formatGateMessage(after, { stageId: "B5_DESIGN" }),
        ].join("\n")
      : `固定推荐调试模式无法自动跳过 B5 Report Designer：${finished.error || "stage-gate finish 未得到 completed 状态"}`;

    ctx?.ui?.notify?.(text, complete ? "info" : "error");
    let sent = false;
    if (complete && sendGateMessage && typeof pi.sendMessage === "function") {
      try {
        pi.sendMessage({
          customType: HTML_REPORT_GATE_CUSTOM_TYPE,
          content: text,
          display: true,
          details: {
            version: 1,
            producer: "qdm-harness",
            sessionId: sid,
            stageId: "B5_DESIGN",
            currentStage: "B5_DESIGN",
            pipelineStatus: "completed",
            stageStatus: "completed",
            debugB5Skipped: true,
            attempt: stageAttemptDetails(after, "B5_DESIGN"),
          },
        }, { triggerTurn: false });
        sent = true;
      } catch (error) {
        ctx?.ui?.notify?.(
          `B5 调试跳过已完成，但 Gate 消息写入失败：${error instanceof Error ? error.message : String(error)}`,
          "warning"
        );
      }
    }
    return { handled: true, ok: complete, text, sent };
  }

  function runtimeAgentListKey(sid: string, gateState: unknown): string | null {
    const identity = runtimeAgentListAttempt(gateState);
    return identity && sid && sid !== "unknown" ? `${sid}|${identity.attempt}` : null;
  }

  function successfulRuntimeAgentList(sid: string, gateState: unknown): boolean {
    const key = runtimeAgentListKey(sid, gateState);
    return Boolean(key && runtimeAgentLists.get(key)?.status === "passed");
  }

  function exactCurrentGateStatus(toolCall: PiToolCallEvent, sid: string, gateState: unknown): boolean {
    if (String(toolCall.toolName || "").toLowerCase() !== "bash") return false;
    const command = typeof toolCall.input?.command === "string" ? toolCall.input.command : "";
    const parsed = parseStandaloneStageGateCommand(command);
    const assignedSession = parsed?.options["--session-dir"];
    return Boolean(
      parsed?.operation === "status" &&
      typeof assignedSession === "string" &&
      resolve(assignedSession) === resolve(htmlReportSessionDir(projectRoot, sid)) &&
      runtimeAgentListAttempt(gateState)
    );
  }

  function runtimeAgentListPrerequisiteDecision(
    sid: string,
    gateState: unknown,
    toolCall: PiToolCallEvent
  ): { block: true; reason: string } | undefined {
    const identity = runtimeAgentListAttempt(gateState);
    if (!identity) return undefined;
    if (isExactRuntimeAgentList(toolCall) || exactCurrentGateStatus(toolCall, sid, gateState)) return undefined;
    if (successfulRuntimeAgentList(sid, gateState)) return undefined;
    const key = runtimeAgentListKey(sid, gateState);
    const record = key ? runtimeAgentLists.get(key) : null;
    const reason = record?.status === "failed"
      ? record.error || "runtime agent list 未通过"
      : record?.status === "inflight"
        ? "runtime agent list 尚未返回"
        : "尚未执行本阶段独立的 runtime agent list";
    return {
      block: true,
      reason: `html-report ${identity.stageId} 自动 runtime agent list 前置条件未满足：${reason}。父模型不得手工补跑 list；等待扩展完成或让当前 Gate 按确切原因失败。`,
    };
  }

  function failRuntimeAgentListStage(
    sid: string,
    record: RuntimeAgentListRecord,
    reason: string
  ): string {
    record.status = "failed";
    record.error = reason;
    runtimeAgentLists.set(record.key, record);
    const current = readGateState(projectRoot, sid);
    if (runtimeAgentListKey(sid, current) !== record.key) {
      return `runtime agent list 已失败，但迟到结果属于 ${record.attempt}，未修改当前 Gate：${reason}`;
    }
    const failed = runStageGate(projectRoot, sid, "fail", [
      "--stage",
      record.stageId,
      "--reason",
      reason,
    ]);
    return failed.ok && failed.payload?.state
      ? `${reason}\n${formatGateMessage(failed.payload.state, { stageId: record.stageId })}`
      : `${reason}\n无法自动 fail ${record.stageId}：${failed.error || "unknown stage-gate error"}`;
  }

  async function settleRuntimeAgentList(
    sid: string,
    record: RuntimeAgentListRecord,
    event: PiToolResultEvent,
    {
      persistTerminal,
    }: {
      persistTerminal?: (status: "passed" | "failed", error?: string) => void;
    } = {}
  ): Promise<{ isError: boolean; text: string }> {
    const persist = (status: "passed" | "failed", error?: string): string | null => {
      if (!persistTerminal) return null;
      try {
        persistTerminal(status, error);
        return null;
      } catch (cause) {
        return `runtime agent list audit 终态写入失败：${cause instanceof Error ? cause.message : String(cause)}`;
      }
    };
    if (runtimeAgentListKey(sid, readGateState(projectRoot, sid)) !== record.key) {
      const reason = `runtime agent list 结果迟到：${record.attempt} 已不是当前 Gate attempt`;
      record.observedAgents = runtimeAgentListObservedAgents(event);
      record.missingAgents = REQUIRED_REPORT_AGENTS.filter(
        (name) => !record.observedAgents?.includes(name)
      );
      record.status = "failed";
      record.error = reason;
      runtimeAgentLists.set(record.key, record);
      const auditError = persist("failed", reason);
      return { isError: true, text: auditError ? `${reason}\n${auditError}` : reason };
    }

    const inspected = inspectRuntimeAgentListResult(event);
    record.observedAgents = runtimeAgentListObservedAgents(event);
    record.missingAgents = inspected.missingAgents;
    if (!inspected.ok) {
      const reason = inspected.error || `${record.stageId} runtime agent list failed`;
      const auditError = persist("failed", reason);
      const terminalReason = auditError ? `${reason}; ${auditError}` : reason;
      return { isError: true, text: failRuntimeAgentListStage(sid, record, terminalReason) };
    }

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
        const auditError = persist("failed", reason);
        const terminalReason = auditError ? `${reason}; ${auditError}` : reason;
        return { isError: true, text: failRuntimeAgentListStage(sid, record, terminalReason) };
      }
    }

    const shouldFinish = record.stageId === "B0_PREFLIGHT" ||
      (record.stageId === "A_CONFIG" && fixedAConfigSessions.has(sid));
    const passAuditError = persist("passed");
    if (passAuditError) {
      return { isError: true, text: failRuntimeAgentListStage(sid, record, passAuditError) };
    }
    if (shouldFinish) {
      const finished = runStageGate(projectRoot, sid, "finish", ["--stage", record.stageId]);
      if (!finished.ok) {
        const reason = record.stageId === "B0_PREFLIGHT"
          ? `runtime list and phase-a layout passed but B0 finish failed: ${finished.error}`
          : `runtime list passed but fixed A_CONFIG finish failed: ${finished.error}`;
        const auditError = persist("failed", reason);
        const terminalReason = auditError ? `${reason}; ${auditError}` : reason;
        return { isError: true, text: failRuntimeAgentListStage(sid, record, terminalReason) };
      }
      if (record.stageId === "B0_PREFLIGHT") {
        // A successful B0 locks result.json for B2. Every failed B0 path above
        // returns before this point, keeping the editor available for correction.
        stopHtmlReportUi(projectRoot, sid);
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
    const continuation = record.stageId === "A_CONFIG" && !fixedAConfigSessions.has(sid)
      ? "；继续 A_CONFIG 的动态推荐工作"
      : "";
    return {
      isError: false,
      text: `${gateText}\nruntime agent list：passed（四个 report-* Agent 均存在）${deterministicAcceptance}${continuation}`,
    };
  }

  async function ensureAutomaticRuntimeAgentList(
    sid: string,
    gateState: unknown,
    ctx?: PiExtensionContext
  ): Promise<void> {
    const identity = runtimeAgentListAttempt(gateState);
    const key = runtimeAgentListKey(sid, gateState);
    if (!identity || !key) return;
    const remembered = runtimeAgentLists.get(key);
    if (remembered?.status === "passed" || remembered?.status === "failed") return;
    const pending = runtimeAgentListPromises.get(key);
    if (pending) return pending;
    if (remembered?.status === "inflight") {
      const reason = "检测到没有活动 Promise 的 runtime agent list inflight 记录；当前 attempt 已中断，禁止覆盖或重放";
      const text = failRuntimeAgentListStage(sid, remembered, reason);
      ctx?.ui?.notify?.(text, "error");
      return;
    }

    const run = (async (): Promise<void> => {
      const auditPath = runtimeAgentListAuditPath(projectRoot, sid, identity.stageId, identity.attempt);
      const auditDirectoryError = runtimeAgentListAuditDirectoryError(auditPath, identity.stageId);
      if (auditDirectoryError) {
        const record: RuntimeAgentListRecord = {
          key,
          sessionId: sid,
          stageId: identity.stageId,
          attempt: identity.attempt,
          toolCallId: "invalid-audit-directory",
          mechanism: "extension-event-bridge",
          status: "failed",
          missingAgents: [...REQUIRED_REPORT_AGENTS],
          error: auditDirectoryError,
        };
        const text = failRuntimeAgentListStage(sid, record, auditDirectoryError);
        ctx?.ui?.notify?.(text, "error");
        return;
      }
      if (existsSync(auditPath)) {
        let parsed: unknown;
        try {
          const auditInfo = lstatSync(auditPath);
          if (!auditInfo.isFile() || auditInfo.isSymbolicLink()) {
            throw new Error("runtime agent list audit must be a regular non-symlink file");
          }
          parsed = JSON.parse(readFileSync(auditPath, "utf8"));
        } catch (error) {
          parsed = { parseError: error instanceof Error ? error.message : String(error) };
        }
        const persisted = validatePersistedRuntimeAgentListAudit(parsed, {
          sessionId: sid,
          stageId: identity.stageId,
          attempt: identity.attempt,
        });
        if (persisted.ok) {
          const record: RuntimeAgentListRecord = {
            key,
            sessionId: sid,
            stageId: identity.stageId,
            attempt: identity.attempt,
            toolCallId: persisted.audit.requestId,
            mechanism: "extension-event-bridge",
            status: "inflight",
            observedAgents: [...persisted.audit.observed],
            missingAgents: [],
          };
          runtimeAgentLists.set(key, record);
          const persistedEvent: PiToolResultEvent = {
            toolCallId: persisted.audit.requestId,
            toolName: "subagent",
            input: { action: "list" },
            isError: false,
            content: [{ type: "text", text: persisted.audit.result?.text || "" }],
          };
          const settled = await settleRuntimeAgentList(sid, record, persistedEvent, {
            persistTerminal(status, error) {
              if (status === "passed") return;
              const endedAtMs = Date.now();
              const startedAtMs = Date.parse(persisted.audit.startedAt);
              const failedAudit = sealRuntimeAgentListAudit({
                version: 1,
                producer: "qdm-harness",
                mechanism: "extension-event-bridge",
                sessionId: sid,
                stageId: identity.stageId,
                attempt: identity.attempt,
                requestId: persisted.audit.requestId,
                status: "failed",
                required: [...REQUIRED_REPORT_AGENTS],
                observed: record.observedAgents || [],
                missing: record.missingAgents || [],
                startedAt: persisted.audit.startedAt,
                endedAt: new Date(endedAtMs).toISOString(),
                durationMs: Math.max(0, endedAtMs - startedAtMs),
                result: {
                  isError: false,
                  text: persisted.audit.result?.text || "",
                  sha256: sha256Text(persisted.audit.result?.text || ""),
                },
                error: error || "persisted runtime list acceptance failed",
              });
              writeRuntimeAgentListAudit(auditPath, failedAudit);
            },
          });
          ctx?.ui?.notify?.(
            settled.isError
              ? settled.text
              : `${identity.stageId} 已复用当前 attempt 的合法 runtime list audit，并完成确定性收尾。`,
            settled.isError ? "error" : "info"
          );
          return;
        }
        const record: RuntimeAgentListRecord = {
          key,
          sessionId: sid,
          stageId: identity.stageId,
          attempt: identity.attempt,
          toolCallId: "persisted-audit",
          mechanism: "extension-event-bridge",
          status: "failed",
          missingAgents: [...REQUIRED_REPORT_AGENTS],
          error: persisted.error,
        };
        const text = failRuntimeAgentListStage(
          sid,
          record,
          `拒绝重复 runtime list：${persisted.error}`
        );
        ctx?.ui?.notify?.(text, "error");
        return;
      }

      const requestId = randomUUID();
      const startedAtMs = Date.now();
      const startedAt = new Date(startedAtMs).toISOString();
      const record: RuntimeAgentListRecord = {
        key,
        sessionId: sid,
        stageId: identity.stageId,
        attempt: identity.attempt,
        toolCallId: requestId,
        mechanism: "extension-event-bridge",
        status: "inflight",
      };
      runtimeAgentLists.set(key, record);
      const emptyText = "";
      const inflightAudit = sealRuntimeAgentListAudit({
        version: 1,
        producer: "qdm-harness",
        mechanism: "extension-event-bridge",
        sessionId: sid,
        stageId: identity.stageId,
        attempt: identity.attempt,
        requestId,
        status: "inflight",
        required: [...REQUIRED_REPORT_AGENTS],
        observed: [],
        missing: [...REQUIRED_REPORT_AGENTS],
        startedAt,
        result: { isError: false, text: emptyText, sha256: sha256Text(emptyText) },
      });
      try {
        writeRuntimeAgentListAudit(auditPath, inflightAudit, { reserve: true });
      } catch (error) {
        const reason = `无法预留 runtime agent list audit：${error instanceof Error ? error.message : String(error)}`;
        const text = failRuntimeAgentListStage(sid, record, reason);
        ctx?.ui?.notify?.(text, "error");
        return;
      }

      let resultEvent: PiToolResultEvent;
      try {
        const response = await requestRuntimeAgentListViaEventBridge({
          events: pi.events,
          ctx,
          projectRoot,
          requestId,
        });
        resultEvent = response.event;
      } catch (error) {
        resultEvent = {
          toolCallId: requestId,
          toolName: "subagent",
          input: { action: "list" },
          isError: true,
          content: [{
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          }],
        };
      }

      const resultText = runtimeAgentListText(resultEvent);
      let terminalAudit: RuntimeAgentListAudit | null = null;
      const settled = await settleRuntimeAgentList(sid, record, resultEvent, {
        persistTerminal(status, error) {
          const endedAtMs = Date.now();
          const audit = sealRuntimeAgentListAudit({
            version: 1,
            producer: "qdm-harness",
            mechanism: "extension-event-bridge",
            sessionId: sid,
            stageId: identity.stageId,
            attempt: identity.attempt,
            requestId,
            status,
            required: [...REQUIRED_REPORT_AGENTS],
            observed: runtimeAgentListObservedAgents(resultEvent),
            missing: record.missingAgents || [...REQUIRED_REPORT_AGENTS],
            startedAt,
            endedAt: new Date(endedAtMs).toISOString(),
            durationMs: Math.max(0, endedAtMs - startedAtMs),
            result: {
              isError: resultEvent.isError === true,
              text: resultText,
              sha256: sha256Text(resultText),
            },
            ...(status === "failed" ? { error: error || "automatic runtime agent list failed" } : {}),
          });
          writeRuntimeAgentListAudit(auditPath, audit);
          terminalAudit = audit;
        },
      });
      ctx?.ui?.notify?.(
        settled.isError
          ? settled.text
          : `${identity.stageId} runtime agent list 已由扩展自动验收，耗时 ${terminalAudit?.durationMs ?? Date.now() - startedAtMs}ms。`,
        settled.isError ? "error" : "info"
      );
    })();
    runtimeAgentListPromises.set(key, run);
    try {
      await run;
    } finally {
      runtimeAgentListPromises.delete(key);
    }
  }

  function currentRuntimeFreshnessError(): string | null {
    if (staleRuntimeError) return staleRuntimeError;
    const changed = changedRuntimeSources(projectRoot, runtimeSourcesAtLoad);
    if (!changed.length) return null;
    staleRuntimeError = runtimeFreshnessError(changed);
    return staleRuntimeError;
  }

  function notifyRuntimeFreshness(
    sid: string,
    reason: string,
    ctx?: PiExtensionContext
  ): void {
    const knownSession = Boolean(sid && sid !== "unknown");
    if (knownSession && freshnessNotifiedSessions.has(sid)) return;
    if (knownSession) freshnessNotifiedSessions.add(sid);
    ctx?.ui?.notify?.(reason, "error");
  }

  function rememberStaleHtmlReportSession(sid: string): void {
    if (sid && sid !== "unknown") staleHtmlReportSessions.add(sid);
    else staleUnknownHtmlReportTurn = true;
  }

  function existingHtmlReportSession(sid: string): boolean {
    return Boolean(
      sid &&
      sid !== "unknown" &&
      inspectGateState(projectRoot, sid).kind !== "absent"
    );
  }

  function currentSessionRuntimeError(sid: string): string | null {
    if (!sid || sid === "unknown") return null;
    const latched = incompatibleSessionErrors.get(sid);
    if (latched) return latched;
    const error = sessionRuntimeContractError(projectRoot, sid, runtimeSourcesAtLoad);
    if (error) incompatibleSessionErrors.set(sid, error);
    return error;
  }

  function runtimeGuardError(sid: string): { reason: string; kind: "process" | "session" } | null {
    const processError = currentRuntimeFreshnessError();
    if (processError) return { reason: processError, kind: "process" };
    const sessionError = currentSessionRuntimeError(sid);
    return sessionError ? { reason: sessionError, kind: "session" } : null;
  }

  function gateAttemptToken(state: unknown): string | null {
    return gateAttemptTokenFromState(state);
  }

  function stageAttemptDetails(state: unknown, stageId: string): JsonObject | null {
    if (!isObject(state) || !isObject(state.stages)) return null;
    const stage = isObject(state.stages[stageId]) ? state.stages[stageId] : null;
    const attempts = stage && Array.isArray(stage.attempts) ? stage.attempts : [];
    const attempt = attempts.length && isObject(attempts.at(-1)) ? attempts.at(-1) : null;
    if (
      !attempt ||
      !Number.isSafeInteger(attempt.number) ||
      typeof attempt.startedAt !== "string" ||
      !attempt.startedAt
    ) return null;
    return { number: attempt.number, startedAt: attempt.startedAt };
  }

  /**
   * Run B0 deterministically from the A_CONFIG approval turn. A successful
   * preflight advances directly into B2 and keeps the same turn alive. Only a
   * failed or explicitly gated compatibility policy emits a persisted Gate.
   */
  async function handleDeterministicB0Approval(
    sid: string,
    before: unknown,
    afterApproval: unknown,
    ctx?: PiExtensionContext
  ): Promise<boolean> {
    if (
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
      runStageGate(projectRoot, sid, "fail", [
        "--stage",
        "B0_PREFLIGHT",
        "--reason",
        reason,
      ]);
    }
    let terminal = readGateState(projectRoot, sid);
    if (
      terminal?.mode === "step" &&
      terminal?.currentStage === "B0_PREFLIGHT" &&
      terminal?.status === "running"
    ) {
      const reason = "B0 扩展自动验收未产生 completed/failed 终态，已 fail closed；未启动 B2";
      const failed = runStageGate(projectRoot, sid, "fail", [
        "--stage",
        "B0_PREFLIGHT",
        "--reason",
        reason,
      ]);
      terminal = failed.payload?.state || readGateState(projectRoot, sid);
    }

    const stage = isObject(terminal?.stages?.B0_PREFLIGHT)
      ? terminal.stages.B0_PREFLIGHT
      : null;
    const advanced = Boolean(
      terminal &&
      terminal.currentStage !== "B0_PREFLIGHT" &&
      stage?.status === "completed" &&
      ["running", "completed"].includes(String(terminal.status))
    );
    if (advanced) {
      ctx?.ui?.notify?.("B0 预检通过，已自动进入 B2 Writer。", "info");
      return false;
    }

    const accepted = terminal?.status === "awaiting_approval" && stage?.status === "awaiting_approval";
    const rejected = terminal?.status === "failed" && stage?.status === "failed";
    if (!terminal || terminal.currentStage !== "B0_PREFLIGHT" || (!accepted && !rejected)) {
      ctx?.ui?.notify?.(
        "B0 确定性验收没有得到可继续或可显示的终态；保留父模型回显作为兼容回退。",
        "error"
      );
      return false;
    }
    if (typeof pi.sendMessage !== "function") return false;

    const gateText = formatGateMessage(terminal, { stageId: "B0_PREFLIGHT" });
    try {
      pi.sendMessage({
        customType: HTML_REPORT_GATE_CUSTOM_TYPE,
        content: gateText,
        display: true,
        details: {
          version: 1,
          producer: "qdm-harness",
          sessionId: sid,
          stageId: "B0_PREFLIGHT",
          currentStage: terminal.currentStage,
          pipelineStatus: terminal.status,
          stageStatus: stage.status,
          attempt: stageAttemptDetails(terminal, "B0_PREFLIGHT"),
        },
      }, { triggerTurn: false });
      return true;
    } catch (error) {
      ctx?.ui?.notify?.(
        `B0 确定性 Gate 消息写入失败：${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
      return false;
    }
  }

  function b2StartupStatusIdentity(
    sid: string,
    state: unknown
  ): { key: string; attempt: string } | null {
    if (!sid || sid === "unknown" || !isObject(state) || state.status !== "running" || state.currentStage !== "B2_WRITER") {
      return null;
    }
    const stages = isObject(state.stages) ? state.stages : null;
    const stage = stages && isObject(stages.B2_WRITER) ? stages.B2_WRITER : null;
    const attempts = stage && Array.isArray(stage.attempts) ? stage.attempts : [];
    const active = attempts.length && isObject(attempts.at(-1)) ? attempts.at(-1) : null;
    if (active?.startupStatusRequired !== true) return null;
    const attempt = gateAttemptToken(state);
    return attempt ? { key: `${sid}|${attempt}|startup-status`, attempt } : null;
  }

  function unavailableSiblingToolName(event: PiToolResultEvent): string | null {
    if (event.isError !== true) return null;
    const match = /^Tool (\S+) not found$/i.exec(contentText(event.content).trim());
    return match?.[1] || null;
  }

  /** Hide the red "Tool read not found" that Pi emits after B2 startup strips non-bash tools. */
  function quietB2StartupUnavailableTool(
    sid: string,
    state: unknown,
    event: PiToolResultEvent
  ): ToolResultPatch | undefined {
    const identity = b2StartupStatusIdentity(sid, state);
    if (!identity) return undefined;
    const record = b2StartupStatuses.get(identity.key);
    if (record?.phase === "failed") return undefined;
    const missing = unavailableSiblingToolName(event);
    if (!missing) return undefined;
    if (String(event.toolName || "").toLowerCase() === "bash") return undefined;
    return {
      isError: false,
      content: [{
        type: "text",
        text: `已忽略：B2 启动只允许 stage-gate status，${missing} 未执行。`,
      }],
    };
  }

  function exactB2StartupStatusCall(sid: string, event: PiToolCallEvent): boolean {
    if (String(event.toolName || "").toLowerCase() !== "bash") return false;
    const command = bashCommandIgnoringHostKeys(event.input);
    if (command === null) return false;
    const parsed = parseStandaloneStageGateCommand(command);
    return Boolean(
      parsed?.operation === "status" &&
      parsed.words?.[0] === "node" &&
      parsed.words?.[1] === stageGateScriptPath(projectRoot) &&
      parsed.options?.["--session-dir"] === htmlReportSessionDir(projectRoot, sid) &&
      parsed.options?.["--format"] === "text" &&
      Object.keys(parsed.options || {}).length === 2
    );
  }

  function restrictB2StartupTools(sid: string, state: unknown): void {
    const identity = b2StartupStatusIdentity(sid, state);
    if (!identity) return;
    const current = b2StartupStatuses.get(identity.key);
    if (current?.phase === "dispatched") return;
    if (
      typeof pi.getActiveTools !== "function" ||
      typeof pi.setActiveTools !== "function"
    ) return;
    const prefix = `${sid}|`;
    for (const [recordKey, record] of [...b2StartupStatuses.entries()]) {
      if (!recordKey.startsWith(prefix) || recordKey === identity.key) continue;
      if (record.toolCallId) b2StartupStatusCalls.delete(record.toolCallId);
      b2StartupStatuses.delete(recordKey);
      restoreB2StartupTools(recordKey);
    }
    if (!b2StartupToolSnapshots.has(identity.key)) {
      b2StartupToolSnapshots.set(identity.key, [...pi.getActiveTools()]);
    }
    if (current?.phase === "passed" && current.nextTool) {
      pi.setActiveTools([current.nextTool.toolName]);
      return;
    }
    if (current?.phase !== "passed") pi.setActiveTools(["bash"]);
  }

  function restoreB2StartupTools(identityKey: string): void {
    const snapshot = b2StartupToolSnapshots.get(identityKey);
    if (!snapshot) return;
    b2StartupToolSnapshots.delete(identityKey);
    pi.setActiveTools?.([...snapshot]);
  }

  function restoreB2StartupToolsForSession(sid: string): void {
    const prefix = `${sid}|`;
    for (const identityKey of [...b2StartupToolSnapshots.keys()]) {
      if (identityKey.startsWith(prefix)) restoreB2StartupTools(identityKey);
    }
  }

  function b25BootstrapIdentity(
    sid: string,
    state: unknown
  ): { key: string; attempt: string } | null {
    if (
      !sid ||
      sid === "unknown" ||
      !isObject(state) ||
      state.status !== "running" ||
      state.currentStage !== "B25_EDITOR"
    ) return null;
    const attempt = gateAttemptToken(state);
    return attempt ? { key: `${sid}|${attempt}|bootstrap`, attempt } : null;
  }

  function b25BootstrapCallKind(
    sid: string,
    state: unknown,
    event: PiToolCallEvent
  ): "status" | "source_fields" | null {
    if (!b25BootstrapIdentity(sid, state)) return null;
    if (String(event.toolName || "").toLowerCase() !== "bash") return null;
    const command = bashCommandIgnoringHostKeys(event.input);
    if (command === null) return null;
    const expected = b25EditorBootstrapContract(projectRoot, sid);
    if (command === expected.statusCommand) return "status";
    if (command === expected.sourceFieldsCommand) return "source_fields";
    return null;
  }

  function failB25Bootstrap(
    record: B25BootstrapRecord,
    reason: string
  ): string {
    const concise = `B25 bootstrap contract failed: ${reason}`.slice(0, 500);
    record.statusResult = record.statusResult === "passed" ? "passed" : "failed";
    record.sourceFieldsResult = record.sourceFieldsResult === "passed" ? "passed" : "failed";
    record.plannerStarted = true;
    b25Bootstraps.set(record.key, record);
    const failed = runStageGate(projectRoot, record.sessionId, "fail", [
      "--stage",
      "B25_EDITOR",
      "--reason",
      concise,
    ]);
    return failed.ok
      ? `${concise}；当前 attempt 已终止，只能由用户“重试当前阶段”。`
      : `${concise}；且自动 fail B25_EDITOR 失败：${failed.error || "unknown error"}`;
  }

  function b25BootstrapToolDecision(
    sid: string,
    state: unknown,
    event: PiToolCallEvent
  ): { block: true; reason: string } | undefined {
    const identity = b25BootstrapIdentity(sid, state);
    if (!identity) return undefined;
    const kind = b25BootstrapCallKind(sid, state, event);
    const existing = b25Bootstraps.get(identity.key);
    if (!kind) {
      if (existing && isSubagentToolName(event.toolName)) {
        return {
          block: true,
          reason: failB25Bootstrap(
            existing,
            "status + source-fields 已进入扩展自动接棒；父模型禁止手工派发或重复 Editor Planner"
          ),
        };
      }
      return undefined;
    }
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    if (!toolCallId) {
      const record = existing || {
        key: identity.key,
        sessionId: sid,
        attempt: identity.attempt,
        statusResult: "pending",
        sourceFieldsResult: "pending",
        plannerStarted: false,
      } as B25BootstrapRecord;
      return { block: true, reason: failB25Bootstrap(record, `${kind} 缺少 toolCallId`) };
    }
    const field = kind === "status" ? "statusToolCallId" : "sourceFieldsToolCallId";
    const record = existing || {
      key: identity.key,
      sessionId: sid,
      attempt: identity.attempt,
      statusResult: "pending",
      sourceFieldsResult: "pending",
      plannerStarted: false,
    } as B25BootstrapRecord;
    if (record[field]) {
      return { block: true, reason: failB25Bootstrap(record, `${kind} 在同一 Gate attempt 重复调用`) };
    }
    record[field] = toolCallId;
    b25Bootstraps.set(identity.key, record);
    b25BootstrapCalls.set(toolCallId, { key: identity.key, kind });
    return undefined;
  }

  function resetB25BootstrapForSession(sid: string): void {
    const prefix = `${sid}|`;
    for (const [key, record] of [...b25Bootstraps.entries()]) {
      if (!key.startsWith(prefix)) continue;
      if (record.statusToolCallId) b25BootstrapCalls.delete(record.statusToolCallId);
      if (record.sourceFieldsToolCallId) b25BootstrapCalls.delete(record.sourceFieldsToolCallId);
      b25Bootstraps.delete(key);
    }
  }

  function settleResearcherContractEvent(
    sid: string,
    contractEvent: PiToolResultEvent,
    dispatchIdentity: ContractDispatchIdentity | null,
    runtimeTimeout: string | null
  ): ToolResultPatch | undefined {
    const researcherDecision = reportResearcherResultDecision(
      contractEvent,
      projectRoot,
      sid
    );
    if (!researcherDecision) return undefined;
    const details = isObject(contractEvent.details) ? contractEvent.details : null;
    const results = Array.isArray(details?.results) ? details.results : [];
    const result = results.length === 1 && isObject(results[0]) ? results[0] : null;
    const output = result && isObject(result.structuredOutput)
      ? result.structuredOutput
      : null;
    const status = output ? String(output.status || "completed") : "";
    const successorNeedsUnresolved =
      researcherDecision.isError !== true &&
      (status === "needs_evidence_plan" || status === "needs_new_query") &&
      dispatchIdentity?.role === "report-researcher" &&
      isResearcherTaskSuccessorDispatch(projectRoot, dispatchIdentity);
    if (researcherDecision.isError !== true && output) {
      markContractTerminal(dispatchIdentity, `结构化 status=${status} 已验收`);
      if (dispatchIdentity && !successorNeedsUnresolved) {
        authorizeResearcherTaskSuccessor(projectRoot, dispatchIdentity, status, output.evidenceGap);
      }
    }
    const parentFailureCode: ResearcherParentFailureCode | null = runtimeTimeout
      ? "runtime_timeout"
      : researcherDecision.isError === true
        ? (!result || result.exitCode !== 0 || !("structuredOutput" in result)
            ? "missing_structured_output"
            : "invalid_return_or_artifacts")
        : successorNeedsUnresolved
          ? "invalid_return_or_artifacts"
          : output?.status === "failed"
            ? "structured_status_failed"
            : null;
    if (
      parentFailureCode &&
      dispatchIdentity?.role === "report-researcher" &&
      dispatchIdentity.attempt
    ) {
      const terminal = persistResearcherParentTerminal(
        projectRoot,
        sid,
        dispatchIdentity.attempt,
        parentFailureCode
      );
      researcherParentTerminals.set(sid, terminal);
      return {
        ...researcherDecision,
        ...(successorNeedsUnresolved ? { isError: true } : {}),
        content: [
          ...(researcherDecision.content || []),
          ...(successorNeedsUnresolved
            ? [{ type: "text", text: `B3 Report Researcher successor 再次返回 status=${status}；一次修复机会已用完，禁止第三次派发。` }]
            : []),
          { type: "text", text: researcherParentFailureText(terminal) },
        ],
      };
    }
    return researcherDecision;
  }

  function rejectInitialResearcherBridge(
    sid: string,
    identity: ContractDispatchIdentity | null,
    reason: string,
    failureCode: ResearcherParentFailureCode = "invalid_return_or_artifacts"
  ): ToolResultPatch {
    markContractTerminal(identity, reason);
    const attempt = identity?.role === "report-researcher"
      ? identity.attempt
      : gateAttemptToken(readGateState(projectRoot, sid));
    if (!attempt) {
      return {
        isError: true,
        content: [{ type: "text", text: `B3 initial Researcher bridge failed: ${reason}` }],
      };
    }
    const terminal = persistResearcherParentTerminal(
      projectRoot,
      sid,
      attempt,
      failureCode
    );
    researcherParentTerminals.set(sid, terminal);
    return {
      isError: true,
      content: [
        { type: "text", text: `B3 initial Researcher bridge failed: ${reason}` },
        { type: "text", text: researcherParentFailureText(terminal) },
      ],
    };
  }

  async function dispatchInitialResearcherViaBridge(
    sid: string,
    nextTool: DeterministicNextTool,
    ctx?: PiExtensionContext
  ): Promise<ToolResultPatch & { bridgeDetails?: JsonObject }> {
    const current = readGateState(projectRoot, sid);
    if (
      nextTool.toolName !== "subagent" ||
      !isObject(current) ||
      current.status !== "running" ||
      current.currentStage !== "B3_RESEARCH"
    ) {
      return rejectInitialResearcherBridge(
        sid,
        null,
        "Planner handoff is not one current B3 subagent call"
      );
    }
    const input = JSON.parse(JSON.stringify(nextTool.input)) as JsonObject;
    const schema = attachResearcherOutputSchema(input, { projectRoot, session: sid });
    if (schema.error) {
      return rejectInitialResearcherBridge(
        sid,
        null,
        `Researcher schema attachment failed: ${schema.error}`
      );
    }
    const stageDecision = runningGateSubagentDecision(current, {
      toolName: "subagent",
      input,
    });
    if (stageDecision) {
      return rejectInitialResearcherBridge(sid, null, stageDecision.reason);
    }
    const dispatchIdentity = contractDispatchIdentity(input, sid, current);
    if (!dispatchIdentity || dispatchIdentity.role !== "report-researcher") {
      return rejectInitialResearcherBridge(
        sid,
        dispatchIdentity,
        "无法建立唯一 initial Researcher 派发身份"
      );
    }
    const snapshot = contractInputSnapshot(input);
    const requestId = randomUUID();
    const dispatchError = registerContractDispatch(dispatchIdentity, "extension-event-bridge");
    if (dispatchError) {
      return rejectInitialResearcherBridge(sid, dispatchIdentity, dispatchError);
    }
    inFlightContractCalls.set(requestId, {
      toolCallId: requestId,
      sessionId: sid,
      identity: dispatchIdentity,
      inputFingerprint: snapshot.fingerprint,
      input: snapshot.input,
    });

    const startedAtMs = Date.now();
    let bridgeEvent: PiToolResultEvent;
    try {
      const maxRuntimeMs = Number(snapshot.input.maxRuntimeMs);
      const timeoutMs = Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0
        ? maxRuntimeMs + 5_000
        : 725_000;
      const response = await requestSubagentViaEventBridge({
        events: pi.events,
        ctx,
        projectRoot,
        params: snapshot.input,
        requestId,
        timeoutMs,
        label: "B3 initial Report Researcher",
      });
      bridgeEvent = response.event;
    } catch (error) {
      bridgeEvent = {
        toolCallId: requestId,
        toolName: "subagent",
        input: snapshot.input,
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        details: { mode: "chain", results: [] },
      };
    }
    const endedAtMs = Date.now();
    const bridgeDetails: JsonObject = {
      version: 1,
      producer: "qdm-harness",
      mechanism: "extension-event-bridge",
      sessionId: sid,
      attempt: dispatchIdentity.attempt,
      stageId: "B3_RESEARCH",
      role: "report-researcher",
      agent: "report-researcher",
      requestId,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      isError: bridgeEvent.isError === true,
      resultDetails: bridgeEvent.details,
    };

    const consumed = consumeContractResult(
      bridgeEvent,
      sid,
      readGateState(projectRoot, sid)
    );
    if (!consumed || "error" in consumed) {
      const reason = consumed && "error" in consumed
        ? contentText(consumed.error.content)
        : "initial Researcher bridge result 无法绑定持久派发";
      return {
        ...rejectInitialResearcherBridge(sid, dispatchIdentity, reason),
        bridgeDetails,
      };
    }
    const runtimeTimeout = contractRuntimeTimeoutReason(consumed.event);
    if (runtimeTimeout) {
      markContractTerminal(dispatchIdentity, `子代理运行超时：${runtimeTimeout}`);
    }
    const decision = settleResearcherContractEvent(
      sid,
      consumed.event,
      dispatchIdentity,
      runtimeTimeout
    );
    if (!decision) {
      return {
        ...rejectInitialResearcherBridge(
          sid,
          dispatchIdentity,
          "initial Researcher bridge result 未进入 typed result decision"
        ),
        bridgeDetails,
      };
    }
    return { ...decision, bridgeDetails };
  }

  async function dispatchEditorPlannerViaBridge(
    sid: string,
    record: B25BootstrapRecord,
    ctx?: PiExtensionContext
  ): Promise<ToolResultPatch & { bridgeDetails?: JsonObject; researcherBridgeDetails?: JsonObject }> {
    const current = readGateState(projectRoot, sid);
    const currentIdentity = b25BootstrapIdentity(sid, current);
    if (!currentIdentity || currentIdentity.key !== record.key) {
      return {
        isError: true,
        content: [{ type: "text", text: "B25 bootstrap 结果已迟到；当前 Gate attempt 未派发 Planner。" }],
      };
    }

    const input = JSON.parse(JSON.stringify(b25EditorBootstrapContract(projectRoot, sid).plannerInput)) as JsonObject;
    const schema = attachEditorPlannerOutputSchema(input, { projectRoot, session: sid });
    if (schema.error) {
      return {
        isError: true,
        content: [{ type: "text", text: failB25Bootstrap(record, `Planner schema attachment failed: ${schema.error}`) }],
      };
    }
    const stageDecision = runningGateSubagentDecision(current, { toolName: "subagent", input });
    if (stageDecision) {
      return {
        isError: true,
        content: [{ type: "text", text: failB25Bootstrap(record, stageDecision.reason) }],
      };
    }
    const dispatchIdentity = contractDispatchIdentity(input, sid, current);
    if (!dispatchIdentity || dispatchIdentity.role !== "report-editor-planner") {
      return {
        isError: true,
        content: [{ type: "text", text: failB25Bootstrap(record, "无法建立唯一 Editor Planner 派发身份") }],
      };
    }
    const snapshot = contractInputSnapshot(input);
    const requestId = randomUUID();
    const dispatchError = registerContractDispatch(dispatchIdentity, "extension-event-bridge");
    if (dispatchError) {
      return {
        isError: true,
        content: [{ type: "text", text: failB25Bootstrap(record, dispatchError) }],
      };
    }
    inFlightContractCalls.set(requestId, {
      toolCallId: requestId,
      sessionId: sid,
      identity: dispatchIdentity,
      inputFingerprint: snapshot.fingerprint,
      input: snapshot.input,
    });

    const startedAtMs = Date.now();
    let bridgeEvent: PiToolResultEvent;
    try {
      const response = await requestSubagentViaEventBridge({
        events: pi.events,
        ctx,
        projectRoot,
        params: snapshot.input,
        requestId,
        timeoutMs: EDITOR_PLANNER_BRIDGE_TIMEOUT_MS,
        label: "B2.5 Editor Planner",
      });
      bridgeEvent = response.event;
    } catch (error) {
      bridgeEvent = {
        toolCallId: requestId,
        toolName: "subagent",
        input: snapshot.input,
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        details: { mode: "chain", results: [] },
      };
    }
    const endedAtMs = Date.now();
    const bridgeDetails: JsonObject = {
      version: 1,
      producer: "qdm-harness",
      mechanism: "extension-event-bridge",
      sessionId: sid,
      attempt: record.attempt,
      stageId: "B25_EDITOR",
      role: "report-editor-planner",
      agent: "report-researcher",
      requestId,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      isError: bridgeEvent.isError === true,
      resultDetails: bridgeEvent.details,
    };

    const consumed = consumeContractResult(bridgeEvent, sid, readGateState(projectRoot, sid));
    if (!consumed || "error" in consumed) {
      const reason = consumed && "error" in consumed
        ? contentText(consumed.error.content)
        : "Editor Planner bridge result 无法绑定持久派发";
      markContractTerminal(dispatchIdentity, reason);
      return {
        isError: true,
        content: [{ type: "text", text: failB25Bootstrap(record, reason) }],
        bridgeDetails,
      };
    }
    const runtimeTimeout = contractRuntimeTimeoutReason(consumed.event);
    const decision = await reportEditorPlannerResultDecision(
      consumed.event,
      projectRoot,
      sid,
      { autoDispatchFirstResearcher: true }
    );
    if (!decision) {
      const reason = "Editor Planner bridge result 未进入 typed result decision";
      markContractTerminal(dispatchIdentity, reason);
      return {
        isError: true,
        content: [{ type: "text", text: failB25Bootstrap(record, reason) }],
        bridgeDetails,
      };
    }
    const terminalReason = decision.isError === true
      ? runtimeTimeout
        ? `子代理运行超时：${runtimeTimeout}`
        : "Planner 返回、materialize 或 B25 自动收尾未通过"
      : "typed semantic plan 已验收并自动完成 B25";
    markContractTerminal(dispatchIdentity, terminalReason);
    const { nextTool, ...resultPatch } = decision;
    if (decision.isError !== true && nextTool) {
      if (nextTool.toolName === "subagent") {
        const researcher = await dispatchInitialResearcherViaBridge(sid, nextTool, ctx);
        return {
          isError: researcher.isError === true,
          content: [...(resultPatch.content || []), ...(researcher.content || [])],
          details: researcher.details,
          bridgeDetails,
          researcherBridgeDetails: researcher.bridgeDetails,
        };
      }
      restrictB3HandoffTools(sid, readGateState(projectRoot, sid), nextTool);
    }
    return { ...resultPatch, bridgeDetails };
  }

  async function settleB25BootstrapResult(
    sid: string,
    state: unknown,
    event: PiToolResultEvent,
    ctx?: PiExtensionContext
  ): Promise<ToolResultPatch | undefined> {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    const binding = toolCallId ? b25BootstrapCalls.get(toolCallId) : undefined;
    if (!binding) return undefined;
    b25BootstrapCalls.delete(toolCallId);
    const record = b25Bootstraps.get(binding.key);
    const current = b25BootstrapIdentity(sid, state);
    if (!record || !current || current.key !== record.key) {
      return {
        isError: true,
        content: [{ type: "text", text: "B25 bootstrap 的迟到 tool_result 已忽略；当前 Gate attempt 未变更。" }],
      };
    }
    const expected = b25EditorBootstrapContract(projectRoot, sid);
    const expectedInput = {
      command: binding.kind === "status" ? expected.statusCommand : expected.sourceFieldsCommand,
    };
    const expectedCallId = binding.kind === "status"
      ? record.statusToolCallId
      : record.sourceFieldsToolCallId;
    if (expectedCallId !== toolCallId || !sameCanonicalJson(event.input, expectedInput)) {
      return {
        isError: true,
        content: [{ type: "text", text: failB25Bootstrap(record, `${binding.kind} tool_result 无法绑定精确输入`) }],
      };
    }
    if (event.isError === true) {
      const reason = `${binding.kind} 执行失败：${contentText(event.content) || "unknown error"}`;
      return {
        isError: true,
        content: [{ type: "text", text: failB25Bootstrap(record, reason) }],
      };
    }
    if (binding.kind === "source_fields") {
      let inventory: unknown;
      try {
        inventory = JSON.parse(contentText(event.content));
      } catch {
        inventory = null;
      }
      if (
        !isObject(inventory) ||
        inventory.ok !== true ||
        inventory.version !== 1 ||
        inventory.producer !== "prepare-research-evidence.mjs" ||
        inventory.mode !== "source_fields" ||
        !Array.isArray(inventory.sources)
      ) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: failB25Bootstrap(
              record,
              "source_fields 必须返回 ok=true、version=1、producer=prepare-research-evidence.mjs、mode=source_fields 与 sources[]"
            ),
          }],
        };
      }
    }
    if (binding.kind === "status") record.statusResult = "passed";
    else record.sourceFieldsResult = "passed";
    b25Bootstraps.set(record.key, record);
    if (
      record.statusResult !== "passed" ||
      record.sourceFieldsResult !== "passed" ||
      record.plannerStarted
    ) {
      return {
        isError: false,
        content: [
          ...(event.content || []),
          {
            type: "text",
            text: `B25 ${binding.kind} 已验证；等待另一个固定 bootstrap 结果后由扩展自动派发 Planner。`,
          },
        ],
      };
    }
    record.plannerStarted = true;
    b25Bootstraps.set(record.key, record);
    const planner = await dispatchEditorPlannerViaBridge(sid, record, ctx);
    const bridgeDetails = planner.bridgeDetails;
    const researcherBridgeDetails = planner.researcherBridgeDetails;
    return {
      isError: planner.isError === true,
      content: [...(event.content || []), ...(planner.content || [])],
      details: bridgeDetails || researcherBridgeDetails
        ? {
            ...(bridgeDetails ? { qdmHarnessAutoSubagent: bridgeDetails } : {}),
            ...(researcherBridgeDetails
              ? { qdmHarnessAutoResearcher: researcherBridgeDetails }
              : {}),
          }
        : event.details,
    };
  }

  function b3HandoffKey(sid: string, state: unknown): string | null {
    if (
      !sid ||
      sid === "unknown" ||
      !isObject(state) ||
      state.status !== "running" ||
      state.currentStage !== "B3_RESEARCH"
    ) return null;
    const attempt = gateAttemptToken(state);
    return attempt ? `${sid}|${attempt}|initial-handoff` : null;
  }

  function restoreB3HandoffTools(key: string): void {
    const snapshot = b3HandoffToolSnapshots.get(key);
    b3HandoffTools.delete(key);
    if (!snapshot) return;
    b3HandoffToolSnapshots.delete(key);
    pi.setActiveTools?.([...snapshot]);
  }

  function restoreB3HandoffToolsForSession(sid: string): void {
    const prefix = `${sid}|`;
    for (const key of new Set([
      ...b3HandoffTools.keys(),
      ...b3HandoffToolSnapshots.keys(),
    ])) {
      if (key.startsWith(prefix)) restoreB3HandoffTools(key);
    }
  }

  function restrictB3HandoffTools(
    sid: string,
    state: unknown,
    nextTool: DeterministicNextTool
  ): void {
    const key = b3HandoffKey(sid, state);
    const attempt = gateAttemptToken(state);
    if (!key || !attempt) return;
    restoreB3HandoffToolsForSession(sid);
    b3HandoffTools.set(key, {
      ...nextTool,
      key,
      sessionId: sid,
      attempt,
    });
    if (
      typeof pi.getActiveTools !== "function" ||
      typeof pi.setActiveTools !== "function"
    ) return;
    b3HandoffToolSnapshots.set(key, [...pi.getActiveTools()]);
    pi.setActiveTools([nextTool.toolName]);
  }

  function b3HandoffToolDecision(
    sid: string,
    state: unknown,
    event: PiToolCallEvent
  ): { block: true; reason: string } | undefined {
    const currentKey = b3HandoffKey(sid, state);
    for (const record of [...b3HandoffTools.values()]) {
      if (record.sessionId === sid && record.key !== currentKey) {
        restoreB3HandoffTools(record.key);
      }
    }
    if (!currentKey) return undefined;
    const record = b3HandoffTools.get(currentKey);
    if (!record) return undefined;
    const actualName = String(event.toolName || "").toLowerCase();
    const expectedName = record.toolName.toLowerCase();
    if (actualName === expectedName && sameCanonicalJson(event.input, record.input)) {
      restoreB3HandoffTools(currentKey);
      return undefined;
    }
    return {
      block: true,
      reason: [
        "B2.5 已生成确定性的 B3 首个工具调用；接棒完成前禁止其他工具或参数漂移。",
        `唯一允许调用：${record.invocation}`,
      ].join(" "),
    };
  }

  function b2WriterQueueKey(sid: string, state: unknown): string | null {
    if (
      !sid ||
      sid === "unknown" ||
      !isObject(state) ||
      state.status !== "running" ||
      state.currentStage !== "B2_WRITER"
    ) return null;
    const attempt = gateAttemptToken(state);
    return attempt ? `${sid}|${attempt}|writer-queue` : null;
  }

  function restoreB2WriterQueueTools(key: string): void {
    const snapshot = b2WriterQueueToolSnapshots.get(key);
    b2WriterQueueTools.delete(key);
    if (!snapshot) return;
    b2WriterQueueToolSnapshots.delete(key);
    pi.setActiveTools?.([...snapshot]);
  }

  function restoreB2WriterQueueToolsForSession(sid: string): void {
    const prefix = `${sid}|`;
    for (const key of new Set([
      ...b2WriterQueueTools.keys(),
      ...b2WriterQueueToolSnapshots.keys(),
    ])) {
      if (key.startsWith(prefix)) restoreB2WriterQueueTools(key);
    }
  }

  function restrictB2WriterQueueTools(
    sid: string,
    state: unknown,
    nextTool: DeterministicNextTool
  ): void {
    const key = b2WriterQueueKey(sid, state);
    const attempt = gateAttemptToken(state);
    if (!key || !attempt) return;
    restoreB2WriterQueueToolsForSession(sid);
    b2WriterQueueTools.set(key, {
      ...nextTool,
      key,
      sessionId: sid,
      attempt,
    });
    if (
      typeof pi.getActiveTools !== "function" ||
      typeof pi.setActiveTools !== "function"
    ) return;
    b2WriterQueueToolSnapshots.set(key, [...pi.getActiveTools()]);
    pi.setActiveTools([nextTool.toolName]);
  }

  function b2WriterQueueToolDecision(
    sid: string,
    state: unknown,
    event: PiToolCallEvent
  ): { block: true; reason: string } | undefined {
    const currentKey = b2WriterQueueKey(sid, state);
    for (const record of [...b2WriterQueueTools.values()]) {
      if (record.sessionId === sid && record.key !== currentKey) {
        restoreB2WriterQueueTools(record.key);
      }
    }
    if (!currentKey) return undefined;
    const record = b2WriterQueueTools.get(currentKey);
    if (!record) return undefined;
    const actualName = String(event.toolName || "").toLowerCase();
    const expectedName = record.toolName.toLowerCase();
    if (actualName === expectedName && sameCanonicalJson(event.input, record.input)) {
      restoreB2WriterQueueTools(currentKey);
      return undefined;
    }
    return {
      block: true,
      reason: [
        "B2 已验收当前 Writer；下一张接棒完成前禁止其他工具或参数漂移。",
        `唯一允许调用：${record.invocation}`,
      ].join(" "),
    };
  }

  async function settleB2WriterQueueStatus(
    sid: string,
    state: unknown,
    event: PiToolResultEvent
  ): Promise<ToolResultPatch | undefined> {
    if (event.isError === true) return undefined;
    if (!exactB2StartupStatusCall(sid, event as unknown as PiToolCallEvent)) return undefined;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    if (toolCallId && b2StartupStatusCalls.has(toolCallId)) return undefined;
    if (
      !isObject(state) ||
      state.status !== "running" ||
      state.currentStage !== "B2_WRITER"
    ) return undefined;
    const remaining = await remainingWriterCardIds(projectRoot, sid);
    if (!remaining.length) return undefined;
    const nextTool = writerNextTool(htmlReportSessionDir(projectRoot, sid), remaining[0]);
    restrictB2WriterQueueTools(sid, state, nextTool);
    return {
      isError: false,
      content: [
        ...(event.content || []),
        { type: "text", text: writerQueueHandoffText(nextTool, remaining) },
      ],
    };
  }

  function b3AttemptToken(state: unknown): string | null {
    if (!isObject(state) || state.currentStage !== "B3_RESEARCH") return null;
    const details = stageAttemptDetails(state, "B3_RESEARCH");
    return details
      ? `B3_RESEARCH:${String(details.number)}:${String(details.startedAt)}`
      : null;
  }

  function failB3FinalizerAttempt(sid: string, reason: string): string {
    const concise = String(reason || "B3 finalizer contract failure").slice(0, 500);
    const state = readGateState(projectRoot, sid);
    if (
      state?.currentStage === "B3_RESEARCH" &&
      ["running", "paused"].includes(String(state.status))
    ) {
      const failed = runStageGate(projectRoot, sid, "fail", [
        "--stage",
        "B3_RESEARCH",
        "--reason",
        concise,
      ]);
      if (!failed.ok) {
        return `${concise}\n扩展无法自动 fail B3_RESEARCH：${failed.error || "unknown stage-gate error"}`;
      }
    }
    const latest = readGateState(projectRoot, sid);
    return latest
      ? `${concise}\n${formatGateMessage(latest, { stageId: "B3_RESEARCH" })}`
      : concise;
  }

  function b3FinalizerToolDecision(
    sid: string,
    state: unknown,
    event: PiToolCallEvent
  ): { block: true; reason: string } | undefined {
    if (
      !sid ||
      sid === "unknown" ||
      !isObject(state) ||
      state.status !== "running" ||
      state.currentStage !== "B3_RESEARCH" ||
      String(event.toolName || "").toLowerCase() !== "bash"
    ) return undefined;

    const command = typeof event.input?.command === "string" ? event.input.command : "";
    const parsedGate = parseStandaloneStageGateCommand(command);
    if (parsedGate?.operation === "finish") {
      return {
        block: true,
        reason: "B3_RESEARCH 只能在精确 finalizer 成功后由 qdm-harness 自动 finish；父代理禁止手工或重复 stage-gate finish。",
      };
    }
    if (!/finalize-research-stage\.mjs/.test(command)) return undefined;

    const contract = researchFinalizerContract(projectRoot, sid);
    if (!sameCanonicalJson(event.input, contract.input)) {
      return {
        block: true,
        reason: [
          "B3 finalizer 必须是扩展给出的精确独立调用，禁止改写路径、参数或追加命令。",
          `唯一允许调用：bash(${JSON.stringify(contract.input)})`,
        ].join(" "),
      };
    }
    const attempt = b3AttemptToken(state);
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    if (!attempt || !toolCallId) {
      const reason = failB3FinalizerAttempt(
        sid,
        "B3 finalizer 缺少可绑定的 Gate attempt 或 toolCallId；为避免无身份重放已失败当前阶段。"
      );
      return { block: true, reason };
    }
    if (
      b3FinalizersInFlight.has(toolCallId) ||
      settledB3FinalizerToolCalls.has(toolCallId)
    ) {
      return {
        block: true,
        reason: `B3 finalizer toolCallId=${toolCallId} 已被使用；重复或重放调用已阻止。`,
      };
    }
    const reserved = reserveB3Finalizer(projectRoot, sid, attempt, toolCallId);
    if (!reserved.reservation) {
      const reason = failB3FinalizerAttempt(
        sid,
        `${reserved.error || "B3 finalizer 持久预留失败"} 为避免重复执行，当前 Gate attempt 已确定性失败。`
      );
      return { block: true, reason };
    }
    b3FinalizersInFlight.set(toolCallId, {
      toolCallId,
      sessionId: sid,
      attempt,
      input: contract.input,
    });
    finishingSessions.add(sid);
    return undefined;
  }

  function settleB3FinalizerResult(
    sid: string,
    state: unknown,
    event: PiToolResultEvent,
    ctx?: PiExtensionContext
  ): ToolResultPatch | undefined {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    const remembered = toolCallId ? b3FinalizersInFlight.get(toolCallId) : undefined;
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    const looksLikeFinalizer =
      String(event.toolName || "").toLowerCase() === "bash" &&
      /finalize-research-stage\.mjs/.test(command);
    if (!remembered && !looksLikeFinalizer) return undefined;

    const attempt = remembered?.attempt || b3AttemptToken(state);
    const inspected = attempt
      ? readB3FinalizerReservation(projectRoot, sid, attempt)
      : { error: "B3 finalizer tool_result 无法绑定当前 Gate attempt" };
    const reservation = inspected.reservation;
    b3FinalizersInFlight.delete(toolCallId);
    finishingSessions.delete(sid);

    if (toolCallId && settledB3FinalizerToolCalls.has(toolCallId)) {
      return {
        isError: true,
        content: [{ type: "text", text: `B3 finalizer toolCallId=${toolCallId} 已结算；重复或重放结果已阻止。` }],
      };
    }
    if (toolCallId) settledB3FinalizerToolCalls.add(toolCallId);

    const contract = researchFinalizerContract(projectRoot, sid);
    const currentAttempt = b3AttemptToken(state);
    const bindingError = inspected.error ||
      (!reservation ? "缺少 B3 finalizer 持久预留" : null) ||
      (!toolCallId ? "B3 finalizer tool_result 缺少 toolCallId" : null) ||
      (reservation?.toolCallId !== toolCallId
        ? `B3 finalizer toolCallId 不匹配：expected=${reservation?.toolCallId || "<missing>"} actual=${toolCallId || "<missing>"}`
        : null) ||
      (remembered && (
        remembered.sessionId !== sid ||
        remembered.attempt !== reservation?.attempt ||
        remembered.toolCallId !== toolCallId ||
        !sameCanonicalJson(remembered.input, contract.input)
      )
        ? "B3 finalizer 内存派发身份与持久预留不一致"
        : null) ||
      (!sameCanonicalJson(event.input, contract.input)
        ? "B3 finalizer tool_result 输入与精确获准命令不一致"
        : null) ||
      (reservation && currentAttempt !== reservation.attempt
        ? `B3 finalizer tool_result 不属于当前 Gate attempt：expected=${reservation.attempt} actual=${currentAttempt || "<missing>"}`
        : null);
    if (bindingError) {
      const text = failB3FinalizerAttempt(
        sid,
        `B3 finalizer result binding failed: ${bindingError}`
      );
      if (reservation) persistB3FinalizerSettlement(projectRoot, reservation, "failed", bindingError);
      return {
        isError: true,
        content: [...(event.content || []), { type: "text", text }],
        details: event.details,
      };
    }

    const details = isObject(event.details) ? event.details : null;
    const exitCode = typeof details?.exitCode === "number" ? details.exitCode : null;
    const finalizerSucceeded = event.isError !== true && (exitCode === null || exitCode === 0);
    if (!finalizerSucceeded) {
      const output = contentText(event.content).replace(/\s+/g, " ").trim().slice(0, 300);
      const reason = `B3 finalizer execution failed${output ? `: ${output}` : ""}`;
      const text = failB3FinalizerAttempt(sid, reason);
      persistB3FinalizerSettlement(projectRoot, reservation!, "failed", reason);
      ctx?.ui?.notify?.(text, "warning");
      return {
        isError: true,
        content: [...(event.content || []), { type: "text", text }],
        details: event.details,
      };
    }

    const finished = runStageGate(projectRoot, sid, "finish", ["--stage", "B3_RESEARCH"]);
    if (!finished.ok) {
      const reason = `B3 finalizer succeeded but automatic stage finish failed: ${finished.error || "unknown stage-gate error"}`;
      const text = failB3FinalizerAttempt(sid, reason);
      persistB3FinalizerSettlement(projectRoot, reservation!, "failed", reason);
      ctx?.ui?.notify?.(text, "error");
      return {
        isError: true,
        content: [...(event.content || []), { type: "text", text }],
        details: event.details,
      };
    }

    const latest = readGateState(projectRoot, sid);
    const gateText = latest
      ? formatGateMessage(latest, { stageId: "B3_RESEARCH" })
      : "B3_RESEARCH 已由扩展自动完成。";
    const settlementWarning = persistB3FinalizerSettlement(
      projectRoot,
      reservation!,
      "passed",
      "finalizer succeeded and qdm-harness finished B3_RESEARCH"
    );
    const text = [
      "B3 finalizer 已成功；qdm-harness 已确定性完成 B3_RESEARCH，无需也禁止父代理再调用 stage-gate finish。",
      gateText,
      settlementWarning && !/已结算/.test(settlementWarning) ? settlementWarning : "",
    ].filter(Boolean).join("\n");
    ctx?.ui?.notify?.(gateText, "info");
    return {
      isError: false,
      content: [...(event.content || []), { type: "text", text }],
      details: event.details,
    };
  }

  function resetInflightB2StartupStatusForSession(sid: string): void {
    for (const [identityKey, record] of [...b2StartupStatuses.entries()]) {
      if (record.sessionId !== sid || record.phase !== "inflight") continue;
      if (record.toolCallId) b2StartupStatusCalls.delete(record.toolCallId);
      b2StartupStatuses.delete(identityKey);
    }
  }

  function foreignToolShapeError(event: PiToolCallEvent): string | null {
    if (!isObject(event.input)) return null;
    const keys = Object.keys(event.input);
    const synthetic = keys.find((key) => key.includes("<arg_key>"));
    if (synthetic) return `工具参数含非法融合键 ${synthetic}`;
    if (!isSubagentToolName(event.toolName)) {
      const foreign = keys.find((key) => ["chain", "context", "agent", "tasks"].includes(key));
      if (foreign) return `非 subagent 工具携带了 ${foreign} 参数`;
    }
    return null;
  }

  function failB2StartupStatus(
    sid: string,
    identity: { key: string; attempt: string },
    reason: string
  ): { block: true; reason: string } {
    const concise = `B2 startup tool contract failed: ${reason}`.slice(0, 500);
    restoreB2StartupTools(identity.key);
    b2StartupStatuses.set(identity.key, {
      key: identity.key,
      sessionId: sid,
      attempt: identity.attempt,
      phase: "failed",
    });
    const failed = runStageGate(projectRoot, sid, "fail", [
      "--stage",
      "B2_WRITER",
      "--reason",
      concise,
    ]);
    return {
      block: true,
      reason: failed.ok
        ? `${concise}；当前 attempt 已终止，只能由用户“重试当前阶段”。`
        : `${concise}；且自动 fail B2_WRITER 失败：${failed.error || "unknown error"}`,
    };
  }

  function b2StartupToolDecision(
    sid: string,
    state: unknown,
    event: PiToolCallEvent
  ): { block: true; reason: string } | undefined {
    const identity = b2StartupStatusIdentity(sid, state);
    if (!identity) return undefined;
    const existing = b2StartupStatuses.get(identity.key);
    if (existing?.phase === "failed") {
      return { block: true, reason: "B2 startup tool contract 已终止；请先由用户重试当前阶段。" };
    }

    if (!existing) {
      const shapeError = foreignToolShapeError(event);
      if (shapeError) return failB2StartupStatus(sid, identity, shapeError);
      if (!exactB2StartupStatusCall(sid, event)) {
        return {
          block: true,
          reason: "B2 启动只需精确 stage-gate status；该工具未执行。当前 Gate attempt 保持有效。",
        };
      }
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
      if (!toolCallId) return failB2StartupStatus(sid, identity, "status 缺少 toolCallId");
      b2StartupStatuses.set(identity.key, {
        key: identity.key,
        sessionId: sid,
        attempt: identity.attempt,
        phase: "inflight",
        toolCallId,
      });
      b2StartupStatusCalls.set(toolCallId, identity.key);
      return undefined;
    }

    if (existing.phase === "inflight") {
      return {
        block: true,
        reason: "B2 startup status 尚在执行；同一消息中的其他 sibling 工具已阻止且不会执行。等待精确 status tool_result 即可，当前 Gate attempt 保持有效。",
      };
    }
    if (existing.phase === "passed") {
      const nextTool = existing.nextTool;
      if (
        nextTool &&
        String(event.toolName || "").toLowerCase() === nextTool.toolName &&
        sameCanonicalJson(event.input, nextTool.input)
      ) return undefined;
      return {
        block: true,
        reason: [
          "B2 startup status 已通过；首个 Writer 接棒完成前，其他工具或参数漂移均已阻止且不会执行。",
          nextTool ? `唯一允许调用：${nextTool.invocation}` : "缺少确定性的 Writer 接棒调用。",
        ].join(" "),
      };
    }
    return undefined;
  }

  function reviewerDispatchIdentityForAttempt(
    sid: string,
    attempt: string
  ): ContractDispatchIdentity {
    return {
      key: `${sid}|${attempt}|report-reviewer`,
      sessionId: sid,
      attempt,
      role: "report-reviewer",
      label: "Report Reviewer",
      maxDispatches: 1,
    };
  }

  function contractDispatchIdentity(
    input: JsonObject | undefined,
    sid: string,
    state: unknown
  ): ContractDispatchIdentity | null {
    const attempt = gateAttemptToken(state);
    if (!attempt || !sid || sid === "unknown") return null;

    const writer = writerInvocationFromSubagentInput(input);
    if (writer.invocation) {
      const expected = writerExpectedFromTask(writer.invocation.task, { projectRoot, session: sid });
      if (!("error" in expected)) {
        return {
          key: `${sid}|${attempt}|report-writer|${expected.cardId}`,
          sessionId: sid,
          attempt,
          role: "report-writer",
          label: `Report Writer cardId=${expected.cardId}`,
          maxDispatches: 1,
        };
      }
    }

    const editorPlanner = editorPlannerInvocationFromSubagentInput(input);
    if (editorPlanner.invocation) {
      const expected = editorPlannerExpected(editorPlanner.invocation.task, projectRoot, sid);
      if (!("error" in expected)) {
        return {
          key: `${sid}|${attempt}|report-editor-planner`,
          sessionId: sid,
          attempt,
          role: "report-editor-planner",
          label: "B2.5 Editor Planner",
          maxDispatches: 1,
        };
      }
    }

    const researcher = researcherInvocationFromSubagentInput(input);
    if (researcher.invocation) {
      const expected = researcherExpected(researcher.invocation.task, projectRoot, sid);
      if (!("error" in expected)) {
        const taskHash = createHash("sha256").update(canonicalizeJson(expected.task), "utf8").digest("hex");
        return {
          key: `${sid}|${attempt}|report-researcher|${expected.taskId}|${taskHash}`,
          sessionId: sid,
          attempt,
          taskId: expected.taskId,
          researcherTask: expected.task,
          role: "report-researcher",
          label: `Report Researcher taskId=${expected.taskId}`,
          maxDispatches: 1,
        };
      }
    }

    const reviewer = reviewerInvocationFromSubagentInput(input);
    if (reviewer.invocation) {
      const expected = reviewerExpected(reviewer.invocation.task, projectRoot, sid);
      if (!("error" in expected)) {
        return reviewerDispatchIdentityForAttempt(sid, attempt);
      }
    }

    const designer = designerInvocationFromSubagentInput(input);
    if (designer.invocation) {
      const expected = designerExpected(designer.invocation.task, projectRoot, sid);
      if (!("error" in expected)) {
        return {
          key: `${sid}|${attempt}|report-designer`,
          sessionId: sid,
          attempt,
          role: "report-designer",
          label: "Report Designer",
          maxDispatches: 1,
        };
      }
    }
    return null;
  }

  function registerContractDispatch(
    identity: ContractDispatchIdentity,
    mechanism: "model-tool" | "extension-event-bridge" = "model-tool"
  ): string | null {
    const record = contractDispatches.get(identity.key) || { count: 0 };
    if (record.terminalReason) {
      return `${identity.label} 本 Gate attempt 已终止：${record.terminalReason}；禁止再次派发。`;
    }
    if (record.count >= identity.maxDispatches) {
      return `${identity.label} 本 Gate attempt 已达到最多 ${identity.maxDispatches} 次派发；禁止继续失败重试。`;
    }
    const taskReservationError = reserveResearcherTaskDispatch(projectRoot, identity);
    if (taskReservationError) return taskReservationError;
    const reservationError = reserveContractDispatch(projectRoot, identity, mechanism);
    if (reservationError) return reservationError;
    record.count = 1;
    contractDispatches.set(identity.key, record);
    return null;
  }

  function markContractTerminal(identity: ContractDispatchIdentity | null, reason: string): void {
    if (!identity) return;
    const record = contractDispatches.get(identity.key);
    if (!record) return;
    record.terminalReason = reason;
    contractDispatches.set(identity.key, record);
  }

  type StageChildResult = {
    ok: boolean;
    text: string;
    transport?: ReportAgentOutcome["transport"];
    value?: unknown;
    identity?: ContractDispatchIdentity;
  };

  function stageProgressFor(sid: string): HtmlReportStageProgressSession | undefined {
    return sid && sid !== "unknown" ? stageProgressSessions.get(sid) : undefined;
  }

  function progressItemIdForIdentity(identity: ContractDispatchIdentity): string | undefined {
    if (identity.role === "report-writer") {
      const parts = identity.key.split("|");
      return parts[parts.length - 1] || undefined;
    }
    if (identity.role === "report-researcher") return identity.taskId;
    if (identity.role === "report-editor-planner") return "planner";
    if (identity.role === "report-reviewer") return "reviewer";
    if (identity.role === "report-designer") return "designer";
    return undefined;
  }

  function publishStageProgress(sid: string): void {
    try { stageProgressFor(sid)?.publish(); } catch { /* display only */ }
  }

  function writerProgressItems(sid: string): HtmlReportProgressItemSeed[] {
    try {
      const result = JSON.parse(readFileSync(join(htmlReportSessionDir(projectRoot, sid), "result.json"), "utf8"));
      if (!isObject(result) || !Array.isArray(result.cards)) return [];
      return result.cards
        .filter((card): card is JsonObject => isObject(card) && typeof card.id === "string" && Boolean(card.id.trim()))
        .map((card) => writerProgressSeed({ id: String(card.id), title: card.title }));
    } catch {
      return [];
    }
  }

  async function markCompletedWriterItems(sid: string): Promise<void> {
    const session = stageProgressFor(sid);
    if (!session) return;
    const remaining = new Set(await remainingWriterCardIds(projectRoot, sid));
    for (const seed of writerProgressItems(sid)) {
      if (!remaining.has(seed.id)) session.tracker.markCompleted(seed.id);
    }
  }

  function researcherProgressItems(sid: string, tasks?: JsonObject[]): HtmlReportProgressItemSeed[] {
    const source = tasks?.length
      ? tasks
      : (() => {
        try {
          const document = JSON.parse(readFileSync(join(htmlReportSessionDir(projectRoot, sid), "analysis", "tasks.json"), "utf8"));
          return isObject(document) && Array.isArray(document.tasks)
            ? document.tasks.filter((task): task is JsonObject => isObject(task))
            : [];
        } catch {
          return [];
        }
      })();
    return source
      .filter((task) => typeof task.id === "string" && task.id.trim())
      .map((task) => {
        const seed = researcherProgressSeed(task);
        const status = String(task.status || "pending");
        if (status === "done" || status === "ok" || status === "completed") seed.status = "completed";
        else if (status === "failed") seed.status = "failed";
        return seed;
      });
  }

  function settleProgressItem(sid: string, itemId: string | undefined, ok: boolean, error?: string): void {
    if (!itemId) return;
    try {
      const session = stageProgressFor(sid);
      if (!session) return;
      if (ok) session.tracker.markCompleted(itemId);
      else session.tracker.markFailed(itemId, error || "failed");
      session.publish();
    } catch { /* display only */ }
  }

  async function beginStageProgress(
    sid: string,
    identity: { stage: ReportAgentStage; attempt: string },
    ctx?: PiExtensionContext,
    onUpdate?: (update: unknown) => void
  ): Promise<HtmlReportStageProgressSession> {
    const existing = stageProgressSessions.get(sid);
    if (existing) {
      existing.bind({ onUpdate });
      return existing;
    }
    const items: HtmlReportProgressItemSeed[] = [];
    let phase = STAGE_PROGRESS_PHASE.writerAgents;
    if (identity.stage === "B2_WRITER") {
      items.push(...writerProgressItems(sid));
      phase = STAGE_PROGRESS_PHASE.prefetch;
    } else if (identity.stage === "B25_EDITOR") {
      items.push({ id: "planner", role: "planner", label: "Editor Planner", agent: "report-researcher" });
      phase = STAGE_PROGRESS_PHASE.sourceInventory;
    } else if (identity.stage === "B3_RESEARCH") {
      items.push(...researcherProgressItems(sid));
      phase = STAGE_PROGRESS_PHASE.researchers;
    } else if (identity.stage === "B4_REVIEW") {
      items.push({ id: "reviewer", role: "reviewer", label: "Report Reviewer", agent: "report-reviewer" });
      phase = STAGE_PROGRESS_PHASE.qualityPreflight;
    } else {
      items.push({ id: "designer", role: "designer", label: "Report Designer", agent: "report-designer" });
      phase = STAGE_PROGRESS_PHASE.designer;
    }
    const session = new HtmlReportStageProgressSession(
      {
        sessionId: sid,
        attempt: identity.attempt,
        entryStage: identity.stage,
        currentStage: identity.stage,
        phase,
        items,
      },
      { onUpdate },
    );
    stageProgressSessions.set(sid, session);
    if (identity.stage === "B2_WRITER") await markCompletedWriterItems(sid);
    session.publish();
    return session;
  }

  function attachStageProgressDetails(sid: string, result: HtmlReportStageRunResult): HtmlReportStageRunResult {
    const session = stageProgressFor(sid);
    if (!session) return result;
    const snapshot = session.finish(result.status, result.status === "failed" ? result.text : undefined);
    return {
      ...result,
      details: {
        ...(result.details || {}),
        progress: snapshot,
      },
    };
  }

  function endStageProgress(sid: string, _ctx?: PiExtensionContext): void {
    if (sid) stageProgressSessions.delete(sid);
  }

  function preparedReportInvocation(
    input: JsonObject,
    sid: string,
    state: unknown
  ): { invocation?: ReportAgentInvocation; identity?: ContractDispatchIdentity; error?: string } {
    if (!isObject(state) || state.status !== "running" || typeof state.currentStage !== "string") {
      return { error: "Report agent 只能在 running html-report Gate 内派发。" };
    }
    const identity = contractDispatchIdentity(input, sid, state);
    if (!identity) return { error: "无法建立 Report agent 的 attempt-bound 派发身份。" };
    const step = Array.isArray(input.chain) && input.chain.length === 1 && isObject(input.chain[0])
      ? input.chain[0]
      : null;
    if (!step || typeof step.agent !== "string" || typeof step.task !== "string" || !isObject(step.outputSchema)) {
      return { error: `${identity.label} 缺少固定 agent/task/outputSchema。` };
    }
    const timeoutMs = Number(input.maxRuntimeMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return { error: `${identity.label} 缺少有效 maxRuntimeMs。` };
    }
    const fingerprint = contractInputSnapshot(input).fingerprint;
    const invocationId = createHash("sha256")
      .update(`${identity.key}|${fingerprint}`, "utf8")
      .digest("hex");
    const stage = state.currentStage as ReportAgentStage;
    return {
      identity,
      invocation: {
        invocationId,
        ownerRunId: `qdm-${createHash("sha256").update(`${sid}|${identity.attempt}`, "utf8").digest("hex")}`,
        nodeId: `${identity.role}-${createHash("sha256").update(identity.key, "utf8").digest("hex")}`,
        sessionId: sid,
        stage,
        attempt: identity.attempt,
        agent: step.agent,
        task: step.task,
        cwd: projectRoot,
        context: "fresh",
        resultSchema: step.outputSchema,
        timeoutMs,
        ...(isObject(input.turnBudget) ? { turnBudget: input.turnBudget as ReportAgentInvocation["turnBudget"] } : {}),
        ...(isObject(step.toolBudget) ? { toolBudget: step.toolBudget as ReportAgentInvocation["toolBudget"] } : {}),
        ...(typeof step.model === "string" && step.model ? { model: step.model } : {}),
        ...(typeof step.skill === "string" || typeof step.skill === "boolean" || Array.isArray(step.skill)
          ? { skill: step.skill as ReportAgentInvocation["skill"] }
          : {}),
        artifacts: false,
      },
    };
  }

  async function invokePreparedReportAgent(
    input: JsonObject,
    sid: string,
    state: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<StageChildResult> {
    if (!transportManager) {
      return { ok: false, text: "pi-subagents event bridge is unavailable; install and enable npm:pi-subagents, then restart Pi." };
    }
    const stageDecision = runningGateSubagentDecision(state, { toolName: "subagent", input });
    if (stageDecision) return { ok: false, text: stageDecision.reason };
    const prepared = preparedReportInvocation(input, sid, state);
    if (!prepared.invocation || !prepared.identity) {
      return { ok: false, text: prepared.error || "Report agent invocation preparation failed." };
    }
    const dispatchError = registerContractDispatch(prepared.identity, "extension-event-bridge");
    if (dispatchError) return { ok: false, text: dispatchError, identity: prepared.identity };
    const itemId = progressItemIdForIdentity(prepared.identity);
    const progressSession = stageProgressFor(sid);
    if (itemId && progressSession) {
      try {
        progressSession.tracker.markDispatching(itemId, {
          invocationId: prepared.invocation.invocationId,
          agent: prepared.invocation.agent,
          ...(prepared.identity.role === "report-writer" ? { cardId: itemId, taskId: itemId } : {}),
          ...(prepared.identity.taskId ? { taskId: prepared.identity.taskId } : {}),
        });
        progressSession.publish();
      } catch { /* display only */ }
    }
    const outcome = await transportManager.invoke(
      prepared.invocation,
      signal,
      (progress: ReportAgentProgress) => {
        if (itemId && progressSession) {
          try {
            progressSession.tracker.applyChildProgress(itemId, progress);
            progressSession.publish();
          } catch { /* display only */ }
          return;
        }
        onUpdate?.({ content: [{ type: "text", text: JSON.stringify(progress) }], details: progress });
      },
    );
    if (outcome.status === "failed") {
      const reason = `${prepared.identity.label} ${outcome.transport} ${outcome.code}: ${outcome.message}`;
      markContractTerminal(prepared.identity, reason);
      settleProgressItem(sid, itemId, false, reason);
      return { ok: false, text: reason, transport: outcome.transport, identity: prepared.identity };
    }
    return {
      ok: true,
      text: `${prepared.identity.label} completed`,
      transport: outcome.transport,
      value: outcome.value,
      identity: prepared.identity,
    };
  }

  function failStageRun(sid: string, stageId: string, reason: string): HtmlReportStageRunResult {
    const concise = String(reason || "html-report stage failed").slice(0, 500);
    const state = readGateState(projectRoot, sid);
    if (state?.status === "running" && state.currentStage === stageId) {
      const failed = runStageGate(projectRoot, sid, "fail", ["--stage", stageId, "--reason", concise]);
      if (!failed.ok) {
        return { status: "failed", text: `${concise}\n扩展无法自动 fail ${stageId}：${failed.error || "unknown stage-gate error"}` };
      }
    }
    return { status: "failed", text: concise };
  }

  async function runWriterChild(
    sid: string,
    cardId: string,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<StageChildResult> {
    const state = readGateState(projectRoot, sid);
    const sessionDir = htmlReportSessionDir(projectRoot, sid);
    const input = writerDispatchInput(sessionDir, cardId);
    const attached = attachWriterRunEnvelope(input, { projectRoot, session: sid });
    if (attached.error) return { ok: false, text: attached.error };
    const step = Array.isArray(input.chain) && isObject(input.chain[0]) ? input.chain[0] : null;
    const task = typeof step?.task === "string" ? step.task : "";
    const expected = writerExpectedFromTask(task, { projectRoot, session: sid });
    if ("error" in expected) return { ok: false, text: expected.error };
    const child = await invokePreparedReportAgent(input, sid, state, signal, onUpdate);
    if (!child.ok) {
      settleProgressItem(sid, cardId, false, child.text);
      return child;
    }
    const checked = validateWriterReturn(child.value, expected);
    if (!checked.ok || !isObject(child.value)) {
      markContractTerminal(child.identity || null, `Writer 返回契约不合法：${checked.errors.join("；")}`);
      settleProgressItem(sid, cardId, false, checked.errors.join("；"));
      return { ...child, ok: false, text: `B2 Report Writer 拒绝：返回契约不合法：${checked.errors.join("；")}` };
    }
    const receipt = child.value;
    if (receipt.fetchStatus === "success") {
      let persisted = null;
      try {
        const resultMtimeMs = (await stat(expected.resultPath)).mtimeMs;
        persisted = await reusableEntry(dirname(expected.dataPath), { notBeforeMs: resultMtimeMs });
      } catch {
        persisted = null;
      }
      if (!persisted) {
        markContractTerminal(child.identity || null, "Writer success 对应的 entry/meta 不存在或已过期");
        settleProgressItem(sid, cardId, false, "success 返回对应的 entry.json / entry.meta.json 不存在、过期，或校验失败");
        return { ...child, ok: false, text: "B2 Report Writer 拒绝：success 返回对应的 entry.json / entry.meta.json 不存在、过期，或校验失败。" };
      }
      persistEditorWriterReturn(expected.resultPath, receipt);
    }
    try {
      const remainingNow = await remainingWriterCardIds(projectRoot, sid);
      if (!remainingNow.length) {
        stageProgressFor(sid)?.tracker.setPhase(STAGE_PROGRESS_PHASE.captionGate);
        publishStageProgress(sid);
      }
    } catch { /* display only */ }
    const finalized = await finishWriterStageIfReady(projectRoot, sid, receipt);
    markContractTerminal(
      child.identity || null,
      finalized.ok ? `fetchStatus=${String(receipt.fetchStatus)} 已验收` : finalized.text,
    );
    settleProgressItem(sid, cardId, finalized.ok, finalized.text);
    return {
      ...child,
      ok: finalized.ok,
      text: `${writerSuccessText(receipt)}\n${finalized.text}`,
      value: receipt,
    };
  }

  async function runB2WriterStage(
    sid: string,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<HtmlReportStageRunResult> {
    const initial = readGateState(projectRoot, sid);
    if (initial?.status !== "running" || initial.currentStage !== "B2_WRITER") {
      return { status: "failed", text: "html_report_run_stage is not bound to a running B2_WRITER attempt" };
    }
    const resultPath = join(htmlReportSessionDir(projectRoot, sid), "result.json");
    const progress = stageProgressFor(sid);
    try {
      progress?.tracker.setPhase(STAGE_PROGRESS_PHASE.prefetch);
      progress?.publish();
    } catch { /* display only */ }
    try {
      const preFetch = await fetchAllEntries(resultPath, { parallel: true, concurrency: 6 });
      const cards = Array.isArray(preFetch?.cards) ? preFetch.cards : [];
      const failed = cards.filter((card) => isObject(card) && card.fetchStatus === "failed");
      if (failed.length && failed.length < cards.length) {
        return failStageRun(sid, "B2_WRITER", `B2 Writer 预取部分失败：${failed.map((card) => String(card.cardId || "unknown")).join(", ")}`);
      }
    } catch {
      // Writers retain their bounded on-demand fetch path.
    }
    try {
      progress?.tracker.setPhase(STAGE_PROGRESS_PHASE.writerAgents);
      progress?.publish();
    } catch { /* display only */ }
    let lastTransport: ReportAgentOutcome["transport"] | undefined;
    while (true) {
      const state = readGateState(projectRoot, sid);
      if (state?.status !== "running" || state.currentStage !== "B2_WRITER") break;
      const remaining = await remainingWriterCardIds(projectRoot, sid);
      if (!remaining.length) {
        try {
          progress?.tracker.setPhase(STAGE_PROGRESS_PHASE.captionGate);
          progress?.publish();
        } catch { /* display only */ }
        const finalized = await finishWriterStageIfReady(projectRoot, sid, {
          fetchStatus: "success",
          cardId: "stage-runner-recovery",
        });
        const afterFinalize = readGateState(projectRoot, sid);
        if (!finalized.ok) {
          return failStageRun(sid, "B2_WRITER", finalized.text);
        }
        if (afterFinalize?.currentStage !== "B2_WRITER" || afterFinalize.status !== "running") break;
        return failStageRun(
          sid,
          "B2_WRITER",
          `B2 caption gate requires correction before this attempt can continue: ${finalized.text}`,
        );
      }
      const child = await runWriterChild(sid, remaining[0], signal, onUpdate);
      if (!child.ok) return { ...failStageRun(sid, "B2_WRITER", child.text), ...(child.transport ? { transport: child.transport } : {}) };
      lastTransport = child.transport || lastTransport;
    }
    const terminal = readGateState(projectRoot, sid);
    if (b2WriterMainWorkAccepted(terminal)) {
      try {
        progress?.tracker.setPhase(STAGE_PROGRESS_PHASE.awaitingApproval);
        progress?.publish();
      } catch { /* display only */ }
      return {
          status: "completed",
          text: formatGateMessage(terminal, { stageId: "B2_MAIN" }),
          ...(lastTransport ? { transport: lastTransport } : {}),
        };
    }
    return { status: "failed", text: "B2 stage runner ended without completed Writer/Main stages", ...(lastTransport ? { transport: lastTransport } : {}) };
  }

  function validateSourceInventory(value: unknown): string | null {
    return !isObject(value) || value.ok !== true || value.version !== 1 ||
      value.producer !== "prepare-research-evidence.mjs" || value.mode !== "source_fields" || !Array.isArray(value.sources)
      ? "source_fields 必须返回 ok=true、version=1、producer=prepare-research-evidence.mjs、mode=source_fields 与 sources[]"
      : null;
  }

  function prepareB25SourceInventory(sid: string): string | null {
    const resultPath = join(htmlReportSessionDir(projectRoot, sid), "result.json");
    const script = join(packageResourceRoot, "skills", "html-report", "scripts", "prepare-research-evidence.mjs");
    const execution = spawnSync(process.execPath, [script, "--result", resultPath, "--source-fields"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    if (execution.status !== 0) return String(execution.stderr || execution.stdout || "source_fields failed").trim();
    try {
      return validateSourceInventory(JSON.parse(execution.stdout));
    } catch {
      return "source_fields 没有返回合法 JSON";
    }
  }

  function researcherInputForTask(
    sessionDir: string,
    resultPath: string,
    task: JsonObject,
    userQuestion: string
  ): JsonObject {
    const taskId = String(task.id || "").trim();
    const evidencePath = join(sessionDir, "analysis", "evidence", `${taskId}.json`);
    return {
      chain: [{
        agent: reportAgentDispatchName("report-researcher"),
        task: [
          `按 report-researcher 处理 taskId=${taskId}`,
          `SESSION=${sessionDir}`,
          `result.json=${resultPath}`,
          `完整 task 对象: ${JSON.stringify(task)}`,
          `用户问题: ${userQuestion.replace(/\s+/g, " ").trim()}`,
          `evidencePath=${evidencePath}`,
          "机器契约：由 qdm-harness 根据当前 task、mode、requirements 和 outputSchema 注入；父代理不得在这里展开、转述或追加规则。",
        ].join("\n"),
      }],
    };
  }

  function writeResearcherSuccessorTask(sessionDir: string, task: JsonObject): void {
    const tasksPath = join(sessionDir, "analysis", "tasks.json");
    const document = JSON.parse(readFileSync(tasksPath, "utf8"));
    if (!isObject(document) || !Array.isArray(document.tasks)) throw new Error("analysis/tasks.json must contain tasks[]");
    const index = document.tasks.findIndex((item) => isObject(item) && item.id === task.id);
    if (index < 0) throw new Error(`analysis/tasks.json is missing taskId=${String(task.id)}`);
    document.tasks[index] = task;
    const temp = `${tasksPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temp, tasksPath);
  }

  function deterministicResearcherSuccessor(task: JsonObject, value: JsonObject): { task?: JsonObject; error?: string } {
    const gap = isObject(value.evidenceGap) ? value.evidenceGap : null;
    if (!gap || !isObject(task.evidencePlan)) return { error: "Researcher needs_* 缺少 evidenceGap/evidencePlan" };
    if (value.status === "needs_new_query") {
      const requiredIndicators = Array.isArray(gap.requiredIndicators) ? gap.requiredIndicators : [];
      const requiredDims = Array.isArray(gap.requiredDims) ? gap.requiredDims : [];
      const unique = (values: unknown[]) => values.filter((item, index) => values.findIndex((candidate) => sameCanonicalJson(candidate, item)) === index);
      return {
        task: {
          ...task,
          evidencePlan: { ...task.evidencePlan, mode: "new_query" },
          evidenceGap: gap,
          candidateIndicators: unique([...(Array.isArray(task.candidateIndicators) ? task.candidateIndicators : []), ...requiredIndicators]),
          candidateDims: unique([...(Array.isArray(task.candidateDims) ? task.candidateDims : []), ...requiredDims]),
        },
      };
    }
    if (value.status === "needs_evidence_plan" && gap.type === "missing_operation") {
      const required = Array.isArray(gap.requiredOperations) ? gap.requiredOperations : [];
      if (!required.length) return { error: "missing_operation 没有 requiredOperations" };
      const operations = [...(Array.isArray(task.evidencePlan.operations) ? task.evidencePlan.operations : [])];
      for (const operation of required) {
        if (!arrayContainsCanonical(operations, operation)) operations.push(operation);
      }
      const requiredColumns = [...(Array.isArray(task.evidencePlan.requiredColumns) ? task.evidencePlan.requiredColumns : [])];
      for (const column of requiredColumnsForOperations(required)) {
        if (!requiredColumns.includes(column)) requiredColumns.push(column);
      }
      return { task: { ...task, evidencePlan: { ...task.evidencePlan, operations, requiredColumns } } };
    }
    return { error: `Researcher ${String(value.status)} ${String(gap.type || "unknown")} 无法唯一确定 successor，已 fail closed` };
  }

  async function runResearcherTask(
    sid: string,
    initialTask: JsonObject,
    userQuestion: string,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<StageChildResult> {
    const sessionDir = htmlReportSessionDir(projectRoot, sid);
    const resultPath = join(sessionDir, "result.json");
    let task = initialTask;
    let lastTransport: ReportAgentOutcome["transport"] | undefined;
    const taskId = String(initialTask.id || "").trim();
    for (let dispatch = 0; dispatch < 2; dispatch += 1) {
      if (dispatch === 1 && taskId) {
        try {
          stageProgressFor(sid)?.tracker.noteAttempt(taskId, 2, 2);
          publishStageProgress(sid);
        } catch { /* display only */ }
      }
      const state = readGateState(projectRoot, sid);
      const input = researcherInputForTask(sessionDir, resultPath, task, userQuestion);
      const attached = attachResearcherOutputSchema(input, { projectRoot, session: sid });
      if (attached.error) return { ok: false, text: attached.error, ...(lastTransport ? { transport: lastTransport } : {}) };
      const step = Array.isArray(input.chain) && isObject(input.chain[0]) ? input.chain[0] : null;
      const expected = researcherExpected(String(step?.task || ""), projectRoot, sid);
      if ("error" in expected) return { ok: false, text: expected.error, ...(lastTransport ? { transport: lastTransport } : {}) };
      const child = await invokePreparedReportAgent(input, sid, state, signal, onUpdate);
      if (!child.ok) {
        settleProgressItem(sid, taskId, false, child.text);
        return child;
      }
      lastTransport = child.transport || lastTransport;
      const checked = validateResearcherArtifacts(child.value, expected);
      if (!checked.ok || !isObject(child.value)) {
        markContractTerminal(child.identity || null, `Researcher 返回或产物契约不合法：${checked.errors.join("；")}`);
        settleProgressItem(sid, taskId, false, checked.errors.join("；"));
        return { ...child, ok: false, text: `B3 Report Researcher 拒绝：${checked.errors.join("；")}` };
      }
      const value = child.value;
      const status = String(value.status || "");
      markContractTerminal(child.identity || null, `结构化 status=${status} 已验收`);
      if (status === "ok") {
        settleProgressItem(sid, taskId, true);
        return { ...child, value, text: researcherSuccessText(value, projectRoot, sid) };
      }
      if (status === "failed") {
        settleProgressItem(sid, taskId, false, String(value.error || "Researcher returned status=failed"));
        return { ...child, ok: false, value, text: String(value.error || "Researcher returned status=failed") };
      }
      if (!child.identity) {
        settleProgressItem(sid, taskId, false, "Researcher needs_* 缺少 dispatch identity");
        return { ...child, ok: false, text: "Researcher needs_* 缺少 dispatch identity" };
      }
      authorizeResearcherTaskSuccessor(projectRoot, child.identity, status, value.evidenceGap);
      if (dispatch === 1) {
        settleProgressItem(sid, taskId, false, `Researcher successor 再次返回 status=${status}；禁止第三次派发。`);
        return { ...child, ok: false, text: `Researcher successor 再次返回 status=${status}；禁止第三次派发。` };
      }
      const successor = deterministicResearcherSuccessor(task, value);
      if (!successor.task) return { ...child, ok: false, text: successor.error || "Researcher successor 无法确定" };
      writeResearcherSuccessorTask(sessionDir, successor.task);
      task = successor.task;
      if (isObject(task.evidencePlan) && task.evidencePlan.mode === "reuse_entry") {
        const script = join(packageResourceRoot, "skills", "html-report", "scripts", "prepare-research-evidence.mjs");
        const prepared = spawnSync(process.execPath, [script, "--result", resultPath, "--task-id", String(task.id)], {
          cwd: projectRoot,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        });
        if (prepared.status !== 0) return { ...child, ok: false, text: String(prepared.stderr || prepared.stdout || "successor evidence preparation failed").trim() };
      }
    }
    return { ok: false, text: "Researcher successor loop exhausted", ...(lastTransport ? { transport: lastTransport } : {}) };
  }

  function runReservedB3Finalizer(sid: string, attempt: string, stageToolCallId: string): HtmlReportStageRunResult {
    const reserved = reserveB3Finalizer(projectRoot, sid, attempt, `${stageToolCallId}:b3-finalizer`);
    if (!reserved.reservation) return failStageRun(sid, "B3_RESEARCH", reserved.error || "B3 finalizer reservation failed");
    const contract = researchFinalizerContract(projectRoot, sid);
    const execution = spawnSync(process.execPath, [contract.scriptPath, "--result", contract.resultPath], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (execution.status !== 0) {
      const reason = String(execution.stderr || execution.stdout || "B3 finalizer failed").trim();
      persistB3FinalizerSettlement(projectRoot, reserved.reservation, "failed", reason);
      return failStageRun(sid, "B3_RESEARCH", reason);
    }
    const finished = runStageGate(projectRoot, sid, "finish", ["--stage", "B3_RESEARCH"]);
    if (!finished.ok) {
      const reason = `B3 finalizer passed but stage finish failed: ${finished.error || "unknown error"}`;
      persistB3FinalizerSettlement(projectRoot, reserved.reservation, "failed", reason);
      return failStageRun(sid, "B3_RESEARCH", reason);
    }
    const settlementError = persistB3FinalizerSettlement(projectRoot, reserved.reservation, "passed", "finalizer and explore layout passed");
    if (settlementError) return { status: "failed", text: settlementError };
    const terminal = readGateState(projectRoot, sid);
    return { status: "completed", text: terminal ? formatGateMessage(terminal, { stageId: "B3_RESEARCH" }) : "B3_RESEARCH completed" };
  }

  async function runB3ResearchStage(
    sid: string,
    stageToolCallId: string,
    researchTasks?: Array<{ task: JsonObject; evidencePath?: string }>,
    userQuestion?: string,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<HtmlReportStageRunResult> {
    const state = readGateState(projectRoot, sid);
    const attempt = gateAttemptToken(state);
    if (!attempt || state?.status !== "running" || state.currentStage !== "B3_RESEARCH") {
      return { status: "failed", text: "html_report_run_stage is not bound to a running B3_RESEARCH attempt" };
    }
    const sessionDir = htmlReportSessionDir(projectRoot, sid);
    let tasks = researchTasks?.map((item) => item.task).filter(isObject) || [];
    let question = String(userQuestion || "").trim();
    if (!tasks.length || !question) {
      try {
        const document = JSON.parse(readFileSync(join(sessionDir, "analysis", "tasks.json"), "utf8"));
        if (!isObject(document) || !Array.isArray(document.tasks)) throw new Error("tasks[] missing");
        if (!tasks.length) tasks = document.tasks.filter((task): task is JsonObject => isObject(task) && ["pending", "running"].includes(String(task.status)));
        if (!question && isObject(document.editorial)) question = String(document.editorial.userQuestion || "").trim();
      } catch (error) {
        return failStageRun(sid, "B3_RESEARCH", `cannot load B3 tasks: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!question) {
      try { question = String(JSON.parse(readFileSync(join(sessionDir, "result.json"), "utf8")).userQuestion || "").trim(); } catch { question = ""; }
    }
    try {
      const progress = stageProgressFor(sid);
      progress?.tracker.setCurrentStage("B3_RESEARCH");
      progress?.tracker.setPhase(STAGE_PROGRESS_PHASE.researchers);
      if (!progress?.tracker.snapshot().items.some((item) => item.role === "researcher")) {
        progress?.tracker.addItems(researcherProgressItems(sid, tasks));
      }
      progress?.publish();
    } catch { /* display only */ }
    let lastTransport: ReportAgentOutcome["transport"] | undefined;
    for (const task of tasks) {
      const child = await runResearcherTask(sid, task, question, signal, onUpdate);
      if (!child.ok) {
        const currentAttempt = gateAttemptToken(readGateState(projectRoot, sid)) || attempt;
        const terminal = persistResearcherParentTerminal(projectRoot, sid, currentAttempt, child.transport ? "invalid_return_or_artifacts" : "missing_structured_output");
        researcherParentTerminals.set(sid, terminal);
        return { ...failStageRun(sid, "B3_RESEARCH", child.text), ...(child.transport ? { transport: child.transport } : {}) };
      }
      lastTransport = child.transport || lastTransport;
    }
    try {
      stageProgressFor(sid)?.tracker.setPhase(STAGE_PROGRESS_PHASE.finalizer);
      publishStageProgress(sid);
    } catch { /* display only */ }
    const finalized = runReservedB3Finalizer(sid, attempt, stageToolCallId);
    return { ...finalized, ...(lastTransport ? { transport: lastTransport } : {}) };
  }

  async function runB25AndB3Stage(
    sid: string,
    stageToolCallId: string,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<HtmlReportStageRunResult> {
    const state = readGateState(projectRoot, sid);
    if (state?.status !== "running" || state.currentStage !== "B25_EDITOR") {
      return { status: "failed", text: "html_report_run_stage is not bound to a running B25_EDITOR attempt" };
    }
    try {
      stageProgressFor(sid)?.tracker.setPhase(STAGE_PROGRESS_PHASE.sourceInventory);
      publishStageProgress(sid);
    } catch { /* display only */ }
    const inventoryError = prepareB25SourceInventory(sid);
    if (inventoryError) return failStageRun(sid, "B25_EDITOR", inventoryError);
    try {
      stageProgressFor(sid)?.tracker.setPhase(STAGE_PROGRESS_PHASE.planner);
      publishStageProgress(sid);
    } catch { /* display only */ }
    const input = JSON.parse(JSON.stringify(b25EditorBootstrapContract(projectRoot, sid).plannerInput)) as JsonObject;
    const attached = attachEditorPlannerOutputSchema(input, { projectRoot, session: sid });
    if (attached.error) return failStageRun(sid, "B25_EDITOR", attached.error);
    const step = Array.isArray(input.chain) && isObject(input.chain[0]) ? input.chain[0] : null;
    const expected = editorPlannerExpected(String(step?.task || ""), projectRoot, sid);
    if ("error" in expected) return failStageRun(sid, "B25_EDITOR", expected.error);
    const child = await invokePreparedReportAgent(input, sid, state, signal, onUpdate);
    if (!child.ok) {
      settleProgressItem(sid, "planner", false, child.text);
      return { ...failStageRun(sid, "B25_EDITOR", child.text), ...(child.transport ? { transport: child.transport } : {}) };
    }
    const canonicalPlan = normalizeEditorPlan(child.value);
    const checked = validateEditorPlan(canonicalPlan, expected.input);
    if (!checked.ok) {
      markContractTerminal(child.identity || null, `Planner return invalid: ${checked.errors.join("; ")}`);
      settleProgressItem(sid, "planner", false, checked.errors.join("; "));
      return { ...failStageRun(sid, "B25_EDITOR", `Editor Planner return is invalid: ${checked.errors.join("; ")}`), ...(child.transport ? { transport: child.transport } : {}) };
    }
    let materialized;
    try {
      materialized = await materializeEditorPlan(expected.resultPath, canonicalPlan, { input: expected.input });
    } catch (error) {
      markContractTerminal(child.identity || null, `Planner materialization failed: ${error instanceof Error ? error.message : String(error)}`);
      settleProgressItem(sid, "planner", false, error instanceof Error ? error.message : String(error));
      return { ...failStageRun(sid, "B25_EDITOR", `Editor Planner materialization failed: ${error instanceof Error ? error.message : String(error)}`), ...(child.transport ? { transport: child.transport } : {}) };
    }
    const finished = runStageGate(projectRoot, sid, "finish", ["--stage", "B25_EDITOR"]);
    if (!finished.ok) {
      settleProgressItem(sid, "planner", false, finished.error || "B25 finish failed");
      return { ...failStageRun(sid, "B25_EDITOR", `B25 finish failed: ${finished.error}`), ...(child.transport ? { transport: child.transport } : {}) };
    }
    markContractTerminal(child.identity || null, "typed semantic plan 已验收并自动完成 B25");
    settleProgressItem(sid, "planner", true);
    try {
      const progress = stageProgressFor(sid);
      progress?.tracker.setCurrentStage("B3_RESEARCH");
      progress?.tracker.addItems(researcherProgressItems(sid, materialized.researchTasks.map((item) => item.task)));
      progress?.tracker.setPhase(STAGE_PROGRESS_PHASE.researchers);
      progress?.publish();
    } catch { /* display only */ }
    const b3 = await runB3ResearchStage(
      sid,
      stageToolCallId,
      materialized.researchTasks,
      String(expected.input.userQuestion || ""),
      signal,
      onUpdate,
    );
    return { ...b3, ...(b3.transport || !child.transport ? {} : { transport: child.transport }) };
  }

  async function runB4ReviewStage(
    sid: string,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<HtmlReportStageRunResult> {
    const state = readGateState(projectRoot, sid);
    const attempt = gateAttemptToken(state);
    if (!attempt || state?.status !== "running" || state.currentStage !== "B4_REVIEW") {
      return { status: "failed", text: "html_report_run_stage is not bound to a running B4_REVIEW attempt" };
    }
    try {
      stageProgressFor(sid)?.tracker.setPhase(STAGE_PROGRESS_PHASE.qualityPreflight);
      publishStageProgress(sid);
    } catch { /* display only */ }
    const scan = runReviewerScanPreflight(projectRoot, sid, attempt);
    if (!scan.ok) {
      settleProgressItem(sid, "reviewer", false, scan.reason);
      return failStageRun(sid, "B4_REVIEW", scan.reason);
    }
    try {
      stageProgressFor(sid)?.tracker.setPhase(STAGE_PROGRESS_PHASE.reviewer);
      publishStageProgress(sid);
    } catch { /* display only */ }
    const sessionDir = htmlReportSessionDir(projectRoot, sid);
    const input: JsonObject = { chain: [{ agent: reportAgentDispatchName("report-reviewer"), task: `B4 scorecard\nSESSION=${sessionDir}\nresult.json=${join(sessionDir, "result.json")}` }] };
    const attached = attachReviewerOutputSchema(input, { projectRoot, session: sid });
    if (attached.error) return failStageRun(sid, "B4_REVIEW", attached.error);
    const step = Array.isArray(input.chain) && isObject(input.chain[0]) ? input.chain[0] : null;
    const expected = reviewerExpected(String(step?.task || ""), projectRoot, sid);
    if ("error" in expected) return failStageRun(sid, "B4_REVIEW", expected.error);
    const child = await invokePreparedReportAgent(input, sid, state, signal, onUpdate);
    if (!child.ok || !isObject(child.value)) {
      const terminal = persistReviewerParentTerminal(projectRoot, sid, attempt, "contract_error");
      reviewerParentTerminals.set(sid, terminal);
      settleProgressItem(sid, "reviewer", false, child.text);
      return { ...failStageRun(sid, "B4_REVIEW", child.text), ...(child.transport ? { transport: child.transport } : {}) };
    }
    const checked = validateReviewerArtifacts(child.value, expected);
    if (!checked.ok) {
      markContractTerminal(child.identity || null, `Reviewer artifacts invalid: ${checked.errors.join("；")}`);
      const terminal = persistReviewerParentTerminal(projectRoot, sid, attempt, "contract_error");
      reviewerParentTerminals.set(sid, terminal);
      settleProgressItem(sid, "reviewer", false, checked.errors.join("；"));
      return { ...failStageRun(sid, "B4_REVIEW", `Reviewer 返回或 verdict 契约不合法：${checked.errors.join("；")}`), ...(child.transport ? { transport: child.transport } : {}) };
    }
    const status = ["passed", "failed", "infrastructure_error"].includes(String(child.value.status))
      ? child.value.status as ReviewerParentTerminal["status"]
      : "contract_error";
    if (status === "passed") {
      try {
        stageProgressFor(sid)?.tracker.setPhase(STAGE_PROGRESS_PHASE.layoutCheck);
        publishStageProgress(sid);
      } catch { /* display only */ }
      const layout = await checkSessionLayout(expected.sessionDir, { phase: "quality" });
      if (!layout.ok) {
        settleProgressItem(sid, "reviewer", false, layout.errors.join("；"));
        return { ...failStageRun(sid, "B4_REVIEW", `quality layout failed: ${layout.errors.join("；")}`), ...(child.transport ? { transport: child.transport } : {}) };
      }
    }
    markContractTerminal(child.identity || null, `结构化 status=${status} 已验收`);
    settleProgressItem(sid, "reviewer", status === "passed", `Reviewer status=${status}`);
    reviewerParentTerminals.set(sid, persistReviewerParentTerminal(projectRoot, sid, attempt, status));
    const operation = status === "passed" ? "finish" : "fail";
    const args = operation === "finish"
      ? ["--stage", "B4_REVIEW"]
      : ["--stage", "B4_REVIEW", "--reason", `Reviewer status=${status}`];
    const transitioned = runStageGate(projectRoot, sid, operation, args);
    if (!transitioned.ok) return { status: "failed", text: `B4 ${operation} failed: ${transitioned.error}`, ...(child.transport ? { transport: child.transport } : {}) };
    const terminal = readGateState(projectRoot, sid);
    return {
      status: status === "passed" ? "completed" : "failed",
      text: terminal ? formatGateMessage(terminal, { stageId: "B4_REVIEW" }) : `B4_REVIEW ${status}`,
      ...(child.transport ? { transport: child.transport } : {}),
    };
  }

  async function runB5DesignStage(
    sid: string,
    ctx?: PiExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<HtmlReportStageRunResult> {
    const skipped = autoSkipB5DesignForFixedDebugSession(sid, ctx);
    if (skipped?.handled) {
      try {
        const progress = stageProgressFor(sid);
        progress?.tracker.setPhase(STAGE_PROGRESS_PHASE.skipped);
        if (skipped.ok) progress?.tracker.markSkipped("designer", "fixed debug skip");
        else progress?.tracker.markFailed("designer", skipped.text);
        progress?.publish();
      } catch { /* display only */ }
      return { status: skipped.ok ? "completed" : "failed", text: skipped.text };
    }
    try {
      stageProgressFor(sid)?.tracker.setPhase(STAGE_PROGRESS_PHASE.designer);
      publishStageProgress(sid);
    } catch { /* display only */ }
    const state = readGateState(projectRoot, sid);
    if (state?.status !== "running" || state.currentStage !== "B5_DESIGN") {
      return { status: "failed", text: "html_report_run_stage is not bound to a running B5_DESIGN attempt" };
    }
    const sessionDir = htmlReportSessionDir(projectRoot, sid);
    const input: JsonObject = { chain: [{ agent: reportAgentDispatchName("report-designer"), task: `B5 autonomous design\nSESSION=${sessionDir}\nresult.json=${join(sessionDir, "result.json")}` }] };
    const attached = attachDesignerOutputSchema(input, { projectRoot, session: sid });
    if (attached.error) return failStageRun(sid, "B5_DESIGN", attached.error);
    const step = Array.isArray(input.chain) && isObject(input.chain[0]) ? input.chain[0] : null;
    const expected = designerExpected(String(step?.task || ""), projectRoot, sid);
    if ("error" in expected) return failStageRun(sid, "B5_DESIGN", expected.error);
    const child = await invokePreparedReportAgent(input, sid, state, signal, onUpdate);
    if (!child.ok) {
      settleProgressItem(sid, "designer", false, child.text);
      return { ...failStageRun(sid, "B5_DESIGN", child.text), ...(child.transport ? { transport: child.transport } : {}) };
    }
    const checked = await validateDesignerArtifacts(child.value, expected);
    if (!checked.ok || !isObject(child.value)) {
      markContractTerminal(child.identity || null, `Designer artifacts invalid: ${checked.errors.join("；")}`);
      settleProgressItem(sid, "designer", false, checked.errors.join("；"));
      return { ...failStageRun(sid, "B5_DESIGN", `Designer 返回或 HTML 产物契约不合法：${checked.errors.join("；")}`), ...(child.transport ? { transport: child.transport } : {}) };
    }
    const failed = child.value.status === "failed";
    markContractTerminal(child.identity || null, `结构化 status=${String(child.value.status)} 已验收`);
    settleProgressItem(sid, "designer", !failed, String(child.value.error || child.value.status));
    const transitioned = runStageGate(
      projectRoot,
      sid,
      failed ? "fail" : "finish",
      failed
        ? ["--stage", "B5_DESIGN", "--reason", String(child.value.error || "Designer status=failed")]
        : ["--stage", "B5_DESIGN"],
    );
    if (!transitioned.ok) return { status: "failed", text: `B5 Gate transition failed: ${transitioned.error}`, ...(child.transport ? { transport: child.transport } : {}) };
    const terminal = readGateState(projectRoot, sid);
    return {
      status: failed ? "failed" : "completed",
      text: terminal ? formatGateMessage(terminal, { stageId: "B5_DESIGN" }) : `B5_DESIGN ${failed ? "failed" : "completed"}`,
      ...(child.transport ? { transport: child.transport } : {}),
    };
  }

  async function executeCurrentReportStage(
    toolCallId: string,
    ctx?: PiExtensionContext,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void
  ): Promise<HtmlReportStageRunResult> {
    const sid = sessionId(ctx);
    const state = sid && sid !== "unknown" ? readGateState(projectRoot, sid) : null;
    const attempt = gateAttemptToken(state);
    const reservation = state ? htmlReportStageReservation(projectRoot, sid, state) : null;
    if (
      !state || state.status !== "running" || !HTML_REPORT_RUNNER_STAGES.has(String(state.currentStage)) ||
      !attempt || !reservation
    ) {
      return {
        status: "failed",
        text: "html_report_run_stage 未绑定到当前 running Gate attempt。若阶段已暂停，回复“继续”；若已失败，回复“重试当前阶段”。",
      };
    }
    const identity = {
      sessionId: sid,
      sessionDir: htmlReportSessionDir(projectRoot, sid),
      stage: state.currentStage as ReportAgentStage,
      attempt,
      reservation,
    };
    return stageRunner.run(identity, async () => {
      await beginStageProgress(sid, { stage: identity.stage, attempt }, ctx, onUpdate);
      try {
        const result = state.currentStage === "B2_WRITER"
          ? await runB2WriterStage(sid, signal, onUpdate)
          : state.currentStage === "B25_EDITOR"
            ? await runB25AndB3Stage(sid, toolCallId, signal, onUpdate)
            : state.currentStage === "B3_RESEARCH"
              ? await runB3ResearchStage(sid, toolCallId, undefined, undefined, signal, onUpdate)
              : state.currentStage === "B4_REVIEW"
                ? await runB4ReviewStage(sid, signal, onUpdate)
                : await runB5DesignStage(sid, ctx, signal, onUpdate);
        return attachStageProgressDetails(sid, result);
      } catch (error) {
        try {
          stageProgressFor(sid)?.finish("failed", error instanceof Error ? error.message : String(error));
        } catch { /* display only */ }
        throw error;
      }
    });
  }

  function syncStageRunnerTools(sid: string, state: unknown): boolean {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function" || !sid || sid === "unknown") return false;
    const running = isObject(state) && state.status === "running" && HTML_REPORT_RUNNER_STAGES.has(String(state.currentStage));
    if (running) {
      if (!stageRunnerToolSnapshots.has(sid)) stageRunnerToolSnapshots.set(sid, [...pi.getActiveTools()]);
      pi.setActiveTools([HTML_REPORT_STAGE_TOOL]);
      return true;
    }
    const snapshot = stageRunnerToolSnapshots.get(sid);
    if (snapshot) {
      stageRunnerToolSnapshots.delete(sid);
      pi.setActiveTools([...snapshot]);
    }
    return false;
  }

  function restoreStageRunnerToolsForSession(sid: string): void {
    const snapshot = stageRunnerToolSnapshots.get(sid);
    if (!snapshot) return;
    stageRunnerToolSnapshots.delete(sid);
    pi.setActiveTools?.([...snapshot]);
  }

  pi.registerTool?.({
    name: HTML_REPORT_STAGE_TOOL,
    label: "Run html-report stage",
    description: "Run the current html-report Gate stage inside qdm-harness. Do not pass reservation, agent, task, or stage; the running Gate attempt is the only input.",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
    renderCall(args, theme) {
      try {
        return renderStageProgressCall(args, theme as { fg?: (token: string, text: string) => string; bold?: (text: string) => string });
      } catch {
        return { render: () => ["html-report"] };
      }
    },
    renderResult(result, options, theme) {
      try {
        return renderStageProgressResult(result, options, theme as { fg?: (token: string, text: string) => string; bold?: (text: string) => string; dim?: (text: string) => string });
      } catch {
        return { render: () => ["html-report"] };
      }
    },
    async execute(toolCallId, _params, signal, onUpdate, ctx) {
      const sid = sessionId(ctx);
      if (sid && sid !== "unknown") stageRunnerInFlightSessions.add(sid);
      try {
        const result = await executeCurrentReportStage(toolCallId, ctx, signal, onUpdate);
        const progress = extractStageProgress(result.details);
        return {
          isError: result.status === "failed",
          content: [{ type: "text", text: result.text }],
          details: {
            status: result.status,
            ...(result.transport ? { transport: result.transport } : {}),
            ...(progress ? { progress } : {}),
            ...(result.details ? { stage: result.details } : {}),
          },
        };
      } finally {
        if (sid && sid !== "unknown") {
          stageRunnerInFlightSessions.delete(sid);
          endStageProgress(sid, ctx);
          syncStageRunnerTools(sid, readGateState(projectRoot, sid));
        }
      }
    },
  });

  function contractResultError(reason: string): ToolResultPatch {
    return {
      isError: true,
      content: [{ type: "text", text: `Report contract 子代理结果拒绝：${reason}` }],
    };
  }

  function contractInvocationPresent(input: JsonObject | undefined): boolean {
    return Boolean(
      writerInvocationFromSubagentInput(input).invocation ||
      editorPlannerInvocationFromSubagentInput(input).invocation ||
      researcherInvocationFromSubagentInput(input).invocation ||
      reviewerInvocationFromSubagentInput(input).invocation ||
      designerInvocationFromSubagentInput(input).invocation
    );
  }

  function consumeContractResult(
    event: PiToolResultEvent,
    sid: string,
    gateState: unknown
  ):
    | { bound: ContractCallInFlight; event: PiToolResultEvent }
    | { error: ToolResultPatch }
    | null {
    if (!isSubagentToolName(event.toolName)) return null;
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
    const bound = toolCallId ? inFlightContractCalls.get(toolCallId) : undefined;
    const protectedStage = isObject(gateState) &&
      ["B2_WRITER", "B2_MAIN", "B25_EDITOR", "B3_RESEARCH", "B4_REVIEW", "B5_DESIGN"].includes(String(gateState.currentStage));
    if (!bound && !contractInvocationPresent(event.input) && !protectedStage) return null;
    if (!toolCallId) return { error: contractResultError("缺少 toolCallId，无法绑定已获准的 contract tool_call。") };
    if (settledContractToolCalls.has(toolCallId)) {
      return { error: contractResultError(`toolCallId=${toolCallId} 已结算；重复或重放结果已阻止。`) };
    }
    if (!bound) {
      return { error: contractResultError(`toolCallId=${toolCallId} 没有当前 Pi 进程内的已获准派发；伪造、跨重启迟到或未登记结果已阻止。`) };
    }

    // Consume before validation/await so concurrent replays cannot both cause
    // successor authorization or Reviewer terminal side effects.
    inFlightContractCalls.delete(toolCallId);
    settledContractToolCalls.add(toolCallId);
    if (bound.sessionId !== sid) {
      return { error: contractResultError(`toolCallId=${toolCallId} 属于另一个 Pi Session。`) };
    }
    let actualFingerprint = "";
    try {
      actualFingerprint = isObject(event.input) ? contractInputSnapshot(event.input).fingerprint : "";
    } catch {
      actualFingerprint = "";
    }
    if (!actualFingerprint || actualFingerprint !== bound.inputFingerprint) {
      return { error: contractResultError(`toolCallId=${toolCallId} 的 input 与发起时固定输入不一致。`) };
    }
    const currentAttempt = gateAttemptToken(gateState);
    if (currentAttempt !== bound.identity.attempt) {
      return {
        error: contractResultError(
          `toolCallId=${toolCallId} 属于 Gate attempt ${bound.identity.attempt}，当前为 ${currentAttempt || "非运行状态"}；迟到结果不得污染新 attempt。`
        ),
      };
    }
    return { bound, event: { ...event, input: bound.input } };
  }

  function currentReviewerParentTerminal(
    sid: string,
    attempt: string
  ): ReviewerParentTerminal | null {
    const remembered = reviewerParentTerminals.get(sid);
    if (remembered?.attempt === attempt) return remembered;

    const persisted = readReviewerParentTerminal(projectRoot, sid, attempt);
    if (persisted) {
      reviewerParentTerminals.set(sid, persisted);
      return persisted;
    }

    // A durable dispatch reservation without a terminal record means Pi died
    // after launching Reviewer but before recording its checked result. Never
    // reopen unrestricted parent tools or re-run Reviewer in that attempt.
    const reviewerIdentity = reviewerDispatchIdentityForAttempt(sid, attempt);
    if (hasContractDispatchReservation(projectRoot, reviewerIdentity)) {
      const interrupted = persistReviewerParentTerminal(
        projectRoot,
        sid,
        attempt,
        "contract_error"
      );
      reviewerParentTerminals.set(sid, interrupted);
      return interrupted;
    }
    return null;
  }

  function currentResearcherParentTerminal(
    sid: string,
    attempt: string
  ): ResearcherParentTerminal | null {
    const remembered = researcherParentTerminals.get(sid);
    if (remembered?.attempt === attempt) return remembered;
    const persisted = readResearcherParentTerminal(projectRoot, sid, attempt);
    if (persisted) researcherParentTerminals.set(sid, persisted);
    return persisted;
  }

  function researcherParentDecision(
    terminal: ResearcherParentTerminal,
    toolCall: PiToolCallEvent
  ): { block: true; reason: string } | undefined {
    const toolName = String(toolCall.toolName || "").toLowerCase();
    if (toolName === "bash") {
      const command = typeof toolCall.input?.command === "string" ? toolCall.input.command : "";
      const parsed = parseStandaloneStageGateCommand(command);
      const assignedSession = parsed?.options["--session-dir"];
      const assignedStage = parsed?.options["--stage"];
      const assignedReason = parsed?.options["--reason"];
      if (
        parsed?.operation === "fail" &&
        typeof assignedSession === "string" &&
        resolve(assignedSession) === resolve(terminal.sessionDir) &&
        assignedStage === terminal.stageId &&
        assignedReason === terminal.gateFailureReason
      ) return undefined;
    }
    return {
      block: true,
      reason: `B3 Researcher ${terminal.failureCode} 已终止当前 Gate attempt；禁止 read/edit/write、assemble、layout、finish 或再次派发。父代理唯一允许动作是针对当前 SESSION/B3_RESEARCH、reason=${JSON.stringify(terminal.gateFailureReason)} 的独立 stage-gate fail。`,
    };
  }

  function researcherParentFailureText(terminal: ResearcherParentTerminal): string {
    const script = join(packageResourceRoot, "skills/html-report/scripts/stage-gate.mjs");
    return [
      `B3 当前 Gate attempt 已持久终止：${terminal.failureCode}。`,
      "禁止读取或修改 tasks/main/section，禁止 assemble/layout/finish，也禁止重新派发 Researcher。",
      "父代理现在只能执行以下独立最终调用：",
      `node '${script}' fail --session-dir '${terminal.sessionDir}' --stage B3_RESEARCH --reason '${terminal.gateFailureReason}' --format text`,
    ].join("\n");
  }

  function reviewerParentDecision(
    terminal: ReviewerParentTerminal,
    toolCall: PiToolCallEvent
  ): { block: true; reason: string } | undefined {
    const toolName = String(toolCall.toolName || "").toLowerCase();
    if (toolName === "bash") {
      const command = typeof toolCall.input?.command === "string" ? toolCall.input.command : "";
      const parsed = parseStandaloneStageGateCommand(command);
      const expectedOperation = terminal.status === "passed" ? "finish" : "fail";
      const assignedSession = parsed?.options["--session-dir"];
      const assignedStage = parsed?.options["--stage"];
      if (
        parsed?.operation === expectedOperation &&
        typeof assignedSession === "string" &&
        resolve(assignedSession) === resolve(terminal.sessionDir) &&
        assignedStage === terminal.stageId
      ) return undefined;
      return {
        block: true,
        reason: `B4 Reviewer 已返回 ${terminal.status}；父代理只允许针对当前 SESSION/B4_REVIEW 的独立 stage-gate ${expectedOperation}，禁止跨 Session 收尾、禁止重复 assemble/layout、诊断脚本或其他 Bash。`,
      };
    }
    const path = typeof toolCall.input?.path === "string"
      ? toolCall.input.path
      : typeof toolCall.input?.filePath === "string"
        ? toolCall.input.filePath
        : "";
    if (
      terminal.status === "failed" &&
      ["read", "write", "edit"].includes(toolName) &&
      path === terminal.repairLogPath
    ) {
      return undefined;
    }
    return {
      block: true,
      reason: `B4 Reviewer 已返回 ${terminal.status}；请直接使用扩展给出的审核与诊断 JSON，禁止再读目录、verdict、section、entry 或临时产物。`,
    };
  }

  // Expose the long-lived agent PID so html-report server can outlive tool shells
  // and exit only when the Pi session process itself exits.
  process.env.PI_AGENT_PID = String(process.pid);

  pi.on?.("input", async (event, ctx) => {
    // Unknown session ids cannot be retained across turns without leaking an
    // html-report stop into an unrelated future turn. Keep only a turn-local
    // marker, refreshed by before_agent_start when an expanded skill prompt
    // bypasses the input hook.
    staleUnknownHtmlReportTurn = false;
    injectedPromptThisTurn = "";
    const sid = sessionId(ctx);
    const text = isObject(event) && typeof event.text === "string" ? event.text : "";
    if (isHtmlReportSkillPrompt(text) || existingHtmlReportSession(sid)) {
      const runtimeError = runtimeGuardError(sid);
      if (runtimeError) {
        rememberStaleHtmlReportSession(sid);
        notifyRuntimeFreshness(sid, runtimeError.reason, ctx);
        return { action: "handled" };
      }
    }
    if (sid && sid !== "unknown") suppressHarnessRecallForSkillSessions.delete(sid);
    const gateAction = classifyGateInput(text);
    if (sid && sid !== "unknown" && gateAction) {
      const gateState = readGateState(projectRoot, sid);
      if (
        gateState?.currentStage === "A_CONFIG" &&
        gateState.status === "awaiting_approval" &&
        fixedAConfigSessions.has(sid) &&
        !successfulRuntimeAgentList(sid, gateState)
      ) {
        ctx?.ui?.notify?.(
          "A_CONFIG 尚未通过本 Pi 进程的 runtime agent list；已阻止批准进入 B0。请先让当前 Agent 执行一次 subagent({\"action\":\"list\"})。",
          "warning"
        );
        return { action: "continue" };
      }
      const result = await applyGateInput(projectRoot, sid, text);
      if (result.result && !result.result.ok) {
        ctx?.ui?.notify?.(`html-report Gate 未变更：${result.result.error}`, "warning");
      } else if (result.rejected === "failed_stage_requires_retry") {
        ctx?.ui?.notify?.("当前阶段失败；请回复“重试当前阶段”，普通“继续”不会跳过 Gate。", "warning");
      } else if (result.rejected === "current_stage_not_failed") {
        ctx?.ui?.notify?.("当前阶段不是 failed，无需重试。", "info");
      } else if (result.rejected === "confirm_only_approves_A_CONFIG") {
        ctx?.ui?.notify?.("“确认生成报告”仅用于批准 A_CONFIG；后续 Gate 请回复“继续”。", "warning");
      } else if (result.rejected === "html_only_on_b2_main") {
        ctx?.ui?.notify?.("“生成 HTML”仅用于 B2 Main 阶段。", "warning");
      }
      // Restrict before Pi constructs the next agent/provider prompt. Doing
      // this only in before_agent_start is too late for providers that already
      // captured the previous read/subagent tool definitions for this turn.
      const afterGateInput = readGateState(projectRoot, sid);
      const debugB5Skip = autoSkipB5DesignForFixedDebugSession(sid, ctx, {
        sendGateMessage: true,
      });
      if (debugB5Skip?.handled) return { action: "handled" };
      if (!syncStageRunnerTools(sid, afterGateInput)) restrictB2StartupTools(sid, afterGateInput);
      const htmlGateAction = gateAction === "generate_html" || gateAction === "retry_html" || gateAction === "skip_html";
      if (htmlGateAction && result.handled) {
        const textOut = typeof result.message === "string" && result.message
          ? result.message
          : "B2_MAIN HTML 导出请求已处理。";
        const exportFailed = result.exportResult != null && result.exportResult.ok === false;
        ctx?.ui?.notify?.(textOut, exportFailed || result.rejected ? "warning" : "info");
        if (typeof pi.sendMessage === "function") {
          try {
            pi.sendMessage({
              customType: HTML_REPORT_GATE_CUSTOM_TYPE,
              content: textOut,
              display: true,
              details: {
                version: 1,
                producer: "qdm-harness",
                sessionId: sid,
                stageId: "B2_MAIN",
                currentStage: afterGateInput?.currentStage || "B2_MAIN",
                pipelineStatus: afterGateInput?.status || null,
                stageStatus: isObject(afterGateInput?.stages) && isObject(afterGateInput.stages.B2_MAIN)
                  ? afterGateInput.stages.B2_MAIN.status
                  : null,
                htmlExport: result.exportResult?.status || result.action,
                attempt: stageAttemptDetails(afterGateInput, "B2_MAIN"),
              },
            }, { triggerTurn: false });
          } catch (error) {
            ctx?.ui?.notify?.(
              `HTML 导出门控消息写入失败：${error instanceof Error ? error.message : String(error)}`,
              "warning"
            );
          }
        }
        return { action: "handled" };
      }
      const idleInput = !isObject(event) || event.streamingBehavior === undefined;
      if (
        idleInput &&
        (gateAction === "continue" || gateAction === "confirm") &&
        result.result?.ok === true &&
        await handleDeterministicB0Approval(sid, gateState, afterGateInput, ctx)
      ) {
        const nextState = readGateState(projectRoot, sid);
        if (!syncStageRunnerTools(sid, nextState)) restrictB2StartupTools(sid, nextState);
        return { action: "handled" };
      }
    }
    return { action: "continue" };
  });

  pi.on?.("before_agent_start", async (event, ctx) => {
    const rawPrompt = latestUserPrompt(event);
    const sid = sessionId(ctx);
    const htmlReportPrompt = isHtmlReportSkillPrompt(rawPrompt);
    if (htmlReportPrompt || existingHtmlReportSession(sid) || staleHtmlReportSessions.has(sid)) {
      const runtimeError = runtimeGuardError(sid);
      if (runtimeError) {
        rememberStaleHtmlReportSession(sid);
        notifyRuntimeFreshness(sid, runtimeError.reason, ctx);
        const current = (event as PiBeforeAgentStartEvent).systemPrompt ?? "";
        return {
          systemPrompt: [
            current,
            runtimeError.kind === "process"
              ? runtimeFreshnessBanner(runtimeError.reason)
              : sessionRuntimeMismatchBanner(runtimeError.reason),
          ].filter(Boolean).join("\n\n"),
        };
      }
    }
    const fixedHtmlReportSkill = htmlReportPrompt && useFixedAConfigPreset();
    if (sid && sid !== "unknown") {
      if (fixedHtmlReportSkill) suppressHarnessRecallForSkillSessions.add(sid);
      else suppressHarnessRecallForSkillSessions.delete(sid);
    }
    if (sid && sid !== "unknown") {
      process.env.PI_SESSION_ID = sid;
    } else if (htmlReportPrompt) {
      delete process.env.PI_SESSION_ID;
      ctx?.ui?.notify?.("无法获取 Pi session id，html-report 将停止使用 manual 目录", "error");
    }
    process.env.PI_AGENT_PID = String(process.pid);

    const gateBeforeInitialization = sid && sid !== "unknown" ? readGateState(projectRoot, sid) : null;
    if (sid && sid !== "unknown" && htmlReportPrompt) {
      const defaultMode = process.env.HTML_REPORT_GATE_MODE === "auto" ? "auto" : "step";
      const initialized = initializeGateForHtmlReport(projectRoot, sid, defaultMode);
      if (!initialized.ok) {
        ctx?.ui?.notify?.(`html-report Gate 初始化失败：${initialized.error}`, "error");
      } else if (!gateBeforeInitialization) {
        try {
          writeHtmlReportRuntimeContract(projectRoot, sid, runtimeSourcesAtLoad);
        } catch (error) {
          const reason = `html-report 运行时契约标记写入失败：${error instanceof Error ? error.message : String(error)}`;
          incompatibleSessionErrors.set(sid, reason);
          rememberStaleHtmlReportSession(sid);
          notifyRuntimeFreshness(sid, reason, ctx);
          const current = (event as PiBeforeAgentStartEvent).systemPrompt ?? "";
          return {
            systemPrompt: [current, sessionRuntimeMismatchBanner(reason)].filter(Boolean).join("\n\n"),
          };
        }
      }
    }

    let gateState = sid && sid !== "unknown" ? readGateState(projectRoot, sid) : null;
    if (
      gateState &&
      process.env.HTML_REPORT_GATE_MODE === "auto" &&
      gateState.mode !== "auto"
    ) {
      const escaped = runStageGate(projectRoot, sid, "resume", [
        "--mode",
        "auto",
        "--phrase",
        "HTML_REPORT_GATE_MODE=auto",
        "--actor",
        "environment",
      ]);
      if (!escaped.ok) {
        ctx?.ui?.notify?.(`html-report auto Gate 切换待处理：${escaped.error}`, "warning");
      }
      gateState = readGateState(projectRoot, sid);
    }
    const debugB5Skip = sid && sid !== "unknown"
      ? autoSkipB5DesignForFixedDebugSession(sid, ctx, { sendGateMessage: true })
      : null;
    if (debugB5Skip?.handled) gateState = readGateState(projectRoot, sid);

    const prompt = harnessQuestion(rawPrompt);
    let fixedSeed: FixedRecommendationSeed | null = null;
    let fixedUiMessage: ReturnType<typeof fixedAConfigMessage> | undefined;
    let fixedSeedError = "";
    if (
      sid &&
      sid !== "unknown" &&
      htmlReportPrompt &&
      fixedHtmlReportSkill &&
      gateState?.currentStage === "A_CONFIG" &&
      gateState.status === "running"
    ) {
      const seeded = seedFixedAConfig(projectRoot, sid, prompt);
      if (!seeded.ok) {
        fixedSeedError = seeded.error;
        ctx?.ui?.notify?.(`html-report 无法启动 qdm-metric-cli ui：${seeded.error}`, "error");
      } else {
        fixedAConfigSessions.add(sid);
        fixedSeed = seeded.seed;
        // Pi appends before_agent_start messages after the expanded skill message.
        fixedUiMessage = fixedAConfigMessage(sid, fixedSeed);
        gateState = readGateState(projectRoot, sid);
        ctx?.ui?.notify?.(
          `html-report 已打开 qdm-metric-cli ui${fixedSeed.serverUrl ? `：${fixedSeed.serverUrl}` : ""}。保存 result.json 后回复一次「继续」；B0 通过后会自动开始 B2。`,
          "info"
        );
      }
    }
    if (sid && sid !== "unknown") {
      const visitedRuntimeListAttempts = new Set<string>();
      // A fixed A_CONFIG finish can advance auto mode directly into B0. Run
      // both deterministic discoveries in this same model-start hook, while
      // a stable attempt (dynamic A_CONFIG or step-mode approval) stops the
      // loop. There are only two runtime-list stages by contract.
      for (let index = 0; index < 2; index += 1) {
        const identity = runtimeAgentListAttempt(gateState);
        const key = runtimeAgentListKey(sid, gateState);
        if (!identity || !key || visitedRuntimeListAttempts.has(key)) break;
        visitedRuntimeListAttempts.add(key);
        await ensureAutomaticRuntimeAgentList(sid, gateState, ctx);
        const nextState = readGateState(projectRoot, sid);
        const nextKey = runtimeAgentListKey(sid, nextState);
        gateState = nextState;
        if (!nextKey || nextKey === key) break;
      }
    }
    if (!syncStageRunnerTools(sid, gateState)) restrictB2StartupTools(sid, gateState);
    const gateContext = gateState
      ? gateContextBanner(projectRoot, sid, gateState, {
          fixedAConfig: fixedAConfigSessions.has(sid),
          writerCardIds: verifiedB2WriterCardIds(projectRoot, sid, gateState),
        })
      : "";
    const context =
      gateState && classifyGateInput(rawPrompt)
        ? ""
        : fixedHtmlReportSkill && gateState?.currentStage === "A_CONFIG"
          ? fixedSeed
            ? fixedAConfigSystemBanner(fixedSeed)
            : fixedAConfigFailureBanner(fixedSeedError)
          : runHarnessContext(projectRoot, rawPrompt || prompt, ctx);
    const additional = [context, gateContext].filter(Boolean).join("\n\n");
    if (!additional && !fixedUiMessage) return undefined;
    if (additional) injectedPromptThisTurn = prompt || rawPrompt;
    const current = (event as PiBeforeAgentStartEvent).systemPrompt ?? "";
    return {
      message: fixedUiMessage,
      systemPrompt: additional ? [current, additional].filter(Boolean).join("\n\n") : undefined,
    };
  });

  pi.on?.("context", async (event, ctx) => {
    const payload = event as PiContextEvent;
    const messages = payload.messages;
    if (!Array.isArray(messages)) return undefined;
    const authz = bindAuthzForTurn(projectRoot, authzStore, ctx, payload);
    if (authz.mode === "on" && !authz.bound && authz.error) {
      ctx?.ui?.notify?.(`QDM Authz: ${authz.error}`, "warning");
    } else if (
      authz.bound &&
      authz.source === "lumi_envelope" &&
      process.env.QDM_HARNESS_DIAG === "1"
    ) {
      ctx?.ui?.notify?.("QDM Authz: bound source=lumi_envelope", "info");
    }
    const sid = sessionId(ctx);
    const gateState = sid && sid !== "unknown" ? readGateState(projectRoot, sid) : null;
    const effectiveMessages = compactHtmlReportGateHistory(
      compactHtmlReportSkillHistory(messages, gateState),
      gateState
    );
    if (existingHtmlReportSession(sid)) {
      const runtimeError = runtimeGuardError(sid);
      if (runtimeError) {
        rememberStaleHtmlReportSession(sid);
        notifyRuntimeFreshness(sid, runtimeError.reason, ctx);
        return {
          messages: authzGuidance(authz.mode, authz.bound)
            ? [...effectiveMessages, qdmContextMessage(authzGuidance(authz.mode, authz.bound))]
            : effectiveMessages,
        };
      }
    }
    // Suppress recall only for the fixed html-report *skill* turn. Do not use
    // the environment flag alone here: ordinary (non-skill) messages must
    // keep the normal Harness recall path even while debugging is enabled.
    const authContext = authzGuidance(authz.mode, authz.bound);
    if (sid && suppressHarnessRecallForSkillSessions.has(sid)) {
      return {
        messages: authContext
          ? [...effectiveMessages, qdmContextMessage(authContext)]
          : effectiveMessages,
      };
    }
    const rawPrompt = latestUserPrompt(event);
    const prompt = harnessQuestion(rawPrompt);
    if (!prompt || injectedPromptThisTurn === prompt) {
      return {
        messages: authContext
          ? [...effectiveMessages, qdmContextMessage(authContext)]
          : effectiveMessages,
      };
    }
    const context = runHarnessContext(projectRoot, rawPrompt || prompt, ctx);
    const additional = [context, authContext].filter(Boolean).join("\n\n");
    if (!additional) return { messages: effectiveMessages };
    injectedPromptThisTurn = prompt;
    return { messages: [...effectiveMessages, qdmContextMessage(additional)] };
  });

  pi.on?.("tool_call", (event, ctx) => {
    const toolCall = event as PiToolCallEvent;
    if (
      String(toolCall.toolName || "").toLowerCase() === "bash" &&
      isObject(toolCall.input) &&
      typeof toolCall.input.command === "string"
    ) {
      toolCall.input.command = normalizeStandaloneStageGateCommand(toolCall.input.command);
    }
    const sid = sessionId(ctx);
    const gateState = sid && sid !== "unknown" ? readGateState(projectRoot, sid) : null;
    if (
      gateState ||
      existingHtmlReportSession(sid) ||
      staleHtmlReportSessions.has(sid) ||
      (sid === "unknown" && staleUnknownHtmlReportTurn)
    ) {
      const runtimeError = runtimeGuardError(sid);
      if (runtimeError) {
        rememberStaleHtmlReportSession(sid);
        notifyRuntimeFreshness(sid, runtimeError.reason, ctx);
        return { block: true, reason: runtimeError.reason };
      }
    }
    if (String(toolCall.toolName || "").toLowerCase() === HTML_REPORT_STAGE_TOOL) {
      return gateToolDecision(gateState, toolCall, {
        finishInFlight: finishingSessions.has(sid),
        stageReservation: gateState ? htmlReportStageReservation(projectRoot, sid, gateState) : null,
      }) || undefined;
    }
    const b25BootstrapDecision = b25BootstrapToolDecision(sid, gateState, toolCall);
    if (b25BootstrapDecision) return b25BootstrapDecision;
    const b2StartupDecision = b2StartupToolDecision(sid, gateState, toolCall);
    if (b2StartupDecision) return b2StartupDecision;
    const b2WriterQueueDecision = b2WriterQueueToolDecision(sid, gateState, toolCall);
    if (b2WriterQueueDecision) return b2WriterQueueDecision;
    const b3HandoffDecision = b3HandoffToolDecision(sid, gateState, toolCall);
    if (b3HandoffDecision) return b3HandoffDecision;
    const runtimeListPrerequisite = runtimeAgentListPrerequisiteDecision(
      sid,
      gateState,
      toolCall
    );
    if (runtimeListPrerequisite) return runtimeListPrerequisite;
    const ledgerDecision = contractRuntimeLedgerDecision(projectRoot, sid, gateState, toolCall);
    if (ledgerDecision) return ledgerDecision;
    const parentFetchDecision = parentDataFetchDecision(gateState, toolCall);
    if (parentFetchDecision) return parentFetchDecision;

    const authzConfig = loadAuthzConfig(projectRoot);
    const metricCliPath = resolveMetricCliPath(projectRoot, authzConfig);
    let authzTurn = authzStore.getCurrentTurn(sid);
    let authzMissingReason = "";
    if (authzConfig.mode === "on" && !authzTurn?.blob) {
      const rebound = bindAuthzForTurn(projectRoot, authzStore, ctx);
      authzTurn = authzStore.getCurrentTurn(sid);
      authzMissingReason = rebound.error || "";
      if (process.env.QDM_HARNESS_DIAG === "1") {
        const rawSid = envelopeSessionId(ctx) || "(empty)";
        const envDir = process.env.LUMI_REQUESTER_CONTEXT_DIR ? "set" : "unset";
        ctx?.ui?.notify?.(
          rebound.bound
            ? `QDM Authz diag: tool_call re-bind ok source=${rebound.source} sid=${rawSid} envDir=${envDir}`
            : `QDM Authz diag: tool_call re-bind failed sid=${rawSid} envDir=${envDir} err=${rebound.error || "unknown"}`,
          rebound.bound ? "info" : "warning",
        );
      }
    }
    const authzDecision = applyAuthzToToolCall(toolCall, {
      mode: authzConfig.mode,
      blob: authzTurn?.blob ?? null,
      metricCliPath,
      allowLocalBlob: authzConfig.allowLocalBlob,
      missingReason: authzTurn?.blob
        ? undefined
        : authzConfig.allowLocalBlob === false
          ? "authz: host blob not bound; cannot run gated metric-cli under allow_local_blob=false (refusing any model-supplied --auth-blob)"
          : `authz mode is on but no encrypted auth blob is bound for this turn; cannot run qdm-metric-cli analysis execute or auth describe${authzMissingReason ? ` (${authzMissingReason})` : ""}`,
    });
    if (authzDecision?.block) return authzDecision;

    const waitingAConfigList = isWaitingAConfigAgentList(gateState, toolCall);
    const listIdentity = runtimeAgentListAttempt(gateState);
    if (listIdentity && isExactRuntimeAgentList(toolCall)) {
      const listKey = runtimeAgentListKey(sid, gateState);
      const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId.trim() : "";
      if (!listKey || !toolCallId) {
        return {
          block: true,
          reason: `${listIdentity.stageId} runtime agent list 缺少可绑定的 Session、attempt 或 toolCallId。`,
        };
      }
      if (runtimeAgentLists.has(listKey)) {
        return {
          block: true,
          reason: `${listIdentity.stageId} 每个 Gate attempt 只允许一次只读 subagent action=list；重复调用已阻止。`,
        };
      }
      runtimeAgentLists.set(listKey, {
        key: listKey,
        sessionId: sid,
        stageId: listIdentity.stageId,
        attempt: listIdentity.attempt,
        toolCallId,
        mechanism: "model-tool",
        status: "inflight",
      });
      runtimeAgentListCalls.set(toolCallId, listKey);
    }
    if (!waitingAConfigList) {
      const decision = gateToolDecision(gateState, toolCall, {
        finishInFlight: finishingSessions.has(sid),
        stageReservation: gateState ? htmlReportStageReservation(projectRoot, sid, gateState) : null,
      });
      if (decision) return decision;
    }

    const attempt = gateAttemptToken(gateState);
    const researcherTerminal = attempt ? currentResearcherParentTerminal(sid, attempt) : null;
    if (researcherTerminal) {
      const parentDecision = researcherParentDecision(researcherTerminal, toolCall);
      if (parentDecision) return parentDecision;
    }
    const reviewerTerminal = attempt ? currentReviewerParentTerminal(sid, attempt) : null;
    if (reviewerTerminal) {
      const parentDecision = reviewerParentDecision(reviewerTerminal, toolCall);
      if (parentDecision) return parentDecision;
    }
    const b3FinalizerDecision = b3FinalizerToolDecision(sid, gateState, toolCall);
    if (b3FinalizerDecision) return b3FinalizerDecision;

    const parallelReportAgent = isSubagentToolName(toolCall.toolName)
      ? anyUnsupportedParallelReportAgent(toolCall.input)
      : undefined;
    if (parallelReportAgent) return { block: true, reason: parallelReportAgent };
    const stageSubagentDecision = runningGateSubagentDecision(gateState, toolCall);
    if (stageSubagentDecision) return stageSubagentDecision;

    if (isSubagentToolName(toolCall.toolName)) {
      const schemaAttachment = attachWriterRunEnvelope(toolCall.input, { projectRoot, session: sid });
      if (schemaAttachment.error) return { block: true, reason: schemaAttachment.error };
      const editorPlannerSchemaAttachment = attachEditorPlannerOutputSchema(toolCall.input, { projectRoot, session: sid });
      if (editorPlannerSchemaAttachment.error) {
        if (isObject(gateState) && gateState.currentStage === "B25_EDITOR") {
          failEditorPlannerStage(projectRoot, sid, `Editor Planner dispatch contract failed: ${editorPlannerSchemaAttachment.error}`);
        }
        return { block: true, reason: editorPlannerSchemaAttachment.error };
      }
      const researcherSchemaAttachment = attachResearcherOutputSchema(toolCall.input, { projectRoot, session: sid });
      if (researcherSchemaAttachment.error) return { block: true, reason: researcherSchemaAttachment.error };
      const reviewerSchemaAttachment = attachReviewerOutputSchema(toolCall.input, { projectRoot, session: sid });
      if (reviewerSchemaAttachment.error) return { block: true, reason: reviewerSchemaAttachment.error };
      const designerSchemaAttachment = attachDesignerOutputSchema(toolCall.input, { projectRoot, session: sid });
      if (designerSchemaAttachment.error) return { block: true, reason: designerSchemaAttachment.error };
      const writerInvocation = writerInvocationFromSubagentInput(toolCall.input);
      if (writerInvocation.error) return { block: true, reason: writerInvocation.error };
      if (writerInvocation.invocation) {
        const expected = writerExpectedFromTask(writerInvocation.invocation.task, { projectRoot, session: sid });
        if ("error" in expected) return { block: true, reason: expected.error };
      }
      const editorPlannerInvocation = editorPlannerInvocationFromSubagentInput(toolCall.input);
      if (editorPlannerInvocation.error) return { block: true, reason: editorPlannerInvocation.error };
      if (editorPlannerInvocation.invocation) {
        const expected = editorPlannerExpected(editorPlannerInvocation.invocation.task, projectRoot, sid);
        if ("error" in expected) return { block: true, reason: expected.error };
      }
      const researcherInvocation = researcherInvocationFromSubagentInput(toolCall.input);
      if (researcherInvocation.error) return { block: true, reason: researcherInvocation.error };
      if (researcherInvocation.invocation) {
        const expected = researcherExpected(researcherInvocation.invocation.task, projectRoot, sid);
        if ("error" in expected) return { block: true, reason: expected.error };
      }
      const reviewerInvocation = reviewerInvocationFromSubagentInput(toolCall.input);
      if (reviewerInvocation.error) return { block: true, reason: reviewerInvocation.error };
      if (reviewerInvocation.invocation) {
        const expected = reviewerExpected(reviewerInvocation.invocation.task, projectRoot, sid);
        if ("error" in expected) return { block: true, reason: expected.error };
        const preflightAttempt = gateAttemptToken(gateState);
        if (!preflightAttempt) {
          return { block: true, reason: "Report Reviewer 只能在 running B4_REVIEW Gate attempt 内派发。" };
        }
        const scanPreflight = runReviewerScanPreflight(projectRoot, sid, preflightAttempt);
        if (!scanPreflight.ok) return { block: true, reason: scanPreflight.reason };
      }
      const designerInvocation = designerInvocationFromSubagentInput(toolCall.input);
      if (designerInvocation.error) return { block: true, reason: designerInvocation.error };
      if (designerInvocation.invocation) {
        const expected = designerExpected(designerInvocation.invocation.task, projectRoot, sid);
        if ("error" in expected) return { block: true, reason: expected.error };
      }
      const dispatchIdentity = contractDispatchIdentity(toolCall.input, sid, gateState);
      if (dispatchIdentity) {
        const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId.trim() : "";
        if (!toolCallId) {
          return { block: true, reason: `${dispatchIdentity.label} 缺少 toolCallId，无法绑定唯一 tool_result。` };
        }
        if (inFlightContractCalls.has(toolCallId) || settledContractToolCalls.has(toolCallId)) {
          return { block: true, reason: `contract toolCallId=${toolCallId} 已被使用，拒绝覆盖或重放派发。` };
        }
        let snapshot;
        try {
          snapshot = contractInputSnapshot(toolCall.input || {});
        } catch (error) {
          return {
            block: true,
            reason: `无法冻结 ${dispatchIdentity.label} 的派发输入：${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const dispatchError = registerContractDispatch(dispatchIdentity);
        if (dispatchError) return { block: true, reason: dispatchError };
        inFlightContractCalls.set(toolCallId, {
          toolCallId,
          sessionId: sid,
          identity: dispatchIdentity,
          inputFingerprint: snapshot.fingerprint,
          input: snapshot.input,
        });
        if (dispatchIdentity.role === "report-writer") {
          const startupIdentity = b2StartupStatusIdentity(sid, gateState);
          const startupRecord = startupIdentity
            ? b2StartupStatuses.get(startupIdentity.key)
            : null;
          if (startupIdentity && startupRecord?.phase === "passed") {
            b2StartupStatuses.set(startupIdentity.key, {
              ...startupRecord,
              phase: "dispatched",
              nextTool: undefined,
            });
            restoreB2StartupTools(startupIdentity.key);
          }
        }
      } else if (
        writerInvocation.invocation ||
        editorPlannerInvocation.invocation ||
        researcherInvocation.invocation ||
        reviewerInvocation.invocation ||
        designerInvocation.invocation
      ) {
        return { block: true, reason: "Report contract 子代理只能在对应的 running html-report Gate attempt 内派发。" };
      }
    }

    if (gateState && toolCall.toolName?.toLowerCase() === "bash") {
      const command = typeof toolCall.input?.command === "string" ? toolCall.input.command : "";
      const parsed = parseStandaloneStageGateCommand(command);
      if (parsed && ["finish", "fail"].includes(parsed.operation)) {
        const operation = parsed.operation as "finish" | "fail";
        finishingSessions.add(sid);
        if (toolCall.toolCallId) {
          finishingToolCalls.set(toolCall.toolCallId, {
            sessionId: sid,
            stageId: gateState.currentStage,
            operation,
          });
        }
      }
    }
    injectPosttool(projectRoot, event, ctx);
    return undefined;
  });

  pi.on?.("tool_result", async (event, ctx) => {
    const toolResultEvent = event as PiToolResultEvent;
    const sid = sessionId(ctx);
    const gateState = sid && sid !== "unknown" ? readGateState(projectRoot, sid) : null;
    if (
      gateState ||
      existingHtmlReportSession(sid) ||
      staleHtmlReportSessions.has(sid) ||
      (sid === "unknown" && staleUnknownHtmlReportTurn)
    ) {
      const runtimeError = runtimeGuardError(sid);
      if (runtimeError) {
        rememberStaleHtmlReportSession(sid);
        notifyRuntimeFreshness(sid, runtimeError.reason, ctx);
        return {
          isError: true,
          content: [{ type: "text", text: runtimeError.reason }],
        };
      }
    }
    const quietUnavailable = quietB2StartupUnavailableTool(sid, gateState, toolResultEvent);
    if (quietUnavailable) return quietUnavailable;
    const b3FinalizerResult = settleB3FinalizerResult(
      sid,
      gateState,
      toolResultEvent,
      ctx
    );
    if (b3FinalizerResult) return b3FinalizerResult;
    const b25BootstrapResult = await settleB25BootstrapResult(
      sid,
      gateState,
      toolResultEvent,
      ctx
    );
    if (b25BootstrapResult) return b25BootstrapResult;
    const b2StatusToolCallId = typeof toolResultEvent.toolCallId === "string"
      ? toolResultEvent.toolCallId.trim()
      : "";
    const b2StatusKey = b2StatusToolCallId
      ? b2StartupStatusCalls.get(b2StatusToolCallId)
      : undefined;
    if (b2StatusKey) {
      b2StartupStatusCalls.delete(b2StatusToolCallId);
      const record = b2StartupStatuses.get(b2StatusKey);
      const currentIdentity = b2StartupStatusIdentity(sid, gateState);
      if (!record) {
        if (currentIdentity?.key !== b2StatusKey) {
          if (
            currentIdentity?.key &&
            b2StartupToolSnapshots.has(currentIdentity.key)
          ) b2StartupToolSnapshots.delete(b2StatusKey);
          else restoreB2StartupTools(b2StatusKey);
          return {
            isError: true,
            content: [{
              type: "text",
              text: "B2 startup status 的迟到 tool_result 已忽略；当前 Gate attempt 未变更。",
            }],
          };
        }
        const failed = failB2StartupStatus(
          sid,
          {
            key: b2StatusKey,
            sessionId: sid,
            attempt: currentIdentity?.attempt || "unknown",
          },
          "status tool_result 无法绑定发起记录"
        );
        return { isError: true, content: [{ type: "text", text: failed.reason }] };
      }
      const failedReason = record.toolCallId !== b2StatusToolCallId
        ? "status tool_result 无法绑定发起记录"
        : record.phase === "failed"
          ? "status 与后续工具被并发发出"
          : record.sessionId !== sid || currentIdentity?.key !== record.key
            ? "status tool_result 不属于当前 Session/Gate attempt"
            : toolResultEvent.isError === true
              ? `status 执行失败：${contentText(toolResultEvent.content) || "unknown error"}`
              : null;
      if (failedReason) {
        if (currentIdentity?.key !== record.key) {
          b2StartupStatuses.delete(record.key);
          if (
            currentIdentity?.key &&
            b2StartupToolSnapshots.has(currentIdentity.key)
          ) b2StartupToolSnapshots.delete(record.key);
          else restoreB2StartupTools(record.key);
          return {
            isError: true,
            content: [{
              type: "text",
              text: `B2 startup status 的迟到 tool_result 已忽略：${failedReason}；当前 Gate attempt 未变更。`,
            }],
          };
        }
        const failed = failB2StartupStatus(sid, record, failedReason);
        return {
          isError: true,
          content: [{ type: "text", text: failed.reason }],
        };
      }
      restoreB2StartupTools(record.key);
      const writerCardIds = verifiedB2WriterCardIds(projectRoot, sid, gateState);
      if (!writerCardIds.length) {
        const failed = failB2StartupStatus(sid, record, "status 成功后无法取得已确认的首张 Writer 卡片");
        return {
          isError: true,
          content: [{ type: "text", text: failed.reason }],
        };
      }
      const sessionDir = htmlReportSessionDir(projectRoot, sid);
      const resultPath = join(sessionDir, "result.json");
      // Best-effort parallel pre-fetch: if it succeeds, Writers get cache hits
      // and skip the CLI wait. If it fails (no CLI, test environment, auth not
      // configured), continue to Writers — they will fetch on-demand via
      // ack_cli_data. Only fail B2 when some cards succeed and others fail,
      // which signals a real data-level error rather than an infrastructure gap.
      try {
        const preFetch = await fetchAllEntries(resultPath, { parallel: true, concurrency: 6 });
        const allCards = Array.isArray(preFetch?.cards) ? preFetch.cards : [];
        const failedCards = allCards.filter((c) => isObject(c) && c.fetchStatus === "failed");
        if (failedCards.length && failedCards.length < allCards.length) {
          const failedIds = failedCards.map((c) => String(c.cardId || "unknown")).join(", ");
          const failed = failB2StartupStatus(sid, record, `预取失败: cardId=${failedIds}`);
          return {
            isError: true,
            content: [{ type: "text", text: failed.reason }],
          };
        }
      } catch {
        // Infrastructure failure (CLI not available, auth not configured):
        // skip pre-fetch, continue to Writers for on-demand fetch.
      }
      const nextTool = writerNextTool(sessionDir, writerCardIds[0]);
      b2StartupStatuses.set(record.key, {
        ...record,
        phase: "passed",
        nextTool,
      });
      restrictB2StartupTools(sid, gateState);
      return {
        isError: false,
        content: [
          ...(toolResultEvent.content || []),
          {
            type: "text",
            text: [
              "B2 startup status 已验证。",
              `NEXT_TOOL_ONLY：下一条 assistant 消息只原样调用 \`${nextTool.invocation}\`。`,
              "这是前台 Writer 调用；禁止 wait、重复 status、目录诊断、复述或参数重构。",
            ].join("\n"),
          },
        ],
      };
    }
    const writerQueueStatus = await settleB2WriterQueueStatus(sid, gateState, toolResultEvent);
    if (writerQueueStatus) return writerQueueStatus;
    const runtimeListToolCallId = typeof toolResultEvent.toolCallId === "string"
      ? toolResultEvent.toolCallId.trim()
      : "";
    const runtimeListKey = runtimeListToolCallId
      ? runtimeAgentListCalls.get(runtimeListToolCallId)
      : undefined;
    if (runtimeListKey) {
      runtimeAgentListCalls.delete(runtimeListToolCallId);
      const record = runtimeAgentLists.get(runtimeListKey);
      if (!record) {
        return {
          isError: true,
          content: [{ type: "text", text: "runtime agent list 结果无法绑定当前 Session/Gate attempt。" }],
        };
      }
      if (record.sessionId !== sid || record.toolCallId !== runtimeListToolCallId) {
        const reason = record.sessionId !== sid
          ? `runtime agent list 结果来自错误 Session：expected=${record.sessionId} actual=${sid}`
          : `runtime agent list toolCallId 不匹配：expected=${record.toolCallId} actual=${runtimeListToolCallId}`;
        const failure = failRuntimeAgentListStage(record.sessionId, record, reason);
        return {
          isError: true,
          content: [{ type: "text", text: failure }],
        };
      }
      const settled = await settleRuntimeAgentList(sid, record, toolResultEvent);
      return {
        isError: settled.isError,
        content: [
          ...(toolResultEvent.content || []),
          { type: "text", text: settled.text },
        ],
      };
    }
    const parentFetchDecision = parentDataFetchDecision(gateState, toolResultEvent);
    if (parentFetchDecision) {
      return {
        isError: true,
        content: [{ type: "text", text: parentFetchDecision.reason }],
      };
    }
    const parallelReportAgent = isSubagentToolName(toolResultEvent.toolName)
      ? anyUnsupportedParallelReportAgent(toolResultEvent.input)
      : undefined;
    if (parallelReportAgent) {
      return {
        isError: true,
        content: [{ type: "text", text: `Report contract 子代理拒绝：${parallelReportAgent}` }],
      };
    }
    const stageSubagentDecision = runningGateSubagentDecision(gateState, toolResultEvent);
    if (stageSubagentDecision) {
      return {
        isError: true,
        content: [{ type: "text", text: stageSubagentDecision.reason }],
      };
    }
    const consumed = consumeContractResult(toolResultEvent, sid, gateState);
    if (consumed && "error" in consumed) return consumed.error;
    const contractEvent = consumed?.event || toolResultEvent;
    const dispatchIdentity = consumed?.bound.identity || null;
    let runtimeTimeout: string | null = null;
    if (
      dispatchIdentity &&
      (
        dispatchIdentity.role === "report-writer" ||
        dispatchIdentity.role === "report-editor-planner" ||
        dispatchIdentity.role === "report-researcher" ||
        dispatchIdentity.role === "report-designer"
      )
    ) {
      runtimeTimeout = contractRuntimeTimeoutReason(contractEvent);
      if (runtimeTimeout) {
        markContractTerminal(dispatchIdentity, `子代理运行超时：${runtimeTimeout}`);
      }
    }
    const writerDecision = await reportWriterResultDecision(
      contractEvent,
      projectRoot,
      sid
    );
    if (writerDecision) {
      const details = isObject(contractEvent.details) ? contractEvent.details : null;
      const results = Array.isArray(details?.results) ? details.results : [];
      const output = results.length === 1 && isObject(results[0])
        ? (isObject(results[0].structuredOutput)
          ? results[0].structuredOutput
          : extractWriterReceipt(results[0]))
        : null;
      if (dispatchIdentity?.role === "report-writer") {
        const reason = writerDecision.isError === true
          ? runtimeTimeout
            ? `子代理运行超时：${runtimeTimeout}`
            : output
              ? `ack_cli_data 回执已验收但 B2 已终止：fetchStatus=${String(output.fetchStatus || "unknown")}`
              : "Writer 终端结果未通过，B2 已确定性失败"
          : output?.fetchStatus === "success"
            ? "success 已验收"
            : `ack_cli_data fetchStatus=${String(output?.fetchStatus || "failed")} 已验收`;
        markContractTerminal(dispatchIdentity, reason);
      }
      const { nextTool, ...resultPatch } = writerDecision;
      if (writerDecision.isError === true || !nextTool) {
        restoreB2WriterQueueToolsForSession(sid);
      } else {
        restrictB2WriterQueueTools(sid, readGateState(projectRoot, sid), nextTool);
      }
      return resultPatch;
    }
    const editorPlannerDecision = await reportEditorPlannerResultDecision(
      contractEvent,
      projectRoot,
      sid
    );
    if (editorPlannerDecision) {
      const terminalReason = editorPlannerDecision.isError === true
        ? runtimeTimeout
          ? `子代理运行超时：${runtimeTimeout}`
          : "Planner 返回、materialize 或 B25 自动收尾未通过"
        : "typed semantic plan 已验收并自动完成 B25";
      markContractTerminal(dispatchIdentity, terminalReason);
      const { nextTool, ...resultPatch } = editorPlannerDecision;
      if (editorPlannerDecision.isError !== true && nextTool) {
        restrictB3HandoffTools(sid, readGateState(projectRoot, sid), nextTool);
      }
      return resultPatch;
    }
    const researcherDecision = settleResearcherContractEvent(
      sid,
      contractEvent,
      dispatchIdentity,
      runtimeTimeout
    );
    if (researcherDecision) return researcherDecision;
    const reviewerDecision = await reportReviewerResultDecision(
      contractEvent,
      projectRoot,
      sid
    );
    if (reviewerDecision) {
      const details = isObject(contractEvent.details) ? contractEvent.details : null;
      const results = Array.isArray(details?.results) ? details.results : [];
      const output = results.length === 1 && isObject(results[0]) && isObject(results[0].structuredOutput)
        ? results[0].structuredOutput
        : null;
      const acceptedStatus = reviewerDecision.isError !== true && typeof output?.status === "string"
        ? output.status
        : null;
      markContractTerminal(
        dispatchIdentity,
        acceptedStatus
          ? `结构化 status=${acceptedStatus} 已验收`
          : "Reviewer 返回或落盘产物未通过父级契约校验"
      );
      const attempt = dispatchIdentity?.role === "report-reviewer"
        ? dispatchIdentity.attempt
        : null;
      if (attempt) {
        // A child-declared status is authoritative only after the parent has
        // validated both structured output and persisted artifacts/layout.
        // In particular, a rejected `status=passed` must never unlock
        // `stage-gate finish`.
        const status = acceptedStatus && ["passed", "failed", "infrastructure_error"].includes(acceptedStatus)
          ? acceptedStatus as ReviewerParentTerminal["status"]
          : "contract_error";
        reviewerParentTerminals.set(
          sid,
          persistReviewerParentTerminal(projectRoot, sid, attempt, status)
        );
      }
      return reviewerDecision;
    }
    const designerDecision = await reportDesignerResultDecision(
      contractEvent,
      projectRoot,
      sid
    );
    if (designerDecision) {
      const details = isObject(contractEvent.details) ? contractEvent.details : null;
      const results = Array.isArray(details?.results) ? details.results : [];
      const output = results.length === 1 && isObject(results[0]) && isObject(results[0].structuredOutput)
        ? results[0].structuredOutput
        : null;
      const terminalReason = designerDecision.isError !== true && typeof output?.status === "string"
        ? `结构化 status=${output.status} 已验收`
        : runtimeTimeout
          ? `子代理运行超时：${runtimeTimeout}`
          : "Designer 返回或 HTML 产物未通过父级契约校验";
      markContractTerminal(dispatchIdentity, terminalReason);
      return designerDecision;
    }
    if (dispatchIdentity?.role === "report-reviewer" && contractEvent.isError === true) {
      const attempt = dispatchIdentity.attempt;
      if (attempt) {
        reviewerParentTerminals.set(
          sid,
          persistReviewerParentTerminal(projectRoot, sid, attempt, "contract_error")
        );
      }
    }
    const toolCallId = (event as PiToolResultEvent).toolCallId;
    if (!toolCallId) return undefined;
    const tracked = finishingToolCalls.get(toolCallId);
    if (tracked) {
      finishingToolCalls.delete(toolCallId);
      finishingSessions.delete(tracked.sessionId);

      const state = readGateState(projectRoot, tracked.sessionId);
      const stage = state?.stages?.[tracked.stageId];
      const transitioned =
        tracked.operation === "fail"
          ? stage?.status === "failed"
          : stage?.status === "completed" || stage?.status === "awaiting_approval";
      const internalSuccess =
        tracked.operation === "finish" && STAGE_DEFINITIONS[tracked.stageId]?.internal === true;
      if (state && transitioned && !internalSuccess) {
        const message = formatGateMessage(state, { stageId: tracked.stageId });
        ctx?.ui?.notify?.(message, tracked.operation === "fail" ? "warning" : "info");
      }
      if (tracked.operation === "finish" && tracked.stageId === "B4_REVIEW") {
        const debugB5Skip = autoSkipB5DesignForFixedDebugSession(tracked.sessionId, ctx);
        if (debugB5Skip?.handled) {
          return {
            isError: !debugB5Skip.ok,
            content: [
              ...(toolResultEvent.content || []),
              { type: "text", text: debugB5Skip.text },
            ],
            details: toolResultEvent.details,
          };
        }
      }
    }
    return undefined;
  });

  const pauseRunningGate = (_event: unknown, ctx?: PiExtensionContext) => {
    staleUnknownHtmlReportTurn = false;
    const sid = sessionId(ctx);
    if (!sid || sid === "unknown") return undefined;
    resetInflightB2StartupStatusForSession(sid);
    restoreB2StartupToolsForSession(sid);
    restoreB2WriterQueueToolsForSession(sid);
    resetB25BootstrapForSession(sid);
    restoreB3HandoffToolsForSession(sid);
    const state = readGateState(projectRoot, sid);
    if (state?.status === "running" && !stageRunnerInFlightSessions.has(sid)) {
      runStageGate(projectRoot, sid, "pause", ["--reason", "Pi agent settled"]);
    }
    restoreStageRunnerToolsForSession(sid);
    if (sid && sid !== "unknown" && !stageRunnerInFlightSessions.has(sid)) endStageProgress(sid, ctx);
    return undefined;
  };
  pi.on?.("session_start", (_event: unknown, ctx?: PiExtensionContext) => {
    transportManager?.reset();
    const sid = sessionId(ctx);
    if (sid && sid !== "unknown") {
      stageProgressSessions.delete(sid);
      syncStageRunnerTools(sid, readGateState(projectRoot, sid));
    }
    return undefined;
  });
  pi.on?.("agent_settled", pauseRunningGate);
  pi.on?.("session_shutdown", (event: unknown, ctx?: PiExtensionContext) => {
    pauseRunningGate(event, ctx);
    transportManager?.reset();
    const sid = sessionId(ctx);
    endStageProgress(sid && sid !== "unknown" ? sid : "", ctx);
    if (sid && sid !== "unknown") stopHtmlReportSidecars(projectRoot, sid);
    return undefined;
  });
}
