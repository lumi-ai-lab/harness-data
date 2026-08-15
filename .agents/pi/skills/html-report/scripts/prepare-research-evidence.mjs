#!/usr/bin/env node
/**
 * Prepare a compact, deterministic evidence packet for one B3 Researcher task.
 *
 * The script reads the complete persisted data locally, but only the compact
 * evidence packet is handed to the LLM. It never calls Indicators and never
 * writes profile/facts artifacts.
 *
 * Usage:
 *   node prepare-research-evidence.mjs \
 *     --result <result.json> --task-id <id>
 *   node prepare-research-evidence.mjs \
 *     --result <result.json> --source-fields
 *
 * Writes:
 *   $SESSION/analysis/evidence/<task-id>.json
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticQueryShape, applyQueryPatch } from "./fetch-explore.mjs";
import { columnMetaPathFor } from "./fetch-entry.mjs";
import { metricQueryFromCard } from "./metric-query-contract.mjs";
import { persistEditorSourceInventory } from "./editor-plan-contract.mjs";
import {
  evidenceGapMatchesChangedKeys,
  isJsonObject,
  isValidEvidenceGap,
} from "./research-contract.mjs";
import { sanitizeCardId } from "./writer-return.mjs";

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name) => argv.includes(name);

const MAX_EVIDENCE_ROWS = 50;
const MAX_GROUPS = 20;
const MAX_ANALYSIS_FIELDS = 20;
const MAX_QUANTILE_BINS = 10;
const MAX_JOINT_BIN_COUNT = 5;
const MAX_EXCLUSION_POINTERS = 20;
const MAX_BIN_POINTERS = 5;
const MAX_RETURNED_JOINT_CELLS = 4;
const MIN_RETURNED_JOINT_CELLS = 2;
export const MIN_JOINT_CELL_SUPPORT = 3;
const MODES = new Set(["reuse_entry", "new_query"]);
const OPERATION_TYPES = new Set([
  "project",
  "sort",
  "topN",
  "bottomN",
  "stats",
  "range",
  "subsetStats",
  "compare",
  "compareTopN",
  "groupBy",
  "correlation",
  "quantileBins",
  "jointQuantileBins",
]);
const WHERE_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in"]);

export function sanitizeTaskId(raw) {
  const value = String(raw || "task").trim();
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "task";
}

/** RFC 8785/JCS-compatible canonicalization for JSON values parsed by Node. */
export function canonicalizeJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
    .join(",")}}`;
}

export function rowsSha256(rows) {
  return createHash("sha256").update(canonicalizeJson(rows), "utf8").digest("hex");
}

function sha256Json(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

export function compactDecisionQueryScope(queryCoverage) {
  if (!queryCoverage || typeof queryCoverage !== "object" || Array.isArray(queryCoverage)) return null;
  const scope = {};
  const nestedTime = queryCoverage.time && typeof queryCoverage.time === "object" && !Array.isArray(queryCoverage.time)
    ? queryCoverage.time
    : {};
  const time = {
    startDate: nestedTime.startDate ?? queryCoverage["time.startDate"],
    endDate: nestedTime.endDate ?? queryCoverage["time.endDate"],
  };
  if (typeof time.startDate === "string" || typeof time.endDate === "string") {
    scope.dateRange = {
      startDate: typeof time.startDate === "string" ? time.startDate : null,
      endDate: typeof time.endDate === "string" ? time.endDate : null,
    };
  }
  const filterMap = queryCoverage.filters && typeof queryCoverage.filters === "object" && !Array.isArray(queryCoverage.filters)
    ? queryCoverage.filters
    : {};
  const filters = Object.entries(filterMap).flatMap(([field, rawValues]) => {
    const values = Array.isArray(rawValues)
      ? rawValues.filter((item) => ["string", "number"].includes(typeof item))
      : [];
    return field && values.length ? [{ field, values }] : [];
  });
  if (filters.length) scope.filters = filters;
  return Object.keys(scope).length ? scope : null;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["rows", "data", "result", "items"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function ensureInside(sessionDir, path, label) {
  const abs = resolve(path);
  const rel = relative(sessionDir, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  throw new Error(`${label} must stay under SESSION: ${abs}`);
}

/**
 * Resolve a JSON input through the expected session subtree without following
 * a model-created symlink. The lexical-root check also rejects dot-segment
 * identifiers before any filesystem read occurs.
 */
async function readJsonWithin(
  sessionDir,
  allowedRoot,
  path,
  label,
  { optional = false } = {}
) {
  const absSession = resolve(sessionDir);
  const absRoot = ensureInside(absSession, allowedRoot, `${label} root`);
  const absPath = ensureInside(absRoot, path, label);
  const rel = relative(absSession, absPath);
  const parts = rel.split(sep).filter(Boolean);
  if (!parts.length) throw new Error(`${label} must be a file below SESSION`);

  let cursor = absSession;
  let leafInfo = null;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (optional && error?.code === "ENOENT") {
        return { present: false, value: null, path: absPath };
      }
      throw new Error(`${label} is missing from its expected session path`);
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} must not use symbolic links`);
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`${label} has a non-directory parent component`);
    }
    if (index === parts.length - 1 && !info.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (index === parts.length - 1) leafInfo = info;
  }

  const [realSession, realFile] = await Promise.all([
    realpath(absSession),
    realpath(absPath),
  ]);
  ensureInside(realSession, realFile, label);
  try {
    return {
      present: true,
      value: JSON.parse(await readFile(realFile, "utf8")),
      path: absPath,
      mtimeMs: leafInfo?.mtimeMs ?? null,
    };
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function roundNumber(number) {
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(6));
}

function displayNumber(number) {
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(3));
}

function reportDisplayNumber(number) {
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(2));
}

function numericCell(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw, unit: null };
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/,/g, "");
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(%)?$/.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? { value: number, unit: match[2] || null } : null;
}

function compareCells(left, right) {
  const a = numericCell(left);
  const b = numericCell(right);
  if (a && b) return a.value - b.value;
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return String(left).localeCompare(String(right), "zh-CN");
}

function isEmptySortCell(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function fieldStats(rows, field) {
  const parsed = rows.map((item) => numericCell(item.row[field])).filter(Boolean);
  const values = parsed.map((item) => item.value).sort((a, b) => a - b);
  const unitSet = new Set(parsed.map((item) => item.unit || ""));
  const distinct = new Set(rows.map((item) => canonicalizeJson(item.row[field]))).size;
  const base = {
    count: rows.length,
    numericCount: values.length,
    nullCount: rows.filter((item) => item.row[field] == null).length,
    distinctCount: distinct,
  };
  if (!values.length) return base;
  const middle = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
  return {
    ...base,
    unit: unitSet.size === 1 ? ([...unitSet][0] || null) : null,
    min: roundNumber(values[0]),
    max: roundNumber(values[values.length - 1]),
    sum: roundNumber(values.reduce((total, number) => total + number, 0)),
    mean: roundNumber(values.reduce((total, number) => total + number, 0) / values.length),
    median: roundNumber(median),
  };
}

function statsWithReportDisplay(stats) {
  if (!stats || typeof stats !== "object") return stats;
  const display = Object.fromEntries(
    ["min", "max", "sum", "mean", "median"].flatMap((key) => {
      if (!Number.isFinite(stats[key])) return [];
      const rounded = reportDisplayNumber(stats[key]);
      return Object.is(rounded, stats[key]) ? [] : [[key, rounded]];
    })
  );
  return Object.keys(display).length ? { ...stats, display } : stats;
}

function assertFields(rows, fields, operationId) {
  if (rows.length === 0) return;
  const available = new Set(rows.flatMap((item) => Object.keys(item.row)));
  for (const field of fields) {
    if (!available.has(field)) {
      throw new Error(`operation ${operationId} references missing field ${JSON.stringify(field)}`);
    }
  }
}

function normalizeFields(raw, fallback = []) {
  const fields = Array.isArray(raw) ? raw.map(String).filter(Boolean) : fallback;
  return [...new Set(fields)];
}

function requireField(raw, operationId, parameter) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`operation ${operationId} requires non-empty ${parameter}`);
  }
  return raw;
}

function requireAnalysisFields(raw, operationId) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`operation ${operationId} requires non-empty fields[]`);
  }
  if (raw.some((field) => typeof field !== "string" || field.trim() === "")) {
    throw new Error(`operation ${operationId} fields[] must contain only non-empty strings`);
  }
  const fields = [...new Set(raw)];
  if (fields.length > MAX_ANALYSIS_FIELDS) {
    throw new Error(
      `operation ${operationId} fields[] count ${fields.length} exceeds cap ${MAX_ANALYSIS_FIELDS}`
    );
  }
  return fields;
}

