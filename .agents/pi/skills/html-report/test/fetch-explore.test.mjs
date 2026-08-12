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
  isIndicatorsTimeout,
  materialQueryDelta,
  reusableExplore,
  semanticQueryShape,
} from "../scripts/fetch-explore.mjs";
import { normalizeEntryPayload } from "../scripts/fetch-entry.mjs";
import {
  evidenceGapMatchesChangedKeys,
  evidenceGapTypes,
  isValidEvidenceGap,
} from "../scripts/research-contract.mjs";

test("sanitizeTaskId strips unsafe chars", () => {
  assert.equal(sanitizeTaskId("drill-001"), "drill-001");
  assert.equal(sanitizeTaskId("a/b c"), "a_b_c");
  assert.equal(sanitizeTaskId(""), "task");
});

test("Indicators timeout classifier recognizes ETIMEDOUT and explicit timeout failures only", () => {
  assert.equal(isIndicatorsTimeout({ errorCode: "ETIMEDOUT" }), true);
  assert.equal(isIndicatorsTimeout({ status: 1, stderr: "upstream request timeout exceeded" }), true);
  assert.equal(isIndicatorsTimeout({ status: 1, stderr: "指标查询超时" }), true);
  assert.equal(isIndicatorsTimeout({ status: 1, stderr: "connection reset" }), false);
  assert.equal(
    isIndicatorsTimeout({ status: 0, error: "", stdout: '{"rows":[{"label":"timeout"}]}' }),
    false,
    "a successful data cell containing the word timeout is not a failed query"
  );
});

test("fetchExploreTask fails closed when indicatorFieldList empty (no CLI)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-"));
  const session = join(root, ".harness", "state", "html-report", "ex1");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(session, "analysis"), { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(
    resultPath,
    JSON.stringify({
      status: "confirmed",
      cards: [{ id: "c1", requestBody: { indicatorFieldList: ["profitAmt"] } }],
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
    payload: { startDate: "2026-07-01", endDate: "2026-07-10" },
    goal: "empty payload should fail",
  });

  assert.equal(meta.status, "failed");
  assert.match(meta.failedMessage || meta.error || "", /indicatorFieldList/i);

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
  const p = normalizeEntryPayload({
    pageSize: 99999,
    currPage: 3,
    indicatorFieldList: ["x"],
  });
  assert.equal(p.currPage, 1);
  assert.ok(p.pageSize <= 5000);
});

test("material query delta ignores ordering, pagination, and chart presentation", () => {
  const original = {
    indicatorFieldList: ["custNum", "profitAmt"],
    aggDimUniqueCodeList: ["incDate"],
    filterDimUniqueCodeList: [{ dimUniqueCode: "storeId", dimFieldIdList: ["101001"] }],
    startDate: "2026-07-01",
    endDate: "2026-07-27",
    orderBy: "日维度 ASC",
    currPage: 1,
    pageSize: 500,
    chartType: "table",
  };
  const presentationOnly = {
    ...original,
    indicatorFieldList: ["profitAmt", "custNum"],
    orderBy: "门店毛利额 DESC",
    currPage: 9,
    pageSize: 50,
    chartType: "line",
  };
  assert.deepEqual(materialQueryDelta(original, presentationOnly).changedKeys, []);
  assert.deepEqual(semanticQueryShape(original), semanticQueryShape(presentationOnly));
  assert.deepEqual(materialQueryDelta(original, { ...presentationOnly, inventedFlag: "bypass" }).changedKeys, []);
  assert.deepEqual(
    materialQueryDelta(original, { ...presentationOnly, inventedFlag: "bypass" }).changedUnclassifiedKeys,
    ["inventedFlag"]
  );
  for (const [key, candidate] of [
    ["indicatorFieldList", { ...presentationOnly, indicatorFieldList: ["profitAmt", "saleAmt"] }],
    ["aggDimUniqueCodeList", { ...presentationOnly, aggDimUniqueCodeList: ["storeId"] }],
    ["startDate", { ...presentationOnly, startDate: "2026-06-01" }],
  ]) {
    const delta = materialQueryDelta(original, candidate);
    assert.equal(delta.material, true, `${key} should be a material query change`);
    assert.deepEqual(delta.changedKeys, [key]);
  }
});

