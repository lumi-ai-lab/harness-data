/**
 * Classify terminal Indicators timeouts consistently for Writer and
 * Researcher fetches. Successful payload text is never inspected, because a
 * legitimate data cell may itself contain words such as "timeout" or "超时".
 */
export function isIndicatorsTimeout(result = {}) {
  if (result.timedOut === true || result.errorCode === "ETIMEDOUT") return true;
  if (result.status === 0 && !result.error) return false;
  const message = [result.error, result.stderr, result.stdout]
    .filter((part) => typeof part === "string" && part)
    .join("\n");
  return /\bETIMEDOUT\b|\btime(?:d)?\s*out\b|\btimeout(?:\s+(?:exceeded|expired))?\b|\bHTTP\s+(?:408|504)\b|\bstatus(?:\s+code)?\s*[:=]?\s*(?:408|504)\b|超时/i.test(message);
}
