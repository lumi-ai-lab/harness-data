import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSessionLayout } from "../scripts/check-session-layout.mjs";
import { writeVerdict, fingerprintScanContent } from "../scripts/write-verdict.mjs";
import { assembleReport } from "../scripts/assemble-report.mjs";
import {
  canonicalizeJson,
  prepareResearchEvidence,
  rowsSha256,
} from "../scripts/prepare-research-evidence.mjs";
import { normalizeEntryPayload } from "../scripts/fetch-entry.mjs";
import { computeQueryPatch, materialQueryDelta } from "../scripts/fetch-explore.mjs";
import { submitResearchFindings } from "../scripts/submit-research-findings.mjs";
import {
  approvePipelineStage,
  finishPipelineStage,
  initPipeline,
  startPipelineStage,
  LEGACY_STAGE_POLICY,
} from "../scripts/stage-gate.mjs";

function fingerprintJson(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

async function seedWriterSession(session) {
  const cardId = "c1";
  const cardDir = join(session, "data", "cards", cardId);
  await mkdir(cardDir, { recursive: true });
  await writeFile(
    join(session, "result.json"),
    JSON.stringify({ status: "confirmed", cards: [{ id: cardId, title: "测试卡" }] })
  );
  const entryPath = join(cardDir, "entry.json");
  const rows = [{ 日期: "2026-07-01", 销售额: 100 }, { 日期: "2026-07-02", 销售额: 200 }];
  await writeFile(entryPath, JSON.stringify(rows));
  const meta = {
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  };
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify(meta));
  await writeFile(join(cardDir, "caption.md"), "本卡最高为 200。\n");
  await writeFile(join(cardDir, "caption-evidence.json"), JSON.stringify({
    producer: "prepare-card-caption-evidence.mjs",
    cardId,
    rowCount: rows.length,
    query: { metrics: ["销售额"], statisticPolicy: "SUMMARY", dimensions: [], time: null, comparisons: [] },
    axis: [],
    groups: [],
    droppedDimensions: [],
    views: {},
  }));
  return { cardDir, entryPath, rows, meta };
}

test("writer phase validates Writer artifacts without requiring Editor tasks/main", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-writer-"));
  const session = join(root, ".harness", "state", "html-report", "writer");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedWriterSession(session);

  const writer = await checkSessionLayout(session, { phase: "writer" });
  assert.equal(writer.ok, true, writer.errors.join("; "));
  const b2 = await checkSessionLayout(session, { phase: "b2" });
  assert.equal(b2.ok, false);
  assert.ok(b2.errors.some((error) => /main\.md|tasks\.json/.test(error)));
});

test("writer phase requires caption artifacts after a successful entry pair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-writer-caption-"));
  const session = join(root, ".harness", "state", "html-report", "writer-caption");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const seeded = await seedWriterSession(session);
  await rm(join(seeded.cardDir, "caption.md"));

  const report = await checkSessionLayout(session, { phase: "writer" });
  assert.ok(report.errors.some((error) => /missing caption\.md/.test(error)));
});

test("writer phase requires a minimal entry/meta pair and rejects legacy artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-writer-forge-"));
  const session = join(root, ".harness", "state", "html-report", "writer-forge");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const seeded = await seedWriterSession(session);

  await rm(seeded.entryPath);
  let report = await checkSessionLayout(session, { phase: "writer" });
  assert.ok(report.errors.some((error) => /both entry\.json and entry\.meta\.json/.test(error)));

  await writeFile(seeded.entryPath, JSON.stringify(seeded.rows));
  await writeFile(join(seeded.cardDir, "entry.meta.json"), JSON.stringify({ rowCount: 3, rowsSha256: "a".repeat(64) }));
  report = await checkSessionLayout(session, { phase: "writer" });
  assert.ok(report.errors.some((error) => /rowCount must equal/.test(error)));

  await writeFile(join(seeded.cardDir, "entry.meta.json"), JSON.stringify(seeded.meta));
  await writeFile(join(seeded.cardDir, "entry.profile.json"), "{}");
  report = await checkSessionLayout(session, { phase: "writer" });
  assert.ok(report.errors.some((error) => /forbidden legacy entry\.profile\.json/.test(error)));
});

test("writer phase rejects an entry/meta pair older than the current result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-writer-stale-"));
  const session = join(root, ".harness", "state", "html-report", "writer-stale");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const seeded = await seedWriterSession(session);
  const staleTime = new Date("2020-01-01T00:00:00.000Z");
  await Promise.all([
    utimes(seeded.entryPath, staleTime, staleTime),
    utimes(join(seeded.cardDir, "entry.meta.json"), staleTime, staleTime),
  ]);

  const report = await checkSessionLayout(session, { phase: "writer" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /entry\.json is stale.*result\.json/.test(error)));
  assert.ok(report.errors.some((error) => /entry\.meta\.json is stale.*result\.json/.test(error)));
});

test("checkSessionLayout passes for a well-formed b2 session tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-"));
  const session = join(root, ".harness", "state", "html-report", "sess1");
  t.after(async () => rm(root, { recursive: true, force: true }));

  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  await writeFile(join(session, "analysis", "main.md"), "# main\n");
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] }));

  const report = await checkSessionLayout(session, { phase: "b2" });
  assert.equal(report.ok, true, report.errors.join("; "));
});

test("b2 rejects a hand-copied detail table in Editor main.md", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-main-table-"));
  const session = join(root, ".harness", "state", "html-report", "main-table");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  await writeFile(
    join(session, "analysis", "main.md"),
    "# main\n\n| 日期 | 毛利额 |\n| --- | ---: |\n| 2026-07-01 | 100 |\n"
  );
  await writeFile(
    join(session, "analysis", "tasks.json"),
    JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] })
  );

  const report = await checkSessionLayout(session, { phase: "b2" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /must not copy.*detail tables/.test(error)));
});