test("evidence gap authorizes every material query change, not just one", () => {
  const gap = { type: "missing_indicator", reason: "需要补充销售额指标" };
  assert.equal(evidenceGapMatchesChangedKeys(gap, ["indicatorFieldList"]), true);
  assert.equal(evidenceGapMatchesChangedKeys(gap, []), false);
  assert.equal(
    evidenceGapMatchesChangedKeys(gap, ["indicatorFieldList", "startDate"]),
    false
  );
  const mergedGap = {
    types: ["missing_indicator", "missing_dimension"],
    reason: "一次查询同时补充销售额指标与品类维度",
  };
  assert.equal(
    evidenceGapMatchesChangedKeys(mergedGap, ["indicatorFieldList", "aggDimUniqueCodeList"]),
    true
  );
  assert.equal(
    evidenceGapMatchesChangedKeys(mergedGap, ["indicatorFieldList", "aggDimUniqueCodeList", "startDate"]),
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
  const original = {
    indicatorFieldList: ["profitAmt"],
    aggDimUniqueCodeList: ["incDate"],
    startDate: "2026-07-01",
    endDate: "2026-07-27",
    filterDimUniqueCodeList: [
      {
        type: "DIMENSION",
        dimUniqueCode: "storeId",
        dimFieldIdList: ["101002", "101001"],
      },
      {
        type: "DIMENSION",
        dimUniqueCode: "categoryLevel1Id",
        dimFieldIdList: ["20", "10"],
      },
    ],
  };
  const reordered = {
    ...original,
    filterDimUniqueCodeList: [
      {
        type: "DIMENSION",
        dimUniqueCode: "categoryLevel1Id",
        dimFieldIdList: ["10", "20", "10"],
      },
      {
        type: "DIMENSION",
        dimUniqueCode: "storeId",
        dimFieldIdList: ["101001", "101002"],
      },
    ],
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
  const original = {
    indicatorFieldList: ["custNum", "profitAmt"],
    aggDimUniqueCodeList: ["incDate"],
    filterDimUniqueCodeList: [{ dimUniqueCode: "storeId", dimFieldIdList: ["101001"] }],
    startDate: "2026-07-01",
    endDate: "2026-07-27",
    orderBy: "日维度 ASC",
  };
  const resultPath = join(session, "result.json");
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: original }],
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
    payload: { ...original, orderBy: "门店毛利额 DESC" },
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
  await writeFile(resultPath, JSON.stringify({ status: "confirmed", cards: [{ id: "c1", requestBody: {} }] }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{ id: "reuse-1", fromCardId: "c1", goal: "复用现有明细", evidencePlan: { mode: "reuse_entry" } }],
  }));
  const meta = await fetchExploreTask(resultPath, {
    taskId: "reuse-1",
    payload: { indicatorFieldList: ["profitAmt"] },
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
    cards: [{ id: "c1", requestBody: { indicatorFieldList: ["profitAmt"] } }],
  }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{ id: "new-without-gap", fromCardId: "c1", goal: "验证缺口契约", evidencePlan: { mode: "new_query" } }],
  }));

  const meta = await fetchExploreTask(resultPath, {
    taskId: "new-without-gap",
    payload: { indicatorFieldList: ["profitAmt", "saleAmt"] },
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
  const source = { indicatorFieldList: ["profitAmt"], aggDimUniqueCodeList: ["incDate"] };
  const candidate = { ...source, indicatorFieldList: ["profitAmt", "saleAmt"] };
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: source }],
  }));

  await writeFile(resultPath, JSON.stringify({ cards: [{ id: "c1", requestBody: source }] }));
  await assert.rejects(
    () => fetchExploreTask(resultPath, { taskId: "guard-1", payload: candidate }),
    /result\.status must be confirmed/
  );
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: source }],
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
  const source = { indicatorFieldList: ["profitAmt"], aggDimUniqueCodeList: ["incDate"] };
  const candidate = { ...source, indicatorFieldList: ["profitAmt", "saleAmt"] };
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
  assert.equal(meta.errorCode, "FROM_CARD_REQUEST_BODY_INVALID");
  assert.deepEqual(meta.attempts, []);

  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: source }],
  }));
  meta = await fetchExploreTask(resultPath, {
    taskId: "baseline-1",
    payload: { ...candidate, inventedFlag: "bypass" },
  });
  assert.equal(meta.errorCode, "UNCLASSIFIED_QUERY_CHANGE");
  assert.deepEqual(meta.queryDelta.changedUnclassifiedKeys, ["inventedFlag"]);
  assert.deepEqual(meta.attempts, []);
});

