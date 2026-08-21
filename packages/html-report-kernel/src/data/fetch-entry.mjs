#!/usr/bin/env node
/**
 * FETCH (Phase B2): fetch one confirmed card's full detail through
 * `qdm-metric-cli analysis execute`.
 *
 * qdm-metric-cli owns the row data. This adapter derives rowCount and the
 * RFC 8785/JCS rows hash so the persisted Writer contract stays unchanged:
 *   { rows, rowCount, rowsSha256 }
 *
 * This adapter only persists that contract, without calculating profiles,
 * facts, aggregates, or report sections:
 *
 *   data/cards/<card-id>/entry.json       # rows only
 *   data/cards/<card-id>/entry.meta.json  # rowCount + rowsSha256 only
 *
 * ack_cli_data returns the paths plus rowCount/rowsSha256 to the Report Editor.
 * No fetch ledger is written: the parent already receives each Writer result.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeCardId } from "../session/writer-return.mjs";
import { normalizeMetricQuery, metricQueryFromCard } from "../query/metric-query-contract.mjs";
import { buildMetricExecuteArgs, runMetricQuery, runMetricQueryAsync } from "../../../harness-runtime-node/src/metric-cli-executor.mjs";
import { isMetricTimeout } from "../../../harness-runtime-node/src/metric-timeout.mjs";
import {
  metricFetchBudgetMs,
  isRetryableMetricFailure,
  shouldRetryMetricFailure,
} from "../../../harness-runtime-node/src/metric-retry.mjs";
import { findWorkspaceRoot } from "../../../harness-runtime-node/src/workspace-resolver.mjs";

export { isMetricTimeout } from "../../../harness-runtime-node/src/metric-timeout.mjs";
export {
  metricFetchBudgetMs,
  isRetryableMetricFailure,
  shouldRetryMetricFailure,
} from "../../../harness-runtime-node/src/metric-retry.mjs";
export { buildMetricExecuteArgs as buildExecuteArgs, runMetricQueryAsync } from "../../../harness-runtime-node/src/metric-cli-executor.mjs";
export { captionPathFor } from "../session/writer-return.mjs";

/** Derive the column-meta file path from a data file path. */
export function columnMetaPathFor(dataPath) {
  return String(dataPath || "").replace(/\.json$/, ".column-meta.json");
}

/**
 * Flatten the CLI envelope meta into a code→name map for evidence consumers.
 * Includes metrics, dimensions, and derived (yoy/mom) columns.
 */
export function buildColumnLabels(meta) {
  const labels = {};
  for (const m of (Array.isArray(meta?.metrics) ? meta.metrics : [])) {
    if (m?.code && m?.name) labels[m.code] = m.name;
  }
  for (const d of (Array.isArray(meta?.dimensionMetas) ? meta.dimensionMetas : [])) {
    if (d?.code && d?.name) labels[d.code] = d.name;
  }
  for (const dc of (Array.isArray(meta?.derivedColumns) ? meta.derivedColumns : [])) {
    if (dc?.key && dc?.name) labels[dc.key] = dc.name;
  }
  return labels;
}

const root = findWorkspaceRoot(fileURLToPath(new URL(".", import.meta.url)));
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function sleepSync(ms) {
  spawnSync(
    process.execPath,
    ["-e", `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${Number(ms) || 0})`],
    { stdio: "ignore" }
  );
}

/** Non-blocking sleep for parallel fetch mode. */
function asyncSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
}

