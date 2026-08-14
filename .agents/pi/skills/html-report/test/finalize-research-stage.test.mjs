import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preparePendingReuseEvidence,
  rowsSha256,
} from "../scripts/prepare-research-evidence.mjs";
import {
  executiveSummaryForTask,
  finalizeResearchStage,
  removeInternalPlanningSections,
  replaceResearchSummary,
} from "../scripts/finalize-research-stage.mjs";

test("executiveSummaryForTask promotes R1 answers without duplicating every deep finding", () => {
  const task = {
    analysisRequirements: [
      { id: "direct-answer", targetRubric: ["R1", "R5"] },
      { id: "support-boundary", targetRubric: ["R2", "R6"] },
    ],
  };
  const summary = {
    summary: "旧的总括文本",
    evidencePointers: ["/views/direct", "/views/boundary"],
    findings: [
      {
        requirementId: "direct-answer",
        claim: "最佳已观测组合位于区间 A，目标值为 30。",
        evidencePointers: ["/views/direct"],
      },
      {
        requirementId: "support-boundary",
        claim: "该组合有 4 行，最低支持数为 3。",
        evidencePointers: ["/views/boundary"],
      },
    ],
  };
  assert.deepEqual(executiveSummaryForTask(task, summary), {
    summary: "最佳已观测组合位于区间 A，目标值为 30。",
    evidencePointers: ["/views/direct"],
  });
  assert.equal(summary.findings.length, 2, "完整深入 findings 仍由 Researcher section 保留");
});

test("replaceResearchSummary requires and deterministically replaces the B3 placeholder", () => {
  const main = "# 报告\n\n## 待 B3 Researcher 结论\n\n- 待补全\n\n## 尾部\n\n内容\n";
  const next = replaceResearchSummary(main, [{
    taskId: "t1",
    goal: "识别高毛利样本",
    summary: "毛利额为 200。",
    evidencePointers: ["/views/top/rows/0/row"],
  }]);
  assert.match(next, /## 核心结论/);
  assert.doesNotMatch(next, /待补全/);
  assert.match(next, /html-report:research-summary:start/);
  assert.match(next, /\/views\/top\/rows\/0\/row/);
  assert.match(next, /## 尾部/);
  const noOp = replaceResearchSummary([
    "# 报告",
    "",
    "## Writer 起点",
    "- 已观测业务结论；evidence: entry.json#/0",
    "",
    "## 待 B3 Researcher 结论",
    "- 待补全",
    "",
  ].join("\n"), []);
  assert.match(noOp, /已观测业务结论；evidence: entry\.json#\/0/);
  assert.match(noOp, /本次没有需要额外下钻的任务/);
  assert.throws(() => replaceResearchSummary("# 无占位\n", []), /missing exact B3 conclusion heading/);
});

test("removeInternalPlanningSections drops Editor-only planning without removing later content", () => {
  const main = [
    "# 报告",
    "",
    "## 待加深分析",
    "",
    "- 内部缺口与派工说明",
    "",
    "## 待 B3 Researcher 结论",
    "",
    "- 待补全",
    "",
  ].join("\n");
  const cleaned = removeInternalPlanningSections(main);
  assert.doesNotMatch(cleaned, /待加深分析|内部缺口与派工说明/);
  assert.match(cleaned, /## 待 B3 Researcher 结论/);
});

test("removeInternalPlanningSections also drops the legacy short planning heading", () => {
  const cleaned = removeInternalPlanningSections([
    "# 报告",
    "",
    "## 待加深",
    "- 内部 Planner 缺口",
    "",
    "## 待 B3 Researcher 结论",
    "- 待补全",
    "",
  ].join("\n"));
  assert.doesNotMatch(cleaned, /待加深|内部 Planner 缺口/);
  assert.match(cleaned, /## 待 B3 Researcher 结论/);
});

test("pending reuse evidence and finalizer close B3 without parent file-by-file edits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-finalize-research-"));
  const session = join(root, ".harness", "state", "html-report", "session-1");
  const resultPath = join(session, "result.json");
  const cardDir = join(session, "data", "cards", "c1");
  const analysisDir = join(session, "analysis");
  await mkdir(cardDir, { recursive: true });
  await mkdir(join(analysisDir, "sections"), { recursive: true });
  t.after(async () => rm(root, { recursive: true, force: true }));

  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{
      id: "c1",
      title: "测试卡",
      query: {
        request: {
          metrics: ["profitAmt"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-07-01", endDate: "2026-07-02" },
          dimensions: ["bizDate"],
          filters: {},
        },
        comparisons: [],
      },
    }],
  }));
  const rows = [{ 日期: "2026-07-01", 毛利额: 100 }, { 日期: "2026-07-02", 毛利额: 200 }];
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }));
  const task = {
    id: "t1",
    fromCardId: "c1",
    goal: "识别高毛利样本",
    gap: "尚未识别高毛利样本",
    evidencePlan: {
      mode: "reuse_entry",
      sourceCardId: "c1",
      reason: "现有字段足够",
      requiredColumns: ["日期", "毛利额"],
      operations: [{ id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
    },
    evidenceGap: null,
    exploreType: "reuse_entry",
    candidateIndicators: [],
    candidateDims: [],
    successCriteria: "指出高毛利样本",
    targetRubric: ["R1"],
    reason: "需要回答题面",
    hint: "使用 top view",
    status: "pending",
  };
  await writeFile(join(analysisDir, "tasks.json"), JSON.stringify({
    version: 2,
    round: 0,
    maxRounds: 2,
    source: "phase-b2",
    editorial: { userQuestion: "测试问题", gaps: ["待回答"], notes: null },
    tasks: [task],
  }));
  await writeFile(join(analysisDir, "main.md"), [
    "# 测试报告",
    "",
    "## 待加深分析",
    "",
    "- 仅供 Editor 派工",
    "",
    "## 待 B3 Researcher 结论",
    "",
    "- 待补全",
    "",
  ].join("\n"));

  const prepared = await preparePendingReuseEvidence(resultPath);
  assert.deepEqual(prepared.deferred, []);
  assert.equal(prepared.prepared.length, 1);
  const evidencePath = prepared.prepared[0].evidencePath;
  const sectionPath = join(analysisDir, "sections", "explore-t1.md");
  const summaryPath = join(analysisDir, "sections", "explore-t1.summary.json");
  const pointer = "/views/top/rows/0/row";
  const summary = {
    taskId: "t1",
    status: "ok",
    evidenceModeUsed: "reuse_entry",
    evidencePath,
    sectionPath,
    summaryPath,
    summary: "毛利额为200。",
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
  };
  await writeFile(sectionPath, `- 毛利额为200。  \n  证据：\`${pointer}\`\n`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  const output = await finalizeResearchStage(resultPath);
  assert.equal(output.ok, true);
  assert.deepEqual(output.taskIds, ["t1"]);
  assert.equal(output.round, 1);
  const tasks = JSON.parse(await readFile(join(analysisDir, "tasks.json"), "utf8"));
  assert.equal(tasks.tasks[0].status, "done");
  const main = await readFile(join(analysisDir, "main.md"), "utf8");
  assert.match(main, /## 核心结论/);
  assert.doesNotMatch(main, /待加深分析|仅供 Editor 派工/);
  assert.match(main, /毛利额为200/);
  assert.match(main, /\/views\/top\/rows\/0\/row/);
  const report = await readFile(join(session, "report", "report.md"), "utf8");
  assert.match(report, /html-report:full-table/);
  assert.match(report, /html-report:research-section/);
});
