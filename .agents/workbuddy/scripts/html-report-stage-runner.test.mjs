import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  advance,
  buildDesignerPrompt,
  buildReviewerPrompt,
  buildWriterPrompt,
  cancel,
  htmlReportSessionDir,
  normalizeWriterChildValue,
  retryTask,
  reviewerScorecardSchema,
  runDesignStage,
  runEditorPlannerStage,
  runStageGate,
  runWriterForCard,
  runWriterStage,
  sanitizeSessionId,
  start,
  status,
  validateReviewerScorecard,
  writerSchema,
} from "./html-report-stage-runner.mjs";
import { rowsSha256 } from "../../../packages/html-report-kernel/src/index.mjs";
import {
  applyQueryPatch,
  canonicalizeJson,
  computeQueryPatch,
  materialQueryDelta,
  metricQueryFromCard,
  normalizeMetricQuery,
} from "../../../packages/html-report-kernel/src/index.mjs";
import {
  buildCodeBuddyChildArgs,
  codeBuddySensitiveValues,
  extractJsonObject,
  redactCodeBuddyOutput,
  resolveCodeBuddyCli,
  resolveDevelopmentCodeBuddy,
  resolveWorkBuddyCodeBuddy,
  validateJsonSchema,
} from "./codebuddy-child.mjs";
import {
  researcherReturnPaths,
  validateResearcherAnalysisRequirements,
} from "../../pi/skills/html-report/scripts/researcher-return.mjs";
import { buildResearcherSubmission } from "../../pi/skills/html-report/scripts/submit-research-findings.mjs";
import { designerReturnPaths } from "../../pi/skills/html-report/scripts/designer-return.mjs";
import {
  approvePipelineStage,
  retryPipelineStage,
} from "../../pi/skills/html-report/scripts/stage-gate.mjs";

function fixtureCard(cardId, overrides = {}) {
  return {
    id: cardId,
    chartType: "table",
    headingLevel: 2,
    query: {
      comparisons: ["YOY", "MOM"],
      request: {
        dimensions: ["bizDate", "regionId"],
        filters: {},
        metrics: ["saleAmt", "profitAmt"],
        pageNo: 1,
        pageSize: 500,
        statisticPolicy: "SALES_STORE_DAY_AVG",
        time: { startDate: "2026-01-01", endDate: "2026-01-31", grain: "DAY" },
      },
    },
    ...overrides,
  };
}

function fixtureResult(cards) {
  return {
    status: "confirmed",
    session_id: "test-session",
    title: "测试分析报告",
    userQuestion: "本月各区域销售表现如何？",
    cards,
  };
}

function makeSession({ cards } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hr-runner-test-"));
  const sessionDir = htmlReportSessionDir(root, "test-session");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "result.json"), JSON.stringify(fixtureResult(cards), null, 2));
  return { root, sessionDir, sessionId: "test-session" };
}

function writeCardFixtures(sessionDir, cardId, rows) {
  const cardDir = join(sessionDir, "data", "cards", cardId);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "entry.json"), JSON.stringify(rows, null, 2));
  writeFileSync(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: "0".repeat(64),
  }, null, 2));
  writeFileSync(join(cardDir, "entry.column-meta.json"), JSON.stringify({
    saleAmt: "销售额",
    profitAmt: "利润额",
    regionId: "区域",
    bizDate: "日期",
  }, null, 2));
}

/**
 * B25 路径需要 kernel 级校验（prepareSourceFieldInventory / check-session-layout）：
 * rowsSha256 必须是 rows 的真实指纹（"0".repeat(64) 无法通过）。
 */
