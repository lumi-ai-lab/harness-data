#!/usr/bin/env node
/**
 * FETCH-EXPLORE (Phase B3.5 / P3): run a self-built Indicators analysis query for one explore task.
 *
 * Invoked by report-researcher (or Report Editor) after the agent designs the payload:
 *   node fetch-explore.mjs --result <result.json> --task-id <id> --payload-json '<json>'
 *   node fetch-explore.mjs --result <result.json> --task-id <id> --payload-file <path>
 *
 * Optional meta fields:
 *   --goal "..." --from-card-id "..." --hint "..."
 *
 * Rules (same spirit as fetch-entry):
 * - Never --single-page; all-pages only.
 * - Retry only explicit transient failures returned within 15s, up to 3×
 *   with 5s delay. CAS + sleeps + all attempts share a 540s hard budget;
 *   timeout stops immediately instead of starting another long query.
 * - Uses CLI --meta; persists rows plus rowCount + rowsSha256 provenance.
 * - A completed query can be reused after a parent/structured-return failure,
 *   but only when the complete result/task/query/payload/rows contract still
 *   validates.
 * - Version-2 tasks must declare evidencePlan.mode=new_query and materially
 *   differ from the source card beyond ordering/pagination/presentation.
 *
 * Products:
 *   data/explore/<task-id>.json       # success only
 *   data/explore/<task-id>.meta.json  # always
 */
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeEntryPayload,
  buildExecuteArgs,
  parseEntryMetaResponse,
  rowsSha256,
} from "./fetch-entry.mjs";
import {
  evidenceGapTypes,
  evidenceGapMatchesChangedKeys,
  isJsonObject,
  isValidEvidenceGap,
} from "./research-contract.mjs";
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
const DEFAULT_INDICATORS_TIMEOUT_MS = 600000;
const EXPLORE_CACHE_CONTRACT_VERSION = 1;

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

function ensureToken({ timeoutMs = 25000 } = {}) {
  if (process.env.QDM_INDICATORS_TOKEN) return process.env.QDM_INDICATORS_TOKEN;
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

const NON_SEMANTIC_QUERY_KEYS = new Set(["orderBy", "currPage", "pageSize", "chartType"]);
const MATERIAL_QUERY_KEYS = new Set([
  "indicatorFieldList",
  "aggDimUniqueCodeList",
  "columnAggDimUniqueCodeList",
  "filterDimUniqueCodeList",
  "startDate",
  "endDate",
  "compareDate",
  "storeCollectType",
  "indicatorsGroup",
]);
const SET_LIKE_QUERY_KEYS = new Set([
  "indicatorFieldList",
  "aggDimUniqueCodeList",
  "columnAggDimUniqueCodeList",
  "compareDate",
  "filterDimUniqueCodeList",
]);
const RUNNABLE_TASK_STATUSES = new Set(["pending", "running"]);

export function canonicalQueryJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalQueryJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalQueryJson(value[key])}`)
    .join(",")}}`;
}

function queryFingerprint(value) {
  return createHash("sha256").update(canonicalQueryJson(value), "utf8").digest("hex");
}

function jsonEqual(left, right) {
  return canonicalQueryJson(left) === canonicalQueryJson(right);
}

function isInside(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function ensureSafeExploreDirectory(sessionDir, outDir) {
  const absSession = resolve(sessionDir);
  const absOut = resolve(outDir);
  const rel = relative(absSession, absOut);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Researcher explore directory must stay below SESSION");
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
      throw new Error(`Researcher explore directory must not traverse a symlink: ${cursor}`);
    }
  }
}

async function assertSafeExploreFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Researcher explore output must be a regular non-symlink file: ${path}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function indicatorsTimeoutMs() {
  const configured = Number(process.env.QDM_INDICATORS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.floor(configured), DEFAULT_INDICATORS_TIMEOUT_MS)
    : DEFAULT_INDICATORS_TIMEOUT_MS;
}

