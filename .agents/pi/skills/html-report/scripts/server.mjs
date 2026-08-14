#!/usr/bin/env node
/**
 * Local recommendation server for html-report.
 *
 * Lifecycle:
 * - Prefer --detach so the launcher returns immediately and survives Pi tool timeouts
 * - Auto-detect the Pi agent process (ancestor walk + process scan); optional --watch-pid override
 * - Optional idle / max-lifetime timeouts as a safety net
 * - Replaces any previous server for the same config directory
 * - Supports --stop to shut down by config/session pid file
 */
import http from "node:http";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { metricQueryFromCard } from "./metric-query-contract.mjs";
import { runMetricQuery } from "./metric-cli-executor.mjs";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const value = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return fallback;
  return argv[index + 1];
};

const configPath = value("--config");
const stopMode = hasFlag("--stop");
const detachMode = hasFlag("--detach") && process.env.HTML_REPORT_SERVER_WORKER !== "1";
if (!configPath) {
  process.stderr.write(
    "usage: server.mjs --config <recommendations.json> [--detach] [--open] [--session-id <id>] [--watch-pid <pid>] [--max-idle-ms <n>] [--max-lifetime-ms <n>]\n"
  );
  process.stderr.write("       server.mjs --config <recommendations.json> --stop\n");
  process.exit(2);
}

const resolvedConfig = resolve(configPath);
const stateDir = dirname(resolvedConfig);
const statePath = join(stateDir, "page-state.json");
const metaPath = join(stateDir, "server-meta.json");
const sessionId = String(value("--session-id", process.env.PI_SESSION_ID || process.env.CLAUDE_SESSION_ID || "manual")).replace(
  /[^a-zA-Z0-9._-]/g,
  "_"
);
const maxIdleMs = Number(value("--max-idle-ms", String(30 * 60 * 1000)));
const maxLifetimeMs = Number(value("--max-lifetime-ms", String(2 * 60 * 60 * 1000)));
const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const htmlPath = join(root, "public/local-report-builder.html");
const thisScript = fileURLToPath(import.meta.url);