function sortedFields(fields) {
  return [...new Set(fields.map(String))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function addFieldReference(references, field, location) {
  const normalized = String(field || "");
  if (!normalized) return;
  if (!references.has(normalized)) references.set(normalized, new Set());
  references.get(normalized).add(location);
}

function collectOperationFieldReferences(operations, references) {
  if (!Array.isArray(operations)) return;
  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
    const base = `evidencePlan.operations[${index}]`;
    const type = String(operation.type || "");
    for (const field of normalizeFields(operation.fields)) {
      addFieldReference(references, field, `${base}.fields`);
    }
    const clauses = operation.where == null
      ? []
      : (Array.isArray(operation.where) ? operation.where : [operation.where]);
    for (const [clauseIndex, clause] of clauses.entries()) {
      addFieldReference(references, clause?.field, `${base}.where[${clauseIndex}].field`);
    }
    if (["sort", "topN", "bottomN"].includes(type)) {
      addFieldReference(references, operation.field, `${base}.field`);
    }
    if (["subsetStats", "compareTopN", "compare"].includes(type)) {
      const usesSortBy = Boolean(operation.sortBy);
      addFieldReference(
        references,
        operation.sortBy || operation.field,
        `${base}.${usesSortBy ? "sortBy" : "field"}`
      );
    }
    if (type === "groupBy") {
      const usesGroupField = Boolean(operation.groupField);
      addFieldReference(
        references,
        operation.groupField || operation.field,
        `${base}.${usesGroupField ? "groupField" : "field"}`
      );
    }
    if (["correlation", "quantileBins", "jointQuantileBins"].includes(type)) {
      addFieldReference(references, operation.targetField, `${base}.targetField`);
    }
  }
}

export class EvidenceFieldValidationError extends Error {
  constructor(details) {
    super(`EVIDENCE_FIELD_MISMATCH ${JSON.stringify(details)}`);
    this.name = "EvidenceFieldValidationError";
    this.code = "EVIDENCE_FIELD_MISMATCH";
    this.details = details;
  }
}

/**
 * Validate all field references in one pass so the Editor can repair one plan
 * once instead of discovering requiredColumns/where/sort failures one by one.
 */
export function validateEvidenceFieldReferences(
  sourceRows,
  { requiredColumns = [], operations = [] } = {}
) {
  if (
    !Array.isArray(sourceRows) ||
    sourceRows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  ) {
    throw new Error("evidence source must be an array of row objects");
  }
  const availableFields = sortedFields(sourceRows.flatMap((row) => Object.keys(row)));
  if (sourceRows.length === 0) {
    return {
      validation: "unverifiable_empty_source",
      availableFields,
      missingFields: [],
    };
  }

  const references = new Map();
  for (const field of normalizeFields(requiredColumns)) {
    addFieldReference(references, field, "evidencePlan.requiredColumns");
  }
  collectOperationFieldReferences(operations, references);

  const available = new Set(availableFields);
  const missingFields = [...references.entries()]
    .filter(([field]) => !available.has(field))
    .map(([field, locations]) => ({ field, references: [...locations].sort() }))
    .sort((left, right) => left.field < right.field ? -1 : left.field > right.field ? 1 : 0);
  if (missingFields.length) {
    throw new EvidenceFieldValidationError({ availableFields, missingFields });
  }
  return { validation: "validated", availableFields, missingFields };
}

function compareWhere(raw, operator, expected) {
  if (operator === "in") {
    const values = Array.isArray(expected) ? expected : [expected];
    return values.some((value) => compareCells(raw, value) === 0);
  }
  const result = compareCells(raw, expected);
  if (operator === "eq") return result === 0;
  if (operator === "ne") return result !== 0;
  if (operator === "gt") return result > 0;
  if (operator === "gte") return result >= 0;
  if (operator === "lt") return result < 0;
  if (operator === "lte") return result <= 0;
  throw new Error(`unsupported where operator ${JSON.stringify(operator)}`);
}

function applyWhere(rows, where, operationId) {
  if (where == null) return rows;
  if (!Array.isArray(where) || where.length === 0) {
    throw new Error(`operation ${operationId} where must be a non-empty array`);
  }
  const clauses = where;
  const fields = clauses.map((clause, index) => {
    if (!clause || typeof clause !== "object" || Array.isArray(clause)) {
      throw new Error(`operation ${operationId} where[${index}] must be an object`);
    }
    for (const requiredKey of ["field", "op", "value"]) {
      if (!Object.prototype.hasOwnProperty.call(clause, requiredKey)) {
        throw new Error(`operation ${operationId} where[${index}] requires ${requiredKey}`);
      }
    }
    const keys = Object.keys(clause).sort();
    if (keys.length !== 3 || keys[0] !== "field" || keys[1] !== "op" || keys[2] !== "value") {
      throw new Error(`operation ${operationId} where[${index}] must contain only field, op, and value`);
    }
    const field = requireField(clause.field, operationId, `where[${index}].field`);
    const operator = String(clause.op || "");
    if (!WHERE_OPERATORS.has(operator)) {
      throw new Error(`operation ${operationId} has unsupported where operator ${JSON.stringify(operator)}`);
    }
    if (operator === "in" && (!Array.isArray(clause.value) || clause.value.length === 0)) {
      throw new Error(`operation ${operationId} where[${index}] op=in requires a non-empty array value`);
    }
    if (operator !== "in" && Array.isArray(clause.value)) {
      throw new Error(`operation ${operationId} where[${index}] op=${operator} requires a scalar value`);
    }
    return field;
  });
  assertFields(rows, fields, operationId);
  return rows.filter((item) =>
    clauses.every((clause) => {
      const operator = String(clause.op);
      const expected = clause.value;
      return compareWhere(item.row[clause.field], operator, expected);
    })
  );
}

function sortedRows(rows, field, direction, operationId) {
  assertFields(rows, [field], operationId);
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const leftEmpty = isEmptySortCell(a.row[field]);
    const rightEmpty = isEmptySortCell(b.row[field]);
    if (leftEmpty || rightEmpty) {
      if (leftEmpty && rightEmpty) return a.index - b.index;
      return leftEmpty ? 1 : -1;
    }
    const compared = compareCells(a.row[field], b.row[field]);
    return compared === 0 ? a.index - b.index : compared * factor;
  });
}

function evidenceRows(rows, fields, { includeRank = false } = {}) {
  return rows.map((item, index) => ({
    ...(includeRank ? { rank: index + 1 } : {}),
    sourcePointer: `/${item.index}`,
    row: Object.fromEntries(fields.map((field) => [field, item.row[field]])),
  }));
}

function boundedCount(raw, fallback = 10) {
  const parsed = Number(raw);
  const count = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  if (count > MAX_EVIDENCE_ROWS) {
    throw new Error(`evidence row count ${count} exceeds cap ${MAX_EVIDENCE_ROWS}`);
  }
  return count;
}

function statsObject(rows, fields) {
  return Object.fromEntries(fields.map((field) => [field, fieldStats(rows, field)]));
}

function comparedStats(selectedRows, remainingRows, fields) {
  const selectedStats = statsObject(selectedRows, fields);
  const remainingStats = statsObject(remainingRows, fields);
  for (const field of fields) {
    const selectedMean = selectedStats[field]?.mean;
    const remainingMean = remainingStats[field]?.mean;
    if (!Number.isFinite(selectedMean) || !Number.isFinite(remainingMean)) continue;
    const meanDelta = roundNumber(selectedMean - remainingMean);
    selectedStats[field] = {
      ...selectedStats[field],
      comparisonToRemaining: {
        remainingCount: remainingStats[field].count,
        remainingMean,
        remainingMeanDisplay: displayNumber(remainingMean),
        meanDelta,
        meanDeltaDisplay: displayNumber(meanDelta),
        direction: meanDelta > 0 ? "higher" : meanDelta < 0 ? "lower" : "equal",
      },
    };
  }
  return { selectedStats, remainingStats };
}

function profileCell(row, field) {
  if (!Object.prototype.hasOwnProperty.call(row, field)) return { kind: "missing", numeric: null };
  const raw = row[field];
  if (raw == null) return { kind: "null", numeric: null };
  if (typeof raw === "string" && raw.trim() === "") return { kind: "blank", numeric: null };
  const numeric = numericCell(raw);
  return numeric ? { kind: "numeric", numeric } : { kind: "non_numeric", numeric: null };
}

function incompleteRequiredFields(row, requiredColumns) {
  return requiredColumns
    .map((field) => ({ field, kind: profileCell(row, field).kind }))
    .filter((item) => ["missing", "null", "blank"].includes(item.kind));
}

function pairwiseNumericPopulation(rows, targetField, field) {
  const eligible = [];
  const excluded = [];
  const reasons = {
    targetOnlyNonNumeric: 0,
    fieldOnlyNonNumeric: 0,
    bothNonNumeric: 0,
  };
  const cellReasons = {
    target: { missing: 0, null: 0, blank: 0, nonNumeric: 0 },
    field: { missing: 0, null: 0, blank: 0, nonNumeric: 0 },
  };
  for (const item of rows) {
    const targetCell = profileCell(item.row, targetField);
    const fieldCell = profileCell(item.row, field);
    const target = targetCell.numeric;
    const driver = fieldCell.numeric;
    if (target && driver) {
      eligible.push({ item, target: target.value, field: driver.value });
      continue;
    }
    if (!target) {
      const key = targetCell.kind === "non_numeric" ? "nonNumeric" : targetCell.kind;
      cellReasons.target[key] += 1;
    }
    if (!driver) {
      const key = fieldCell.kind === "non_numeric" ? "nonNumeric" : fieldCell.kind;
      cellReasons.field[key] += 1;
    }
    const reason = !target && !driver
      ? "bothNonNumeric"
      : (!target ? "targetOnlyNonNumeric" : "fieldOnlyNonNumeric");
    reasons[reason] += 1;
    excluded.push(item);
  }
  return {
    eligible,
    exclusions: {
      count: excluded.length,
      reasons,
      cellReasons,
      sourcePointers: excluded
        .slice(0, MAX_EXCLUSION_POINTERS)
        .map((item) => `/${item.index}`),
      pointersTruncated: excluded.length > MAX_EXCLUSION_POINTERS,
    },
  };
}

