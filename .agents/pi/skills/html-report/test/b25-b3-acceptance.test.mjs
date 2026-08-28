import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

import {
  initPipeline,
  startPipelineStage,
  finishPipelineStage,
  approvePipelineStage,
  readPipelineState,
  LEGACY_STAGE_POLICY,
} from "../scripts/stage-gate.mjs";
import { finalizeEditorStage } from "../scripts/finalize-editor-stage.mjs";
import { finalizeResearchStage } from "../scripts/finalize-research-stage.mjs";
import {
  preparePendingReuseEvidence,
  rowsSha256,
} from "../scripts/prepare-research-evidence.mjs";
import { assembleReport } from "../scripts/assemble-report.mjs";
import { checkSessionLayout } from "../scripts/check-session-layout.mjs";
import {
  fetchExploreTask,
  materialQueryDelta,
} from "../scripts/fetch-explore.mjs";
import {
  evidenceGapMatchesChangedKeys,
  isValidEvidenceGap,
} from "../scripts/research-contract.mjs";
import { researcherReturnPaths } from "../scripts/researcher-return.mjs";
import { submitResearchFindings } from "../scripts/submit-research-findings.mjs";

// ─── shared fixture ───────────────────────────────────────────────

const CARD_ID = "balance-001";
const TASK_ID = "drill-balance-001";

function mockRows() {
  return [
    { 日期: "2026-07-01", 客数: 1200, 客单价: 85.5, 毛利额: 38000 },
    { 日期: "2026-07-02", 客数: 980, 客单价: 92.0, 毛利额: 42000 },
  ];
}

function mockRequestBody() {
  return {
    metrics: ["custNum", "perCustAmt", "profitAmt"],
    statisticPolicy: "SUMMARY",
    time: { startDate: "2026-07-01", endDate: "2026-07-02" },
    dimensions: ["incDate"],
    filters: { storeId: ["101001"] },
    pageNo: 1,
    pageSize: 500,
  };
}

function resultJson(sessionDir) {
  return {
    status: "confirmed",
    submitted_at: new Date().toISOString(),
    title: "门店101001 客数与客单价平衡点分析",
    mode: "free",
    session_id: "test-b3",
    result_path: join(sessionDir, "result.json"),
    already_validated: false,
    validation: [],
    cards: [
      {
        id: CARD_ID,
        title: "门店101001 客数与客单价平衡点分析（逐日趋势）",
        headingLevel: 2,
        analysisFocus: "按日分析来客数、客单价与门店毛利额的关系",
        chartType: "table",
        indicatorBizId: "retail",
        query: {
          request: mockRequestBody(),
          comparisons: [],
        },
      },
    ],
  };
}

function tasksDocument() {
  return {
    version: 2,
    round: 0,
    maxRounds: 2,
    source: "phase-b2",
    editorial: { userQuestion: "客数和客单的平衡在哪个点最好?", gaps: ["尚未识别高毛利样本"], notes: null },
    tasks: [
      {
        id: TASK_ID,
        fromCardId: CARD_ID,
        goal: "识别最高毛利额样本",
        gap: "尚未识别高毛利额最高的日期",
        evidencePlan: {
          mode: "reuse_entry",
          sourceCardId: CARD_ID,
          reason: "现有字段足够完成排序",
          requiredColumns: ["日期", "毛利额"],
          operations: [
            { id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] },
          ],
        },
        analysisRequirements: [
          { id: "answer", question: "哪天毛利额最高？", evidenceViewIds: ["top"], targetRubric: ["R1"] },
        ],
        evidenceGap: null,
        exploreType: "reuse_entry",
        candidateIndicators: [],
        candidateDims: [],
        successCriteria: "指出最高毛利额样本",
        targetRubric: ["R1"],
        reason: "需要回答题面",
        hint: "使用 top view",
        status: "pending",
      },
    ],
  };
}

function mainMarkdown() {
  return [
    "# 门店101001 客数与客单价平衡点分析",
    "",
    "## Writer 起点",
    "",
    "- 已观测业务结论；evidence: entry.json#/0",
    "",
    "## 待加深分析",
    "",
    "- 仅供 Editor 派工",
    "",
    "## 待 B3 Researcher 结论",
    "",
    "- 待补全",
    "",
  ].join("\n");
}

