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
 *   node agents/workbuddy/scripts/html-report-stage-runner.mjs retry   --session <id> --task <taskId>
 *   node agents/workbuddy/scripts/html-report-stage-runner.mjs cancel  --session <id>
 *
 * session 目录 = <projectRoot>/.harness/state/html-report/<sanitized-id>，
 * 状态沿用 Pi 既有 stage-gate 契约（$SESSION/debug/pipeline-state.json），
 * 不创建第二份业务状态源。
 *
 * 注意：codebuddy 的 --json-schema 只是提示，不是强制校验。Runner 必须自己
 * 预校验 schema、并后校验 child 输出（JSON 解析 → 角色 Schema → role/taskId/
 * cardId 一致性 → evidence 引用校验），任何失败都不写入正式 session。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchAllEntries, writerReturnPaths } from "../../../packages/html-report-kernel/src/index.mjs";
import { prepareCardCaptionEvidence } from "../../../packages/html-report-kernel/src/evidence/prepare-card-caption-evidence.mjs";
import { validateCaptionSubmissionDetailed, writeCardCaption } from "../../../packages/html-report-kernel/src/captions/submit-card-caption.mjs";
import { composeMain } from "../../../packages/html-report-kernel/src/artifacts/compose-main.mjs";
import { runCodeBuddyChild } from "./codebuddy-child.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const STAGE_GATE_SCRIPT = resolve(SCRIPT_DIR, "../../pi/skills/html-report/scripts/stage-gate.mjs");

const WRITER_MODEL = "custom-local:gpt-5.5";
const WRITER_ROLE = "report-writer";
const WRITER_TIMEOUT_MS = 120_000; // 对齐文档 §4.3：Writer 120s，Reviewer 150s

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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeSessionId(raw) {
  return String(raw || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function htmlReportSessionDir(projectRoot, sessionId) {
  return join(resolve(projectRoot), ".harness", "state", "html-report", sanitizeSessionId(sessionId));
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
    child = await runChild({
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
 * M1: B2_WRITER —— 串行处理每张未完成卡片，卡片隔离（单卡失败不污染后续卡）。
 * 全部成功 → finish B2_WRITER 并自动 start B2_MAIN（人工 Gate 停在 await）。
 * 有失败卡 → 不 finish，保持 running 供 retry，返回失败清单。
 */
export async function runWriterStage(
  projectRoot,
  sessionId,
  { runChild, fetchEntries } = {}
) {
  const result = readResult(projectRoot, sessionId);
  if (!result) {
    return { ok: false, error: `result.json 不存在或不可读：${htmlReportSessionDir(projectRoot, sessionId)}/result.json` };
  }
  const cardIds = confirmedCardIds(result);
  if (cardIds.length === 0) return { ok: false, error: "result.json 没有可用的 cards[]" };

  const pending = cardIds.filter((cardId) => !cardHasCaption(projectRoot, sessionId, cardId));
  if (pending.length === 0) {
    const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "B2_WRITER"]);
    if (!finished.ok) return { ok: false, error: finished.error || "stage-gate finish B2_WRITER 失败" };
    const started = runStageGate(projectRoot, sessionId, "start", ["--stage", "B2_MAIN"]);
    return { ok: true, message: `全部 ${cardIds.length} 张卡已完成；B2_WRITER 已 finish，B2_MAIN 已开始。`, started };
  }

  const failed = [];
  const succeeded = [];
  for (const cardId of pending) {
    const attempt = await runWriterForCard(projectRoot, sessionId, cardId, { runChild, fetchEntries });
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
      message: `B2_WRITER 有 ${failed.length} 张卡失败（已成功 ${succeeded.length} 张）：\n${detail}\n修复后可 retry --task <cardId> 重试。`,
      failed,
      succeeded,
      pending,
    };
  }

  const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "B2_WRITER"]);
  if (!finished.ok) return { ok: false, error: finished.error || "stage-gate finish B2_WRITER 失败" };
  const started = runStageGate(projectRoot, sessionId, "start", ["--stage", "B2_MAIN"]);
  return { ok: true, message: `B2_WRITER 完成 ${succeeded.length} 张卡；B2_MAIN 已开始（人工 Gate，等待批准）。`, started, succeeded };
}

