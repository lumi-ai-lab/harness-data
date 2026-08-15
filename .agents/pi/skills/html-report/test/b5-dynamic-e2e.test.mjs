import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedRecommendations } from "../scripts/seed-debug-recommendations.mjs";
import { headlessConfirm } from "../scripts/headless-confirm.mjs";
import { rowsSha256 } from "../scripts/prepare-research-evidence.mjs";
import { assembleReport } from "../scripts/assemble-report.mjs";
import { runQualityScan } from "../scripts/quality-scan.mjs";
import { writeVerdict } from "../scripts/write-verdict.mjs";
import { compileReportContent } from "../scripts/compile-report-content.mjs";
import { composeReport } from "../scripts/compose-report.mjs";
import { captureReport } from "../scripts/capture-report.mjs";
import { finalizeDesign } from "../scripts/finalize-design.mjs";
import { checkSessionLayout } from "../scripts/check-session-layout.mjs";
import {
  approvePipelineStage,
  finishPipelineStage,
  initPipeline,
  readPipelineState,
  startPipelineStage,
  LEGACY_STAGE_POLICY,
} from "../scripts/stage-gate.mjs";

const rows = [
  { incDate: "2026-07-01", custNum: 120, perCustAmt: 80, profitLostRate: "20%", profitAmt: 1920 },
  { incDate: "2026-07-02", custNum: 150, perCustAmt: 82, profitLostRate: "21%", profitAmt: 2583 },
];

