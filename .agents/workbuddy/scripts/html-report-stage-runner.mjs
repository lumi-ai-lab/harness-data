#!/usr/bin/env node
/**
 * HTML Report Stage Runner — M0 + M1.
 *
 * 依据 docs/implementer/html-report-stage-runner-alignment-2026-08-22.md：
 *  - M0：固定 CodeBuddy CLI、custom-local:gpt-5.5、角色配置、JSON Schema、
 *        超时/退出码处理；独立 child 可重复得到受校验的结构化输出，无业务
 *        数据/凭据泄露。
 *  - M1：B2 单卡 Writer —— 复用 Pi 取数/evidence/Gate，启动一个
 *        report-writer child，Runner 校验 JSON 后才调用 Pi 逻辑落盘并推进 Gate。
 *
 * 命令面（§8）：
 *   node agents/workbuddy/scripts/html-report-stage-runner.mjs start   --session <id>
 *   node agents/workbuddy/scripts/html-report-stage-runner.mjs advance --session <id>
 *   node agents/workbuddy/scripts/html-report-stage-runner.mjs status  --session <id>
 *   node agents/workbuddy/scripts/html-report-stage-runner.mjs approve --session <id>
 *   node agents/workbuddy/scripts/html-report-stage-runner.mjs retry   --session <id> --task <taskId>
 *   node agents/workbuddy/scripts/html-report-stage-runner.mjs cancel  --session <id>
 *
 * session 目录 = <projectRoot>/.harness/state/html-report/<session-key>，
 * 状态沿用 Pi 既有 stage-gate 契约（$SESSION/debug/pipeline-state.json），
 * 不创建第二份业务状态源。
 *
 * 注意：codebuddy 的 --json-schema 只是提示，不是强制校验。Runner 必须自己
 * 预校验 schema、并后校验 child 输出（JSON 解析 → 角色 Schema → role/taskId/
 * cardId 一致性 → evidence 引用校验），任何失败都不写入正式 session。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalizeJson,
  fetchAllEntries,
  fetchExploreTask,
  metricQueryFromCard,
  persistEditorSourceInventory,
  prepareResearchEvidence,
  prepareSourceFieldInventory,
  rowsSha256,
  validateWriterReturn,
  writerReturnPaths,
} from "../../../packages/html-report-kernel/src/index.mjs";
import { prepareCardCaptionEvidence } from "../../../packages/html-report-kernel/src/evidence/prepare-card-caption-evidence.mjs";
import { validateCaptionSubmissionDetailed, writeCardCaption } from "../../../packages/html-report-kernel/src/captions/submit-card-caption.mjs";
import { composeMain } from "../../../packages/html-report-kernel/src/artifacts/compose-main.mjs";
import { ensureResultUserQuestion } from "../../../packages/harness-runtime-node/src/open-metric-cli-ui.mjs";
import {
  buildEditorPlannerAssignment,
  buildEditorPlanSchema,
  loadEditorPlannerInput,
  persistEditorWriterReturn,
} from "../../pi/skills/html-report/scripts/editor-plan-contract.mjs";
import { materializeEditorPlan } from "../../pi/skills/html-report/scripts/editor-plan.mjs";
import {
  buildResearcherReturnSchema,
  researcherReturnPaths,
  validateResearcherAnalysisRequirements,
  validateResearcherReturn,
} from "../../pi/skills/html-report/scripts/researcher-return.mjs";
import { buildResearcherSubmission, submitResearchFindings } from "../../pi/skills/html-report/scripts/submit-research-findings.mjs";
import { finalizeResearchStage } from "../../pi/skills/html-report/scripts/finalize-research-stage.mjs";
import { applyPipelinePolicy, approvePipelineStage, failPipelineStage, finishPipelineStage } from "../../pi/skills/html-report/scripts/stage-gate.mjs";
import {
  reviewerReturnPaths,
  validateReviewerArtifacts,
} from "../../pi/skills/html-report/scripts/reviewer-return.mjs";
import { submitReviewScorecard } from "../../pi/skills/html-report/scripts/submit-review-scorecard.mjs";
import { runQualityScan } from "../../pi/skills/html-report/scripts/quality-scan.mjs";
import { checkSessionLayout } from "../../pi/skills/html-report/scripts/check-session-layout.mjs";
import {
  buildDesignerReturnSchema,
  designerReturnPaths,
  validateDesignerReturn,
} from "../../pi/skills/html-report/scripts/designer-return.mjs";
import { runCodeBuddyChild } from "./codebuddy-child.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const STAGE_GATE_SCRIPT = resolve(SCRIPT_DIR, "../../pi/skills/html-report/scripts/stage-gate.mjs");

const WRITER_MODEL = "custom-local:gpt-5.5";
const WRITER_ROLE = "report-writer";
const WRITER_TIMEOUT_MS = 120_000; // 对齐文档 §4.3：Writer 120s，Reviewer 150s
const DEFAULT_WRITER_CONCURRENCY = 4;
const MAX_WRITER_CONCURRENCY = 8;
const RUNNER_CHILDREN_FILE = join("debug", "runner-children.json");

// B25 Editor Planner child（角色沿用 report-researcher，负责产出研究计划）。
const EDITOR_MODEL = WRITER_MODEL;
const EDITOR_ROLE = "report-researcher";
const EDITOR_TIMEOUT_MS = 840_000; // 参考 ref-b345：Editor Planner 14 分钟上限

// B3 Research child（角色沿用 report-researcher，逐任务研究分析）。
const RESEARCH_MODEL = WRITER_MODEL;
const RESEARCH_ROLE = "report-researcher";
const RESEARCH_TIMEOUT_MS = 600_000; // 参考 ref-b345：Research 单任务 10 分钟上限
const RESEARCH_EVIDENCE_EMBED_LIMIT = 64 * 1024; // evidence 内嵌上限，超限 fail-closed

// B4 Reviewer child（角色 report-reviewer，产出 raw scorecard，无工具）。
const REVIEWER_MODEL = WRITER_MODEL;
const REVIEWER_ROLE = "report-reviewer";
const REVIEWER_TIMEOUT_MS = 150_000; // 对齐文档 §4.3：Reviewer 150s
const REVIEW_RUBRIC_IDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];

// B5 Designer child（角色 report-designer，执行 compile→compose→capture→finalize 链）。
const DESIGNER_MODEL = WRITER_MODEL;
const DESIGNER_ROLE = "report-designer";
const DESIGNER_TIMEOUT_MS = 300_000; // 参考 ref-b345：Designer 含浏览器截图，上限 5 分钟

export const RUNNER_STAGES = Object.freeze([
  "A_CONFIG",
  "B0_PREFLIGHT",
  "B2_WRITER",
  "B2_MAIN",
  "B25_EDITOR",
  "B3_RESEARCH",
  "B4_REVIEW",
  "B5_DESIGN",
]);

/** Pi 默认只启用到 B2_MAIN（对齐文档 §3.1/§9）；其余阶段 M2-M6 再启用。 */
const DISABLED_RUNNER_STAGES = new Set(["B25_EDITOR", "B3_RESEARCH", "B4_REVIEW", "B5_DESIGN"]);

/**
 * M3-M5 由 Runner 在 init 后程序化启用（stage-gate 无 CLI policy 命令）。
 * gate 语义沿用 Pi：B25/B5 自动完成，B3/B4 为人工 Gate。
 */
export const RUNNER_STAGE_POLICY = Object.freeze({
  B25_EDITOR: { enabled: true, gate: false },
  B3_RESEARCH: { enabled: true, gate: true },
  B4_REVIEW: { enabled: true, gate: true },
  B5_DESIGN: { enabled: true, gate: false },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeSessionId(raw) {
  return String(raw || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sessionStorageKey(raw) {
  return createHash("sha256").update(`workbuddy:${String(raw || "")}`).digest("hex");
}

export function htmlReportSessionDir(projectRoot, sessionId, stateRoot = process.env.HARNESS_STATE_ROOT || "") {
  const base = stateRoot ? resolve(stateRoot) : join(resolve(projectRoot), ".harness", "state");
  return join(base, "html-report", sessionStorageKey(sessionId));
}

function findHarnessRoot(start = process.cwd()) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, ".harness"))) return current;
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

export function resolveProjectRoot(explicit) {
  if (explicit) return resolve(String(explicit));
  const found = findHarnessRoot(process.cwd());
  if (!found) throw new Error("未找到 Harness 项目根目录；请从仓库根目录运行或传入 --root <path>");
  return found;
}

/**
 * Run one stage-gate CLI operation and parse its JSON output.
 * Injectable scriptPath / spawnFn keep the wrapper testable.
 */
export function runStageGate(
  projectRoot,
  sessionId,
  operation,
  args = [],
  { scriptPath = STAGE_GATE_SCRIPT, spawnFn = spawnSync } = {}
) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const result = spawnFn(
    process.execPath,
    [scriptPath, operation, "--session-dir", sessionDir, ...args.map(String)],
    { cwd: resolve(projectRoot), encoding: "utf8" }
  );
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || result.stderr || "null");
  } catch {
    payload = null;
  }
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: payload?.error || (result.stderr || result.stdout || "stage-gate 失败").trim(),
      payload,
    };
  }
  return { ok: true, status: 0, payload };
}

export function writerSchema(cardId) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      role: { const: WRITER_ROLE },
      taskId: { type: "string", minLength: 1 },
      cardId: { const: String(cardId) },
      paragraphs: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 500 } },
    },
    required: ["role", "taskId", "cardId", "paragraphs"],
  };
}

/** Build the writer child prompt: role instructions + evidence capsule. */
export function buildWriterPrompt({ cardId, evidence }) {
  const capsule = JSON.stringify({
    cardId: String(cardId),
    query: {
      metrics: evidence?.query?.metrics || [],
      dimensions: evidence?.query?.dimensions || [],
      time: evidence?.query?.time || null,
    },
    views: evidence?.views || {},
    columnLabels: evidence?.columnLabels || {},
  });
  return [
    `你是 html-report 的 Report Writer。处理卡片 cardId=${cardId}。`,
    "证据（evidence views，topN/bottomN）已包含在下面 capsule JSON 中。",
    "写 1-3 句结论（who-is-high / who-is-low），只引用证据里出现的数字、日期、指标名和维度名。",
    "禁止编造总数、阈值、行数；禁止提到 rowCount、views、capsule 等结构词。",
    "输出必须严格符合 schema：顶层对象只允许 role、taskId、cardId、paragraphs 四个字段",
    `（role 固定 "report-writer"，taskId 用 "${cardId}",cardId 固定 "${cardId}"，paragraphs 是字符串数组）。`,
    "不要用 conclusion 等其他字段名。",
    "",
    "capsule JSON:",
    capsule,
    "",
    "只输出 JSON，不要其他文字。",
  ].join("\n");
}

