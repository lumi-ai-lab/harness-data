import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildConfirmPayload,
  buildPageConfirmPayload,
  buildPageRequestBody,
  buildRequestBody,
  buildServerArgs,
  headlessConfirm,
} from "../scripts/headless-confirm.mjs";
import { fixedRecommendations } from "../scripts/seed-debug-recommendations.mjs";

const root = resolve(new URL("../../../../../", import.meta.url).pathname);
const script = join(root, ".agents/pi/skills/html-report/scripts/headless-confirm.mjs");
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    }
    return true;
  }
}

async function fakeCli(t, exitCode = 0) {
  const dir = await mkdtemp(join(tmpdir(), "headless-confirm-cli-"));
  const path = join(dir, "qdm-indicators-cli");
  const log = join(dir, "calls.jsonl");
  await writeFile(path, [
    "#!/usr/bin/env node",
    'const { appendFileSync } = await import("node:fs");',
    'appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);',
    exitCode ? 'process.stderr.write("simulated Indicators failure\\n");' : 'process.stdout.write("{}");',
    `process.exit(${exitCode});`,
  ].join("\n"));
  await chmod(path, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { path, log };
}

async function fixture(t, label) {
  const sessionId = `headless-${label}-${process.pid}-${Date.now()}`;
  const dir = join(root, ".harness/state/html-report", sessionId);
  const recommendationsPath = join(dir, "recommendations.json");
  const recommendations = fixedRecommendations({ sessionId, now: new Date(2026, 6, 25) });
  await mkdir(dir, { recursive: true });
  await writeFile(recommendationsPath, `${JSON.stringify(recommendations, null, 2)}\n`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { sessionId, dir, recommendationsPath };
}

test("pure builders create HTML-equivalent requestBody without bypass flags", () => {
  const card = {
    id: "c1", title: "销售额", analysisFocus: "分析", chartType: "table",
    indicatorFieldList: ["saleAmt"], aggDimUniqueCodeList: ["incDate"],
    startDate: "2026-07-01", endDate: "2026-07-24", storeCollectType: 2,
    filters: [
      { type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] },
      { type: "MEASURE", dimUniqueCode: "saleAmt", operator: ">", operatorValue: 100 },
    ],
  };
  const body = buildRequestBody(card);
  assert.deepEqual(body.filterDimUniqueCodeList, [
    { type: "DIMENSION", dimUniqueCode: "storeId", dimFieldIdList: ["101001"] },
    { type: "MEASURE", dimUniqueCode: "saleAmt", mathematicalOperator: { operator: ">", operatorValue: 100 } },
  ]);
  assert.equal(body.pageSize, 500);
  const payload = buildConfirmPayload({ version: 1, mode: "free", cards: [card] });
  assert.equal(Object.hasOwn(payload, "already_validated"), false);
  assert.equal(Object.hasOwn(payload, "skip_validate"), false);
  assert.equal(buildServerArgs({ recommendationsPath: "/tmp/r.json", sessionId: "s", serverScript: "/tmp/server.mjs" }).includes("--open"), false);
});

test("page builder derives the same default orderBy from loaded metadata without changing HTTP semantics", () => {
  const card = {
    id: "c1", title: "销售额", analysisFocus: "分析", chartType: "table",
    indicatorFieldList: ["saleAmt"], aggDimUniqueCodeList: ["incDate"],
    startDate: "2026-07-01", endDate: "2026-07-24", storeCollectType: 2,
    filters: [{ type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] }],
    orderBy: "推荐文件中的值不应覆盖页面派生值 DESC",
  };
  const metadata = {
    dimensions: [
      { dimUniqueCode: "incDate", dimName: "日维度", dimGroupCode: "dim_date_group" },
      { dimUniqueCode: "storeId", dimName: "门店", dimGroupCode: "dim_store_group" },
    ],
    indicators: [{ indicatorsCodeEn: "saleAmt", indicatorsName: "销售额" }],
  };

  assert.equal(buildRequestBody(card).orderBy, "推荐文件中的值不应覆盖页面派生值 DESC");
  assert.equal(buildPageRequestBody(card, metadata).orderBy, "日维度 ASC");

  const nonDate = { ...card, aggDimUniqueCodeList: ["storeId"] };
  assert.equal(buildPageRequestBody(nonDate, metadata).orderBy, "销售额 DESC");

  const payload = buildPageConfirmPayload({ version: 1, mode: "free", cards: [card] }, metadata);
  assert.equal(payload.cards[0].requestBody.orderBy, "日维度 ASC");
});