function pearsonCorrelation(pairs) {
  if (pairs.length < 2) return { status: "insufficient_pairs", coefficient: null };
  const targetMean = pairs.reduce((sum, item) => sum + item.target, 0) / pairs.length;
  const fieldMean = pairs.reduce((sum, item) => sum + item.field, 0) / pairs.length;
  let cross = 0;
  let targetSquares = 0;
  let fieldSquares = 0;
  for (const item of pairs) {
    const targetDelta = item.target - targetMean;
    const fieldDelta = item.field - fieldMean;
    cross += targetDelta * fieldDelta;
    targetSquares += targetDelta * targetDelta;
    fieldSquares += fieldDelta * fieldDelta;
  }
  const denominator = Math.sqrt(targetSquares * fieldSquares);
  if (!Number.isFinite(denominator) || denominator === 0) {
    return { status: "zero_variance", coefficient: null };
  }
  const coefficient = Math.max(-1, Math.min(1, cross / denominator));
  return { status: "ok", coefficient: roundNumber(coefficient) };
}

function zeroValueSensitivity(pairs) {
  const retained = [];
  const excluded = [];
  const reasons = { targetOnlyZero: 0, fieldOnlyZero: 0, bothZero: 0 };
  for (const pair of pairs) {
    const targetZero = pair.target === 0;
    const fieldZero = pair.field === 0;
    if (!targetZero && !fieldZero) {
      retained.push(pair);
      continue;
    }
    reasons[targetZero && fieldZero ? "bothZero" : targetZero ? "targetOnlyZero" : "fieldOnlyZero"] += 1;
    excluded.push(pair);
  }
  if (!excluded.length) {
    return { applied: false, reason: "no_zero_value_pairs" };
  }
  return {
    applied: true,
    policy: "exclude_pair_when_target_or_field_equals_zero",
    sourceEligibleRows: pairs.length,
    eligibleRows: retained.length,
    exclusions: {
      count: excluded.length,
      reasons,
      sourcePointers: excluded
        .slice(0, MAX_EXCLUSION_POINTERS)
        .map((pair) => `/${pair.item.index}`),
      pointersTruncated: excluded.length > MAX_EXCLUSION_POINTERS,
    },
    ...pearsonCorrelation(retained),
  };
}

function quantileBinCount(raw, operationId) {
  if (raw == null) return 4;
  if (!Number.isSafeInteger(raw) || raw < 2 || raw > MAX_QUANTILE_BINS) {
    throw new Error(
      `operation ${operationId} binCount must be an integer from 2 to ${MAX_QUANTILE_BINS}`
    );
  }
  return raw;
}

function quantileGrid(rows, targetField, field, requestedBinCount) {
  const population = pairwiseNumericPopulation(rows, targetField, field);
  const ordered = [...population.eligible].sort((left, right) =>
    left.field === right.field ? left.item.index - right.item.index : left.field - right.field
  );
  const desiredBinCount = Math.min(requestedBinCount, ordered.length);
  const maxValue = ordered.at(-1)?.field;
  const cutPoints = [];
  for (let index = 1; index < desiredBinCount; index += 1) {
    const rank = Math.ceil((index * ordered.length) / desiredBinCount) - 1;
    const value = ordered[rank]?.field;
    if (
      Number.isFinite(value) &&
      value < maxValue &&
      (cutPoints.length === 0 || cutPoints.at(-1) !== value)
    ) {
      cutPoints.push(value);
    }
  }
  const grouped = Array.from({ length: cutPoints.length + (ordered.length ? 1 : 0) }, () => []);
  for (const pair of ordered) {
    const found = cutPoints.findIndex((cutPoint) => pair.field <= cutPoint);
    grouped[found === -1 ? cutPoints.length : found].push(pair.item);
  }
  const bins = grouped.map((binRows, index) => ({
    ordinal: index + 1,
    label: `Q${index + 1}`,
    rowCount: binRows.length,
    sourcePointers: binRows.slice(0, MAX_BIN_POINTERS).map((item) => `/${item.index}`),
    pointersTruncated: binRows.length > MAX_BIN_POINTERS,
    fieldStats: statsWithReportDisplay(fieldStats(binRows, field)),
    targetStats: statsWithReportDisplay(fieldStats(binRows, targetField)),
  }));
  const baseline = bins[0];
  const baselineMean = baseline?.targetStats?.mean;
  return {
    eligibleRows: ordered.length,
    exclusions: population.exclusions,
    actualBinCount: grouped.length,
    cutPoints: cutPoints.map(roundNumber),
    bins: bins.map((bin) => {
      const mean = bin.targetStats?.mean;
      if (!Number.isFinite(baselineMean) || !Number.isFinite(mean)) return bin;
      const meanDelta = roundNumber(mean - baselineMean);
      return {
        ...bin,
        comparisonToFirst: {
          baselineLabel: baseline.label,
          baselineMean,
          baselineMeanDisplay: reportDisplayNumber(baselineMean),
          meanDelta,
          meanDeltaDisplay: reportDisplayNumber(meanDelta),
          direction: meanDelta > 0 ? "higher" : meanDelta < 0 ? "lower" : "equal",
        },
      };
    }),
  };
}

function completeNumericPopulation(rows, targetField, fields) {
  const labels = [targetField, ...fields];
  const cellReasons = Object.fromEntries(labels.map((field) => [field, {
    missing: 0,
    null: 0,
    blank: 0,
    nonNumeric: 0,
  }]));
  const eligible = [];
  const excluded = [];
  for (const item of rows) {
    const cells = Object.fromEntries(labels.map((field) => [field, profileCell(item.row, field)]));
    const invalid = labels.filter((field) => !cells[field].numeric);
    if (invalid.length === 0) {
      eligible.push({
        item,
        target: cells[targetField].numeric.value,
        fields: Object.fromEntries(fields.map((field) => [field, cells[field].numeric.value])),
      });
      continue;
    }
    for (const field of invalid) {
      const kind = cells[field].kind === "non_numeric" ? "nonNumeric" : cells[field].kind;
      cellReasons[field][kind] += 1;
    }
    excluded.push(item);
  }
  return {
    eligible,
    exclusions: {
      count: excluded.length,
      cellReasons,
      sourcePointers: excluded.slice(0, MAX_EXCLUSION_POINTERS).map((item) => `/${item.index}`),
      pointersTruncated: excluded.length > MAX_EXCLUSION_POINTERS,
    },
  };
}

function jointQuantileAxis(population, field, requestedBinCount) {
  const ordered = [...population].sort((left, right) =>
    left.fields[field] === right.fields[field]
      ? left.item.index - right.item.index
      : left.fields[field] - right.fields[field]
  );
  const desiredBinCount = Math.min(requestedBinCount, ordered.length);
  const maxValue = ordered.at(-1)?.fields[field];
  const cutPoints = [];
  for (let index = 1; index < desiredBinCount; index += 1) {
    const rank = Math.ceil((index * ordered.length) / desiredBinCount) - 1;
    const value = ordered[rank]?.fields[field];
    if (
      Number.isFinite(value) &&
      value < maxValue &&
      (cutPoints.length === 0 || cutPoints.at(-1) !== value)
    ) {
      cutPoints.push(value);
    }
  }
  const grouped = Array.from({ length: cutPoints.length + (ordered.length ? 1 : 0) }, () => []);
  for (const row of ordered) {
    const found = cutPoints.findIndex((cutPoint) => row.fields[field] <= cutPoint);
    grouped[found === -1 ? cutPoints.length : found].push(row.item);
  }
  return {
    cutPoints,
    view: {
      actualBinCount: grouped.length,
      cutPoints: cutPoints.map(roundNumber),
      bins: grouped.map((binRows, index) => ({
        ordinal: index + 1,
        label: `Q${index + 1}`,
        lowerExclusive: index === 0 ? null : roundNumber(cutPoints[index - 1]),
        upperInclusive: index < cutPoints.length ? roundNumber(cutPoints[index]) : null,
        rowCount: binRows.length,
        fieldStats: statsWithReportDisplay(fieldStats(binRows, field)),
      })),
    },
  };
}

