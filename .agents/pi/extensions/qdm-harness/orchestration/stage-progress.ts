import type {
  ReportAgentProgress,
  ReportAgentStage,
  ReportAgentTransportKind,
} from "./contracts.ts";

export const HTML_REPORT_STAGE_PROGRESS_KIND = "html-report-stage-progress";
export const HTML_REPORT_STAGE_PROGRESS_VERSION = 1;
export const HTML_REPORT_STAGE_PROGRESS_PRODUCER = "qdm-harness";

export const MAX_PROGRESS_ITEMS = 50;
export const MAX_PROGRESS_LABEL = 40;
export const MAX_PROGRESS_OUTPUT = 80;
export const MAX_PROGRESS_ERROR = 120;
export const MAX_PROGRESS_TOOL = 40;

export const STAGE_PROGRESS_PHASE = {
  prefetch: "prefetch",
  writerAgents: "writer-agents",
  captionGate: "caption-gate",
  composeMain: "compose-main",
  awaitingApproval: "awaiting-approval",
  sourceInventory: "source-inventory",
  planner: "planner",
  researchers: "researchers",
  finalizer: "finalizer",
  qualityPreflight: "quality-preflight",
  reviewer: "reviewer",
  layoutCheck: "layout-check",
  designer: "designer",
  skipped: "skipped",
} as const;

export type HtmlReportProgressItemStatus =
  | "pending"
  | "dispatching"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type HtmlReportProgressRole =
  | "writer"
  | "planner"
  | "researcher"
  | "reviewer"
  | "designer";

export interface HtmlReportProgressItem {
  id: string;
  role: HtmlReportProgressRole;
  status: HtmlReportProgressItemStatus;
  label: string;
  cardId?: string;
  taskId?: string;
  agent?: string;
  currentTool?: string;
  durationMs?: number;
  tokens?: number;
  recentOutput?: string;
  error?: string;
  attempt?: number;
  maxAttempts?: number;
  invocationId?: string;
  requestId?: string;
  runId?: string;
}

