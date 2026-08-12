import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sanitizeTaskId,
  fetchExploreTask,
  isMetricTimeout,
  materialQueryDelta,
  reusableExplore,
  semanticQueryShape,
  computeQueryPatch,
  applyQueryPatch,
} from "../scripts/fetch-explore.mjs";
import { normalizeEntryPayload } from "../scripts/fetch-entry.mjs";
import {
  evidenceGapMatchesChangedKeys,
  evidenceGapTypes,
  isValidEvidenceGap,
} from "../scripts/research-contract.mjs";

function metricQuery(overrides = {}) {
  return {
    metrics: ["profitAmt"],
    statisticPolicy: "SUMMARY",
    time: { startDate: "2026-07-01", endDate: "2026-07-27" },
    dimensions: ["incDate"],
    filters: { storeId: ["101001"] },
    pageNo: 1,
    pageSize: 500,
    ...overrides,
  };
}

test("sanitizeTaskId strips unsafe chars", () => {
  assert.equal(sanitizeTaskId("drill-001"), "drill-001");
  assert.equal(sanitizeTaskId("a/b c"), "a_b_c");
  assert.equal(sanitizeTaskId(""), "task");
});

test("Metric timeout classifier recognizes ETIMEDOUT and explicit timeout failures only", () => {
  assert.equal(isMetricTimeout({ errorCode: "ETIMEDOUT" }), true);
  assert.equal(isMetricTimeout({ status: 1, stderr: "upstream request timeout exceeded" }), true);
  assert.equal(isMetricTimeout({ status: 1, stderr: "指标查询超时" }), true);
  assert.equal(isMetricTimeout({ status: 1, stderr: "connection reset" }), false);
  assert.equal(
    isMetricTimeout({ status: 0, error: "", stdout: '[{"label":"timeout"}]' }),
    false,
    "a successful data cell containing the word timeout is not a failed query"
  );
});

test("fetchExploreTask fails closed when metrics is empty (no CLI)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-"));
  const session = join(root, ".harness", "state", "html-report", "ex1");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(session, "analysis"), { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(
    resultPath,
    JSON.stringify({
      status: "confirmed",
      cards: [{ id: "c1", query: { request: metricQuery(), comparisons: [] } }],
      title: "t",
    })
  );
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 0,
    maxRounds: 2,
    tasks: [{
      id: "drill-001",
      fromCardId: "c1",
      goal: "验证空指标会失败",
      evidenceGap: { type: "missing_indicator", reason: "验证空指标会失败" },
      evidencePlan: { mode: "new_query" },
    }],
  }));

  const meta = await fetchExploreTask(resultPath, {
    taskId: "drill-001",
    payload: metricQuery({ metrics: [] }),
    goal: "empty payload should fail",
  });

  assert.equal(meta.status, "failed");
  assert.match(meta.failedMessage || meta.error || "", /query\.metrics/i);

  const metaOnDisk = JSON.parse(
    await readFile(join(session, "data", "explore", "drill-001.meta.json"), "utf8")
  );
  assert.equal(metaOnDisk.status, "failed");
  assert.equal(metaOnDisk.taskId, "drill-001");
  assert.equal(metaOnDisk.producer, "fetch-explore.mjs");
  assert.equal(metaOnDisk.pagination?.singlePage, false);
  assert.ok(Array.isArray(metaOnDisk.attempts));
});

test("normalizeEntryPayload still all-pages for explore payloads", () => {
  const p = normalizeEntryPayload(metricQuery({ pageSize: 99999, pageNo: 3 }));
  assert.equal(p.pageNo, 1);
  assert.equal(p.pageSize, 2000);
});