function jointQuantileView(
  rows,
  sourceRowCount,
  whereApplied,
  targetField,
  fields,
  requestedBinCount,
  direction
) {
  const population = completeNumericPopulation(rows, targetField, fields);
  const axes = Object.fromEntries(
    fields.map((field) => [field, jointQuantileAxis(population.eligible, field, requestedBinCount)])
  );
  const groups = new Map();
  for (const row of population.eligible) {
    const ordinals = fields.map((field) => {
      const found = axes[field].cutPoints.findIndex((cutPoint) => row.fields[field] <= cutPoint);
      return found === -1 ? axes[field].cutPoints.length + 1 : found + 1;
    });
    const key = ordinals.join(":");
    if (!groups.has(key)) groups.set(key, { ordinals, rows: [] });
    groups.get(key).rows.push(row.item);
  }
  const overallTargetStats = statsWithReportDisplay(
    fieldStats(population.eligible.map((row) => row.item), targetField)
  );
  const overallMean = overallTargetStats?.mean;
  const rankedCells = [...groups.values()].map((group) => {
    const targetStats = statsWithReportDisplay(fieldStats(group.rows, targetField));
    const mean = targetStats?.mean;
    const meanDelta = Number.isFinite(mean) && Number.isFinite(overallMean)
      ? roundNumber(mean - overallMean)
      : null;
    return {
      cellId: group.ordinals.map((ordinal) => `Q${ordinal}`).join("×"),
      coordinates: Object.fromEntries(fields.map((field, index) => {
        const ordinal = group.ordinals[index];
        const bin = axes[field].view.bins[ordinal - 1];
        return [field, {
          ordinal,
          label: `Q${ordinal}`,
          min: bin?.fieldStats?.min ?? null,
          max: bin?.fieldStats?.max ?? null,
        }];
      })),
      rowCount: group.rows.length,
      support: {
        status: group.rows.length >= MIN_JOINT_CELL_SUPPORT ? "sufficient" : "low",
        minimumRowCount: MIN_JOINT_CELL_SUPPORT,
      },
      sourcePointers: group.rows.slice(0, MAX_BIN_POINTERS).map((item) => `/${item.index}`),
      pointersTruncated: group.rows.length > MAX_BIN_POINTERS,
      targetStats,
      ...(Number.isFinite(meanDelta) ? {
        comparisonToOverall: {
          overallMean,
          overallMeanDisplay: reportDisplayNumber(overallMean),
          meanDelta,
          meanDeltaDisplay: reportDisplayNumber(meanDelta),
          direction: meanDelta > 0 ? "higher" : meanDelta < 0 ? "lower" : "equal",
        },
      } : {}),
    };
  }).sort((left, right) => {
    const leftMean = left.targetStats?.mean;
    const rightMean = right.targetStats?.mean;
    if (Number.isFinite(leftMean) || Number.isFinite(rightMean)) {
      if (!Number.isFinite(leftMean)) return 1;
      if (!Number.isFinite(rightMean)) return -1;
      if (leftMean !== rightMean) return direction === "asc" ? leftMean - rightMean : rightMean - leftMean;
    }
    if (left.rowCount !== right.rowCount) return right.rowCount - left.rowCount;
    return canonicalizeJson(left.coordinates).localeCompare(canonicalizeJson(right.coordinates));
  }).map((cell, index) => ({ rank: index + 1, ...cell }));
  const observedCellCount = rankedCells.length;
  const hasComparableObservedCells = observedCellCount >= 2 && rankedCells.every((cell) =>
    Number.isFinite(cell.targetStats?.mean) && Number.isFinite(cell.targetStats?.median)
  );
  const bestBy = (statistic, cells = rankedCells) => {
    if (!hasComparableObservedCells || cells.length === 0) return null;
    const values = cells.map((cell) => cell.targetStats[statistic]);
    const value = direction === "asc" ? Math.min(...values) : Math.max(...values);
    return {
      value,
      valueDisplay: reportDisplayNumber(value),
      cellIds: cells.filter((cell) => cell.targetStats[statistic] === value).map((cell) => cell.cellId),
    };
  };
  const bestObservedByMean = bestBy("mean");
  const bestObservedByMedian = bestBy("median");
  const supportedCells = rankedCells.filter((cell) => cell.rowCount >= MIN_JOINT_CELL_SUPPORT);
  const bestSupportedByMean = bestBy("mean", supportedCells);
  const bestSupportedByMedian = bestBy("median", supportedCells);
  const meanBestIds = bestObservedByMean?.cellIds || [];
  const medianBestIds = bestObservedByMedian?.cellIds || [];
  const supportedMeanBestIds = bestSupportedByMean?.cellIds || [];
  const supportedMedianBestIds = bestSupportedByMedian?.cellIds || [];
  const observedWinnerIds = [...new Set([...meanBestIds, ...medianBestIds])];
  const lowSupportWinnerCellIds = observedWinnerIds.filter((cellId) =>
    rankedCells.find((cell) => cell.cellId === cellId)?.rowCount < MIN_JOINT_CELL_SUPPORT
  );
  const winnerSupportSufficient = hasComparableObservedCells &&
    observedWinnerIds.length > 0 && lowSupportWinnerCellIds.length === 0;
  const observedSameBestCells = hasComparableObservedCells
    ? canonicalizeJson(meanBestIds) === canonicalizeJson(medianBestIds)
    : null;
  const supportedSameBestCells = bestSupportedByMean && bestSupportedByMedian
    ? canonicalizeJson(supportedMeanBestIds) === canonicalizeJson(supportedMedianBestIds)
    : null;
  const evaluationStatus = !hasComparableObservedCells
    ? "insufficient_observed_cells"
    : winnerSupportSufficient
      ? "ok"
      : "insufficient_winner_support";
  const stabilityStatus = !hasComparableObservedCells
    ? "not_assessable"
    : !winnerSupportSufficient
      ? "not_assessable_low_support"
      : observedSameBestCells
        ? "mean_median_agree"
        : "mean_median_disagree";
  // Keep one representative of the observed mean/median winners and of the
  // support-qualified alternatives. This guarantees that a sparse raw winner
  // cannot crowd the usable fallback cells out of the compact packet.
  const priorityCellIds = [];
  for (const ids of [meanBestIds, medianBestIds, supportedMeanBestIds, supportedMedianBestIds]) {
    const representative = ids[0];
    if (representative && !priorityCellIds.includes(representative)) priorityCellIds.push(representative);
  }
  const cellById = new Map(rankedCells.map((cell) => [cell.cellId, cell]));
  const selectedCells = [];
  const selectedIds = new Set();
  for (const cellId of priorityCellIds) {
    const cell = cellById.get(cellId);
    if (!cell || selectedIds.has(cellId) || selectedCells.length >= MAX_RETURNED_JOINT_CELLS) continue;
    selectedCells.push(cell);
    selectedIds.add(cellId);
  }
  for (const cell of rankedCells) {
    if (selectedCells.length >= Math.min(MIN_RETURNED_JOINT_CELLS, rankedCells.length)) break;
    if (selectedIds.has(cell.cellId)) continue;
    selectedCells.push(cell);
    selectedIds.add(cell.cellId);
  }
  selectedCells.sort((left, right) => left.rank - right.rank);
  const compactCells = selectedCells.map((cell) => {
    const display = Object.fromEntries(
      ["mean", "median"].flatMap((key) =>
        Number.isFinite(cell.targetStats?.display?.[key])
          ? [[key, cell.targetStats.display[key]]]
          : []
      )
    );
    return {
      rank: cell.rank,
      cellId: cell.cellId,
      coordinates: cell.coordinates,
      rowCount: cell.rowCount,
      support: cell.support,
      sourcePointers: cell.sourcePointers,
      pointersTruncated: cell.pointersTruncated,
      targetStats: {
        count: cell.targetStats.count,
        numericCount: cell.targetStats.numericCount,
        mean: cell.targetStats.mean,
        median: cell.targetStats.median,
        ...(Object.keys(display).length ? { display } : {}),
      },
      ...(cell.comparisonToOverall ? {
        comparisonToOverall: {
          overallMeanDisplay: cell.comparisonToOverall.overallMeanDisplay,
          meanDeltaDisplay: cell.comparisonToOverall.meanDeltaDisplay,
          direction: cell.comparisonToOverall.direction,
        },
      } : {}),
    };
  });
  const decisionCandidate = (selection, criterion) => {
    const cellIds = Array.isArray(selection?.cellIds) ? selection.cellIds : [];
    const cell = cellIds.length ? cellById.get(cellIds[0]) : null;
    if (!cell) return null;
    return {
      criterion,
      tiedCellCount: cellIds.length,
      cellId: cell.cellId,
      coordinates: cell.coordinates,
      rowCount: cell.rowCount,
      supportStatus: cell.support.status,
      targetStats: {
        meanDisplay: reportDisplayNumber(cell.targetStats?.mean),
        medianDisplay: reportDisplayNumber(cell.targetStats?.median),
      },
    };
  };
  const supportedCandidatesAvailable = Boolean(bestSupportedByMean && bestSupportedByMedian);
  const supportedByMeanCandidate = decisionCandidate(bestSupportedByMean, "mean");
  const supportedByMedianCandidate = decisionCandidate(bestSupportedByMedian, "median");
  const observedByMeanCandidate = decisionCandidate(bestObservedByMean, "mean");
  const observedByMedianCandidate = decisionCandidate(bestObservedByMedian, "median");
  const answerStatus = !hasComparableObservedCells
    ? "insufficient_observed_cells"
    : winnerSupportSufficient
      ? observedSameBestCells
        ? "supported_observed_winner_mean_median_agree"
        : "supported_observed_winners_mean_median_differ"
      : !supportedCandidatesAvailable
        ? "observed_winner_support_insufficient_no_supported_candidate"
        : supportedSameBestCells
          ? "observed_winner_support_insufficient_one_supported_candidate"
          : "observed_winner_support_insufficient_supported_candidates_differ";
  const coordinatePhrase = (candidate) => Object.entries(candidate?.coordinates || {})
    .map(([field, coordinate]) => {
      const min = coordinate?.min;
      const max = coordinate?.max;
      if (min == null && max == null) return `${field}${coordinate?.label || "未标注区间"}`;
      return min === max ? `${field}${min}` : `${field}${min}–${max}`;
    })
    .join("、");
  const candidatePhrase = (candidate) => [
    coordinatePhrase(candidate),
    `（${candidate.rowCount}条记录，${targetField}均值${candidate.targetStats.meanDisplay}`,
    `、中位数${candidate.targetStats.medianDisplay}）`,
  ].join("");
  const recommendedSentences = [];
  if (population.exclusions.count > 0) {
    recommendedSentences.push(
      `本次组合评估使用${population.eligible.length}条完整记录，另有${population.exclusions.count}条未进入计算。`
    );
  }
  if (!hasComparableObservedCells) {
    recommendedSentences.push("当前已观测组合不足以形成可比较的平衡结论。");
  } else if (winnerSupportSufficient) {
    if (observedSameBestCells) {
      recommendedSentences.push(
        `在最低支持记录数为${MIN_JOINT_CELL_SUPPORT}的口径下，均值与中位数均指向${candidatePhrase(observedByMeanCandidate)}，可作为样本内优先观察的支持合格组合。`
      );
    } else {
      recommendedSentences.push(
        `在最低支持记录数为${MIN_JOINT_CELL_SUPPORT}的口径下，按均值可参考${candidatePhrase(observedByMeanCandidate)}；按中位数可参考${candidatePhrase(observedByMedianCandidate)}。两种口径未指向同一组合，当前没有单一支持合格候选。`
      );
    }
  } else {
    if (!supportedCandidatesAvailable) {
      recommendedSentences.push(
        `当前没有达到最低支持记录数${MIN_JOINT_CELL_SUPPORT}的候选，暂不能给出支持合格的平衡区间。`
      );
    } else if (supportedSameBestCells) {
      recommendedSentences.push(
        `在最低支持记录数为${MIN_JOINT_CELL_SUPPORT}的口径下，可优先参考${candidatePhrase(supportedByMeanCandidate)}；均值与中位数指向同一支持合格候选。`
      );
    } else {
      recommendedSentences.push(
        `在最低支持记录数为${MIN_JOINT_CELL_SUPPORT}的口径下，按均值可参考${candidatePhrase(supportedByMeanCandidate)}；按中位数可参考${candidatePhrase(supportedByMedianCandidate)}。两种口径未指向同一组合，当前没有单一支持合格候选。`
      );
    }
    if (observedSameBestCells) {
      recommendedSentences.push(
        `原始观测中目标指标${direction === "asc" ? "较低" : "较高"}的组合为${candidatePhrase(observedByMeanCandidate)}，但其记录数低于${MIN_JOINT_CELL_SUPPORT}，仅作为低支持边界，不作为稳健平衡结论。`
      );
    } else {
      recommendedSentences.push(
        `原始观测按均值指向${candidatePhrase(observedByMeanCandidate)}，按中位数指向${candidatePhrase(observedByMedianCandidate)}；相关组合未全部达到最低支持记录数${MIN_JOINT_CELL_SUPPORT}，仅作为低支持边界。`
      );
    }
  }
  if (supportedCandidatesAvailable && supportedSameBestCells) {
    recommendedSentences.push(
      "经营上，可先把该支持合格组合作为观察区间，并持续核对后续同类记录；低支持组合仅用于跟踪，不直接设为经营基准。"
    );
  } else if (supportedCandidatesAvailable) {
    recommendedSentences.push("经营上，可并行观察两组支持合格候选，暂不设置单一经营基准。");
  } else {
    recommendedSentences.push("经营上，当前证据不足以设置平衡区间，应在支持度满足后再判断。");
  }
  // This is the model-facing decision surface. It denormalizes only the facts
  // needed for the answer so Researcher does not have to join evaluation ids
  // back to grid cells or inspect every returned cell. The fuller structures
  // below remain available for deterministic validation and audit.
  const decisionBrief = {
    answerOrder: ["supportedCandidates", "rawObservedWinners", "stabilityAndLimits"],
    answerStatus,
    recommendedClaim: recommendedSentences.join(""),
    targetField,
    driverFields: fields,
    direction,
    population: {
      eligibleRows: population.eligible.length,
      excludedRows: population.exclusions.count,
    },
    minimumSupportRowCount: MIN_JOINT_CELL_SUPPORT,
    supportedCandidates: {
      status: supportedCandidatesAvailable ? "available" : "unavailable",
      meanMedianSameCell: supportedSameBestCells,
      byMean: supportedByMeanCandidate,
      byMedian: supportedByMedianCandidate,
    },
    rawObservedWinners: {
      supportSufficient: winnerSupportSufficient,
      meanMedianSameCell: observedSameBestCells,
      byMean: observedByMeanCandidate,
      byMedian: observedByMedianCandidate,
    },
    stabilityAndLimits: {
      supportedCandidateMeanMedianSameCell: supportedSameBestCells,
      rawObservedMeanMedianSameCell: observedSameBestCells,
      rawObservedWinnerSupportSufficient: winnerSupportSufficient,
      supportsCausality: false,
      supportsInterpolation: false,
      supportsUnobservedCombinations: false,
      supportsGlobalOptimum: false,
    },
  };
  const zeroCounts = {
    target: population.eligible.filter((row) => row.target === 0).length,
    fields: Object.fromEntries(fields.map((field) => [
      field,
      population.eligible.filter((row) => row.fields[field] === 0).length,
    ])),
  };
  const evaluation = {
    status: evaluationStatus,
    support: {
      status: !hasComparableObservedCells
        ? "not_assessable"
        : winnerSupportSufficient
          ? "sufficient"
          : "insufficient_winner_support",
      minimumCellRowCount: MIN_JOINT_CELL_SUPPORT,
      winnerCells: observedWinnerIds.map((cellId) => {
        const cell = rankedCells.find((candidate) => candidate.cellId === cellId);
        return {
          cellId,
          rowCount: cell?.rowCount ?? 0,
          status: cell?.support?.status || "low",
        };
      }),
    },
    stability: {
      status: stabilityStatus,
      sameBestCells: winnerSupportSufficient ? observedSameBestCells : null,
    },
    bestObservedByMean,
    bestObservedByMedian,
    bestSupportedCandidates: {
      status: bestSupportedByMean && bestSupportedByMedian ? "available" : "unavailable",
      bestByMean: bestSupportedByMean,
      bestByMedian: bestSupportedByMedian,
      sameBestCells: supportedSameBestCells,
    },
  };
  return {
    type: "jointQuantileBins",
    targetField,
    fields,
    direction,
    decisionBrief,
    interpretation: {
      scope: "observed_matched_complete_case_sample",
      selectionCriterion: direction === "asc"
        ? "lowest_observed_cell_target_mean"
        : "highest_observed_cell_target_mean",
      supportsCausality: false,
      supportsSignificance: false,
      supportsInterpolation: false,
      supportsUnobservedCombinations: false,
      supportsGlobalOptimum: false,
    },
    population: {
      sourceRows: sourceRowCount,
      whereApplied,
      matchedRows: rows.length,
      eligibleRows: population.eligible.length,
      excludedRows: population.exclusions.count,
      includedZeroCounts: zeroCounts,
      exclusions: population.exclusions,
    },
    evaluation,
    grid: {
      observedCellCount,
      returnedCellCount: compactCells.length,
      truncated: observedCellCount > compactCells.length,
      cells: compactCells,
    },
  };
}

