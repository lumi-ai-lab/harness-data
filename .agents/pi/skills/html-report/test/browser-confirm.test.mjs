import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  assertBrowserConfirmedResult,
  browserConfirm,
  buildBrowserServerArgs,
  runSystemPlaywright,
} from "../scripts/browser-confirm.mjs";
import { buildPageConfirmPayload } from "../scripts/headless-confirm.mjs";
import { fixedRecommendations } from "../scripts/seed-debug-recommendations.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    this.finish(null, signal);
    return true;
  }

  finish(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

function fixture(label = "ok") {
  const sessionId = `browser-${label}`;
  const recommendationsPath = resolve(`/tmp/${sessionId}/recommendations.json`);
  const resultPath = join(dirname(recommendationsPath), "result.json");
  const recommendations = fixedRecommendations({
    sessionId,
    now: new Date("2026-07-25T00:00:00.000Z"),
  });
  const pageMetadata = {
    dimensions: [
      { dimUniqueCode: "bizDate", dimName: "日维度", dimGroupCode: "dim_date_group" },
      { dimUniqueCode: "storeId", dimName: "门店", dimGroupCode: "dim_store_group" },
    ],
    indicators: [
      { indicatorsCodeEn: "custNum", indicatorsName: "来客数" },
      { indicatorsCodeEn: "perCustAmt", indicatorsName: "客单价" },
      { indicatorsCodeEn: "profitLostRate", indicatorsName: "门店毛利率（分析）" },
      { indicatorsCodeEn: "profitAmt", indicatorsName: "门店毛利额" },
    ],
    loadedCardIds: recommendations.cards.map((card) => card.id),
  };
  const payload = buildPageConfirmPayload(recommendations, pageMetadata, {
    submittedAt: "2026-07-25T00:01:00.000Z",
  });
  const result = {
    ...payload,
    session_id: sessionId,
    result_path: resultPath,
    recommendations_path: recommendationsPath,
    already_validated: true,
    validation: payload.cards.map((card) => ({ ok: true, cardId: card.id })),
  };
  return { sessionId, recommendationsPath, resultPath, recommendations, pageMetadata, payload, result };
}

function injectedRun(f, overrides = {}) {
  const server = new FakeProcess();
  const calls = { spawn: [], fetch: [], browser: [], layout: [] };
  let resultReady = false;
  const dependencies = {
    async readFile(path) {
      if (path === f.recommendationsPath) return JSON.stringify(f.recommendations);
      if (path === f.resultPath && resultReady) return JSON.stringify(overrides.result || f.result);
      const error = new Error(`ENOENT: ${path}`);
      error.code = "ENOENT";
      throw error;
    },
    spawn(command, args, options) {
      calls.spawn.push({ command, args, options });
      queueMicrotask(() => server.stdout.write("http://127.0.0.1:45678/\n"));
      return server;
    },
    async fetch(url, options = {}) {
      calls.fetch.push({ url, options });
      if (url.endsWith("harness/shutdown")) {
        server.finish(0, null);
        if (overrides.shutdownError) throw new Error("shutdown connection closed");
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ status: "ok" });
    },
    async browserRunner(input) {
      calls.browser.push(input);
      if (overrides.browserError) throw new Error(overrides.browserError);
      resultReady = true;
      return overrides.browserResult || {
        ok: true,
        status: "确认成功",
        pageMetadata: f.pageMetadata,
        uiAudit: { waitingObserved: true },
      };
    },
    async checkSessionLayout(sessionDir, options) {
      calls.layout.push({ sessionDir, options });
      return overrides.layout || { ok: true, errors: [] };
    },
    sleep: async () => {},
    now: (() => {
      let value = 0;
      return () => { value += 10; return value; };
    })(),
  };
  return { server, calls, dependencies };
}

test("server arguments are foreground-only and never include --open", () => {
  const args = buildBrowserServerArgs({
    recommendationsPath: "/tmp/recommendations.json",
    sessionId: "session",
    serverScript: "/tmp/server.mjs",
  });
  assert.equal(args.includes("--open"), false);
  assert.equal(args.includes("--detach"), false);
  assert.deepEqual(args.slice(0, 5), [
    "/tmp/server.mjs",
    "--config",
    "/tmp/recommendations.json",
    "--session-id",
    "session",
  ]);
});

