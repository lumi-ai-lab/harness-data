#!/usr/bin/env node
/**
 * Open qdm-metric-cli ui as the html-report Phase A editor.
 *
 * Does not write recommendations.json. The user builds cards in the CLI UI
 * and clicks 保存 to write $SESSION/result.json. Phase B still waits for
 * the Pi Gate reply 「继续」.
 *
 * Lifetime:
 * - --detach launcher returns immediately and leaves a worker that owns the CLI
 * - The worker exits when the watched Pi process dies, the CLI exits, or --stop
 * - session_shutdown in qdm-harness also calls --stop for this session
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuthzConfig, resolveMetricCliPath } from "../../../extensions/qdm-harness/authz-config.mjs";

export const METRIC_CLI_UI_MARKER_RELATIVE_PATH = ["debug", "metric-cli-ui.json"];
export const A_CONFIG_QUESTION_RELATIVE_PATH = ["debug", "a-config-question.json"];
export const METRIC_CLI_UI_PRODUCER = "open-metric-cli-ui.mjs";
export const METRIC_CLI_UI_WORKER_ENV = "HTML_REPORT_METRIC_CLI_UI_WORKER";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const thisScript = fileURLToPath(import.meta.url);

export function sanitizeSessionId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function sessionDirFor(projectRoot, sessionId) {
  return join(resolve(projectRoot), ".harness", "state", "html-report", sanitizeSessionId(sessionId));
}

export function shouldSpawnMetricCliUi(env = process.env) {
  return env.HTML_REPORT_METRIC_CLI_UI_OPEN !== "0" && env.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN !== "0";
}

export function parseUiListenUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s]+/);
  return match ? match[0].replace(/[)\].,;]+$/, "") : "";
}

export function isMetricCliUiWorker(env = process.env) {
  return env[METRIC_CLI_UI_WORKER_ENV] === "1";
}

export function pidAlive(pid) {
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

export function looksLikePiCommand(cmd) {
  if (!cmd) return false;
  if (/html-report\/scripts\/open-metric-cli-ui\.mjs/.test(cmd)) return false;
  if (/html-report\/scripts\/server\.mjs/.test(cmd)) return false;
  if (/node --test\b/.test(cmd)) return false;
  if (/open-metric-cli-ui\.test\.mjs/.test(cmd)) return false;
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
  if (candidates.length === 1) return candidates[0].pid;
  process.stderr.write(
    `[metric-cli-ui] multiple Pi processes found (${candidates.map((item) => item.pid).join(", ")}); pass --watch-pid explicitly if auto-detect binds wrong\n`
  );
  return 0;
}

/**
 * Resolve the process that should own UI lifetime.
 * Priority: explicit --watch-pid > $PI_AGENT_PID > Pi ancestor > Pi scan > ppid (foreground only).
 */
export function resolveWatchPid({
  env = process.env,
  explicitWatchPid = 0,
  isWorker = isMetricCliUiWorker(env),
} = {}) {
  const explicit = Number(explicitWatchPid || 0);
  if (explicit > 1 && pidAlive(explicit)) {
    return { pid: explicit, source: "explicit" };
  }

  const fromEnv = Number(env.PI_AGENT_PID || env.PI_SESSION_PID || 0);
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

  if (isWorker) {
    return { pid: 0, source: "none" };
  }
  const ppid = Number(process.ppid || 0);
  if (ppid > 1 && pidAlive(ppid)) {
    return { pid: ppid, source: "ppid" };
  }
  return { pid: 0, source: "none" };
}

export function publicMetricCliUiResult(opened) {
  if (!opened || typeof opened !== "object") return opened;
  const { child: _child, ...rest } = opened;
  return rest;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function persistAConfigQuestion({ sessionDir, sessionId, userQuestion }) {
  const path = join(sessionDir, ...A_CONFIG_QUESTION_RELATIVE_PATH);
  await writeJson(path, {
    version: 1,
    producer: METRIC_CLI_UI_PRODUCER,
    sessionId,
    userQuestion: String(userQuestion || "").trim(),
    writtenAt: new Date().toISOString(),
  });
  return path;
}

export async function readAConfigQuestion(sessionDir) {
  const value = await readJson(join(sessionDir, ...A_CONFIG_QUESTION_RELATIVE_PATH));
  return String(value?.userQuestion || "").trim();
}

export async function ensureResultUserQuestion(sessionDir, resultPath = join(sessionDir, "result.json")) {
  const result = await readJson(resultPath);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { changed: false, result: null };
  }
  if (String(result.userQuestion || "").trim()) {
    return { changed: false, result };
  }
  const userQuestion = (await readAConfigQuestion(sessionDir)) || String(result.title || "").trim();
  if (!userQuestion) return { changed: false, result };
  result.userQuestion = userQuestion;
  await writeJson(resultPath, result);
  return { changed: true, result };
}