export function buildSourceFieldMetadata(rows, requiredColumns = []) {
  const availableFields = sortedFields(rows.flatMap((row) => Object.keys(row)));
  const normalizedRequiredColumns = sortedFields(normalizeFields(requiredColumns));
  const coverageFields = sortedFields([...availableFields, ...normalizedRequiredColumns]);
  const fieldProfiles = Object.fromEntries(coverageFields.map((field) => {
    const profile = {
      presentCount: 0,
      missingCount: 0,
      nullCount: 0,
      blankCount: 0,
      numericCount: 0,
      zeroCount: 0,
      nonNumericValueCount: 0,
    };
    for (const row of rows) {
      const cell = profileCell(row, field);
      if (cell.kind === "missing") {
        profile.missingCount += 1;
        continue;
      }
      profile.presentCount += 1;
      if (cell.kind === "null") profile.nullCount += 1;
      if (cell.kind === "blank") profile.blankCount += 1;
      if (cell.kind === "non_numeric") profile.nonNumericValueCount += 1;
      if (cell.kind === "numeric") {
        profile.numericCount += 1;
        if (cell.numeric.value === 0) profile.zeroCount += 1;
      }
    }
    return [field, profile];
  }));
  const incompleteRows = rows.map((row, index) => ({
    index,
    fields: incompleteRequiredFields(row, normalizedRequiredColumns),
  })).filter((item) => item.fields.length > 0);
  return {
    empty: rows.length === 0,
    availableFields,
    fieldCoverage: Object.fromEntries(
      coverageFields.map((field) => [field, {
        presentCount: fieldProfiles[field].presentCount,
        nullCount: fieldProfiles[field].missingCount + fieldProfiles[field].nullCount,
        numericCount: fieldProfiles[field].numericCount,
      }])
    ),
    profile: {
      rowCount: rows.length,
      fieldCount: availableFields.length,
      fields: fieldProfiles,
    },
    dataQuality: {
      requiredColumns: normalizedRequiredColumns,
      completeRequiredRowCount: rows.length - incompleteRows.length,
      incompleteRequiredRowCount: incompleteRows.length,
      incompleteRequiredRows: {
        returnedRows: Math.min(incompleteRows.length, MAX_EVIDENCE_ROWS),
        truncated: incompleteRows.length > MAX_EVIDENCE_ROWS,
        rows: incompleteRows.slice(0, MAX_EVIDENCE_ROWS).map((item) => ({
          sourcePointer: `/${item.index}`,
          fields: Object.fromEntries(item.fields.map(({ field, kind }) => [field, kind])),
        })),
      },
    },
  };
}