test("browserConfirm clicks the real page path, validates result/layout, and shuts down", async () => {
  const f = fixture();
  const injected = injectedRun(f);
  const output = await browserConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    startupTimeoutMs: 100,
    confirmTimeoutMs: 100,
    resultPollIntervalMs: 1,
    dependencies: injected.dependencies,
  });
  assert.equal(output.ok, true);
  assert.equal(output.resultPath, f.resultPath);
  assert.equal(output.cardCount, f.recommendations.cards.length);
  assert.equal(injected.calls.browser.length, 1);
  assert.deepEqual(injected.calls.browser[0], {
    url: "http://127.0.0.1:45678/",
    buttonSelector: "#confirmReportBtn",
    timeoutMs: 100,
    env: process.env,
  });
  assert.deepEqual(injected.calls.layout, [{
    sessionDir: dirname(f.recommendationsPath),
    options: { phase: "a" },
  }]);
  assert.equal(injected.calls.spawn[0].args.includes("--open"), false);
  assert.deepEqual(injected.calls.fetch.map((call) => call.url), [
    "http://127.0.0.1:45678/healthz",
    "http://127.0.0.1:45678/harness/shutdown",
  ]);
});

test("browser result contract rejects wrong session, card, and validation", () => {
  const f = fixture("contract");
  const broken = {
    ...f.result,
    session_id: "another-session",
    cards: [{ ...f.result.cards[0], requestBody: {} }],
    validation: [{ ok: false, cardId: "wrong" }],
  };
  assert.throws(
    () => assertBrowserConfirmedResult({
      result: broken,
      recommendations: f.recommendations,
      payload: f.payload,
      recommendationsPath: f.recommendationsPath,
      sessionId: f.sessionId,
    }),
    /session_id mismatch.*requestBody mismatch.*validation 1 failed.*cardId mismatch/
  );
});

test("browser result contract strictly rejects a missing or wrong page-derived orderBy", () => {
  const f = fixture("order-by");
  assert.equal(f.payload.cards[0].requestBody.orderBy, "日维度 ASC");
  for (const value of [undefined, "来客数 DESC", "日维度 DESC"]) {
    const requestBody = { ...f.result.cards[0].requestBody };
    if (value === undefined) delete requestBody.orderBy;
    else requestBody.orderBy = value;
    assert.throws(
      () => assertBrowserConfirmedResult({
        result: {
          ...f.result,
          cards: [{ ...f.result.cards[0], requestBody }],
        },
        recommendations: f.recommendations,
        payload: f.payload,
        recommendationsPath: f.recommendationsPath,
        sessionId: f.sessionId,
      }),
      /requestBody mismatch/
    );
  }
});

test("browser or layout failure still shuts down the server", async () => {
  const f = fixture("failure");
  const browserFailure = injectedRun(f, { browserError: "page button failed" });
  await assert.rejects(browserConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    startupTimeoutMs: 100,
    confirmTimeoutMs: 100,
    dependencies: browserFailure.dependencies,
  }), (error) => {
    assert.equal(error.classification, "TEST_HARNESS");
    assert.equal(error.code, "A_CONFIRM_PLAYWRIGHT_FAILED");
    assert.match(error.message, /page button failed/);
    return true;
  });
  assert.equal(browserFailure.server.exitCode, 0);
  assert.equal(browserFailure.calls.fetch.at(-1).url.endsWith("harness/shutdown"), true);

  const layoutFailure = injectedRun(f, { layout: { ok: false, errors: ["bad result"] } });
  await assert.rejects(browserConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    startupTimeoutMs: 100,
    confirmTimeoutMs: 100,
    dependencies: layoutFailure.dependencies,
  }), (error) => {
    assert.equal(error.classification, "PRODUCT_CONTRACT");
    assert.equal(error.code, "A_CONFIRM_LAYOUT_INVALID");
    return true;
  });
  assert.equal(layoutFailure.server.exitCode, 0);
});

test("browser confirmation classifies page CLI failure as INFRASTRUCTURE and invalid result as PRODUCT_CONTRACT", async () => {
  const f = fixture("classification");
  const cliFailure = injectedRun(f, {
    browserError: "headless Playwright failed: page confirmation failed: 确认失败：Indicators CLI 校验失败",
  });
  await assert.rejects(browserConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    dependencies: cliFailure.dependencies,
  }), (error) => {
    assert.equal(error.classification, "INFRASTRUCTURE");
    assert.equal(error.code, "A_CONFIRM_INDICATORS_FAILED");
    return true;
  });

  const invalidResult = injectedRun(f, {
    result: { ...f.result, session_id: "wrong-session" },
  });
  await assert.rejects(browserConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    dependencies: invalidResult.dependencies,
  }), (error) => {
    assert.equal(error.classification, "PRODUCT_CONTRACT");
    assert.equal(error.code, "A_CONFIRM_RESULT_INVALID");
    return true;
  });
});