/** Run async tasks with a concurrency limit. */
async function parallelLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** RFC 8785/JCS-compatible canonicalization for CLI rows parsed by Node. */
function canonicalizeJson(value) {
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

function isRowArray(value) {
  return Array.isArray(value) && value.every(
    (row) => row && typeof row === "object" && !Array.isArray(row)
  );
}

/** Create the fixed card directory one component at a time, never via symlink. */
async function ensureSafeCardDirectory(sessionDir, outDir) {
  const absSession = resolve(sessionDir);
  const absOut = resolve(outDir);
  const rel = relative(absSession, absOut);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Writer card directory must stay below SESSION");
  }
  let cursor = absSession;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(cursor);
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Writer card directory must not traverse a symlink: ${cursor}`);
    }
  }
}

async function assertSafeOutputFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Writer output must be a regular non-symlink file: ${path}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

/**
 * Reuse an already persisted Writer result only when the complete minimal CLI
 * contract can be recomputed. Invalid, partial, or forged pairs fall through
 * to a fresh CLI fetch and are overwritten only after that fetch succeeds.
 */
export async function reusableEntry(outDir, { notBeforeMs }) {
  try {
    const entryPath = join(outDir, "entry.json");
    const metaPath = join(outDir, "entry.meta.json");
    const columnMetaPath = join(outDir, "entry.column-meta.json");
    const [entryLinkStat, metaLinkStat] = await Promise.all([
      lstat(entryPath),
      lstat(metaPath),
    ]);
    if (
      entryLinkStat.isSymbolicLink() ||
      metaLinkStat.isSymbolicLink() ||
      !entryLinkStat.isFile() ||
      !metaLinkStat.isFile()
    ) return null;
    // column-meta is optional: old caches predate it; the evidence builder
    // falls back to empty columnLabels when it is absent.
    let colMetaLinkStat = null;
    try { colMetaLinkStat = await lstat(columnMetaPath); } catch { /* optional */ }
    if (colMetaLinkStat && (colMetaLinkStat.isSymbolicLink() || !colMetaLinkStat.isFile())) return null;
    const readTasks = [
      readFile(entryPath, "utf8"),
      readFile(metaPath, "utf8"),
      stat(entryPath),
      stat(metaPath),
    ];
    if (colMetaLinkStat) readTasks.push(readFile(columnMetaPath, "utf8"));
    const results = await Promise.all(readTasks);
    const [rowsText, metaText, entryStat, metaStat, ...colMetaResults] = results;
    if (!Number.isFinite(notBeforeMs) || entryStat.mtimeMs < notBeforeMs || metaStat.mtimeMs < notBeforeMs) {
      return null;
    }
    const rows = JSON.parse(rowsText);
    const meta = JSON.parse(metaText);
    const metaKeys = meta && typeof meta === "object" && !Array.isArray(meta)
      ? Object.keys(meta).sort()
      : [];
    if (!isRowArray(rows)) return null;
    if (metaKeys.length !== 2 || metaKeys[0] !== "rowCount" || metaKeys[1] !== "rowsSha256") return null;
    if (!Number.isSafeInteger(meta.rowCount) || meta.rowCount < 0 || meta.rowCount !== rows.length) return null;
    if (!/^[a-f0-9]{64}$/.test(meta.rowsSha256 || "")) return null;
    if (rowsSha256(rows) !== meta.rowsSha256) return null;
    let columnLabels = {};
    if (colMetaResults.length) {
      columnLabels = JSON.parse(colMetaResults[0]);
      if (!columnLabels || typeof columnLabels !== "object" || Array.isArray(columnLabels)) return null;
    }
    return { rows, rowCount: meta.rowCount, rowsSha256: meta.rowsSha256, columnLabels };
  } catch {
    return null;
  }
}

/** Normalize the single confirmed-card Metric QueryRequest contract. */
export const normalizeEntryPayload = normalizeMetricQuery;

/**
 * Parse qdm-metric-cli's envelope stdout ({ meta, data }) and derive
 * persisted meta. The envelope carries Chinese column names in meta;
 * data field names are still codes.
 */
export function parseEntryMetaResponse(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new Error(`qdm-metric-cli returned invalid JSON: ${error.message || error}`);
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("qdm-metric-cli must return an envelope object");
  }
  if (envelope.code && envelope.code !== "OK") {
    throw new Error(`qdm-metric-cli returned error: ${envelope.message || envelope.code}`);
  }
  const rows = envelope.data;
  if (!Array.isArray(rows)) throw new Error("qdm-metric-cli envelope data must be a rows array");
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`qdm-metric-cli data[${index}] must be an object`);
    }
  }
  return { rows, rowCount: rows.length, rowsSha256: rowsSha256(rows), columnMeta: envelope.meta || {} };
}

function cardResult({ cardId, fetchStatus, dataPath = null, metaPath = null, entry = null, error = "", attempts = [] }) {
  return {
    cardId,
    fetchStatus,
    dataPath,
    metaPath,
    rowCount: entry?.rowCount ?? null,
    rowsSha256: entry?.rowsSha256 ?? null,
    error: error || null,
    attempts: attempts.map(({ attempt, status, durationMs }) => ({ attempt, status, durationMs })),
  };
}

async function fetchCard(sessionDir, card, {
  resultMtimeMs,
  sessionId,
  queryFn = runMetricQuery,
  sleepFn = sleepSync,
  projectRoot = root,
}) {
  const cardId = sanitizeCardId(card.id);
  const outDir = join(sessionDir, "data", "cards", cardId);
  await ensureSafeCardDirectory(sessionDir, outDir);

  let query;
  try {
    query = metricQueryFromCard(card);
  } catch (error) {
    return cardResult({
      cardId,
      fetchStatus: "failed",
      error: String(error.message || error),
    });
  }

  const persisted = await reusableEntry(outDir, { notBeforeMs: resultMtimeMs });
  if (persisted) {
    return cardResult({
      cardId,
      fetchStatus: "success",
      dataPath: join(outDir, "entry.json"),
      metaPath: join(outDir, "entry.meta.json"),
      entry: persisted,
      attempts: [],
    });
  }

  // Retry sleeps and all CLI attempts share one hard deadline, leaving time in
  // the Writer envelope for evidence reading and its structured return.
  const fetchDeadlineMs = Date.now() + metricFetchBudgetMs();
  const attempts = [];
  let entry = null;
  let failure = "unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = fetchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      failure = "METRIC_FETCH_BUDGET_EXHAUSTED: no time remains for another CLI attempt";
      break;
    }
    let result;
    try {
      result = await queryFn(query, { projectRoot, sessionId, timeoutMs: remainingMs });
    } catch (error) {
      failure = String(error.message || error);
      break;
    }
    let parseError = "";
    attempts.push({ attempt, status: result.status, durationMs: result.durationMs });
    if (result.status === 0 && !result.error) {
      try {
        entry = parseEntryMetaResponse(result.stdout);
        break;
      } catch (error) {
        parseError = String(error.message || error);
        failure = parseError;
      }
    } else {
      failure = (result.stderr || result.error || result.stdout || "unknown error").slice(0, 4000);
    }
    // A timeout (including exhaustion of the shared 540-second adapter budget)
    // is not a transient quick failure. Do not start another long-running
    // descendant; only explicit failures returned within 15 seconds may retry.
    if (result.timedOut) break;
    if (!shouldRetryMetricFailure(result, { parseError })) break;
    if (attempt < MAX_ATTEMPTS) {
      if (fetchDeadlineMs - Date.now() <= RETRY_DELAY_MS) {
        failure = `${failure}\nMETRIC_FETCH_BUDGET_EXHAUSTED: retry delay would exceed the adapter deadline`;
        break;
      }
      await sleepFn(RETRY_DELAY_MS);
    }
  }

  if (!entry) return cardResult({ cardId, fetchStatus: "failed", error: failure, attempts });

  const dataPath = join(outDir, "entry.json");
  const metaPath = join(outDir, "entry.meta.json");
  const columnMetaPath = join(outDir, "entry.column-meta.json");
  await Promise.all([assertSafeOutputFile(dataPath), assertSafeOutputFile(metaPath), assertSafeOutputFile(columnMetaPath)]);
  await writeFile(dataPath, `${JSON.stringify(entry.rows, null, 2)}\n`);
  await writeFile(
    metaPath,
    `${JSON.stringify({ rowCount: entry.rowCount, rowsSha256: entry.rowsSha256 }, null, 2)}\n`
  );
  await writeFile(
    columnMetaPath,
    `${JSON.stringify(buildColumnLabels(entry.columnMeta), null, 2)}\n`
  );
  return cardResult({ cardId, fetchStatus: "success", dataPath, metaPath, entry, attempts });
}

/** Fetch one card or all cards. No report or aggregate artifact is written. */
export async function fetchAllEntries(resultPath, {
  cardId,
  parallel = false,
  concurrency = 6,
  projectRoot = root,
} = {}) {
  const absResult = resolve(resultPath);
  const sessionDir = dirname(absResult);
  const result = JSON.parse(await readFile(absResult, "utf8"));
  const resultMtimeMs = (await stat(absResult)).mtimeMs;
  if (result.status !== "confirmed") {
    throw new Error(`result.status must be confirmed, got ${JSON.stringify(result.status)}`);
  }
  let cards = Array.isArray(result.cards) ? result.cards : [];
  if (cardId) cards = cards.filter((card) => card.id === cardId);
  if (!cards.length) throw new Error("no cards to fetch");

  const sessionId = String(result.session_id || "");

  if (parallel && !cardId) {
    const cardsResult = await parallelLimit(cards, concurrency, (card) =>
      fetchCard(sessionDir, card, {
        resultMtimeMs,
        sessionId,
        projectRoot,
        queryFn: runMetricQueryAsync,
        sleepFn: asyncSleep,
      })
    );
    return { producer: "fetch-entry.mjs", cards: cardsResult };
  }

  const cardsResult = [];
  for (const card of cards) {
    cardsResult.push(await fetchCard(sessionDir, card, {
      resultMtimeMs,
      sessionId,
      projectRoot,
    }));
  }
  return {
    producer: "fetch-entry.mjs",
    cards: cardsResult,
  };
}

export async function runCli() {
  const resultPath = value("--result");
  const cardId = value("--card-id");
  const parallel = argv.includes("--parallel");
  if (!resultPath) {
    process.stderr.write("usage: fetch-entry.mjs --result <result.json> [--card-id <id>] [--parallel]\n");
    process.exit(2);
  }
  try {
    const output = await fetchAllEntries(resultPath, { cardId, parallel });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(output.cards.every((card) => card.fetchStatus === "failed") ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