test("checkSessionLayout fails when Editor outputs are missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-miss-"));
  const session = join(root, ".harness", "state", "html-report", "sess2");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  await mkdir(join(session, "data"), { recursive: true });

  const report = await checkSessionLayout(session, { phase: "b2" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /main\.md|tasks\.json/i.test(e)));
});

test("every layout phase rejects result.json without confirmed status", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-status-"));
  const session = join(root, ".harness", "state", "html-report", "missing-status");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ cards: [] }));
  for (const phase of ["a", "b1", "writer", "b2", "explore", "quality", "html"]) {
    const report = await checkSessionLayout(session, { phase });
    assert.equal(report.ok, false, phase);
    assert.ok(
      report.errors.some((error) => /result\.status must be confirmed/.test(error)),
      `${phase}: ${report.errors.join("; ")}`
    );
  }
});

async function seedB2Session(session) {
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [] }));
  await writeFile(join(session, "analysis", "main.md"), "# main\n");
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] }));
  await writeFile(join(session, "analysis", "sections", "c1.md"), "# c1\n");
  await writeFile(join(session, "analysis", "sections", "c1.summary.json"), JSON.stringify({ cardId: "c1", status: "ok" }));
  await assembleReport(session);
}

function sampleScores() {
  return {
    R1: { score: 2, name: "题面回答" },
    R2: { score: 2, name: "证据与全量表" },
    R3: { score: 1, name: "维度/结构深度" },
    R4: { score: 1, name: "指标丰富度" },
    R5: { score: 1, name: "对比与拆解" },
    R6: { score: 2, name: "一致性" },
    R7: { score: 2, name: "范围忠实" },
  };
}

async function seedQualitySession(session, { pass = true, hardBlockers = [], issues = [] } = {}) {
  await seedB2Session(session);
  await mkdir(join(session, "quality"), { recursive: true });
  await mkdir(join(session, "report"), { recursive: true });
  const scanBody = JSON.stringify({ version: 1, hardIssues: [], softIssues: [] });
  await writeFile(join(session, "quality", "scan.json"), scanBody);
  await writeFile(join(session, "quality", "report.md"), "# 质量审核报告\n");
  await writeVerdict(session, {
    pass,
    draft: false,
    scores: sampleScores(),
    hardBlockers,
    issues,
  });
  await assembleReport(session);
}

async function writeResearchCompletion(session, task, evidence, {
  pointer,
  summary = "基于紧凑证据完成业务分析。",
} = {}) {
  const id = String(task.id).replace(/[^a-zA-Z0-9._-]/g, "_");
  const sectionPath = join(session, "analysis", "sections", `explore-${id}.md`);
  const summaryPath = join(session, "analysis", "sections", `explore-${id}.summary.json`);
  const noData = evidence.source.empty === true;
  const evidencePointer = pointer || `/views/${Object.keys(evidence.views)[0]}`;
  await writeFile(
    sectionPath,
    `# ${task.goal || task.id}\n\n${summary}\n\n证据：\`${evidencePointer}\`\n`
  );
  await writeFile(summaryPath, JSON.stringify({
    taskId: task.id,
    status: "ok",
    evidenceModeUsed: task.evidencePlan.mode,
    evidencePath: evidence.evidencePath,
    sectionPath,
    summaryPath,
    summary,
    noData,
    evidencePointers: [evidencePointer],
    selfCheck: {
      modeCompliant: true,
      evidenceTraceable: true,
      hasContrastOrBreakdown: !noData,
      answersGoal: true,
      queryJustified: task.evidencePlan.mode === "new_query" ? true : null,
    },
    suggestedDeeper: [],
  }));
  return { sectionPath, summaryPath };
}

async function seedTypedResearchTask(session, {
  taskId,
  targetRubric,
  operation,
  rows,
  claim,
  evidencePointer,
}) {
  const cardId = "c1";
  const cardDir = join(session, "data", "cards", cardId);
  const resultPath = join(session, "result.json");
  const tasksPath = join(session, "analysis", "tasks.json");
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await mkdir(cardDir, { recursive: true });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{
      id: cardId,
      title: "通用样本卡",
      query: {
        request: {
          metrics: ["genericMetric"],
          statisticPolicy: "SUMMARY",
          time: { startDate: "2026-07-01", endDate: "2026-07-02" },
          dimensions: ["genericDimension"],
          filters: {},
        },
        comparisons: [],
      },
    }],
  }));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }));
  await writeFile(join(session, "analysis", "main.md"), "# 通用分析\n");
  const task = {
    id: taskId,
    analysisContractVersion: 1,
    fromCardId: cardId,
    goal: "回答通用业务子问题",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      sourceCardId: cardId,
      reason: "现有明细足以回答",
      requiredColumns: ["dimension", "metric"],
      operations: [operation],
    },
    evidenceGap: null,
    analysisRequirements: [{
      id: "answer",
      question: "当前样本支持什么结论？",
      evidenceViewIds: [operation.id],
      targetRubric,
    }],
  };
  await writeFile(tasksPath, JSON.stringify({
    version: 2,
    round: 0,
    maxRounds: 2,
    tasks: [task],
  }));
  const evidence = await prepareResearchEvidence(resultPath, { taskId });
  const id = String(taskId).replace(/[^a-zA-Z0-9._-]/g, "_");
  const expected = {
    taskId,
    mode: "reuse_entry",
    evidencePath: evidence.evidencePath,
    sectionPath: join(session, "analysis", "sections", `explore-${id}.md`),
    summaryPath: join(session, "analysis", "sections", `explore-${id}.summary.json`),
    task,
    analysisRequirements: task.analysisRequirements,
  };
  const submitted = await submitResearchFindings(expected, evidence, {
    findings: [{
      requirementId: "answer",
      claim,
      evidencePointers: [evidencePointer],
    }],
    suggestedDeeper: [],
  });
  task.status = "done";
  await writeFile(tasksPath, JSON.stringify({
    version: 2,
    round: 1,
    maxRounds: 2,
    tasks: [task],
  }));
  await assembleReport(session);
  return { expected, submitted };
}