function writeCardFixturesReal(sessionDir, cardId, rows) {
  const cardDir = join(sessionDir, "data", "cards", cardId);
  mkdirSync(cardDir, { recursive: true });
  writeFileSync(join(cardDir, "entry.json"), JSON.stringify(rows, null, 2));
  writeFileSync(join(cardDir, "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }, null, 2));
  writeFileSync(join(cardDir, "entry.column-meta.json"), JSON.stringify({
    saleAmt: "销售额",
    profitAmt: "利润额",
    regionId: "区域",
    bizDate: "日期",
  }, null, 2));
}

function rowsFixture() {
  return [
    { bizDate: "2026-01-05", regionId: "east", saleAmt: 120000, profitAmt: 30000, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
    { bizDate: "2026-01-06", regionId: "west", saleAmt: 40000, profitAmt: 10000, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
    { bizDate: "2026-01-07", regionId: "north", saleAmt: 90000, profitAmt: 25000, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
  ];
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** Walk the gate from init to B2_WRITER running (A_CONFIG is an approvalRequired gate). */
function driveGateToWriter(root, sessionId) {
  assert.equal(runStageGate(root, sessionId, "init", ["--mode", "step", "--session-id", sessionId]).ok, true, "init");
  assert.equal(runStageGate(root, sessionId, "start", ["--stage", "A_CONFIG"]).ok, true, "start A_CONFIG");
  assert.equal(runStageGate(root, sessionId, "finish", ["--stage", "A_CONFIG"]).ok, true, "finish A_CONFIG");
  assert.equal(runStageGate(root, sessionId, "approve", ["--phrase", "继续"]).ok, true, "approve A_CONFIG");
  assert.equal(runStageGate(root, sessionId, "finish", ["--stage", "B0_PREFLIGHT"]).ok, true, "finish B0_PREFLIGHT");
  const gate = runStageGate(root, sessionId, "status");
  assert.equal(gate.payload?.state?.currentStage, "B2_WRITER", `expected B2_WRITER, got ${gate.payload?.state?.currentStage}`);
}

/**
 * M3：走到 B25_EDITOR running。必须先经 Runner start 应用 policy（raw
 * runStageGate 不启用 B25/B3/B4/B5），再 raw finish/approve 依次推进。
 */
async function driveGateToEditor(root, sessionId) {
  const started = await start(root, sessionId);
  assert.equal(started.ok, true, started.error);
  assert.equal(runStageGate(root, sessionId, "finish", ["--stage", "A_CONFIG"]).ok, true, "finish A_CONFIG");
  assert.equal(runStageGate(root, sessionId, "approve", ["--phrase", "继续"]).ok, true, "approve A_CONFIG");
  assert.equal(runStageGate(root, sessionId, "finish", ["--stage", "B0_PREFLIGHT"]).ok, true, "finish B0_PREFLIGHT");
  assert.equal(runStageGate(root, sessionId, "finish", ["--stage", "B2_WRITER"]).ok, true, "finish B2_WRITER");
  assert.equal(runStageGate(root, sessionId, "finish", ["--stage", "B2_MAIN"]).ok, true, "finish B2_MAIN");
  assert.equal(runStageGate(root, sessionId, "approve", ["--phrase", "继续"]).ok, true, "approve B2_MAIN");
  const gate = runStageGate(root, sessionId, "status");
  assert.equal(gate.payload?.state?.currentStage, "B25_EDITOR", `expected B25_EDITOR, got ${gate.payload?.state?.currentStage}`);
}

/** 一份可通过 schema 与语义校验的 reuse_entry/ranking 编辑计划。 */
function validEditorPlan(cardId) {
  return {
    version: 1,
    tasks: [{
      fromCardId: cardId,
      goal: "梳理本月各区域销售排名",
      gap: "需要按销售额排序选出 Top 区域",
      mode: "reuse_entry",
      reason: "可用行已包含区域与销售额，直接排序即可回答",
      evidenceGap: null,
      candidateIndicators: [],
      candidateDims: [],
      operations: [{
        id: "op-top-sale",
        type: "topN",
        field: "saleAmt",
        fields: ["saleAmt", "regionId", "bizDate"],
        count: 3,
        direction: "desc",
      }],
      requirements: [{
        id: "req-top-sale",
        question: "本月销售额最高的区域与日期组合是哪些？",
        capability: "ranking",
        evidenceViewIds: ["op-top-sale"],
        targetRubric: ["R1", "R5"],
      }],
      successCriteria: "给出按销售额排序的 Top 记录，并说明排名依据",
      hint: "使用 op-top-sale 的排序结果",
    }],
    answerRequirements: [],
    noDeeperReason: null,
  };
}

/** sha256( canonicalizeJson )，与 kernel canonicalFingerprint / sha256Json 一致。 */
function sha256Hex(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

/** sha256( 原始文本 )，与 check-session-layout 的 fingerprintScanText 一致。 */
function textSha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** sha256( 原始字节 )，与 Pi sha256Text 的 Buffer 分支一致（截图指纹）。 */
function bufferSha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * B3 前置：先走 B25 物化研究计划，停在 B3_RESEARCH running。
 * 注意：advance 的 while 循环会从 B25（gate:false）自动级联进入 B3_RESEARCH
 * 并执行研究任务，因此这里直接用 runEditorPlannerStage 停在 B3 running，
 * 让各 B3 用例用自己的 researcher mock 单独 advance。
 */
async function driveToResearch(root, sessionId) {
  await driveGateToEditor(root, sessionId);
  const outcome = await runEditorPlannerStage(root, sessionId, {
    runChild: async () => ({ status: "completed", code: "ok", value: validEditorPlan("card-001"), message: "ok" }),
  });
  assert.equal(outcome.ok, true, outcome.error);
  const gate = runStageGate(root, sessionId, "status");
  assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH", `expected B3_RESEARCH, got ${gate.payload?.state?.currentStage}`);
  assert.equal(gate.payload?.state?.status, "running");
}

/** 复刻 Runner 的 expected 契约（taskId/mode/task/analysisRequirements/paths）。 */
function researcherExpected(sessionDir, taskId) {
  const document = JSON.parse(readFileSync(join(sessionDir, "analysis", "tasks.json"), "utf8"));
  const task = document.tasks.find((candidate) => String(candidate.id) === taskId);
  assert.ok(task, `task ${taskId} not found in tasks.json`);
  const checked = validateResearcherAnalysisRequirements(task);
  assert.equal(checked.ok, true, checked.errors?.join("; "));
  const paths = researcherReturnPaths({ sessionDir, taskId });
  return {
    taskId: String(task.id),
    mode: String(task.evidencePlan?.mode || ""),
    task,
    analysisRequirements: checked.requirements,
    ...paths,
  };
}

/** 依据当前物化的 evidence，构造一份可通过全部语义校验的 ranking findings。 */
function researcherRankingParams(evidence) {
  const view = evidence.views["op-top-sale"];
  assert.ok(view, "evidence must have an op-top-sale view");
  const top = view.rows[0].row;
  const bottom = view.rows[2].row;
  return {
    findings: [{
      requirementId: "req-top-sale",
      claim: `本月销售额最高的是${top.bizDate}${top.regionId}，${top.saleAmt}元；最低的是${bottom.bizDate}${bottom.regionId}，${bottom.saleAmt}元。`,
      evidencePointers: [
        "/views/op-top-sale/rows/0/row/bizDate",
        "/views/op-top-sale/rows/0/row/saleAmt",
        "/views/op-top-sale/rows/2/row/bizDate",
        "/views/op-top-sale/rows/2/row/saleAmt",
      ],
    }],
    suggestedDeeper: [],
  };
}

/** B3 mock runChild：用 Pi buildResearcherSubmission 重建合法 ok envelope（与 Runner 落盘一致）。 */
function mockOkResearcher(sessionDir, params) {
  return async () => {
    const expected = researcherExpected(sessionDir, "drill-001");
    const evidence = JSON.parse(readFileSync(expected.evidencePath, "utf8"));
    const built = buildResearcherSubmission(expected, evidence, params);
    return { status: "completed", code: "ok", value: built.researcherReturn, message: "ok" };
  };
}

/**
 * B3 mock fetchExplore：确定性写 explore 产物，meta 与 fetch-explore.mjs
 * 成功路径契约一致（queryDelta/queryPatch/hash/rowCount/rowsSha256）。
 */
function mockFetchExplore(sessionDir) {
  return async (resultPath, opts) => {
    const taskId = "drill-001";
    const outDir = join(sessionDir, "data", "explore");
    mkdirSync(outDir, { recursive: true });
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    const sourceCard = result.cards.find((card) => String(card?.id) === opts.fromCardId);
    const sourceQuery = metricQueryFromCard(sourceCard);
    const candidate = normalizeMetricQuery(opts.payload, { defaultComparisons: sourceQuery.comparisons });
    const queryDelta = materialQueryDelta(sourceQuery, candidate);
    const queryPatch = computeQueryPatch(sourceQuery, candidate);
    const rows = [
      { bizDate: "2026-01-05", regionId: "east", saleAmt: 120000, profitAmt: 30000, uv: 1800, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
      { bizDate: "2026-01-06", regionId: "west", saleAmt: 40000, profitAmt: 10000, uv: 900, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
      { bizDate: "2026-01-07", regionId: "north", saleAmt: 90000, profitAmt: 25000, uv: 1300, "saleAmt同比增长率": null, "saleAmt环比增长率": null, "profitAmt同比增长率": null, "profitAmt环比增长率": null },
    ];
    const meta = {
      producer: "fetch-explore.mjs",
      producerVersion: 3,
      sessionDir,
      resultPath,
      writtenAt: new Date().toISOString(),
      taskId,
      status: "ok",
      goal: opts.goal || "",
      fromCardId: opts.fromCardId || null,
      hint: opts.hint || "",
      queryDelta,
      queryDeltaSha256: sha256Hex(queryDelta),
      queryPatch,
      queryPatchSha256: sha256Hex(queryPatch),
      sourceQuerySha256: sha256Hex(sourceQuery),
      executedQuerySha256: sha256Hex(candidate),
      dataPath: join(outDir, `${taskId}.json`),
      rowCount: rows.length,
      rowsSha256: rowsSha256(rows),
      attempts: [{ attempt: 1, status: 0, durationMs: 5, signal: null, error: null, argsSummary: [] }],
      pagination: { mode: "all-pages", singlePage: false, pageSize: candidate.pageSize },
    };
    writeFileSync(join(outDir, `${taskId}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    writeFileSync(join(outDir, `${taskId}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);
    writeFileSync(join(outDir, `${taskId}.column-meta.json`), JSON.stringify({
      saleAmt: "销售额",
      profitAmt: "利润额",
      regionId: "区域",
      bizDate: "日期",
      uv: "用户数",
    }, null, 2));
    return meta;
  };
}

/** B3 mock runChild：dispatch 0 返回 needs_new_query，dispatch 1 返回合法 ok envelope。 */
function mockNeedsNewQueryResearcher(sessionDir) {
  let dispatch = 0;
  return async () => {
    if (dispatch === 0) {
      dispatch += 1;
      return {
        status: "completed",
        code: "ok",
        value: {
          taskId: "drill-001",
          status: "needs_new_query",
          evidenceModeUsed: "reuse_entry",
          evidenceGap: {
            type: "missing_indicator",
            reason: "需要用户数指标 uv 才能完整回答排名依据",
            requiredIndicators: ["uv"],
            requiredDims: [],
          },
        },
        message: "ok",
      };
    }
    dispatch += 1;
    const expected = researcherExpected(sessionDir, "drill-001");
    assert.equal(expected.mode, "new_query", "second dispatch must run with evidencePlan.mode=new_query");
    const evidence = JSON.parse(readFileSync(expected.evidencePath, "utf8"));
    const built = buildResearcherSubmission(expected, evidence, researcherRankingParams(evidence));
    return { status: "completed", code: "ok", value: built.researcherReturn, message: "ok" };
  };
}

/** Pi html-report design scripts 目录（真实脚本，B5 mock 通过 spawnSync 运行）。 */
const PI_SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "pi", "skills", "html-report", "scripts");

function runPiScript(sessionDir, script, extraArgs = []) {
  const scriptPath = join(PI_SCRIPTS_DIR, script);
  const spawned = spawnSync(process.execPath, [scriptPath, "--result", join(sessionDir, "result.json"), ...extraArgs], {
    cwd: sessionDir,
    encoding: "utf8",
  });
  assert.equal(spawned.status, 0, `${script} failed:\n${spawned.stderr || spawned.stdout}`);
  return spawned;
}

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, body) {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0);
  return Buffer.concat([length, typeBuf, body, crc]);
}
/** 生成一张 8bit RGB、filter-0 的真实 PNG（满足 pngViewport 校验）。 */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 2; // colorType RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const rowBytes = width * 3;
  const raw = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y += 1) raw[y * (1 + rowBytes)] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 走真实 Pi 脚本合成 B5 产物（compile → 写模板 → compose → capture 造假 →
 * draft → finalize-design），skipFinalize=true 时跳过 finalize-design 以模拟
 * child 声称 ok 但未产出 design-result.json。
 */
function fabricateDesignArtifacts(sessionDir, { skipFinalize = false } = {}) {
  const reportDir = join(sessionDir, "report");
  runPiScript(sessionDir, "compile-report-content.mjs");
  const template = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>{{HTML_REPORT_TITLE}}</title>",
    "</head>",
    "<body>",
    '<main id="report"><!-- HTML_REPORT_CONTENT --></main>',
    "</body>",
    "</html>",
  ].join("\n");
  writeFileSync(join(reportDir, "report.design.html"), template);
  runPiScript(sessionDir, "compose-report.mjs");

  const html = readFileSync(join(reportDir, "report.html"), "utf8");
  const screenshotsDir = join(reportDir, "screenshots");
  mkdirSync(screenshotsDir, { recursive: true });
  const screenshots = [
    { id: "desktop", viewport: "1440,1000", filename: "desktop-1440x1000.png", width: 1440, height: 1000 },
    { id: "mobile", viewport: "390,844", filename: "mobile-390x844.png", width: 390, height: 844 },
  ].map((shot) => {
    const png = makePng(shot.width, shot.height);
    const path = join(screenshotsDir, shot.filename);
    writeFileSync(path, png);
    return { id: shot.id, viewport: shot.viewport, path, bytes: png.length, sha256: bufferSha256(png) };
  });
  const visual = {
    producer: "capture-report.mjs",
    htmlPath: join(reportDir, "report.html"),
    htmlSha256: textSha256(html),
    screenshots,
  };
  writeFileSync(join(reportDir, "visual-check.json"), `${JSON.stringify(visual, null, 2)}\n`);
  const draft = {
    status: "pass",
    viewports: {
      desktop: { pass: true, notes: "桌面端布局正常" },
      mobile: { pass: true, notes: "移动端布局正常" },
    },
    notes: [],
  };
  writeFileSync(join(reportDir, "design-result.draft.json"), `${JSON.stringify(draft, null, 2)}\n`);
  if (!skipFinalize) {
    runPiScript(sessionDir, "finalize-design.mjs", ["--assessment-file", join(reportDir, "design-result.draft.json")]);
  }
}

/** B5 mock runChild：真实合成产物后返回 designer envelope（与 Pi 契约一致）。 */
function mockDesignerChild(sessionDir, { status = "ok", skipFinalize = false, tamper = null } = {}) {
  return async () => {
    fabricateDesignArtifacts(sessionDir, { skipFinalize });
    if (tamper) tamper(sessionDir);
    const expected = designerReturnPaths({ sessionDir });
    const failed = status === "failed";
    return {
      status: "completed",
      code: "ok",
      value: {
        status,
        paths: {
          reportHtml: expected.reportHtml,
          renderMeta: expected.renderMeta,
          designResult: expected.designResult,
          desktopScreenshot: expected.desktopScreenshot,
          mobileScreenshot: expected.mobileScreenshot,
        },
        layoutOk: !failed,
        repairRounds: 0,
        elapsedMs: 1234,
        residualNotes: failed ? ["模板可见缺陷未修复"] : [],
        ...(failed ? { error: "截图校验失败：桌面端内容溢出" } : {}),
      },
      message: "ok",
    };
  };
}

/** B5 前置：走完 B4 质量审核并 approve B4，停在 B5_DESIGN running。 */
async function driveToDesign(root, sessionId) {
  const sessionDir = htmlReportSessionDir(root, sessionId);
  const reviewed = await advance(root, sessionId, {
    runChild: async () => ({ status: "completed", code: "ok", value: passingScorecard(), message: "ok" }),
  });
  assert.equal(reviewed.ok, true, reviewed.message);
  const gate = runStageGate(root, sessionId, "status");
  assert.equal(gate.payload?.state?.currentStage, "B4_REVIEW");
  assert.equal(gate.payload?.state?.status, "awaiting_approval");
  const approved = await approvePipelineStage(sessionDir, { phrase: "继续" });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const after = runStageGate(root, sessionId, "status");
  assert.equal(after.payload?.state?.currentStage, "B5_DESIGN", `expected B5_DESIGN, got ${after.payload?.state?.currentStage}`);
  assert.equal(after.payload?.state?.status, "running");
}

test("sanitizeSessionId strips unsafe chars", () => {
  assert.equal(sanitizeSessionId("a b/c:待"), "a_b_c__");
  assert.equal(sanitizeSessionId("safe.id-1_2"), "safe.id-1_2");
});

test("htmlReportSessionDir nests under .harness/state/html-report", () => {
  const dir = htmlReportSessionDir("/repo", "sid-1");
  assert.equal(dir, join("/repo", ".harness", "state", "html-report", "sid-1"));
});

test("writerSchema pins role and cardId", () => {
  const schema = writerSchema("card-001");
  const ok = validateJsonSchema({ role: "report-writer", taskId: "t1", cardId: "card-001", paragraphs: ["x"] }, schema);
  assert.equal(ok.ok, true);
  const badRole = validateJsonSchema({ role: "writer", taskId: "t1", cardId: "card-001", paragraphs: ["x"] }, schema);
  assert.equal(badRole.ok, false);
  const badCard = validateJsonSchema({ role: "report-writer", taskId: "t1", cardId: "other", paragraphs: ["x"] }, schema);
  assert.equal(badCard.ok, false);
  const extra = validateJsonSchema({ role: "report-writer", taskId: "t1", cardId: "card-001", paragraphs: ["x"], conclusion: "y" }, schema);
  assert.equal(extra.ok, false, "additionalProperties:false must reject conclusion");
});

test("buildWriterPrompt embeds cardId and capsule, forbids conclusion field", () => {
  const evidence = {
    query: { metrics: ["saleAmt"], dimensions: ["regionId"], time: { startDate: "2026-01-01", endDate: "2026-01-31", grain: "DAY" } },
    views: {},
    columnLabels: {},
  };
  const prompt = buildWriterPrompt({ cardId: "card-001", evidence });
  assert.match(prompt, /cardId=card-001/);
  assert.match(prompt, /capsule JSON/);
  assert.match(prompt, /不要用 conclusion 等其他字段名/);
});

test("normalizeWriterChildValue accepts exact paragraphs and aliases conclusion", () => {
  const exact = normalizeWriterChildValue({ role: "report-writer", taskId: "t1", cardId: "card-001", paragraphs: ["华东最高 12 万"] }, "card-001");
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.value.paragraphs, ["华东最高 12 万"]);

  const alias = normalizeWriterChildValue({ role: "report-writer", taskId: "t1", cardId: "card-001", conclusion: ["华南最低 3 万"] }, "card-001");
  assert.equal(alias.ok, true);
  assert.deepEqual(alias.value.paragraphs, ["华南最低 3 万"]);

  const wrongRole = normalizeWriterChildValue({ role: "writer", taskId: "t1", cardId: "card-001", paragraphs: ["x"] }, "card-001");
  assert.equal(wrongRole.ok, false);

  const wrongCard = normalizeWriterChildValue({ role: "report-writer", taskId: "t1", cardId: "other", paragraphs: ["x"] }, "card-001");
  assert.equal(wrongCard.ok, false);

  const empty = normalizeWriterChildValue({ role: "report-writer", taskId: "t1", cardId: "card-001", paragraphs: [] }, "card-001");
  assert.equal(empty.ok, false);
});

test("extractJsonObject pulls first object from prose", () => {
  assert.deepEqual(extractJsonObject('先写说明\n{"a": 1}\n结尾'), { a: 1 });
  assert.deepEqual(extractJsonObject('{"x": {"y": 2}} tail'), { x: { y: 2 } });
  assert.equal(extractJsonObject("没有 JSON"), null);
  assert.equal(extractJsonObject('[1,2,3]'), null);
});

test("buildCodeBuddyChildArgs disables all tools and pins model", () => {
  const args = buildCodeBuddyChildArgs({ cli: "/cli/codebuddy", prompt: "p", schema: { type: "object" }, sessionId: "s-1", model: "custom-local:gpt-5.5", tools: [] });
  assert.deepEqual(args.command, "/cli/codebuddy");
  const joined = args.args.join(" ");
  assert.match(joined, /--tools /);
  assert.match(joined, /--model custom-local:gpt-5.5/);
  assert.match(joined, /--session-id s-1/);
  assert.throws(() => buildCodeBuddyChildArgs({ cli: "relative", prompt: "p", schema: {}, sessionId: "s" }), /absolute/);
});

test("validateJsonSchema enforces required and const", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.equal(validateJsonSchema({ a: "x" }, schema).ok, true);
  assert.equal(validateJsonSchema({}, schema).ok, false);
});

test("validateJsonSchema supports oneOf, pattern, and uniqueItems (from ref codebuddy-process)", () => {
  const oneOf = { oneOf: [{ type: "string" }, { type: "number" }] };
  assert.equal(validateJsonSchema("x", oneOf).ok, true);
  assert.equal(validateJsonSchema(3, oneOf).ok, true);
  assert.equal(validateJsonSchema(null, oneOf).ok, false);
  assert.equal(validateJsonSchema("x", { oneOf: [{ type: "string" }, { type: "string" }] }).ok, false, "exactly one branch");

  const pattern = { type: "string", pattern: "^[a-f0-9]{64}$" };
  assert.equal(validateJsonSchema("a".repeat(64), pattern).ok, true);
  assert.equal(validateJsonSchema("not-hex", pattern).ok, false);

  const unique = { type: "array", items: { type: "number" }, uniqueItems: true };
  assert.equal(validateJsonSchema([1, 2], unique).ok, true);
  assert.equal(validateJsonSchema([1, 1], unique).ok, false);
});

test("redactCodeBuddyOutput scrubs metric secrets and sensitive env values", () => {
  const blob = "qdm1enc.abc123";
  const token = "secret-token-value";
  const out = redactCodeBuddyOutput(`blob=${blob} HARNESS_AUTH_BLOB=${blob} QDM_TOKEN=${token}`, [token]);
  assert.ok(!out.includes(blob), "metric blob must be redacted");
  assert.ok(!out.includes(token), "sensitive source value must be redacted");
  assert.match(out, /<redacted>/);
});

test("codeBuddySensitiveValues collects sensitive env values", () => {
  const values = codeBuddySensitiveValues({
    HARNESS_AUTH_BLOB: "qdm1enc.zzz",
    HARNESS_AUTH_BLOB_FILE: "/secret/blob",
    QDM_METRIC_TOKEN: "tok",
    OTHER: "keep-me",
  });
  assert.deepEqual(values.sort(), ["/secret/blob", "qdm1enc.zzz", "tok"]);
});

test("resolveDevelopmentCodeBuddy validates absolute launcher and node paths", () => {
  const nodePath = process.execPath;
  const launcherPath = resolveCodeBuddyCli();
  const resolved = resolveDevelopmentCodeBuddy({ launcherPath, nodePath });
  assert.equal(resolved.launcherPath, launcherPath);
  assert.equal(resolved.nodePath, nodePath);
  assert.throws(() => resolveDevelopmentCodeBuddy({ launcherPath: "relative/path", nodePath }), /absolute/);
});

test("resolveWorkBuddyCodeBuddy fails closed when WorkBuddy.app is absent", () => {
  // Never point at a real app in tests; use a non-existent path and expect fail-closed.
  assert.throws(() => resolveWorkBuddyCodeBuddy({ appPath: "/Applications/Definitely-Not-WorkBuddy.app" }), /unavailable|macOS only/i);
});

test("runStageGate fails closed on stage-gate non-zero exit", () => {
  const { root, sessionId } = makeSession();
  try {
    // Init once so the session exists; then ask for an operation that must fail.
    assert.equal(runStageGate(root, sessionId, "init", ["--mode", "step", "--session-id", sessionId]).ok, true);
    const result = runStageGate(root, sessionId, "start", ["--stage", "B2_WRITER"]);
    // A_CONFIG is current; starting B2_WRITER is a stage mismatch → exit 1.
    assert.equal(result.ok, false);
    assert.match(result.error, /stage mismatch/i);
  } finally {
    cleanup(root);
  }
});

test("stage-gate init + start A_CONFIG via runStageGate (real stage-gate script)", () => {
  const { root, sessionDir, sessionId } = makeSession();
  try {
    const init = runStageGate(root, sessionId, "init", ["--mode", "step", "--session-id", sessionId]);
    assert.equal(init.ok, true, init.error);
    assert.equal(init.payload?.state?.currentStage, "A_CONFIG");
    const start0 = runStageGate(root, sessionId, "start", ["--stage", "A_CONFIG"]);
    assert.equal(start0.ok, true);
    const st = runStageGate(root, sessionId, "status");
    assert.equal(st.ok, true);
    assert.equal(st.payload?.state?.currentStage, "A_CONFIG");
    assert.equal(st.payload?.exists, true);
  } finally {
    cleanup(root);
  }
});

test("resolveCodeBuddyCli finds codebuddy on PATH", () => {
  const env = { PATH: process.env.PATH || "/usr/bin:/bin", CODEBUDDY_CLI: "" };
  const cli = resolveCodeBuddyCli(env);
  assert.ok(cli, "should resolve a codebuddy CLI path");
});

test("start + status + cancel on a fresh session", async () => {
  const { root, sessionId } = makeSession();
  try {
    const started = await start(root, sessionId);
    assert.equal(started.ok, true, started.error);
    // start 会程序化启用 M3-M5 policy（B25/B3/B4/B5 enabled）
    const statePath = join(htmlReportSessionDir(root, sessionId), "debug", "pipeline-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.policy?.B25_EDITOR?.enabled, true, "policy must enable B25_EDITOR");
    assert.equal(state.policy?.B3_RESEARCH?.enabled, true, "policy must enable B3_RESEARCH");
    assert.equal(state.policy?.B5_DESIGN?.enabled, true, "policy must enable B5_DESIGN");
    const st = status(root, sessionId);
    assert.equal(st.ok, true);
    assert.equal(st.exists, true);
    assert.equal(st.state.currentStage, "A_CONFIG");
    const cancelled = cancel(root, sessionId);
    assert.equal(cancelled.ok, true, cancelled.error);
  } finally {
    cleanup(root);
  }
});

test("status on a missing session returns a clear prompt, not a crash", () => {
  const { root } = makeSession();
  try {
    const st = status(root, "no-such-session-xyz");
    assert.equal(st.ok, true);
    assert.equal(st.exists, false);
    assert.match(st.message, /尚未初始化/);
  } finally {
    cleanup(root);
  }
});

test("M1 runWriterForCard writes caption and persists violations on a bad number", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    const rows = rowsFixture();
    writeCardFixtures(sessionDir, cardId, rows);

    const fetchEntries = async (resultPath, opts) => {
      assert.equal(opts.cardId, cardId);
      return { producer: "fetch-entry.mjs", cards: [{ cardId, fetchStatus: "success", rowCount: rows.length, rowsSha256: "0".repeat(64) }] };
    };
    const runChild = async (opts) => {
      assert.equal(opts.schema.properties.cardId.const, cardId);
      // Valid child: paragraphs cite numbers present in the evidence views.
      return {
        status: "completed",
        code: "ok",
        value: { role: "report-writer", taskId: cardId, cardId, paragraphs: ["销售额最高的是1月5日东部，120000元；最低是1月6日西部，40000元"] },
        message: "ok",
      };
    };

    const attempt = await runWriterForCard(root, sessionId, cardId, { fetchEntries, runChild });
    assert.equal(attempt.status, "committed", attempt.error);
    const captionPath = join(sessionDir, "data", "cards", cardId, "caption.md");
    assert.equal(existsSync(captionPath), true);
    assert.ok(readFileSync(captionPath, "utf8").trim().length > 0);
    // writeCardCaption also writes an empty violations record next to caption.md
    const violationsPath = join(sessionDir, "data", "cards", cardId, "caption.md.violations.json");
    assert.equal(existsSync(violationsPath), true);

    // Bad number not in evidence → fail closed, no caption.md, violations persisted.
    const runChildBad = async () => ({
      status: "completed",
      code: "ok",
      value: { role: "report-writer", taskId: cardId, cardId, paragraphs: ["总额高达 999999 元"] },
      message: "ok",
    });
    const attempt2 = await runWriterForCard(root, sessionId, cardId, { fetchEntries, runChild: runChildBad });
    assert.equal(attempt2.status, "failed");
    assert.match(attempt2.error, /违规|caption/i);
    assert.equal(existsSync(join(sessionDir, "data", "cards", cardId, "caption.violations.json")), true);
  } finally {
    cleanup(root);
  }
});

test("M1 runWriterStage writes caption and advances gate to B2_MAIN (mocked fetch + child)", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    driveGateToWriter(root, sessionId);
    const rows = rowsFixture();
    writeCardFixtures(sessionDir, cardId, rows);

    const fetchEntries = async (resultPath, opts) => {
      assert.equal(opts.cardId, cardId);
      return { producer: "fetch-entry.mjs", cards: [{ cardId, fetchStatus: "success", rowCount: rows.length, rowsSha256: "0".repeat(64) }] };
    };
    const runChild = async (opts) => ({
      status: "completed",
      code: "ok",
      value: { role: "report-writer", taskId: cardId, cardId, paragraphs: ["销售额最高的是1月5日东部，120000元；最低是1月6日西部，40000元"] },
      message: "ok",
    });

    const outcome = await runWriterStage(root, sessionId, { fetchEntries, runChild });
    assert.equal(outcome.ok, true, outcome.message || outcome.error);
    assert.equal(existsSync(join(sessionDir, "data", "cards", cardId, "caption.md")), true);
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B2_MAIN", "gate should advance to B2_MAIN");
  } finally {
    cleanup(root);
  }
});

