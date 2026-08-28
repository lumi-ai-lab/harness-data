/** Confirm recommendations through the real page with a headless Playwright browser. */
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  DEFAULT_SERVER_SCRIPT,
  ConfirmationFailure,
  assertValidRecommendations,
  buildPageConfirmPayload,
  buildServerArgs,
  confirmationDeadline,
  confirmationFailure,
  withinConfirmationDeadline,
} from "./headless-confirm.mjs";
import { checkSessionLayout } from "./check-session-layout.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const BUTTON_SELECTOR = "#confirmReportBtn";

export function buildBrowserServerArgs(options) {
  const args = buildServerArgs(options);
  if (args.includes("--open") || args.includes("--detach")) {
    throw new Error("browser confirmation server must stay foreground and must not use --open");
  }
  return args;
}

async function executablePath(command, env, accessImpl) {
  if (isAbsolute(command)) {
    await accessImpl(command, fsConstants.X_OK);
    return command;
  }
  for (const directory of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      await accessImpl(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`cannot find system Playwright CLI: ${command}`);
}

function collectProcess(child, timeoutMs, setTimer, clearTimer) {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimer(() => {
      child.kill("SIGTERM");
      finish(new Error(`headless Playwright timed out after ${timeoutMs}ms; ${stderr.trim()}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20000); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code !== 0) {
        finish(new Error(`headless Playwright failed: code=${code} signal=${signal}; ${stderr.trim()}`));
      } else {
        finish(null, { stdout, stderr, code, signal });
      }
    });
  });
}

const pythonProgram = String.raw`
import json
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1]
timeout_ms = int(sys.argv[2])
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("dialog", lambda dialog: dialog.accept())
        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        page.wait_for_function("""() => {
          const status = document.querySelector('#loadStatus')?.textContent || '';
          return /(加载完成|加载失败)/.test(status);
        }""", timeout=timeout_ms)
        load_status = page.locator("#loadStatus").inner_text()
        if "加载完成" not in load_status:
            raise RuntimeError(f"page metadata load failed: {load_status}")
        button = page.locator("#confirmReportBtn")
        button.wait_for(state="visible", timeout=timeout_ms)
        page.wait_for_function("""() => {
          const button = document.querySelector('#confirmReportBtn');
          return button && !button.disabled;
        }""", timeout=timeout_ms)
        page_metadata = page.evaluate("""() => ({
          dimensions: Object.values(state.dimensionMap || {}).map((item) => ({
            dimUniqueCode: item.dimUniqueCode || '',
            dimName: item.dimName || '',
            dimGroupCode: item.dimGroupCode || '',
          })),
          indicators: flattenIndicators().map((item) => ({
            indicatorsCodeEn: item.indicatorsCodeEn || '',
            indicatorsName: item.indicatorsName || '',
          })),
          loadedCardIds: (state.cards || []).map((card) => card.id || ''),
        })""")
        page.evaluate("""() => {
          const audit = { statuses: [], buttons: [] };
          const capture = () => {
            const status = document.querySelector('#confirmStatus')?.textContent || '';
            const button = document.querySelector('#confirmReportBtn');
            if (status && audit.statuses[audit.statuses.length - 1] !== status) {
              audit.statuses.push(status);
            }
            if (button) {
              const snapshot = { text: button.textContent || '', disabled: button.disabled };
              const last = audit.buttons[audit.buttons.length - 1];
              if (!last || last.text !== snapshot.text || last.disabled !== snapshot.disabled) {
                audit.buttons.push(snapshot);
              }
            }
          };
          window.__htmlReportConfirmAudit = audit;
          window.__htmlReportConfirmObserver = new MutationObserver(capture);
          window.__htmlReportConfirmObserver.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['disabled', 'class'],
          });
          capture();
        }""")
        button.click(timeout=timeout_ms)
        page.wait_for_function("""() => {
          const status = document.querySelector('#confirmStatus')?.textContent || '';
          const errorBox = document.querySelector('#confirmErrorBox');
          const failed = /(失败|中断|无法确认|已取消)/.test(status) || errorBox?.classList.contains('show');
          const passed = /(确认成功|确认完成|已写入|报告已锁定)/.test(status);
          return failed || passed;
        }""", timeout=timeout_ms)
        status = page.locator("#confirmStatus").inner_text()
        error_box = page.locator("#confirmErrorBox").inner_text()
        if not any(word in status for word in ["确认成功", "确认完成", "已写入", "报告已锁定"]):
            raise RuntimeError(f"page confirmation failed: {status}; {error_box}")
        ui_audit = page.evaluate("""() => window.__htmlReportConfirmAudit || {statuses: [], buttons: []}""")
        statuses = ui_audit.get("statuses", [])
        buttons = ui_audit.get("buttons", [])
        ui_audit["waitingObserved"] = (
            any(any(marker in value for marker in ["开始确认", "正在校验 CLI", "正在写入"]) for value in statuses)
            and any(item.get("disabled") and item.get("text") == "确认中..." for item in buttons)
        )
        print(json.dumps({
            "ok": True,
            "status": status,
            "loadStatus": load_status,
            "pageMetadata": page_metadata,
            "uiAudit": ui_audit,
        }, ensure_ascii=False))
    finally:
        browser.close()
`;

/**
 * Use the Python interpreter behind the installed `playwright` CLI so the
 * automation uses that exact system Playwright installation.
 */
export async function runSystemPlaywright({
  url,
  timeoutMs,
  playwrightBin = process.env.HTML_REPORT_PLAYWRIGHT_CLI || "playwright",
  playwrightPython = process.env.HTML_REPORT_PLAYWRIGHT_PYTHON || "",
  env = process.env,
  dependencies = {},
}) {
  const accessImpl = dependencies.access || access;
  const readFileImpl = dependencies.readFile || readFile;
  const spawnImpl = dependencies.spawn || spawn;
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  const cliPath = await executablePath(playwrightBin, env, accessImpl);
  let python = playwrightPython;
  if (!python) {
    const firstLine = (await readFileImpl(cliPath, "utf8")).split("\n", 1)[0];
    const match = firstLine.match(/^#!\s*(\S+)/);
    if (!match) throw new Error(`Playwright CLI does not expose a Python shebang: ${cliPath}`);
    python = match[1];
  }
  const child = spawnImpl(python, ["-c", pythonProgram, url, String(timeoutMs)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const result = await collectProcess(child, timeoutMs, setTimer, clearTimer);
  let output;
  try {
    output = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`headless Playwright returned invalid JSON: ${result.stdout.slice(0, 500)}`);
  }
  if (output?.ok !== true) throw new Error("headless Playwright did not confirm the page");
  if (!Array.isArray(output?.pageMetadata?.dimensions) || !Array.isArray(output?.pageMetadata?.indicators)) {
    throw new Error("headless Playwright did not return page metadata");
  }
  if (output?.uiAudit?.waitingObserved !== true) {
    throw new Error("headless Playwright did not observe the confirmation waiting state");
  }
  return output;
}

async function startServer({ recommendationsPath, sessionId, serverScript, env, timeoutMs, spawnImpl }) {
  const args = buildBrowserServerArgs({ recommendationsPath, sessionId, serverScript });
  const child = spawnImpl(process.execPath, args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`server startup timed out after ${timeoutMs}ms; ${stderr.trim()}`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20000); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(new Error(`server exited before ready: code=${code} signal=${signal}; ${stderr.trim()}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const url = stdout.slice(0, newline).trim();
      if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) {
        child.kill("SIGTERM");
        finish(new Error(`server returned invalid URL: ${url}`));
      } else {
        finish(null, { child, url, args });
      }
    });
  });
}