/** Normalize a child caption object: accept common alias `conclusion` → `paragraphs`. */
export function normalizeWriterChildValue(value, cardId) {
  if (!isPlainObject(value)) return { ok: false, error: "child 输出不是对象" };
  if (value.role !== WRITER_ROLE) return { ok: false, error: `role 不匹配，期望 ${WRITER_ROLE}` };
  if (String(value.cardId ?? "") !== String(cardId)) {
    return { ok: false, error: `cardId 不匹配，期望 ${cardId}` };
  }
  let paragraphs = Array.isArray(value.paragraphs) ? value.paragraphs : null;
  if (paragraphs === null && Array.isArray(value.conclusion)) paragraphs = value.conclusion;
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    return { ok: false, error: "缺少 paragraphs（或 conclusion）数组" };
  }
  const taskId = typeof value.taskId === "string" && value.taskId.trim() ? value.taskId.trim() : String(cardId);
  return { ok: true, value: { role: WRITER_ROLE, taskId, cardId: String(cardId), paragraphs } };
}

function readResult(projectRoot, sessionId) {
  const resultPath = join(htmlReportSessionDir(projectRoot, sessionId), "result.json");
  if (!existsSync(resultPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function confirmedCardIds(result) {
  if (!isPlainObject(result) || result.status !== "confirmed" || !Array.isArray(result.cards)) return [];
  return result.cards
    .map((card) => (isPlainObject(card) ? card.id : null))
    .filter((id) => typeof id === "string" && id.trim());
}

function cardHasCaption(projectRoot, sessionId, cardId) {
  const captionPath = join(htmlReportSessionDir(projectRoot, sessionId), "data", "cards", cardId, "caption.md");
  try {
    return statSync(captionPath).isFile() && statSync(captionPath).size > 0;
  } catch {
    return false;
  }
}

function runnerChildrenPath(projectRoot, sessionId) {
  return join(htmlReportSessionDir(projectRoot, sessionId), RUNNER_CHILDREN_FILE);
}

function readRunnerChildren(projectRoot, sessionId) {
  try {
    const value = JSON.parse(readFileSync(runnerChildrenPath(projectRoot, sessionId), "utf8"));
    return Array.isArray(value) ? value.filter((item) => Number(item?.pid) > 1) : [];
  } catch {
    return [];
  }
}

function writeRunnerChildren(projectRoot, sessionId, children) {
  const path = runnerChildrenPath(projectRoot, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(children, null, 2)}\n`);
}

function registerRunnerChild(projectRoot, sessionId, record) {
  const children = readRunnerChildren(projectRoot, sessionId)
    .filter((item) => item.pid !== record.pid);
  writeRunnerChildren(projectRoot, sessionId, [...children, record]);
}

function unregisterRunnerChild(projectRoot, sessionId, pid) {
  const children = readRunnerChildren(projectRoot, sessionId).filter((item) => item.pid !== pid);
  if (children.length > 0) writeRunnerChildren(projectRoot, sessionId, children);
  else rmSync(runnerChildrenPath(projectRoot, sessionId), { force: true });
}

function killRunnerProcess(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function stopRunnerChildren(projectRoot, sessionId, signal = "SIGTERM") {
  const children = readRunnerChildren(projectRoot, sessionId);
  let stopped = 0;
  for (const child of children) if (killRunnerProcess(child.pid, signal)) stopped += 1;
  if (signal === "SIGKILL" || stopped === children.length) {
    rmSync(runnerChildrenPath(projectRoot, sessionId), { force: true });
  }
  return { stopped, children: children.length };
}

function registeredChildRunner(projectRoot, sessionId, stage, cardId, runChild) {
  return (options) => {
    let pid = 0;
    return runChild({
      ...options,
      onSpawn: (child) => {
        pid = Number(child?.pid || 0);
        registerRunnerChild(projectRoot, sessionId, {
          pid,
          stage,
          cardId,
          startedAt: new Date().toISOString(),
        });
        options.onSpawn?.(child);
      },
      onClose: (outcome) => {
        unregisterRunnerChild(projectRoot, sessionId, pid);
        options.onClose?.(outcome);
      },
    });
  };
}

/** Persist a per-card failure record under $SESSION/data/cards/<id>/caption.violations.json. */
function writeCaptionViolations(resultPath, cardId, error, violations = []) {
  const paths = writerReturnPaths({ sessionDir: dirname(resolve(resultPath)), cardId });
  const cardDir = dirname(paths.captionPath);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(
    join(cardDir, "caption.violations.json"),
    `${JSON.stringify({
      producer: "html-report-stage-runner",
      cardId,
      captionPath: paths.captionPath,
      ok: false,
      error: String(error || "").slice(0, 4000),
      violations: Array.isArray(violations) ? violations : [],
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`
  );
}

/**
 * M1: run the full writer flow for ONE card.
 *
 *   fetch（复用 Pi fetch-entry）→ evidence capsule → report-writer child →
 *   Runner 校验（role/taskId/cardId + evidence 引用）→ writeCardCaption 落盘。
 *
 * Returns a structured attempt record; never throws for a per-card failure so
 * a failing card cannot pollute later cards. Inject runChild/fetchEntries for tests.
 */
export async function runWriterForCard(
  projectRoot,
  sessionId,
  cardId,
  { runChild = runCodeBuddyChild, fetchEntries = fetchAllEntries } = {}
) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const resultPath = join(sessionDir, "result.json");
  const paths = writerReturnPaths({ sessionDir, cardId });
  const childRunner = registeredChildRunner(projectRoot, sessionId, "B2_WRITER", cardId, runChild);
  const attempt = { cardId, status: "running", startedAt: new Date().toISOString() };

  // 1. 取数（复用 Pi fetch-entry；QDM CLI 缺失时 fail-closed）
  let fetched;
  try {
    fetched = await fetchEntries(resultPath, { cardId, parallel: false, projectRoot });
  } catch (error) {
    attempt.status = "failed";
    attempt.error = `取数失败: ${error?.message || error}`;
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }
  const cardResult = Array.isArray(fetched?.cards) ? fetched.cards.find((item) => item?.cardId === cardId) : null;
  if (!cardResult || cardResult.fetchStatus !== "success") {
    attempt.status = "failed";
    attempt.error = cardResult?.error || `卡片 ${cardId} 取数失败`;
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }

  // 2. evidence capsule（复用 Pi prepare-card-caption-evidence）
  let prepared;
  try {
    prepared = await prepareCardCaptionEvidence({ resultPath, cardId });
  } catch (error) {
    attempt.status = "failed";
    attempt.error = `evidence capsule 生成失败: ${error?.message || error}`;
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }
  if (!prepared?.evidence || prepared.evidence.cardId !== cardId) {
    attempt.status = "failed";
    attempt.error = "evidence capsule 生成失败（cardId 不匹配）";
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }

  // 3. 启动 report-writer child（M0 launcher；独立 child，无业务凭据）
  const schema = writerSchema(cardId);
  let child;
  try {
    child = await childRunner({
      prompt: buildWriterPrompt({ cardId, evidence: prepared.evidence }),
      schema,
      sessionId: `${sanitizeSessionId(sessionId)}-writer-${cardId}`,
      cwd: resolve(projectRoot),
      model: WRITER_MODEL,
      timeoutMs: WRITER_TIMEOUT_MS,
    });
  } catch (error) {
    attempt.status = "failed";
    attempt.error = `启动 writer child 失败: ${error?.message || error}`;
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }
  attempt.durationMs = child?.durationMs ?? null;
  if (child?.status !== "completed" || !child?.value) {
    attempt.status = "failed";
    attempt.timedOut = Boolean(child?.timedOut);
    attempt.error = child?.timedOut
      ? `writer child 超时（${WRITER_TIMEOUT_MS}ms）`
      : (child?.message || `writer child ${child?.code || "failed"}`);
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }

  // 4. Runner 校验（对齐文档 §4.3：role/taskId/cardId 一致 + Pi 校验通过）
  const normalized = normalizeWriterChildValue(child.value, cardId);
  if (!normalized.ok) {
    attempt.status = "failed";
    attempt.error = normalized.error;
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }

  // 5. evidence 引用校验（numbers/dates/pointers 必须在 capsule 内）
  let submitted;
  try {
    submitted = validateCaptionSubmissionDetailed({ paragraphs: normalized.value.paragraphs }, prepared.evidence);
  } catch (error) {
    attempt.status = "failed";
    attempt.error = `caption 校验异常: ${error?.message || error}`;
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }
  if (submitted.violations.length > 0) {
    attempt.status = "failed";
    attempt.error = `caption 违规 ${submitted.violations.length} 项`;
    attempt.violations = submitted.violations;
    writeCaptionViolations(resultPath, cardId, attempt.error, submitted.violations);
    return attempt;
  }

  // 6. Pi 逻辑落盘（writeCardCaption 内部会再校验并写 violations 文件）
  try {
    await writeCardCaption({
      input: { paragraphs: normalized.value.paragraphs },
      evidencePath: paths.evidencePath,
      captionPath: paths.captionPath,
    });
  } catch (error) {
    attempt.status = "failed";
    attempt.error = `caption 落盘失败: ${error?.message || error}`;
    writeCaptionViolations(resultPath, cardId, attempt.error);
    return attempt;
  }

  attempt.status = "committed";
  attempt.captionPath = paths.captionPath;
  return attempt;
}

/**
 * M1: B2_WRITER —— 低并发处理每张未完成卡片，卡片隔离（单卡失败不污染后续卡）。
 * 全部成功 → finish B2_WRITER 并自动 start B2_MAIN（人工 Gate 停在 await）。
 * 有失败卡 → 不 finish，保持 running 供 retry，返回失败清单。
 */
export async function runWriterStage(
  projectRoot,
  sessionId,
  { runChild, fetchEntries, writerConcurrency, onProgress } = {}
) {
  const result = readResult(projectRoot, sessionId);
  if (!result) {
    return { ok: false, error: `result.json 不存在或不可读：${htmlReportSessionDir(projectRoot, sessionId)}/result.json` };
  }
  const cardIds = confirmedCardIds(result);
  if (cardIds.length === 0) return { ok: false, error: "result.json 没有可用的 cards[]" };

  const pending = cardIds.filter((cardId) => !cardHasCaption(projectRoot, sessionId, cardId));
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  let processed = cardIds.length - pending.length;
  let completed = processed;
  progress({ stage: "B2_WRITER", status: "running", total: cardIds.length, processed, completed });
  if (pending.length === 0) {
    const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "B2_WRITER"]);
    if (!finished.ok) return { ok: false, error: finished.error || "stage-gate finish B2_WRITER 失败" };
    const started = runStageGate(projectRoot, sessionId, "start", ["--stage", "B2_MAIN"]);
    progress({ stage: "B2_WRITER", status: "completed", total: cardIds.length, processed, completed });
    return { ok: true, message: `全部 ${cardIds.length} 张卡已完成；B2_WRITER 已 finish，B2_MAIN 已开始。`, started };
  }

  const concurrency = resolveWriterConcurrency(writerConcurrency);
  const attempts = await mapWithConcurrency(pending, concurrency, async (cardId) => {
    try {
      const attempt = await runWriterForCard(projectRoot, sessionId, cardId, { runChild, fetchEntries });
      processed += 1;
      if (attempt.status === "committed") completed += 1;
      progress({
        stage: "B2_WRITER",
        status: attempt.status === "committed" ? "completed" : "failed",
        cardId,
        total: cardIds.length,
        processed,
        completed,
        error: attempt.error,
      });
      return attempt;
    } catch (error) {
      processed += 1;
      const message = error?.message || String(error);
      progress({
        stage: "B2_WRITER",
        status: "failed",
        cardId,
        total: cardIds.length,
        processed,
        completed,
        error: message,
      });
      return { cardId, status: "failed", error: message };
    }
  });

  const failed = [];
  const succeeded = [];
  for (const attempt of attempts) {
    const cardId = attempt.cardId;
    if (attempt.status === "committed") {
      succeeded.push(cardId);
    } else {
      failed.push({ cardId, error: attempt.error });
    }
  }

  if (failed.length > 0) {
    const detail = failed.map((item) => `  - ${item.cardId}: ${item.error}`).join("\n");
    return {
      ok: false,
      message: `B2_WRITER 有 ${failed.length} 张卡失败（并发 ${concurrency}，已成功 ${succeeded.length} 张）：\n${detail}\n修复后可 retry --task <cardId> 重试。`,
      failed,
      succeeded,
      pending,
      writerConcurrency: concurrency,
    };
  }

  const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "B2_WRITER"]);
  if (!finished.ok) return { ok: false, error: finished.error || "stage-gate finish B2_WRITER 失败" };
  const started = runStageGate(projectRoot, sessionId, "start", ["--stage", "B2_MAIN"]);
  progress({ stage: "B2_WRITER", status: "completed", total: cardIds.length, processed, completed });
  return { ok: true, message: `B2_WRITER 完成 ${succeeded.length} 张卡（并发 ${concurrency}）；B2_MAIN 已开始（人工 Gate，等待批准）。`, started, succeeded, writerConcurrency: concurrency };
}

function resolveWriterConcurrency(value = process.env.HTML_REPORT_WRITER_CONCURRENCY) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_WRITER_CONCURRENCY;
  return Math.min(parsed, MAX_WRITER_CONCURRENCY);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** M3-M5：阶段是否已由 Runner policy 显式启用。 */
function runnerPolicyEnabled(state, stageId) {
  return state?.policy?.[stageId]?.enabled === true;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 提升文件 mtime 到当前时间，避免早于被重写的 result.json（见 prepareSourceFieldInventory 前置条件）。 */
function bumpFileMtime(path) {
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    try {
      const content = readFileSync(path, "utf8");
      writeFileSync(path, content);
    } catch {
      // 忽略：后续 prepareSourceFieldInventory 会以 fail-closed 兜底
    }
  }
}

/**
 * M3: 从已落盘的 entry 文件构建 editor-planner 缓存（不触发 CLI 重取数）。
 * 当 ensureResultUserQuestion 重写了 result.json（userQuestion 缺失补齐）时，
 * entry 文件 mtime 可能早于 result.json —— 同步提升其 mtime 以满足
 * prepareSourceFieldInventory 的 mtime 前置条件。
 */
export async function prepareEditorPlannerCaches(sessionDir, resultPath, { result, questionChanged = false } = {}) {
  const cards = Array.isArray(result?.cards) ? result.cards.map((card) => card?.id).filter(Boolean) : [];
  if (cards.length === 0) throw new Error("result.json 没有可用 cards[]");
  for (const cardId of cards) {
    const paths = writerReturnPaths({ sessionDir, cardId });
    const data = readJsonFile(paths.dataPath);
    const meta = readJsonFile(paths.metaPath);
    if (data === null || meta === null) {
      throw new Error(`卡片 ${cardId} 缺少 entry.json/entry.meta.json，无法构建 Writer 缓存`);
    }
    const receipt = {
      cardId,
      fetchStatus: "success",
      dataPath: paths.dataPath,
      metaPath: paths.metaPath,
      rowCount: Array.isArray(data) ? data.length : 0,
      rowsSha256: rowsSha256(data),
    };
    const checked = validateWriterReturn(receipt, { cardId, dataPath: paths.dataPath, metaPath: paths.metaPath });
    if (!checked.ok) {
      throw new Error(`卡片 ${cardId} Writer 返回校验失败: ${checked.errors.join("; ")}`);
    }
    if (questionChanged) {
      bumpFileMtime(paths.dataPath);
      bumpFileMtime(paths.metaPath);
    }
    persistEditorWriterReturn(resultPath, receipt);
  }
  persistEditorSourceInventory(resultPath, await prepareSourceFieldInventory(resultPath));
  return { ok: true };
}

/**
 * M3: B25_EDITOR —— 运行 Editor Planner child（report-researcher），
 * Runner 校验并物化版本 2 研究计划（analysis/tasks.json + analysis/main.md），
 * 经 materializeEditorPlan（内部调用 finalize-editor-stage）后 finish B25_EDITOR，
 * gate:false 自动推进到 B3_RESEARCH。
 */
export async function runEditorPlannerStage(
  projectRoot,
  sessionId,
  { runChild = runCodeBuddyChild } = {}
) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const resultPath = join(sessionDir, "result.json");
  const result = readResult(projectRoot, sessionId);
  if (!result) return { ok: false, error: "result.json 不存在或不可读" };
  if (result.status !== "confirmed") {
    return { ok: false, error: `B25_EDITOR 需要 result.status=confirmed，当前为 ${JSON.stringify(result.status)}` };
  }

  // 1. 确保 result.userQuestion（缺失时从 A_CONFIG 问题文件补齐）
  let question;
  try {
    question = await ensureResultUserQuestion(sessionDir, resultPath);
  } catch (error) {
    return { ok: false, error: `B25_EDITOR 准备 userQuestion 失败: ${error?.message || error}` };
  }

  // 2. 构建 editor-planner 缓存（writer-returns + source-inventory）
  try {
    await prepareEditorPlannerCaches(sessionDir, resultPath, {
      result,
      questionChanged: Boolean(question?.changed),
    });
  } catch (error) {
    return { ok: false, error: `B25_EDITOR 准备 planner 缓存失败: ${error?.message || error}` };
  }

  // 3. 加载 planner 输入并启动 child（M0 launcher，独立 child，无业务凭据）
  let input;
  try {
    input = loadEditorPlannerInput(resultPath);
  } catch (error) {
    return { ok: false, error: `B25_EDITOR 加载 planner 输入失败: ${error?.message || error}` };
  }
  let child;
  try {
    child = await runChild({
      prompt: buildEditorPlannerAssignment({ sessionDir, resultPath, input }),
      schema: buildEditorPlanSchema(input),
      sessionId: `${sanitizeSessionId(sessionId)}-editor`,
      cwd: resolve(projectRoot),
      model: EDITOR_MODEL,
      timeoutMs: EDITOR_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, error: `启动 editor planner child 失败: ${error?.message || error}` };
  }
  if (child?.status !== "completed" || !child?.value) {
    return {
      ok: false,
      error: child?.timedOut
        ? `editor planner child 超时（${EDITOR_TIMEOUT_MS}ms）`
        : (child?.message || `editor planner child ${child?.code || "failed"}`),
    };
  }

  // 4. Runner 校验并物化（materializeEditorPlan 内部做语义校验，任何失败都不写正式 session）
  let materialized;
  try {
    materialized = await materializeEditorPlan(resultPath, child.value);
  } catch (error) {
    return { ok: false, error: `Editor Planner 返回校验失败: ${error?.message || error}` };
  }
  if (!materialized?.ok) return { ok: false, error: "Editor Planner 返回校验失败（materializeEditorPlan 未通过）" };

  // 5. finish B25_EDITOR（gate:false → completed → 自动 start B3_RESEARCH）
  const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "B25_EDITOR"]);
  if (!finished.ok) return { ok: false, error: finished.error || "stage-gate finish B25_EDITOR 失败" };
  const after = runStageGate(projectRoot, sessionId, "status");
  return {
    ok: true,
    sessionDir,
    resultPath,
    tasksPath: materialized.tasksPath,
    mainPath: materialized.mainPath,
    taskCount: materialized.taskCount,
    researchTasks: materialized.researchTasks,
    state: after.payload?.state,
    message: `B25_EDITOR 已物化研究计划（${materialized.taskCount} 个任务），完成并进入 ${after.payload?.state?.currentStage}。`,
  };
}

/** 带 error.code 的 fail-closed 阶段错误。 */
function stageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameCanonicalJson(left, right) {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function uniqueCanonical(values) {
  return values.filter((value, index) => values.findIndex((candidate) => sameCanonicalJson(candidate, value)) === index);
}

/**
 * 由源卡 canonical query + task.candidateIndicators/candidateDims +
 * evidenceGap.requiredIndicators/requiredDims 确定性构建补查 payload。
 * 这是 Runner 对 child 返回 needs_new_query 的闭环：补查查询由 Runner 生成，
 * 不依赖 child 提供 queryDelta（child schema 也不允许返回该字段）。
 */
function buildCandidateQuery(sourceQuery, task) {
  const candidate = structuredClone(sourceQuery);
  const gap = isPlainObject(task?.evidenceGap) ? task.evidenceGap : null;
  candidate.metrics = uniqueCanonical([
    ...(Array.isArray(candidate.metrics) ? candidate.metrics : []),
    ...(Array.isArray(task?.candidateIndicators) ? task.candidateIndicators : []),
    ...(Array.isArray(gap?.requiredIndicators) ? gap.requiredIndicators : []),
  ]);
  candidate.dimensions = uniqueCanonical([
    ...(Array.isArray(candidate.dimensions) ? candidate.dimensions : []),
    ...(Array.isArray(task?.candidateDims) ? task.candidateDims : []),
    ...(Array.isArray(gap?.requiredDims) ? gap.requiredDims : []),
  ]);
  return candidate;
}

/**
 * 准备一次 dispatch 的 evidence 包：
 *  - new_query：先由 Runner 确定性补查（fetchExplore 写 data/explore 产物），再走 Pi prepare。
 *  - reuse_entry：直接走 Pi prepare（evidence 包按当前 task 重新生成，保证与后继任务一致）。
 * evidence JSON 超限时 fail-closed（evidence_overflow）。
 */
async function prepareResearchEvidenceForRun({ resultPath, task, fetchExplore }) {
  const mode = String(task?.evidencePlan?.mode || "");
  if (mode === "new_query") {
    const result = readJsonFile(resultPath);
    if (!isPlainObject(result) || result.status !== "confirmed") {
      throw stageError("evidence_invalid", `task ${task.id} new_query 需要 result.status=confirmed`);
    }
    const fromCardId = String(task.fromCardId || "");
    const sourceCard = Array.isArray(result.cards)
      ? result.cards.find((card) => String(card?.id) === fromCardId)
      : null;
    if (!sourceCard) {
      throw stageError("evidence_invalid", `task ${task.id} 的源卡 ${fromCardId} 不在 result.json`);
    }
    let sourceQuery;
    try {
      sourceQuery = metricQueryFromCard(sourceCard);
    } catch (error) {
      throw stageError("evidence_invalid", `task ${task.id} 源卡 ${fromCardId} 的 canonical query 无效: ${error?.message || error}`);
    }
    const payload = buildCandidateQuery(sourceQuery, task);
    let explore;
    try {
      explore = await fetchExplore(resultPath, {
        taskId: String(task.id),
        payload,
        goal: String(task.goal || ""),
        fromCardId,
        hint: "Runner 依据 Researcher evidenceGap 确定性补查",
      });
    } catch (error) {
      throw stageError("fetch_failed", `task ${task.id} new_query 补查失败: ${error?.message || error}`);
    }
    if (!isPlainObject(explore) || explore.status !== "ok") {
      throw stageError("fetch_failed", `task ${task.id} new_query 补查未成功：${explore?.failedMessage || explore?.errorCode || "unknown"}`);
    }
  }
  let packet;
  try {
    packet = await prepareResearchEvidence(resultPath, { taskId: String(task.id) });
  } catch (error) {
    throw stageError("evidence_invalid", `task ${task.id} evidence 准备失败: ${error?.message || error}`);
  }
  if (!isPlainObject(packet)) throw stageError("evidence_invalid", `task ${task.id} evidence 包无效`);
  const evidenceText = JSON.stringify(packet);
  if (Buffer.byteLength(evidenceText, "utf8") > RESEARCH_EVIDENCE_EMBED_LIMIT) {
    throw stageError("evidence_overflow", `task ${task.id} evidence JSON ${Buffer.byteLength(evidenceText, "utf8")} 字节超过 ${RESEARCH_EVIDENCE_EMBED_LIMIT} 上限`);
  }
  return { evidence: packet, evidenceText };
}

/** 构建 researcher child prompt：角色说明 + 分析要求 + 内嵌 evidence capsule。 */
export function buildResearcherPrompt({ sessionDir, resultPath, task, paths, evidenceText }) {
  const requirementLines = (Array.isArray(task?.analysisRequirements) ? task.analysisRequirements : [])
    .map((requirement, index) => [
      `  ${index + 1}. requirementId=${requirement.id}`,
      `     question：${requirement.question}`,
      `     允许证据视图：${(requirement.evidenceViewIds || []).join(", ")}`,
    ].join("\n"))
    .join("\n");
  return [
    `你是 html-report 的 Report Researcher（角色 report-researcher）。处理任务 taskId=${task.id}。`,
    `SESSION=${sessionDir}`,
    `result.json=${resultPath}`,
    `evidencePath=${paths.evidencePath}（evidenceMode=${task.evidencePlan?.mode}）`,
    `研究目标：${task.goal}`,
    "分析要求（analysisRequirements，逐条回答）：",
    requirementLines,
    "证据（evidence packet JSON）已完整内嵌在下方 capsule 中。结论只能引用证据中出现的数字、日期、指标名、维度名与视图节点。",
    "输出必须严格符合返回 schema，且只输出一个 JSON 对象。",
    "当证据足以回答全部要求时，status 用 ok，并为每条 requirement 给一个 finding（requirementId/claim/evidencePointers），evidencePointers 必须是证据内可解析的 /views/ 指针。",
    "当证据不足、需要补查（缺指标/维度/粒度/范围/口径/对比）时，不得编造结论：返回 status=needs_new_query（附 evidenceGap.type/reason/requiredIndicators/requiredDims）或 status=needs_evidence_plan（gap.type=missing_operation + requiredOperations）。",
    "禁止伪造结论：任何 ok 结论都必须能被内嵌证据唯一支撑；summary 由 findings 的 claim 拼接，不得额外编造。",
    "",
    "capsule evidence JSON:",
    evidenceText,
    "",
    "只输出 JSON，不要其他文字。",
  ].join("\n");
}

function buildResearcherExpected(task, requirements, paths) {
  return {
    taskId: String(task.id),
    mode: String(task?.evidencePlan?.mode || ""),
    task,
    analysisRequirements: requirements,
    ...paths,
  };
}

/** needs_new_query / needs_evidence_plan → 后继任务（仅 Runner 内确定性改写 tasks.json）。 */
function researcherSuccessor(task, value) {
  const gap = isPlainObject(value?.evidenceGap) ? value.evidenceGap : null;
  const plan = isPlainObject(task?.evidencePlan) ? task.evidencePlan : null;
  if (!gap || !plan) throw stageError("successor_invalid", "researcher needs_* 返回缺少 evidenceGap/evidencePlan");
  if (value.status === "needs_new_query") {
    return {
      ...task,
      evidencePlan: { ...plan, mode: "new_query" },
      evidenceGap: gap,
      candidateIndicators: uniqueCanonical([
        ...(Array.isArray(task.candidateIndicators) ? task.candidateIndicators : []),
        ...(Array.isArray(gap.requiredIndicators) ? gap.requiredIndicators : []),
      ]),
      candidateDims: uniqueCanonical([
        ...(Array.isArray(task.candidateDims) ? task.candidateDims : []),
        ...(Array.isArray(gap.requiredDims) ? gap.requiredDims : []),
      ]),
    };
  }
  if (value.status === "needs_evidence_plan" && gap.type === "missing_operation") {
    const required = Array.isArray(gap.requiredOperations) ? gap.requiredOperations : [];
    if (!required.length) throw stageError("successor_invalid", "missing_operation 缺少 requiredOperations");
    const operations = [...(Array.isArray(plan.operations) ? plan.operations : [])];
    for (const operation of required) {
      if (!operations.some((current) => sameCanonicalJson(current, operation))) operations.push(operation);
    }
    const requiredColumns = [...(Array.isArray(plan.requiredColumns) ? plan.requiredColumns : [])];
    for (const operation of required) {
      for (const field of Array.isArray(operation?.fields) ? operation.fields : []) {
        if (typeof field === "string" && !requiredColumns.includes(field)) requiredColumns.push(field);
      }
    }
    return { ...task, evidencePlan: { ...plan, operations, requiredColumns } };
  }
  throw stageError("successor_invalid", `researcher ${String(value.status)} 无法推导唯一后继`);
}

/** 把后继任务写回 analysis/tasks.json（同 index 替换，版本保持 2）。 */
async function persistResearcherSuccessor(sessionDir, task) {
  const tasksPath = join(sessionDir, "analysis", "tasks.json");
  const document = readJsonFile(tasksPath);
  if (!isPlainObject(document) || !Array.isArray(document.tasks)) {
    throw stageError("tasks_invalid", "analysis/tasks.json 必须是含 tasks[] 的对象文档");
  }
  const index = document.tasks.findIndex((candidate) => String(candidate?.id) === String(task.id));
  if (index < 0) throw stageError("tasks_invalid", `analysis/tasks.json 缺少任务 ${task.id}`);
  document.tasks[index] = task;
  writeFileSync(tasksPath, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * M3: B3_RESEARCH —— 按任务串行 dispatch report-researcher child：
 *  - evidence 由 Runner 内嵌（≤64KB），child 无工具，结论必须由证据唯一支撑；
 *  - child 返回 needs_new_query/needs_evidence_plan 时，Runner 确定性改写后继
 *    任务并重新准备 evidence 再跑一次（绝不把补查写成伪造结论）；
 *  - ok 时由 Pi submitResearchFindings 落盘 section+summary，并用
 *    canonicalizeJson 比对 Pi 重建 envelope 与 child 返回值（反伪造守卫）；
 *  - 全部任务终态后 finalizeResearchStage + finish B3（人工 Gate，停在等待批准）。
 */
export async function runResearchStage(
  projectRoot,
  sessionId,
  { runChild = runCodeBuddyChild, fetchExplore = fetchExploreTask } = {}
) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const resultPath = join(sessionDir, "result.json");
  try {
    const tasksDocument = readJsonFile(join(sessionDir, "analysis", "tasks.json"));
    if (!isPlainObject(tasksDocument) || Number(tasksDocument.version) !== 2 || !Array.isArray(tasksDocument.tasks)) {
      return { ok: false, code: "tasks_invalid", error: "B3 需要 B25 物化的 version 2 analysis/tasks.json（含 tasks[]）" };
    }
    const tasks = tasksDocument.tasks.filter((task) => isPlainObject(task) && String(task.status) === "pending");
    const completed = [];
    for (let task of tasks) {
      for (let dispatch = 0; dispatch < 2; dispatch += 1) {
        const paths = researcherReturnPaths({ sessionDir, taskId: task.id });
        let requirements;
        try {
          const checked = validateResearcherAnalysisRequirements(task);
          if (!checked.ok) {
            throw stageError("task_invalid", `task ${task.id} analysisRequirements 无效: ${checked.errors.join("; ")}`);
          }
          requirements = checked.requirements;
        } catch (error) {
          if (error?.code) throw error;
          throw stageError("task_invalid", `task ${task.id} analysisRequirements 校验异常: ${error?.message || error}`);
        }
        const expected = buildResearcherExpected(task, requirements, paths);
        if (expected.mode !== "reuse_entry" && expected.mode !== "new_query") {
          throw stageError("task_invalid", `task ${task.id} evidencePlan.mode=${JSON.stringify(expected.mode)} 不受支持`);
        }
        let prepared;
        try {
          prepared = await prepareResearchEvidenceForRun({ resultPath, task, fetchExplore });
        } catch (error) {
          if (error?.code) throw error;
          throw stageError("evidence_invalid", `task ${task.id} evidence 准备失败: ${error?.message || error}`);
        }
        let child;
        try {
          child = await runChild({
            prompt: buildResearcherPrompt({ sessionDir, resultPath, task, paths, evidenceText: prepared.evidenceText }),
            schema: buildResearcherReturnSchema(expected),
            sessionId: `${sanitizeSessionId(sessionId)}-researcher-${paths.safeTaskId}-${dispatch}`,
            cwd: resolve(projectRoot),
            model: RESEARCH_MODEL,
            timeoutMs: RESEARCH_TIMEOUT_MS,
          });
        } catch (error) {
          throw stageError("child_failed", `启动 researcher child 失败: ${error?.message || error}`);
        }
        if (child?.status !== "completed" || !child?.value) {
          throw stageError(child?.code || "child_failed", child?.timedOut
            ? `researcher child 超时（${RESEARCH_TIMEOUT_MS}ms）`
            : (child?.message || `researcher child ${child?.code || "failed"}`));
        }
        const value = child.value;
        let checkedReturn;
        try {
          checkedReturn = validateResearcherReturn(value, expected);
        } catch (error) {
          throw stageError("return_invalid", `task ${task.id} researcher 返回校验异常: ${error?.message || error}`);
        }
        if (!checkedReturn.ok) {
          throw stageError("return_invalid", `task ${task.id} researcher 返回无效: ${checkedReturn.errors.join("; ")}`);
        }
        if (value.status === "failed") {
          throw stageError("research_failed", `task ${task.id} researcher 返回 failed：${value.error || "unknown"}`);
        }
        if (value.status === "needs_evidence_plan" || value.status === "needs_new_query") {
          if (dispatch === 1) {
            throw stageError("successor_exhausted", `task ${task.id} 已耗尽唯一一次补查/补 plan 机会`);
          }
          let successor;
          try {
            successor = researcherSuccessor(task, value);
          } catch (error) {
            if (error?.code) throw error;
            throw stageError("successor_invalid", error?.message || "researcher 返回无法推导后继任务");
          }
          await persistResearcherSuccessor(sessionDir, successor);
          task = successor;
          continue;
        }
        if (value.status !== "ok") {
          throw stageError("return_invalid", `task ${task.id} researcher 返回未知 status=${JSON.stringify(value.status)}`);
        }
        // 反伪造守卫（先于任何落盘）：Pi 从 findings 重建 envelope，必须与 child
        // 返回值一致，证明 child 的 summary/selfCheck/evidencePointers 不是伪造的补查结论。
        let built;
        try {
          built = buildResearcherSubmission(expected, prepared.evidence, {
            findings: value.findings,
            suggestedDeeper: value.suggestedDeeper,
          });
        } catch (error) {
          throw stageError("return_invalid", `task ${task.id} researcher 结论无法由 Pi 重建: ${error?.message || error}`);
        }
        if (canonicalizeJson(built.researcherReturn) !== canonicalizeJson(value)) {
          throw stageError("return_inconsistent", `task ${task.id} researcher 返回值与 Pi 重建结果不一致（疑似伪造），拒绝落盘`);
        }
        // Pi 落盘：submitResearchFindings 内部做完整校验；success 即写入 section+summary。
        try {
          await submitResearchFindings(expected, prepared.evidence, {
            findings: value.findings,
            suggestedDeeper: value.suggestedDeeper,
          });
        } catch (error) {
          throw stageError("research_failed", `task ${task.id} 结论落盘失败: ${error?.message || error}`);
        }
        completed.push(String(task.id));
        break;
      }
    }
    let finalized;
    try {
      finalized = await finalizeResearchStage(resultPath);
    } catch (error) {
      throw stageError("finalize_failed", `研究收尾失败: ${error?.message || error}`);
    }
    if (!finalized?.ok) throw stageError("finalize_failed", "研究收尾校验未通过");
    let gate;
    try {
      gate = await finishPipelineStage(sessionDir, "B3_RESEARCH", { now: Date.now() });
    } catch (error) {
      throw stageError("finish_failed", `B3_RESEARCH finish 失败: ${error?.message || error}`);
    }
    return {
      ok: true,
      message: `B3_RESEARCH 完成 ${completed.length} 个任务，研究阶段结束（B3 为人工 Gate，停在等待批准）。${gate?.message || ""}`,
      completed,
      finalized,
      gate,
    };
  } catch (error) {
    return { ok: false, code: error?.code || "research_failed", error: error?.message || String(error) };
  }
}

/** reviewer child 的 raw scorecard JSON Schema（无工具：直接返回评分卡，不落盘）。 */
export function reviewerScorecardSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      scores: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(REVIEW_RUBRIC_IDS.map((id) => [
          id,
          {
            type: "object",
            additionalProperties: false,
            properties: {
              score: { type: "integer", minimum: 0, maximum: 2 },
              note: { type: "string", minLength: 1, maxLength: 1000 },
            },
            required: ["score", "note"],
          },
        ])),
        required: REVIEW_RUBRIC_IDS,
      },
      summary: { type: "string", minLength: 1, maxLength: 2000 },
      hardBlockers: { type: "array", maxItems: 20, items: { type: "object" } },
      issues: { type: "array", maxItems: 20, items: { type: "object" } },
      repairHints: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
    },
    required: ["scores", "summary", "hardBlockers", "issues", "repairHints"],
  };
}

/** 校验 reviewer child 返回的 raw scorecard 结构与基本语义。 */
export function validateReviewerScorecard(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["reviewer 返回必须是单个 JSON 对象"] };
  }
  if (!isPlainObject(value.scores)) {
    errors.push("scores 必须包含 R1–R7");
  } else {
    for (const id of REVIEW_RUBRIC_IDS) {
      const cell = value.scores[id];
      if (!isPlainObject(cell)) {
        errors.push(`scores.${id} 必须是对象`);
      } else {
        if (!Number.isInteger(cell.score) || cell.score < 0 || cell.score > 2) {
          errors.push(`scores.${id}.score 必须是 0/1/2`);
        }
        if (typeof cell.note !== "string" || !cell.note.trim()) {
          errors.push(`scores.${id}.note 不能为空`);
        }
      }
    }
  }
  if (typeof value.summary !== "string" || !value.summary.trim()) errors.push("summary 不能为空");
  for (const key of ["hardBlockers", "issues", "repairHints"]) {
    if (!Array.isArray(value[key])) errors.push(`${key} 必须是数组`);
  }
  if (
    Array.isArray(value.repairHints) &&
    !value.repairHints.every((hint) => typeof hint === "string" && hint.trim())
  ) {
    errors.push("repairHints 每项必须是非空字符串");
  }
  return { ok: errors.length === 0, errors };
}

/** 构建 reviewer child prompt：角色说明 + 只读输入 + 评分要求。 */
export function buildReviewerPrompt({ sessionDir, resultPath, rubricPath }) {
  const fixedReads = [
    resultPath,
    join(sessionDir, "report", "report.md"),
    join(sessionDir, "report", "render-manifest.json"),
    rubricPath,
    join(sessionDir, "quality", "scan.json"),
  ];
  return [
    `你是 html-report 的 Report Reviewer（角色 ${REVIEWER_ROLE}）。对已通过的 B3 研究产物做质量审核。`,
    `SESSION=${sessionDir}`,
    `result.json=${resultPath}`,
    "PARENT QUALITY SCAN: passed with hardIssues=0.",
    "可读输入（只读，不得修改）：",
    ...fixedReads.map((path) => `- ${path}`),
    `按评分表 ${REVIEW_RUBRIC_IDS.join("/")} 逐条打分：score 只能是 0/1/2，note 必须给出能由上述输入支撑的具体依据。`,
    "输出必须严格符合返回 schema，且只输出一个 JSON 对象（raw scorecard，不含任何落盘副作用）。",
    "当报告未达质量线（存在 hard blocker、任何 rubric 明显失分、或需要给出可执行修正方向）时，不得在分数上作假：如实给分并在 repairHints 中说明修正方向。",
    "禁止伪造：分数与 note 必须能由你读取的输入唯一支撑。",
    "只输出 JSON，不要其他文字。",
  ].join("\n");
}

/** 冻结输入快照（sha256(path + content)），用于校验子进程运行期间输入未被改动。 */
async function inputSnapshot(paths, { label = "冻结输入", code = "input_too_large" } = {}) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of paths) {
    const content = existsSync(path) ? readFileSync(path) : Buffer.from("<missing>");
    bytes += content.byteLength;
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(content);
    hash.update("\0", "utf8");
  }
  if (bytes > 512 * 1024) {
    throw stageError(code, `${label} ${bytes} 字节超过 512 KiB`);
  }
  return { bytes, fingerprint: hash.digest("hex") };
}

/** 冻结 B4 审核输入，用于校验审核期间输入未被改动。 */
async function reviewerSnapshot(paths) {
  return inputSnapshot(paths, { label: "Reviewer 冻结输入", code: "review_input_too_large" });
}

/**
 * quality/html 布局的 step Gate 前置检查中，B0_PREFLIGHT/B2_WRITER 因 Runner
 * 以 gate:false 驱动而恒无人工审批记录（Pi 内部不一致，真实 harness 亦不满足）；
 * 仅过滤这两条恒假错误，其余布局错误仍阻断。
 */
const STEP_GATE_PREREQUISITE_ERROR = /^step Gate prerequisite (?:B0_PREFLIGHT|B2_WRITER) is not validly completed and approved before --phase (?:quality|html)$/;
function filterStepGatePrerequisiteErrors(errors = []) {
  return errors.filter((error) => !STEP_GATE_PREREQUISITE_ERROR.test(String(error)));
}

/**
 * M4: B4_REVIEW —— report-reviewer child 产出 raw scorecard（无工具）：
 *  - Runner 先跑 Pi quality-scan 做质量预检：hardIssues > 0 时 fail-closed
 *    （quality_hard），不得派发 Reviewer；
 *  - child 返回 raw scorecard 后 Runner 校验结构，再经 Pi
 *    submitReviewScorecard（内部 normalize + write-verdict）落盘 verdict.json
 *    与 report.md 并返回 reviewer envelope；
 *  - 以落盘 verdict 为唯一真相：validateReviewerArtifacts 交叉校验 envelope，
 *    证明 pass/total/requiredRubrics/gateFailures 全部由 Pi 公式重算而来
 *    （反伪造，child 无法自封通过）；
 *  - 未达质量线（pass=false）→ failPipelineStage 阻断流水线（可 retry，
 *    不推进）；达标 → quality 布局 + finishPipelineStage(B4) 停在等待批准。
 */
export async function runReviewStage(
  projectRoot,
  sessionId,
  { runChild = runCodeBuddyChild } = {}
) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const resultPath = join(sessionDir, "result.json");
  try {
    let scanned;
    try {
      scanned = await runQualityScan(sessionDir);
    } catch (error) {
      throw stageError("scan_invalid", `quality-scan 失败: ${error?.message || error}`);
    }
    const scan = scanned?.scan;
    if (!scan || !Array.isArray(scan.hardIssues)) {
      throw stageError("scan_invalid", "quality-scan 未产生 hardIssues[]");
    }
    if (scan.hardIssues.length > 0) {
      throw stageError("quality_hard", `quality-scan 硬伤 ${scan.hardIssues.length} 项（${scan.hardIssues.map((issue) => String(issue?.code || "DATA_UNTRACEABLE")).join(", ")}），不得派发 Reviewer`);
    }

    const expected = reviewerReturnPaths({ sessionDir });
    const rubricPath = join(projectRoot, "docs", "html-report-quality-rubric.md");
    const frozenPaths = [
      expected.resultPath,
      join(sessionDir, "report", "report.md"),
      join(sessionDir, "report", "render-manifest.json"),
      rubricPath,
      expected.scanPath,
    ];
    const before = await reviewerSnapshot(frozenPaths);

    let child;
    try {
      child = await runChild({
        prompt: buildReviewerPrompt({ sessionDir, resultPath, rubricPath }),
        schema: reviewerScorecardSchema(),
        sessionId: `${sanitizeSessionId(sessionId)}-reviewer-1`,
        cwd: resolve(projectRoot),
        model: REVIEWER_MODEL,
        tools: ["Read"],
        timeoutMs: REVIEWER_TIMEOUT_MS,
      });
    } catch (error) {
      throw stageError("child_failed", `启动 reviewer child 失败: ${error?.message || error}`);
    }
    if (child?.status !== "completed" || !child?.value) {
      throw stageError(child?.code || "child_failed", child?.timedOut
        ? `reviewer child 超时（${REVIEWER_TIMEOUT_MS}ms）`
        : (child?.message || `reviewer child ${child?.code || "failed"}`));
    }
    const value = child.value;

    let checked;
    try {
      checked = validateReviewerScorecard(value);
    } catch (error) {
      throw stageError("return_invalid", `reviewer 返回校验异常: ${error?.message || error}`);
    }
    if (!checked.ok) throw stageError("return_invalid", `reviewer 返回无效: ${checked.errors.join("; ")}`);

    if ((await reviewerSnapshot(frozenPaths)).fingerprint !== before.fingerprint) {
      throw stageError("review_input_changed", "审核期间冻结输入被改动，拒绝继续");
    }

    // Pi 落盘：submitReviewScorecard 内部 normalize + write-verdict 写
    // verdict.json/report.md，并返回 reviewer envelope（唯一真相来源）。
    let envelope;
    try {
      envelope = await submitReviewScorecard(resultPath, value);
    } catch (error) {
      throw stageError("return_invalid", `reviewer scorecard 无法由 Pi 落盘: ${error?.message || error}`);
    }

    // 反伪造守卫：落盘 verdict 与 envelope 必须逐项一致（pass/total/动态门槛
    // 全部由 Pi 公式重算，child 无法自封通过）。
    let verified;
    try {
      verified = validateReviewerArtifacts(envelope, expected);
    } catch (error) {
      throw stageError("review_invalid", `审核产物校验异常: ${error?.message || error}`);
    }
    if (!verified.ok) throw stageError("review_invalid", `审核产物无效: ${verified.errors.join("; ")}`);

    if (!envelope.pass) {
      throw stageError("review_failed", `质量审核未达线（total=${envelope.total}/14），阻断流水线`);
    }

    let layout;
    try {
      layout = await checkSessionLayout(sessionDir, { phase: "quality" });
    } catch (error) {
      throw stageError("layout_invalid", `quality 布局校验失败: ${error?.message || error}`);
    }
    if (!layout.ok) {
      // verdict 正确性已由 validateReviewerArtifacts 独立把关（producer=
      // write-verdict.mjs、draft=false、pass/total/requiredRubrics/gateFailures、
      // scanFingerprint 交叉一致），故仅过滤恒假的 step Gate 前置错误。
      const fatal = filterStepGatePrerequisiteErrors(layout.errors || []);
      if (fatal.length > 0) throw stageError("layout_invalid", `quality 布局校验未通过: ${fatal.join("; ")}`);
    }

    let gate;
    try {
      gate = await finishPipelineStage(sessionDir, "B4_REVIEW", { now: Date.now() });
    } catch (error) {
      throw stageError("finish_failed", `B4_REVIEW finish 失败: ${error?.message || error}`);
    }
    return {
      ok: true,
      message: `B4_REVIEW 质量审核通过（total=${envelope.total}/14）。${gate?.message || ""}`,
      envelope,
      gate,
    };
  } catch (error) {
    const code = error?.code || "review_failed";
    const reason = error?.message || String(error);
    // 任何 B4 失败都 fail Gate 并开放 retry（不推进到 B5）。
    let gate;
    try {
      gate = await failPipelineStage(sessionDir, "B4_REVIEW", reason);
    } catch (gateError) {
      // 二次失败不影响主错误上报（Gate 可能已非 running，如 child 超时后重试）。
    }
    return { ok: false, code, error: reason, gate };
  }
}

/** 构建 designer child prompt：角色说明 + 只读输入 + 固定执行链（只消费已审核产物）。 */
export function buildDesignerPrompt({ sessionDir, resultPath, expected }) {
  const reportDir = join(sessionDir, "report");
  const fixedReads = [
    resultPath,
    join(reportDir, "report.md"),
    join(reportDir, "render-manifest.json"),
    join(sessionDir, "quality", "verdict.json"),
    join(sessionDir, "quality", "scan.json"),
  ];
  const paths = {
    reportHtml: expected.reportHtml,
    renderMeta: expected.renderMeta,
    designResult: expected.designResult,
    desktopScreenshot: expected.desktopScreenshot,
    mobileScreenshot: expected.mobileScreenshot,
  };
  return [
    `你是 html-report 的 Report Designer（角色 ${DESIGNER_ROLE}）。只消费已通过质量审核（quality pass）的产物，输出最终 HTML 报告，不得改动任何已审核输入。`,
    `SESSION=${sessionDir}`,
    `result.json=${resultPath}`,
    "只读输入（不得修改）：",
    ...fixedReads.map((path) => `- ${path}`),
    "固定执行链（顺序执行、各一次）：",
    `1) node compile-report-content.mjs --result '${resultPath}'  （生成 report.content.html + design-input.json）`,
    `2) 写入 ${join(reportDir, "report.design.html")}：完整 HTML 模板，且只含一个 <!-- HTML_REPORT_CONTENT --> 槽；不得复制业务内容`,
    `3) node compose-report.mjs --result '${resultPath}'  （合成 report.html + render.meta.json）`,
    `4) node capture-report.mjs --result '${resultPath}'  （生成 visual-check.json 与双端截图）`,
    `5) 检查截图后写入 ${join(reportDir, "design-result.draft.json")}（status=pass，viewports.desktop/mobile 均 pass=true，仅可改 notes）`,
    `6) node finalize-design.mjs --result '${resultPath}' --assessment-file '${join(reportDir, "design-result.draft.json")}'  （产出 design-result.json）`,
    `7) node check-session-layout.mjs --result '${resultPath}' --phase html 必须 ok=true`,
    "修复最多 2 轮（repairRounds 0-2），只允许改 report.design.html 的可见缺陷，绝不动内容槽。",
    `成功：输出 status=ok、layoutOk=true、paths 严格等于 ${JSON.stringify(paths)}、residualNotes=[]。`,
    "任何一步失败：输出 status=failed、layoutOk=false、error 简短、residualNotes 至少 1 项。",
    "只输出一个 JSON 对象，不要其他文字。",
  ].join("\n");
}

/**
 * M5: B5_DESIGN —— report-designer child 只消费已审核产物：
 *  - Runner 冻结已审核输入后派发 designer child；child 依固定执行链
 *    （compile → 写 report.design.html → compose → capture → draft →
 *    finalize → layout(html)）产出最终 HTML；
 *  - Runner 校验 designer 返回（validateDesignerReturn + html 布局，同样
 *    过滤恒假的 B0/B2 step Gate 前置错误）；
 *  - status=failed 或任何校验失败 → failPipelineStage 阻断（可 retry）；
 *  - status=ok 且 html 布局通过 → finishPipelineStage(B5) 完成流水线。
 */
export async function runDesignStage(
  projectRoot,
  sessionId,
  { runChild = runCodeBuddyChild } = {}
) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const resultPath = join(sessionDir, "result.json");
  try {
    const expected = designerReturnPaths({ sessionDir });
    const frozenPaths = [
      resultPath,
      join(sessionDir, "report", "report.md"),
      join(sessionDir, "report", "render-manifest.json"),
      join(sessionDir, "quality", "verdict.json"),
      join(sessionDir, "quality", "scan.json"),
    ];
    const before = await inputSnapshot(frozenPaths, { label: "Designer 冻结输入", code: "design_input_too_large" });

    let child;
    try {
      child = await runChild({
        prompt: buildDesignerPrompt({ sessionDir, resultPath, expected }),
        schema: buildDesignerReturnSchema(expected),
        sessionId: `${sanitizeSessionId(sessionId)}-designer-1`,
        cwd: resolve(projectRoot),
        model: DESIGNER_MODEL,
        tools: ["Read", "Write", "Edit", "Bash"],
        timeoutMs: DESIGNER_TIMEOUT_MS,
      });
    } catch (error) {
      throw stageError("child_failed", `启动 designer child 失败: ${error?.message || error}`);
    }
    if (child?.status !== "completed" || !child?.value) {
      throw stageError(child?.code || "child_failed", child?.timedOut
        ? `designer child 超时（${DESIGNER_TIMEOUT_MS}ms）`
        : (child?.message || `designer child ${child?.code || "failed"}`));
    }
    const value = child.value;

    let checkedReturn;
    try {
      checkedReturn = validateDesignerReturn(value, expected);
    } catch (error) {
      throw stageError("return_invalid", `designer 返回校验异常: ${error?.message || error}`);
    }
    if (!checkedReturn.ok) throw stageError("return_invalid", `designer 返回无效: ${checkedReturn.errors.join("; ")}`);

    if ((await inputSnapshot(frozenPaths, { label: "Designer 冻结输入", code: "design_input_too_large" })).fingerprint !== before.fingerprint) {
      throw stageError("design_input_changed", "设计期间冻结输入被改动，拒绝继续");
    }

    if (value.status === "failed") {
      throw stageError("design_failed", value.error || "designer 返回 failed");
    }

    let layout;
    try {
      layout = await checkSessionLayout(sessionDir, { phase: "html" });
    } catch (error) {
      throw stageError("layout_invalid", `html 布局校验失败: ${error?.message || error}`);
    }
    if (!layout.ok) {
      const fatal = filterStepGatePrerequisiteErrors(layout.errors || []);
      if (fatal.length > 0) throw stageError("layout_invalid", `html 布局校验未通过: ${fatal.join("; ")}`);
    }

    let gate;
    try {
      gate = await finishPipelineStage(sessionDir, "B5_DESIGN", { now: Date.now() });
    } catch (error) {
      throw stageError("finish_failed", `B5_DESIGN finish 失败: ${error?.message || error}`);
    }
    return {
      ok: true,
      message: `B5_DESIGN 最终 HTML 已通过 layout(html) 与 finalize-design。${gate?.message || ""}`,
      layout,
      gate,
    };
  } catch (error) {
    const code = error?.code || "design_failed";
    const reason = error?.message || String(error);
    // 任何 B5 失败都 fail Gate 并开放 retry（不推进到下一个阶段）。
    let gate;
    try {
      gate = await failPipelineStage(sessionDir, "B5_DESIGN", reason);
    } catch (gateError) {
      // 二次失败不影响主错误上报（Gate 可能已非 running）。
    }
    return { ok: false, code, error: reason, gate };
  }
}

/** Advance one stage; returns { ok, message, state?, stop? }. */
async function advanceStage(projectRoot, sessionId, state, { runChild, fetchEntries, fetchExplore, onProgress } = {}) {
  const stage = state.currentStage;
  const trackedRunChild = registeredChildRunner(
    projectRoot,
    sessionId,
    stage,
    undefined,
    runChild || runCodeBuddyChild,
  );
  // M3-M5 阶段默认关闭；仅当当前 state 的 policy 显式启用时才进入各 case。
  if (DISABLED_RUNNER_STAGES.has(stage) && !runnerPolicyEnabled(state, stage)) {
    return { ok: true, message: `${stage} 未启用（对齐文档 §9 默认只到 B2_MAIN），不改变状态。`, state };
  }
  switch (stage) {
    case "A_CONFIG": {
      const result = readResult(projectRoot, sessionId);
      if (!result) {
        return { ok: false, message: "A_CONFIG 等待用户保存卡片：请先运行 qdm-metric-cli ui 保存 result.json（status=confirmed），再 advance。" };
      }
      if (result.status !== "confirmed") {
        return { ok: false, message: `A_CONFIG 需要 result.status=confirmed，当前为 ${JSON.stringify(result.status)}。` };
      }
      const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "A_CONFIG"]);
      if (!finished.ok) return { ok: false, message: finished.error || "stage-gate finish A_CONFIG 失败" };
      // A_CONFIG 是 approvalRequired 人工 Gate；result.json confirmed 即用户已确认配置，
      // Runner 代表用户批准以推进 B0（B2_MAIN 才是需要等待人工 approve 的 Gate）。
      const approved = runStageGate(projectRoot, sessionId, "approve", ["--phrase", "继续"]);
      if (!approved.ok) return { ok: false, message: approved.error || "stage-gate approve A_CONFIG 失败" };
      const after = runStageGate(projectRoot, sessionId, "status");
      return { ok: true, message: `A_CONFIG 已批准，进入 ${after.payload?.state?.currentStage}。`, state: after.payload?.state };
    }
    case "B0_PREFLIGHT": {
      const result = readResult(projectRoot, sessionId);
      if (!result) return { ok: false, message: "B0_PREFLIGHT 需要 result.json" };
      let fetched;
      try {
        fetched = await fetchAllEntries(join(htmlReportSessionDir(projectRoot, sessionId), "result.json"), {
          parallel: false,
          projectRoot,
        });
      } catch (error) {
        const reason = String(error?.message || error);
        const failed = runStageGate(projectRoot, sessionId, "fail", ["--stage", "B0_PREFLIGHT", "--reason", reason]);
        return { ok: false, message: `B0_PREFLIGHT 取数失败（已 fail Gate）：${reason}`, failed };
      }
      const cards = Array.isArray(fetched?.cards) ? fetched.cards : [];
      const bad = cards.filter((item) => item?.fetchStatus !== "success");
      if (cards.length === 0 || bad.length > 0) {
        const reason = bad.map((item) => `${item?.cardId}: ${item?.error || "fetch failed"}`).join("; ");
        const failed = runStageGate(projectRoot, sessionId, "fail", ["--stage", "B0_PREFLIGHT", "--reason", reason || "no cards fetched"]);
        return { ok: false, message: `B0_PREFLIGHT 取数失败（已 fail Gate）：${reason}`, failed };
      }
      const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "B0_PREFLIGHT"]);
      if (!finished.ok) return { ok: false, message: finished.error || "stage-gate finish B0_PREFLIGHT 失败" };
      const started = runStageGate(projectRoot, sessionId, "start", ["--stage", "B2_WRITER"]);
      const after = runStageGate(projectRoot, sessionId, "status");
      return { ok: true, message: `B0_PREFLIGHT 通过（${cards.length} 张卡），进入 B2_WRITER。`, state: after.payload?.state, started };
    }
    case "B2_WRITER": {
      const outcome = await runWriterStage(projectRoot, sessionId, { runChild, fetchEntries, onProgress });
      if (!outcome.ok) return { ok: false, message: outcome.message || outcome.error, outcome };
      const after = runStageGate(projectRoot, sessionId, "status");
      return { ok: true, message: outcome.message, state: after.payload?.state, outcome };
    }
    case "B2_MAIN": {
      // 用 composeMain 生成 analysis/main.md（answerFirst 可选，当前用默认）
      let composed;
      const mainPath = join(htmlReportSessionDir(projectRoot, sessionId), "analysis", "main.md");
      try {
        composed = await composeMain(htmlReportSessionDir(projectRoot, sessionId));
      } catch (error) {
        return { ok: false, message: `composeMain 生成 analysis/main.md 失败（可能还有卡片缺 caption.md）：${error?.message || error}` };
      }
      const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "B2_MAIN"]);
      if (!finished.ok) return { ok: false, message: finished.error || "stage-gate finish B2_MAIN 失败" };
      const after = runStageGate(projectRoot, sessionId, "status");
      // B2_MAIN 是人工 Gate，step 模式下 finish 后停在 awaiting_approval；Runner 不自动 approve。
      return {
        ok: true,
        message: [
          `B2_MAIN 已生成 main.md（${composed.cardIds?.length || 0} 卡）并 finish，报告文件：${mainPath}，等待人工批准（不自动 approve）。`,
          gateActionHint(projectRoot, sessionId, after.payload?.state),
        ].filter(Boolean).join("\n"),
        state: after.payload?.state,
        composed,
      };
    }
    case "B25_EDITOR": {
      const outcome = await runEditorPlannerStage(projectRoot, sessionId, { runChild: trackedRunChild });
      if (!outcome.ok) return { ok: false, message: outcome.error, outcome };
      return { ok: true, message: outcome.message, state: outcome.state, outcome };
    }
    case "B3_RESEARCH": {
      const outcome = await runResearchStage(projectRoot, sessionId, { runChild: trackedRunChild, fetchExplore });
      if (!outcome.ok) return { ok: false, message: outcome.error, code: outcome.code, outcome };
      const after = runStageGate(projectRoot, sessionId, "status");
      return { ok: true, message: outcome.message, state: after.payload?.state, outcome };
    }
    case "B4_REVIEW": {
      const outcome = await runReviewStage(projectRoot, sessionId, { runChild: trackedRunChild });
      if (!outcome.ok) return { ok: false, message: outcome.error, code: outcome.code, state: outcome.state, outcome };
      const after = runStageGate(projectRoot, sessionId, "status");
      return { ok: true, message: outcome.message, state: after.payload?.state, outcome };
    }
    case "B5_DESIGN": {
      const outcome = await runDesignStage(projectRoot, sessionId, { runChild: trackedRunChild });
      if (!outcome.ok) return { ok: false, message: outcome.error, code: outcome.code, state: outcome.state, outcome };
      const after = runStageGate(projectRoot, sessionId, "status");
      return { ok: true, message: outcome.message, state: after.payload?.state, outcome };
    }
    default:
      return { ok: true, message: `阶段 ${stage} 无需 runner advance。`, state };
  }
}

function currentStageRecord(state) {
  if (!state?.currentStage) return null;
  return state.stages?.[state.currentStage] || null;
}

function conciseFailureReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return "未记录失败原因";
  const cardMatch = text.match(/^([^:\s]+):/);
  const unsupportedDim = text.match(/metric\s+([A-Za-z0-9_]+)\s+does not support filter dimension\s+([A-Za-z0-9_]+)/);
  if (unsupportedDim) {
    const card = cardMatch ? `卡片 ${cardMatch[1]}：` : "";
    return `${card}指标 ${unsupportedDim[1]} 不支持筛选维度 ${unsupportedDim[2]}`;
  }
  const code = text.match(/"code"\s*:\s*"([^"]+)"/)?.[1];
  const message = text.match(/"message"\s*:\s*"([^"]+)"/)?.[1];
  if (code || message) return [code, message].filter(Boolean).join(" - ");
  return text.split("\n").slice(0, 4).join(" ").slice(0, 500);
}

function gateActionHint(projectRoot, sessionId, state) {
  if (!state) return "";
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const mainPath = join(sessionDir, "analysis", "main.md");
  if (state.status === "failed") {
    const stage = state.currentStage || "unknown";
    const failure = conciseFailureReason(currentStageRecord(state)?.failureReason);
    if (stage === "B0_PREFLIGHT") {
      return [
        "下一步：B0 预检失败，请直接把下面的错误摘要和修复步骤告诉用户，不要让用户再问状态。",
        `错误摘要：${failure}`,
        "请让用户回到配置 UI 修改对应卡片（例如移除不支持的筛选维度或更换指标），重新点击「保存」。",
        `保存后运行：node .agents/pi/skills/html-report/scripts/stage-gate.mjs retry --session-dir ${JSON.stringify(sessionDir)} --phrase "重试当前阶段"`,
        `然后运行：node .agents/workbuddy/scripts/html-report-workbuddy.mjs advance --session ${sessionId}`,
      ].join("\n");
    }
    return [
      `下一步：${stage} 已失败，请直接告诉用户失败原因。`,
      `错误摘要：${failure}`,
      `修复后可运行 retry：node .agents/pi/skills/html-report/scripts/stage-gate.mjs retry --session-dir ${JSON.stringify(sessionDir)} --phrase "重试当前阶段"`,
      `再运行：node .agents/workbuddy/scripts/html-report-workbuddy.mjs advance --session ${sessionId}`,
    ].join("\n");
  }
  if (state.status === "awaiting_approval" && state.currentStage === "B2_MAIN" && existsSync(mainPath)) {
    return [
      "下一步：初版报告已生成，请直接把报告文件路径告诉用户，不要在后台继续推进。",
      `报告文件：${mainPath}`,
      "当前 WorkBuddy 流程止于 B2_MAIN；除非用户明确要求后续增强，否则不要运行 approve。",
    ].join("\n");
  }
  return "";
}

/** advance：按当前 Gate 阶段分发；自动阶段（A_CONFIG→B0→B2_WRITER→B2_MAIN）级联推进。 */
export async function advance(projectRoot, sessionId, { runChild, fetchEntries, fetchExplore, onProgress } = {}) {
  let status = runStageGate(projectRoot, sessionId, "status");
  if (!status.ok) return { ok: false, error: status.error || "stage-gate status 失败" };
  let state = status.payload?.state;
  if (!state) return { ok: false, error: "stage-gate status 无 state；请先运行 start" };
  if (state.status === "failed") {
    const hint = gateActionHint(projectRoot, sessionId, state);
    return { ok: false, error: [`当前阶段 ${state.currentStage} 已失败。`, hint].filter(Boolean).join("\n"), state };
  }
  if (state.status === "awaiting_approval") {
    const hint = gateActionHint(projectRoot, sessionId, state);
    return { ok: true, message: [`当前停在人工 Gate：${state.currentStage}，等待批准（不自动 approve）。`, hint].filter(Boolean).join("\n"), state };
  }

  const logs = [];
  let guard = 0;
  while (state && guard < RUNNER_STAGES.length) {
    const outcome = await advanceStage(projectRoot, sessionId, state, { runChild, fetchEntries, fetchExplore, onProgress });
    logs.push(outcome.message);
    if (!outcome.ok) return { ok: false, message: logs.join("\n"), error: outcome.message, code: outcome.code, state: outcome.state || state };
    const after = outcome.state || runStageGate(projectRoot, sessionId, "status").payload?.state;
    if (!after || after.currentStage === state.currentStage || after.status === "awaiting_approval") {
      return { ok: true, message: logs.join("\n"), state: after || state };
    }
    state = after;
    guard += 1;
  }
  return { ok: true, message: logs.join("\n"), state };
}

/** start：初始化 gate 并 start A_CONFIG；增强阶段必须显式启用 policy。 */
export async function start(projectRoot, sessionId, { applyPolicy = false } = {}) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const init = runStageGate(projectRoot, sessionId, "init", ["--mode", "step", "--session-id", sanitizeSessionId(sessionId)]);
  if (!init.ok && !/already/i.test(String(init.error || ""))) {
    return { ok: false, error: init.error || "stage-gate init 失败" };
  }
  // stage-gate 无 CLI policy 命令；启用 B25/B3/B4/B5 必须程序化执行（幂等）。
  if (applyPolicy) {
    try {
      await applyPipelinePolicy(sessionDir, RUNNER_STAGE_POLICY);
    } catch (error) {
      return { ok: false, error: `启用 B25/B3/B4/B5 失败: ${error?.message || error}` };
    }
  }
  const started = runStageGate(projectRoot, sessionId, "start", ["--stage", "A_CONFIG"]);
  if (!started.ok && !/already/i.test(String(started.error || ""))) {
    return { ok: false, error: started.error || "stage-gate start A_CONFIG 失败" };
  }
  const status = runStageGate(projectRoot, sessionId, "status");
  return { ok: true, sessionDir, state: status.payload?.state, message: `html-report session 已启动：${sessionDir}` };
}

/** status：返回当前 Gate 状态（JSON 或人类可读摘要）。 */
export function status(projectRoot, sessionId, { format = "text" } = {}) {
  const result = runStageGate(projectRoot, sessionId, "status");
  if (!result.ok) return { ok: false, error: result.error || "stage-gate status 失败" };
  if (!result.payload?.exists) {
    return { ok: true, exists: false, message: `Session ${sessionId} 尚未初始化 html-report Gate（目录：${htmlReportSessionDir(projectRoot, sessionId)}）。请先运行 start。` };
  }
  const state = result.payload?.state;
  const mainPath = join(htmlReportSessionDir(projectRoot, sessionId), "analysis", "main.md");
  const summary = state
    ? [
        `Session: ${state.sessionId}`,
        `目录: ${state.sessionDir}`,
        existsSync(mainPath)
          ? `报告文件: ${mainPath}`
          : null,
        `Gate 模式: ${state.mode}  状态: ${state.status}`,
        `当前阶段: ${state.currentStage}`,
        ...RUNNER_STAGES.map((id) => {
          const stage = state.stages?.[id];
          if (!stage) return null;
          const reason = stage.failureReason ? `（${stage.failureReason}）` : "";
          return `  ${id}: ${stage.status}${reason}`;
        }).filter(Boolean),
        gateActionHint(projectRoot, sessionId, state),
      ].filter(Boolean).join("\n")
    : "（无 state）";
  return { ok: true, exists: true, state, message: format === "json" ? JSON.stringify(result.payload, null, 2) : summary };
}

/** cancel：暂停当前阶段。 */
export function cancel(projectRoot, sessionId) {
  const stopped = stopRunnerChildren(projectRoot, sessionId);
  const result = runStageGate(projectRoot, sessionId, "pause", ["--reason", "runner cancel"]);
  if (!result.ok) return { ok: false, error: result.error || "stage-gate pause 失败" };
  return {
    ok: true,
    state: result.payload?.state,
    message: stopped.stopped > 0
      ? `当前阶段已暂停（cancel），已停止 ${stopped.stopped} 个子进程。`
      : "当前阶段已暂停（cancel）。",
    stoppedChildren: stopped.stopped,
  };
}

/** approve：通过人工 Gate（awaiting_approval）并继续推进；其余状态拒绝。 */
export async function approveGate(projectRoot, sessionId) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const before = runStageGate(projectRoot, sessionId, "status");
  if (!before.ok) return { ok: false, error: before.error || "stage-gate status 失败" };
  if (!before.payload?.exists) {
    return { ok: false, error: `Session ${sessionId} 尚未初始化 html-report Gate（目录：${sessionDir}）。请先运行 start。` };
  }
  const state = before.payload?.state;
  const current = state?.currentStage;
  const stage = current ? state?.stages?.[current] : null;
  if (state?.status !== "awaiting_approval" || stage?.status !== "awaiting_approval") {
    return {
      ok: false,
      error: `当前不在等待批准，无法 approve（state=${state?.status || "unknown"}，${current || "unknown"}=${stage?.status || "unknown"}）。`,
      state,
    };
  }
  const approved = await approvePipelineStage(sessionDir, { phrase: "继续" });
  if (approved.approvalRejected) {
    return { ok: false, error: `approve 被拒绝：${approved.approvalRejected}。`, state: approved.state };
  }
  return { ok: true, state: approved.state, message: `已通过人工 Gate ${current}，继续推进。` };
}

/** retry --task：对指定卡重跑 writer（仅 B2_WRITER 支持）。 */
export async function retryTask(projectRoot, sessionId, taskId, { runChild, fetchEntries } = {}) {
  const status0 = runStageGate(projectRoot, sessionId, "status");
  const state = status0.ok ? status0.payload?.state : null;
  const current = state?.currentStage;
  if (current !== "B2_WRITER") {
    return { ok: false, error: `retry --task 仅支持 B2_WRITER，当前阶段 ${current || "unknown"}。` };
  }
  if (typeof taskId !== "string" || !taskId.trim()) {
    return { ok: false, error: "缺少 --task <cardId>" };
  }
  const result = readResult(projectRoot, sessionId);
  if (!confirmedCardIds(result).includes(taskId)) {
    return { ok: false, error: `卡片 ${taskId} 不在 result.json cards[] 中。` };
  }
  const attempt = await runWriterForCard(projectRoot, sessionId, taskId, { runChild, fetchEntries });
  if (attempt.status !== "committed") {
    return { ok: false, error: `卡片 ${taskId} writer 重跑失败：${attempt.error}` };
  }
  return { ok: true, message: `卡片 ${taskId} writer 重跑成功。`, attempt };
}

function usage() {
  return [
    "用法：",
    "  agents/workbuddy/scripts/html-report-stage-runner.mjs start  --session <id>",
    "  agents/workbuddy/scripts/html-report-stage-runner.mjs advance --session <id>",
    "  agents/workbuddy/scripts/html-report-stage-runner.mjs status --session <id>",
    "  agents/workbuddy/scripts/html-report-stage-runner.mjs approve --session <id>",
    "  agents/workbuddy/scripts/html-report-stage-runner.mjs retry  --session <id> --task <cardId>",
    "  agents/workbuddy/scripts/html-report-stage-runner.mjs cancel --session <id>",
    "可选：--root <projectRoot>（默认自动探测）、--format text|json（仅 status）",
  ].join("\n");
}

function cliValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : "";
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return { ok: true, command };
  }
  if (!["start", "advance", "status", "approve", "retry", "cancel"].includes(command)) {
    process.stderr.write(`未知命令 ${JSON.stringify(command)}\n${usage()}\n`);
    process.exitCode = 2;
    return { ok: false, error: "unknown command" };
  }
  const sessionId = cliValue(argv, "--session") || cliValue(argv, "--session-id");
  const rootArg = cliValue(argv, "--root");
  const taskId = cliValue(argv, "--task");
  const format = cliValue(argv, "--format") || "text";
  if (!sessionId) {
    process.stderr.write(`命令 ${command} 需要 --session <id>\n`);
    process.exitCode = 2;
    return { ok: false, error: "missing --session" };
  }
  const projectRoot = resolveProjectRoot(rootArg);
  try {
    let output;
    switch (command) {
      case "start":
        output = await start(projectRoot, sessionId);
        break;
      case "status":
        output = status(projectRoot, sessionId, { format });
        break;
      case "cancel":
        output = cancel(projectRoot, sessionId);
        break;
      case "retry":
        output = await retryTask(projectRoot, sessionId, taskId);
        break;
      case "approve":
        output = await approveGate(projectRoot, sessionId);
        break;
      case "advance":
        output = await advance(projectRoot, sessionId);
        break;
      default:
        output = { ok: false, error: "unreachable" };
    }
    process.stdout.write(`${output.message || JSON.stringify(output)}\n`);
    if (!output.ok) process.exitCode = 1;
    return output;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2)}\n`);
    process.exitCode = 1;
    return { ok: false, error: error?.message || String(error) };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
