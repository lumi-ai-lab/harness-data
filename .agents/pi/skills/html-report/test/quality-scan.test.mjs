import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleReport } from "../scripts/assemble-report.mjs";
import {
  canonicalizeJson,
  prepareResearchEvidence,
  rowsSha256,
} from "../scripts/prepare-research-evidence.mjs";
import { normalizeEntryPayload } from "../scripts/fetch-entry.mjs";
import { computeQueryPatch, materialQueryDelta } from "../scripts/fetch-explore.mjs";
import {
  collectNumbersFromJson,
  collectNumbersFromResult,
  collectColumnStatsFromJson,
  reconcileUnmatchedWithColumnStats,
  extractNumbersFromText,
  numbersClose,
  numbersCloseApprox,
  matchReportToEvidence,
  buildHardIssues,
  looksInventedMetricLine,
  softDepthHints,
  runQualityScan,
  writeDraftVerdict,
} from "../scripts/quality-scan.mjs";

function fingerprintJson(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

test("collectNumbersFromJson walks nested objects and arrays", () => {
  const nums = collectNumbersFromJson({
    a: 4540,
    b: { c: "17.45", d: [100, { e: "22,337.06".replace(/,/g, "") }] },
  });
  const values = nums.map((n) => n.value).sort((x, y) => x - y);
  assert.deepEqual(values, [17.45, 100, 4540, 22337.06]);
});

test("collectNumbersFromJson accepts whole percent cells but rejects dates and mixed prose", () => {
  const nums = collectNumbersFromJson({
    percent: "33.8%",
    spacedPercent: "-18.3 %",
    ratio: "0.338",
    date: "2026-07-01",
    mixedPrefix: "约33.8%",
    mixedSuffix: "33.8%同比",
  });
  assert.deepEqual(
    nums.map(({ value, raw, isPercent }) => ({ value, raw, isPercent })),
    [
      { value: 33.8, raw: "33.8%", isPercent: true },
      { value: -18.3, raw: "-18.3 %", isPercent: true },
      { value: 0.338, raw: "0.338", isPercent: false },
    ]
  );

  const report = extractNumbersFromText("占比为 33.8%。", "report.md");
  assert.equal(matchReportToEvidence(report, nums).unmatched.length, 0);
  const wrongUnit = collectNumbersFromJson({ percent: "0.338%" });
  assert.equal(matchReportToEvidence(report, wrongUnit).unmatched.length, 1);

  const plainClaim = extractNumbersFromText("客单价为 33.8 元。", "report.md");
  assert.equal(
    matchReportToEvidence(plainClaim, collectNumbersFromJson({ percent: "33.8%" })).unmatched.length,
    1,
    "percent evidence must not validate a plain amount with the same magnitude"
  );
});

test("extractNumbersFromText captures money, commas, and percents", () => {
  const text = "客数 4,540，客单 17.45，毛利 22,337.06，环比 -18.3%。";
  const found = extractNumbersFromText(text, "main.md");
  const raws = found.map((f) => f.raw);
  assert.ok(raws.some((r) => r.includes("4,540") || r === "4540" || r.includes("4540")));
  assert.ok(found.some((f) => f.isPercent && Math.abs(Math.abs(f.value) - 18.3) < 0.01));
  assert.ok(found.some((f) => f.weight === "hard" && f.value >= 1000));
});

test("numbersClose tolerates rounding and scale", () => {
  assert.equal(numbersClose(22337.06, 22337), true);
  assert.equal(numbersClose(100, 100.04), true);
  assert.equal(numbersClose(100, 200), false);
});

test("numbersCloseApprox accepts narrative rounded counts", () => {
  assert.equal(numbersCloseApprox(4500, 4540), "approx");
  assert.equal(numbersCloseApprox(3700, 3709), "approx");
  assert.equal(numbersCloseApprox(4540, 4540), "exact");
  assert.equal(numbersCloseApprox(100, 500), false);
});

test("collectNumbersFromResult includes filter store ids", () => {
  const nums = collectNumbersFromResult({
    cards: [{ filters: [{ dimUniqueCode: "storeId", dimFieldIdList: ["101001"] }] }],
  });
  assert.ok(nums.some((n) => n.value === 101001));
});

test("matchReportToEvidence marks hard unmatched amounts", () => {
  const report = extractNumbersFromText("销售额 99999 元，占比 12%。", "x.md");
  const evidence = collectNumbersFromJson({ saleAmt: 100 });
  const { matched, unmatched } = matchReportToEvidence(report, evidence);
  const hard = buildHardIssues(unmatched);
  assert.ok(hard.some((i) => i.code === "DATA_UNTRACEABLE"));
  assert.ok(unmatched.some((u) => u.isPercent));
});

test("column stats sum matches report aggregates (not product inventions)", () => {
  const json = {
    rows: [
      { profitAmt: 1000.5, custNum: 10 },
      { profitAmt: 2000.25, custNum: 20 },
      { profitAmt: 500, custNum: 5 },
    ],
  };
  const stats = collectColumnStatsFromJson(json, "entry.json");
  assert.ok(stats.some((s) => s.kind === "col-sum" && Math.abs(s.value - 3500.75) < 0.01));
  assert.ok(stats.some((s) => s.kind === "col-avg" && s.path.includes("custNum")));

  // report cites sum only — should reconcile
  const report = extractNumbersFromText("累计毛利额 3,500.75 元。", "main.md");
  const rowEvidence = collectNumbersFromJson(json, "entry.json");
  let { unmatched } = matchReportToEvidence(report, rowEvidence);
  const recon = reconcileUnmatchedWithColumnStats(unmatched, stats);
  assert.equal(recon.stillUnmatched.length, 0, JSON.stringify(recon.stillUnmatched));
  assert.ok(recon.matchedExtra.some((m) => m.matchType.startsWith("col-stat")));

  // product-like invented amount not equal to any col stat → still unmatched
  const fake = extractNumbersFromText("模拟销售额 99999 元", "sec.md");
  assert.ok(looksInventedMetricLine(fake[0].line));
  let r2 = matchReportToEvidence(fake, rowEvidence);
  let rec2 = reconcileUnmatchedWithColumnStats(r2.unmatched, stats);
  assert.ok(rec2.stillUnmatched.length >= 1);
  const hard = buildHardIssues(rec2.stillUnmatched);
  assert.ok(hard.some((i) => i.code === "INVENTED_METRIC" || i.code === "DATA_UNTRACEABLE"));
});

test("softDepthHints flags short text and missing 平衡", () => {
  const issues = softDepthHints("短", { question: "客数和客单的平衡点" });
  assert.ok(issues.some((i) => i.code === "DEPTH_SHORT"));
  assert.ok(issues.some((i) => i.code === "DEPTH_MISS_QUESTION" || i.code === "DEPTH_NO_CONCLUSION"));
});

async function seedTrustedResearcherSession(session, { claimText } = {}) {
  const cardDir = join(session, "data", "cards", "c1");
  const sectionDir = join(session, "analysis", "sections");
  await mkdir(cardDir, { recursive: true });
  await mkdir(sectionDir, { recursive: true });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    question: "高毛利日期的客流与毛利率表现如何",
    cards: [{
      id: "c1",
      title: "经营明细",
      query: {
        request: {
          metrics: ["profitAmt", "custNum", "profitRate"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-07-01", endDate: "2026-07-04" },
          dimensions: ["incDate"],
          filters: {},
        },
        comparisons: [],
      },
    }],
  }));
  const rows = [
    { 日期: "07-01", 毛利额: 900, 来客数: 101, 毛利率: "10%" },
    { 日期: "07-02", 毛利额: 800, 来客数: 203, 毛利率: "20%" },
    { 日期: "07-03", 毛利额: 700, 来客数: 307, 毛利率: "30%" },
    { 日期: "07-04", 毛利额: 600, 来客数: 419, 毛利率: "40%" },
  ];
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }));
  const task = {
    id: "derived-1",
    fromCardId: "c1",
    goal: "比较高毛利日期与其余日期",
    status: "done",
    evidenceGap: null,
    evidencePlan: {
      mode: "reuse_entry",
      sourceCardId: "c1",
      reason: "现有明细可完成排序和分组统计",
      requiredColumns: ["毛利额", "来客数", "毛利率"],
      operations: [{
        id: "compare",
        type: "compareTopN",
        sortBy: "毛利额",
        count: 2,
        fields: ["来客数", "毛利率"],
      }],
    },
  };
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 1,
    maxRounds: 2,
    tasks: [task],
  }));
  await writeFile(
    join(session, "analysis", "main.md"),
    "# 经营分析\n\n已基于确认范围完成明细取数，并对高毛利日期与其余日期进行拆解。\n"
  );
  const evidence = await prepareResearchEvidence(resultPath, { taskId: task.id });
  const pointer = "/views/compare/selectedStats";
  const sectionPath = join(sectionDir, "explore-derived-1.md");
  const summaryPath = join(sectionDir, "explore-derived-1.summary.json");
  const conclusion = claimText || "高毛利前两日的来客数均值为 152，毛利率均值的原始数值为 15。";
  await writeFile(
    sectionPath,
    `# 分组结论\n\n${conclusion}\n\n证据：\`${pointer}\`\n`
  );
  await writeFile(summaryPath, JSON.stringify({
    taskId: task.id,
    status: "ok",
    evidenceModeUsed: "reuse_entry",
    evidencePath: evidence.evidencePath,
    sectionPath,
    summaryPath,
    summary: conclusion,
    noData: false,
    evidencePointers: [pointer],
    selfCheck: {
      modeCompliant: true,
      evidenceTraceable: true,
      hasContrastOrBreakdown: true,
      answersGoal: true,
      queryJustified: null,
    },
    suggestedDeeper: [],
  }));
  await assembleReport(session);
  return { evidence, task };
}