function pidAlive(pid) {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessInfo(pid) {
  if (!pid || pid <= 1) return null;
  const out = spawnSync("ps", ["-p", String(pid), "-o", "ppid=,command="], { encoding: "utf8" });
  if (out.status !== 0) return null;
  const line = (out.stdout || "").trim();
  if (!line) return null;
  const match = line.match(/^(\d+)\s+(.*)$/);
  if (!match) return null;
  return { ppid: Number(match[1]), command: match[2] || "" };
}

function looksLikePiCommand(cmd) {
  if (!cmd) return false;
  // Never treat our own server / tests as the session owner.
  if (/html-report\/scripts\/server\.mjs/.test(cmd)) return false;
  if (/node --test\b/.test(cmd)) return false;
  if (/html-report\.test\.mjs/.test(cmd)) return false;
  return (
    /(^|[\\/\s])pi(\s|$)/.test(cmd) ||
    /\/\.bin\/pi\b/.test(cmd) ||
    /\/bin\/pi\b/.test(cmd) ||
    /pi-coding-agent/.test(cmd) ||
    /pi\s+--session\b/.test(cmd) ||
    /@mariozechner\/pi/.test(cmd)
  );
}

function ancestorPids(startPid = process.ppid) {
  const chain = [];
  let pid = Number(startPid) || 0;
  for (let depth = 0; depth < 24 && pid > 1; depth += 1) {
    chain.push(pid);
    const info = readProcessInfo(pid);
    if (!info) break;
    pid = info.ppid;
  }
  return chain;
}

/** Walk parent chain for the Pi agent that launched this tool. */
function findPiAncestorPid(startPid = process.ppid) {
  let pid = Number(startPid) || 0;
  for (let depth = 0; depth < 24 && pid > 1; depth += 1) {
    const info = readProcessInfo(pid);
    if (!info) break;
    if (looksLikePiCommand(info.command)) return pid;
    pid = info.ppid;
  }
  return 0;
}

/**
 * Fallback: scan process table for Pi agents owned by the same user.
 * Prefer a process that is also an ancestor of the current process.
 */
function findPiProcessByScan() {
  const out = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  if (out.status !== 0) return 0;
  const ancestors = new Set(ancestorPids(process.ppid));
  const candidates = [];
  for (const raw of (out.stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[3] || "";
    if (!looksLikePiCommand(command) || !pidAlive(pid)) continue;
    candidates.push({ pid, command, isAncestor: ancestors.has(pid) });
  }
  if (!candidates.length) return 0;
  const ancestorHit = candidates.find((item) => item.isAncestor);
  if (ancestorHit) return ancestorHit.pid;
  // Single Pi process on the machine — safe enough for local dev.
  if (candidates.length === 1) return candidates[0].pid;
  // Multiple Pi sessions: refuse to guess (caller can pass --watch-pid).
  process.stderr.write(
    `[html-report-server] multiple Pi processes found (${candidates.map((c) => c.pid).join(", ")}); pass --watch-pid explicitly if auto-detect binds wrong\n`
  );
  return 0;
}

/**
 * Resolve the process that should own server lifetime.
 * Priority: explicit --watch-pid > $PI_AGENT_PID > Pi ancestor > Pi process scan > ppid (foreground only).
 */
function resolveWatchPid() {
  const explicitRaw = value("--watch-pid", "");
  // Treat empty / 0 as "auto" so skill can omit the flag entirely.
  if (explicitRaw !== undefined && explicitRaw !== null && String(explicitRaw).trim() !== "") {
    const explicit = Number(explicitRaw);
    if (explicit > 1 && pidAlive(explicit)) {
      return { pid: explicit, source: "explicit" };
    }
  }

  const fromEnv = Number(process.env.PI_AGENT_PID || process.env.PI_SESSION_PID || 0);
  if (fromEnv > 1 && pidAlive(fromEnv)) {
    return { pid: fromEnv, source: "env" };
  }

  const ancestor = findPiAncestorPid(process.ppid);
  if (ancestor > 1) {
    return { pid: ancestor, source: "ancestor" };
  }

  const scanned = findPiProcessByScan();
  if (scanned > 1) {
    return { pid: scanned, source: "scan" };
  }

  // Foreground (tests): fall back to direct parent. Detached workers must not
  // default to ppid=1 / short-lived launcher.
  if (process.env.HTML_REPORT_SERVER_WORKER === "1") {
    return { pid: 0, source: "none" };
  }
  const ppid = Number(process.ppid || 0);
  if (ppid > 1 && pidAlive(ppid)) {
    return { pid: ppid, source: "ppid" };
  }
  return { pid: 0, source: "none" };
}

const watchResolved = resolveWatchPid();
const watchPid = watchResolved.pid;
const watchPidSource = watchResolved.source;

async function readMeta() {
  try {
    return JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    return null;
  }
}

async function stopExisting(reason = "replace") {
  const meta = await readMeta();
  if (!meta?.pid) return { stopped: false, reason: "no-meta" };
  if (meta.pid === process.pid) return { stopped: false, reason: "self" };
  if (!pidAlive(meta.pid)) {
    try {
      await unlink(metaPath);
    } catch {
      // ignore
    }
    return { stopped: false, reason: "stale-meta", meta };
  }
  try {
    process.kill(meta.pid, "SIGTERM");
  } catch {
    return { stopped: false, reason: "kill-failed", meta };
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && pidAlive(meta.pid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (pidAlive(meta.pid)) {
    try {
      process.kill(meta.pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  try {
    await unlink(metaPath);
  } catch {
    // ignore
  }
  return { stopped: true, reason, meta };
}

/**
 * Detach path: spawn a worker outside the tool process group so Pi tool
 * timeouts / turn end do not kill the HTTP server. Launcher prints URL and exits.
 */
async function runDetachLauncher() {
  const workerArgs = [thisScript, ...argv.filter((arg) => arg !== "--detach")];
  // Always pin the worker to the resolved owner so re-resolve inside worker
  // does not re-scan after the launcher (and its ancestors) disappear.
  if (watchPid > 1) {
    const filtered = [];
    for (let i = 0; i < workerArgs.length; i += 1) {
      if (workerArgs[i] === "--watch-pid") {
        i += 1; // skip previous value
        continue;
      }
      filtered.push(workerArgs[i]);
    }
    workerArgs.length = 0;
    workerArgs.push(...filtered, "--watch-pid", String(watchPid));
  }
  const child = spawn(process.execPath, workerArgs, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HTML_REPORT_SERVER_WORKER: "1" },
    cwd: process.cwd(),
  });

  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      child.unref();
      resolvePromise(code);
    };

    const timer = setTimeout(() => {
      process.stderr.write("[html-report-server] detach: timed out waiting for worker URL\n");
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish(1);
    }, 60000);

    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const nl = stdoutBuf.indexOf("\n");
      if (nl === -1) return;
      const line = stdoutBuf.slice(0, nl).trim();
      if (/^https?:\/\//.test(line)) {
        process.stdout.write(`${line}\n`);
        finish(0);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!settled) process.stderr.write(chunk);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      process.stderr.write(`[html-report-server] detach worker exited early code=${code} signal=${signal}\n`);
      finish(code || 1);
    });
  });
}