test("checkSessionLayout quality phase requires scan/report/verdict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-q-"));
  const session = join(root, ".harness", "state", "html-report", "sess-q");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);

  const missing = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /quality/i.test(e)));

  await seedQualitySession(session);
  const ok = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(ok.ok, true, ok.errors.join("; "));
});

test("quality phase requires preceding approvals when the session is in step mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-qgate-"));
  const session = join(root, ".harness", "state", "html-report", "sess-qgate");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedQualitySession(session);
  await initPipeline(session, {
    mode: "step",
    sessionId: "sess-qgate",
    policy: LEGACY_STAGE_POLICY,
  });
  await startPipelineStage(session, "A_CONFIG");
  await finishPipelineStage(session, "A_CONFIG");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B0_PREFLIGHT");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B2_WRITER");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B25_EDITOR");
  await finishPipelineStage(session, "B3_RESEARCH");

  let report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /B3_RESEARCH.*not validly completed and approved/.test(error)));

  await approvePipelineStage(session);
  report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, true, report.errors.join("; "));

  const statePath = join(session, "debug", "pipeline-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.mode = "auto";
  state.approvals = [];
  await writeFile(statePath, JSON.stringify(state));
  report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, true, report.errors.join("; "));
});

test("checkSessionLayout quality requires R1–R7 scores on final verdict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-qscore-"));
  const session = join(root, ".harness", "state", "html-report", "sess-qs");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);
  await mkdir(join(session, "quality"), { recursive: true });
  const scanBody = JSON.stringify({ version: 1, hardIssues: [] });
  await writeFile(join(session, "quality", "scan.json"), scanBody);
  await writeFile(join(session, "quality", "report.md"), "# r\n");
  // Hand-written incomplete verdict (also missing producer)
  await writeFile(
    join(session, "quality", "verdict.json"),
    JSON.stringify({ version: 1, pass: true, draft: false, issues: [] })
  );
  const report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /scores|R1|producer/i.test(e)));
});

test("checkSessionLayout quality rejects fractional rubric scores and total", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-qfraction-"));
  const session = join(root, ".harness", "state", "html-report", "sess-qfraction");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedQualitySession(session);
  const verdictPath = join(session, "quality", "verdict.json");
  const verdict = JSON.parse(await readFile(verdictPath, "utf8"));
  verdict.scores.R3.score = 1.5;
  verdict.total = 11.5;
  await writeFile(verdictPath, JSON.stringify(verdict));

  const report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /scores\.R3.*0, 1, or 2/.test(error)));
  assert.ok(report.errors.some((error) => /total must be an integer/.test(error)));
});

test("checkSessionLayout quality rejects pass=true with hard issues", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-qhard-"));
  const session = join(root, ".harness", "state", "html-report", "sess-qh");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);
  await mkdir(join(session, "quality"), { recursive: true });
  const scanBody = JSON.stringify({ version: 1, hardIssues: [{}] });
  await writeFile(join(session, "quality", "scan.json"), scanBody);
  await writeFile(join(session, "quality", "report.md"), "# r\n");
  // Force pass=true with hard issues via raw write + fake stamp to isolate hard-issue rule
  const fp = fingerprintScanContent(scanBody);
  await writeFile(
    join(session, "quality", "verdict.json"),
    JSON.stringify({
      version: 1,
      pass: true,
      draft: false,
      producer: "write-verdict.mjs",
      scanFingerprint: fp,
      issues: [{ severity: "hard", code: "DATA_UNTRACEABLE", message: "x" }],
      scores: sampleScores(),
      total: 11,
      hardBlockers: [],
    })
  );

  const report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /hard issues.*pass=true/i.test(e)));
});

test("checkSessionLayout quality rejects pass=true with scan-only hard issues", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-qscan-hard-"));
  const session = join(root, ".harness", "state", "html-report", "sess-qscan-hard");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);
  await mkdir(join(session, "quality"), { recursive: true });
  await writeFile(join(session, "quality", "scan.json"), JSON.stringify({
    version: 1,
    hardIssues: [{ code: "DATA_UNTRACEABLE", message: "关键数字不可追溯" }],
  }));
  await writeFile(join(session, "quality", "report.md"), "# 质量审核报告\n");
  const { verdict } = await writeVerdict(session, {
    pass: true,
    scores: sampleScores(),
    hardBlockers: [],
    issues: [],
  });
  assert.equal(verdict.pass, false, "write-verdict must honor scan-only hard issues");
  verdict.pass = true;
  await writeFile(join(session, "quality", "verdict.json"), JSON.stringify(verdict));
  await assembleReport(session);

  const report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /scan\.json has hardIssues/.test(error)));
});

test("checkSessionLayout quality rejects hand-written verdict without producer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-qforge-"));
  const session = join(root, ".harness", "state", "html-report", "sess-qf");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);
  await mkdir(join(session, "quality"), { recursive: true });
  const scanBody = JSON.stringify({ version: 1, hardIssues: [], softIssues: [] });
  await writeFile(join(session, "quality", "scan.json"), scanBody);
  await writeFile(join(session, "quality", "report.md"), "# r\n");
  await writeFile(
    join(session, "quality", "verdict.json"),
    JSON.stringify({
      version: 1,
      pass: true,
      draft: false,
      scores: sampleScores(),
      total: 11,
      hardBlockers: [],
    })
  );
  const report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /producer=write-verdict/i.test(e)));
});