function uniquePids(values) {
  return [...new Set(values.map((value) => Number(value) || 0).filter((pid) => pid > 1 && pid !== process.pid))];
}

function killPid(pid, signal = "SIGTERM") {
  if (!pid || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid, signal = "SIGTERM") {
  if (!pid || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return killPid(pid, signal);
  }
}

async function waitUntilDead(pids, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some((pid) => pidAlive(pid))) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  return !pids.some((pid) => pidAlive(pid));
}

async function stopExisting(markerPath) {
  const meta = await readJson(markerPath);
  const pids = uniquePids([meta?.pid, meta?.cliPid]);
  if (!pids.length) return { stopped: false };
  for (const pid of pids) {
    killProcessGroup(pid, "SIGTERM");
  }
  const dead = await waitUntilDead(pids, 2000);
  if (!dead) {
    for (const pid of pids) {
      killProcessGroup(pid, "SIGKILL");
      killPid(pid, "SIGKILL");
    }
    await waitUntilDead(pids, 400);
  }
  return { stopped: true, pid: meta?.pid || pids[0], cliPid: meta?.cliPid || 0 };
}

function watchIntervalMs(env = process.env) {
  const raw = Number(env.HTML_REPORT_METRIC_CLI_UI_WATCH_MS || 2000);
  return Number.isFinite(raw) && raw >= 50 ? raw : 2000;
}

function startWatchdog(child, watchPid, { keepAlive = false, env = process.env } = {}) {
  if (!watchPid || watchPid <= 1 || !child) return;
  const timer = setInterval(() => {
    if (!pidAlive(watchPid)) {
      try {
        if (child.pid) killProcessGroup(child.pid, "SIGTERM");
      } catch {
        // ignore
      }
      clearInterval(timer);
    }
  }, watchIntervalMs(env));
  if (!keepAlive) timer.unref?.();
  child.on("exit", () => clearInterval(timer));
}

function waitForListenUrl(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`qdm-metric-cli ui timed out waiting for listen URL; ${stderr.trim()}`));
    }, 20000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const found = parseUiListenUrl(stdout);
      if (found) finish(null, found);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(new Error(`qdm-metric-cli ui exited early code=${code} signal=${signal}; ${stderr.trim()}`));
    });
  });
}

function waitForWorkerReady(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try {
        if (child.pid) killProcessGroup(child.pid, "SIGTERM");
      } catch {
        // ignore
      }
      finish(new Error(`metric-cli-ui detach worker timed out; ${stderr.trim()}`));
    }, 20000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      child.unref?.();
      if (error) reject(error);
      else resolvePromise(value);
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      const line = stdout.slice(0, newline).trim();
      try {
        const parsed = JSON.parse(line);
        if (parsed?.preset === "metric-cli-ui") finish(null, parsed);
      } catch {
        // keep reading until a complete JSON line arrives
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
      if (!settled) process.stderr.write(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(new Error(`metric-cli-ui detach worker exited early code=${code} signal=${signal}; ${stderr.trim()}`));
    });
  });
}

