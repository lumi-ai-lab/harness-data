#!/usr/bin/env node
/** Confirm recommendations through server.mjs without opening a browser. */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { validateShape } from "./validate-config.mjs";
import { checkSessionLayout } from "./check-session-layout.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
export const DEFAULT_SERVER_SCRIPT = join(root, ".agents/pi/skills/html-report/scripts/server.mjs");

const CONFIRM_CLASSIFICATIONS = new Set([
  "PRODUCT_CONTRACT",
  "TEST_HARNESS",
  "INFRASTRUCTURE",
  "PERFORMANCE_REGRESSION",
]);

export class ConfirmationFailure extends Error {
  constructor({ classification, code, message, cause } = {}) {
    super(String(message || code || "confirmation failed"), cause ? { cause } : undefined);
    this.name = "ConfirmationFailure";
    this.classification = CONFIRM_CLASSIFICATIONS.has(classification)
      ? classification
      : "TEST_HARNESS";
    this.code = String(code || "A_CONFIRM_FAILED");
  }
}

export function confirmationFailure(classification, code, message, cause) {
  if (cause instanceof ConfirmationFailure) return cause;
  return new ConfirmationFailure({ classification, code, message, cause });
}

export function confirmationDeadline(totalTimeoutMs, now = Date.now) {
  const total = Number(totalTimeoutMs);
  const enabled = Number.isFinite(total) && total > 0;
  const startedAt = Number(now());
  const expiresAt = enabled ? startedAt + total : Number.POSITIVE_INFINITY;
  return {
    totalTimeoutMs: enabled ? total : null,
    remaining(capMs = Number.POSITIVE_INFINITY) {
      const cap = Number(capMs);
      const remaining = Math.max(0, expiresAt - Number(now()));
      return Math.max(0, Math.min(remaining, Number.isFinite(cap) && cap > 0 ? cap : remaining));
    },
    expired() {
      return enabled && Number(now()) >= expiresAt;
    },
    failure(operation = "A_CONFIRM") {
      return new ConfirmationFailure({
        classification: "PERFORMANCE_REGRESSION",
        code: "A_CONFIRM_DEADLINE_EXCEEDED",
        message: `${operation} exceeded the single A_CONFIRM deadline of ${total}ms`,
      });
    },
  };
}