test("M1 runWriterStage isolates a failing card (mocked)", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    driveGateToWriter(root, sessionId);
    const rows = rowsFixture();
    writeCardFixtures(sessionDir, cardId, rows);

    const fetchEntries = async (resultPath, opts) => ({
      producer: "fetch-entry.mjs",
      cards: [{ cardId, fetchStatus: "success", rowCount: rows.length, rowsSha256: "0".repeat(64) }],
    });
    const runChild = async () => ({ status: "failed", code: "child_exit_nonzero", message: "child failed" });

    const outcome = await runWriterStage(root, sessionId, { fetchEntries, runChild });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /失败/);
    // caption.md must NOT be written; violations record IS persisted
    assert.equal(existsSync(join(sessionDir, "data", "cards", cardId, "caption.md")), false);
    assert.equal(existsSync(join(sessionDir, "data", "cards", cardId, "caption.violations.json")), true);
    // gate must NOT be advanced past B2_WRITER
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B2_WRITER");
  } finally {
    cleanup(root);
  }
});

test("M1 runWriterStage card isolation: one bad card does not block the next good card", async () => {
  const goodId = "card-good";
  const badId = "card-bad";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(goodId), fixtureCard(badId)] });
  try {
    driveGateToWriter(root, sessionId);
    writeCardFixtures(sessionDir, goodId, rowsFixture());
    writeCardFixtures(sessionDir, badId, rowsFixture());

    const fetchEntries = async (resultPath, opts) => ({
      producer: "fetch-entry.mjs",
      cards: [{ cardId: opts.cardId, fetchStatus: "success", rowCount: 3, rowsSha256: "0".repeat(64) }],
    });
    const runChild = async (opts) => {
      if (opts.schema.properties.cardId.const === badId) {
        return { status: "failed", code: "child_exit_nonzero", message: "bad card child failed" };
      }
      return {
        status: "completed",
        code: "ok",
        value: { role: "report-writer", taskId: opts.schema.properties.cardId.const, cardId: opts.schema.properties.cardId.const, paragraphs: ["销售额最高的是1月5日东部，120000元；最低是1月6日西部，40000元"] },
        message: "ok",
      };
    };

    const outcome = await runWriterStage(root, sessionId, { fetchEntries, runChild });
    assert.equal(outcome.ok, false, "stage must report failure");
    assert.deepEqual(outcome.failed.map((item) => item.cardId), [badId]);
    assert.deepEqual(outcome.succeeded, [goodId]);
    // good card caption written, bad card caption absent
    assert.equal(existsSync(join(sessionDir, "data", "cards", goodId, "caption.md")), true);
    assert.equal(existsSync(join(sessionDir, "data", "cards", badId, "caption.md")), false);
    // gate stays on B2_WRITER (not finished)
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B2_WRITER");

    // retry the bad card with a working child → committed
    const retryRunChild = async (opts) => ({
      status: "completed",
      code: "ok",
      value: { role: "report-writer", taskId: badId, cardId: badId, paragraphs: ["销售额最高的是1月5日东部，120000元；最低是1月6日西部，40000元"] },
      message: "ok",
    });
    const retried = await retryTask(root, sessionId, badId, { fetchEntries, runChild: retryRunChild });
    assert.equal(retried.ok, true, retried.error);
    assert.equal(existsSync(join(sessionDir, "data", "cards", badId, "caption.md")), true);
  } finally {
    cleanup(root);
  }
});