async function seedTrustedNewQuerySession(session, { claimText } = {}) {
  const cardDir = join(session, "data", "cards", "c1");
  const exploreDir = join(session, "data", "explore");
  const sectionDir = join(session, "analysis", "sections");
  await mkdir(cardDir, { recursive: true });
  await mkdir(exploreDir, { recursive: true });
  await mkdir(sectionDir, { recursive: true });

  const sourcePayload = normalizeEntryPayload({
    metrics: ["profitAmt"],
    statisticPolicy: "SUMMARY",
    time: { startDate: "2026-07-01", endDate: "2026-07-02" },
    dimensions: ["incDate"],
    filters: {},
  });
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    question: "新增品类维度后，各品类毛利表现如何",
    cards: [{ id: "c1", title: "来源卡", query: { request: sourcePayload, comparisons: [] } }],
  }));
  const writerRows = [{ 日期: "2026-07-01", 毛利额: 100 }];
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(writerRows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: writerRows.length,
    rowsSha256: rowsSha256(writerRows),
  }));

  const task = {
    id: "new-1",
    fromCardId: "c1",
    goal: "按新增品类维度拆解毛利额",
    status: "done",
    evidenceGap: { type: "missing_dimension", reason: "现有明细缺少品类维度" },
    evidencePlan: {
      mode: "new_query",
      reason: "需要新增品类维度",
      requiredColumns: ["品类", "毛利额"],
      operations: [{
        id: "groups",
        type: "groupBy",
        groupField: "品类",
        fields: ["毛利额"],
      }],
    },
  };
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 1,
    maxRounds: 2,
    tasks: [task],
  }));
  const conclusion = claimText || "新增品类查询的毛利额合计为 3,333 元。";
  await writeFile(
    join(session, "analysis", "main.md"),
    `# 品类毛利分析\n\n已在确认范围内补充品类维度，并完成分组比较。${conclusion}\n`
  );

  const rows = [{ 品类: "A", 毛利额: 1111 }, { 品类: "B", 毛利额: 2222 }];
  const payload = normalizeEntryPayload({
    ...sourcePayload,
    dimensions: ["categoryLevel1Id"],
  });
  const dataPath = join(exploreDir, "new-1.json");
  const queryPatch = computeQueryPatch(sourcePayload, payload);
  const queryDelta = materialQueryDelta(sourcePayload, payload);
  await writeFile(dataPath, JSON.stringify(rows));
  await writeFile(join(exploreDir, "new-1.meta.json"), JSON.stringify({
    producer: "fetch-explore.mjs",
    producerVersion: 3,
    cacheContractVersion: 3,
    taskId: "new-1",
    fromCardId: "c1",
    status: "ok",
    attempts: [{ attempt: 1, status: 0 }],
    pagination: { mode: "all-pages", singlePage: false },
    queryDelta,
    queryDeltaSha256: fingerprintJson(queryDelta),
    queryPatch,
    queryPatchSha256: fingerprintJson(queryPatch),
    sourceQuerySha256: fingerprintJson(sourcePayload),
    executedQuerySha256: fingerprintJson(payload),
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }));

  const evidence = await prepareResearchEvidence(resultPath, { taskId: task.id });
  const pointer = "/views/groups";
  const sectionPath = join(sectionDir, "explore-new-1.md");
  const summaryPath = join(sectionDir, "explore-new-1.summary.json");
  const researchSummary = "新增品类查询已完成分组拆解，具体数值见固定证据视图。";
  await writeFile(sectionPath, `# 品类拆解\n\n${researchSummary}\n\n证据：\`${pointer}\`\n`);
  await writeFile(summaryPath, JSON.stringify({
    taskId: task.id,
    status: "ok",
    evidenceModeUsed: "new_query",
    evidencePath: evidence.evidencePath,
    sectionPath,
    summaryPath,
    summary: researchSummary,
    noData: false,
    evidencePointers: [pointer],
    selfCheck: {
      modeCompliant: true,
      evidenceTraceable: true,
      hasContrastOrBreakdown: true,
      answersGoal: true,
      queryJustified: true,
    },
    suggestedDeeper: [],
  }));
  await assembleReport(session);
  return { dataPath, evidence, payload, rows, task };
}