async function responseJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 500)}`);
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolvePromise) => {
    const done = (value) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise(value);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function shutdownServer(server, fetchImpl, deadline) {
  if (!server) return { ok: true, deadlineExceeded: false };
  let deadlineExceeded = deadline?.expired() === true;
  const remaining = (cap) => deadline ? deadline.remaining(cap) : cap;
  const httpMs = remaining(5_000);
  if (httpMs > 0) {
    try {
      await responseJson(fetchImpl, `${server.url}harness/shutdown`, { method: "POST" }, httpMs);
    } catch {
      // Signal fallback below.
    }
  } else {
    deadlineExceeded = true;
  }
  let waitMs = remaining(5_000);
  if (waitMs > 0 && await waitExit(server.child, waitMs)) {
    return { ok: true, deadlineExceeded };
  }
  if (waitMs <= 0) deadlineExceeded = true;
  server.child.kill("SIGTERM");
  waitMs = remaining(2_000);
  if (waitMs > 0 && await waitExit(server.child, waitMs)) {
    return { ok: true, deadlineExceeded };
  }
  if (waitMs <= 0) deadlineExceeded = true;
  server.child.kill("SIGKILL");
  waitMs = remaining(2_000);
  const exited = waitMs > 0 ? await waitExit(server.child, waitMs) : false;
  if (waitMs <= 0) deadlineExceeded = true;
  return { ok: exited || server.child.exitCode !== null || server.child.signalCode !== null, deadlineExceeded };
}

async function waitForResult(path, readFileImpl, timeoutMs, pollIntervalMs, sleep, now) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() <= deadline) {
    try {
      return JSON.parse(await readFileImpl(path, "utf8"));
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }
  throw new Error(`result.json was not created within ${timeoutMs}ms: ${lastError?.message || lastError}`);
}

export function assertBrowserConfirmedResult({ result, recommendations, payload, recommendationsPath, sessionId }) {
  const configPath = resolve(recommendationsPath);
  const resultPath = join(dirname(configPath), "result.json");
  const cards = Array.isArray(result?.cards) ? result.cards : [];
  const validation = Array.isArray(result?.validation) ? result.validation : [];
  const errors = [];
  if (result?.status !== "confirmed") errors.push("status must be confirmed");
  if (result?.session_id !== sessionId) errors.push("session_id mismatch");
  if (result?.result_path !== resultPath) errors.push("result_path mismatch");
  if (result?.recommendations_path !== configPath) errors.push("recommendations_path mismatch");
  if (result?.already_validated !== true) errors.push("browser confirmation must persist page validation");
  if (cards.length !== recommendations.cards.length) errors.push("card count mismatch");
  cards.forEach((card, index) => {
    const expected = payload.cards[index];
    for (const key of [
      "id",
      "title",
      "headingLevel",
      "analysisFocus",
      "chartType",
      "storeCollectType",
      "aggDimUniqueCodeList",
      "columnAggDimUniqueCodeList",
      "indicatorFieldList",
      "startDate",
      "endDate",
    ]) {
      if (!isDeepStrictEqual(card?.[key], expected?.[key])) {
        errors.push(`card ${card?.id || index + 1} ${key} mismatch`);
      }
    }
    if (!isDeepStrictEqual(card?.requestBody, expected?.requestBody)) {
      errors.push(`card ${card?.id || index + 1} requestBody mismatch`);
    }
  });
  if (validation.length !== cards.length) errors.push("validation count mismatch");
  validation.forEach((item, index) => {
    if (item?.ok !== true) errors.push(`validation ${index + 1} failed`);
    if (item?.cardId !== cards[index]?.id) errors.push(`validation ${index + 1} cardId mismatch`);
  });
  if (errors.length) throw new Error(`invalid browser-confirmed result: ${errors.join("; ")}`);
  return { resultPath, cardCount: cards.length, validationCount: validation.length };
}

export async function browserConfirm({
  recommendationsPath,
  sessionId,
  serverScript = DEFAULT_SERVER_SCRIPT,
  env = process.env,
  startupTimeoutMs = 60_000,
  confirmTimeoutMs = 180_000,
  totalTimeoutMs = null,
  resultPollIntervalMs = 250,
  dependencies = {},
} = {}) {
  if (!recommendationsPath) throw new Error("recommendationsPath is required");
  if (!String(sessionId || "").trim()) throw new Error("sessionId is required");
  const configPath = resolve(recommendationsPath);
  const resultPath = join(dirname(configPath), "result.json");
  const readFileImpl = dependencies.readFile || readFile;
  const spawnImpl = dependencies.spawn || spawn;
  const fetchImpl = dependencies.fetch || fetch;
  const browserRunner = dependencies.browserRunner || runSystemPlaywright;
  const checkLayout = dependencies.checkSessionLayout || checkSessionLayout;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
  const now = dependencies.now || Date.now;
  const deadline = confirmationDeadline(totalTimeoutMs, now);
  let recommendations;
  try {
    recommendations = JSON.parse(await withinConfirmationDeadline(
      "read recommendations.json",
      deadline,
      startupTimeoutMs,
      () => readFileImpl(configPath, "utf8")
    ));
    assertValidRecommendations(recommendations, sessionId);
  } catch (cause) {
    if (cause instanceof ConfirmationFailure) throw cause;
    throw confirmationFailure(
      "PRODUCT_CONTRACT",
      "A_CONFIRM_RECOMMENDATIONS_INVALID",
      `cannot read or validate recommendations.json: ${cause.message || cause}`,
      cause
    );
  }
  let server;
  let completed = false;
  try {
    try {
      server = await withinConfirmationDeadline(
        "server startup",
        deadline,
        startupTimeoutMs,
        () => startServer({
          recommendationsPath: configPath,
          sessionId,
          serverScript,
          env,
          timeoutMs: deadline.remaining(startupTimeoutMs),
          spawnImpl,
        })
      );
      await withinConfirmationDeadline(
        "server health check",
        deadline,
        startupTimeoutMs,
        () => responseJson(
          fetchImpl,
          `${server.url}healthz`,
          { cache: "no-store" },
          deadline.remaining(startupTimeoutMs)
        )
      );
    } catch (cause) {
      if (cause instanceof ConfirmationFailure) throw cause;
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_SERVER_FAILED",
        `local confirmation server failed: ${cause.message || cause}`,
        cause
      );
    }

    let browser;
    try {
      browser = await withinConfirmationDeadline(
        "headless Playwright confirmation",
        deadline,
        confirmTimeoutMs,
        () => browserRunner({
          url: server.url,
          buttonSelector: BUTTON_SELECTOR,
          timeoutMs: deadline.remaining(confirmTimeoutMs),
          env,
        })
      );
    } catch (cause) {
      if (cause instanceof ConfirmationFailure) throw cause;
      const message = String(cause?.message || cause);
      if (/page metadata load failed/i.test(message) || /page confirmation failed:.*(?:CLI|Indicators|认证|超时|timeout)/is.test(message)) {
        throw confirmationFailure(
          "INFRASTRUCTURE",
          "A_CONFIRM_INDICATORS_FAILED",
          `Indicators-backed page confirmation failed: ${message}`,
          cause
        );
      }
      if (/page confirmation failed:/i.test(message)) {
        throw confirmationFailure(
          "PRODUCT_CONTRACT",
          "A_CONFIRM_PAGE_REJECTED",
          message,
          cause
        );
      }
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_PLAYWRIGHT_FAILED",
        `headless Playwright failed: ${message}`,
        cause
      );
    }
    if (browser?.ok !== true) {
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_PLAYWRIGHT_FAILED",
        "headless browser did not confirm the page"
      );
    }
    if (!Array.isArray(browser?.pageMetadata?.dimensions) || !Array.isArray(browser?.pageMetadata?.indicators)) {
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_PLAYWRIGHT_OUTPUT_INVALID",
        "headless browser did not return page metadata"
      );
    }
    if (browser?.uiAudit?.waitingObserved !== true) {
      throw confirmationFailure(
        "PRODUCT_CONTRACT",
        "A_CONFIRM_WAITING_STATE_MISSING",
        "headless browser did not observe the confirmation waiting state"
      );
    }
    const expectedCardIds = recommendations.cards.map((card, index) =>
      String(card?.id || `card_${String(index + 1).padStart(3, "0")}`)
    );
    if (!isDeepStrictEqual(browser.pageMetadata.loadedCardIds, expectedCardIds)) {
      throw confirmationFailure(
        "PRODUCT_CONTRACT",
        "A_CONFIRM_PAGE_CARDS_MISMATCH",
        "headless browser did not load the expected recommendation cards"
      );
    }
    let payload;
    let contract;
    try {
      payload = buildPageConfirmPayload(recommendations, browser.pageMetadata);
      const result = await withinConfirmationDeadline(
        "read browser-confirmed result.json",
        deadline,
        confirmTimeoutMs,
        () => waitForResult(
          resultPath,
          readFileImpl,
          deadline.remaining(confirmTimeoutMs),
          resultPollIntervalMs,
          sleep,
          now
        )
      );
      contract = assertBrowserConfirmedResult({
        result,
        recommendations,
        payload,
        recommendationsPath: configPath,
        sessionId,
      });
    } catch (cause) {
      if (cause instanceof ConfirmationFailure) throw cause;
      throw confirmationFailure(
        "PRODUCT_CONTRACT",
        "A_CONFIRM_RESULT_INVALID",
        `invalid browser-confirmed result: ${cause.message || cause}`,
        cause
      );
    }

    let layout;
    try {
      layout = await withinConfirmationDeadline(
        "phase=a layout",
        deadline,
        confirmTimeoutMs,
        () => checkLayout(dirname(configPath), { phase: "a" })
      );
    } catch (cause) {
      if (cause instanceof ConfirmationFailure) throw cause;
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_LAYOUT_CHECK_FAILED",
        `phase=a layout checker failed: ${cause.message || cause}`,
        cause
      );
    }
    if (!layout.ok) {
      throw confirmationFailure(
        "PRODUCT_CONTRACT",
        "A_CONFIRM_LAYOUT_INVALID",
        `phase=a layout failed: ${(layout.errors || []).join("; ")}`
      );
    }
    const output = {
      ok: true,
      sessionId,
      recommendationsPath: configPath,
      resultPath: contract.resultPath,
      cardCount: contract.cardCount,
      validationCount: contract.validationCount,
      browser,
      layout,
    };
    completed = true;
    return output;
  } finally {
    const cleanup = await shutdownServer(server, fetchImpl, deadline);
    if (completed && cleanup.deadlineExceeded) throw deadline.failure("server shutdown");
    if (completed && !cleanup.ok) {
      throw confirmationFailure(
        "TEST_HARNESS",
        "A_CONFIRM_SERVER_SHUTDOWN_FAILED",
        "local confirmation server did not exit after shutdown"
      );
    }
  }
}