test("material query delta ignores ordering, pagination, and chart presentation", () => {
  const original = metricQuery({ metrics: ["custNum", "profitAmt"], orderBy: { field: "incDate", direction: "ASC" } });
  const presentationOnly = {
    ...original,
    metrics: ["profitAmt", "custNum"],
    orderBy: { field: "profitAmt", direction: "DESC" },
    pageNo: 9,
    pageSize: 50,
  };
  assert.deepEqual(materialQueryDelta(original, presentationOnly).changedKeys, []);
  assert.deepEqual(semanticQueryShape(original), semanticQueryShape(presentationOnly));
  assert.throws(() => materialQueryDelta(original, { ...presentationOnly, inventedFlag: "bypass" }), /unsupported fields/);
  for (const [key, candidate] of [
    ["metrics", { ...presentationOnly, metrics: ["profitAmt", "saleAmt"] }],
    ["dimensions", { ...presentationOnly, dimensions: ["storeId"] }],
    ["time.startDate", { ...presentationOnly, time: { ...presentationOnly.time, startDate: "2026-06-01" } }],
  ]) {
    const delta = materialQueryDelta(original, candidate);
    assert.equal(delta.material, true, `${key} should be a material query change`);
    assert.deepEqual(delta.changedKeys, [key]);
  }
});

test("evidence gap authorizes every material query change, not just one", () => {
  const gap = { type: "missing_indicator", reason: "需要补充销售额指标" };
  assert.equal(evidenceGapMatchesChangedKeys(gap, ["metrics"]), true);
  assert.equal(evidenceGapMatchesChangedKeys(gap, []), false);
  assert.equal(
    evidenceGapMatchesChangedKeys(gap, ["metrics", "time.startDate"]),
    false
  );
  const mergedGap = {
    types: ["missing_indicator", "missing_dimension"],
    reason: "一次查询同时补充销售额指标与品类维度",
  };
  assert.equal(
    evidenceGapMatchesChangedKeys(mergedGap, ["metrics", "dimensions"]),
    true
  );
  assert.equal(
    evidenceGapMatchesChangedKeys(mergedGap, ["metrics", "dimensions", "time.startDate"]),
    false
  );
  assert.equal(isValidEvidenceGap(mergedGap), true);
  assert.deepEqual(evidenceGapTypes(mergedGap), ["missing_indicator", "missing_dimension"]);
  assert.equal(
    isValidEvidenceGap({ ...mergedGap, type: "missing_indicator" }),
    false,
    "type and types[] are mutually exclusive"
  );
  assert.equal(
    isValidEvidenceGap({ types: ["missing_indicator", "missing_indicator"], reason: "重复" }),
    false
  );
});

test("material query delta treats filter order and filter value order as set-like", () => {
  const original = metricQuery({
    filters: { storeId: ["101002", "101001"], categoryLevel1Id: ["20", "10"] },
  });
  const reordered = {
    ...original,
    filters: { categoryLevel1Id: ["10", "20"], storeId: ["101001", "101002"] },
  };

  const delta = materialQueryDelta(original, reordered);
  assert.equal(delta.material, false);
  assert.deepEqual(delta.changedKeys, []);
  assert.deepEqual(semanticQueryShape(original), semanticQueryShape(reordered));
});

test("fetchExploreTask rejects orderBy-only re-query before CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-same-"));
  const session = join(root, ".harness", "state", "html-report", "ex-same");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  const original = metricQuery({
    metrics: ["custNum", "profitAmt"],
    orderBy: { field: "incDate", direction: "ASC" },
  });
  const resultPath = join(session, "result.json");
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", query: { request: original, comparisons: [] } }],
  }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: "same-query",
      fromCardId: "c1",
      goal: "验证排序变化不会触发查询",
      evidenceGap: { type: "missing_dimension", reason: "需要新的分析维度" },
      evidencePlan: { mode: "new_query" },
    }],
  }));
  const meta = await fetchExploreTask(resultPath, {
    taskId: "same-query",
    fromCardId: "c1",
    payload: { ...original, orderBy: { field: "profitAmt", direction: "DESC" } },
  });
  assert.equal(meta.status, "failed");
  assert.equal(meta.errorCode, "NO_MATERIAL_QUERY_DELTA");
  assert.equal(meta.attempts.length, 0);
  assert.match(meta.failedMessage, /reuse Writer entry\.json/);
});

