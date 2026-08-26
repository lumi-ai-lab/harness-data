/**
 * Build the compact topN/bottomN packet for one Writer card caption.
 *
 * Reads the persisted entry rows and card.query. Never invents totals:
 * coarser prefixes keep the existing row with the best/worst cell.
 *
 * Usage:
 *   node prepare-card-caption-evidence.mjs --result <result.json> --card-id <id>
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRows } from "../artifacts/assemble-report.mjs";
import {
  buildCaptionAxis,
  captionPrefixes,
  captionViewId,
  resolveDimensionColumn,
} from "./caption-dims.mjs";
import { metricQueryFromCard } from "../query/metric-query-contract.mjs";
import { buildColumnLabels } from "../data/fetch-entry.mjs";
import { sanitizeCardId, writerReturnPaths } from "../session/writer-return.mjs";
import { roundHalfUpUnsigned } from "../captions/submit-card-caption.mjs";

export const CAPTION_EVIDENCE_PRODUCER = "prepare-card-caption-evidence.mjs";
export const CAPTION_N = 3;
export const CAPTION_COMPARISON_SUFFIXES = Object.freeze(["同比增长率", "环比增长率"]);

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function captionNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * 四舍五入到 2 位小数，减少 LLM 转录高精度数字时的末位错误。
 * 用 roundHalfUpUnsigned（digit 字符串半入）而非 Number.toFixed，
 * 避免 IEEE-754 浮点导致的 26494489.185→26494489.18 问题。
 * 只对 |value| ≥ 1 的数取整（指标值如 4464.3966 → 4464.40）；
 * |value| < 1 的小数（率字段如 -0.0082）保持原样，避免丢失精度。
 */
function roundCaptionValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  if (Math.abs(value) < 1) return value;
  const unsigned = String(Math.abs(value));
  const rounded = roundHalfUpUnsigned(unsigned, 2);
  if (rounded == null) return value;
  return value < 0 ? -Number(rounded) : Number(rounded);
}

/** 对 rowSlice 里的数值字段统一取整（维度字符串不受影响）。 */
function roundRowSlice(sliced) {
  for (const [key, val] of Object.entries(sliced)) {
    if (typeof val === "number" && Number.isFinite(val)) {
      sliced[key] = roundCaptionValue(val);
    }
  }
  return sliced;
}

function comparisonField(metric, suffix) {
  return `${metric}${suffix}`;
}

/** AUTO / measures output keys look like saleAmt__SUMMARY or saleAmt__SUMMARY__2. */
function isPolicyColumnKey(key) {
  return /__[A-Z][A-Z0-9_]*(?:__\d+)?$/.test(String(key || ""));
}

export function captionValueFields(query, columnLabels = {}) {
  const fromLabels = Object.keys(columnLabels || {}).filter(isPolicyColumnKey);
  if (fromLabels.length) return fromLabels;
  const measures = Array.isArray(query?.measures) ? query.measures : [];
  if (measures.length) {
    return measures
      .map((item) => `${String(item?.metric || "").trim()}__${String(item?.statisticPolicy || "").trim()}`)
      .filter((key) => !key.startsWith("__") && !key.endsWith("__"));
  }
  return (Array.isArray(query?.metrics) ? query.metrics : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function rowSlice(row, metric, axis, columnLabels) {
  const sliced = {};
  for (const dim of axis) {
    const col = resolveDimensionColumn(dim, row);
    if (Object.prototype.hasOwnProperty.call(row, col)) {
      const label = columnLabels?.[dim] || col;
      sliced[label] = row[col];
    }
  }
  if (Object.prototype.hasOwnProperty.call(row, metric)) {
    const label = columnLabels?.[metric] || metric;
    sliced[label] = row[metric];
  }
  for (const suffix of CAPTION_COMPARISON_SUFFIXES) {
    const field = comparisonField(metric, suffix);
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      const label = columnLabels?.[field] || field;
      sliced[label] = row[field];
    }
  }
  return sliced;
}

function prefixKey(row, prefix) {
  return JSON.stringify(prefix.map((dim) => {
    const col = resolveDimensionColumn(dim, row);
    return Object.prototype.hasOwnProperty.call(row, col) ? row[col] : null;
  }));
}

function prefixObject(row, prefix, columnLabels) {
  return Object.fromEntries(prefix.map((dim) => {
    const col = resolveDimensionColumn(dim, row);
    const label = columnLabels?.[dim] || dim;
    return [label, Object.prototype.hasOwnProperty.call(row, col) ? row[col] : null];
  }));
}

function pickGroupRow(current, candidate, direction) {
  if (!current) return candidate;
  if (candidate.metricValue === current.metricValue) {
    return candidate.index < current.index ? candidate : current;
  }
  if (direction === "desc") return candidate.metricValue > current.metricValue ? candidate : current;
  return candidate.metricValue < current.metricValue ? candidate : current;
}

function rankMetric(rows, metric, prefix, direction) {
  const groups = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const metricValue = captionNumber(row[metric]);
    if (metricValue == null) continue;
    const key = prefixKey(row, prefix);
    const candidate = { index, row, metricValue };
    groups.set(key, pickGroupRow(groups.get(key), candidate, direction));
  }
  const ranked = [...groups.values()].sort((left, right) => {
    if (left.metricValue !== right.metricValue) {
      return direction === "desc" ? right.metricValue - left.metricValue : left.metricValue - right.metricValue;
    }
    return left.index - right.index;
  });
  return ranked.slice(0, CAPTION_N);
}