if (stopMode) {
  const result = await stopExisting("explicit-stop");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.stopped || result.reason === "stale-meta" || result.reason === "no-meta" ? 0 : 1);
}

if (detachMode) {
  const code = await runDetachLauncher();
  process.exit(code);
}

// Worker / foreground server path continues below.
await stopExisting("replace-on-start");

let token = process.env.QDM_INDICATORS_TOKEN || "";
let tokenWarning = "";
let pageState = {
  updatedAt: null,
  reason: "server-start",
  loaded: false,
  cards: [],
  note: "Waiting for the browser page to report selection state.",
};
let lastActivityAt = Date.now();
const startedAt = Date.now();
let shuttingDown = false;
let serverUrl = "";

const cas = process.env.QDM_CAS_CLI || join(root, "bin/cas-cli");
const indicatorsCli = process.env.QDM_INDICATORS_CLI || join(root, "bin/qdm-indicators-cli");
const resultPath = join(stateDir, "result.json");
let tokenRefreshed = false;

if (!token) {
  const auth = spawnSync(cas, ["token", "--app", "indicators", "--timeout", "20s"], { encoding: "utf8", timeout: 25000 });
  if (auth.status === 0) token = auth.stdout.trim();
  else tokenWarning = (auth.stderr || auth.stdout || "CAS token acquisition failed").trim().split("\n").at(-1);
}

function explainCliError(message) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  if (/token|401|403|460|expired|unauthorized|认证|登录/i.test(text)) {
    return {
      category: "auth",
      summary: "Indicators 认证失败（token 无效或过期）",
      hint: "请刷新 Access Token（cas-cli token --app indicators）后重试确认。",
      detail: text,
    };
  }
  if (/timeout|etimedout|timed out/i.test(lower)) {
    return {
      category: "timeout",
      summary: "CLI 查询超时",
      hint: "可缩小时间范围或减少指标后重试。",
      detail: text,
    };
  }
  if (/not support|不支持|incompatible|非法|invalid|参数/i.test(text)) {
    return {
      category: "params",
      summary: "指标/维度/筛选参数组合不被 Indicators 接受",
      hint: "请检查卡片的指标、维度、店日均口径与筛选条件是否兼容，修改后重新确认。",
      detail: text,
    };
  }
  if (/empty|无数据|no data/i.test(lower)) {
    return {
      category: "empty",
      summary: "查询可执行但返回空结果",
      hint: "通常仍可确认；若业务上必须有数，请调整门店/时间范围。",
      detail: text,
    };
  }
  return {
    category: "cli",
    summary: "卡片 CLI 执行失败",
    hint: "请根据下方 CLI 原始错误修改配置后重新提交确认。",
    detail: text || "unknown error",
  };
}