async function launchDetachedWorker({
  projectRoot,
  sessionId,
  userQuestion,
  open,
  env,
  watchPid,
}) {
  const watch = resolveWatchPid({ env, explicitWatchPid: watchPid, isWorker: false });
  const args = [thisScript, "--session-id", sessionId, "--project-root", projectRoot];
  if (userQuestion) args.push("--question", userQuestion);
  args.push(open ? "--open" : "--no-open");
  if (watch.pid > 1) args.push("--watch-pid", String(watch.pid));
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: { ...env, [METRIC_CLI_UI_WORKER_ENV]: "1" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return waitForWorkerReady(child);
}

export async function openMetricCliUi({
  projectRoot = root,
  sessionId,
  userQuestion = "",
  open = true,
  spawnUi = shouldSpawnMetricCliUi(),
  detach = false,
  watchPid = 0,
  env = process.env,
  now = new Date(),
} = {}) {
  const safeSessionId = sanitizeSessionId(sessionId);
  if (!safeSessionId) throw new Error("--session-id is required");
  const sessionDir = sessionDirFor(projectRoot, safeSessionId);
  const markerPath = join(sessionDir, ...METRIC_CLI_UI_MARKER_RELATIVE_PATH);
  await mkdir(join(sessionDir, "debug"), { recursive: true });
  const questionPath = await persistAConfigQuestion({
    sessionDir,
    sessionId: safeSessionId,
    userQuestion,
  });

  const config = loadAuthzConfig(projectRoot, env);
  const cliPath = resolveMetricCliPath(projectRoot, config, env);
  if (spawnUi && !existsSync(cliPath)) {
    throw new Error(`QDM_METRIC_CLI_UNAVAILABLE: ${cliPath}`);
  }

  const shouldDetach = Boolean(detach) && spawnUi && !isMetricCliUiWorker(env);
  if (shouldDetach) {
    const opened = await launchDetachedWorker({
      projectRoot,
      sessionId: safeSessionId,
      userQuestion,
      open,
      env,
      watchPid,
    });
    return publicMetricCliUiResult(opened);
  }

  await stopExisting(markerPath);

  const watch = resolveWatchPid({
    env,
    explicitWatchPid: watchPid,
    isWorker: isMetricCliUiWorker(env),
  });
  let url = "";
  let child = null;
  let cliPid = 0;
  if (spawnUi) {
    const args = [
      "ui",
      "--session-local-dir",
      sessionDir,
      "--addr",
      "127.0.0.1:0",
    ];
    if (!open) args.push("--no-open");
    child = spawn(cliPath, args, {
      cwd: projectRoot,
      env,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    cliPid = child.pid || 0;
    try {
      url = await waitForListenUrl(child);
    } catch (error) {
      if (cliPid) killProcessGroup(cliPid, "SIGTERM");
      throw error;
    }
    startWatchdog(child, watch.pid, {
      keepAlive: isMetricCliUiWorker(env),
      env,
    });
  }

  const ownerPid = isMetricCliUiWorker(env) ? process.pid : cliPid;
  const marker = {
    version: 1,
    producer: METRIC_CLI_UI_PRODUCER,
    sessionId: safeSessionId,
    ui: "qdm-metric-cli",
    b5Design: "skip",
    cliPath,
    url: url || null,
    pid: ownerPid,
    cliPid,
    watchPid: watch.pid || 0,
    watchPidSource: watch.source,
    questionPath,
    startedAt: now.toISOString(),
  };
  await writeJson(markerPath, marker);
  return {
    preset: "metric-cli-ui",
    sessionDir,
    markerPath,
    questionPath,
    serverUrl: url || null,
    cliPath,
    pid: ownerPid,
    cliPid,
    watchPid: watch.pid || 0,
    watchPidSource: watch.source,
    cardCount: 0,
    child,
  };
}

export async function stopMetricCliUi({ projectRoot = root, sessionId } = {}) {
  const sessionDir = sessionDirFor(projectRoot, sanitizeSessionId(sessionId));
  const markerPath = join(sessionDir, ...METRIC_CLI_UI_MARKER_RELATIVE_PATH);
  const result = await stopExisting(markerPath);
  try {
    await unlink(markerPath);
  } catch {
    // ignore
  }
  return result;
}

function readArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
    } else {
      flags.add(key);
    }
  }
  return { values, flags };
}

async function runWorkerLifetime(opened) {
  const child = opened?.child;
  if (!child) return;
  const shutdown = () => {
    if (opened.cliPid) killProcessGroup(opened.cliPid, "SIGTERM");
  };
  process.on("SIGTERM", () => {
    shutdown();
  });
  process.on("SIGINT", () => {
    shutdown();
  });
  process.on("SIGHUP", () => {
    shutdown();
  });
  await new Promise((resolveWait) => {
    child.once("exit", () => resolveWait());
  });
}

async function main() {
  const { values, flags } = readArgs(process.argv.slice(2));
  const projectRoot = values["project-root"] || root;
  if (flags.has("stop")) {
    const stopped = await stopMetricCliUi({
      projectRoot,
      sessionId: values["session-id"],
    });
    process.stdout.write(`${JSON.stringify(stopped)}\n`);
    return;
  }
  const opened = await openMetricCliUi({
    projectRoot,
    sessionId: values["session-id"],
    userQuestion: values.question || "",
    open: flags.has("open") || !flags.has("no-open"),
    spawnUi: shouldSpawnMetricCliUi() && !flags.has("skip-spawn"),
    detach: flags.has("detach") && !isMetricCliUiWorker(),
    watchPid: Number(values["watch-pid"] || 0),
  });
  process.stdout.write(`${JSON.stringify(publicMetricCliUiResult(opened))}\n`);
  if (isMetricCliUiWorker()) {
    await runWorkerLifetime(opened);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