test("checkSessionLayout quality rejects mismatched scanFingerprint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-qfp-"));
  const session = join(root, ".harness", "state", "html-report", "sess-qfp");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedQualitySession(session);
  // Tamper scan after verdict was written
  await writeFile(
    join(session, "quality", "scan.json"),
    JSON.stringify({ version: 1, hardIssues: [], softIssues: [], tampered: true })
  );
  const report = await checkSessionLayout(session, { phase: "quality" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /scanFingerprint/i.test(e)));
});

test("checkSessionLayout rejects a version-1 downgrade before accepting B3 artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-ex-"));
  const session = join(root, ".harness", "state", "html-report", "sess-ex");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);

  let report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, true, report.errors.join("; "));

  await writeFile(
    join(session, "analysis", "tasks.json"),
    JSON.stringify({
      version: 1,
      round: 1,
      maxRounds: 2,
      tasks: [{ id: "drill-001", goal: "g", status: "done" }],
    })
  );

  report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /version must be exactly 2/i.test(e)));
});

test("explore phase rejects a report assembled before the final main merge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-assembly-stale-"));
  const session = join(root, ".harness", "state", "html-report", "sess-stale");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);
  await writeFile(join(session, "analysis", "main.md"), "# main\n\nResearcher 新结论。\n");

  let report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /stale.*assemble-report|final Researcher/.test(error)));

  await assembleReport(session);
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, true, report.errors.join("; "));
});

test("checkSessionLayout b2 rejects non-minimal entry metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-entry-"));
  const session = join(root, ".harness", "state", "html-report", "sess-ent");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);
  await writeFile(
    join(session, "result.json"),
    JSON.stringify({ status: "confirmed", cards: [{ id: "c1", title: "t" }] })
  );
  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  await writeFile(
    join(session, "data", "cards", "c1", "entry.meta.json"),
    JSON.stringify({ cardId: "c1", status: "ok", attempts: [] })
  );
  const report = await checkSessionLayout(session, { phase: "b2" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /both entry\.json and entry\.meta\.json|only rowCount and rowsSha256/i.test(e)));
});

test("checkSessionLayout b2 rejects row-count mismatch and legacy profile artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-entry-meta-"));
  const session = join(root, ".harness", "state", "html-report", "sess-entry-meta");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const seeded = await seedWriterSession(session);
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(join(session, "analysis", "main.md"), "# main\n");
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] }));
  const cardDir = join(session, "data", "cards", "c1");
  const entryPath = join(cardDir, "entry.json");
  let report = await checkSessionLayout(session, { phase: "b2" });
  assert.equal(report.ok, true, report.errors.join("; "));

  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({ rowCount: 99, rowsSha256: "a".repeat(64) }));
  report = await checkSessionLayout(session, { phase: "b2" });
  assert.equal(report.ok, false);

  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({ rowCount: 2, rowsSha256: rowsSha256(seeded.rows) }));
  await writeFile(join(cardDir, "entry.facts.json"), "{}");
  report = await checkSessionLayout(session, { phase: "b2" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /forbidden legacy entry\.facts\.json/.test(error)));
});

test("checkSessionLayout explore rejects stuck running tasks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-run-"));
  const session = join(root, ".harness", "state", "html-report", "sess-run");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedB2Session(session);
  await writeFile(
    join(session, "analysis", "tasks.json"),
    JSON.stringify({
      version: 2,
      round: 0,
      maxRounds: 2,
      tasks: [{
        id: "t1",
        status: "running",
        fromCardId: "missing-card",
        goal: "验证 running 状态",
        evidencePlan: {
          mode: "reuse_entry",
          reason: "验证 running 状态不能完成 B3",
          requiredColumns: ["value"],
          operations: [{ id: "stats", type: "stats", fields: ["value"] }],
        },
      }],
    })
  );
  const report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /running/i.test(e)));
});