test("runQualityScan trusts validated Researcher view statistics without model-derived percentages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-qscan-research-"));
  const session = join(root, ".harness", "state", "html-report", "trusted-research");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedTrustedResearcherSession(session);

  const { scan } = await runQualityScan(session);
  assert.equal(scan.evidence.researcher.layoutValidated, true, scan.evidence.researcher.validationErrors.join("; "));
  assert.equal(scan.evidence.researcher.fileCount, 1);
  assert.ok(scan.evidence.researcher.numberCount > 0);
  assert.ok(scan.matched.some((item) =>
    item.value === 152 && /analysis\/evidence\/derived-1\.json\.views/.test(item.evidencePath)
  ));
  assert.ok(!scan.unmatched.some((item) => item.value === 15), JSON.stringify(scan.unmatched));
  assert.equal(scan.hardIssues.length, 0, JSON.stringify(scan.hardIssues));
});

test("runQualityScan fails fast when authoritative B3 Researcher evidence is tampered", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-qscan-tampered-"));
  const session = join(root, ".harness", "state", "html-report", "tampered-research");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const { evidence } = await seedTrustedResearcherSession(session, {
    claimText: "高毛利前两日的来客数均值为 999999。",
  });
  const packet = JSON.parse(await readFile(evidence.evidencePath, "utf8"));
  packet.views.compare.selectedStats.来客数.mean = 999999;
  await writeFile(evidence.evidencePath, JSON.stringify(packet));

  await assert.rejects(
    () => runQualityScan(session),
    /B3_EXPLORE_LAYOUT_INVALID:.*evidence views do not match/
  );
  await assert.rejects(() => readFile(join(session, "quality", "scan.json"), "utf8"));
});