test("M3 B25 fail-closed: invalid editor plan is rejected, no artifacts, gate stays on B25_EDITOR", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    await driveGateToEditor(root, sessionId);
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());

    const runChild = async () => ({
      status: "completed",
      code: "ok",
      value: {
        ...validEditorPlan(cardId),
        tasks: [{ ...validEditorPlan(cardId).tasks[0], operations: [{ id: "op-top-sale", type: "topN", field: "bogusField", fields: ["saleAmt", "regionId"], count: 3 }] }],
      },
      message: "ok",
    });

    const outcome = await advance(root, sessionId, { runChild });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /Editor Planner 返回校验失败/);
    // 失败不得写任何正式 session 产物，也不得推进 Gate。
    assert.equal(existsSync(join(sessionDir, "analysis", "tasks.json")), false, "tasks.json must not be written");
    assert.equal(existsSync(join(sessionDir, "analysis", "main.md")), false, "main.md must not be written");
    assert.equal(existsSync(join(sessionDir, "report", "report.md")), false, "report must not be assembled");
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B25_EDITOR", "gate must stay on B25_EDITOR");
    assert.equal(gate.payload?.state?.status, "running");
  } finally {
    cleanup(root);
  }
});

test("M3 B25 happy path: materialize version-2 research plan and advance to B3_RESEARCH", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    await driveGateToEditor(root, sessionId);
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());

    const runChild = async (opts) => {
      assert.equal(opts.schema.properties.version.const, 1, "child schema must pin plan version 1");
      return { status: "completed", code: "ok", value: validEditorPlan(cardId), message: "ok" };
    };

    // B25 是 gate:false 自动阶段，用 runEditorPlannerStage 直接物化并停在 B3_RESEARCH running
    // （advance 的全循环 B25→B3 级联由专门的 full-advance 用例覆盖）。
    const outcome = await runEditorPlannerStage(root, sessionId, { runChild });
    assert.equal(outcome.ok, true, outcome.message);
    assert.match(outcome.message, /B25_EDITOR 已物化研究计划（1 个任务）/);

    // 研究计划物化为版本 2 的 tasks.json + main.md。
    const tasksPath = join(sessionDir, "analysis", "tasks.json");
    const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    assert.equal(tasks.version, 2);
    assert.equal(tasks.tasks.length, 1);
    const task = tasks.tasks[0];
    assert.equal(task.id, "drill-001");
    assert.equal(task.status, "pending");
    assert.equal(task.analysisContractVersion, 1);
    assert.equal(task.evidencePlan.mode, "reuse_entry");
    assert.equal(task.evidencePlan.sourceCardId, cardId);
    assert.ok(Array.isArray(task.analysisRequirements) && task.analysisRequirements.length === 1);
    assert.equal(existsSync(join(sessionDir, "analysis", "main.md")), true);

    // reuse_entry 已由 finalizer 预生成 evidence 包。
    assert.equal(existsSync(join(sessionDir, "analysis", "evidence", "drill-001.json")), true, "prepared evidence packet must exist");

    // B2.5 finalizer 顺带组装 report 骨架（report.md + render-manifest.json）。
    assert.equal(existsSync(join(sessionDir, "report", "report.md")), true, "report.md must be assembled");
    assert.equal(existsSync(join(sessionDir, "report", "render-manifest.json")), true, "render-manifest.json must be assembled");

    // B25_EDITOR gate:false → 自动推进到 B3_RESEARCH running。
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH", `expected B3_RESEARCH, got ${gate.payload?.state?.currentStage}`);
    assert.equal(gate.payload?.state?.status, "running");
  } finally {
    cleanup(root);
  }
});