test("B2 task contract rejects malformed collections, ids, state, and fake gaps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-task-contract-"));
  const session = join(root, ".harness", "state", "html-report", "task-contract");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedWriterSession(session);
  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(join(session, "analysis", "main.md"), "# main\n");
  const tasksPath = join(session, "analysis", "tasks.json");
  const baseTask = (id = "t1") => ({
    id,
    fromCardId: "c1",
    goal: "验证任务契约",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "现有明细足够",
      requiredColumns: ["销售额"],
      operations: [{ id: "stats", type: "stats", fields: ["销售额"] }],
    },
  });
  const verify = async (document, pattern) => {
    await writeFile(tasksPath, JSON.stringify(document));
    const report = await checkSessionLayout(session, { phase: "b2" });
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => pattern.test(error)), report.errors.join("; "));
  };

  await verify({ version: 2, round: 0, maxRounds: 2, tasks: {} }, /tasks.*array/i);
  await verify({ version: 2, round: -1, maxRounds: 1, tasks: [] }, /round|maxRounds/i);
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [baseTask("dup"), baseTask("dup")] },
    /collide after sanitization/i
  );
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [baseTask("a/b"), baseTask("a_b")] },
    /collide after sanitization/i
  );
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [baseTask("..")] },
    /dot path segment/i
  );
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [{ ...baseTask(), goal: "" }] },
    /goal is required/i
  );
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [{ ...baseTask(), fromCardId: "" }] },
    /fromCardId is required/i
  );
  const mismatchedSource = baseTask();
  mismatchedSource.evidencePlan.sourceCardId = "c2";
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [mismatchedSource] },
    /sourceCardId must equal task\.fromCardId/i
  );
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [{ ...baseTask(), status: "completed" }] },
    /unsupported status/i
  );
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [{ ...baseTask(), status: "skipped" }] },
    /skipReason/i
  );
  await verify(
    {
      version: 2,
      round: 0,
      maxRounds: 2,
      tasks: [{ ...baseTask(), analysisRequirements: {} }],
    },
    /analysisRequirements must be an array/i
  );
  for (const analysisRequirements of [undefined, []]) {
    await verify(
      {
        version: 2,
        round: 0,
        maxRounds: 2,
        tasks: [{
          ...baseTask(),
          analysisContractVersion: 1,
          ...(analysisRequirements === undefined ? {} : { analysisRequirements }),
        }],
      },
      /analysisRequirements must be a non-empty array/i
    );
  }
  await verify(
    {
      version: 2,
      round: 0,
      maxRounds: 2,
      tasks: [{
        ...baseTask(),
        analysisContractVersion: 1,
        analysisRequirements: [{
          id: "null-score",
          question: "回答业务子问题",
          evidenceViewIds: ["stats"],
          targetRubric: ["R3"],
          minScore: null,
        }],
      }],
    },
    /minScore must be 1 or 2/i
  );
  await verify(
    {
      version: 2,
      round: 0,
      maxRounds: 2,
      tasks: [{
        ...baseTask(),
        analysisRequirements: [{
          id: "deep-1",
          question: "回答业务子问题",
          evidenceViewIds: ["missing-view"],
          targetRubric: ["R8"],
          minScore: 3,
        }],
      }],
    },
    /unknown evidencePlan operation|R1-R7|minScore/i
  );
  await verify(
    {
      version: 2,
      round: 0,
      maxRounds: 2,
      tasks: [{
        ...baseTask(),
        analysisRequirements: [
          { id: "duplicate", question: "问题一", evidenceViewIds: ["stats"], targetRubric: ["R3"] },
          { id: "duplicate", question: "问题二", evidenceViewIds: ["stats"], targetRubric: ["R5"] },
        ],
      }],
    },
    /id must be unique/i
  );
  const fakeGapTask = baseTask();
  fakeGapTask.evidencePlan = { ...fakeGapTask.evidencePlan, mode: "new_query" };
  fakeGapTask.evidenceGap = { type: "sorting", reason: "只想换排序" };
  await verify(
    { version: 2, round: 0, maxRounds: 2, tasks: [fakeGapTask] },
    /new_query.*evidenceGap/i
  );
});

test("explore rejects completion artifacts orphaned by failed, skipped, or needs_* tasks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-orphan-completion-"));
  const session = join(root, ".harness", "state", "html-report", "orphan-completion");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedWriterSession(session);
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await writeFile(join(session, "analysis", "main.md"), "# main\n");

  const task = {
    id: "orphan-1",
    fromCardId: "c1",
    goal: "验证非完成任务不能遗留完成产物",
    status: "failed",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "现有明细足够",
      requiredColumns: ["销售额"],
      operations: [{ id: "stats", type: "stats", fields: ["销售额"] }],
    },
    evidenceGap: null,
  };
  const tasksPath = join(session, "analysis", "tasks.json");
  const sectionPath = join(session, "analysis", "sections", "explore-orphan-1.md");
  const summaryPath = join(session, "analysis", "sections", "explore-orphan-1.summary.json");
  await writeFile(sectionPath, "# forged completion\n");
  await writeFile(summaryPath, "{}\n");

  for (const status of ["failed", "skipped", "needs_evidence_plan", "needs_new_query"]) {
    const current = {
      ...task,
      status,
      ...(status === "skipped" ? { skipReason: "无需继续" } : {}),
    };
    await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [current] }));
    await assembleReport(session);
    const report = await checkSessionLayout(session, { phase: "explore" });
    assert.equal(report.ok, false, status);
    assert.ok(
      report.errors.some((error) => error.includes(`status=${status}`) && /explore-orphan-1\.md/.test(error)),
      `${status}: ${report.errors.join("; ")}`
    );
    assert.ok(
      report.errors.some((error) => error.includes(`status=${status}`) && /explore-orphan-1\.summary\.json/.test(error)),
      `${status}: ${report.errors.join("; ")}`
    );
  }

  await rm(sectionPath);
  await rm(summaryPath);
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] }));
  await assembleReport(session);
  const cleanFailed = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(cleanFailed.ok, true, cleanFailed.errors.join("; "));
  assert.equal(cleanFailed.warnings.some((warning) => /missing analysis\/sections/.test(warning)), false);
});

