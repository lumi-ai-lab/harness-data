#!/usr/bin/env node
/**
 * Convert $SESSION/analysis/main.md into sibling analysis/main.html via md2html.
 *
 * Usage:
 *   node export-main-html.mjs --session-dir <absolute SESSION>
 *
 * Callers must not pass input, output, template, or md2html options.
 * The CLI always reads analysis/main.md and publishes analysis/main.html.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MAIN_HTML_PRODUCER = "export-main-html.mjs";
export const MAIN_HTML_META_VERSION = 1;
export const MAIN_HTML_THEME = "report";
export const MAIN_HTML_RENDERER = "svg";
export const DEFAULT_MAIN_HTML_TIMEOUT_MS = 120_000;

const argv = process.argv.slice(2);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nowIso(now) {
  if (typeof now === "function") return now();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function truncateText(value, limit = 4000) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(truncated)`;
}

function ensureInside(root, path, label) {
  const absRoot = resolve(root);
  const abs = resolve(path);
  const rel = relative(absRoot, abs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
  throw new Error(`${label} must stay under SESSION: ${abs}`);
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Walk every path component from SESSION to `path` without following
 * symbolic links. Existing leaves must be regular files when `asFile`
 * is true; missing leaves are allowed when `mustExist` is false.
 */
async function inspectSessionPath(sessionDir, path, label, { mustExist = true, asFile = true } = {}) {
  const absSession = resolve(sessionDir);
  const absPath = ensureInside(absSession, path, label);
  const sessionInfo = await lstat(absSession);
  if (sessionInfo.isSymbolicLink() || !sessionInfo.isDirectory()) {
    throw new Error("SESSION must be a regular directory, not a symbolic link");
  }

  const rel = relative(absSession, absPath);
  const parts = rel.split(sep).filter(Boolean);
  if (!parts.length) throw new Error(`${label} must be a path below SESSION`);

  let cursor = absSession;
  let leafInfo = null;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = await lstatOrNull(cursor);
    const isLeaf = index === parts.length - 1;
    if (!info) {
      if (isLeaf && !mustExist) return { path: absPath, exists: false, info: null };
      throw new Error(`${label} is missing: ${absPath}`);
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} must not use symbolic links: ${cursor}`);
    }
    if (!isLeaf && !info.isDirectory()) {
      throw new Error(`${label} has a non-directory parent component: ${cursor}`);
    }
    if (isLeaf) {
      if (asFile && !info.isFile()) throw new Error(`${label} must be a regular file: ${cursor}`);
      if (!asFile && !info.isDirectory()) throw new Error(`${label} must be a directory: ${cursor}`);
      leafInfo = info;
    }
  }

  const [realSession, realPath] = await Promise.all([realpath(absSession), realpath(absPath)]);
  ensureInside(realSession, realPath, label);
  return { path: absPath, exists: true, info: leafInfo };
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

async function readJsonOrNull(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function withExportLock(sessionDir, operation, { lockWaitMs = 5_000, lockStaleMs = 30_000 } = {}) {
  const debugDir = join(resolve(sessionDir), "debug");
  const lockDir = join(debugDir, ".main-html-export.lock");
  await mkdir(debugDir, { recursive: true });
  ensureInside(sessionDir, lockDir, "HTML export lock");
  const deadline = Date.now() + Math.max(1, lockWaitMs);
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > lockStaleMs) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        const failure = failedResult({
          error: `timed out waiting for HTML export lock: ${lockDir}`,
          status: "failed",
        });
        return failure;
      }
      await delay(10);
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function failedResult(fields) {
  return {
    ok: false,
    status: "failed",
    mainPath: fields.mainPath || null,
    htmlPath: fields.htmlPath || null,
    metaPath: fields.metaPath || null,
    inputSha256: fields.inputSha256 || null,
    outputSha256: fields.outputSha256 || null,
    bytes: fields.bytes ?? null,
    attempt: fields.attempt ?? 1,
    error: String(fields.error || "HTML export failed"),
    timedOut: fields.timedOut === true,
  };
}

function successResult(fields) {
  return {
    ok: true,
    status: fields.status,
    mainPath: fields.mainPath,
    htmlPath: fields.htmlPath,
    metaPath: fields.metaPath,
    inputSha256: fields.inputSha256,
    outputSha256: fields.outputSha256,
    bytes: fields.bytes,
    attempt: fields.attempt,
  };
}

export function mainHtmlPaths(sessionDir) {
  const abs = resolve(String(sessionDir || ""));
  return {
    sessionDir: abs,
    mainPath: join(abs, "analysis", "main.md"),
    htmlPath: join(abs, "analysis", "main.html"),
    metaPath: join(abs, "analysis", "main.html.meta.json"),
    ledgerPath: join(abs, "debug", "main-html-export.json"),
    lockDir: join(abs, "debug", ".main-html-export.lock"),
  };
}

async function currentHtmlReceipt(paths, inputSha256) {
  try {
    const html = await inspectSessionPath(paths.sessionDir, paths.htmlPath, "analysis/main.html");
    const metaInfo = await inspectSessionPath(paths.sessionDir, paths.metaPath, "analysis/main.html.meta.json");
    if (!html.exists || !metaInfo.exists) return null;
    const meta = await readJsonOrNull(paths.metaPath);
    if (!meta) return null;
    const htmlBytes = await readFile(paths.htmlPath);
    const outputSha256 = sha256Buffer(htmlBytes);
    if (
      meta.producer !== MAIN_HTML_PRODUCER ||
      meta.version !== MAIN_HTML_META_VERSION ||
      meta.inputSha256 !== inputSha256 ||
      meta.outputSha256 !== outputSha256 ||
      (Number.isSafeInteger(meta.bytes) && meta.bytes !== htmlBytes.length)
    ) return null;
    return {
      outputSha256,
      bytes: htmlBytes.length,
      attempt: Number.isSafeInteger(meta.attempt) ? meta.attempt : 1,
    };
  } catch {
    return null;
  }
}

function runMd2html(command, args, { cwd, env, timeoutMs, spawnImpl }) {
  return new Promise((resolveChild) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveChild(result);
    };
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        status: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error?.code || "",
        stdout,
        stderr,
        timedOut: false,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, Math.max(1, timeoutMs));
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        status: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error?.code || "",
        stdout,
        stderr,
        timedOut: false,
      });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      finish({
        status,
        signal,
        error: null,
        errorCode: "",
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function writeLedger(paths, payload) {
  const debugDir = dirname(paths.ledgerPath);
  await mkdir(debugDir, { recursive: true });
  ensureInside(paths.sessionDir, paths.ledgerPath, "HTML export ledger");
  await atomicWrite(paths.ledgerPath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function previousAttempt(paths) {
  const ledger = await readJsonOrNull(paths.ledgerPath);
  return Number.isSafeInteger(ledger?.attempt) && ledger.attempt > 0 ? ledger.attempt : 0;
}

export async function htmlExportSummary(sessionDir) {
  const paths = mainHtmlPaths(sessionDir);
  const ledger = await readJsonOrNull(paths.ledgerPath);
  if (ledger?.ok === true && (ledger.status === "generated" || ledger.status === "up_to_date")) {
    return {
      status: ledger.status,
      htmlPath: paths.htmlPath,
      metaPath: paths.metaPath,
      inputSha256: ledger.inputSha256 || null,
      outputSha256: ledger.outputSha256 || null,
      bytes: ledger.bytes ?? null,
      attempt: ledger.attempt ?? null,
      error: null,
    };
  }
  if (ledger?.ok === false || ledger?.status === "failed") {
    return {
      status: "failed",
      htmlPath: (await lstatOrNull(paths.htmlPath))?.isFile() ? paths.htmlPath : null,
      metaPath: (await lstatOrNull(paths.metaPath))?.isFile() ? paths.metaPath : null,
      inputSha256: ledger.inputSha256 || null,
      outputSha256: ledger.outputSha256 || null,
      bytes: ledger.bytes ?? null,
      attempt: ledger.attempt ?? null,
      error: ledger.error || "HTML export failed",
    };
  }
  return {
    status: "awaiting_confirmation",
    htmlPath: null,
    metaPath: null,
    inputSha256: null,
    outputSha256: null,
    bytes: null,
    attempt: null,
    error: null,
  };
}

export async function exportMainHtml(sessionDir, options = {}) {
  const abs = resolve(String(sessionDir || ""));
  if (!abs || abs === ".") {
    return failedResult({ error: "session dir is required" });
  }
  const paths = mainHtmlPaths(abs);
  const env = options.env || process.env;
  const spawnImpl = options.spawnImpl || spawn;
  const md2htmlCommand = options.md2htmlCommand || env.MD2HTML_BIN || "md2html";
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : Number.isFinite(Number(env.MAIN_HTML_EXPORT_TIMEOUT_MS)) && Number(env.MAIN_HTML_EXPORT_TIMEOUT_MS) > 0
      ? Math.floor(Number(env.MAIN_HTML_EXPORT_TIMEOUT_MS))
      : DEFAULT_MAIN_HTML_TIMEOUT_MS;
  const startedAt = nowIso(options.now);

  return withExportLock(abs, async () => {
    const temps = [];
    const attempt = (await previousAttempt(paths)) + 1;
    const recordFailure = async (error, extra = {}) => {
      const result = failedResult({
        error,
        attempt,
        mainPath: paths.mainPath,
        htmlPath: paths.htmlPath,
        metaPath: paths.metaPath,
        inputSha256: extra.inputSha256 || null,
        timedOut: extra.timedOut === true,
      });
      try {
        await writeLedger(paths, {
          version: MAIN_HTML_META_VERSION,
          producer: MAIN_HTML_PRODUCER,
          ok: false,
          status: "failed",
          sessionDir: abs,
          mainPath: paths.mainPath,
          htmlPath: paths.htmlPath,
          metaPath: paths.metaPath,
          inputSha256: extra.inputSha256 || null,
          outputSha256: null,
          bytes: null,
          attempt,
          error: result.error,
          timedOut: extra.timedOut === true,
          exitCode: extra.exitCode ?? null,
          signal: extra.signal ?? null,
          stderr: truncateText(extra.stderr),
          stdout: truncateText(extra.stdout),
          command: extra.command || null,
          startedAt,
          finishedAt: nowIso(options.now),
        });
      } catch {
        // Keep the structured failure even if the debug ledger cannot be written.
      }
      return result;
    };

    try {
      const main = await inspectSessionPath(abs, paths.mainPath, "analysis/main.md");
      await mkdir(join(abs, "analysis"), { recursive: true });
      await mkdir(join(abs, "debug"), { recursive: true });
      await inspectSessionPath(abs, join(abs, "analysis"), "analysis", { mustExist: true, asFile: false });
      await inspectSessionPath(abs, join(abs, "debug"), "debug", { mustExist: true, asFile: false });

      const existingHtml = await lstatOrNull(paths.htmlPath);
      if (existingHtml?.isSymbolicLink()) {
        return recordFailure("analysis/main.html must not be a symbolic link");
      }
      if (existingHtml && !existingHtml.isFile()) {
        return recordFailure("analysis/main.html must be a regular file");
      }
      const existingMeta = await lstatOrNull(paths.metaPath);
      if (existingMeta?.isSymbolicLink()) {
        return recordFailure("analysis/main.html.meta.json must not be a symbolic link");
      }

      const markdown = await readFile(main.path);
      const inputSha256 = sha256Buffer(markdown);
      const receipt = await currentHtmlReceipt(paths, inputSha256);
      if (receipt) {
        return successResult({
          status: "up_to_date",
          mainPath: paths.mainPath,
          htmlPath: paths.htmlPath,
          metaPath: paths.metaPath,
          inputSha256,
          outputSha256: receipt.outputSha256,
          bytes: receipt.bytes,
          attempt: receipt.attempt,
        });
      }

      const stamp = `${process.pid}.${randomUUID()}`;
      const snapshotPath = join(abs, "analysis", `.main.md.${stamp}.export-src.md`);
      const tempHtmlPath = join(abs, "analysis", `.main.html.${stamp}.export-out.html`);
      const workDir = join(abs, "debug", `.md2html-cwd.${stamp}`);
      temps.push(snapshotPath, tempHtmlPath, workDir);
      await writeFile(snapshotPath, markdown);
      await inspectSessionPath(abs, snapshotPath, "main.md snapshot");
      await mkdir(workDir, { recursive: true });
      await inspectSessionPath(abs, workDir, "md2html cwd", { mustExist: true, asFile: false });

      const args = [snapshotPath, "-o", tempHtmlPath, "--theme", MAIN_HTML_THEME, "--renderer", MAIN_HTML_RENDERER];
      const child = await runMd2html(md2htmlCommand, args, {
        cwd: workDir,
        env,
        timeoutMs,
        spawnImpl,
      });
      if (child.timedOut) {
        return recordFailure(`md2html timed out after ${timeoutMs}ms`, {
          inputSha256,
          timedOut: true,
          command: [md2htmlCommand, ...args],
          stderr: child.stderr,
          stdout: child.stdout,
          signal: child.signal,
        });
      }
      if (child.error || child.status !== 0) {
        const reason = child.error
          ? `md2html failed to start: ${child.error}`
          : `md2html exited ${child.status}${child.stderr ? `: ${truncateText(child.stderr, 500)}` : ""}`;
        return recordFailure(reason, {
          inputSha256,
          command: [md2htmlCommand, ...args],
          exitCode: child.status,
          signal: child.signal,
          stderr: child.stderr,
          stdout: child.stdout,
        });
      }

      const tempHtml = await inspectSessionPath(abs, tempHtmlPath, "temporary HTML");
      const htmlBytes = await readFile(tempHtml.path);
      if (!htmlBytes.length) {
        return recordFailure("md2html produced an empty HTML file", { inputSha256, command: [md2htmlCommand, ...args] });
      }
      const outputSha256 = sha256Buffer(htmlBytes);
      await rename(tempHtml.path, paths.htmlPath);
      await inspectSessionPath(abs, paths.htmlPath, "analysis/main.html");

      const meta = {
        version: MAIN_HTML_META_VERSION,
        producer: MAIN_HTML_PRODUCER,
        sessionDir: abs,
        mainPath: paths.mainPath,
        htmlPath: paths.htmlPath,
        inputSha256,
        outputSha256,
        bytes: htmlBytes.length,
        theme: MAIN_HTML_THEME,
        renderer: MAIN_HTML_RENDERER,
        attempt,
        generatedAt: nowIso(options.now),
      };
      await atomicWrite(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
      await inspectSessionPath(abs, paths.metaPath, "analysis/main.html.meta.json");
      await writeLedger(paths, {
        version: MAIN_HTML_META_VERSION,
        producer: MAIN_HTML_PRODUCER,
        ok: true,
        status: "generated",
        sessionDir: abs,
        mainPath: paths.mainPath,
        htmlPath: paths.htmlPath,
        metaPath: paths.metaPath,
        inputSha256,
        outputSha256,
        bytes: htmlBytes.length,
        attempt,
        error: null,
        timedOut: false,
        command: [md2htmlCommand, ...args],
        startedAt,
        finishedAt: nowIso(options.now),
      });
      return successResult({
        status: "generated",
        mainPath: paths.mainPath,
        htmlPath: paths.htmlPath,
        metaPath: paths.metaPath,
        inputSha256,
        outputSha256,
        bytes: htmlBytes.length,
        attempt,
      });
    } catch (error) {
      return recordFailure(error instanceof Error ? error.message : String(error));
    } finally {
      for (const path of temps) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, {
    lockWaitMs: options.lockWaitMs,
    lockStaleMs: options.lockStaleMs,
  });
}

export async function runCli() {

  if (argv.length !== 2 || argv[0] !== "--session-dir" || !argv[1]) {
    process.stderr.write("usage: export-main-html.mjs --session-dir <absolute SESSION>\n");
    process.exit(2);
  }
  if (!isAbsolute(argv[1])) {
    process.stderr.write("--session-dir must be an absolute path\n");
    process.exit(2);
  }
  try {
    const output = await exportMainHtml(argv[1]);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(output.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