test("runQualityScan trusts new_query rows and column stats only after explore layout passes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-qscan-new-query-"));
  const session = join(root, ".harness", "state", "html-report", "trusted-new-query");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedTrustedNewQuerySession(session);

  const { scan } = await runQualityScan(session);
  assert.equal(scan.evidence.researcher.layoutValidated, true, scan.evidence.researcher.validationErrors.join("; "));
  assert.equal(scan.evidence.researcher.sourceFileCount, 1);
  assert.ok(scan.evidence.researcher.columnStatCount > 0);
  assert.ok(scan.matched.some((item) =>
    item.value === 3333 && /data\/explore\/new-1\.json\.#stats\.毛利额\.sum/.test(item.evidencePath)
  ), JSON.stringify(scan.matched));
  assert.equal(scan.hardIssues.length, 0, JSON.stringify(scan.hardIssues));
});

test("runQualityScan fails fast when authoritative B3 explore rows are stale", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-qscan-stale-explore-"));
  const session = join(root, ".harness", "state", "html-report", "stale-explore");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const seeded = await seedTrustedNewQuerySession(session, {
    claimText: "新增品类查询的毛利额高达 999999 元。",
  });
  await writeFile(seeded.dataPath, JSON.stringify([...seeded.rows, { 品类: "伪造", 毛利额: 999999 }]));

  await assert.rejects(
    () => runQualityScan(session),
    /B3_EXPLORE_LAYOUT_INVALID:.*rowsSha256|B3_EXPLORE_LAYOUT_INVALID:.*source hash/i
  );
  await assert.rejects(() => readFile(join(session, "quality", "scan.json"), "utf8"));
});