test("M3 B3 full advance: one advance from B25_EDITOR cascades planner + research and stops at awaiting_approval", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveGateToEditor(root, sessionId);

    // 一次 advance：B25（planner schema 有 version.const=1）→ 级联 B3（researcher schema）。
    const runChild = async (opts) => {
      if (opts.schema?.properties?.version?.const === 1) {
        return { status: "completed", code: "ok", value: validEditorPlan(cardId), message: "ok" };
      }
      const expected = researcherExpected(sessionDir, "drill-001");
      const evidence = JSON.parse(readFileSync(expected.evidencePath, "utf8"));
      const built = buildResearcherSubmission(expected, evidence, researcherRankingParams(evidence));
      return { status: "completed", code: "ok", value: built.researcherReturn, message: "ok" };
    };

    const outcome = await advance(root, sessionId, { runChild });
    assert.equal(outcome.ok, true, outcome.message);
    assert.match(outcome.message, /B25_EDITOR 已物化研究计划（1 个任务）/);
    assert.match(outcome.message, /B3_RESEARCH 完成 1 个任务/);

    // B25 物化 + B3 研究结论均在一次 advance 内落盘。
    const tasks = JSON.parse(readFileSync(join(sessionDir, "analysis", "tasks.json"), "utf8"));
    assert.equal(tasks.tasks[0].status, "done");
    assert.equal(existsSync(join(sessionDir, "analysis", "sections", "explore-drill-001.md")), true, "section must be persisted");

    // B3 为人工 Gate：级联推进停在 awaiting_approval，Runner 不自动批准。
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH", `expected B3_RESEARCH, got ${gate.payload?.state?.currentStage}`);
    assert.equal(gate.payload?.state?.status, "awaiting_approval");
  } finally {
    cleanup(root);
  }
});

