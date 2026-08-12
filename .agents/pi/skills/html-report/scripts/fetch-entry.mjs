#!/usr/bin/env node
/**
 * FETCH (Phase B2): fetch one confirmed card's full detail through
 * `analysis execute --meta`.
 *
 * The CLI owns the successful data contract:
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
import { isIndicatorsTimeout } from "./indicators-timeout.mjs";
import {
  indicatorsFetchBudgetMs,
  isRetryableIndicatorsFailure,
  shouldRetryIndicatorsFailure,
} from "./indicators-retry.mjs";

export { isIndicatorsTimeout } from "./indicators-timeout.mjs";
export {
  indicatorsFetchBudgetMs,
  isRetryableIndicatorsFailure,
  shouldRetryIndicatorsFailure,
} from "./indicators-retry.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const indicatorsCli = process.env.QDM_INDICATORS_CLI || join(root, "bin/qdm-indicators-cli");
const casCli = process.env.QDM_CAS_CLI || join(root, "bin/cas-cli");

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;
const PAGE_SIZE_CAP = 5000;
let tokenResolutionAttempted = false;

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

function ensureToken({ timeoutMs = 25000 } = {}) {
  if (process.env.QDM_INDICATORS_TOKEN) return process.env.QDM_INDICATORS_TOKEN;
  if (tokenResolutionAttempted) return "";
  tokenResolutionAttempted = true;
  const auth = spawnSync(casCli, ["token", "--app", "indicators", "--timeout", "20s"], {
    encoding: "utf8",
    timeout: Math.max(1, Math.min(25000, Math.floor(timeoutMs))),
    killSignal: "SIGKILL",
  });
  if (auth.status === 0 && auth.stdout.trim()) {
    process.env.QDM_INDICATORS_TOKEN = auth.stdout.trim();
    return process.env.QDM_INDICATORS_TOKEN;
  }
  return "";
}

/** Normalize a confirmed card request for a full-history entry fetch. */
export function normalizeEntryPayload(requestBody = {}) {
  const pageSizeRaw = Number(requestBody.pageSize);
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(Math.floor(pageSizeRaw), PAGE_SIZE_CAP)
      : PAGE_SIZE_CAP;

  return {
    ...requestBody,
    currPage: 1,
    pageSize,
    chartType: requestBody.chartType || "table",
    compareDate: Array.isArray(requestBody.compareDate) ? requestBody.compareDate : [],
    filterDimUniqueCodeList: Array.isArray(requestBody.filterDimUniqueCodeList)
      ? requestBody.filterDimUniqueCodeList
      : [],
    columnAggDimUniqueCodeList: Array.isArray(requestBody.columnAggDimUniqueCodeList)
      ? requestBody.columnAggDimUniqueCodeList
      : [],
    indicatorFieldList: requestBody.indicatorFieldList || [],
    aggDimUniqueCodeList: requestBody.aggDimUniqueCodeList || [],
  };
}

/**
 * Both Writer and version-2 Researcher fetches opt into --meta so their rows
 * can be persisted with the same rowCount + RFC 8785/JCS hash contract.
 */
export function buildExecuteArgs(payload, { meta = false } = {}) {
  const args = ["analysis", "execute", "--payload-json", JSON.stringify(payload)];
  if (meta) args.push("--meta");
  return args;
}

/** Validate the exact successful `analysis execute --meta` contract. */
export function parseEntryMetaResponse(text) {
  let result;
  try {
    result = JSON.parse(text);
  } catch (error) {
    throw new Error(`analysis execute --meta returned invalid JSON: ${error.message || error}`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("analysis execute --meta must return an object");
  }
  const keys = Object.keys(result).sort();
  const expected = ["rowCount", "rows", "rowsSha256"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("analysis execute --meta must return exactly rows, rowCount, rowsSha256");
  }
  if (!Array.isArray(result.rows)) {
    throw new Error("analysis execute --meta rows must be an array");
  }
  if (!Number.isSafeInteger(result.rowCount) || result.rowCount < 0 || result.rowCount !== result.rows.length) {
    throw new Error("analysis execute --meta rowCount must equal rows.length");
  }
  if (!/^[a-f0-9]{64}$/.test(result.rowsSha256 || "")) {
    throw new Error("analysis execute --meta rowsSha256 must be 64 lowercase hexadecimal characters");
  }
  for (const [index, row] of result.rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`analysis execute --meta rows[${index}] must be an object`);
    }
  }
  return result;
}

function runExecute(payload, { timeoutMs = 600000 } = {}) {
  const args = buildExecuteArgs(payload, { meta: true });
  const env = { ...process.env };
  const started = Date.now();
  const out = spawnSync(indicatorsCli, args, {
    encoding: "utf8",
    env,
    timeout: Math.max(1, Math.min(600000, Math.floor(timeoutMs))),
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    cwd: root,
  });
  const result = {
    status: out.status,
    signal: out.signal,
    errorCode: out.error?.code || "",
    error: out.error ? String(out.error.message || out.error) : "",
    stdout: out.stdout || "",
    stderr: out.stderr || "",
    durationMs: Date.now() - started,
  };
  return { ...result, timedOut: isIndicatorsTimeout(result) };
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

async function fetchCard(sessionDir, card, { resultMtimeMs }) {
  const cardId = sanitizeCardId(card.id);
  const outDir = join(sessionDir, "data", "cards", cardId);
  await ensureSafeCardDirectory(sessionDir, outDir);

  const requestBody = card.requestBody || {};
  if (!Array.isArray(requestBody.indicatorFieldList) || !requestBody.indicatorFieldList.length) {
    return cardResult({
      cardId,
      fetchStatus: "failed",
      error: "indicatorFieldList is empty",
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

  // One adapter invocation must leave enough of the 720-second child envelope
  // for model setup, evidence reading, and structured return. CAS, retry sleeps,
  // and every CLI attempt therefore share one hard deadline.
  const fetchDeadlineMs = Date.now() + indicatorsFetchBudgetMs();

  // Authenticate once only after cache miss. Retrying the same CLI failure
  // must not add another 20–25 second CAS round trip on every attempt.
  const authRemainingMs = fetchDeadlineMs - Date.now();
  if (authRemainingMs <= 0) {
    return cardResult({
      cardId,
      fetchStatus: "failed",
      error: "INDICATORS_FETCH_BUDGET_EXHAUSTED: no time remains for authentication",
      attempts: [],
    });
  }
  if (!ensureToken({ timeoutMs: authRemainingMs })) {
    return cardResult({
      cardId,
      fetchStatus: "failed",
      error: "AUTH_TOKEN_FAILED: unable to obtain Indicators token",
      attempts: [],
    });
  }
  const payload = normalizeEntryPayload(requestBody);
  const attempts = [];
  let entry = null;
  let failure = "unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = fetchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      failure = "INDICATORS_FETCH_BUDGET_EXHAUSTED: no time remains for another CLI attempt";
      break;
    }
    const result = runExecute(payload, { timeoutMs: remainingMs });
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
    if (!shouldRetryIndicatorsFailure(result, { parseError })) break;
    if (attempt < MAX_ATTEMPTS) {
      if (fetchDeadlineMs - Date.now() <= RETRY_DELAY_MS) {
        failure = `${failure}\nINDICATORS_FETCH_BUDGET_EXHAUSTED: retry delay would exceed the adapter deadline`;
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
  for (const card of cards) cardsResult.push(await fetchCard(sessionDir, card, { resultMtimeMs }));
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