async function setupSession(root) {
  const sessionDir = join(root, ".harness", "state", "html-report", "test-b3");
  const cardDir = join(sessionDir, "data", "cards", CARD_ID);
  const analysisDir = join(sessionDir, "analysis");
  await mkdir(join(cardDir), { recursive: true });
  await mkdir(join(analysisDir, "sections"), { recursive: true });
  await mkdir(join(analysisDir, "evidence"), { recursive: true });
  await mkdir(join(sessionDir, "report"), { recursive: true });

  const resultPath = join(sessionDir, "result.json");
  await writeFile(resultPath, JSON.stringify(resultJson(sessionDir), null, 2));

  const rows = mockRows();
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(
    join(cardDir, "entry.meta.json"),
    JSON.stringify({ rowCount: rows.length, rowsSha256: rowsSha256(rows) })
  );

  return { sessionDir, resultPath, cardDir, analysisDir };
}

async function advanceGateToB25(sessionDir) {
  await initPipeline(sessionDir, { mode: "step", sessionId: "test-b3", policy: LEGACY_STAGE_POLICY });
  await startPipelineStage(sessionDir, "A_CONFIG");
  await finishPipelineStage(sessionDir, "A_CONFIG");
  await approvePipelineStage(sessionDir);
  await finishPipelineStage(sessionDir, "B0_PREFLIGHT");
  await approvePipelineStage(sessionDir);
  await startPipelineStage(sessionDir, "B2_WRITER");
  await finishPipelineStage(sessionDir, "B2_WRITER");
  await approvePipelineStage(sessionDir);
  // B25_EDITOR auto-starts because approvalRequired=false
  const state = await readPipelineState(sessionDir);
  assert.equal(state.currentStage, "B25_EDITOR", "B25_EDITOR should auto-start after B2 approval");
  return state;
}

// ─── Scenario A: reuse_entry full chain ───────────────────────────

test("B2.5→B3 reuse_entry full chain delivers report.md with full-table markers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "b25-b3-acceptance-A-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const { sessionDir, resultPath, analysisDir } = await setupSession(root);

  // 1. Advance Gate to B25_EDITOR running
  await advanceGateToB25(sessionDir);
  // A_CONFIG approval may normalize result.json. Writer artifacts are produced
  // later in the real flow, so refresh this fixture after the Gate transition.
  const rows = mockRows();
  const cardDir = join(sessionDir, "data", "cards", CARD_ID);
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(
    join(cardDir, "entry.meta.json"),
    JSON.stringify({ rowCount: rows.length, rowsSha256: rowsSha256(rows) })
  );

  // 2. Write B2.5 Planner artifacts
  await writeFile(join(analysisDir, "tasks.json"), JSON.stringify(tasksDocument(), null, 2));
  await writeFile(join(analysisDir, "main.md"), mainMarkdown());

  // 3. Run finalize-editor-stage.mjs (real, no overrides)
  //    stamps tasks → prepares evidence → assembles → checks b2 layout
  const editorResult = await finalizeEditorStage(resultPath);
  assert.equal(editorResult.ok, true, "finalizeEditorStage should succeed");
  assert.equal(editorResult.nextAction, "stage_gate_finish_B25_EDITOR");

  // 4. Finish B25_EDITOR → auto-starts B3_RESEARCH
  await finishPipelineStage(sessionDir, "B25_EDITOR");
  let state = await readPipelineState(sessionDir);
  assert.equal(state.currentStage, "B3_RESEARCH", "B3_RESEARCH should auto-start after B25 finish");
  assert.equal(state.stages.B25_EDITOR.status, "completed");

  // 5. Read stamped task and evidence to build Researcher submission
  const tasksDoc = JSON.parse(await readFile(join(analysisDir, "tasks.json"), "utf8"));
  const task = tasksDoc.tasks[0];
  assert.equal(task.analysisContractVersion, 1, "task should be stamped with analysisContractVersion");

  const paths = researcherReturnPaths({ sessionDir, taskId: TASK_ID });
  const evidence = JSON.parse(await readFile(paths.evidencePath, "utf8"));
  assert.equal(evidence.taskId, TASK_ID);
  assert.equal(evidence.evidenceMode, "reuse_entry");
  assert.ok(evidence.views?.top, "evidence should have a 'top' view from the topN operation");

  // 6. Use submitResearchFindings to create section + summary
  const expected = {
    taskId: TASK_ID,
    mode: "reuse_entry",
    evidencePath: paths.evidencePath,
    sectionPath: paths.sectionPath,
    summaryPath: paths.summaryPath,
    task,
    analysisRequirements: task.analysisRequirements,
  };
  const topRow = evidence.views.top.rows[0];
  const pointer = `/views/top/rows/0/row`;
  const params = {
    findings: [
      {
        requirementId: "answer",
        claim: `最高毛利额为${topRow.row.毛利额}，出现在${topRow.row.日期}。`,
        evidencePointers: [pointer],
      },
    ],
    suggestedDeeper: [],
  };
  await submitResearchFindings(expected, evidence, params);

  // 7. Run finalize-research-stage.mjs → merges main + assemble + explore layout
  const researchResult = await finalizeResearchStage(resultPath);
  assert.equal(researchResult.ok, true, "finalizeResearchStage should succeed");
  assert.deepEqual(researchResult.taskIds, [TASK_ID]);

  // 8. Finish B3_RESEARCH
  await finishPipelineStage(sessionDir, "B3_RESEARCH");
  state = await readPipelineState(sessionDir);
  assert.equal(state.stages.B3_RESEARCH.status, "awaiting_approval", "B3 should be awaiting_approval");

  // 9. Assertions
  const tasksFinal = JSON.parse(await readFile(join(analysisDir, "tasks.json"), "utf8"));
  assert.equal(tasksFinal.version, 2, "tasks.json should be version 2");
  assert.equal(tasksFinal.tasks[0].status, "done", "task should be done");

  const mainFinal = await readFile(join(analysisDir, "main.md"), "utf8");
  assert.match(mainFinal, /## 核心结论/, "main.md should have 核心结论 section");
  assert.doesNotMatch(mainFinal, /\|.*\|.*\|/, "main.md should not contain Markdown tables");
  assert.doesNotMatch(mainFinal, /待加深分析|仅供 Editor 派工/, "internal planning sections should be removed");

  const report = await readFile(join(sessionDir, "report", "report.md"), "utf8");
  assert.match(report, /html-report:full-table/, "report.md should contain full-table markers");
  assert.match(report, /html-report:research-section/, "report.md should contain research section markers");
  assert.match(report, /门店101001/, "report.md should contain the report title");
});