/**
 * The Editor inventory is intentionally smaller than the Researcher packet:
 * it exposes only field-level counts and one all-fields completeness count.
 * Row values and row pointers stay local to this deterministic script.
 */
function buildInventoryDataQuality(rows, availableFields, profile) {
  let incompleteRequiredRowCount = 0;
  for (const row of rows) {
    const incomplete = availableFields.some((field) =>
      ["missing", "null", "blank"].includes(profileCell(row, field).kind)
    );
    if (incomplete) incompleteRequiredRowCount += 1;
  }
  const incompleteByField = Object.fromEntries(
    availableFields.flatMap((field) => {
      const fieldProfile = profile.fields[field];
      const counts = {
        missingCount: fieldProfile.missingCount,
        nullCount: fieldProfile.nullCount,
        blankCount: fieldProfile.blankCount,
      };
      return Object.values(counts).some((count) => count > 0) ? [[field, counts]] : [];
    })
  );
  return {
    completenessBasis: "all_available_fields",
    completeRequiredRowCount: rows.length - incompleteRequiredRowCount,
    incompleteRequiredRowCount,
    incompleteByField,
  };
}

export function executeEvidenceOperations(sourceRows, operations) {
  if (!Array.isArray(sourceRows) || sourceRows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("evidence source must be an array of row objects");
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("evidencePlan.operations must be a non-empty array");
  }
  validateEvidenceFieldReferences(sourceRows, { operations });
  const indexed = sourceRows.map((row, index) => ({ row, index }));
  const views = Object.create(null);
  for (const [operationIndex, operation] of operations.entries()) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw new Error(`operation ${operationIndex} must be an object`);
    }
    const type = String(operation.type || "");
    const id = String(operation.id || `${type || "operation"}-${operationIndex + 1}`);
    if (!OPERATION_TYPES.has(type)) throw new Error(`unsupported evidence operation ${JSON.stringify(type)}`);
    if (Object.prototype.hasOwnProperty.call(views, id)) {
      throw new Error(`duplicate evidence operation id ${JSON.stringify(id)}`);
    }
    const selected = applyWhere(indexed, operation.where, id);

    if (["project", "sort", "topN", "bottomN"].includes(type)) {
      const sortField = String(operation.field || "");
      let ordered = selected;
      if (type !== "project") {
        if (!sortField) throw new Error(`operation ${id} requires field`);
        const direction = type === "bottomN" ? "asc" : String(operation.direction || "desc").toLowerCase();
        if (!new Set(["asc", "desc"]).has(direction)) throw new Error(`operation ${id} has invalid direction`);
        ordered = sortedRows(selected, sortField, direction, id);
      }
      const count = boundedCount(operation.count ?? operation.limit, 10);
      const fields = normalizeFields(operation.fields, sortField ? [sortField] : Object.keys(sourceRows[0] || {}));
      assertFields(indexed, fields, id);
      views[id] = {
        type,
        matchedRows: selected.length,
        returnedRows: Math.min(count, ordered.length),
        truncated: ordered.length > count,
        rows: evidenceRows(ordered.slice(0, count), fields, {
          includeRank: type !== "project",
        }),
      };
      continue;
    }

    if (["stats", "range"].includes(type)) {
      const fields = normalizeFields(operation.fields);
      if (!fields.length) throw new Error(`operation ${id} requires fields[]`);
      assertFields(indexed, fields, id);
      views[id] = { type, matchedRows: selected.length, stats: statsObject(selected, fields) };
      continue;
    }

    if (type === "subsetStats" || type === "compareTopN" || type === "compare") {
      const sortBy = String(operation.sortBy || operation.field || "");
      if (!sortBy) throw new Error(`operation ${id} requires sortBy`);
      const direction = String(operation.direction || "desc").toLowerCase();
      if (!new Set(["asc", "desc"]).has(direction)) throw new Error(`operation ${id} has invalid direction`);
      const fields = normalizeFields(operation.fields, [sortBy]);
      assertFields(indexed, [sortBy, ...fields], id);
      const count = boundedCount(operation.count, 5);
      const ordered = sortedRows(selected, sortBy, direction, id);
      const subset = ordered.slice(0, count);
      const rest = ordered.slice(count);
      const includesComparison = ["compareTopN", "compare"].includes(type);
      const comparison = includesComparison
        ? comparedStats(subset, rest, fields)
        : { selectedStats: statsObject(subset, fields), remainingStats: null };
      views[id] = {
        type,
        sortBy,
        direction,
        population: {
          sourceRows: indexed.length,
          whereApplied: operation.where != null,
          matchedRows: selected.length,
          selectedCount: subset.length,
          remainingCount: rest.length,
        },
        selectedRows: evidenceRows(subset, [...new Set([sortBy, ...fields])], {
          includeRank: true,
        }),
        selectedStats: comparison.selectedStats,
        ...(includesComparison ? { remainingStats: comparison.remainingStats } : {}),
      };
      continue;
    }

    if (type === "correlation") {
      const targetField = requireField(operation.targetField, id, "targetField");
      const fields = requireAnalysisFields(operation.fields, id);
      if (fields.includes(targetField)) {
        throw new Error(`operation ${id} fields[] must not contain targetField`);
      }
      assertFields(indexed, [targetField, ...fields], id);
      views[id] = {
        type,
        targetField,
        method: "pearson_pairwise_complete",
        interpretation: {
          scope: "observed_matched_sample",
          supportsCausality: false,
          supportsSignificance: false,
        },
        population: {
          sourceRows: indexed.length,
          whereApplied: operation.where != null,
          matchedRows: selected.length,
        },
        correlations: Object.fromEntries(fields.map((field) => {
          const pairwise = pairwiseNumericPopulation(selected, targetField, field);
          const eligibleRows = pairwise.eligible.map((item) => item.item);
          return [field, {
            eligibleRows: eligibleRows.length,
            exclusions: pairwise.exclusions,
            ...pearsonCorrelation(pairwise.eligible),
            zeroValueSensitivity: zeroValueSensitivity(pairwise.eligible),
            fieldStats: fieldStats(eligibleRows, field),
            targetStats: fieldStats(eligibleRows, targetField),
          }];
        })),
      };
      continue;
    }

    if (type === "quantileBins") {
      const targetField = requireField(operation.targetField, id, "targetField");
      const fields = requireAnalysisFields(operation.fields, id);
      if (fields.includes(targetField)) {
        throw new Error(`operation ${id} fields[] must not contain targetField`);
      }
      const binCount = quantileBinCount(operation.binCount, id);
      assertFields(indexed, [targetField, ...fields], id);
      views[id] = {
        type,
        targetField,
        method: "equal_frequency_nearest_rank_ties_together",
        requestedBinCount: binCount,
        population: {
          sourceRows: indexed.length,
          whereApplied: operation.where != null,
          matchedRows: selected.length,
        },
        grids: Object.fromEntries(
          fields.map((field) => [field, quantileGrid(selected, targetField, field, binCount)])
        ),
      };
      continue;
    }

    if (type === "jointQuantileBins") {
      const targetField = requireField(operation.targetField, id, "targetField");
      const fields = requireAnalysisFields(operation.fields, id);
      if (fields.length !== 2) {
        throw new Error(`operation ${id} jointQuantileBins requires exactly two driver fields`);
      }
      if (fields.includes(targetField)) {
        throw new Error(`operation ${id} fields[] must not contain targetField`);
      }
      const binCount = quantileBinCount(operation.binCount, id);
      if (binCount > MAX_JOINT_BIN_COUNT) {
        throw new Error(`operation ${id} jointQuantileBins binCount must be at most ${MAX_JOINT_BIN_COUNT}`);
      }
      const direction = String(operation.direction || "").toLowerCase();
      if (!new Set(["asc", "desc"]).has(direction)) {
        throw new Error(`operation ${id} jointQuantileBins requires direction asc or desc`);
      }
      assertFields(indexed, [targetField, ...fields], id);
      views[id] = jointQuantileView(
        selected,
        indexed.length,
        operation.where != null,
        targetField,
        fields,
        binCount,
        direction
      );
      continue;
    }

    if (type === "groupBy") {
      const groupField = String(operation.groupField || operation.field || "");
      const fields = normalizeFields(operation.fields);
      if (!groupField || !fields.length) throw new Error(`operation ${id} requires groupField and fields[]`);
      assertFields(indexed, [groupField, ...fields], id);
      const groups = new Map();
      for (const item of selected) {
        const key = canonicalizeJson(item.row[groupField]);
        if (!groups.has(key)) groups.set(key, { value: item.row[groupField], rows: [] });
        groups.get(key).rows.push(item);
      }
      const maxGroups = Math.min(boundedCount(operation.maxGroups, MAX_GROUPS), MAX_GROUPS);
      const orderedGroups = [...groups.values()].sort((a, b) => compareCells(a.value, b.value));
      views[id] = {
        type,
        groupField,
        groupCount: orderedGroups.length,
        truncated: orderedGroups.length > maxGroups,
        groups: orderedGroups.slice(0, maxGroups).map((group) => ({
          value: group.value,
          rowCount: group.rows.length,
          stats: statsObject(group.rows, fields),
        })),
      };
    }
  }
  return views;
}

