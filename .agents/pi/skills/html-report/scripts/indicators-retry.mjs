import { isIndicatorsTimeout } from "./indicators-timeout.mjs";

export const DEFAULT_FAST_RETRY_CUTOFF_MS = 15_000;
export const DEFAULT_INDICATORS_FETCH_BUDGET_MS = 540_000;

/** A test may shorten, but never expand, the production fetch budget. */
export function indicatorsFetchBudgetMs(environment = process.env) {
  const configured = Number(environment?.QDM_INDICATORS_FETCH_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), DEFAULT_INDICATORS_FETCH_BUDGET_MS)
    : DEFAULT_INDICATORS_FETCH_BUDGET_MS;
}

const TRANSIENT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
]);

/** Retry only explicit transient transport/backend failures. */
export function isRetryableIndicatorsFailure(result = {}, { parseError = "" } = {}) {
  if (isIndicatorsTimeout(result) || parseError) return false;
  if (result.status === 0 && !result.error) return false;

  const message = [result.error, result.stderr, result.stdout]
    .filter((part) => typeof part === "string" && part)
    .join("\n");
  const clientStatus = /\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*(4\d\d)\b/i.exec(message);
  if (
    (clientStatus && Number(clientStatus[1]) !== 429) ||
    /\b(?:400|401|403|404|409|422)\b|unauthori[sz]ed|forbidden|invalid\s+(?:payload|argument|parameter)|认证|鉴权|令牌|参数错误/i.test(message)
  ) {
    return false;
  }
  if (TRANSIENT_CODES.has(String(result.errorCode || "").toUpperCase())) return true;
  // A signal alone is not proof of a transient backend problem: SIGKILL can
  // mean an outer runtime cap or OOM, and retrying it can repeat the full
  // expensive query.  Only the explicit transport codes/messages below are
  // retryable.
  if (result.signal) return false;
  return /\b(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*(?:429|5\d\d)\b|rate\s*limit|too\s*many\s*requests|service\s*unavailable|bad\s*gateway|socket\s*hang\s*up|connection\s*(?:reset|refused)|网络(?:异常|错误)/i.test(message);
}

/**
 * Apply the child-runtime budget to a transient failure.  A late 5xx after a
 * long query is not a "fast retry": starting another 600-second attempt can
 * only run into the 720-second Writer/Researcher envelope and duplicate work.
 */
export function shouldRetryIndicatorsFailure(
  result = {},
  { parseError = "", fastRetryCutoffMs = DEFAULT_FAST_RETRY_CUTOFF_MS } = {}
) {
  if (!isRetryableIndicatorsFailure(result, { parseError })) return false;
  const durationMs = Number(result.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 0) return false;
  return durationMs <= fastRetryCutoffMs;
}