test("fetchExploreTask refuses a version-2 reuse_entry task even if caller omits fromCardId", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-reuse-"));
  const session = join(root, ".harness", "state", "html-report", "ex-reuse");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [{ id: "c1", query: { request: metricQuery(), comparisons: [] } }] }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{ id: "reuse-1", fromCardId: "c1", goal: "复用现有明细", evidencePlan: { mode: "reuse_entry" } }],
  }));
  const meta = await fetchExploreTask(resultPath, {
    taskId: "reuse-1",
    payload: metricQuery(),
  });
  assert.equal(meta.status, "failed");
  assert.equal(meta.errorCode, "TASK_MODE_REUSE_ENTRY");
  assert.equal(meta.attempts.length, 0);
});

test("fetchExploreTask refuses new_query without a structured evidence gap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-gap-"));
  const session = join(root, ".harness", "state", "html-report", "ex-gap");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", query: { request: metricQuery(), comparisons: [] } }],
  }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{ id: "new-without-gap", fromCardId: "c1", goal: "验证缺口契约", evidencePlan: { mode: "new_query" } }],
  }));

  const meta = await fetchExploreTask(resultPath, {
    taskId: "new-without-gap",
    payload: metricQuery({ metrics: ["profitAmt", "saleAmt"] }),
  });
  assert.equal(meta.status, "failed");
  assert.equal(meta.errorCode, "TASK_EVIDENCE_GAP_MISSING");
  assert.equal(meta.attempts.length, 0);
});

test("fetchExploreTask requires a version-2 runnable task before any query", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-task-gate-"));
  const session = join(root, ".harness", "state", "html-report", "ex-task-gate");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });
  const resultPath = join(session, "result.json");
  const source = metricQuery();
  const candidate = metricQuery({ metrics: ["profitAmt", "saleAmt"] });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", query: { request: source, comparisons: [] } }],
  }));

  await writeFile(resultPath, JSON.stringify({ cards: [{ id: "c1", query: { request: source, comparisons: [] } }] }));
  await assert.rejects(
    () => fetchExploreTask(resultPath, { taskId: "guard-1", payload: candidate }),
    /result\.status must be confirmed/
  );
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", query: { request: source, comparisons: [] } }],
  }));

  let meta = await fetchExploreTask(resultPath, { taskId: "guard-1", payload: candidate });
  assert.equal(meta.errorCode, "TASKS_NOT_FOUND");
  assert.deepEqual(meta.attempts, []);

  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({ version: 1, tasks: [] }));
  meta = await fetchExploreTask(resultPath, { taskId: "guard-1", payload: candidate });
  assert.equal(meta.errorCode, "TASKS_VERSION_INVALID");
  assert.deepEqual(meta.attempts, []);

  const contractTask = {
    id: "guard-1",
    status: "pending",
    fromCardId: "c1",
    goal: "验证任务执行契约",
    evidenceGap: { type: "missing_indicator", reason: "需要销售额指标" },
    evidencePlan: { mode: "new_query" },
  };
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{ ...contractTask, goal: "" }],
  }));
  meta = await fetchExploreTask(resultPath, { taskId: "guard-1", payload: candidate });
  assert.equal(meta.errorCode, "TASK_GOAL_MISSING");

  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{ ...contractTask, fromCardId: "" }],
  }));
  meta = await fetchExploreTask(resultPath, { taskId: "guard-1", payload: candidate });
  assert.equal(meta.errorCode, "TASK_FROM_CARD_MISSING");

  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      ...contractTask,
      evidencePlan: { mode: "new_query", sourceCardId: "c2" },
    }],
  }));
  meta = await fetchExploreTask(resultPath, { taskId: "guard-1", payload: candidate });
  assert.equal(meta.errorCode, "TASK_SOURCE_CARD_MISMATCH");

  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 1,
    maxRounds: 2,
    tasks: [{
      id: "guard-1",
      status: "done",
      fromCardId: "c1",
      goal: "验证任务状态门禁",
      evidenceGap: { type: "missing_indicator", reason: "需要销售额指标" },
      evidencePlan: { mode: "new_query" },
    }],
  }));
  meta = await fetchExploreTask(resultPath, { taskId: "guard-1", payload: candidate });
  assert.equal(meta.errorCode, "TASK_STATUS_NOT_RUNNABLE");
  assert.deepEqual(meta.attempts, []);
});