test("dependencies are injectable before server startup", async () => {
  let spawned = false;
  await assert.rejects(headlessConfirm({
    recommendationsPath: "/tmp/injected.json",
    sessionId: "injected",
    dependencies: {
      readFile: async () => "not-json",
      spawn: () => { spawned = true; throw new Error("unexpected spawn"); },
    },
  }), (error) => {
    assert.equal(error.classification, "PRODUCT_CONTRACT");
    assert.equal(error.code, "A_CONFIRM_RECOMMENDATIONS_INVALID");
    assert.match(error.message, /cannot read or validate recommendations\.json/);
    return true;
  });
  assert.equal(spawned, false);
});

test("server startup failures are classified as TEST_HARNESS", async (t) => {
  const f = await fixture(t, "server-failure");
  await assert.rejects(headlessConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    dependencies: {
      spawn: () => { throw new Error("simulated spawn failure"); },
    },
  }), (error) => {
    assert.equal(error.classification, "TEST_HARNESS");
    assert.equal(error.code, "A_CONFIRM_SERVER_FAILED");
    return true;
  });
});

test("one total deadline covers cumulative startup, confirmation, and shutdown", async (t) => {
  const f = await fixture(t, "deadline");
  const child = new FakeProcess();
  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body); },
  });
  const delayedResponse = (body, delayMs, signal) => new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => resolvePromise(jsonResponse(body)), delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const started = Date.now();
  await assert.rejects(headlessConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    startupTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    totalTimeoutMs: 80,
    dependencies: {
      spawn: () => {
        queueMicrotask(() => child.stdout.write("http://127.0.0.1:45678/\n"));
        return child;
      },
      fetch: (url, options = {}) => url.endsWith("healthz")
        ? delayedResponse({ status: "ok" }, 45, options.signal)
        : delayedResponse({ ok: true, status: "confirmed" }, 1_000, options.signal),
    },
  }), (error) => {
    assert.equal(error.classification, "PERFORMANCE_REGRESSION");
    assert.equal(error.code, "A_CONFIRM_DEADLINE_EXCEEDED");
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 60, `deadline fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 250, `per-step timeouts accumulated: ${elapsed}ms`);
  assert.ok(child.kills.includes("SIGTERM"));
});

test("successful HTTP confirmation still fails when shutdown crosses the total deadline", async (t) => {
  const f = await fixture(t, "shutdown-deadline");
  const child = new FakeProcess();
  const payload = buildConfirmPayload(fixedRecommendations({
    sessionId: f.sessionId,
    now: new Date(2026, 6, 25),
  }));
  const resultPath = join(f.dir, "result.json");
  const result = {
    ...payload,
    session_id: f.sessionId,
    result_path: resultPath,
    recommendations_path: f.recommendationsPath,
    already_validated: false,
    validation: payload.cards.map((card) => ({ ok: true, cardId: card.id })),
  };
  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body); },
  });
  const delayedShutdown = (signal) => new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => resolvePromise(jsonResponse({ ok: true })), 1_000);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const started = Date.now();
  await assert.rejects(headlessConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    startupTimeoutMs: 1_000,
    confirmTimeoutMs: 1_000,
    totalTimeoutMs: 80,
    dependencies: {
      spawn: () => {
        queueMicrotask(() => child.stdout.write("http://127.0.0.1:45678/\n"));
        return child;
      },
      readFile: async (path, encoding) => path === resultPath
        ? JSON.stringify(result)
        : readFile(path, encoding),
      fetch: (url, options = {}) => {
        if (url.endsWith("healthz")) return Promise.resolve(jsonResponse({ status: "ok" }));
        if (url.endsWith("harness/confirm")) {
          return Promise.resolve(jsonResponse({ ok: true, status: "confirmed" }));
        }
        if (url.endsWith("harness/result")) return Promise.resolve(jsonResponse(result));
        if (url.endsWith("harness/shutdown")) return delayedShutdown(options.signal);
        throw new Error(`unexpected URL: ${url}`);
      },
      checkSessionLayout: async () => ({ ok: true, errors: [] }),
    },
  }), (error) => {
    assert.equal(error.classification, "PERFORMANCE_REGRESSION");
    assert.equal(error.code, "A_CONFIRM_DEADLINE_EXCEEDED");
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 60, `deadline fired too early: ${elapsed}ms`);
  assert.ok(elapsed < 250, `shutdown exceeded the single deadline: ${elapsed}ms`);
  assert.ok(child.kills.includes("SIGTERM"));
});

test("success runs one server-side CLI smoke, verifies layout and shuts down", async (t) => {
  const f = await fixture(t, "ok");
  const cli = await fakeCli(t);
  const result = await headlessConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    env: { ...process.env, QDM_INDICATORS_CLI: cli.path, QDM_INDICATORS_TOKEN: "test", FAKE_CLI_LOG: cli.log },
    startupTimeoutMs: 10000,
    confirmTimeoutMs: 10000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.layout.ok, true);
  const persisted = JSON.parse(await readFile(result.resultPath, "utf8"));
  assert.equal(persisted.session_id, f.sessionId);
  assert.equal(persisted.already_validated, false);
  assert.equal(Object.hasOwn(persisted, "skip_validate"), false);
  const calls = (await readFile(cli.log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["analysis", "execute"]);
  assert.equal(await exists(join(f.dir, "server-meta.json")), false);
});

test("CLI failure is not retried and server still shuts down", async (t) => {
  const f = await fixture(t, "fail");
  const cli = await fakeCli(t, 1);
  await assert.rejects(headlessConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    env: { ...process.env, QDM_INDICATORS_CLI: cli.path, QDM_INDICATORS_TOKEN: "test", FAKE_CLI_LOG: cli.log },
    startupTimeoutMs: 10000,
    confirmTimeoutMs: 10000,
  }), (error) => {
    assert.equal(error.classification, "INFRASTRUCTURE");
    assert.equal(error.code, "A_CONFIRM_INDICATORS_FAILED");
    assert.match(error.message, /HTTP 422: simulated Indicators failure/);
    return true;
  });
  assert.equal(await exists(join(f.dir, "result.json")), false);
  assert.equal(await exists(join(f.dir, "server-meta.json")), false);
  assert.equal((await readFile(cli.log, "utf8")).trim().split("\n").length, 1);
});

test("an invalid phase=a layout is classified as PRODUCT_CONTRACT", async (t) => {
  const f = await fixture(t, "layout-invalid");
  const cli = await fakeCli(t);
  await assert.rejects(headlessConfirm({
    recommendationsPath: f.recommendationsPath,
    sessionId: f.sessionId,
    env: { ...process.env, QDM_INDICATORS_CLI: cli.path, QDM_INDICATORS_TOKEN: "test", FAKE_CLI_LOG: cli.log },
    dependencies: {
      checkSessionLayout: async () => ({ ok: false, errors: ["simulated layout mismatch"] }),
    },
  }), (error) => {
    assert.equal(error.classification, "PRODUCT_CONTRACT");
    assert.equal(error.code, "A_CONFIRM_LAYOUT_INVALID");
    return true;
  });
  assert.equal(await exists(join(f.dir, "server-meta.json")), false);
});

test("CLI prints verified JSON result", async (t) => {
  const f = await fixture(t, "cli");
  const cli = await fakeCli(t);
  const out = spawnSync(process.execPath, [script, "--recommendations", f.recommendationsPath, "--session-id", f.sessionId, "--startup-timeout-ms", "10000", "--confirm-timeout-ms", "10000"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, QDM_INDICATORS_CLI: cli.path, QDM_INDICATORS_TOKEN: "test", FAKE_CLI_LOG: cli.log },
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  const result = JSON.parse(out.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, f.sessionId);
  assert.equal(result.layout.ok, true);
});