test("explore phase accepts a version-2 reuse_entry task without explore query artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-reuse-"));
  const session = join(root, ".harness", "state", "html-report", "reuse");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cardDir = join(session, "data", "cards", "c1");
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await mkdir(cardDir, { recursive: true });
  const rows = [{ 日期: "07-01", 毛利额: 100 }, { 日期: "07-02", 毛利额: 200 }];
  const reuseRequestBody = {
    metrics: ["profitAmt"],
    statisticPolicy: "SUMMARY",
    time: { startDate: "2026-07-01", endDate: "2026-07-02" },
    dimensions: ["bizDate"],
    filters: {},
  };
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", title: "卡1", query: { request: reuseRequestBody, comparisons: [] } }],
  }));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({ rowCount: 2, rowsSha256: rowsSha256(rows) }));
  await writeFile(join(session, "analysis", "main.md"), "# main\n");
  const tasksPath = join(session, "analysis", "tasks.json");
  const task = {
    id: "reuse-1",
    goal: "识别毛利额最高的日期",
    fromCardId: "c1",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "现有明细字段足够",
      requiredColumns: ["日期", "毛利额"],
      operations: [{ id: "top", type: "topN", field: "毛利额", count: 1, fields: ["日期", "毛利额"] }],
    },
  };
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [task] }));
  const pending = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(pending.errors.some((error) => /status=pending/.test(error)));
  const evidence = await prepareResearchEvidence(join(session, "result.json"), { taskId: "reuse-1" });
  await writeResearchCompletion(session, task, evidence, { pointer: "/views/top/rows/0" });
  await assembleReport(session);
  task.status = "done";
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] }));
  const staleTasks = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(
    staleTasks.errors.some((error) => /tasks\.json.*stale|tasks do not exactly cover/i.test(error)),
    staleTasks.errors.join("; ")
  );
  await assembleReport(session);
  const report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, true, report.errors.join("; "));

  const originalResult = await readFile(join(session, "result.json"), "utf8");
  await writeFile(
    join(session, "result.json"),
    JSON.stringify({
      status: "confirmed",
      cards: [{ id: "c1", title: "卡1（改名）", query: { request: reuseRequestBody, comparisons: [] } }],
    })
  );
  const staleResult = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(staleResult.errors.some((error) => /result\.json changes/.test(error)));
  await writeFile(join(session, "result.json"), originalResult);

  const changedRows = [...rows, { 日期: "07-03", 毛利额: 300 }];
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(changedRows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: changedRows.length,
    rowsSha256: rowsSha256(changedRows),
  }));
  const staleSource = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(staleSource.errors.some((error) => /source hash is stale|evidence rowsSha256/.test(error)));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }));

  const sectionPath = join(session, "analysis", "sections", "explore-reuse-1.md");
  const originalSection = await readFile(sectionPath, "utf8");
  await writeFile(sectionPath, `${originalSection}\n篡改章节。\n`);
  const staleSection = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(staleSection.errors.some((error) => /Researcher section is stale/.test(error)));
  await writeFile(sectionPath, originalSection);

  await rm(evidence.evidencePath);
  const missing = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(missing.errors.some((error) => /missing analysis\/evidence\/reuse-1\.json/.test(error)));
});

test("explore phase recomputes joint decision query scope before validating views", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-joint-scope-"));
  const session = join(root, ".harness", "state", "html-report", "joint-scope");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cardDir = join(session, "data", "cards", "c1");
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await mkdir(cardDir, { recursive: true });
  const rows = [
    { traffic: 10, ticket: 3, profit: 30 },
    { traffic: 11, ticket: 4, profit: 44 },
    { traffic: 12, ticket: 5, profit: 60 },
    { traffic: 20, ticket: 3, profit: 60 },
    { traffic: 21, ticket: 4, profit: 84 },
    { traffic: 22, ticket: 5, profit: 110 },
  ];
  const requestBody = {
    metrics: ["traffic", "ticket", "profit"],
    statisticPolicy: "SUMMARY",
    time: { startDate: "2026-07-01", endDate: "2026-07-31" },
    dimensions: ["bizDate"],
    filters: { storeId: ["sample-store"] },
  };
  const resultPath = join(session, "result.json");
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", title: "通用平衡样本", query: { request: requestBody, comparisons: [] } }],
  }));
  await writeFile(join(cardDir, "entry.json"), JSON.stringify(rows));
  await writeFile(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }));
  await writeFile(join(session, "analysis", "main.md"), "# main\n");
  const task = {
    id: "joint-scope-1",
    goal: "识别两个驱动指标的平衡区间",
    fromCardId: "c1",
    status: "pending",
    evidencePlan: {
      mode: "reuse_entry",
      reason: "现有明细字段足够",
      requiredColumns: ["traffic", "ticket", "profit"],
      operations: [{
        id: "balance",
        type: "jointQuantileBins",
        fields: ["traffic", "ticket"],
        targetField: "profit",
        direction: "desc",
        binCount: 2,
      }],
    },
  };
  const tasksPath = join(session, "analysis", "tasks.json");
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [task] }));
  const evidence = await prepareResearchEvidence(resultPath, { taskId: task.id });
  assert.deepEqual(evidence.views.balance.decisionBrief.queryScope, {
    dateRange: { startDate: "2026-07-01", endDate: "2026-07-31" },
    filters: [{ field: "storeId", values: ["sample-store"] }],
  });
  await writeResearchCompletion(session, task, evidence, {
    pointer: "/views/balance/decisionBrief",
    summary: evidence.views.balance.decisionBrief.recommendedClaim,
  });
  task.status = "done";
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] }));
  await assembleReport(session);

  const report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, true, report.errors.join("; "));
});

test("typed record-only B3 passes layout while comparison capability remains strict", async (t) => {
  const recordRoot = await mkdtemp(join(tmpdir(), "html-report-layout-typed-record-"));
  const recordSession = join(recordRoot, ".harness", "state", "html-report", "typed-record");
  t.after(async () => rm(recordRoot, { recursive: true, force: true }));
  const record = await seedTypedResearchTask(recordSession, {
    taskId: "record-only",
    targetRubric: ["R1"],
    operation: {
      id: "record",
      type: "topN",
      field: "metric",
      fields: ["dimension", "metric"],
      count: 1,
    },
    rows: [
      { dimension: "A", metric: 10 },
      { dimension: "B", metric: 20 },
      { dimension: "C", metric: 15 },
    ],
    claim: "最高已观察指标值为20。",
    evidencePointer: "/views/record",
  });
  assert.equal(record.submitted.researcherReturn.selfCheck.answersGoal, true);
  assert.equal(record.submitted.researcherReturn.selfCheck.hasContrastOrBreakdown, false);
  assert.equal(record.expected.task.analysisRequirements[0].capability, undefined);
  const recordLayout = await checkSessionLayout(recordSession, { phase: "explore" });
  assert.equal(recordLayout.ok, true, recordLayout.errors.join("; "));

  const comparisonRoot = await mkdtemp(join(tmpdir(), "html-report-layout-typed-comparison-"));
  const comparisonSession = join(
    comparisonRoot,
    ".harness",
    "state",
    "html-report",
    "typed-comparison"
  );
  t.after(async () => rm(comparisonRoot, { recursive: true, force: true }));
  const comparison = await seedTypedResearchTask(comparisonSession, {
    taskId: "comparison",
    targetRubric: ["R5"],
    operation: {
      id: "contrast",
      type: "compare",
      sortBy: "metric",
      fields: ["metric"],
      count: 1,
    },
    rows: [
      { dimension: "A", metric: 10 },
      { dimension: "B", metric: 20 },
      { dimension: "C", metric: 15 },
    ],
    claim: "选中样本数为1，剩余样本数为2。",
    evidencePointer: "/views/contrast",
  });
  assert.equal(comparison.submitted.researcherReturn.selfCheck.hasContrastOrBreakdown, true);
  const comparisonLayout = await checkSessionLayout(comparisonSession, { phase: "explore" });
  assert.equal(comparisonLayout.ok, true, comparisonLayout.errors.join("; "));

  const forged = JSON.parse(await readFile(comparison.expected.summaryPath, "utf8"));
  forged.selfCheck.hasContrastOrBreakdown = false;
  await writeFile(comparison.expected.summaryPath, JSON.stringify(forged));
  await assembleReport(comparisonSession);
  const rejected = await checkSessionLayout(comparisonSession, { phase: "explore" });
  assert.equal(rejected.ok, false);
  assert.ok(
    rejected.errors.some((error) => /analysis requirement contract requires hasContrastOrBreakdown=true/.test(error)),
    rejected.errors.join("; ")
  );
  assert.ok(
    rejected.errors.some((error) => /does not match cited operation\/view facts/.test(error)),
    rejected.errors.join("; ")
  );
});