test("fetchExploreTask rejects a missing baseline and unclassified payload changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-baseline-"));
  const session = join(root, ".harness", "state", "html-report", "ex-baseline");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });
  const resultPath = join(session, "result.json");
  const source = metricQuery();
  const candidate = metricQuery({ metrics: ["profitAmt", "saleAmt"] });
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 0,
    maxRounds: 2,
    tasks: [{
      id: "baseline-1",
      status: "pending",
      fromCardId: "c1",
      goal: "验证查询基线",
      evidenceGap: { type: "missing_indicator", reason: "需要销售额指标" },
      evidencePlan: { mode: "new_query" },
    }],
  }));

  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [{ id: "c1" }] }));
  let meta = await fetchExploreTask(resultPath, { taskId: "baseline-1", payload: candidate });
  assert.equal(meta.errorCode, "FROM_CARD_QUERY_INVALID");
  assert.deepEqual(meta.attempts, []);

  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", query: { request: source, comparisons: [] } }],
  }));
  meta = await fetchExploreTask(resultPath, {
    taskId: "baseline-1",
    payload: { ...candidate, inventedFlag: "bypass" },
  });
  assert.equal(meta.errorCode, "METRIC_QUERY_INVALID");
  assert.match(meta.failedMessage, /unsupported fields.*inventedFlag/);
  assert.deepEqual(meta.attempts, []);
});