function runIndicatorsCli(argv, timeoutMs = 120000) {
  const env = { ...process.env };
  if (token) env.QDM_INDICATORS_TOKEN = token;
  let out = spawnSync(indicatorsCli, argv, { encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const message = () => `${out.stderr || ""}\n${out.stdout || ""}`.trim();
  if (out.status !== 0 && !tokenRefreshed && /token|401|403|460|expired|unauthorized|认证/i.test(message())) {
    tokenRefreshed = true;
    const auth = spawnSync(cas, ["token", "--app", "indicators", "--timeout", "20s"], {
      encoding: "utf8",
      timeout: 25000,
    });
    if (auth.status === 0 && auth.stdout.trim()) {
      token = auth.stdout.trim();
      env.QDM_INDICATORS_TOKEN = token;
      out = spawnSync(indicatorsCli, argv, { encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
    }
  }
  return out;
}

function validateCardWithCli(card) {
  const title = card?.title || card?.id || "未命名卡片";
  if (card?.query) return validateCardWithMetricCli(card, title);

  const requestBody = card?.requestBody || {};
  if (!Array.isArray(requestBody.indicatorFieldList) || !requestBody.indicatorFieldList.length) {
    return {
      ok: false,
      cardId: card?.id || "",
      title,
      error: explainCliError("指标列表为空，无法执行 analysis execute"),
    };
  }
  if (!Array.isArray(requestBody.aggDimUniqueCodeList) || !requestBody.aggDimUniqueCodeList.length) {
    return {
      ok: false,
      cardId: card?.id || "",
      title,
      error: explainCliError("行维度为空，无法执行 analysis execute"),
    };
  }

  // Smoke execute: one page only, smaller page size — proves the real query path works.
  const payload = {
    ...requestBody,
    currPage: 1,
    pageSize: Math.min(Number(requestBody.pageSize) || 20, 20),
    chartType: requestBody.chartType || "table",
    compareDate: Array.isArray(requestBody.compareDate) ? requestBody.compareDate : [],
  };
  const argv = [
    "analysis",
    "execute",
    "--payload-json",
    JSON.stringify(payload),
    "--single-page",
    "--page-size",
    String(payload.pageSize),
  ];
  const started = Date.now();
  const out = runIndicatorsCli(argv);
  const durationMs = Date.now() - started;
  const command = `${indicatorsCli} analysis execute --payload-json '<requestBody>' --single-page --page-size ${payload.pageSize}`;
  if (out.error && out.error.code === "ETIMEDOUT") {
    return {
      ok: false,
      cardId: card?.id || "",
      title,
      command,
      durationMs,
      error: explainCliError(`CLI timed out after ${durationMs}ms`),
    };
  }
  if (out.status !== 0) {
    return {
      ok: false,
      cardId: card?.id || "",
      title,
      command,
      durationMs,
      error: explainCliError((out.stderr || out.stdout || "").trim()),
    };
  }
  return {
    ok: true,
    cardId: card?.id || "",
    title,
    command,
    durationMs,
    stdoutBytes: Buffer.byteLength(out.stdout || "", "utf8"),
  };
}

function validateCardWithMetricCli(card, title) {
  let query;
  try {
    query = metricQueryFromCard(card);
  } catch (error) {
    return {
      ok: false,
      cardId: card?.id || "",
      title,
      error: explainCliError(error.message || String(error)),
    };
  }

  const smokeQuery = {
    ...query,
    pageNo: 1,
    pageSize: Math.min(Number(query.pageSize) || 20, 20),
  };
  const started = Date.now();
  const result = runMetricQuery(smokeQuery, {
    projectRoot: root,
    sessionId,
    timeoutMs: 120000,
  });
  const durationMs = Date.now() - started;
  const command = `qdm-metric-cli analysis execute --payload-json '<query.request>' --page-size ${smokeQuery.pageSize}`;
  if (result.timedOut) {
    return {
      ok: false,
      cardId: card?.id || "",
      title,
      command,
      durationMs,
      error: explainCliError(`CLI timed out after ${durationMs}ms`),
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      cardId: card?.id || "",
      title,
      command,
      durationMs,
      error: explainCliError((result.stderr || result.stdout || result.error || "").trim()),
    };
  }
  return {
    ok: true,
    cardId: card?.id || "",
    title,
    command,
    durationMs,
    stdoutBytes: Buffer.byteLength(result.stdout || "", "utf8"),
  };
}

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function persistPageState(snapshot) {
  pageState = snapshot;
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch {
    // Disk snapshot is best-effort; in-memory GET still works.
  }
}

async function writeMeta(extra = {}) {
  const meta = {
    pid: process.pid,
    ppid: process.ppid,
    watchPid,
    watchPidSource,
    sessionId,
    configPath: resolvedConfig,
    statePath,
    metaPath,
    url: serverUrl,
    port: serverUrl ? Number(new URL(serverUrl).port) : null,
    startedAt: new Date(startedAt).toISOString(),
    maxIdleMs,
    maxLifetimeMs,
    ...extra,
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

async function clearMeta() {
  try {
    const meta = await readMeta();
    if (meta?.pid === process.pid) await unlink(metaPath);
  } catch {
    // ignore
  }
}

function touchActivity() {
  lastActivityAt = Date.now();
}

async function readRecommendations() {
  return JSON.parse(await readFile(resolvedConfig, "utf8"));
}

function hasCompletePageValidation(validation, cards) {
  if (!Array.isArray(validation) || validation.length !== cards.length) return false;
  return cards.every((card, index) => {
    const item = validation[index];
    return item?.ok === true && (!item.cardId || !card?.id || item.cardId === card.id);
  });
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[html-report-server] shutting down: ${reason}\n`);
  try {
    await clearMeta();
  } catch {
    // ignore
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}

const server = http.createServer(async (req, res) => {
  touchActivity();
  const path = new URL(req.url, "http://127.0.0.1").pathname;

  if (req.method === "POST" && path === "/harness/page-state") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const snapshot = {
        ...body,
        updatedAt: body.updatedAt || new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        statePath,
      };
      await persistPageState(snapshot);
      return json(res, 200, { ok: true, updatedAt: snapshot.updatedAt, statePath });
    } catch (error) {
      return json(res, 400, { error: error.message || "invalid page state" });
    }
  }

  if (req.method === "POST" && path === "/harness/shutdown") {
    json(res, 200, { ok: true, reason: "http-shutdown" });
    setTimeout(() => shutdown("http-shutdown"), 10);
    return;
  }

  if (req.method === "POST" && path === "/harness/confirm/validate-card") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const card = body.card || body;
      const index = Number(body.index || 0);
      const total = Number(body.total || 0);
      const result = validateCardWithCli(card);
      return json(res, result.ok ? 200 : 422, {
        ...result,
        index,
        total,
        progress: total > 0 ? `${Math.min(index + 1, total)}/${total}` : undefined,
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: explainCliError(error.message || "invalid validate-card body") });
    }
  }

  if (req.method === "POST" && path === "/harness/confirm") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== "object") {
        return json(res, 400, { ok: false, error: "result payload is required" });
      }
      const cards = Array.isArray(body.cards) ? body.cards : [];
      if (!cards.length) {
        return json(res, 400, { ok: false, error: "cards must not be empty" });
      }

      // Optional server-side re-validation when client skips per-card calls.
      const pageValidation = Array.isArray(body.validation) ? body.validation : [];
      const skipValidate = body.skip_validate === true || body.already_validated === true || hasCompletePageValidation(pageValidation, cards);
      const validation = [];
      if (!skipValidate) {
        for (let i = 0; i < cards.length; i += 1) {
          const item = validateCardWithCli(cards[i]);
          validation.push(item);
          if (!item.ok) {
            return json(res, 422, {
              ok: false,
              failedIndex: i,
              failedCardId: item.cardId,
              failedTitle: item.title,
              error: item.error,
              validation,
              message: `卡片「${item.title}」CLI 校验失败，未写入 result.json`,
            });
          }
        }
      } else if (pageValidation.length) {
        validation.push(...pageValidation);
      }

      let recommendations = {};
      try {
        recommendations = await readRecommendations();
      } catch {
        recommendations = {};
      }
      const userQuestion = String(body.userQuestion || body.question || recommendations.userQuestion || recommendations.question || "").trim();
      const title = String(body.title || recommendations.title || cards[0]?.title || userQuestion || "Harness Web 报告").trim();

      const resultPayload = {
        ...body,
        status: "confirmed",
        userQuestion,
        title,
        mode: body.mode || recommendations.mode || "free",
        submitted_at: body.submitted_at || new Date().toISOString(),
        session_id: sessionId,
        result_path: resultPath,
        recommendations_path: resolvedConfig,
        validation,
        already_validated: skipValidate,
      };
      // Do not persist internal control flags.
      delete resultPayload.skip_validate;

      await mkdir(stateDir, { recursive: true });
      await writeFile(resultPath, `${JSON.stringify(resultPayload, null, 2)}\n`, "utf8");
      return json(res, 200, {
        ok: true,
        status: "confirmed",
        result_path: resultPath,
        session_id: sessionId,
        cards: cards.length,
        validation,
      });
    } catch (error) {
      return json(res, 500, { ok: false, error: error.message || "failed to write result.json" });
    }
  }

  if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
  if (path === "/healthz") {
    return json(res, 200, {
      status: "ok",
      pid: process.pid,
      sessionId,
      watchPid,
      uptimeMs: Date.now() - startedAt,
      idleMs: Date.now() - lastActivityAt,
    });
  }
  if (path === "/harness/recommendations") {
    return json(res, 200, await readRecommendations());
  }
  if (path === "/harness/result") {
    try {
      return json(res, 200, JSON.parse(await readFile(resultPath, "utf8")));
    } catch {
      return json(res, 404, { error: "result.json not found", result_path: resultPath });
    }
  }
  if (path === "/harness/config") {
    return json(res, 200, {
      token,
      token_source: token ? (process.env.QDM_INDICATORS_TOKEN ? "environment" : "cas-cli") : "",
      warning: tokenWarning,
      recommendations_only: true,
      session_id: sessionId,
      server_pid: process.pid,
      result_path: resultPath,
    });
  }
  if (path === "/harness/page-state") {
    let recommendations = null;
    try {
      recommendations = await readRecommendations();
    } catch {
      recommendations = null;
    }
    return json(res, 200, {
      page: pageState,
      recommendationsSummary: recommendations
        ? {
            title: recommendations.title || "",
            mode: recommendations.mode || "",
            cardCount: Array.isArray(recommendations.cards) ? recommendations.cards.length : 0,
            cards: (recommendations.cards || []).map((card) => ({
              id: card.id,
              title: card.title,
              indicatorFieldList: card.indicatorFieldList || [],
              aggDimUniqueCodeList: card.aggDimUniqueCodeList || [],
              columnAggDimUniqueCodeList: card.columnAggDimUniqueCodeList || [],
              startDate: card.startDate,
              endDate: card.endDate,
              filters: card.filters || [],
              storeCollectType: card.storeCollectType,
              indicatorBizId: card.indicatorBizId,
              chartType: card.chartType,
            })),
          }
        : null,
      statePath,
      server: {
        pid: process.pid,
        sessionId,
        watchPid,
        metaPath,
        url: serverUrl,
      },
    });
  }
  if (path === "/" || path === "/local-report-builder.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(await readFile(htmlPath));
  }
  return json(res, 404, { error: "not found" });
});

function startWatchdogs() {
  const interval = setInterval(() => {
    if (shuttingDown) return;
    // Primary lifecycle: Pi agent / explicit owner. Prefer PI_AGENT_PID over tool shells.
    if (watchPid > 1 && !pidAlive(watchPid)) {
      shutdown(`watch-pid-exited:${watchPid}`);
      return;
    }
    const now = Date.now();
    if (maxLifetimeMs > 0 && now - startedAt >= maxLifetimeMs) {
      shutdown("max-lifetime");
      return;
    }
    if (maxIdleMs > 0 && now - lastActivityAt >= maxIdleMs) {
      shutdown("max-idle");
    }
  }, 2000);
  interval.unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

server.listen(0, "127.0.0.1", async () => {
  serverUrl = `http://127.0.0.1:${server.address().port}/`;
  try {
    await writeMeta();
  } catch (error) {
    process.stderr.write(`[html-report-server] failed to write meta: ${error.message}\n`);
  }
  // First line of stdout remains the URL for callers/tests.
  process.stdout.write(serverUrl + "\n");
  process.stderr.write(
    `[html-report-server] pid=${process.pid} session=${sessionId} watchPid=${watchPid} source=${watchPidSource} meta=${metaPath}\n`
  );
  if (!watchPid) {
    process.stderr.write(
      "[html-report-server] warning: no Pi owner process detected; server will rely on max-idle/max-lifetime only\n"
    );
  }
  startWatchdogs();
  if (hasFlag("--open") && process.platform === "darwin") {
    spawn("open", [serverUrl], { detached: true, stdio: "ignore" }).unref();
  }
});