test("explore phase validates version-2 new_query evidence and material query metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-new-query-"));
  const session = join(root, ".harness", "state", "html-report", "new-query");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await mkdir(join(session, "data", "explore"), { recursive: true });
  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  const resultPath = join(session, "result.json");
  const sourcePayload = normalizeEntryPayload({
    metrics: ["profitAmt"],
    statisticPolicy: "SUMMARY",
    time: { startDate: "2026-07-01", endDate: "2026-07-02" },
    dimensions: ["bizDate"],
    filters: {},
  });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", title: "来源卡", query: { request: sourcePayload, comparisons: [] } }],
  }));
  const writerRows = [{ 日期: "2026-07-01", 毛利额: 100 }];
  await writeFile(join(session, "data", "cards", "c1", "entry.json"), JSON.stringify(writerRows));
  await writeFile(join(session, "data", "cards", "c1", "entry.meta.json"), JSON.stringify({
    rowCount: writerRows.length,
    rowsSha256: rowsSha256(writerRows),
  }));
  await writeFile(join(session, "analysis", "main.md"), "# main\n");
  const task = {
    id: "new-1",
    goal: "按品类拆解毛利额",
    fromCardId: "c1",
    status: "done",
    evidenceGap: { type: "missing_dimension", reason: "需要新增品类维度" },
    evidencePlan: {
      mode: "new_query",
      reason: "需要新增品类维度",
      requiredColumns: ["品类", "毛利额"],
      operations: [{ id: "groups", type: "groupBy", groupField: "品类", fields: ["毛利额"] }],
    },
  };
  const tasksPath = join(session, "analysis", "tasks.json");
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] }));
  const rows = [{ 品类: "A", 毛利额: 100 }, { 品类: "B", 毛利额: 200 }];
  const payload = normalizeEntryPayload({
    ...sourcePayload,
    dimensions: ["categoryLevel1Id"],
  });
  const queryPatch = computeQueryPatch(sourcePayload, payload);
  const queryDelta = materialQueryDelta(sourcePayload, payload);
  await writeFile(join(session, "data", "explore", "new-1.json"), JSON.stringify(rows));
  await writeFile(join(session, "data", "explore", "new-1.meta.json"), JSON.stringify({
    producer: "fetch-explore.mjs",
    producerVersion: 3,
    cacheContractVersion: 3,
    taskId: "new-1",
    fromCardId: "c1",
    status: "ok",
    attempts: [{ attempt: 1, status: 0 }],
    pagination: { mode: "all-pages", singlePage: false },
    queryDelta,
    queryPatch,
    queryPatchSha256: fingerprintJson(queryPatch),
    sourceQuerySha256: fingerprintJson(sourcePayload),
    executedQuerySha256: fingerprintJson(payload),
    rowCount: 2,
    rowsSha256: rowsSha256(rows),
  }));
  const evidence = await prepareResearchEvidence(resultPath, { taskId: "new-1" });
  await writeResearchCompletion(session, task, evidence, { pointer: "/views/groups/groups/0" });
  await assembleReport(session);
  let report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, true, report.errors.join("; "));

  task.evidenceGap = null;
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] }));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /new_query.*requires.*evidenceGap/.test(error)));
  task.evidenceGap = { type: "missing_dimension", reason: "需要新增品类维度" };
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] }));

  task.evidenceGap = { type: "missing_indicator", reason: "错误地声称缺指标" };
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] }));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /queryDelta does not address.*evidenceGap/.test(error)));
  task.evidenceGap = { type: "missing_dimension", reason: "需要新增品类维度" };
  await writeFile(tasksPath, JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] }));

  const metaPath = join(session, "data", "explore", "new-1.meta.json");
  const validMeta = JSON.parse(await readFile(metaPath, "utf8"));
  const meta = structuredClone(validMeta);
  meta.queryDelta.material = false;
  await writeFile(metaPath, JSON.stringify(meta));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /material queryDelta/.test(error)));

  await writeFile(metaPath, JSON.stringify(validMeta));
  const badDelta = structuredClone(validMeta);
  badDelta.queryDelta = { ...badDelta.queryDelta, changedKeys: [] };
  await writeFile(metaPath, JSON.stringify(badDelta));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /queryDelta cannot be reproduced from patch/.test(error)));
  await writeFile(metaPath, JSON.stringify(validMeta));

  const badPatchHash = { ...validMeta, queryPatchSha256: "0".repeat(64) };
  await writeFile(metaPath, JSON.stringify(badPatchHash));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /queryPatch hash mismatch/.test(error)));

  const badSourceFp = { ...validMeta, sourceQuerySha256: "0".repeat(64) };
  await writeFile(metaPath, JSON.stringify(badSourceFp));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /source query fingerprint mismatch/.test(error)));

  const badExecutedFp = { ...validMeta, executedQuerySha256: "0".repeat(64) };
  await writeFile(metaPath, JSON.stringify(badExecutedFp));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /executed query fingerprint mismatch/.test(error)));
  await writeFile(metaPath, JSON.stringify(validMeta));

  const evidencePath = evidence.evidencePath;
  const validEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const badViews = structuredClone(validEvidence);
  badViews.views.groups.groupCount = 999;
  await writeFile(evidencePath, JSON.stringify(badViews));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /evidence views do not match/.test(error)));

  const badCoverage = structuredClone(validEvidence);
  badCoverage.source.fieldCoverage = {};
  await writeFile(evidencePath, JSON.stringify(badCoverage));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /field metadata does not match/.test(error)));

  const badQueryCoverage = structuredClone(validEvidence);
  badQueryCoverage.source.queryCoverage = {};
  await writeFile(evidencePath, JSON.stringify(badQueryCoverage));
  report = await checkSessionLayout(session, { phase: "explore" });
  assert.ok(report.errors.some((error) => /queryCoverage does not match/.test(error)));
  await writeFile(evidencePath, JSON.stringify(validEvidence));
});