test("fetch-explore Metric CLI success persists rows with derived provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-success-"));
  const session = join(root, ".harness", "state", "html-report", "ex-success");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });

  const original = metricQuery({ orderBy: { field: "incDate", direction: "ASC" } });
  const candidate = {
    ...original,
    metrics: ["profitAmt", "saleAmt"],
    orderBy: { field: "profitAmt", direction: "DESC" },
  };
  const taskId = "new-query-success";
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    session_id: "ex-success",
    cards: [{ id: "c1", query: { request: original, comparisons: [] } }],
  }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: taskId,
      fromCardId: "c1",
      goal: "补充销售额指标",
      evidenceGap: { type: "missing_indicator", reason: "需要新增销售额指标" },
      evidencePlan: { mode: "new_query" },
    }],
  }));

  const fakeArgsPath = join(root, "fake-cli-args.json");
  const fakeCountPath = join(root, "fake-cli-count.txt");
  const fakeCliPath = join(root, "fake-metric-cli.mjs");
  const rows = [{ b: 2, a: "x" }, { a: "y", b: 1 }];
  const expectedRowsSha256 = "b33e3daec35e0d408ffa081470a9f4aa52a07350cc41b4fe31526f54aeb28130";
  await writeFile(
    fakeCliPath,
    [
      "#!/usr/bin/env node",
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      "const countPath = process.env.FAKE_CLI_COUNT_PATH;",
      "const count = countPath && existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0;",
      "if (countPath) writeFileSync(countPath, String(count + 1));",
      "writeFileSync(process.env.FAKE_CLI_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
      `process.stdout.write(${JSON.stringify(JSON.stringify(rows))});`,
      "",
    ].join("\n")
  );
  await chmod(fakeCliPath, 0o755);

  const fetchExploreScript = fileURLToPath(new URL("../scripts/fetch-explore.mjs", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [
      fetchExploreScript,
      "--result",
      resultPath,
      "--task-id",
      taskId,
      "--payload-json",
      JSON.stringify(candidate),
      "--from-card-id",
      "c1",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        QDM_METRIC_CLI: fakeCliPath,
        HARNESS_AUTHZ_MODE: "off",
        FAKE_CLI_ARGS_PATH: fakeArgsPath,
        FAKE_CLI_COUNT_PATH: fakeCountPath,
      },
    }
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const cliArgs = JSON.parse(await readFile(fakeArgsPath, "utf8"));
  assert.equal(cliArgs[0], "analysis");
  assert.equal(cliArgs[1], "execute");
  assert.equal(cliArgs.includes("--meta"), false);
  assert.equal(cliArgs.includes("--single-page"), false);
  const payloadIndex = cliArgs.indexOf("--payload-json");
  assert.ok(payloadIndex >= 0);
  const executedPayload = JSON.parse(cliArgs[payloadIndex + 1]);
  assert.deepEqual(executedPayload.metrics, candidate.metrics);
  assert.equal(executedPayload.pageNo, 1);

  const dataPath = join(session, "data", "explore", `${taskId}.json`);
  const metaPath = join(session, "data", "explore", `${taskId}.meta.json`);
  assert.deepEqual(JSON.parse(await readFile(dataPath, "utf8")), rows);
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  assert.equal(meta.status, "ok");
  assert.equal(meta.producer, "fetch-explore.mjs");
  assert.equal(meta.rowCount, rows.length);
  assert.equal(meta.rowsSha256, expectedRowsSha256);
  assert.equal(meta.argsSummary.singlePage, false);
  assert.equal(meta.queryDelta.material, true);
  assert.deepEqual(meta.queryDelta.changedKeys, ["metrics"]);
  assert.deepEqual(meta.queryPatch, { metrics: ["profitAmt", "saleAmt"], orderBy: { field: "profitAmt", direction: "DESC" } });
  assert.match(meta.queryPatchSha256, /^[a-f0-9]{64}$/);
  assert.match(meta.sourceQuerySha256, /^[a-f0-9]{64}$/);
  assert.match(meta.executedQuerySha256, /^[a-f0-9]{64}$/);
  assert.equal(meta.producerVersion, 3);
  assert.equal(meta.cacheContractVersion, 3);
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0].status, 0);
  assert.match(meta.resultSha256, /^[a-f0-9]{64}$/);
  assert.match(meta.taskQueryContractSha256, /^[a-f0-9]{64}$/);
  assert.match(meta.queryDeltaSha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(fakeCountPath, "utf8"), "1");

  const beforeReuse = {
    data: await readFile(dataPath, "utf8"),
    meta: await readFile(metaPath, "utf8"),
  };
  const cachedRun = spawnSync(
    process.execPath,
    [
      fetchExploreScript,
      "--result",
      resultPath,
      "--task-id",
      taskId,
      "--payload-json",
      JSON.stringify(candidate),
      "--from-card-id",
      "c1",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        QDM_METRIC_CLI: fakeCliPath,
        HARNESS_AUTHZ_MODE: "off",
        FAKE_CLI_ARGS_PATH: fakeArgsPath,
        FAKE_CLI_COUNT_PATH: fakeCountPath,
      },
    }
  );
  assert.equal(cachedRun.status, 0, cachedRun.stderr || cachedRun.stdout);
  assert.equal(JSON.parse(cachedRun.stdout).cacheReuse?.reused, true);
  assert.equal(await readFile(fakeCountPath, "utf8"), "1", "validated cache must skip Metric CLI");
  assert.equal(await readFile(dataPath, "utf8"), beforeReuse.data);
  assert.equal(await readFile(metaPath, "utf8"), beforeReuse.meta);

  const expectedCache = {
    sessionDir: session,
    outDir: join(session, "data", "explore"),
    dataPath,
    metaPath,
    resultPath,
    resultMtimeMs: (await stat(resultPath)).mtimeMs,
    resultSha256: meta.resultSha256,
    taskId,
    taskQueryContractSha256: meta.taskQueryContractSha256,
    fromCardId: "c1",
    queryPatch: meta.queryPatch,
    queryPatchSha256: meta.queryPatchSha256,
    sourceQuerySha256: meta.sourceQuerySha256,
    executedQuerySha256: meta.executedQuerySha256,
    queryDelta: meta.queryDelta,
  };
  assert.ok(await reusableExplore(expectedCache));
  assert.equal(
    await reusableExplore({ ...expectedCache, resultMtimeMs: Date.now() + 60_000 }),
    null,
    "artifacts older than the current result must miss cache"
  );
  assert.equal(
    await reusableExplore({ ...expectedCache, taskQueryContractSha256: "0".repeat(64) }),
    null,
    "task query authorization mismatch must miss cache"
  );
  assert.equal(
    await reusableExplore({
      ...expectedCache,
      queryDelta: { ...meta.queryDelta, changedKeys: ["dimensions"] },
    }),
    null,
    "recomputed queryDelta mismatch must miss cache"
  );
  assert.equal(
    await reusableExplore({ ...expectedCache, queryPatchSha256: "0".repeat(64) }),
    null,
    "query patch hash mismatch must miss cache"
  );
  assert.equal(
    await reusableExplore({ ...expectedCache, sourceQuerySha256: "0".repeat(64) }),
    null,
    "source query hash mismatch must miss cache"
  );

  await writeFile(dataPath, JSON.stringify([...rows, { a: "tampered", b: 9 }]));
  assert.equal(await reusableExplore(expectedCache), null, "rowCount/hash mismatch must miss cache");
  await writeFile(dataPath, beforeReuse.data);
  await writeFile(metaPath, JSON.stringify({ ...meta, rowsSha256: "0".repeat(64) }));
  assert.equal(await reusableExplore(expectedCache), null, "metadata rows hash mismatch must miss cache");
  await writeFile(metaPath, beforeReuse.meta);
  await writeFile(metaPath, JSON.stringify({ ...meta, executedQuerySha256: "0".repeat(64) }));
  assert.equal(await reusableExplore(expectedCache), null, "executed query hash mismatch must miss cache");
  await writeFile(metaPath, beforeReuse.meta);

  await writeFile(metaPath, JSON.stringify({ ...meta, taskQueryContractSha256: "0".repeat(64) }));
  const cacheMissRun = spawnSync(
    process.execPath,
    [
      fetchExploreScript,
      "--result",
      resultPath,
      "--task-id",
      taskId,
      "--payload-json",
      JSON.stringify(candidate),
      "--from-card-id",
      "c1",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        QDM_METRIC_CLI: fakeCliPath,
        HARNESS_AUTHZ_MODE: "off",
        FAKE_CLI_ARGS_PATH: fakeArgsPath,
        FAKE_CLI_COUNT_PATH: fakeCountPath,
      },
    }
  );
  assert.equal(cacheMissRun.status, 0, cacheMissRun.stderr || cacheMissRun.stdout);
  assert.equal(JSON.parse(cacheMissRun.stdout).cacheReuse, undefined);
  assert.equal(await readFile(fakeCountPath, "utf8"), "2", "invalid cache must follow the normal CLI path");
  const repairedMeta = JSON.parse(await readFile(metaPath, "utf8"));
  assert.equal(repairedMeta.taskQueryContractSha256, meta.taskQueryContractSha256);
});