async function readTask(taskPath, taskId, sessionDir) {
  const document = (await readJsonWithin(
    sessionDir,
    join(sessionDir, "analysis"),
    taskPath,
    "analysis/tasks.json"
  )).value;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`tasks document must be an object: ${taskPath}`);
  }
  if (Number(document.version) !== 2) {
    throw new Error(`tasks document version must be exactly 2: ${taskPath}`);
  }
  if (!Array.isArray(document.tasks)) {
    throw new Error(`tasks document tasks must be an array: ${taskPath}`);
  }
  const tasks = document.tasks;
  const idsBySanitized = new Map();
  for (const candidate of tasks) {
    const safe = sanitizeTaskId(candidate?.id);
    if (idsBySanitized.has(safe)) {
      throw new Error(`task ids collide after sanitization: ${idsBySanitized.get(safe)} and ${candidate?.id}`);
    }
    idsBySanitized.set(safe, String(candidate?.id));
  }
  const task = tasks.find(
    (candidate) => String(candidate?.id) === String(taskId)
  );
  if (!task) throw new Error(`task ${JSON.stringify(taskId)} not found in ${taskPath}`);
  return task;
}

function validateWriterSource(rows, meta, cardId) {
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error(`Writer entry for card ${cardId} must be an array of row objects`);
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(`Writer metadata for card ${cardId} must be an object`);
  }
  const metaKeys = Object.keys(meta).sort();
  if (metaKeys.length !== 2 || metaKeys[0] !== "rowCount" || metaKeys[1] !== "rowsSha256") {
    throw new Error(`Writer metadata for card ${cardId} must contain only rowCount and rowsSha256`);
  }
  const computedRowsSha256 = rowsSha256(rows);
  if (meta.rowCount !== rows.length) throw new Error(`Writer rowCount mismatch for card ${cardId}`);
  if (meta.rowsSha256 !== computedRowsSha256) {
    throw new Error(`Writer rowsSha256 mismatch for card ${cardId}`);
  }
  return computedRowsSha256;
}

/**
 * Return only a deterministic field inventory for all confirmed Writer cards.
 * This is the B2.5 model-facing bridge: it reads/validates entry locally but
 * does not expose rows and does not add anything to the CLI metadata contract.
 */
export async function prepareSourceFieldInventory(resultPath) {
  const absResult = resolve(resultPath);
  const sessionDir = dirname(absResult);
  const resultFile = await readJsonWithin(
    sessionDir,
    sessionDir,
    absResult,
    "result.json"
  );
  const confirmedResult = resultFile.value;
  if (confirmedResult.status !== "confirmed") {
    throw new Error(`result.status must be confirmed, got ${JSON.stringify(confirmedResult.status)}`);
  }
  // B2.5 writes tasks.json/main.md immediately after this inventory. Prepare
  // their fixed parent directory here so the Editor never needs a separate
  // mkdir shell turn.
  await mkdir(join(sessionDir, "analysis"), { recursive: true });
  const cards = Array.isArray(confirmedResult.cards) ? confirmedResult.cards : [];
  const cardsRoot = join(sessionDir, "data", "cards");
  const sanitizedIds = new Map();
  const sources = [];
  for (const card of cards) {
    const rawCardId = String(card?.id || "");
    if (!rawCardId) throw new Error("result card is missing id");
    const cardId = sanitizeCardId(rawCardId);
    if (sanitizedIds.has(cardId)) {
      throw new Error(`result card ids collide after sanitization: ${sanitizedIds.get(cardId)} and ${rawCardId}`);
    }
    sanitizedIds.set(cardId, rawCardId);
    const cardDir = join(cardsRoot, cardId);
    const dataPath = join(cardDir, "entry.json");
    const metaPath = join(cardDir, "entry.meta.json");
    const [data, meta] = await Promise.all([
      readJsonWithin(sessionDir, cardsRoot, dataPath, `Writer entry for card ${rawCardId}`, { optional: true }),
      readJsonWithin(sessionDir, cardsRoot, metaPath, `Writer metadata for card ${rawCardId}`, { optional: true }),
    ]);
    if (!data.present && !meta.present) {
      sources.push({
        cardId: rawCardId,
        status: "unavailable",
        reason: "writer_data_unavailable",
        availableFields: [],
        profile: null,
        dataQuality: null,
      });
      continue;
    }
    if (!data.present || !meta.present) {
      throw new Error(`Writer card ${rawCardId} must contain both entry.json and entry.meta.json`);
    }
    if (data.mtimeMs < resultFile.mtimeMs || meta.mtimeMs < resultFile.mtimeMs) {
      throw new Error(`Writer artifacts for card ${rawCardId} are older than the current result.json`);
    }
    const computedRowsSha256 = validateWriterSource(data.value, meta.value, rawCardId);
    const fieldMetadata = buildSourceFieldMetadata(data.value);
    const inventoryDataQuality = buildInventoryDataQuality(
      data.value,
      fieldMetadata.availableFields,
      fieldMetadata.profile
    );
    sources.push({
      cardId: rawCardId,
      status: "available",
      rowCount: data.value.length,
      rowsSha256: computedRowsSha256,
      empty: fieldMetadata.empty,
      fieldInventoryStatus: fieldMetadata.empty ? "unverifiable_empty_source" : "validated",
      availableFields: fieldMetadata.availableFields,
      profile: fieldMetadata.profile,
      dataQuality: inventoryDataQuality,
    });
  }
  return {
    version: 1,
    producer: "prepare-research-evidence.mjs",
    mode: "source_fields",
    sources,
  };
}

/**
 * B2.5 can deterministically prepare every pending reuse_entry packet after it
 * has written tasks.json. This keeps full Writer rows out of the model and
 * lets the internally-started B3 dispatch Researcher without another evidence
 * preparation round trip. new_query tasks are intentionally deferred.
 */
export async function preparePendingReuseEvidence(resultPath) {
  const absResult = resolve(resultPath);
  const sessionDir = dirname(absResult);
  const taskPath = join(sessionDir, "analysis", "tasks.json");
  const taskFile = await readJsonWithin(sessionDir, sessionDir, taskPath, "analysis/tasks.json");
  const document = taskFile.value;
  if (Number(document?.version) !== 2 || !Array.isArray(document?.tasks)) {
    throw new Error("analysis/tasks.json must be a version 2 document with tasks[]");
  }
  const prepared = [];
  const deferred = [];
  for (const task of document.tasks) {
    if (String(task?.status || "") !== "pending") continue;
    const mode = String(task?.evidencePlan?.mode || "");
    if (mode === "new_query") {
      deferred.push({ taskId: String(task.id), evidenceMode: mode, reason: "new_query_runs_in_researcher" });
      continue;
    }
    if (mode !== "reuse_entry") {
      throw new Error(`pending task ${String(task?.id || "<missing>")} has invalid evidence mode ${JSON.stringify(mode)}`);
    }
    const output = await prepareResearchEvidence(absResult, { taskId: String(task.id) });
    prepared.push({
      taskId: output.taskId,
      evidenceMode: output.evidenceMode,
      evidencePath: output.evidencePath,
      rowCount: output.source.rowCount,
      rowsSha256: output.source.rowsSha256,
      viewIds: Object.keys(output.views),
    });
  }
  return {
    version: 1,
    producer: "prepare-research-evidence.mjs",
    mode: "pending_reuse",
    prepared,
    deferred,
  };
}