function viewRows(ranked, metric, prefix, axis, columnLabels) {
  return ranked.map((item, rank) => ({
    rank: rank + 1,
    key: prefixObject(item.row, prefix, columnLabels),
    metricValue: roundCaptionValue(item.metricValue),
    row: roundRowSlice(rowSlice(item.row, metric, axis, columnLabels)),
  }));
}

export function buildCaptionEvidence({ cardId, query, rows, columnLabels = {} }) {
  const metrics = Array.isArray(query?.metrics) ? query.metrics.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const valueFields = captionValueFields(query, columnLabels);
  const { axis, droppedDimensions, groups } = buildCaptionAxis(query?.dimensions);
  const sourceRows = Array.isArray(rows) ? rows : [];
  const views = {};
  for (const metric of valueFields) {
    for (const prefix of captionPrefixes(axis)) {
      const top = rankMetric(sourceRows, metric, prefix, "desc");
      const bottom = rankMetric(sourceRows, metric, prefix, "asc");
      if (top.length) {
        const id = captionViewId("topN", metric, prefix);
        views[id] = {
          type: "topN",
          metric,
          metricLabel: columnLabels[metric] || metric,
          dimensions: prefix,
          dimensionLabels: prefix.map((d) => columnLabels[d] || d),
          n: CAPTION_N,
          rows: viewRows(top, metric, prefix, axis, columnLabels),
        };
      }
      if (bottom.length) {
        const id = captionViewId("bottomN", metric, prefix);
        views[id] = {
          type: "bottomN",
          metric,
          metricLabel: columnLabels[metric] || metric,
          dimensions: prefix,
          dimensionLabels: prefix.map((d) => columnLabels[d] || d),
          n: CAPTION_N,
          rows: viewRows(bottom, metric, prefix, axis, columnLabels),
        };
      }
    }
  }
  return {
    producer: CAPTION_EVIDENCE_PRODUCER,
    cardId: String(cardId),
    rowCount: sourceRows.length,
    columnLabels,
    query: {
      metrics,
      measures: Array.isArray(query?.measures) ? structuredClone(query.measures) : [],
      statisticPolicy: query?.statisticPolicy || null,
      dimensions: Array.isArray(query?.dimensions) ? [...query.dimensions] : [],
      time: query?.time && typeof query.time === "object" ? { ...query.time } : null,
      comparisons: Array.isArray(query?.comparisons) ? [...query.comparisons] : [],
    },
    axis,
    groups,
    droppedDimensions,
    views,
  };
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw new Error(`cannot read ${label}: ${error.message || error}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message || error}`);
  }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function persistCaptionEvidence(path, evidence) {
  await atomicWrite(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return path;
}

export async function prepareCardCaptionEvidence({ resultPath, cardId, rows } = {}) {
  if (typeof resultPath !== "string" || !isAbsolute(resultPath)) {
    throw new Error("resultPath must be an absolute result.json path");
  }
  if (typeof cardId !== "string" || !cardId.trim()) {
    throw new Error("cardId is required");
  }
  const absResult = resolve(resultPath);
  const sessionDir = dirname(absResult);
  const result = await readJson(absResult, "result.json");
  if (!isPlainObject(result) || result.status !== "confirmed") {
    throw new Error(`result.status must be confirmed, got ${JSON.stringify(result?.status)}`);
  }
  const card = (Array.isArray(result.cards) ? result.cards : []).find((item) => item?.id === cardId);
  if (!card) throw new Error(`result.json has no card ${cardId}`);
  const query = metricQueryFromCard(card);
  const paths = writerReturnPaths({ sessionDir, cardId });
  const sourceRows = Array.isArray(rows) ? rows : extractRows(await readJson(paths.dataPath, "entry.json"));
  let columnLabels = {};
  try {
    columnLabels = await readJson(paths.columnMetaPath, "entry.column-meta.json");
    if (!isPlainObject(columnLabels)) columnLabels = {};
  } catch {
    columnLabels = {};
  }
  const evidence = buildCaptionEvidence({
    cardId: sanitizeCardId(cardId),
    query,
    rows: sourceRows,
    columnLabels,
  });
  await persistCaptionEvidence(paths.evidencePath, evidence);
  return { evidence, evidencePath: paths.evidencePath };
}

export async function runCli() {

  const resultPath = value("--result");
  const cardId = value("--card-id");
  if (!resultPath || !cardId || argv.length > 4) {
    process.stderr.write("usage: prepare-card-caption-evidence.mjs --result <result.json> --card-id <id>\n");
    process.exit(2);
  }
  try {
    const output = await prepareCardCaptionEvidence({ resultPath: resolve(resultPath), cardId });
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: output.evidencePath, viewIds: Object.keys(output.evidence.views) }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