export interface HtmlReportStageProgressV1 {
  kind: typeof HTML_REPORT_STAGE_PROGRESS_KIND;
  version: typeof HTML_REPORT_STAGE_PROGRESS_VERSION;
  producer: typeof HTML_REPORT_STAGE_PROGRESS_PRODUCER;
  sessionId: string;
  attempt: string;
  entryStage: ReportAgentStage;
  currentStage: ReportAgentStage;
  status: "running" | "completed" | "failed";
  phase: string;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  currentItemId?: string;
  omitted?: number;
  items: HtmlReportProgressItem[];
  transport?: ReportAgentTransportKind;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface HtmlReportProgressItemSeed {
  id: string;
  role: HtmlReportProgressRole;
  label: string;
  status?: HtmlReportProgressItemStatus;
  cardId?: string;
  taskId?: string;
  agent?: string;
  attempt?: number;
  maxAttempts?: number;
  error?: string;
}

export interface HtmlReportStageProgressInit {
  sessionId: string;
  attempt: string;
  entryStage: ReportAgentStage;
  currentStage?: ReportAgentStage;
  phase: string;
  items?: HtmlReportProgressItemSeed[];
  transport?: ReportAgentTransportKind;
  now?: () => Date;
}

export interface ProgressTheme {
  fg?(token: string, text: string): string;
  bold?(text: string): string;
  dim?(text: string): string;
}

export interface ProgressComponent {
  render(width: number): string[];
}

export interface StageProgressPublishTarget {
  onUpdate?: (update: unknown) => void;
}

export type ProgressWidthTier = "wide" | "medium" | "narrow";

export interface ProgressWindow {
  tier: ProgressWidthTier;
  failed: HtmlReportProgressItem[];
  recentCompleted: HtmlReportProgressItem[];
  current?: HtmlReportProgressItem;
  upcoming: HtmlReportProgressItem[];
  hiddenCompleted: number;
  hiddenPending: number;
  hiddenFailed: number;
  showCurrentDetail: boolean;
  compactHeader: boolean;
}

export interface StageProgressRenderOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

const STATUS_GLYPH: Record<HtmlReportProgressItemStatus, string> = {
  pending: "○",
  dispatching: "◌",
  running: "▶",
  completed: "✓",
  failed: "!",
  skipped: "–",
};

const UNIT_WIDTH_CHARS = new Set(["○", "◌", "▶", "✓", "!", "–", "…", "·"]);

const STAGE_SHORT: Record<ReportAgentStage, string> = {
  B2_WRITER: "B2 Writer",
  B25_EDITOR: "B25 Editor",
  B3_RESEARCH: "B3 Research",
  B4_REVIEW: "B4 Review",
  B5_DESIGN: "B5 Design",
};

const STAGE_FOOTER: Record<ReportAgentStage, string> = {
  B2_WRITER: "B2",
  B25_EDITOR: "B25",
  B3_RESEARCH: "B3",
  B4_REVIEW: "B4",
  B5_DESIGN: "B5",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function truncateProgressText(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  if (collapsed.length <= max) return collapsed;
  if (max <= 1) return "…";
  return `${collapsed.slice(0, max - 1)}…`;
}

function cloneSeed(seed: HtmlReportProgressItemSeed): HtmlReportProgressItem {
  return {
    id: seed.id,
    role: seed.role,
    status: seed.status || "pending",
    label: seed.label,
    ...(seed.cardId ? { cardId: seed.cardId } : {}),
    ...(seed.taskId ? { taskId: seed.taskId } : {}),
    ...(seed.agent ? { agent: seed.agent } : {}),
    ...(seed.attempt !== undefined ? { attempt: seed.attempt } : {}),
    ...(seed.maxAttempts !== undefined ? { maxAttempts: seed.maxAttempts } : {}),
    ...(seed.error ? { error: seed.error } : {}),
  };
}

function snapshotItem(item: HtmlReportProgressItem): HtmlReportProgressItem {
  return {
    ...item,
    label: truncateProgressText(item.label, MAX_PROGRESS_LABEL) || item.id,
    ...(item.currentTool
      ? { currentTool: truncateProgressText(item.currentTool, MAX_PROGRESS_TOOL) || item.currentTool }
      : {}),
    ...(item.recentOutput
      ? { recentOutput: truncateProgressText(item.recentOutput, MAX_PROGRESS_OUTPUT) }
      : {}),
    ...(item.error ? { error: truncateProgressText(item.error, MAX_PROGRESS_ERROR) } : {}),
  };
}

function countByStatus(items: HtmlReportProgressItem[]): Pick<HtmlReportStageProgressV1, "total" | "completed" | "failed" | "pending"> {
  let completed = 0;
  let failed = 0;
  let pending = 0;
  for (const item of items) {
    if (item.status === "completed" || item.status === "skipped") completed += 1;
    else if (item.status === "failed") failed += 1;
    else pending += 1;
  }
  return { total: items.length, completed, failed, pending };
}

function currentItemId(items: HtmlReportProgressItem[]): string | undefined {
  const running = items.find((item) => item.status === "running")
    || items.find((item) => item.status === "dispatching");
  return running?.id;
}

export function writerProgressSeed(
  card: { id: string; title?: unknown },
  status: HtmlReportProgressItemStatus = "pending",
): HtmlReportProgressItemSeed {
  const id = String(card.id);
  return {
    id,
    role: "writer",
    label: String(card.title || id),
    status,
    cardId: id,
    taskId: id,
    agent: "report-writer",
  };
}

export function researcherProgressSeed(
  task: { id?: unknown; goal?: unknown; question?: unknown },
): HtmlReportProgressItemSeed {
  const id = String(task.id || "").trim();
  return {
    id,
    role: "researcher",
    label: String(task.goal || task.question || id),
    status: "pending",
    taskId: id,
    agent: "report-researcher",
    attempt: 1,
    maxAttempts: 2,
  };
}

export class HtmlReportStageProgressTracker {
  readonly sessionId: string;
  readonly attempt: string;
  readonly entryStage: ReportAgentStage;
  readonly startedAt: string;
  #currentStage: ReportAgentStage;
  #status: HtmlReportStageProgressV1["status"] = "running";
  #phase: string;
  #transport?: ReportAgentTransportKind;
  #items: HtmlReportProgressItem[];
  #updatedAt: string;
  #endedAt?: string;
  #now: () => Date;

  constructor(init: HtmlReportStageProgressInit) {
    this.#now = init.now || (() => new Date());
    const at = this.#now().toISOString();
    this.sessionId = init.sessionId;
    this.attempt = init.attempt;
    this.entryStage = init.entryStage;
    this.#currentStage = init.currentStage || init.entryStage;
    this.#phase = init.phase;
    this.#transport = init.transport;
    this.#items = (init.items || []).map(cloneSeed);
    this.startedAt = at;
    this.#updatedAt = at;
  }

  #touch(): void {
    this.#updatedAt = this.#now().toISOString();
  }

  #item(itemId: string): HtmlReportProgressItem | undefined {
    return this.#items.find((item) => item.id === itemId);
  }