test("fetch-explore inherits comparison evidence when the candidate query omits comparisons", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-comparison-"));
  const session = join(root, ".harness", "state", "html-report", "ex-comparison");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });

  const source = metricQuery();
  const candidate = metricQuery({ metrics: ["profitAmt", "saleAmt"] });
  const taskId = "comparison-inheritance";
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    session_id: "ex-comparison",
    cards: [{
      id: "c1",
      query: { request: source, comparisons: ["YOY", "MOM"] },
    }],
  }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: taskId,
      fromCardId: "c1",
      goal: "补充销售额指标",
      evidenceGap: { type: "missing_indicator", reason: "需要新增销售额指标" },
      evidencePlan: { mode: "new_query" },
    }],
  }));

  const fakeArgsPath = join(root, "fake-cli-args.json");
  const fakeCliPath = join(root, "fake-metric-cli.mjs");
  await writeFile(fakeCliPath, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    "writeFileSync(process.env.FAKE_CLI_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
    'process.stdout.write("[]");',
    "",
  ].join("\n"));
  await chmod(fakeCliPath, 0o755);

  const fetchExploreScript = fileURLToPath(new URL("../scripts/fetch-explore.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [
    fetchExploreScript,
    "--result", resultPath,
    "--task-id", taskId,
    "--payload-json", JSON.stringify(candidate),
    "--from-card-id", "c1",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      QDM_METRIC_CLI: fakeCliPath,
      HARNESS_AUTHZ_MODE: "off",
      FAKE_CLI_ARGS_PATH: fakeArgsPath,
    },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const cliArgs = JSON.parse(await readFile(fakeArgsPath, "utf8"));
  assert.equal(cliArgs.filter((arg) => arg === "--yoy").length, 1);
  assert.equal(cliArgs.filter((arg) => arg === "--mom").length, 1);
  const executedPayload = JSON.parse(cliArgs[cliArgs.indexOf("--payload-json") + 1]);
  assert.equal(Object.prototype.hasOwnProperty.call(executedPayload, "comparisons"), false);
  const meta = JSON.parse(await readFile(
    join(session, "data", "explore", `${taskId}.meta.json`),
    "utf8"
  ));
  assert.deepEqual(meta.queryDelta.changedKeys, ["metrics"]);
});