function taskQueryContract(task, fromCardId) {
  return {
    taskId: String(task?.id || ""),
    fromCardId: String(fromCardId || ""),
    evidencePlan: {
      mode: String(task?.evidencePlan?.mode || ""),
      sourceCardId: String(task?.fromCardId || ""),
    },
    evidenceGap: task?.evidenceGap ?? null,
  };
}

/**
 * Validate a previous successful explore fetch without trusting its producer
 * label alone. Any missing, stale, symlinked, or mismatched field is a cache
 * miss; callers then follow the normal query path.
 */
export async function reusableExplore({
  sessionDir,
  outDir,
  dataPath,
  metaPath,
  payloadPath,
  resultPath,
  resultMtimeMs,
  resultSha256,
  taskId,
  taskQueryContractSha256,
  fromCardId,
  payload,
  payloadSha256,
  queryDelta,
  sourceQueryShape,
  queryShape,
}) {
  try {
    const [outInfo, dataInfo, metaInfo, payloadInfo] = await Promise.all([
      lstat(outDir),
      lstat(dataPath),
      lstat(metaPath),
      lstat(payloadPath),
    ]);
    if (
      outInfo.isSymbolicLink() || !outInfo.isDirectory() ||
      dataInfo.isSymbolicLink() || !dataInfo.isFile() ||
      metaInfo.isSymbolicLink() || !metaInfo.isFile() ||
      payloadInfo.isSymbolicLink() || !payloadInfo.isFile()
    ) return null;

    const [realSession, realOut, realData, realMeta, realPayload] = await Promise.all([
      realpath(sessionDir),
      realpath(outDir),
      realpath(dataPath),
      realpath(metaPath),
      realpath(payloadPath),
    ]);
    if (
      !isInside(realSession, realOut) ||
      dirname(realData) !== realOut ||
      dirname(realMeta) !== realOut ||
      dirname(realPayload) !== realOut
    ) return null;

    const [rowsText, metaText, payloadText, dataStat, metaStat, payloadStat] = await Promise.all([
      readFile(dataPath, "utf8"),
      readFile(metaPath, "utf8"),
      readFile(payloadPath, "utf8"),
      stat(dataPath),
      stat(metaPath),
      stat(payloadPath),
    ]);
    if (
      !Number.isFinite(resultMtimeMs) ||
      dataStat.mtimeMs < resultMtimeMs ||
      metaStat.mtimeMs < resultMtimeMs ||
      payloadStat.mtimeMs < resultMtimeMs
    ) return null;

    const rows = JSON.parse(rowsText);
    const meta = JSON.parse(metaText);
    const persistedPayload = JSON.parse(payloadText);
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) return null;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    if (!persistedPayload || typeof persistedPayload !== "object" || Array.isArray(persistedPayload)) return null;

    const computedRowsSha256 = rowsSha256(rows);
    const expectedQueryDeltaSha256 = queryFingerprint(queryDelta);
    const expectedSourceShapeSha256 = queryFingerprint(sourceQueryShape);
    const expectedQueryShapeSha256 = queryFingerprint(queryShape);
    if (
      meta.producer !== "fetch-explore.mjs" ||
      meta.producerVersion !== 2 ||
      meta.cacheContractVersion !== EXPLORE_CACHE_CONTRACT_VERSION ||
      meta.status !== "ok" ||
      meta.sessionDir !== sessionDir ||
      meta.resultPath !== resultPath ||
      meta.resultSha256 !== resultSha256 ||
      meta.taskId !== taskId ||
      meta.taskQueryContractSha256 !== taskQueryContractSha256 ||
      meta.fromCardId !== fromCardId ||
      meta.payloadPath !== payloadPath ||
      meta.dataPath !== dataPath ||
      meta.payloadSha256 !== payloadSha256 ||
      queryFingerprint(persistedPayload) !== payloadSha256 ||
      !jsonEqual(persistedPayload, payload) ||
      !jsonEqual(meta.queryDelta, queryDelta) ||
      meta.queryDeltaSha256 !== expectedQueryDeltaSha256 ||
      !jsonEqual(meta.sourceQueryShape, sourceQueryShape) ||
      meta.sourceQueryShapeSha256 !== expectedSourceShapeSha256 ||
      !jsonEqual(meta.queryShape, queryShape) ||
      meta.queryShapeSha256 !== expectedQueryShapeSha256 ||
      meta.rowCount !== rows.length ||
      meta.rowsSha256 !== computedRowsSha256 ||
      meta.pagination?.mode !== "all-pages" ||
      meta.pagination?.singlePage !== false ||
      !Array.isArray(meta.attempts) ||
      !meta.attempts.some((attempt) => attempt?.status === 0 && !attempt?.error)
    ) return null;

    return {
      rows,
      rowCount: rows.length,
      rowsSha256: computedRowsSha256,
      meta,
    };
  } catch {
    return null;
  }
}

