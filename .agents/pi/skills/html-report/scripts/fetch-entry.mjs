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
 * A Writer returns the paths plus its concise analysis to the Report Editor.
 * No fetch ledger is written: the parent already receives each Writer result.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeCardId } from "./writer-return.mjs";
import { normalizeMetricQuery, metricQueryFromCard } from "./metric-query-contract.mjs";
import { buildMetricExecuteArgs, runMetricQuery } from "./metric-cli-executor.mjs";
import { isMetricTimeout } from "./metric-timeout.mjs";
import {
  metricFetchBudgetMs,
  isRetryableMetricFailure,
  shouldRetryMetricFailure,
} from "./metric-retry.mjs";

export { isMetricTimeout } from "./metric-timeout.mjs";
export {
  metricFetchBudgetMs,
  isRetryableMetricFailure,
  shouldRetryMetricFailure,
} from "./metric-retry.mjs";
export { buildMetricExecuteArgs as buildExecuteArgs } from "./metric-cli-executor.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
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
    const [rowsText, metaText, entryStat, metaStat] = await Promise.all([
      readFile(entryPath, "utf8"),
      readFile(metaPath, "utf8"),
      stat(entryPath),
      stat(metaPath),
    ]);
    // result.json is immutable after confirmation in the html-report flow.
    // This freshness guard prevents a later re-confirmation from reusing an
    // older pair without expanding the deliberately minimal meta contract.
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
    return { rows, rowCount: meta.rowCount, rowsSha256: meta.rowsSha256 };
  } catch {
    return null;
  }
}

/** Normalize the single confirmed-card Metric QueryRequest contract. */
export const normalizeEntryPayload = normalizeMetricQuery;

/** Parse qdm-metric-cli's default rows-array stdout and derive persisted meta. */
export function parseEntryMetaResponse(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new Error(`qdm-metric-cli returned invalid JSON: ${error.message || error}`);
  }
  if (!Array.isArray(rows)) throw new Error("qdm-metric-cli must return a rows array");
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`qdm-metric-cli rows[${index}] must be an object`);
    }
  }
  return { rows, rowCount: rows.length, rowsSha256: rowsSha256(rows) };
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

async function fetchCard(sessionDir, card, { resultMtimeMs, sessionId }) {
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
      result = runMetricQuery(query, { projectRoot: root, sessionId, timeoutMs: remainingMs });
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
      sleepSync(RETRY_DELAY_MS);
    }
  }

  if (!entry) return cardResult({ cardId, fetchStatus: "failed", error: failure, attempts });

  const dataPath = join(outDir, "entry.json");
  const metaPath = join(outDir, "entry.meta.json");
  await Promise.all([assertSafeOutputFile(dataPath), assertSafeOutputFile(metaPath)]);
  await writeFile(dataPath, `${JSON.stringify(entry.rows, null, 2)}\n`);
  await writeFile(
    metaPath,
    `${JSON.stringify({ rowCount: entry.rowCount, rowsSha256: entry.rowsSha256 }, null, 2)}\n`
  );
  return cardResult({ cardId, fetchStatus: "success", dataPath, metaPath, entry, attempts });
}

/** Fetch one card or all cards. No report or aggregate artifact is written. */
export async function fetchAllEntries(resultPath, { cardId } = {}) {
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

  const cardsResult = [];
  for (const card of cards) {
    cardsResult.push(await fetchCard(sessionDir, card, {
      resultMtimeMs,
      sessionId: String(result.session_id || ""),
    }));
  }
  return {
    producer: "fetch-entry.mjs",
    cards: cardsResult,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultPath = value("--result");
  const cardId = value("--card-id");
  if (!resultPath) {
    process.stderr.write("usage: fetch-entry.mjs --result <result.json> [--card-id <id>]\n");
    process.exit(2);
  }
  try {
    const output = await fetchAllEntries(resultPath, { cardId });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(output.cards.every((card) => card.fetchStatus === "failed") ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