test("fetch-explore stops after the first real ETIMEDOUT without a second long query", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-timeout-"));
  const session = join(root, ".harness", "state", "html-report", "ex-timeout");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });

  const original = metricQuery();
  const candidate = metricQuery({ metrics: ["profitAmt", "saleAmt"] });
  const taskId = "timeout-query";
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    session_id: "ex-timeout",
    cards: [{ id: "c1", query: { request: original, comparisons: [] } }],
  }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: taskId,
      fromCardId: "c1",
      goal: "验证查询超时",
      evidenceGap: { type: "missing_indicator", reason: "需要销售额" },
      evidencePlan: { mode: "new_query" },
    }],
  }));

  const fakeCliPath = join(root, "fake-timeout-cli.sh");
  await writeFile(fakeCliPath, [
    "#!/bin/sh",
    "sleep 5",
    "",
  ].join("\n"));
  await chmod(fakeCliPath, 0o755);

  const fetchExploreScript = fileURLToPath(new URL("../scripts/fetch-explore.mjs", import.meta.url));
  const started = Date.now();
  const run = spawnSync(process.execPath, [
    fetchExploreScript,
    "--result", resultPath,
    "--task-id", taskId,
    "--payload-json", JSON.stringify(candidate),
    "--from-card-id", "c1",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      QDM_METRIC_CLI: fakeCliPath,
      HARNESS_AUTHZ_MODE: "off",
      QDM_METRIC_TIMEOUT_MS: "1000",
    },
  });
  const elapsedMs = Date.now() - started;
  assert.equal(run.status, 1, run.stderr || run.stdout);
  assert.ok(elapsedMs < 3000, `timeout retry path took too long: ${elapsedMs}ms`);
  const meta = JSON.parse(await readFile(join(session, "data", "explore", `${taskId}.meta.json`), "utf8"));
  assert.equal(meta.status, "failed");
  assert.equal(meta.errorCode, "METRIC_TIMEOUT");
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0].timedOut, true);
  assert.match(meta.attempts[0].error, /ETIMEDOUT/i);
});