function normalizeSetLike(value) {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const copy = { ...item };
      for (const key of ["dimFieldIdList", "values"]) {
        if (Array.isArray(copy[key])) {
          copy[key] = [...new Map(copy[key].map((entry) => [canonicalQueryJson(entry), entry])).values()]
            .sort((a, b) => canonicalQueryJson(a).localeCompare(canonicalQueryJson(b)));
        }
      }
      return copy;
    })
    .sort((a, b) => canonicalQueryJson(a).localeCompare(canonicalQueryJson(b)));
  return [...new Map(normalized.map((entry) => [canonicalQueryJson(entry), entry])).values()];
}

/** Query shape used to reject presentation-only explore requests. */
export function semanticQueryShape(rawPayload = {}) {
  const normalized = normalizeEntryPayload(rawPayload);
  const shape = {};
  for (const key of Object.keys(normalized).sort()) {
    if (!MATERIAL_QUERY_KEYS.has(key) || normalized[key] === undefined) continue;
    shape[key] = SET_LIKE_QUERY_KEYS.has(key)
      ? normalizeSetLike(normalized[key])
      : normalized[key];
  }
  return shape;
}

export function materialQueryDelta(originalPayload, candidatePayload) {
  const original = semanticQueryShape(originalPayload);
  const candidate = semanticQueryShape(candidatePayload);
  const changedKeys = [...new Set([...Object.keys(original), ...Object.keys(candidate)])]
    .filter((key) => canonicalQueryJson(original[key]) !== canonicalQueryJson(candidate[key]))
    .sort();
  const unclassifiedKeys = [...new Set([...Object.keys(originalPayload || {}), ...Object.keys(candidatePayload || {})])]
    .filter((key) => !MATERIAL_QUERY_KEYS.has(key) && !NON_SEMANTIC_QUERY_KEYS.has(key))
    .sort();
  return {
    material: changedKeys.length > 0,
    changedKeys,
    ignoredKeys: [...NON_SEMANTIC_QUERY_KEYS].sort(),
    unclassifiedKeys,
    changedUnclassifiedKeys: unclassifiedKeys.filter(
      (key) => canonicalQueryJson(originalPayload?.[key]) !== canonicalQueryJson(candidatePayload?.[key])
    ),
  };
}

/** Safe task id for filesystem paths. */
export function sanitizeTaskId(raw) {
  const s = String(raw || "task").trim();
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "task";
}

function runExecute(payload, { timeoutMs = DEFAULT_INDICATORS_TIMEOUT_MS } = {}) {
  const args = buildExecuteArgs(payload, { meta: true });
  const env = { ...process.env };
  const started = Date.now();
  const out = spawnSync(indicatorsCli, args, {
    encoding: "utf8",
    env,
    timeout: Math.max(1, Math.min(indicatorsTimeoutMs(), Math.floor(timeoutMs))),
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    cwd: root,
  });
  const result = {
    status: out.status,
    signal: out.signal,
    errorCode: out.error?.code || null,
    error: out.error ? String(out.error.message || out.error) : "",
    stdout: out.stdout || "",
    stderr: out.stderr || "",
    durationMs: Date.now() - started,
    argsSummary: {
      mode: "all-pages",
      meta: true,
      singlePage: false,
      pageSize: payload.pageSize,
      currPage: payload.currPage,
      indicatorFieldList: payload.indicatorFieldList,
      aggDimUniqueCodeList: payload.aggDimUniqueCodeList,
      startDate: payload.startDate,
      endDate: payload.endDate,
    },
  };
  return { ...result, timedOut: isIndicatorsTimeout(result) };
}