test("zero-row new_query evidence assembles and passes with noData summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-new-query-empty-"));
  const session = join(root, ".harness", "state", "html-report", "new-query-empty");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await mkdir(join(session, "data", "explore"), { recursive: true });
  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  const resultPath = join(session, "result.json");
  const sourcePayload = normalizeEntryPayload({
    metrics: ["profitAmt"],
    statisticPolicy: "SUMMARY",
    time: { startDate: "2026-07-01", endDate: "2026-07-02" },
    dimensions: ["bizDate"],
    filters: {},
  });
  await writeFile(resultPath, JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", title: "来源卡", query: { request: sourcePayload, comparisons: [] } }],
  }));
  const writerRows = [];
  await writeFile(join(session, "data", "cards", "c1", "entry.json"), JSON.stringify(writerRows));
  await writeFile(join(session, "data", "cards", "c1", "entry.meta.json"), JSON.stringify({
    rowCount: 0,
    rowsSha256: rowsSha256(writerRows),
  }));
  await writeFile(join(session, "analysis", "main.md"), "# main\n");
  const task = {
    id: "empty-new-1",
    fromCardId: "c1",
    status: "done",
    goal: "验证新增维度是否有数据",
    evidenceGap: { type: "missing_dimension", reason: "需要新增品类维度" },
    evidencePlan: {
      mode: "new_query",
      reason: "原明细没有品类维度",
      requiredColumns: ["品类", "毛利额"],
      operations: [{ id: "stats", type: "stats", fields: ["毛利额"] }],
    },
  };
  await writeFile(
    join(session, "analysis", "tasks.json"),
    JSON.stringify({ version: 2, round: 1, maxRounds: 2, tasks: [task] })
  );
  const payload = normalizeEntryPayload({
    ...sourcePayload,
    dimensions: ["categoryLevel1Id"],
  });
  const queryPatch = computeQueryPatch(sourcePayload, payload);
  const queryDelta = materialQueryDelta(sourcePayload, payload);
  const rows = [];
  await writeFile(join(session, "data", "explore", "empty-new-1.json"), JSON.stringify(rows));
  await writeFile(join(session, "data", "explore", "empty-new-1.meta.json"), JSON.stringify({
    producer: "fetch-explore.mjs",
    producerVersion: 3,
    cacheContractVersion: 3,
    taskId: "empty-new-1",
    fromCardId: "c1",
    status: "ok",
    attempts: [{ attempt: 1, status: 0 }],
    pagination: { mode: "all-pages", singlePage: false },
    queryDelta,
    queryPatch,
    queryPatchSha256: fingerprintJson(queryPatch),
    sourceQuerySha256: fingerprintJson(sourcePayload),
    executedQuerySha256: fingerprintJson(payload),
    rowCount: 0,
    rowsSha256: rowsSha256(rows),
  }));

  const evidence = await prepareResearchEvidence(resultPath, { taskId: task.id });
  assert.equal(evidence.source.empty, true);
  await writeResearchCompletion(session, task, evidence, {
    pointer: "/views/stats",
    summary: "新增维度查询合法返回 0 行，因此不推断趋势。",
  });
  const output = await assembleReport(session);
  const markdown = await readFile(output.reportPath, "utf8");
  assert.match(markdown, /html-report:full-explore-table task="empty-new-1" rows="0"/);
  assert.match(markdown, /本次探索查询返回 0 行明细/);
  const report = await checkSessionLayout(session, { phase: "explore" });
  assert.equal(report.ok, true, report.errors.join("; "));
});

test("checkSessionLayout html phase rejects hand-written HTML without Designer artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-layout-html-"));
  const session = join(root, ".harness", "state", "html-report", "sess-html");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedQualitySession(session);

  const missing = await checkSessionLayout(session, { phase: "html" });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /report\.html/i.test(e)));

  await writeFile(
    join(session, "report", "report.html"),
    "<!DOCTYPE html><html><body><table><tr><td>1</td></tr></table></body></html>"
  );
  const forged = await checkSessionLayout(session, { phase: "html" });
  assert.equal(forged.ok, false);
  assert.ok(forged.errors.some((error) => /design-input|compose-report|visual-check|design-result/i.test(error)));
});
