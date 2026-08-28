export const EVIDENCE_GAP_TYPES = new Set([
  "missing_indicator",
  "missing_dimension",
  "missing_granularity",
  "missing_range",
  "missing_scope",
  "missing_comparison",
  "metric_definition",
]);

export function isJsonObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Accept one gap type or a merged, non-empty types[] list, never both. */
export function evidenceGapTypes(gap) {
  if (!isJsonObject(gap)) return [];
  const hasType = Object.prototype.hasOwnProperty.call(gap, "type");
  const hasTypes = Object.prototype.hasOwnProperty.call(gap, "types");
  if (hasType === hasTypes) return [];
  const raw = hasTypes ? gap.types : [gap.type];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const normalized = raw.map((type) => String(type || ""));
  if (
    normalized.some((type) => !EVIDENCE_GAP_TYPES.has(type)) ||
    new Set(normalized).size !== normalized.length
  ) return [];
  return normalized;
}

export function isValidEvidenceGap(gap) {
  return Boolean(
    evidenceGapTypes(gap).length > 0 &&
      String(gap.reason || "").trim()
  );
}

const GAP_QUERY_KEYS = {
  missing_indicator: new Set(["metrics"]),
  missing_dimension: new Set(["dimensions"]),
  missing_granularity: new Set(["time.grain", "dimensions"]),
  missing_range: new Set(["time.startDate", "time.endDate"]),
  missing_scope: new Set(["filters", "scopes", "measureFilters"]),
  missing_comparison: new Set(["comparisons"]),
  metric_definition: new Set(["metrics", "statisticPolicy", "measures"]),
};

export function evidenceGapMatchesChangedKeys(gap, changedKeys) {
  if (!isValidEvidenceGap(gap) || !Array.isArray(changedKeys)) return false;
  const allowed = new Set(
    evidenceGapTypes(gap).flatMap((type) => [...GAP_QUERY_KEYS[type]])
  );
  return changedKeys.length > 0 && changedKeys.every((key) => allowed.has(key));
}