test("browser confirmation uses one total deadline instead of cumulative step timeouts", async () => {
  const f = fixture("deadline");
  const injected = injectedRun(f);
  injected.dependencies.now = Date.now;
  injected.dependencies.browserRunner = async () => {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    return {
      ok: true,
      pageMetadata: f.pageMetadata,
      uiAudit: { waitingObserved: true },
    };
  };
  const started = Date.now();
  await assert.rejects(browserConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    startupTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    totalTimeoutMs: 80,
    dependencies: injected.dependencies,
  }), (error) => {
    assert.equal(error.classification, "PERFORMANCE_REGRESSION");
    assert.equal(error.code, "A_CONFIRM_DEADLINE_EXCEEDED");
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 60, `deadline fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 250, `per-step timeouts accumulated: ${elapsed}ms`);
  assert.ok(injected.server.kills.includes("SIGTERM"));
});

test("successful browser confirmation still fails when shutdown crosses the total deadline", async () => {
  const f = fixture("shutdown-deadline");
  const injected = injectedRun(f);
  injected.dependencies.now = Date.now;
  injected.dependencies.fetch = async (url, options = {}) => {
    injected.calls.fetch.push({ url, options });
    if (!url.endsWith("harness/shutdown")) return jsonResponse({ status: "ok" });
    return await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => resolvePromise(jsonResponse({ ok: true })), 1_000);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const started = Date.now();
  await assert.rejects(browserConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    startupTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    totalTimeoutMs: 80,
    resultPollIntervalMs: 1,
    dependencies: injected.dependencies,
  }), (error) => {
    assert.equal(error.classification, "PERFORMANCE_REGRESSION");
    assert.equal(error.code, "A_CONFIRM_DEADLINE_EXCEEDED");
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 60, `deadline fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 250, `shutdown exceeded the single deadline: ${elapsed}ms`);
  assert.equal(injected.calls.browser.length, 1);
  assert.ok(injected.server.kills.includes("SIGTERM"));
});

test("browser confirmation fails closed when page metadata, waiting state, or loaded cards are unproven", async () => {
  const f = fixture("page-proof");
  const cases = [
    {
      browserResult: { ok: true, uiAudit: { waitingObserved: true } },
      pattern: /did not return page metadata/,
    },
    {
      browserResult: { ok: true, pageMetadata: f.pageMetadata, uiAudit: { waitingObserved: false } },
      pattern: /did not observe the confirmation waiting state/,
    },
    {
      browserResult: {
        ok: true,
        pageMetadata: { ...f.pageMetadata, loadedCardIds: ["wrong-card"] },
        uiAudit: { waitingObserved: true },
      },
      pattern: /did not load the expected recommendation cards/,
    },
  ];
  for (const current of cases) {
    const injected = injectedRun(f, { browserResult: current.browserResult });
    await assert.rejects(browserConfirm({
      recommendationsPath: f.recommendationsPath,
      sessionId: f.sessionId,
      startupTimeoutMs: 100,
      confirmTimeoutMs: 100,
      dependencies: injected.dependencies,
    }), (error) => {
      assert.match(error.message, current.pattern);
      const expected = current.pattern.source.includes("metadata") ? "TEST_HARNESS" : "PRODUCT_CONTRACT";
      assert.equal(error.classification, expected);
      return true;
    });
    assert.equal(injected.server.exitCode, 0);
  }
});

test("system Playwright runner derives CLI interpreter and forces headless mode", async () => {
  const child = new FakeProcess();
  const calls = [];
  const output = await runSystemPlaywright({
    url: "http://127.0.0.1:45678/",
    timeoutMs: 100,
    playwrightBin: "/opt/homebrew/bin/playwright",
    env: { PATH: "/opt/homebrew/bin" },
    dependencies: {
      access: async () => {},
      readFile: async () => "#!/opt/homebrew/bin/python3.14\n",
      spawn(command, args, options) {
        calls.push({ command, args, options });
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({
            ok: true,
            status: "确认成功",
            pageMetadata: { dimensions: [], indicators: [], loadedCardIds: [] },
            uiAudit: { waitingObserved: true },
          })}\n`);
          child.finish(0, null);
        });
        return child;
      },
    },
  });
  assert.equal(output.ok, true);
  assert.equal(calls[0].command, "/opt/homebrew/bin/python3.14");
  assert.equal(calls[0].args[0], "-c");
  assert.match(calls[0].args[1], /launch\(headless=True\)/);
  assert.match(calls[0].args[1], /confirmReportBtn/);
  assert.match(calls[0].args[1], /dimGroupCode/);
  assert.match(calls[0].args[1], /waitingObserved/);
  assert.equal(calls[0].args.includes("http://127.0.0.1:45678/"), true);
  assert.equal(calls[0].options.shell, false);
});

test("module never sends confirmation HTTP directly", async () => {
  const source = await readFile(new URL("../scripts/browser-confirm.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("harness/confirm"), false);
  assert.equal(source.includes("harness/shutdown"), true);
});