export async function prepareResearchEvidence(resultPath, options) {
  const absResult = resolve(resultPath);
  const sessionDir = dirname(absResult);
  const resultFile = await readJsonWithin(
    sessionDir,
    sessionDir,
    absResult,
    "result.json"
  );
  const confirmedResult = resultFile.value;
  if (confirmedResult.status !== "confirmed") {
    throw new Error(`result.status must be confirmed, got ${JSON.stringify(confirmedResult.status)}`);
  }
  const taskPath = join(sessionDir, "analysis", "tasks.json");
  if (options.taskPath && resolve(options.taskPath) !== taskPath) {
    throw new Error(`task file is fixed to ${taskPath}`);
  }
  const task = await readTask(taskPath, options.taskId, sessionDir);
  const plan = task.evidencePlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error(`task ${task.id} missing evidencePlan`);
  }
  const mode = String(plan.mode || "");
  if (options.mode && String(options.mode) !== mode) {
    throw new Error(`mode override is forbidden; task evidencePlan.mode is ${mode}`);
  }
  if (!MODES.has(mode)) throw new Error(`task ${task.id} evidence mode must be reuse_entry or new_query`);
  if (mode === "reuse_entry" && task.evidenceGap != null) {
    throw new Error(`task ${task.id} reuse_entry evidenceGap must be null`);
  }
  if (mode === "new_query" && !isValidEvidenceGap(task.evidenceGap)) {
    throw new Error(`task ${task.id} new_query requires allowed evidenceGap.type or evidenceGap.types[] + evidenceGap.reason`);
  }
  const taskId = sanitizeTaskId(task.id);
  const rawSourceCardId = String(task.fromCardId || "");
  if (!String(task.goal || "").trim()) {
    throw new Error(`task ${task.id} goal is required`);
  }
  if (!rawSourceCardId) {
    throw new Error(`task ${task.id} fromCardId is required`);
  }
  if (plan.sourceCardId != null && String(plan.sourceCardId) !== rawSourceCardId) {
    throw new Error(`task ${task.id} evidencePlan.sourceCardId must equal task.fromCardId`);
  }
  const sourceCard = (Array.isArray(confirmedResult.cards) ? confirmedResult.cards : []).find(
    (card) => String(card?.id) === rawSourceCardId
  );
  if (
    !rawSourceCardId ||
    !sourceCard
  ) {
    throw new Error(`task ${task.id} source card ${JSON.stringify(rawSourceCardId)} is not in result.json`);
  }
  let sourceQuery;
  try {
    sourceQuery = metricQueryFromCard(sourceCard);
  } catch (error) {
    throw new Error(`task ${task.id} source card ${rawSourceCardId} has invalid canonical query: ${error.message || error}`);
  }

  let dataPath;
  let metaPath;
  let sourceKind;
  let sourceRoot;
  if (mode === "reuse_entry") {
    const cardId = sanitizeCardId(rawSourceCardId);
    if (!cardId || cardId === "unknown") throw new Error(`task ${task.id} reuse_entry requires fromCardId`);
    sourceRoot = join(sessionDir, "data", "cards");
    dataPath = join(sourceRoot, cardId, "entry.json");
    metaPath = join(sourceRoot, cardId, "entry.meta.json");
    sourceKind = "writer_entry";
  } else {
    sourceRoot = join(sessionDir, "data", "explore");
    dataPath = join(sourceRoot, `${taskId}.json`);
    metaPath = join(sourceRoot, `${taskId}.meta.json`);
    sourceKind = "explore_query";
  }
  const dataFile = await readJsonWithin(sessionDir, sourceRoot, dataPath, "source data");
  const metaFile = await readJsonWithin(sessionDir, sourceRoot, metaPath, "source metadata");
  const columnMetaPath = columnMetaPathFor(dataPath);
  const columnMetaFile = await readJsonWithin(
    sessionDir, sourceRoot, columnMetaPath, "source column metadata", { optional: true }
  );
  if (dataFile.mtimeMs < resultFile.mtimeMs || metaFile.mtimeMs < resultFile.mtimeMs) {
    throw new Error(`source artifacts for task ${task.id} are older than the current result.json`);
  }
  const data = dataFile.value;
  const meta = metaFile.value;
  const rows = extractRows(data);
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error(`source data for task ${task.id} must contain row objects`);
  }
  const computedRowsSha256 = rowsSha256(rows);
  let queryCoverage;
  if (mode === "reuse_entry") {
    validateWriterSource(rows, meta, `task ${task.id}`);
    queryCoverage = semanticQueryShape(sourceQuery);
  } else {
    if (meta.producer !== "fetch-explore.mjs" || meta.status !== "ok") {
      throw new Error(`new_query source for task ${task.id} must be a successful fetch-explore artifact`);
    }
    if (
      meta.queryDelta?.material !== true ||
      !Array.isArray(meta.queryDelta.changedKeys) ||
      meta.queryDelta.changedKeys.length === 0
    ) {
      throw new Error(`new_query source for task ${task.id} must declare a material query delta`);
    }
    if (!evidenceGapMatchesChangedKeys(task.evidenceGap, meta.queryDelta.changedKeys)) {
      throw new Error(`new_query source for task ${task.id} does not address the contracted evidenceGap types`);
    }
    if (meta.rowCount !== rows.length) throw new Error(`explore rowCount mismatch for task ${task.id}`);
    if (meta.rowsSha256 !== computedRowsSha256) throw new Error(`explore rowsSha256 mismatch for task ${task.id}`);
    if (!meta.queryPatch || typeof meta.queryPatch !== "object" || Array.isArray(meta.queryPatch)) {
      throw new Error(`new_query source for task ${task.id} must include queryPatch`);
    }
    if (meta.queryPatchSha256 !== sha256Json(meta.queryPatch)) {
      throw new Error(`new_query source for task ${task.id} queryPatch hash mismatch`);
    }
    // Reconstruct the candidate query shape from source + minimal patch
    // instead of trusting a persisted full query copy.  The source query is
    // recomputed from the single card.query; the patch carries only the
    // authorized changed fields with their new values.
    const candidateQuery = applyQueryPatch(sourceQuery, meta.queryPatch);
    queryCoverage = semanticQueryShape(candidateQuery);
  }

  if (options.operations && canonicalizeJson(options.operations) !== canonicalizeJson(plan.operations)) {
    throw new Error("operations override is forbidden; update evidencePlan.operations in tasks.json");
  }
  const operations = plan.operations;
  const requiredColumns = normalizeFields(plan.requiredColumns);
  validateEvidenceFieldReferences(rows, { requiredColumns, operations });
  const sourceFieldMetadata = buildSourceFieldMetadata(rows, requiredColumns);
  const views = executeEvidenceOperations(rows, operations);
  const decisionQueryScope = compactDecisionQueryScope(queryCoverage);
  if (decisionQueryScope) {
    for (const view of Object.values(views)) {
      if (view?.decisionBrief && typeof view.decisionBrief === "object") {
        view.decisionBrief.queryScope = decisionQueryScope;
      }
    }
  }
  const colMetaValue = columnMetaFile?.value;
  const columnLabels = (colMetaValue && typeof colMetaValue === "object" && !Array.isArray(colMetaValue))
    ? colMetaValue
    : {};
  const packet = {
    version: 1,
    producer: "prepare-research-evidence.mjs",
    taskId: String(task.id),
    evidenceMode: mode,
    columnLabels,
    source: {
      kind: sourceKind,
      dataPath,
      metaPath,
      rowCount: rows.length,
      ...sourceFieldMetadata,
      fieldMetadataSha256: sha256Json(sourceFieldMetadata),
      rowsSha256: computedRowsSha256,
      declaredRowsSha256: meta.rowsSha256 || null,
      queryCoverage,
      queryCoverageSha256: sha256Json(queryCoverage),
    },
    operationPlanSha256: sha256Json(operations),
    requiredColumns,
    viewsSha256: sha256Json(views),
    views,
  };
  const evidencePath = join(sessionDir, "analysis", "evidence", `${taskId}.json`);
  await mkdir(dirname(evidencePath), { recursive: true });
  // This file is read directly into the Researcher context. Persist compact
  // JSON to avoid spending model time and tokens on indentation while keeping
  // the parsed packet and every provenance hash unchanged.
  await writeFile(evidencePath, `${JSON.stringify(packet)}\n`);
  return { ...packet, evidencePath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultPath = value("--result");
  const taskId = value("--task-id");
  const sourceFields = has("--source-fields");
  const pendingReuse = has("--pending-reuse");
  const modeCount = Number(sourceFields) + Number(Boolean(taskId)) + Number(pendingReuse);
  if (!resultPath || modeCount !== 1) {
    process.stderr.write(
      "usage: prepare-research-evidence.mjs --result <result.json> (--source-fields | --pending-reuse | --task-id <id>)\n"
    );
    process.exit(2);
  }
  try {
    if (sourceFields) {
      const inventory = await prepareSourceFieldInventory(resultPath);
      persistEditorSourceInventory(resultPath, inventory);
      process.stdout.write(`${JSON.stringify({ ok: true, ...inventory }, null, 2)}\n`);
    } else if (pendingReuse) {
      const output = await preparePendingReuseEvidence(resultPath);
      process.stdout.write(`${JSON.stringify({ ok: true, ...output }, null, 2)}\n`);
    } else {
      const output = await prepareResearchEvidence(resultPath, {
        taskId,
      });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        taskId: output.taskId,
        evidenceMode: output.evidenceMode,
        evidencePath: output.evidencePath,
        rowCount: output.source.rowCount,
        rowsSha256: output.source.rowsSha256,
        viewIds: Object.keys(output.views),
      }, null, 2)}\n`);
    }
  } catch (error) {
    if (error?.code === "EVIDENCE_FIELD_MISMATCH") {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        code: error.code,
        taskId,
        ...error.details,
      }, null, 2)}\n`);
    } else {
      process.stderr.write(`${error.message || error}\n`);
    }
    process.exit(1);
  }
}