export async function withinConfirmationDeadline(operation, deadline, capMs, task) {
  const timeoutMs = deadline.remaining(capMs);
  if (timeoutMs <= 0) throw deadline.failure(operation);
  if (!Number.isFinite(timeoutMs)) return await task();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(deadline.failure(operation)), timeoutMs);
      }),
    ]);
    if (deadline.expired()) throw deadline.failure(operation);
    return result;
  } catch (cause) {
    // Inner HTTP/server timers often share the exact remaining deadline. Under
    // event-loop load they may reject a few microtasks before this wrapper's
    // timer; the externally visible cause is still the single A_CONFIRM hard
    // deadline, not a misleading server/test-harness failure.
    if (deadline.expired() && cause?.code !== "A_CONFIRM_DEADLINE_EXCEEDED") {
      throw deadline.failure(operation);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === "string" ? value.trim() : "";
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");

export function normalizeFilter(filter = {}) {
  const type = text(filter.type) || "DIMENSION";
  const dimUniqueCode = text(first(filter.dimUniqueCode, filter.dim_unique_code));
  if (type === "MEASURE") {
    return {
      type,
      dimUniqueCode,
      mathematicalOperator: {
        operator: first(filter.operator, filter.mathematicalOperator?.operator, "="),
        operatorValue: Number(first(filter.operatorValue, filter.mathematicalOperator?.operatorValue, 0)),
      },
    };
  }
  return {
    type,
    dimUniqueCode,
    dimFieldIdList: list(first(filter.values, filter.dimFieldIdList, filter.dim_field_id_list)),
  };
}

export function compactFilter(filter = {}) {
  return {
    type: text(filter.type) || "DIMENSION",
    dimUniqueCode: text(first(filter.dimUniqueCode, filter.dim_unique_code)),
    values: list(first(filter.values, filter.dimFieldIdList, filter.dim_field_id_list)),
    valueLabelMap: filter.valueLabelMap || filter.value_label_map || {},
    operator: first(filter.operator, filter.mathematicalOperator?.operator, "="),
    operatorValue: first(filter.operatorValue, filter.mathematicalOperator?.operatorValue, ""),
  };
}

/** Query fields mirror public/local-report-builder.html buildRequest(). */
export function buildRequestBody(card = {}) {
  const source = card.requestBody && typeof card.requestBody === "object" ? card.requestBody : {};
  const filters = list(first(card.filters, source.filterDimUniqueCodeList));
  const body = {
    filterDimUniqueCodeList: filters.map(normalizeFilter).filter((item) => item.dimUniqueCode),
    aggDimUniqueCodeList: list(first(card.aggDimUniqueCodeList, source.aggDimUniqueCodeList)),
    indicatorFieldList: list(first(card.indicatorFieldList, source.indicatorFieldList)),
    columnAggDimUniqueCodeList: list(first(card.columnAggDimUniqueCodeList, source.columnAggDimUniqueCodeList)),
    startDate: first(card.startDate, source.startDate),
    endDate: first(card.endDate, source.endDate),
    indicatorsGroup: 1,
    storeCollectType: Number(first(card.storeCollectType, source.storeCollectType, 1)),
    currPage: 1,
    pageSize: 500,
    chartType: first(card.chartType, source.chartType, "table"),
    compareDate: [],
  };
  const orderBy = text(first(card.orderBy, source.orderBy));
  if (orderBy) body.orderBy = orderBy;
  return body;
}

/**
 * Rebuild the request exactly as public/local-report-builder.html does after
 * the page has loaded Indicators metadata.  The page derives orderBy from the
 * resolved first row dimension / first indicator; recommendations.orderBy is
 * intentionally not authoritative for the browser path.
 *
 * HTTP confirmation keeps using buildRequestBody() because it does not load
 * page metadata.  Browser confirmation supplies the metadata snapshot read
 * from the real page and uses this stricter builder for its independent
 * persisted-result check.
 */
export function buildPageRequestBody(card = {}, pageMetadata = {}) {
  const body = buildRequestBody(card);
  delete body.orderBy;

  const dimensions = list(pageMetadata?.dimensions);
  const indicators = list(pageMetadata?.indicators);
  const firstDimCode = text(body.aggDimUniqueCodeList?.[0]);
  const firstIndicatorCode = text(body.indicatorFieldList?.[0]);
  const firstDim = dimensions.find((item) => text(item?.dimUniqueCode) === firstDimCode);
  const firstIndicator = indicators.find(
    (item) => text(item?.indicatorsCodeEn) === firstIndicatorCode
  );

  let orderBy = "";
  if (firstDim?.dimGroupCode === "dim_date_group") {
    const dimName = text(firstDim.dimName);
    if (!dimName) throw new Error(`page metadata has no dimName for ${firstDimCode}`);
    orderBy = `${dimName} ASC`;
  } else if (firstIndicator) {
    const indicatorName = text(firstIndicator.indicatorsName);
    if (!indicatorName) {
      throw new Error(`page metadata has no indicatorsName for ${firstIndicatorCode}`);
    }
    orderBy = `${indicatorName} DESC`;
  }
  if (orderBy) body.orderBy = orderBy;
  return body;
}

export function buildConfirmCard(card = {}, index = 0) {
  const requestBody = buildRequestBody(card);
  const id = text(card.id) || `card_${String(index + 1).padStart(3, "0")}`;
  const title = text(card.title) || `卡片 ${index + 1}`;
  return {
    id,
    title,
    headingLevel: Number(card.headingLevel || 2),
    analysisFocus: text(first(card.analysisFocus, card.analysis_focus)) ||
      `围绕「${title}」用已选指标与维度回答用户问题，并给出可追溯的结论与可深入方向`,
    chartType: requestBody.chartType,
    storeCollectType: requestBody.storeCollectType,
    indicatorBizId: card.indicatorBizId || "",
    aggDimUniqueCodeList: requestBody.aggDimUniqueCodeList,
    columnAggDimUniqueCodeList: requestBody.columnAggDimUniqueCodeList,
    indicatorFieldList: requestBody.indicatorFieldList,
    startDate: requestBody.startDate,
    endDate: requestBody.endDate,
    filters: list(card.filters).map(compactFilter),
    requestBody,
  };
}

export function assertValidRecommendations(recommendations, sessionId) {
  if (!recommendations || typeof recommendations !== "object" || Array.isArray(recommendations)) {
    throw new Error("recommendations.json must contain a JSON object");
  }
  const errors = validateShape(recommendations);
  if (errors.length) throw new Error(`invalid recommendations.json: ${errors.join("; ")}`);
  const configured = text(first(recommendations.sessionId, recommendations.session_id));
  if (configured && configured !== sessionId) {
    throw new Error(`recommendations session ${configured} does not match requested session ${sessionId}`);
  }
  return recommendations;
}

export function buildConfirmPayload(recommendations, { submittedAt = new Date().toISOString() } = {}) {
  const cards = recommendations.cards.map(buildConfirmCard);
  return {
    status: "confirmed",
    submitted_at: submittedAt,
    title: text(recommendations.title) || cards[0]?.title || "Harness Web 报告",
    mode: text(recommendations.mode) || "free",
    cards,
  };
}

/** Build the expected browser payload from recommendations + page metadata. */
export function buildPageConfirmPayload(
  recommendations,
  pageMetadata,
  { submittedAt = new Date().toISOString() } = {}
) {
  const payload = buildConfirmPayload(recommendations, { submittedAt });
  payload.cards = payload.cards.map((card, index) => ({
    ...card,
    requestBody: buildPageRequestBody(recommendations.cards[index], pageMetadata),
  }));
  return payload;
}

export function buildServerArgs({ recommendationsPath, sessionId, serverScript = DEFAULT_SERVER_SCRIPT }) {
  return [
    resolve(serverScript),
    "--config", resolve(recommendationsPath),
    "--session-id", sessionId,
    "--max-idle-ms", "0",
    "--max-lifetime-ms", "0",
  ];
}

export function assertConfirmedResult({ result, recommendations, payload, recommendationsPath, sessionId }) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("result.json must contain a JSON object");
  }
  const configPath = resolve(recommendationsPath);
  const resultPath = join(dirname(configPath), "result.json");
  const errors = [];
  if (result.status !== "confirmed") errors.push(`status=${JSON.stringify(result.status)}`);
  if (result.session_id !== sessionId) errors.push(`session_id=${JSON.stringify(result.session_id)}`);
  if (result.result_path !== resultPath) errors.push(`result_path=${JSON.stringify(result.result_path)}`);
  if (result.recommendations_path !== configPath) errors.push(`recommendations_path=${JSON.stringify(result.recommendations_path)}`);
  if (result.already_validated !== false) errors.push("already_validated must be false");
  if (Object.hasOwn(result, "skip_validate")) errors.push("skip_validate must not be persisted");

  const cards = list(result.cards);
  if (cards.length !== recommendations.cards.length) errors.push("card count mismatch");
  const ids = cards.map((card) => text(card?.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) errors.push("card ids must be non-empty and unique");
  cards.forEach((card, index) => {
    if (JSON.stringify(card?.requestBody) !== JSON.stringify(payload.cards[index]?.requestBody)) {
      errors.push(`card ${card?.id || index + 1} requestBody mismatch`);
    }
    if (!list(card?.requestBody?.indicatorFieldList).length) errors.push(`card ${index + 1} has no indicators`);
    if (!list(card?.requestBody?.aggDimUniqueCodeList).length) errors.push(`card ${index + 1} has no row dimensions`);
  });
  const validation = list(result.validation);
  if (validation.length !== cards.length) errors.push("validation count mismatch");
  validation.forEach((item, index) => {
    if (item?.ok !== true) errors.push(`validation ${index + 1} failed`);
    if (cards[index]?.id && item?.cardId !== cards[index].id) errors.push(`validation ${index + 1} cardId mismatch`);
  });
  if (errors.length) throw new Error(`invalid confirmed result: ${errors.join("; ")}`);
  return { resultPath, cardCount: cards.length, validationCount: validation.length };
}

async function requestJson(fetchImpl, url, options = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let body;
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`HTTP ${response.status} returned invalid JSON: ${raw.slice(0, 500)}`); }
    if (!response.ok) {
      const detail = body?.error?.detail || body?.error?.summary || body?.message || body?.error || raw;
      const error = new Error(`HTTP ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      error.httpStatus = response.status;
      error.responseBody = body;
      error.requestUrl = url;
      throw error;
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function startServer({ recommendationsPath, sessionId, serverScript, env, timeoutMs, spawnImpl }) {
  const child = spawnImpl(process.execPath, buildServerArgs({ recommendationsPath, sessionId, serverScript }), {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20000); });
  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`server startup timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code, signal) => fail(new Error(`server exited before ready: code=${code} signal=${signal}; ${stderr.trim()}`)));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0 || settled) return;
      const url = stdout.slice(0, newline).trim();
      if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) {
        child.kill("SIGTERM");
        fail(new Error(`server returned invalid URL: ${url}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({ child, url });
    });
  });
}

async function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolvePromise) => {
    const done = (value) => { clearTimeout(timer); child.off("exit", onExit); resolvePromise(value); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function shutdownServer(server, fetchImpl, deadline) {
  if (!server) return { ok: true, deadlineExceeded: false };
  let deadlineExceeded = deadline?.expired() === true;
  const remaining = (cap) => deadline ? deadline.remaining(cap) : cap;
  const httpMs = remaining(5000);
  if (httpMs > 0) {
    try {
      await requestJson(fetchImpl, `${server.url}harness/shutdown`, { method: "POST" }, httpMs);
    } catch {
      // Process fallback below.
    }
  } else {
    deadlineExceeded = true;
  }
  let waitMs = remaining(5000);
  if (waitMs > 0 && await waitExit(server.child, waitMs)) {
    return { ok: true, deadlineExceeded };
  }
  if (waitMs <= 0) deadlineExceeded = true;
  server.child.kill("SIGTERM");
  waitMs = remaining(2000);
  if (waitMs > 0 && await waitExit(server.child, waitMs)) {
    return { ok: true, deadlineExceeded };
  }
  if (waitMs <= 0) deadlineExceeded = true;
  server.child.kill("SIGKILL");
  waitMs = remaining(2000);
  const exited = waitMs > 0 ? await waitExit(server.child, waitMs) : false;
  if (waitMs <= 0) deadlineExceeded = true;
  return { ok: exited || server.child.exitCode !== null || server.child.signalCode !== null, deadlineExceeded };
}

/**
 * Dependencies may inject readFile/spawn/fetch/checkSessionLayout for unit tests.
 */
export async function headlessConfirm({
  recommendationsPath,
  sessionId,
  serverScript = DEFAULT_SERVER_SCRIPT,
  env = process.env,
  startupTimeoutMs = 60000,
  confirmTimeoutMs = 180000,
  totalTimeoutMs = null,
  dependencies = {},
} = {}) {
  if (!recommendationsPath) throw new Error("recommendationsPath is required");
  if (!text(sessionId)) throw new Error("sessionId is required");
  const absConfig = resolve(recommendationsPath);
  const readFileImpl = dependencies.readFile || readFile;
  const spawnImpl = dependencies.spawn || spawn;
  const fetchImpl = dependencies.fetch || fetch;
  const checkLayoutImpl = dependencies.checkSessionLayout || checkSessionLayout;
  const deadline = confirmationDeadline(totalTimeoutMs, dependencies.now || Date.now);
  let recommendations;
  try {
    recommendations = JSON.parse(await withinConfirmationDeadline(
      "read recommendations.json",
      deadline,
      startupTimeoutMs,
      () => readFileImpl(absConfig, "utf8")
    ));
    assertValidRecommendations(recommendations, sessionId);
  } catch (cause) {
    if (cause instanceof ConfirmationFailure) throw cause;
    throw confirmationFailure(
      "PRODUCT_CONTRACT",
      "A_CONFIRM_RECOMMENDATIONS_INVALID",
      `cannot read or validate recommendations.json: ${cause.message || cause}`,
      cause
    );
  }
  let payload;
  try {
    payload = buildConfirmPayload(recommendations);
  } catch (cause) {
    throw confirmationFailure(
      "PRODUCT_CONTRACT",
      "A_CONFIRM_REQUEST_BODY_INVALID",
      `cannot build confirmation payload: ${cause.message || cause}`,
      cause
    );
  }
  if (Object.hasOwn(payload, "already_validated") || Object.hasOwn(payload, "skip_validate")) {
    throw confirmationFailure(
      "PRODUCT_CONTRACT",
      "A_CONFIRM_VALIDATION_BYPASS",
      "confirmation payload must not bypass server-side validation"
    );
  }

  let server;
  let completed = false;
  try {
    try {
      server = await withinConfirmationDeadline(
        "server startup",
        deadline,
        startupTimeoutMs,
        () => startServer({
          recommendationsPath: absConfig,
          sessionId,
          serverScript,
          env,
          timeoutMs: deadline.remaining(startupTimeoutMs),
          spawnImpl,
        })
      );
      await withinConfirmationDeadline(
        "server health check",
        deadline,
        startupTimeoutMs,
        () => requestJson(
          fetchImpl,
          `${server.url}healthz`,
          { cache: "no-store" },
          deadline.remaining(startupTimeoutMs)
        )
      );
    } catch (cause) {
      if (cause instanceof ConfirmationFailure) throw cause;
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_SERVER_FAILED",
        `local confirmation server failed: ${cause.message || cause}`,
        cause
      );
    }

    let response;
    try {
      response = await withinConfirmationDeadline(
        "Indicators CLI validation",
        deadline,
        confirmTimeoutMs,
        () => requestJson(fetchImpl, `${server.url}harness/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }, deadline.remaining(confirmTimeoutMs))
      );
    } catch (cause) {
      if (cause instanceof ConfirmationFailure) throw cause;
      if (cause?.httpStatus === 422) {
        throw confirmationFailure(
          "INFRASTRUCTURE",
          "A_CONFIRM_INDICATORS_FAILED",
          `Indicators CLI validation failed: ${cause.message || cause}`,
          cause
        );
      }
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_SERVER_FAILED",
        `confirmation endpoint failed: ${cause.message || cause}`,
        cause
      );
    }
    if (response?.ok !== true || response?.status !== "confirmed") {
      throw confirmationFailure(
        "PRODUCT_CONTRACT",
        "A_CONFIRM_RESULT_INVALID",
        "server response is not confirmed"
      );
    }

    const resultPath = join(dirname(absConfig), "result.json");
    let diskResult;
    let apiResult;
    let contract;
    try {
      diskResult = JSON.parse(await withinConfirmationDeadline(
        "read result.json",
        deadline,
        confirmTimeoutMs,
        () => readFileImpl(resultPath, "utf8")
      ));
      apiResult = await withinConfirmationDeadline(
        "read result API",
        deadline,
        10000,
        () => requestJson(
          fetchImpl,
          `${server.url}harness/result`,
          { cache: "no-store" },
          deadline.remaining(10000)
        )
      );
      if (!isDeepStrictEqual(apiResult, diskResult)) {
        throw new Error("result API does not match result.json");
      }
      contract = assertConfirmedResult({
        result: diskResult,
        recommendations,
        payload,
        recommendationsPath: absConfig,
        sessionId,
      });
    } catch (cause) {
      if (cause instanceof ConfirmationFailure) throw cause;
      throw confirmationFailure(
        "PRODUCT_CONTRACT",
        "A_CONFIRM_RESULT_INVALID",
        `invalid confirmed result: ${cause.message || cause}`,
        cause
      );
    }

    let layout;
    try {
      layout = await withinConfirmationDeadline(
        "phase=a layout",
        deadline,
        confirmTimeoutMs,
        () => checkLayoutImpl(dirname(absConfig), { phase: "a" })
      );
    } catch (cause) {
      if (cause instanceof ConfirmationFailure) throw cause;
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_LAYOUT_CHECK_FAILED",
        `phase=a layout checker failed: ${cause.message || cause}`,
        cause
      );
    }
    if (!layout.ok) {
      throw confirmationFailure(
        "PRODUCT_CONTRACT",
        "A_CONFIRM_LAYOUT_INVALID",
        `phase=a layout failed: ${layout.errors.join("; ")}`
      );
    }
    const output = {
      ok: true,
      sessionId,
      recommendationsPath: absConfig,
      resultPath: contract.resultPath,
      cardCount: contract.cardCount,
      validationCount: contract.validationCount,
      layout,
    };
    completed = true;
    return output;
  } finally {
    const cleanup = await shutdownServer(server, fetchImpl, deadline);
    if (completed && cleanup.deadlineExceeded) throw deadline.failure("server shutdown");
    if (completed && !cleanup.ok) {
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_SERVER_SHUTDOWN_FAILED",
        "local confirmation server did not exit after shutdown"
      );
    }
  }
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!arg.startsWith("--") || !next || next.startsWith("--")) throw new Error(`invalid argument: ${arg}`);
    values[arg.slice(2)] = next;
    i += 1;
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.recommendations || !args["session-id"]) {
    throw new Error("usage: headless-confirm.mjs --recommendations <path> --session-id <id> [--server-script <path>]");
  }
  const result = await headlessConfirm({
    recommendationsPath: args.recommendations,
    sessionId: args["session-id"],
    serverScript: args["server-script"] || DEFAULT_SERVER_SCRIPT,
    startupTimeoutMs: Number(args["startup-timeout-ms"] || 60000),
    confirmTimeoutMs: Number(args["confirm-timeout-ms"] || 180000),
    totalTimeoutMs: args["total-timeout-ms"] ? Number(args["total-timeout-ms"]) : null,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message || error}\n`); process.exit(1); });
}