  setPhase(phase: string, currentStage?: ReportAgentStage): void {
    this.#phase = phase;
    if (currentStage) this.#currentStage = currentStage;
    this.#touch();
  }

  setCurrentStage(stage: ReportAgentStage): void {
    this.#currentStage = stage;
    this.#touch();
  }

  setTransport(transport: ReportAgentTransportKind): void {
    this.#transport = transport;
    this.#touch();
  }

  replaceItems(items: HtmlReportProgressItemSeed[]): void {
    this.#items = items.map(cloneSeed);
    this.#touch();
  }

  addItems(items: HtmlReportProgressItemSeed[]): void {
    const seen = new Set(this.#items.map((item) => item.id));
    for (const seed of items) {
      if (!seed.id || seen.has(seed.id)) continue;
      this.#items.push(cloneSeed(seed));
      seen.add(seed.id);
    }
    this.#touch();
  }

  noteAttempt(itemId: string, attempt: number, maxAttempts: number): void {
    const item = this.#item(itemId);
    if (!item) return;
    item.attempt = attempt;
    item.maxAttempts = maxAttempts;
    this.#touch();
  }

  markDispatching(
    itemId: string,
    identity: {
      invocationId?: string;
      agent?: string;
      cardId?: string;
      taskId?: string;
      role?: HtmlReportProgressRole;
    } = {},
  ): void {
    const item = this.#item(itemId);
    if (!item || item.status === "completed" || item.status === "skipped") return;
    item.status = "dispatching";
    if (identity.invocationId) item.invocationId = identity.invocationId;
    if (identity.agent) item.agent = identity.agent;
    if (identity.cardId) item.cardId = identity.cardId;
    if (identity.taskId) item.taskId = identity.taskId;
    if (identity.role) item.role = identity.role;
    item.currentTool = undefined;
    this.#touch();
  }

  markStarted(
    itemId: string,
    progress: Pick<ReportAgentProgress, "requestId" | "runId" | "transport"> = { requestId: "" },
  ): void {
    const item = this.#item(itemId);
    if (!item || item.status === "completed" || item.status === "failed" || item.status === "skipped") return;
    item.status = "running";
    if (progress.requestId) item.requestId = progress.requestId;
    if (progress.runId) item.runId = progress.runId;
    this.#touch();
  }

  markUpdate(itemId: string, progress: Partial<ReportAgentProgress>): void {
    const item = this.#item(itemId);
    if (!item || item.status === "completed" || item.status === "failed" || item.status === "skipped") return;
    if (item.status === "pending" || item.status === "dispatching") item.status = "running";
    if (progress.requestId) item.requestId = progress.requestId;
    if (progress.runId) item.runId = progress.runId;
    if (typeof progress.currentTool === "string") item.currentTool = progress.currentTool;
    if (typeof progress.recentOutput === "string") item.recentOutput = progress.recentOutput;
    if (typeof progress.durationMs === "number") item.durationMs = progress.durationMs;
    if (typeof progress.tokens === "number") item.tokens = progress.tokens;
    this.#touch();
  }

  markCompleted(itemId: string, extra: { durationMs?: number; tokens?: number } = {}): void {
    const item = this.#item(itemId);
    if (!item || item.status === "failed" || item.status === "skipped") return;
    item.status = "completed";
    item.currentTool = undefined;
    if (extra.durationMs !== undefined) item.durationMs = extra.durationMs;
    if (extra.tokens !== undefined) item.tokens = extra.tokens;
    this.#touch();
  }

  markFailed(itemId: string, error: string, extra: { durationMs?: number; tokens?: number } = {}): void {
    const item = this.#item(itemId);
    if (!item || item.status === "completed" || item.status === "skipped") return;
    item.status = "failed";
    item.error = error;
    if (extra.durationMs !== undefined) item.durationMs = extra.durationMs;
    if (extra.tokens !== undefined) item.tokens = extra.tokens;
    this.#touch();
  }

  markSkipped(itemId: string, reason?: string): void {
    const item = this.#item(itemId);
    if (!item || item.status === "failed") return;
    item.status = "skipped";
    item.currentTool = undefined;
    if (reason) item.error = reason;
    this.#touch();
  }

  completeStage(): void {
    this.#status = "completed";
    this.#endedAt = this.#now().toISOString();
    this.#touch();
  }

  failStage(error?: string): void {
    this.#status = "failed";
    this.#endedAt = this.#now().toISOString();
    if (error) {
      const current = this.#item(currentItemId(this.#items) || "") || this.#items.find((item) => item.status === "running" || item.status === "dispatching");
      if (current && current.status !== "completed" && current.status !== "skipped") {
        current.status = "failed";
        current.error = current.error || error;
      }
    }
    this.#touch();
  }

  applyChildProgress(itemId: string, progress: ReportAgentProgress): void {
    if (progress.transport) this.setTransport(progress.transport);
    const item = this.#item(itemId);
    if (!item) return;
    if (item.status === "pending" || item.status === "dispatching" || (progress.started && item.status !== "running")) {
      this.markStarted(itemId, progress);
    }
    if (
      progress.currentTool !== undefined ||
      progress.recentOutput !== undefined ||
      progress.durationMs !== undefined ||
      progress.tokens !== undefined ||
      progress.runId !== undefined
    ) {
      this.markUpdate(itemId, progress);
    }
  }

  snapshot(): HtmlReportStageProgressV1 {
    const counts = countByStatus(this.#items);
    const omitted = Math.max(0, this.#items.length - MAX_PROGRESS_ITEMS);
    const visible = this.#items.slice(0, MAX_PROGRESS_ITEMS).map(snapshotItem);
    const current = currentItemId(this.#items);
    return {
      kind: HTML_REPORT_STAGE_PROGRESS_KIND,
      version: HTML_REPORT_STAGE_PROGRESS_VERSION,
      producer: HTML_REPORT_STAGE_PROGRESS_PRODUCER,
      sessionId: this.sessionId,
      attempt: this.attempt,
      entryStage: this.entryStage,
      currentStage: this.#currentStage,
      status: this.#status,
      phase: this.#phase,
      ...counts,
      ...(current ? { currentItemId: current } : {}),
      ...(omitted ? { omitted } : {}),
      items: visible,
      ...(this.#transport ? { transport: this.#transport } : {}),
      startedAt: this.startedAt,
      updatedAt: this.#updatedAt,
      ...(this.#endedAt ? { endedAt: this.#endedAt } : {}),
    };
  }
}

export function isHtmlReportStageProgress(value: unknown): value is HtmlReportStageProgressV1 {
  return isObject(value) &&
    value.kind === HTML_REPORT_STAGE_PROGRESS_KIND &&
    value.version === HTML_REPORT_STAGE_PROGRESS_VERSION &&
    value.producer === HTML_REPORT_STAGE_PROGRESS_PRODUCER &&
    typeof value.sessionId === "string" &&
    typeof value.attempt === "string" &&
    typeof value.entryStage === "string" &&
    typeof value.currentStage === "string" &&
    typeof value.status === "string" &&
    typeof value.phase === "string" &&
    typeof value.total === "number" &&
    typeof value.completed === "number" &&
    typeof value.failed === "number" &&
    typeof value.pending === "number" &&
    Array.isArray(value.items);
}

export function parseStageProgress(value: unknown): HtmlReportStageProgressV1 | null {
  return isHtmlReportStageProgress(value) ? value : null;
}

export function extractStageProgress(details: unknown): HtmlReportStageProgressV1 | null {
  if (!isObject(details)) return null;
  return parseStageProgress(details.progress) ||
    parseStageProgress(details) ||
    (isObject(details.stage) ? parseStageProgress(details.stage.progress) : null);
}

function paint(theme: ProgressTheme | undefined, token: string, text: string): string {
  return theme?.fg?.(token, text) ?? text;
}

function bold(theme: ProgressTheme | undefined, text: string): string {
  return theme?.bold?.(text) ?? text;
}

function dim(theme: ProgressTheme | undefined, text: string): string {
  return theme?.dim?.(text) ?? text;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function charDisplayWidth(char: string): number {
  if (UNIT_WIDTH_CHARS.has(char)) return 1;
  return char.charCodeAt(0) > 127 ? 2 : 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += charDisplayWidth(char);
  }
  return width;
}

export function progressLineWidth(text: string): number {
  return displayWidth(text);
}

function clipAnsiLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return "…";
  let width = 0;
  let out = "";
  const target = maxWidth - 1;
  const ansi = /\x1b\[[0-9;]*m/y;
  let index = 0;
  while (index < text.length) {
    ansi.lastIndex = index;
    const match = ansi.exec(text);
    if (match) {
      out += match[0];
      index += match[0].length;
      continue;
    }
    const char = text[index];
    const next = charDisplayWidth(char);
    if (width + next > target) break;
    out += char;
    width += next;
    index += 1;
  }
  return `${out}…`;
}

class StaticLines implements ProgressComponent {
  #lines: string[];
  constructor(lines: string[]) {
    this.#lines = lines;
  }
  render(width: number): string[] {
    const max = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
    return this.#lines.map((line) => clipAnsiLine(line, max));
  }
}

class ComputedLines implements ProgressComponent {
  #compute: (width: number) => string[];
  constructor(compute: (width: number) => string[]) {
    this.#compute = compute;
  }
  render(width: number): string[] {
    const max = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
    try {
      return this.#compute(max).map((line) => clipAnsiLine(line, max));
    } catch {
      return ["html-report stage"];
    }
  }
}

export function formatProgressDuration(durationMs: number | undefined): string | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatProgressBar(completed: number, total: number, width = 14): string {
  const safeTotal = Math.max(0, total);
  const filled = safeTotal === 0 ? 0 : Math.min(width, Math.round((Math.max(0, completed) / safeTotal) * width));
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

function fraction(progress: HtmlReportStageProgressV1): string {
  return `${progress.completed}/${progress.total}`;
}

function currentItem(progress: HtmlReportStageProgressV1): HtmlReportProgressItem | undefined {
  if (progress.currentItemId) {
    const match = progress.items.find((item) => item.id === progress.currentItemId);
    if (match) return match;
  }
  return progress.items.find((item) => item.status === "running" || item.status === "dispatching");
}

function currentSummary(item: HtmlReportProgressItem | undefined): string | undefined {
  if (!item) return undefined;
  const label = item.label || item.id;
  const tool = item.currentTool;
  const duration = formatProgressDuration(item.durationMs);
  const bits = [item.id !== label ? `${item.id} ${label}` : item.id];
  if (tool) bits.push(tool);
  if (duration) bits.push(duration);
  return bits.join(" · ");
}

function isCompletedLike(status: HtmlReportProgressItemStatus): boolean {
  return status === "completed" || status === "skipped";
}

function isQueuedStatus(status: HtmlReportProgressItemStatus): boolean {
  return status === "pending" || status === "dispatching";
}

function isSingleItemStage(progress: HtmlReportStageProgressV1): boolean {
  return progress.items.length <= 1
    || progress.currentStage === "B4_REVIEW"
    || progress.currentStage === "B5_DESIGN";
}

export function progressWidthTier(width: number): ProgressWidthTier {
  if (width >= 100) return "wide";
  if (width >= 72) return "medium";
  return "narrow";
}

export function selectProgressWindow(
  progress: HtmlReportStageProgressV1,
  width: number,
): ProgressWindow {
  const tier = progressWidthTier(width);
  const items = progress.items;
  const failedAll = items.filter((item) => item.status === "failed");
  const pinnedFailed = failedAll.slice(0, 1);
  const current = currentItem(progress);
  const singleItem = isSingleItemStage(progress);
  const compact = tier === "narrow";

  let completedBudget = 0;
  let upcomingBudget = 0;
  if (tier === "wide") {
    completedBudget = 2;
    upcomingBudget = 2;
  } else if (tier === "medium") {
    completedBudget = 1;
    upcomingBudget = 2;
  }
  if (pinnedFailed.length) completedBudget = Math.max(0, completedBudget - 1);
  if (singleItem || compact) {
    completedBudget = 0;
    upcomingBudget = 0;
  }
  if (!current) {
    upcomingBudget += completedBudget + (singleItem || compact ? 0 : 1);
    completedBudget = 0;
  }

  const focusIndex = current
    ? items.findIndex((item) => item.id === current.id)
    : items.findIndex((item) => isQueuedStatus(item.status));

  const recentCompleted: HtmlReportProgressItem[] = [];
  const upcoming: HtmlReportProgressItem[] = [];
  if (focusIndex >= 0 && current) {
    for (let index = focusIndex - 1; index >= 0 && recentCompleted.length < completedBudget; index -= 1) {
      if (isCompletedLike(items[index].status)) recentCompleted.push(items[index]);
    }
    recentCompleted.reverse();
    for (let index = focusIndex + 1; index < items.length && upcoming.length < upcomingBudget; index += 1) {
      if (isQueuedStatus(items[index].status)) upcoming.push(items[index]);
    }
  } else if (focusIndex >= 0) {
    for (let index = focusIndex; index < items.length && upcoming.length < upcomingBudget; index += 1) {
      if (isQueuedStatus(items[index].status)) upcoming.push(items[index]);
    }
  }

  const shown = new Set<string>();
  for (const item of pinnedFailed) shown.add(item.id);
  for (const item of recentCompleted) shown.add(item.id);
  if (current) shown.add(current.id);
  for (const item of upcoming) shown.add(item.id);

  let hiddenCompleted = 0;
  let hiddenPending = 0;
  for (const item of items) {
    if (shown.has(item.id)) continue;
    if (isCompletedLike(item.status)) hiddenCompleted += 1;
    else if (isQueuedStatus(item.status)) hiddenPending += 1;
  }

  return {
    tier,
    failed: pinnedFailed,
    recentCompleted,
    ...(current ? { current } : {}),
    upcoming,
    hiddenCompleted,
    hiddenPending,
    hiddenFailed: Math.max(0, failedAll.length - pinnedFailed.length),
    showCurrentDetail: compact,
    compactHeader: compact,
  };
}

function percentLabel(progress: HtmlReportStageProgressV1): string {
  if (progress.total <= 0) return "0%";
  return `${Math.round((progress.completed / progress.total) * 100)}%`;
}

function humanPhase(phase: string): string {
  return phase.replace(/-/g, " ");
}

function elapsedLabel(progress: HtmlReportStageProgressV1): string | undefined {
  if (!progress.endedAt) return undefined;
  const started = Date.parse(progress.startedAt);
  const ended = Date.parse(progress.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) return undefined;
  return formatProgressDuration(ended - started);
}

function padBetween(left: string, right: string, width: number): string {
  if (!right) return left;
  const gap = width - displayWidth(left) - displayWidth(right);
  if (gap < 1) return `${left} ${right}`;
  return `${left}${" ".repeat(gap)}${right}`;
}

function itemTitle(item: HtmlReportProgressItem): string {
  return item.label && item.label !== item.id ? item.label : "";
}

function currentDetailText(item: HtmlReportProgressItem): string {
  const bits: string[] = [];
  if (item.currentTool) bits.push(item.currentTool);
  else if (item.status === "running" || item.status === "dispatching") bits.push(item.status);
  const duration = formatProgressDuration(item.durationMs);
  if (duration) bits.push(duration);
  if (typeof item.tokens === "number") bits.push(`${item.tokens} tok`);
  return bits.join(" · ");
}

function runningCurrentVariants(item: HtmlReportProgressItem): Array<{ left: string; right: string }> {
  const glyph = STATUS_GLYPH[item.status];
  const title = itemTitle(item);
  const labeled = title ? `${item.id}  ${title}` : item.id;
  const duration = formatProgressDuration(item.durationMs) || "";
  const variants: Array<{ left: string; right: string }> = [];
  if (item.currentTool && typeof item.tokens === "number") {
    variants.push({ left: `${glyph} ${labeled} · ${item.currentTool} · ${item.tokens} tok`, right: duration });
  }
  if (item.currentTool) {
    variants.push({ left: `${glyph} ${labeled} · ${item.currentTool}`, right: duration });
    variants.push({ left: `${glyph} ${labeled} · ${item.currentTool}`, right: "" });
  }
  variants.push({ left: `${glyph} ${labeled} · ${item.status}`, right: duration });
  variants.push({ left: `${glyph} ${item.id} · ${item.status}`, right: "" });
  return variants;
}

function formatQueueLine(
  item: HtmlReportProgressItem,
  width: number,
  theme: ProgressTheme | undefined,
  options: { right?: string; includeDetail?: boolean } = {},
): string {
  if ((item.status === "running" || item.status === "dispatching") && options.includeDetail !== false && !options.right) {
    for (const variant of runningCurrentVariants(item)) {
      const needed = displayWidth(variant.right ? `${variant.left} ${variant.right}` : variant.left);
      if (needed <= width) return padBetween(variant.left, variant.right, width);
    }
    return runningCurrentVariants(item).at(-1)?.left || `${STATUS_GLYPH[item.status]} ${item.id}`;
  }

  const glyph = STATUS_GLYPH[item.status];
  const title = itemTitle(item);
  let body = title ? `${item.id}  ${title}` : item.id;
  if (options.includeDetail !== false && item.status === "failed") {
    const error = item.error || "failed";
    body = title ? `${item.id}  ${title} · ${error}` : `${item.id} · ${error}`;
    if (options.right) body = `${body} · ${options.right}`;
  }
  const left = `${glyph} ${body}`;
  const painted = item.status === "failed"
    ? paint(theme, "error", left)
    : item.status === "completed" || item.status === "skipped" || item.status === "pending"
      ? dim(theme, left)
      : left;
  if (item.status === "failed") return painted;
  const duration = formatProgressDuration(item.durationMs);
  const right = options.right
    || (item.status === "completed" && duration ? duration : "");
  return padBetween(painted, right ? dim(theme, right) : "", width);
}

function formatRunningHeader(
  progress: HtmlReportStageProgressV1,
  theme: ProgressTheme | undefined,
  width: number,
  compact: boolean,
): string {
  const title = paint(theme, "toolTitle", bold(theme, "HTML Report"));
  if (compact) {
    const stage = STAGE_FOOTER[progress.currentStage] || progress.currentStage;
    return `${title} · ${stage} · ${paint(theme, "accent", fraction(progress))} · !${progress.failed}`;
  }
  const stage = STAGE_SHORT[progress.currentStage] || progress.currentStage;
  const left = `${title} · ${stage}`;
  const right = `${paint(theme, "accent", fraction(progress))} · ${percentLabel(progress)} · ${progress.failed} failed`;
  return padBetween(left, right, width);
}

function defaultRunningLines(
  progress: HtmlReportStageProgressV1,
  theme: ProgressTheme | undefined,
  width: number,
): string[] {
  const win = selectProgressWindow(progress, width);
  const lines = [formatRunningHeader(progress, theme, width, win.compactHeader)];

  if (win.failed[0]) {
    const extra = win.hiddenFailed ? `+${win.hiddenFailed} failed` : undefined;
    lines.push(formatQueueLine(win.failed[0], width, theme, { right: extra }));
  }

  for (const item of win.recentCompleted) {
    lines.push(formatQueueLine(item, width, theme));
  }

  if (win.current) {
    if (win.showCurrentDetail) {
      lines.push(formatQueueLine(win.current, width, theme, { includeDetail: false }));
      const detail = currentDetailText(win.current);
      if (detail) lines.push(dim(theme, `  ${detail}`));
    } else {
      lines.push(formatQueueLine(win.current, width, theme));
    }
  }

  if (win.upcoming.length) {
    win.upcoming.forEach((item, index) => {
      const last = index === win.upcoming.length - 1;
      const right = last && win.hiddenPending ? `+${win.hiddenPending} queued` : undefined;
      lines.push(formatQueueLine(item, width, theme, { right }));
    });
  } else if (win.hiddenPending && !win.failed[0]) {
    lines.push(dim(theme, `${STATUS_GLYPH.pending} ${win.hiddenPending} queued`));
  } else if (!win.current && !win.upcoming.length && !win.failed[0] && progress.status === "running") {
    lines.push(dim(theme, `phase: ${humanPhase(progress.phase)}`));
  }

  return lines;
}

function defaultTerminalLines(
  progress: HtmlReportStageProgressV1,
  theme?: ProgressTheme,
): string[] {
  const stage = STAGE_SHORT[progress.currentStage] || progress.currentStage;
  const elapsed = elapsedLabel(progress);
  if (progress.status === "failed") {
    const firstFailed = progress.items.find((item) => item.status === "failed");
    const title = paint(
      theme,
      "error",
      `! HTML Report · ${stage} · ${fraction(progress)} · ${progress.failed} failed`,
    );
    const titleBit = firstFailed
      ? `${firstFailed.id}${itemTitle(firstFailed) ? ` ${itemTitle(firstFailed)}` : ""}`
      : "";
    const error = firstFailed?.error || "failed";
    return [title, titleBit ? `${titleBit} · ${error}` : error];
  }
  const glyph = progress.items.some((item) => item.status === "skipped") && progress.completed === progress.total
    && progress.items.every((item) => item.status === "skipped")
    ? STATUS_GLYPH.skipped
    : STATUS_GLYPH.completed;
  const title = `${glyph} HTML Report · ${stage} · ${fraction(progress)}${elapsed ? ` · ${elapsed}` : ""}`;
  return [title, `${progress.completed} completed · ${progress.failed} failed · ${humanPhase(progress.phase)}`];
}

function useTerminalDensity(progress: HtmlReportStageProgressV1): boolean {
  return progress.status === "completed" || progress.status === "failed";
}

function defaultLines(
  progress: HtmlReportStageProgressV1,
  theme: ProgressTheme | undefined,
  width: number,
): string[] {
  return useTerminalDensity(progress)
    ? defaultTerminalLines(progress, theme)
    : defaultRunningLines(progress, theme, width);
}

export function renderStageProgressPlainText(progress: HtmlReportStageProgressV1): string {
  const stage = STAGE_SHORT[progress.currentStage] || progress.currentStage;
  const current = currentItem(progress);
  const lines = [
    `html-report · ${stage} ${formatProgressBar(progress.completed, progress.total)} ${fraction(progress)}`,
  ];
  if (current) lines.push(`current: ${currentSummary(current)}`);
  if (progress.failed) {
    for (const item of progress.items.filter((entry) => entry.status === "failed")) {
      lines.push(`failed: ${item.id} ${item.error || "failed"}`.trim());
    }
  }
  return lines.join("\n");
}

function expandedItemLine(item: HtmlReportProgressItem): string {
  const glyph = STATUS_GLYPH[item.status];
  const id = item.id.padEnd(10, " ");
  const label = (item.label || item.id).padEnd(12, " ").slice(0, 12);
  const detail = item.status === "running" || item.status === "dispatching"
    ? (item.currentTool || item.status)
    : item.status === "failed"
      ? (item.error || "failed")
      : item.status === "skipped"
        ? "skipped"
        : item.attempt && item.maxAttempts && item.attempt > 1
          ? `${item.status} ${item.attempt}/${item.maxAttempts}`
          : item.status;
  const duration = formatProgressDuration(item.durationMs) || "";
  return `${glyph} ${id} ${label} ${detail}${duration ? `        ${duration}` : ""}`;
}

function expandedLines(progress: HtmlReportStageProgressV1, theme?: ProgressTheme): string[] {
  const stage = STAGE_SHORT[progress.currentStage] || progress.currentStage;
  const title = `${paint(theme, "toolTitle", bold(theme, "HTML Report"))} · ${stage}`;
  const count = paint(theme, "accent", fraction(progress));
  const lines = [
    `${title}                           ${count}`,
    "------------------------------------------------------",
    ...progress.items.map(expandedItemLine),
  ];
  if (progress.omitted) lines.push(dim(theme, `… ${progress.omitted} more omitted`));
  lines.push("------------------------------------------------------");
  const transport = progress.transport ? ` · transport: ${progress.transport}` : "";
  lines.push(dim(theme, `phase: ${progress.phase}${transport}`));
  lines.push(dim(theme, "Ctrl+O: expand/collapse · Ctrl+Alt+F: inspect active child"));
  return lines;
}

export function renderStageProgressDefault(
  progress: HtmlReportStageProgressV1,
  theme?: ProgressTheme,
): ProgressComponent {
  return new ComputedLines((width) => {
    try {
      return defaultLines(progress, theme, width);
    } catch {
      return renderStageProgressPlainText(progress).split("\n");
    }
  });
}

export function renderStageProgressCollapsed(
  progress: HtmlReportStageProgressV1,
  theme?: ProgressTheme,
): ProgressComponent {
  return renderStageProgressDefault(progress, theme);
}

export function renderStageProgressExpanded(
  progress: HtmlReportStageProgressV1,
  theme?: ProgressTheme,
): ProgressComponent {
  return new StaticLines(expandedLines(progress, theme));
}

export function renderStageProgressCall(
  _args: unknown,
  theme?: ProgressTheme,
): ProgressComponent {
  const title = paint(theme, "toolTitle", bold(theme, "html-report"));
  return new StaticLines([`${title} · run current stage`]);
}

export function renderStageProgressResult(
  result: { details?: unknown; content?: unknown; isError?: boolean },
  options: StageProgressRenderOptions = {},
  theme?: ProgressTheme,
): ProgressComponent {
  try {
    const progress = extractStageProgress(result.details);
    if (progress) {
      return options.expanded
        ? renderStageProgressExpanded(progress, theme)
        : renderStageProgressDefault(progress, theme);
    }
    const text = Array.isArray(result.content)
      ? result.content
        .filter((part) => isObject(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("\n")
        .trim()
      : "";
    return new StaticLines([text || "html-report stage"]);
  } catch {
    return new StaticLines(["html-report stage"]);
  }
}

export class HtmlReportStageProgressSession {
  readonly tracker: HtmlReportStageProgressTracker;
  #onUpdate?: (update: unknown) => void;

  constructor(
    init: HtmlReportStageProgressInit,
    target: StageProgressPublishTarget = {},
  ) {
    this.tracker = new HtmlReportStageProgressTracker(init);
    this.#onUpdate = target.onUpdate;
  }

  bind(target: StageProgressPublishTarget): void {
    if (target.onUpdate) this.#onUpdate = target.onUpdate;
  }

  publish(): HtmlReportStageProgressV1 {
    const snapshot = this.tracker.snapshot();
    try {
      this.#onUpdate?.({
        content: [{ type: "text", text: renderStageProgressPlainText(snapshot) }],
        details: { progress: snapshot },
      });
    } catch { /* onUpdate failure degrades display only */ }
    return snapshot;
  }

  finish(status: "completed" | "failed", error?: string): HtmlReportStageProgressV1 {
    if (status === "completed") this.tracker.completeStage();
    else this.tracker.failStage(error);
    return this.publish();
  }
}