test("M3 B3 reuse_entry: serial dispatch, Pi persist, finalize, and stop at awaiting_approval", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToResearch(root, sessionId);

    const params = researcherRankingParams(JSON.parse(readFileSync(join(sessionDir, "analysis", "evidence", "drill-001.json"), "utf8")));
    const outcome = await advance(root, sessionId, { runChild: mockOkResearcher(sessionDir, params) });
    assert.equal(outcome.ok, true, outcome.message);
    assert.match(outcome.message, /B3_RESEARCH 完成 1 个任务/);

    // 任务终态 + Pi 落盘产物（section + summary）。
    const tasks = JSON.parse(readFileSync(join(sessionDir, "analysis", "tasks.json"), "utf8"));
    assert.equal(tasks.tasks[0].status, "done");
    assert.equal(existsSync(join(sessionDir, "analysis", "sections", "explore-drill-001.md")), true, "section must be persisted");
    assert.equal(existsSync(join(sessionDir, "analysis", "sections", "explore-drill-001.summary.json")), true, "summary must be persisted");

    // reuse_entry 不产生 data/explore 产物。
    assert.equal(existsSync(join(sessionDir, "data", "explore", "drill-001.json")), false, "reuse_entry must not create explore data");

    // B3 为人工 Gate：停在 awaiting_approval，Runner 不自动批准。
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH", `expected B3_RESEARCH, got ${gate.payload?.state?.currentStage}`);
    assert.equal(gate.payload?.state?.status, "awaiting_approval", "B3 must stop at awaiting_approval");
  } finally {
    cleanup(root);
  }
});

test("M3 B3 needs_new_query: deterministic candidate query closes the gap, successor persisted, then ok", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToResearch(root, sessionId);

    const outcome = await advance(root, sessionId, {
      runChild: mockNeedsNewQueryResearcher(sessionDir),
      fetchExplore: mockFetchExplore(sessionDir),
    });
    assert.equal(outcome.ok, true, outcome.message);
    assert.match(outcome.message, /B3_RESEARCH 完成 1 个任务/);

    // 后继任务持久化：mode=new_query + evidenceGap + candidateIndicators 含 uv。
    const tasks = JSON.parse(readFileSync(join(sessionDir, "analysis", "tasks.json"), "utf8"));
    const task = tasks.tasks[0];
    assert.equal(task.status, "done");
    assert.equal(task.evidencePlan.mode, "new_query");
    assert.equal(task.evidenceGap.type, "missing_indicator");
    assert.ok(task.candidateIndicators.includes("uv"), "candidateIndicators must include uv");
    assert.equal(task.candidateDims.length, 0);

    // 确定性补查产物存在，且 meta 与 fetch-explore.mjs 契约一致。
    const metaPath = join(sessionDir, "data", "explore", "drill-001.meta.json");
    const dataPath = join(sessionDir, "data", "explore", "drill-001.json");
    assert.equal(existsSync(metaPath), true, "explore meta must exist");
    assert.equal(existsSync(dataPath), true, "explore data must exist");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    assert.equal(meta.producer, "fetch-explore.mjs");
    assert.equal(meta.status, "ok");
    assert.equal(meta.queryDelta.material, true);
    assert.equal(meta.queryPatchSha256, sha256Hex(meta.queryPatch));
    const result = JSON.parse(readFileSync(join(sessionDir, "result.json"), "utf8"));
    const sourceCard = result.cards.find((card) => String(card?.id) === cardId);
    assert.equal(meta.sourceQuerySha256, sha256Hex(metricQueryFromCard(sourceCard)), "source query fingerprint mismatch");

    // 终态 + 人工 Gate 停在 awaiting_approval。
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH");
    assert.equal(gate.payload?.state?.status, "awaiting_approval");
  } finally {
    cleanup(root);
  }
});

test("M3 B3 fail-closed: second needs_new_query exhausts the single retry, nothing persists, gate stays running", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToResearch(root, sessionId);

    // 每次 dispatch 都返回 needs_new_query；第二次（mode 已变为 new_query）命中
    // dispatch===1 的 successor_exhausted 分支。evidenceModeUsed 须跟随当前 task 模式。
    let calls = 0;
    const runChild = async () => {
      calls += 1;
      return {
        status: "completed",
        code: "ok",
        value: {
          taskId: "drill-001",
          status: "needs_new_query",
          evidenceModeUsed: calls === 1 ? "reuse_entry" : "new_query",
          evidenceGap: { type: "missing_indicator", reason: "仍缺指标", requiredIndicators: ["uv"], requiredDims: [] },
        },
        message: "ok",
      };
    };
    const outcome = await advance(root, sessionId, { runChild, fetchExplore: mockFetchExplore(sessionDir) });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "successor_exhausted");
    assert.match(outcome.error, /已耗尽唯一一次补查/);

    // 不落任何结论产物，任务保持 pending，Gate 停留在 B3_RESEARCH running。
    assert.equal(existsSync(join(sessionDir, "analysis", "sections", "explore-drill-001.md")), false, "no section must be persisted");
    const tasks = JSON.parse(readFileSync(join(sessionDir, "analysis", "tasks.json"), "utf8"));
    assert.equal(tasks.tasks[0].status, "pending");
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH");
    assert.equal(gate.payload?.state?.status, "running");
  } finally {
    cleanup(root);
  }
});

test("M3 B3 fail-closed: invalid researcher return is rejected, no artifacts, gate stays running", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToResearch(root, sessionId);

    // summary 为空 → validateResearcherReturn 拒绝（return_invalid）。
    const runChild = async () => ({
      status: "completed",
      code: "ok",
      value: {
        taskId: "drill-001",
        status: "ok",
        evidenceModeUsed: "reuse_entry",
        evidencePath: "x",
        sectionPath: "y",
        summaryPath: "z",
        summary: "",
        noData: false,
        evidencePointers: ["/views/op-top-sale/rows/0/row/saleAmt"],
        findings: [{ requirementId: "req-top-sale", claim: "c", evidencePointers: ["/views/op-top-sale/rows/0/row/saleAmt"] }],
        selfCheck: { modeCompliant: true, evidenceTraceable: true, hasContrastOrBreakdown: false, answersGoal: true, queryJustified: null },
        suggestedDeeper: [],
      },
      message: "ok",
    });
    const outcome = await advance(root, sessionId, { runChild });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "return_invalid");
    assert.match(outcome.error, /返回无效/);

    assert.equal(existsSync(join(sessionDir, "analysis", "sections", "explore-drill-001.md")), false, "no section must be persisted");
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH");
    assert.equal(gate.payload?.state?.status, "running");
  } finally {
    cleanup(root);
  }
});

test("M3 B3 anti-fabrication: child envelope diverging from Pi rebuild is rejected (return_inconsistent)", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToResearch(root, sessionId);

    const runChild = async () => {
      const expected = researcherExpected(sessionDir, "drill-001");
      const evidence = JSON.parse(readFileSync(expected.evidencePath, "utf8"));
      const built = buildResearcherSubmission(expected, evidence, researcherRankingParams(evidence));
      // 伪造：child 返回里塞一个 findings 未引用的证据指针（过 envelope 校验，但 Pi 重建不含它）。
      return {
        status: "completed",
        code: "ok",
        value: {
          ...built.researcherReturn,
          evidencePointers: [...built.researcherReturn.evidencePointers, "/views/op-top-sale/rows/1/row/saleAmt"],
        },
        message: "ok",
      };
    };
    const outcome = await advance(root, sessionId, { runChild });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "return_inconsistent");
    assert.match(outcome.error, /疑似伪造/);

    assert.equal(existsSync(join(sessionDir, "analysis", "sections", "explore-drill-001.md")), false, "no section must be persisted");
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH");
    assert.equal(gate.payload?.state?.status, "running");
  } finally {
    cleanup(root);
  }
});