test("fetch-explore authz on fails closed before Metric CLI when no blob exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-auth-"));
  const session = join(root, ".harness", "state", "html-report", "ex-auth");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });

  const source = metricQuery();
  const candidate = metricQuery({ metrics: ["profitAmt", "saleAmt"] });
  const taskId = "auth-query";
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    session_id: "ex-auth",
    cards: [{ id: "c1", query: { request: source, comparisons: [] } }],
  }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: taskId,
      status: "pending",
      fromCardId: "c1",
      goal: "验证鉴权失败",
      evidenceGap: { type: "missing_indicator", reason: "需要销售额" },
      evidencePlan: { mode: "new_query" },
    }],
  }));

  const metricCountPath = join(root, "metric-count.txt");
  const fakeMetric = join(root, "fake-metric.sh");
  await writeFile(fakeMetric, [
    "#!/bin/sh",
    "printf 'called' > \"$FAKE_METRIC_COUNT_PATH\"",
    "exit 1",
    "",
  ].join("\n"));
  await chmod(fakeMetric, 0o755);

  const fetchExploreScript = fileURLToPath(new URL("../scripts/fetch-explore.mjs", import.meta.url));
  const env = {
    ...process.env,
    QDM_METRIC_CLI: fakeMetric,
    HARNESS_AUTHZ_MODE: "on",
    FAKE_METRIC_COUNT_PATH: metricCountPath,
  };
  delete env.HARNESS_AUTH_BLOB;
  delete env.HARNESS_AUTH_BLOB_FILE;
  delete env.HARNESS_AUTH_USER_ID;
  delete env.LUMI_REQUESTER_CONTEXT_DIR;
  const run = spawnSync(process.execPath, [
    fetchExploreScript,
    "--result", resultPath,
    "--task-id", taskId,
    "--payload-json", JSON.stringify(candidate),
    "--from-card-id", "c1",
  ], { encoding: "utf8", env });

  assert.equal(run.status, 1, run.stderr || run.stdout);
  await assert.rejects(() => stat(metricCountPath), /ENOENT/);
  const meta = JSON.parse(await readFile(join(session, "data", "explore", `${taskId}.meta.json`), "utf8"));
  assert.equal(meta.errorCode, "METRIC_FETCH_FAILED");
  assert.match(meta.failedMessage, /METRIC_AUTH_CONTEXT_REQUIRED/);
  assert.deepEqual(meta.attempts, []);
});

test("computeQueryPatch captures non-semantic field changes (pageSize)", () => {
  const source = normalizeEntryPayload(metricQuery());
  const candidate = normalizeEntryPayload({ ...metricQuery(), pageSize: 1000 });
  const patch = computeQueryPatch(source, candidate);
  assert.ok(patch.pageSize !== undefined, "pageSize change must be in the patch");
  assert.equal(patch.pageSize, 1000);
  const reconstructed = applyQueryPatch(source, patch);
  assert.equal(reconstructed.pageSize, 1000);
  assert.deepEqual(reconstructed, candidate);
});

test("computeQueryPatch uses null for field deletion and applyQueryPatch respects it", () => {
  const source = normalizeEntryPayload({
    ...metricQuery(),
    scopes: { region: "CN01" },
  });
  const candidate = normalizeEntryPayload(metricQuery());
  const patch = computeQueryPatch(source, candidate);
  assert.ok(Object.prototype.hasOwnProperty.call(patch, "scopes"), "deleted field must be in patch");
  assert.equal(patch.scopes, null, "deleted field must use null marker");
  const reconstructed = applyQueryPatch(source, patch);
  assert.equal(Object.prototype.hasOwnProperty.call(reconstructed, "scopes"), false, "deleted field must not exist in reconstruction");
  assert.deepEqual(reconstructed, candidate);
});

test("computeQueryPatch survives JSON round-trip for field deletions", () => {
  const source = normalizeEntryPayload({
    ...metricQuery(),
    scopes: { region: "CN01" },
  });
  const candidate = normalizeEntryPayload(metricQuery());
  const patch = computeQueryPatch(source, candidate);
  const serialized = JSON.parse(JSON.stringify(patch));
  const reconstructed = applyQueryPatch(source, serialized);
  assert.deepEqual(reconstructed, candidate, "reconstruction must match after JSON round-trip");
});