/**
 * @param {string} resultPath
 * @param {{
 *   taskId: string,
 *   payload: object,
 *   goal?: string,
 *   fromCardId?: string,
 *   hint?: string,
 * }} opts
 */
export async function fetchExploreTask(resultPath, opts) {
  const absResult = resolve(resultPath);
  const sessionDir = dirname(absResult);
  const taskId = sanitizeTaskId(opts.taskId);
  const outDir = join(sessionDir, "data", "explore");
  await ensureSafeExploreDirectory(sessionDir, outDir);

  const dataPath = join(outDir, `${taskId}.json`);
  const metaPath = join(outDir, `${taskId}.meta.json`);
  const payloadPath = join(outDir, `${taskId}.payload.json`);
  await Promise.all([
    assertSafeExploreFile(dataPath),
    assertSafeExploreFile(metaPath),
    assertSafeExploreFile(payloadPath),
  ]);
  const writeFailure = async ({
    errorCode,
    message,
    fromCardId = null,
    queryDelta = null,
    sourceQueryShape = null,
    queryShape = null,
  }) => {
    const meta = {
      producer: "fetch-explore.mjs",
      producerVersion: 2,
      sessionDir,
      resultPath: absResult,
      writtenAt: new Date().toISOString(),
      taskId,
      status: "failed",
      goal: opts.goal || "",
      fromCardId,
      hint: opts.hint || "",
      errorCode,
      error: message,
      queryDelta,
      payloadPath: null,
      payloadSha256: null,
      sourceQueryShape,
      sourceQueryShapeSha256: sourceQueryShape ? queryFingerprint(sourceQueryShape) : null,
      queryShape,
      queryShapeSha256: queryShape ? queryFingerprint(queryShape) : null,
      attempts: [],
      failedMessage: message,
      dataPath: null,
      rowCount: null,
      rowsSha256: null,
      pagination: { mode: "all-pages", singlePage: false },
    };
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  };

  // A confirmed result is the query authorization boundary.
  let confirmedResult;
  let resultMtimeMs;
  try {
    confirmedResult = JSON.parse(await readFile(absResult, "utf8"));
    resultMtimeMs = (await stat(absResult)).mtimeMs;
    if (confirmedResult.status !== "confirmed") {
      throw new Error(`result.status must be confirmed, got ${JSON.stringify(confirmedResult.status)}`);
    }
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`result.json not found: ${absResult}`);
    throw e;
  }
  const resultSha256 = queryFingerprint(confirmedResult);

  let fromCardId = opts.fromCardId || "";
  let contractedEvidenceGap = null;
  const tasksPath = join(sessionDir, "analysis", "tasks.json");
  let tasksDocument;
  try {
    tasksDocument = JSON.parse(await readFile(tasksPath, "utf8"));
  } catch (error) {
    return writeFailure({
      errorCode: error.code === "ENOENT" ? "TASKS_NOT_FOUND" : "TASKS_INVALID",
      message: `cannot read analysis/tasks.json: ${error.message || error}`,
      fromCardId: fromCardId || null,
    });
  }
  if (!tasksDocument || typeof tasksDocument !== "object" || Array.isArray(tasksDocument)) {
    return writeFailure({
      errorCode: "TASKS_INVALID",
      message: "analysis/tasks.json must contain an object document",
      fromCardId: fromCardId || null,
    });
  }
  if (Number(tasksDocument.version) !== 2) {
    return writeFailure({
      errorCode: "TASKS_VERSION_INVALID",
      message: `analysis/tasks.json version must be exactly 2, got ${JSON.stringify(tasksDocument.version)}`,
      fromCardId: fromCardId || null,
    });
  }
  if (!Array.isArray(tasksDocument.tasks)) {
    return writeFailure({
      errorCode: "TASKS_INVALID",
      message: "analysis/tasks.json tasks must be an array",
      fromCardId: fromCardId || null,
    });
  }
  const taskIds = new Map();
  for (const candidate of tasksDocument.tasks) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !candidate.id) {
      return writeFailure({
        errorCode: "TASKS_INVALID",
        message: "analysis/tasks.json requires every task to have an id",
        fromCardId: fromCardId || null,
      });
    }
    const safeId = sanitizeTaskId(candidate.id);
    if (taskIds.has(safeId)) {
      return writeFailure({
        errorCode: "TASK_IDS_COLLIDE",
        message: `task ids collide after sanitization: ${taskIds.get(safeId)} and ${candidate.id}`,
        fromCardId: fromCardId || null,
      });
    }
    taskIds.set(safeId, String(candidate.id));
  }
  const task = tasksDocument.tasks.find(
    (candidate) => String(candidate.id) === String(opts.taskId)
  );
  if (!task) {
    return writeFailure({
      errorCode: "TASK_NOT_FOUND",
      message: `task ${opts.taskId} not found in analysis/tasks.json`,
    });
  }
  if (!String(task.goal || "").trim()) {
    return writeFailure({
      errorCode: "TASK_GOAL_MISSING",
      message: `new_query task ${opts.taskId} requires goal`,
      fromCardId: task.fromCardId || null,
    });
  }
  const taskFromCardId = String(task.fromCardId || "");
  if (!taskFromCardId) {
    return writeFailure({
      errorCode: "TASK_FROM_CARD_MISSING",
      message: `new_query task ${opts.taskId} requires fromCardId`,
    });
  }
  if (
    task.evidencePlan?.sourceCardId != null &&
    String(task.evidencePlan.sourceCardId) !== taskFromCardId
  ) {
    return writeFailure({
      errorCode: "TASK_SOURCE_CARD_MISMATCH",
      message: `task ${opts.taskId} evidencePlan.sourceCardId must equal task.fromCardId`,
      fromCardId: taskFromCardId,
    });
  }
  const taskStatus = String(task.status || "pending").toLowerCase();
  if (!RUNNABLE_TASK_STATUSES.has(taskStatus)) {
    return writeFailure({
      errorCode: "TASK_STATUS_NOT_RUNNABLE",
      message: `task ${opts.taskId} status=${JSON.stringify(taskStatus)} is not runnable`,
      fromCardId: taskFromCardId,
    });
  }
  const planMode = String(task.evidencePlan?.mode || "");
  if (planMode !== "new_query") {
    return writeFailure({
      errorCode: "TASK_MODE_REUSE_ENTRY",
      message: `task ${opts.taskId} evidencePlan.mode=${JSON.stringify(planMode)}; use prepare-research-evidence.mjs instead of querying`,
      fromCardId: taskFromCardId,
    });
  }
  const evidenceGap = task.evidenceGap;
  contractedEvidenceGap = evidenceGap;
  if (!isValidEvidenceGap(evidenceGap)) {
    return writeFailure({
      errorCode: "TASK_EVIDENCE_GAP_MISSING",
          message: `new_query task ${opts.taskId} requires allowed evidenceGap.type or evidenceGap.types[] + evidenceGap.reason`,
      fromCardId: taskFromCardId,
    });
  }
  const contractCardId = taskFromCardId;
  if (fromCardId && fromCardId !== contractCardId) {
    return writeFailure({
      errorCode: "TASK_FROM_CARD_MISMATCH",
      message: `--from-card-id ${fromCardId} does not match tasks.json ${contractCardId}`,
      fromCardId: contractCardId,
    });
  }
  fromCardId = contractCardId;

  const rawPayload = opts.payload || {};
  if (!Array.isArray(rawPayload.indicatorFieldList) || !rawPayload.indicatorFieldList.length) {
    return writeFailure({
      errorCode: "INDICATORS_EMPTY",
      message: "indicatorFieldList is empty",
      fromCardId: fromCardId || null,
    });
  }

  const payload = normalizeEntryPayload(rawPayload);
  let queryDelta = null;
  let sourceQueryShape = null;
  const queryShape = semanticQueryShape(payload);
  if (fromCardId) {
    const fromCard = (Array.isArray(confirmedResult.cards) ? confirmedResult.cards : []).find(
      (card) => String(card?.id) === String(fromCardId)
    );
    if (!fromCard) {
      return writeFailure({
        errorCode: "FROM_CARD_NOT_FOUND",
        message: `fromCardId not found in result.json: ${fromCardId}`,
        fromCardId,
      });
    }
    if (!isJsonObject(fromCard.requestBody)) {
      return writeFailure({
        errorCode: "FROM_CARD_REQUEST_BODY_INVALID",
        message: `fromCardId ${fromCardId} has no valid requestBody baseline`,
        fromCardId,
        queryShape,
      });
    }
    sourceQueryShape = semanticQueryShape(fromCard.requestBody);
    queryDelta = materialQueryDelta(fromCard.requestBody, payload);
    if (queryDelta.changedUnclassifiedKeys.length > 0) {
      return writeFailure({
        errorCode: "UNCLASSIFIED_QUERY_CHANGE",
        message: `candidate query changes unclassified fields: ${queryDelta.changedUnclassifiedKeys.join(", ")}`,
        fromCardId,
        queryDelta,
        sourceQueryShape,
        queryShape,
      });
    }
    if (!queryDelta.material) {
      const message =
        "NO_MATERIAL_QUERY_DELTA: query differs only by presentation/pagination fields; reuse Writer entry.json";
      return writeFailure({
        errorCode: "NO_MATERIAL_QUERY_DELTA",
        message,
        fromCardId,
        queryDelta,
        sourceQueryShape,
        queryShape,
      });
    }
    if (!evidenceGapMatchesChangedKeys(contractedEvidenceGap, queryDelta.changedKeys)) {
      return writeFailure({
        errorCode: "QUERY_DELTA_DOES_NOT_MATCH_EVIDENCE_GAP",
        message: `query delta does not address evidenceGap types=${evidenceGapTypes(contractedEvidenceGap).join(",")}`,
        fromCardId,
        queryDelta,
        sourceQueryShape,
        queryShape,
      });
    }
  }
  const payloadSha256 = queryFingerprint(payload);
  const taskQueryContractSha256 = queryFingerprint(taskQueryContract(task, fromCardId));
  const cached = await reusableExplore({
    sessionDir,
    outDir,
    dataPath,
    metaPath,
    payloadPath,
    resultPath: absResult,
    resultMtimeMs,
    resultSha256,
    taskId,
    taskQueryContractSha256,
    fromCardId,
    payload,
    payloadSha256,
    queryDelta,
    sourceQueryShape,
    queryShape,
  });
  if (cached) {
    return {
      ...cached.meta,
      cacheReuse: {
        reused: true,
        reason: "validated persisted new_query fetch",
      },
    };
  }

  // Bound CAS + sleeps + all CLI attempts as one operation so the 720-second
  // Researcher envelope retains time for recall/Spec work and structured return.
  const fetchDeadlineMs = Date.now() + indicatorsFetchBudgetMs();
  await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
  const authRemainingMs = fetchDeadlineMs - Date.now();
  const budgetExpiredBeforeAuth = authRemainingMs <= 0;
  const authToken = budgetExpiredBeforeAuth ? "" : ensureToken({ timeoutMs: authRemainingMs });

  const attempts = [];
  let last = authToken
    ? null
    : {
        status: null,
        signal: null,
        error: budgetExpiredBeforeAuth
          ? "INDICATORS_FETCH_BUDGET_EXHAUSTED: no time remains for authentication"
          : "AUTH_TOKEN_FAILED: unable to obtain Indicators token",
        stdout: "",
        stderr: "",
        parseError: "",
        timedOut: budgetExpiredBeforeAuth,
        authFailed: !budgetExpiredBeforeAuth,
        argsSummary: null,
      };
  let entry = null;
  for (let attempt = 1; authToken && attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = fetchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      last = {
        status: null,
        signal: null,
        error: "INDICATORS_FETCH_BUDGET_EXHAUSTED: no time remains for another CLI attempt",
        stdout: "",
        stderr: "",
        parseError: "",
        timedOut: true,
        argsSummary: null,
      };
      break;
    }
    const result = runExecute(payload, { timeoutMs: remainingMs });
    let parseError = "";
    if (result.status === 0 && !result.error) {
      try {
        entry = parseEntryMetaResponse(result.stdout);
      } catch (error) {
        parseError = String(error.message || error);
      }
    }
    attempts.push({
      attempt,
      status: result.status,
      durationMs: result.durationMs,
      signal: result.signal,
      error: result.error || parseError,
      timedOut: result.timedOut,
      stderrTail: (result.stderr || "").slice(-2000),
      stdoutBytes: Buffer.byteLength(result.stdout || "", "utf8"),
    });
    last = { ...result, parseError };
    if (entry) break;
    if (result.timedOut) break;
    if (!shouldRetryIndicatorsFailure(result, { parseError })) break;
    if (attempt < MAX_ATTEMPTS) {
      if (fetchDeadlineMs - Date.now() <= RETRY_DELAY_MS) {
        last = {
          ...last,
          error: `${last?.error || last?.stderr || "transient failure"}\nINDICATORS_FETCH_BUDGET_EXHAUSTED: retry delay would exceed the adapter deadline`,
          timedOut: true,
        };
        break;
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }

  const ok = Boolean(entry);

  if (ok) {
    await writeFile(dataPath, `${JSON.stringify(entry.rows, null, 2)}\n`);
  }

  const meta = {
    producer: "fetch-explore.mjs",
    producerVersion: 2,
    cacheContractVersion: EXPLORE_CACHE_CONTRACT_VERSION,
    sessionDir,
    resultPath: absResult,
    resultSha256,
    writtenAt: new Date().toISOString(),
    taskId,
    status: ok ? "ok" : "failed",
    goal: opts.goal || "",
    fromCardId: fromCardId || null,
    hint: opts.hint || "",
    queryDelta,
    queryDeltaSha256: queryFingerprint(queryDelta),
    taskQueryContractSha256,
    payloadPath,
    payloadSha256,
    sourceQueryShape,
    sourceQueryShapeSha256: sourceQueryShape ? queryFingerprint(sourceQueryShape) : null,
    queryShape,
    queryShapeSha256: queryFingerprint(queryShape),
    dataPath: ok ? dataPath : null,
    rowCount: entry?.rowCount ?? null,
    rowsSha256: entry?.rowsSha256 ?? null,
    pagination: {
      mode: "all-pages",
      singlePage: false,
      pageSize: payload.pageSize,
      note: "fetch-explore never passes --single-page; CLI default pulls all pages",
    },
    argsSummary: last?.argsSummary || null,
    attempts,
    failedMessage: ok
      ? null
      : (last?.stderr || last?.error || last?.parseError || last?.stdout || "unknown error").slice(0, 4000),
    errorCode: ok
      ? null
      : last?.authFailed
        ? "AUTH_TOKEN_FAILED"
        : last?.timedOut
          ? "INDICATORS_TIMEOUT"
          : "INDICATORS_FETCH_FAILED",
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultPath = value("--result");
  const taskId = value("--task-id");
  const payloadJson = value("--payload-json");
  const payloadFile = value("--payload-file");
  if (!resultPath || !taskId || (!payloadJson && !payloadFile)) {
    process.stderr.write(
      "usage: fetch-explore.mjs --result <result.json> --task-id <id> (--payload-json '<json>' | --payload-file <path>) [--goal ...] [--from-card-id ...] [--hint ...]\n"
    );
    process.exit(2);
  }

  let payload;
  try {
    if (payloadFile) {
      payload = JSON.parse(await readFile(resolve(payloadFile), "utf8"));
    } else {
      payload = JSON.parse(payloadJson);
    }
  } catch (e) {
    process.stderr.write(`invalid payload JSON: ${e.message || e}\n`);
    process.exit(2);
  }

  try {
    const meta = await fetchExploreTask(resultPath, {
      taskId,
      payload,
      goal: value("--goal") || "",
      fromCardId: value("--from-card-id") || "",
      hint: value("--hint") || "",
    });
    process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
    process.exit(meta.status === "ok" ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