// ─── Scenario B: new_query evidenceGap validation ─────────────────

test("new_query path: no evidenceGap is rejected, unauthorized fields are rejected, authorized fields pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "b25-b3-acceptance-B-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const sessionDir = join(root, ".harness", "state", "html-report", "test-b3b");
  const analysisDir = join(sessionDir, "analysis");
  await mkdir(analysisDir, { recursive: true });

  const original = mockRequestBody();
  const resultPath = join(sessionDir, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: CARD_ID, query: { request: original, comparisons: [] } }],
  }));

  // B1: new_query without evidenceGap → rejected
  await writeFile(join(analysisDir, "tasks.json"), JSON.stringify({
    version: 2,
    tasks: [{
      id: "gap-test",
      fromCardId: CARD_ID,
      goal: "test",
      evidencePlan: { mode: "new_query" },
      evidenceGap: null,
    }],
  }));
  const noGapResult = await fetchExploreTask(resultPath, {
    taskId: "gap-test",
    fromCardId: CARD_ID,
    payload: { ...original, metrics: ["saleAmt"] },
  });
  assert.equal(noGapResult.status, "failed");
  assert.equal(noGapResult.errorCode, "TASK_EVIDENCE_GAP_MISSING");

  // B2: evidenceGap present but changes an unauthorized field → material delta detects it
  const gap = { type: "missing_indicator", reason: "需要补充销售额指标" };
  assert.equal(isValidEvidenceGap(gap), true);
  // Only metrics is authorized by the gap
  assert.equal(evidenceGapMatchesChangedKeys(gap, ["metrics"]), true);
  // Adding time.startDate makes it unauthorized
  assert.equal(evidenceGapMatchesChangedKeys(gap, ["metrics", "time.startDate"]), false);

  // B3: evidenceGap present, only authorized field changed → passes material delta check
  const candidatePayload = { ...original, metrics: ["custNum", "perCustAmt", "profitAmt", "saleAmt"] };
  const delta = materialQueryDelta(original, candidatePayload);
  assert.equal(delta.material, true);
  assert.deepEqual(delta.changedKeys, ["metrics"]);
  assert.equal(evidenceGapMatchesChangedKeys(gap, delta.changedKeys), true);

  // B4: orderBy-only change → no material delta, should be rejected as NO_MATERIAL_QUERY_DELTA
  const orderByOnly = materialQueryDelta(original, {
    ...original,
    orderBy: { field: "profitAmt", direction: "DESC" },
  });
  assert.equal(orderByOnly.material, false);
  assert.deepEqual(orderByOnly.changedKeys, []);
});