test("M3 B3 empty tasks: no pending research tasks finalizes cleanly and advances to awaiting_approval", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToResearch(root, sessionId);

    // 空任务：无 pending 研究任务（等价于 B25 已全部派工/完成）。
    writeFileSync(join(sessionDir, "analysis", "tasks.json"), JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] }, null, 2));

    const outcome = await advance(root, sessionId);
    assert.equal(outcome.ok, true, outcome.message);
    assert.match(outcome.message, /B3_RESEARCH 完成 0 个任务/);

    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B3_RESEARCH");
    assert.equal(gate.payload?.state?.status, "awaiting_approval");
  } finally {
    cleanup(root);
  }
});

test("advance on a disabled stage reports 未启用 and does not change state", async () => {
  const { root, sessionDir, sessionId } = makeSession();
  try {
    // Real init/start so we have a valid stage-gate state, then hand-edit currentStage
    // into a disabled stage (B3_RESEARCH) to exercise the runner's disabled branch.
    assert.equal(runStageGate(root, sessionId, "init", ["--mode", "step", "--session-id", sessionId]).ok, true);
    assert.equal(runStageGate(root, sessionId, "start", ["--stage", "A_CONFIG"]).ok, true);
    const statePath = join(sessionDir, "debug", "pipeline-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.currentStage = "B3_RESEARCH";
    state.status = "paused";
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const outcome = await advance(root, sessionId);
    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /未启用/);
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(after.currentStage, "B3_RESEARCH", "state must not change on a disabled stage");
    assert.equal(after.status, "paused");
  } finally {
    cleanup(root);
  }
});

/** B3 合法结论：走完 B25+B3，approve B3 后停在 B4_REVIEW running。 */
async function driveToReview(root, sessionId) {
  await driveToResearch(root, sessionId);
  const params = researcherRankingParams(JSON.parse(readFileSync(join(htmlReportSessionDir(root, sessionId), "analysis", "evidence", "drill-001.json"), "utf8")));
  const outcome = await advance(root, sessionId, { runChild: mockOkResearcher(htmlReportSessionDir(root, sessionId), params) });
  assert.equal(outcome.ok, true, outcome.message);
  const approved = await approvePipelineStage(htmlReportSessionDir(root, sessionId), { phrase: "继续" });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const gate = runStageGate(root, sessionId, "status");
  assert.equal(gate.payload?.state?.currentStage, "B4_REVIEW", `expected B4_REVIEW, got ${gate.payload?.state?.currentStage}`);
  assert.equal(gate.payload?.state?.status, "running");
}

/** 一份可通过全部 Pi 校验的通过型 raw scorecard（R1/R5=2 满足动态门槛，total=14）。 */
function passingScorecard(overrides = {}) {
  const scores = Object.fromEntries(["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, { score: 2, note: `${id} 检查通过` }]));
  return {
    scores,
    summary: "报告满足当前质量门禁。",
    hardBlockers: [],
    issues: [],
    repairHints: [],
    ...overrides,
  };
}

test("reviewerScorecardSchema + validateReviewerScorecard accept a passing raw scorecard", () => {
  const schema = reviewerScorecardSchema();
  const ok = validateJsonSchema(passingScorecard(), schema);
  assert.equal(ok.ok, true, ok.errors?.join("; "));
  const checked = validateReviewerScorecard(passingScorecard());
  assert.equal(checked.ok, true, checked.errors?.join("; "));
  // 非法：score 越界 / note 为空 / summary 缺失。
  assert.equal(validateReviewerScorecard(passingScorecard({ scores: { R1: { score: 5, note: "x" } } })).ok, false);
  assert.equal(validateReviewerScorecard(passingScorecard({ scores: { R1: { score: 2, note: "  " } } })).ok, false);
  assert.equal(validateReviewerScorecard({ ...passingScorecard(), summary: "" }).ok, false);
  assert.equal(validateReviewerScorecard("nope").ok, false);
});

test("buildReviewerPrompt embeds session/result and forbids side effects", () => {
  const prompt = buildReviewerPrompt({ sessionDir: "/s", resultPath: "/s/result.json", rubricPath: "/r/docs/html-report-quality-rubric.md" });
  assert.match(prompt, /SESSION=\/s/);
  assert.match(prompt, /result\.json=\/s\/result\.json/);
  assert.match(prompt, /PARENT QUALITY SCAN: passed/);
  assert.match(prompt, /只输出 JSON/);
});

test("M4 B4 happy path: scorecard passes → verdict stamped + quality layout → awaiting_approval, approve → B5_DESIGN", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);

    const runChild = async () => ({ status: "completed", code: "ok", value: passingScorecard(), message: "ok" });
    const outcome = await advance(root, sessionId, { runChild });
    assert.equal(outcome.ok, true, outcome.message);
    assert.match(outcome.message, /质量审核通过/);

    // 落盘：verdict.json 最终态（draft=false, pass=true, total=14），report.md 非空。
    const verdict = JSON.parse(readFileSync(join(sessionDir, "quality", "verdict.json"), "utf8"));
    assert.equal(verdict.producer, "write-verdict.mjs");
    assert.equal(verdict.draft, false);
    assert.equal(verdict.pass, true);
    assert.equal(verdict.total, 14);
    assert.equal(verdict.maxTotal, 14);
    assert.ok(verdict.scanFingerprint && /^[a-f0-9]{64}$/.test(verdict.scanFingerprint));
    assert.equal(readFileSync(join(sessionDir, "quality", "report.md"), "utf8").trim().length > 0, true);

    // B4 为人工 Gate：停在 awaiting_approval，Runner 不自动批准。
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B4_REVIEW");
    assert.equal(gate.payload?.state?.status, "awaiting_approval");

    // 批准 B4 → 推进到 B5_DESIGN running（达标 scorecard 推进到 B5）。
    const approved = await approvePipelineStage(sessionDir, { phrase: "继续" });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const after = runStageGate(root, sessionId, "status");
    assert.equal(after.payload?.state?.currentStage, "B5_DESIGN", `expected B5_DESIGN, got ${after.payload?.state?.currentStage}`);
    assert.equal(after.payload?.state?.status, "running");
  } finally {
    cleanup(root);
  }
});

test("M4 B4 failed verdict: below-quality scorecard fails the Gate (blocked + retryable), then retry passes", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);

    // R5=1 < 动态任务门槛 minScore=2 → gateFailures=[R5] → pass=false。
    let calls = 0;
    const runChild = async () => {
      calls += 1;
      if (calls === 1) {
        return { status: "completed", code: "ok", value: passingScorecard({ scores: { ...passingScorecard().scores, R5: { score: 1, note: "R5 范围忠实不足" } } }), message: "ok" };
      }
      return { status: "completed", code: "ok", value: passingScorecard(), message: "ok" };
    };

    const first = await advance(root, sessionId, { runChild });
    assert.equal(first.ok, false, "failed verdict must block");
    assert.equal(first.code, "review_failed");
    assert.match(first.error, /未达线/);

    // fail Gate：流水线 failed，不推进到 B5，且已开放 retry。
    const gate1 = runStageGate(root, sessionId, "status");
    assert.equal(gate1.payload?.state?.currentStage, "B4_REVIEW");
    assert.equal(gate1.payload?.state?.status, "failed");
    assert.match(gate1.payload?.state?.stages?.B4_REVIEW?.failureReason || "", /未达线/);
    const verdict1 = JSON.parse(readFileSync(join(sessionDir, "quality", "verdict.json"), "utf8"));
    assert.equal(verdict1.pass, false);
    assert.equal(verdict1.gateFailures.length, 1);
    assert.equal(verdict1.gateFailures[0].rubric, "R5");

    // advance 在 failed 态返回 retry 指引，不推进。
    const blocked = await advance(root, sessionId, { runChild });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /retry/);

    // retry → B4 重新 running，重跑 scorecard（这次通过）→ awaiting_approval。
    const retried = await retryPipelineStage(sessionDir, { phrase: "重试当前阶段" });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    const gate2 = runStageGate(root, sessionId, "status");
    assert.equal(gate2.payload?.state?.currentStage, "B4_REVIEW");
    assert.equal(gate2.payload?.state?.status, "running");
    const second = await advance(root, sessionId, { runChild });
    assert.equal(second.ok, true, second.message);
    assert.match(second.message, /质量审核通过/);
    const gate3 = runStageGate(root, sessionId, "status");
    assert.equal(gate3.payload?.state?.status, "awaiting_approval");
  } finally {
    cleanup(root);
  }
});

