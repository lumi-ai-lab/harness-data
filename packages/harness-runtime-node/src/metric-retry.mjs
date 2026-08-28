import { isMetricTimeout } from "./metric-timeout.mjs";

export const DEFAULT_FAST_RETRY_CUTOFF_MS = 15_000;
export const DEFAULT_METRIC_FETCH_BUDGET_MS = 540_000;

/** A test may shorten, but never expand, the production fetch budget. */
export function metricFetchBudgetMs(environment = process.env) {
  const configured = Number(environment?.QDM_METRIC_FETCH_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), DEFAULT_METRIC_FETCH_BUDGET_MS)
    : DEFAULT_METRIC_FETCH_BUDGET_MS;
}
const TRANSIENT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
]);

function structuredRetryability(result) {
  try {
    const parsed = JSON.parse(String(result.stderr || ""));
    if (parsed?.error?.retryable === true) return true;
    if (parsed?.error?.retryable === false) return false;
  } catch {
    // Fall through to transport classification.
  }
  return null;
}

export function isRetryableMetricFailure(result = {}, { parseError = "" } = {}) {
  if (isMetricTimeout(result) || parseError) return false;
  if (result.status === 0 && !result.error) return false;
  const structured = structuredRetryability(result);
  if (structured != null) return structured;

  const message = [result.error, result.stderr, result.stdout]
    .filter((part) => typeof part === "string" && part)
    .join("\n");
  const clientStatus = /\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*(4\d\d)\b/i.exec(message);
  if (
    (clientStatus && Number(clientStatus[1]) !== 429) ||
    /\b(?:400|401|403|404|409|422)\b|unauthori[sz]ed|forbidden|invalid\s+(?:payload|argument|parameter)|认证|鉴权|参数错误/i.test(message)
  ) return false;
  if (TRANSIENT_CODES.has(String(result.errorCode || "").toUpperCase())) return true;
  if (result.signal) return false;
  return /\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*(?:429|5\d\d)\b|rate\s*limit|too\s*many\s*requests|service\s*unavailable|bad\s*gateway|socket\s*hang\s*up|connection\s*(?:reset|refused)|网络(?:异常|错误)/i.test(message);
}

export function shouldRetryMetricFailure(
  result = {},
  { parseError = "", fastRetryCutoffMs = DEFAULT_FAST_RETRY_CUTOFF_MS } = {}
) {
  if (!isRetryableMetricFailure(result, { parseError })) return false;
  const durationMs = Number(result.durationMs);
  return Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= fastRetryCutoffMs;
}