// ─── Scenario C: evidence tamper detection ────────────────────────

test("evidence tamper: modifying entry.json after evidence generation breaks explore layout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "b25-b3-acceptance-C-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const { sessionDir, resultPath, cardDir, analysisDir } = await setupSession(root);

  // Write tasks + main (no Gate flow needed for tamper test — just test layout)
  await writeFile(join(analysisDir, "tasks.json"), JSON.stringify(tasksDocument(), null, 2));
  await writeFile(join(analysisDir, "main.md"), mainMarkdown());

  // Generate evidence
  const prepared = await preparePendingReuseEvidence(resultPath);
  assert.equal(prepared.prepared.length, 1);
  const evidencePath = prepared.prepared[0].evidencePath;

  // Verify evidence exists and has correct source hash
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const originalMeta = JSON.parse(await readFile(join(cardDir, "entry.meta.json"), "utf8"));
  assert.equal(evidence.source.rowsSha256, originalMeta.rowsSha256,
    "evidence source hash should match entry.meta.json");

  // Assemble report and verify b2 layout passes before tamper
  await assembleReport(sessionDir);
  const layoutBefore = await checkSessionLayout(sessionDir, { phase: "b2" });
  assert.equal(layoutBefore.ok, true, "b2 layout should pass before tamper");

  // Tamper: modify entry.json rows (change a value)
  const tamperedRows = mockRows();
  tamperedRows[0].毛利额 = 99999;
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(tamperedRows));

  // Update entry.meta.json to match tampered rows so assembleReport succeeds,
  // but the evidence file still has the ORIGINAL hash — explore layout should
  // detect the mismatch between evidence.source.rowsSha256 and meta.rowsSha256
  const tamperedHash = rowsSha256(tamperedRows);
  assert.notEqual(tamperedHash, originalMeta.rowsSha256,
    "tampered rows hash should differ from original meta hash");
  await writeFile(
    join(cardDir, "entry.meta.json"),
    JSON.stringify({ rowCount: tamperedRows.length, rowsSha256: tamperedHash })
  );

  // Mark the task as done and write Researcher artifacts so explore layout can check
  const tasksDoc = JSON.parse(await readFile(join(analysisDir, "tasks.json"), "utf8"));
  tasksDoc.tasks[0].status = "done";
  tasksDoc.tasks[0].analysisContractVersion = 1;
  await writeFile(join(analysisDir, "tasks.json"), JSON.stringify(tasksDoc, null, 2));

  // Write minimal section + summary so explore layout has artifacts to check
  const paths = researcherReturnPaths({ sessionDir, taskId: TASK_ID });
  const pointer = "/views/top/rows/0/row";
  await writeFile(paths.sectionPath, `- 最高毛利额。  \n  证据：\`${pointer}\`\n`);
  await writeFile(paths.summaryPath, JSON.stringify({
    taskId: TASK_ID,
    status: "ok",
    evidenceModeUsed: "reuse_entry",
    evidencePath,
    sectionPath: paths.sectionPath,
    summaryPath: paths.summaryPath,
    summary: "最高毛利额。",
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
  }, null, 2) + "\n");

  // Re-assemble with tampered data
  await assembleReport(sessionDir);

  // Explore layout should fail because evidence source hash doesn't match tampered entry
  const layoutAfter = await checkSessionLayout(sessionDir, { phase: "explore" });
  assert.equal(layoutAfter.ok, false, "explore layout should fail after tamper");
  assert.ok(
    layoutAfter.errors.some((e) => /rowsSha256 does not match source/i.test(e)),
    `errors should mention rowsSha256 mismatch; got: ${layoutAfter.errors.join("; ")}`
  );
});