test("M4 B4 anti-fabrication: hardBlockers force pass=false even with all-2 scores", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);

    // child 给满分但夹带 hard blocker：Pi 公式强制 pass=false（child 无法自封通过）。
    const runChild = async () => ({
      status: "completed",
      code: "ok",
      value: passingScorecard({
        hardBlockers: [{ code: "BALANCE_MISSING", rubric: "R5", message: "报告未回答平衡性问题", where: "report/report.md" }],
      }),
      message: "ok",
    });
    const outcome = await advance(root, sessionId, { runChild });
    assert.equal(outcome.ok, false, "hardBlocker must force pass=false");
    assert.equal(outcome.code, "review_failed");
    const verdict = JSON.parse(readFileSync(join(sessionDir, "quality", "verdict.json"), "utf8"));
    assert.equal(verdict.pass, false);
    assert.equal(verdict.hardBlockers.length, 1);
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.status, "failed");
    assert.equal(gate.payload?.state?.currentStage, "B4_REVIEW");
  } finally {
    cleanup(root);
  }
});

test("M4 B4 fail-closed: quality scan hardIssues > 0 → quality_hard before dispatch", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);

    // 往已审核报告里注入一个无法从证据复算的数字 → scan hardIssues > 0。
    // 同步更新 render-manifest.json 的 reportSha256，使报告指纹校验通过、
    // 真正命中硬伤检测（而不是先被 assembly fingerprint 拦截成 scan_invalid）。
    const reportPath = join(sessionDir, "report", "report.md");
    const tamperedReport = `${readFileSync(reportPath, "utf8")}\n另：总销售额高达 999999 元。\n`;
    writeFileSync(reportPath, tamperedReport);
    const manifestPath = join(sessionDir, "report", "render-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.reportSha256 = textSha256(tamperedReport);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    let dispatched = 0;
    const runChild = async () => {
      dispatched += 1;
      return { status: "completed", code: "ok", value: passingScorecard(), message: "ok" };
    };
    const outcome = await advance(root, sessionId, { runChild });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "quality_hard");
    assert.match(outcome.error, /不得派发 Reviewer/);
    assert.equal(dispatched, 0, "reviewer must not be dispatched on hard scan issues");
    // fail Gate：阻断，不推进。
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B4_REVIEW");
    assert.equal(gate.payload?.state?.status, "failed");
    assert.equal(existsSync(join(sessionDir, "quality", "verdict.json")), false, "no verdict must be stamped");
  } finally {
    cleanup(root);
  }
});

test("M4 B4 fail-closed: invalid reviewer return → return_invalid, no verdict, gate failed", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);

    const runChild = async () => ({
      status: "completed",
      code: "ok",
      value: passingScorecard({ scores: { ...passingScorecard().scores, R1: { score: 5, note: "非法" } } }),
      message: "ok",
    });
    const outcome = await advance(root, sessionId, { runChild });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "return_invalid");
    assert.match(outcome.error, /返回无效/);
    assert.equal(existsSync(join(sessionDir, "quality", "verdict.json")), false, "no verdict must be stamped");
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B4_REVIEW");
    assert.equal(gate.payload?.state?.status, "failed");
  } finally {
    cleanup(root);
  }
});

test("M5 buildDesignerPrompt embeds session/result, read-only inputs, fixed chain, and ok/failed spec", () => {
  const sessionDir = "/s";
  const resultPath = "/s/result.json";
  const expected = designerReturnPaths({ sessionDir });
  const prompt = buildDesignerPrompt({ sessionDir, resultPath, expected });
  assert.match(prompt, /SESSION=\/s/);
  assert.match(prompt, /result\.json=\/s\/result\.json/);
  assert.match(prompt, /只读输入（不得修改）/);
  assert.match(prompt, /quality\/verdict\.json/);
  assert.match(prompt, /compile-report-content\.mjs --result/);
  assert.match(prompt, /compose-report\.mjs --result/);
  assert.match(prompt, /capture-report\.mjs --result/);
  assert.match(prompt, /finalize-design\.mjs --result/);
  assert.match(prompt, /check-session-layout\.mjs --result/);
  assert.match(prompt, /--phase html/);
  assert.match(prompt, /repairRounds 0-2/);
  assert.match(prompt, /status=ok/);
  assert.match(prompt, /status=failed/);
  assert.match(prompt, /不得改动任何已审核输入/);
});

test("M5 B5 happy path: designer child builds final HTML → layout(html) + finalize-design → pipeline completed", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);
    await driveToDesign(root, sessionId);

    const outcome = await advance(root, sessionId, { runChild: mockDesignerChild(sessionDir) });
    assert.equal(outcome.ok, true, outcome.message);
    assert.match(outcome.message, /layout\(html\) 与 finalize-design/);

    // 全部 B5 产物落盘（含真实脚本合成的 report.html/render.meta.json/design-result.json）。
    for (const rel of [
      "report/report.html",
      "report/render.meta.json",
      "report/design-result.json",
      "report/visual-check.json",
      "report/report.content.html",
      "report/design-input.json",
      "report/report.design.html",
      "report/screenshots/desktop-1440x1000.png",
      "report/screenshots/mobile-390x844.png",
    ]) {
      assert.equal(existsSync(join(sessionDir, rel)), true, `missing ${rel}`);
    }
    const designResult = JSON.parse(readFileSync(join(sessionDir, "report", "design-result.json"), "utf8"));
    assert.equal(designResult.producer, "finalize-design.mjs");
    assert.equal(designResult.status, "pass");
    assert.match(designResult.htmlPath || "", /report\/report\.html$/);

    // B5 gate:false → finish 后流水线 completed。
    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B5_DESIGN");
    assert.equal(gate.payload?.state?.status, "completed", JSON.stringify(gate.payload?.state));
    assert.equal(gate.payload?.state?.stages?.B5_DESIGN?.status, "completed");
  } finally {
    cleanup(root);
  }
});

test("M5 B5 fail-closed: ok return without finalize-design → layout_invalid, gate failed", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);
    await driveToDesign(root, sessionId);

    // child 声称 ok 但跳过 finalize-design（无 design-result.json）→ 布局校验拦截。
    const outcome = await advance(root, sessionId, { runChild: mockDesignerChild(sessionDir, { skipFinalize: true }) });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "layout_invalid");
    assert.match(outcome.error, /design-result\.json/);
    assert.equal(existsSync(join(sessionDir, "report", "design-result.json")), false, "finalize must not run");

    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B5_DESIGN");
    assert.equal(gate.payload?.state?.status, "failed");
    assert.match(gate.payload?.state?.stages?.B5_DESIGN?.failureReason || "", /design-result\.json/);
  } finally {
    cleanup(root);
  }
});

test("M5 B5 fail-closed: designer status=failed → design_failed, gate failed", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);
    await driveToDesign(root, sessionId);

    const outcome = await advance(root, sessionId, { runChild: mockDesignerChild(sessionDir, { status: "failed" }) });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "design_failed");
    assert.match(outcome.error, /截图校验失败/);

    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B5_DESIGN");
    assert.equal(gate.payload?.state?.status, "failed");
    assert.match(gate.payload?.state?.stages?.B5_DESIGN?.failureReason || "", /截图校验失败/);
  } finally {
    cleanup(root);
  }
});

test("M5 B5 anti-fabrication: designer child tampers a frozen input → design_input_changed, gate failed", async () => {
  const cardId = "card-001";
  const { root, sessionDir, sessionId } = makeSession({ cards: [fixtureCard(cardId)] });
  try {
    writeCardFixturesReal(sessionDir, cardId, rowsFixture());
    await driveToReview(root, sessionId);
    await driveToDesign(root, sessionId);

    // 冻结输入之一（quality/scan.json）在 child 运行期间被改动 → 拒绝继续。
    const outcome = await advance(root, sessionId, {
      runChild: mockDesignerChild(sessionDir, {
        tamper: (dir) => writeFileSync(join(dir, "quality", "scan.json"), `${readFileSync(join(dir, "quality", "scan.json"), "utf8")}\n  // designer 越权改写\n`, "utf8"),
      }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, "design_input_changed");
    assert.match(outcome.error, /冻结输入被改动/);

    const gate = runStageGate(root, sessionId, "status");
    assert.equal(gate.payload?.state?.currentStage, "B5_DESIGN");
    assert.equal(gate.payload?.state?.status, "failed");
  } finally {
    cleanup(root);
  }
});
