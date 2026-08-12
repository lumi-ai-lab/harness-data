const METRIC_QUERY_KEYS = new Set([
  "requestId",
  "metrics",
  "statisticPolicy",
  "time",
  "dimensions",
  "filters",
  "scopes",
  "measureFilters",
  "orderBy",
  "pageNo",
  "pageSize",
  // Harness-only execution extension. It stays in the single canonical query
  // and is removed only at the qdm-metric-cli process boundary.
  "comparisons",
]);

const LEGACY_QUERY_KEYS = new Set([
  "indicatorFieldList",
  "aggDimUniqueCodeList",
  "columnAggDimUniqueCodeList",
  "filterDimUniqueCodeList",
  "currPage",
  "storeCollectType",
  "indicatorsGroup",
  "chartType",
  "compareDate",
]);

export const DEFAULT_METRIC_PAGE_SIZE = 2000;
export const MAX_METRIC_PAGE_SIZE = 2000;
export const METRIC_COMPARISONS = new Set(["YOY", "MOM"]);
export const METRIC_STATISTIC_POLICIES = new Set(["SUMMARY", "SALES_STORE_DAY_AVG"]);

export function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueStrings(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = value.map((item) => String(item || "").trim());
  if (normalized.some((item) => !item)) throw new Error(`${label} must contain non-empty strings`);
  if (!allowEmpty && normalized.length === 0) throw new Error(`${label} must not be empty`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must not contain duplicates`);
  return normalized;
}

function normalizeFilters(value) {
  if (!isPlainObject(value)) throw new Error("query.filters must be an object of string arrays");
  const filters = {};
  for (const key of Object.keys(value).sort()) {
    const field = String(key || "").trim();
    if (!field) throw new Error("query.filters contains an empty field");
    filters[field] = uniqueStrings(value[key], `query.filters.${field}`).sort();
  }
  return filters;
}

function normalizeTime(value) {
  if (!isPlainObject(value)) throw new Error("query.time must be an object");
  const startDate = String(value.startDate || "").trim();
  const endDate = String(value.endDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error("query.time.startDate/endDate must use YYYY-MM-DD");
  }
  if (startDate > endDate) throw new Error("query.time.startDate must not be after endDate");
  const time = { startDate, endDate };
  if (value.grain != null && String(value.grain).trim()) {
    const grain = String(value.grain).trim().toUpperCase();
    if (!new Set(["DAY", "WEEK", "MONTH"]).has(grain)) {
      throw new Error("query.time.grain must be DAY, WEEK, or MONTH");
    }
    time.grain = grain;
  }
  return time;
}

function normalizeComparisons(value) {
  const comparisons = uniqueStrings(value ?? [], "query.comparisons")
    .map((item) => item.toUpperCase())
    .sort();
  if (new Set(comparisons).size !== comparisons.length) {
    throw new Error("query.comparisons must not contain duplicates");
  }
  if (comparisons.some((item) => !METRIC_COMPARISONS.has(item))) {
    throw new Error("query.comparisons only supports YOY and MOM");
  }
  return comparisons;
}

function normalizePositiveInteger(value, label, fallback, cap = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (value == null || value === "") return fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return Math.min(parsed, cap);
}

function normalizedOptionalObject(value, label) {
  if (value == null) return undefined;
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return structuredClone(value);
}

/**
 * Normalize the sole Phase-B query contract. The internal representation is a
 * flat object that merges the strict qdm-metric-cli QueryRequest fields with
 * the Harness-only comparisons flag.  At the CLI process boundary
 * metricCliPayload() strips comparisons and metricComparisonArgs() maps them
 * to --yoy/--mom flags.
 */
export function normalizeMetricQuery(rawQuery, { defaultComparisons = [] } = {}) {
  if (!isPlainObject(rawQuery)) throw new Error("query must be a Metric QueryRequest object");
  const legacy = Object.keys(rawQuery).filter((key) => LEGACY_QUERY_KEYS.has(key));
  if (legacy.length) {
    throw new Error(`LEGACY_INDICATORS_PAYLOAD_UNSUPPORTED: ${legacy.sort().join(", ")}`);
  }
  const unknown = Object.keys(rawQuery).filter((key) => !METRIC_QUERY_KEYS.has(key));
  if (unknown.length) throw new Error(`query contains unsupported fields: ${unknown.sort().join(", ")}`);

  const statisticPolicy = String(rawQuery.statisticPolicy || "").trim().toUpperCase();
  if (!METRIC_STATISTIC_POLICIES.has(statisticPolicy)) {
    throw new Error("query.statisticPolicy only supports SUMMARY and SALES_STORE_DAY_AVG");
  }
  const dimensions = uniqueStrings(rawQuery.dimensions, "query.dimensions");
  const comparisons = normalizeComparisons(rawQuery.comparisons ?? defaultComparisons);
  if (comparisons.length && dimensions.length === 0) {
    throw new Error("query.comparisons requires at least one dimension");
  }
  const query = {
    metrics: uniqueStrings(rawQuery.metrics, "query.metrics", { allowEmpty: false }),
    statisticPolicy,
    time: normalizeTime(rawQuery.time),
    dimensions,
    filters: normalizeFilters(rawQuery.filters ?? {}),
    pageNo: 1,
    pageSize: normalizePositiveInteger(
      rawQuery.pageSize,
      "query.pageSize",
      DEFAULT_METRIC_PAGE_SIZE,
      MAX_METRIC_PAGE_SIZE
    ),
    comparisons,
  };
  if (rawQuery.requestId != null && String(rawQuery.requestId).trim()) {
    query.requestId = String(rawQuery.requestId).trim();
  }
  const scopes = normalizedOptionalObject(rawQuery.scopes, "query.scopes");
  if (scopes) query.scopes = scopes;
  if (rawQuery.measureFilters != null) {
    if (!Array.isArray(rawQuery.measureFilters)) throw new Error("query.measureFilters must be an array");
    query.measureFilters = structuredClone(rawQuery.measureFilters);
  }
  if (rawQuery.orderBy != null) {
    if (!isPlainObject(rawQuery.orderBy)) throw new Error("query.orderBy must be an object");
    const field = String(rawQuery.orderBy.field || "").trim();
    const direction = String(rawQuery.orderBy.direction || "").trim().toUpperCase();
    if (!field || !new Set(["ASC", "DESC"]).has(direction)) {
      throw new Error("query.orderBy requires field and ASC or DESC direction");
    }
    query.orderBy = { field, direction };
  }
  return query;
}

/**
 * Build the canonical query once from one confirmed card.
 *
 * Each card carries exactly one query wrapper:
 *   card.query = { request: <strict QueryRequest>, comparisons: ["YOY","MOM"] }
 *
 * The internal flat representation merges request + comparisons so that
 * downstream code (executor, explore, shape, delta) works unchanged.  Legacy
 * requestBody/queryProof/cli/queryProof forms are rejected to enforce the
 * single-query contract.
 */
export function metricQueryFromCard(card) {
  if (!isPlainObject(card)) throw new Error("confirmed card must be an object");

  // Reject all legacy multi-query representations.
  for (const legacyKey of ["requestBody", "queryProof", "cli"]) {
    if (Object.prototype.hasOwnProperty.call(card, legacyKey)) {
      throw new Error(
        `LEGACY_QUERY_FIELD_UNSUPPORTED: card.${legacyKey} is removed; use card.query = { request, comparisons }`
      );
    }
  }
  // Reject top-level query mirror fields.
  for (const mirrorKey of ["metrics", "dimensions", "startDate", "endDate", "filters", "statisticPolicy"]) {
    if (Object.prototype.hasOwnProperty.call(card, mirrorKey)) {
      throw new Error(
        `LEGACY_QUERY_MIRROR_UNSUPPORTED: card.${mirrorKey} is removed; use card.query.request`
      );
    }
  }

  const query = card.query;
  if (!isPlainObject(query)) {
    throw new Error("card.query must be an object with request and comparisons");
  }
  const request = query.request;
  if (!isPlainObject(request)) {
    throw new Error("card.query.request must be a strict Metric QueryRequest object");
  }
  // comparisons is optional; default to empty.
  const comparisons = Array.isArray(query.comparisons) ? query.comparisons : [];
  return normalizeMetricQuery(request, { defaultComparisons: comparisons });
}

/** Strip the one Harness extension before invoking qdm-metric-cli. */
export function metricCliPayload(query) {
  const normalized = normalizeMetricQuery(query);
  const { comparisons: _comparisons, ...payload } = normalized;
  return payload;
}

export function metricComparisonArgs(query) {
  const comparisons = normalizeMetricQuery(query).comparisons;
  return [
    ...(comparisons.includes("YOY") ? ["--yoy"] : []),
    ...(comparisons.includes("MOM") ? ["--mom"] : []),
  ];
}

export function metricQueryKeys() {
  return new Set(METRIC_QUERY_KEYS);
}