/** Advance one stage; returns { ok, message, state?, stop? }. */
async function advanceStage(projectRoot, sessionId, state, { runChild, fetchEntries } = {}) {
  const stage = state.currentStage;
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
      const outcome = await runWriterStage(projectRoot, sessionId, { runChild, fetchEntries });
      if (!outcome.ok) return { ok: false, message: outcome.message || outcome.error, outcome };
      const after = runStageGate(projectRoot, sessionId, "status");
      return { ok: true, message: outcome.message, state: after.payload?.state, outcome };
    }
    case "B2_MAIN": {
      // 用 composeMain 生成 analysis/main.md（answerFirst 可选，当前用默认）
      let composed;
      try {
        composed = await composeMain(htmlReportSessionDir(projectRoot, sessionId));
      } catch (error) {
        return { ok: false, message: `composeMain 生成 analysis/main.md 失败（可能还有卡片缺 caption.md）：${error?.message || error}` };
      }
      const finished = runStageGate(projectRoot, sessionId, "finish", ["--stage", "B2_MAIN"]);
      if (!finished.ok) return { ok: false, message: finished.error || "stage-gate finish B2_MAIN 失败" };
      const after = runStageGate(projectRoot, sessionId, "status");
      // B2_MAIN 是人工 Gate，step 模式下 finish 后停在 awaiting_approval；Runner 不自动 approve。
      return { ok: true, message: `B2_MAIN 已生成 main.md（${composed.cardIds?.length || 0} 卡）并 finish，等待人工批准（不自动 approve）。`, state: after.payload?.state, composed };
    }
    default:
      if (DISABLED_RUNNER_STAGES.has(stage)) {
        return { ok: true, message: `${stage} 未启用（对齐文档 §9 默认只到 B2_MAIN），不改变状态。`, state };
      }
      return { ok: true, message: `阶段 ${stage} 无需 runner advance。`, state };
  }
}

/** advance：按当前 Gate 阶段分发；自动阶段（A_CONFIG→B0→B2_WRITER→B2_MAIN）级联推进。 */
export async function advance(projectRoot, sessionId, { runChild, fetchEntries } = {}) {
  let status = runStageGate(projectRoot, sessionId, "status");
  if (!status.ok) return { ok: false, error: status.error || "stage-gate status 失败" };
  let state = status.payload?.state;
  if (!state) return { ok: false, error: "stage-gate status 无 state；请先运行 start" };
  if (state.status === "failed") {
    return { ok: false, error: `当前阶段 ${state.currentStage} 已失败，请用 retry --session <id> --task <cardId> 重试，或先 stage-gate retry。` };
  }
  if (state.status === "awaiting_approval") {
    return { ok: true, message: `当前停在人工 Gate：${state.currentStage}，等待批准（不自动 approve）。`, state };
  }

  const logs = [];
  let guard = 0;
  while (state && guard < RUNNER_STAGES.length) {
    const outcome = await advanceStage(projectRoot, sessionId, state, { runChild, fetchEntries });
    logs.push(outcome.message);
    if (!outcome.ok) return { ok: false, message: logs.join("\n"), error: outcome.message, state: outcome.state || state };
    const after = outcome.state || runStageGate(projectRoot, sessionId, "status").payload?.state;
    if (!after || after.currentStage === state.currentStage || after.status === "awaiting_approval") {
      return { ok: true, message: logs.join("\n"), state: after || state };
    }
    state = after;
    guard += 1;
  }
  return { ok: true, message: logs.join("\n"), state };
}

/** start：初始化 gate 并 start A_CONFIG。 */
export function start(projectRoot, sessionId) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const init = runStageGate(projectRoot, sessionId, "init", ["--mode", "step", "--session-id", sanitizeSessionId(sessionId)]);
  if (!init.ok && !/already/i.test(String(init.error || ""))) {
    return { ok: false, error: init.error || "stage-gate init 失败" };
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
  const summary = state
    ? [
        `Session: ${state.sessionId}`,
        `目录: ${state.sessionDir}`,
        `Gate 模式: ${state.mode}  状态: ${state.status}`,
        `当前阶段: ${state.currentStage}`,
        ...RUNNER_STAGES.map((id) => {
          const stage = state.stages?.[id];
          if (!stage) return null;
          const reason = stage.failureReason ? `（${stage.failureReason}）` : "";
          return `  ${id}: ${stage.status}${reason}`;
        }).filter(Boolean),
      ].join("\n")
    : "（无 state）";
  return { ok: true, exists: true, state, message: format === "json" ? JSON.stringify(result.payload, null, 2) : summary };
}

/** cancel：暂停当前阶段。 */
export function cancel(projectRoot, sessionId) {
  const result = runStageGate(projectRoot, sessionId, "pause", ["--reason", "runner cancel"]);
  if (!result.ok) return { ok: false, error: result.error || "stage-gate pause 失败" };
  return { ok: true, state: result.payload?.state, message: "当前阶段已暂停（cancel）。" };
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
  if (!["start", "advance", "status", "retry", "cancel"].includes(command)) {
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
        output = start(projectRoot, sessionId);
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