test("fetch-explore CLI success uses --meta and persists rows with provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-success-"));
  const session = join(root, ".harness", "state", "html-report", "ex-success");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });

  const original = {
    indicatorFieldList: ["profitAmt"],
    aggDimUniqueCodeList: ["incDate"],
    filterDimUniqueCodeList: [
      { type: "DIMENSION", dimUniqueCode: "storeId", dimFieldIdList: ["101001"] },
    ],
    startDate: "2026-07-01",
    endDate: "2026-07-27",
    storeCollectType: 1,
    orderBy: "日维度 ASC",
  };
  const candidate = {
    ...original,
    indicatorFieldList: ["profitAmt", "saleAmt"],
    orderBy: "门店毛利额 DESC",
  };
  const taskId = "new-query-success";
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: original }],
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
  const fakeCliPath = join(root, "fake-indicators-cli.mjs");
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
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        rows,
        rowCount: rows.length,
        rowsSha256: expectedRowsSha256,
      }))});`,
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
        QDM_INDICATORS_CLI: fakeCliPath,
        QDM_INDICATORS_TOKEN: "test-token",
        FAKE_CLI_ARGS_PATH: fakeArgsPath,
        FAKE_CLI_COUNT_PATH: fakeCountPath,
      },
    }
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const cliArgs = JSON.parse(await readFile(fakeArgsPath, "utf8"));
  assert.equal(cliArgs[0], "analysis");
  assert.equal(cliArgs[1], "execute");
  assert.ok(cliArgs.includes("--meta"));
  assert.equal(cliArgs.includes("--single-page"), false);
  const payloadIndex = cliArgs.indexOf("--payload-json");
  assert.ok(payloadIndex >= 0);
  const executedPayload = JSON.parse(cliArgs[payloadIndex + 1]);
  assert.deepEqual(executedPayload.indicatorFieldList, candidate.indicatorFieldList);
  assert.equal(executedPayload.currPage, 1);

  const dataPath = join(session, "data", "explore", `${taskId}.json`);
  const metaPath = join(session, "data", "explore", `${taskId}.meta.json`);
  assert.deepEqual(JSON.parse(await readFile(dataPath, "utf8")), rows);
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  assert.equal(meta.status, "ok");
  assert.equal(meta.producer, "fetch-explore.mjs");
  assert.equal(meta.rowCount, rows.length);
  assert.equal(meta.rowsSha256, expectedRowsSha256);
  assert.equal(meta.argsSummary.meta, true);
  assert.equal(meta.queryDelta.material, true);
  assert.deepEqual(meta.queryDelta.changedKeys, ["indicatorFieldList"]);
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0].status, 0);
  assert.equal(meta.cacheContractVersion, 1);
  assert.match(meta.resultSha256, /^[a-f0-9]{64}$/);
  assert.match(meta.taskQueryContractSha256, /^[a-f0-9]{64}$/);
  assert.match(meta.queryDeltaSha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(fakeCountPath, "utf8"), "1");

  const payloadPath = join(session, "data", "explore", `${taskId}.payload.json`);
  const beforeReuse = {
    data: await readFile(dataPath, "utf8"),
    meta: await readFile(metaPath, "utf8"),
    payload: await readFile(payloadPath, "utf8"),
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
        QDM_INDICATORS_CLI: fakeCliPath,
        QDM_INDICATORS_TOKEN: "test-token",
        FAKE_CLI_ARGS_PATH: fakeArgsPath,
        FAKE_CLI_COUNT_PATH: fakeCountPath,
      },
    }
  );
  assert.equal(cachedRun.status, 0, cachedRun.stderr || cachedRun.stdout);
  assert.equal(JSON.parse(cachedRun.stdout).cacheReuse?.reused, true);
  assert.equal(await readFile(fakeCountPath, "utf8"), "1", "validated cache must skip Indicators CLI");
  assert.equal(await readFile(dataPath, "utf8"), beforeReuse.data);
  assert.equal(await readFile(metaPath, "utf8"), beforeReuse.meta);
  assert.equal(await readFile(payloadPath, "utf8"), beforeReuse.payload);

  const persistedPayload = JSON.parse(beforeReuse.payload);
  const expectedCache = {
    sessionDir: session,
    outDir: join(session, "data", "explore"),
    dataPath,
    metaPath,
    payloadPath,
    resultPath,
    resultMtimeMs: (await stat(resultPath)).mtimeMs,
    resultSha256: meta.resultSha256,
    taskId,
    taskQueryContractSha256: meta.taskQueryContractSha256,
    fromCardId: "c1",
    payload: persistedPayload,
    payloadSha256: meta.payloadSha256,
    queryDelta: meta.queryDelta,
    sourceQueryShape: meta.sourceQueryShape,
    queryShape: meta.queryShape,
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
      queryDelta: { ...meta.queryDelta, changedKeys: ["aggDimUniqueCodeList"] },
    }),
    null,
    "recomputed queryDelta mismatch must miss cache"
  );
  assert.equal(
    await reusableExplore({ ...expectedCache, payloadSha256: "0".repeat(64) }),
    null,
    "payload hash mismatch must miss cache"
  );

  await writeFile(dataPath, JSON.stringify([...rows, { a: "tampered", b: 9 }]));
  assert.equal(await reusableExplore(expectedCache), null, "rowCount/hash mismatch must miss cache");
  await writeFile(dataPath, beforeReuse.data);
  await writeFile(metaPath, JSON.stringify({ ...meta, rowsSha256: "0".repeat(64) }));
  assert.equal(await reusableExplore(expectedCache), null, "metadata rows hash mismatch must miss cache");
  await writeFile(metaPath, beforeReuse.meta);
  await writeFile(payloadPath, JSON.stringify({ ...persistedPayload, indicatorFieldList: ["forged"] }));
  assert.equal(await reusableExplore(expectedCache), null, "persisted payload mismatch must miss cache");
  await writeFile(payloadPath, beforeReuse.payload);

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
        QDM_INDICATORS_CLI: fakeCliPath,
        QDM_INDICATORS_TOKEN: "test-token",
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

test("fetch-explore stops after the first real ETIMEDOUT without a second long query", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-timeout-"));
  const session = join(root, ".harness", "state", "html-report", "ex-timeout");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });

  const original = {
    indicatorFieldList: ["profitAmt"],
    aggDimUniqueCodeList: ["incDate"],
    startDate: "2026-07-01",
    endDate: "2026-07-27",
  };
  const candidate = { ...original, indicatorFieldList: ["profitAmt", "saleAmt"] };
  const taskId = "timeout-query";
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: original }],
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
  const fakeCountPath = join(root, "fake-timeout-count.txt");
  await writeFile(fakeCliPath, [
    "#!/bin/sh",
    "count=0",
    "if [ -f \"$FAKE_CLI_COUNT_PATH\" ]; then count=$(sed -n '1p' \"$FAKE_CLI_COUNT_PATH\"); fi",
    "count=$((count + 1))",
    "printf '%s' \"$count\" > \"$FAKE_CLI_COUNT_PATH\"",
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
      QDM_INDICATORS_CLI: fakeCliPath,
      QDM_INDICATORS_TOKEN: "test-token",
      QDM_INDICATORS_TIMEOUT_MS: "1000",
      FAKE_CLI_COUNT_PATH: fakeCountPath,
    },
  });
  const elapsedMs = Date.now() - started;
  assert.equal(run.status, 1, run.stderr || run.stdout);
  assert.ok(elapsedMs < 3000, `timeout retry path took too long: ${elapsedMs}ms`);
  assert.equal(await readFile(fakeCountPath, "utf8"), "1", "ETIMEDOUT must not launch attempt 2");
  const meta = JSON.parse(await readFile(join(session, "data", "explore", `${taskId}.meta.json`), "utf8"));
  assert.equal(meta.status, "failed");
  assert.equal(meta.errorCode, "INDICATORS_TIMEOUT");
  assert.equal(meta.attempts.length, 1);
  assert.equal(meta.attempts[0].timedOut, true);
  assert.match(meta.attempts[0].error, /ETIMEDOUT/i);
});

test("fetch-explore attempts CAS once and skips Indicators when auth fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-explore-auth-"));
  const session = join(root, ".harness", "state", "html-report", "ex-auth");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });

  const source = { indicatorFieldList: ["profitAmt"], aggDimUniqueCodeList: ["incDate"] };
  const candidate = { ...source, indicatorFieldList: ["profitAmt", "saleAmt"] };
  const taskId = "auth-query";
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", requestBody: source }],
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

  const casCountPath = join(root, "cas-count.txt");
  const indicatorsCountPath = join(root, "indicators-count.txt");
  const fakeCas = join(root, "fake-cas.sh");
  const fakeIndicators = join(root, "fake-indicators.sh");
  await writeFile(fakeCas, [
    "#!/bin/sh",
    "count=0",
    "if [ -f \"$FAKE_CAS_COUNT_PATH\" ]; then count=$(sed -n '1p' \"$FAKE_CAS_COUNT_PATH\"); fi",
    "count=$((count + 1))",
    "printf '%s' \"$count\" > \"$FAKE_CAS_COUNT_PATH\"",
    "exit 1",
    "",
  ].join("\n"));
  await writeFile(fakeIndicators, [
    "#!/bin/sh",
    "printf 'called' > \"$FAKE_INDICATORS_COUNT_PATH\"",
    "exit 1",
    "",
  ].join("\n"));
  await Promise.all([chmod(fakeCas, 0o755), chmod(fakeIndicators, 0o755)]);

  const fetchExploreScript = fileURLToPath(new URL("../scripts/fetch-explore.mjs", import.meta.url));
  const env = {
    ...process.env,
    QDM_CAS_CLI: fakeCas,
    QDM_INDICATORS_CLI: fakeIndicators,
    FAKE_CAS_COUNT_PATH: casCountPath,
    FAKE_INDICATORS_COUNT_PATH: indicatorsCountPath,
  };
  delete env.QDM_INDICATORS_TOKEN;
  const run = spawnSync(process.execPath, [
    fetchExploreScript,
    "--result", resultPath,
    "--task-id", taskId,
    "--payload-json", JSON.stringify(candidate),
    "--from-card-id", "c1",
  ], { encoding: "utf8", env });

  assert.equal(run.status, 1, run.stderr || run.stdout);
  assert.equal(await readFile(casCountPath, "utf8"), "1");
  await assert.rejects(() => stat(indicatorsCountPath), /ENOENT/);
  const meta = JSON.parse(await readFile(join(session, "data", "explore", `${taskId}.meta.json`), "utf8"));
  assert.equal(meta.errorCode, "AUTH_TOKEN_FAILED");
  assert.deepEqual(meta.attempts, []);
});