test("runQualityScan fails fast when the B3 explore meta queryPatch hash is tampered", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-qscan-forged-payload-"));
  const session = join(root, ".harness", "state", "html-report", "forged-payload");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const seeded = await seedTrustedNewQuerySession(session, {
    claimText: "新增品类查询的毛利额高达 888888 元。",
  });
  const metaPath = join(seeded.dataPath, "..", "new-1.meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  meta.queryPatchSha256 = "0".repeat(64);
  await writeFile(metaPath, JSON.stringify(meta));

  await assert.rejects(
    () => runQualityScan(session),
    /B3_EXPLORE_LAYOUT_INVALID:.*(?:queryPatch hash mismatch|fingerprint mismatch)/i
  );
  await assert.rejects(() => readFile(join(session, "quality", "scan.json"), "utf8"));
});

test("quality scan CLI writes only scan.json while the legacy draft helper remains explicit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-qscan-"));
  const session = join(root, ".harness", "state", "html-report", "q1");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await writeFile(
    join(session, "result.json"),
    JSON.stringify({ status: "confirmed", question: "客数和客单的平衡点最好在哪", title: "平衡分析" })
  );
  await writeFile(
    join(session, "data", "cards", "c1", "entry.json"),
    JSON.stringify({ rows: [{ customerCnt: 4540, avgTicket: 17.45, profitAmt: 22337.06 }] })
  );
  await writeFile(
    join(session, "analysis", "main.md"),
    [
      "# 结论",
      "",
      "门店客数 4,540，客单 17.45，毛利额 22,337.06。",
      "建议在客流与客单之间寻找平衡，优先保障毛利额最优。",
      "",
    ].join("\n")
  );
  await writeFile(join(session, "analysis", "sections", "c1.md"), "## 章节\n客数 4540\n");

  const { scan, scanPath } = await runQualityScan(session);
  const draft = await writeDraftVerdict(session, scan);

  assert.ok(scanPath.endsWith("quality/scan.json"));
  const disk = JSON.parse(await readFile(scanPath, "utf8"));
  assert.equal(disk.version, 1);
  assert.ok(disk.evidence.numberCount >= 3);
  assert.ok(disk.report.matchedCount >= 1);
  assert.equal(disk.suggestPass, true, JSON.stringify(disk.hardIssues));
  assert.equal(draft.verdict.draft, true);
  assert.equal(draft.verdict.pass, true);

  await rm(draft.path, { force: true });
  const cli = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/quality-scan.mjs", import.meta.url)), "--session-dir", session],
    { encoding: "utf8" }
  );
  assert.equal(cli.status, 0, cli.stderr);
  const output = JSON.parse(cli.stdout);
  assert.equal(output.draftVerdictPath, undefined);
  await assert.rejects(() => readFile(draft.path, "utf8"));
});

test("runQualityScan flags hard untraceable numbers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-qscan-fail-"));
  const session = join(root, ".harness", "state", "html-report", "q2");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ question: "销售额" }));
  await writeFile(join(session, "data", "cards", "c1", "entry.json"), JSON.stringify({ saleAmt: 100 }));
  await writeFile(
    join(session, "analysis", "main.md"),
    "# 结论\n\n销售额高达 888888 元，建议继续观察。\n\n发现明显异常。\n"
  );

  const { scan } = await runQualityScan(session);
  assert.equal(scan.suggestPass, false);
  assert.ok(scan.hardIssues.length >= 1);
  assert.ok(scan.hardIssues.some((i) => /888888/.test(i.raw) || i.value === 888888));
});