async function fakeMetricCli(root) {
  const path = join(root, "fake-qdm-metric-cli.mjs");
  await writeFile(path, [
    "#!/usr/bin/env node",
    `const rows = ${JSON.stringify(rows)};`,
    'process.stdout.write(JSON.stringify(rows));',
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

async function fakeIndicatorsCli(root) {
  const path = join(root, "fake-qdm-indicators-cli.mjs");
  await writeFile(path, [
    "#!/usr/bin/env node",
    'process.stdout.write(JSON.stringify({ rows: [], rowCount: 0, rowsSha256: "0".repeat(64) }));',
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

async function fakePlaywrightCli(root) {
  const path = join(root, "fake-playwright.mjs");
  await writeFile(path, [
    "#!/usr/bin/env node",
    'const { writeFileSync } = await import("node:fs");',
    'const { deflateSync } = await import("node:zlib");',
    'const args = process.argv.slice(2);',
    'const viewport = args[args.indexOf("--viewport-size") + 1].split(",").map(Number);',
    'const output = args.at(-1);',
    'const crc32 = (data) => { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; };',
    'const chunk = (type, body) => { const name = Buffer.from(type, "ascii"); const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); name.copy(out, 4); body.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([name, body])), 8 + body.length); return out; };',
    'const header = Buffer.alloc(13); header.writeUInt32BE(viewport[0], 0); header.writeUInt32BE(viewport[1], 4); header[8] = 8;',
    'const pixels = Buffer.alloc(viewport[1] * (viewport[0] + 1));',
    'const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);',
    'writeFileSync(output, png);',
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

function scores() {
  return Object.fromEntries(["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, { score: 2 }]));
}

async function finishAndApprove(session, stage) {
  await finishPipelineStage(session, stage);
  await approvePipelineStage(session);
}

test("real Phase A confirmation result drives the dynamic B5 delivery chain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-b5-e2e-"));
  const sessionId = `b5-e2e-${process.pid}-${Date.now()}`;
  const session = join(root, ".harness", "state", "html-report", sessionId);
  const recommendationsPath = join(session, "recommendations.json");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(session, { recursive: true });
  await writeFile(recommendationsPath, `${JSON.stringify(fixedRecommendations({
    sessionId,
    now: new Date(2026, 6, 25),
  }), null, 2)}\n`);
  const indicatorsCli = await fakeIndicatorsCli(root);
  const metricCli = await fakeMetricCli(root);
  const playwrightCli = await fakePlaywrightCli(root);
  const previousMetricCli = process.env.QDM_METRIC_CLI;
  process.env.QDM_METRIC_CLI = metricCli;
  t.after(() => {
    if (previousMetricCli === undefined) delete process.env.QDM_METRIC_CLI;
    else process.env.QDM_METRIC_CLI = previousMetricCli;
  });

  await initPipeline(session, { mode: "step", sessionId, policy: LEGACY_STAGE_POLICY });
  await startPipelineStage(session, "A_CONFIG");
  const confirmed = await headlessConfirm({
    recommendationsPath,
    sessionId,
    env: {
      ...process.env,
      QDM_INDICATORS_CLI: indicatorsCli,
      QDM_INDICATORS_TOKEN: "b5-a-confirm-token",
    },
    startupTimeoutMs: 10_000,
    confirmTimeoutMs: 10_000,
    totalTimeoutMs: 20_000,
  });
  const result = JSON.parse(await readFile(confirmed.resultPath, "utf8"));
  assert.equal(result.status, "confirmed");
  assert.equal(result.already_validated, false);
  assert.equal(result.validation[0].ok, true);
  assert.match(result.validation[0].command, /analysis execute/);
  assert.equal(result.result_path, confirmed.resultPath);

  await finishAndApprove(session, "A_CONFIG");
  await finishAndApprove(session, "B0_PREFLIGHT");
  result.cards = result.cards.map((card) => {
    const { requestBody, metrics, dimensions, startDate, endDate, filters, statisticPolicy, ...rest } = card;
    return {
      ...rest,
      query: {
        request: {
          metrics: card.metrics || card.indicatorFieldList,
          statisticPolicy: card.statisticPolicy || "SUMMARY",
          time: { startDate: card.startDate, endDate: card.endDate },
          dimensions: card.dimensions || card.aggDimUniqueCodeList,
          filters: Object.fromEntries(
            (Array.isArray(card.filters) ? card.filters : []).map((filter) => [filter.dimUniqueCode, filter.values || []])
          ),
          pageNo: 1,
          pageSize: 500,
        },
        comparisons: [],
      },
    };
  });
  await writeFile(confirmed.resultPath, `${JSON.stringify(result, null, 2)}\n`);
  const { fetchAllEntries } = await import(`../scripts/fetch-entry.mjs?b5-e2e=${Date.now()}`);
  const fetched = await fetchAllEntries(confirmed.resultPath);
  assert.equal(fetched.cards[0].fetchStatus, "success", JSON.stringify(fetched.cards[0]));
  await finishAndApprove(session, "B2_WRITER");

  await mkdir(join(session, "analysis"), { recursive: true });
  await writeFile(join(session, "analysis", "main.md"), [
    "# 门店经营动态报告",
    "",
    "## 结论",
    "",
    "门店日度来客与毛利数据已完成真实确认和全量取数。",
    "",
  ].join("\n"));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 0,
    maxRounds: 2,
    tasks: [],
  }));
  await assembleReport(session);
  await finishPipelineStage(session, "B25_EDITOR");
  await finishAndApprove(session, "B3_RESEARCH");

  const scan = await runQualityScan(session);
  assert.equal(scan.scan.hardIssues.length, 0);
  await mkdir(join(session, "quality"), { recursive: true });
  await writeFile(join(session, "quality", "report.md"), "# B4 Reviewer\n\n机械扫描与语义审阅均通过。\n");
  const verdict = await writeVerdict(session, {
    scores: scores(),
    hardBlockers: [],
    issues: [],
    notes: "B5 dynamic E2E",
  });
  assert.equal(verdict.verdict.pass, true);
  await finishAndApprove(session, "B4_REVIEW");

  const compiled = await compileReportContent(session);
  await writeFile(join(session, "report", "report.design.html"), [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>{{HTML_REPORT_TITLE}}</title><style>body{margin:0;font-family:sans-serif}.table-wrap{overflow-x:auto}@media print{body{color:#000}}</style></head>",
    '<body><header><strong>{{HTML_REPORT_QUALITY_BADGE}}</strong></header><main><!-- HTML_REPORT_CONTENT --></main></body></html>',
  ].join("\n"));
  const composed = await composeReport(session);
  await captureReport(session, { playwright: playwrightCli });
  const draftPath = join(session, "report", "design-result.draft.json");
  await writeFile(draftPath, JSON.stringify({
    status: "pass",
    viewports: {
      desktop: { pass: true, notes: "1440×1000 布局完整" },
      mobile: { pass: true, notes: "390×844 无横向溢出" },
    },
    notes: [],
  }));
  await finalizeDesign(session, draftPath);
  const layout = await checkSessionLayout(session, { phase: "html" });
  assert.equal(layout.ok, true, layout.errors.join("; "));
  const html = await readFile(composed.htmlPath, "utf8");
  const content = await readFile(compiled.contentPath, "utf8");
  assert.equal(html.split(content.trimEnd()).length - 1, 1);
  assert.match(html, /html-report:full-table/);
  assert.match(html, /<table>/);
  await finishPipelineStage(session, "B5_DESIGN");
  const completed = await readPipelineState(session);
  assert.equal(completed.status, "completed");
  assert.equal(completed.stages.B5_DESIGN.status, "completed");
});
