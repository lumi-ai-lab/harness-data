import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { compileReportContent, sha256Text } from "../scripts/compile-report-content.mjs";
import { composeReport, validateDesignTemplate } from "../scripts/compose-report.mjs";
import { finalizeDesign } from "../scripts/finalize-design.mjs";
import { checkSessionLayout } from "../scripts/check-session-layout.mjs";
import { writeVerdict } from "../scripts/write-verdict.mjs";
import { assembleReport } from "../scripts/assemble-report.mjs";
import { rowsSha256 } from "../scripts/prepare-research-evidence.mjs";
import {
  approvePipelineStage,
  finishPipelineStage,
  initPipeline,
  startPipelineStage,
} from "../scripts/stage-gate.mjs";

function scores() {
  return Object.fromEntries(["R1", "R2", "R3", "R4", "R5", "R6", "R7"].map((id) => [id, { score: 2 }]));
}

async function seedSession(session) {
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  await mkdir(join(session, "quality"), { recursive: true });
  await mkdir(join(session, "report"), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    session_id: "design-test",
    cards: [{ id: "c1", title: "经营明细" }],
  }));
  await writeFile(join(session, "analysis", "main.md"), "# 经营分析\n\n## 结论\n\n> 数据完整。\n");
  const rows = [{ 日期: "2026-07-01", 值: 1 }];
  await writeFile(join(session, "data", "cards", "c1", "entry.json"), JSON.stringify(rows));
  await writeFile(join(session, "data", "cards", "c1", "entry.meta.json"), JSON.stringify({
    rowCount: rows.length,
    rowsSha256: rowsSha256(rows),
  }));
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] }));
  await writeFile(join(session, "quality", "scan.json"), JSON.stringify({ version: 1, hardIssues: [], softIssues: [] }));
  await writeFile(join(session, "quality", "report.md"), "# quality\n");
  await writeVerdict(session, { pass: true, draft: false, scores: scores(), hardBlockers: [], issues: [] });
  await assembleReport(session);
}

async function advanceGateToB4Approval(session) {
  await initPipeline(session, { mode: "step", sessionId: "design-test" });
  await startPipelineStage(session, "A_CONFIG");
  await finishPipelineStage(session, "A_CONFIG");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B0_PREFLIGHT");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B2_WRITER");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B25_EDITOR");
  await finishPipelineStage(session, "B3_RESEARCH");
  await approvePipelineStage(session);
  await finishPipelineStage(session, "B4_REVIEW");
}

function shellTemplate() {
  return [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>{{HTML_REPORT_TITLE}}</title>',
    "<style>body{margin:0;color:#222}.table-wrap{overflow-x:auto}</style></head>",
    '<body><header><h1>{{HTML_REPORT_TITLE}}</h1><span>{{HTML_REPORT_QUALITY_BADGE}}</span></header>',
    "<main><!-- HTML_REPORT_CONTENT --></main></body></html>",
  ].join("\n");
}

async function writeVisualArtifacts(session, htmlPath) {
  const screenshotDir = join(session, "report", "screenshots");
  await mkdir(screenshotDir, { recursive: true });
  const desktopPath = join(screenshotDir, "desktop-1440x1000.png");
  const mobilePath = join(screenshotDir, "mobile-390x844.png");
  const crc32 = (data) => {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const name = Buffer.from(type, "ascii");
    const output = Buffer.alloc(12 + body.length);
    output.writeUInt32BE(body.length, 0);
    name.copy(output, 4);
    body.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([name, body])), 8 + body.length);
    return output;
  };
  const fakePng = (width, height, fill) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    const pixels = Buffer.alloc(height * (width + 1));
    for (let row = 0; row < height; row += 1) pixels.fill(fill, row * (width + 1) + 1, (row + 1) * (width + 1));
    return Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  const desktop = fakePng(1440, 1000, 1);
  const mobile = fakePng(390, 844, 2);
  await writeFile(desktopPath, desktop);
  await writeFile(mobilePath, mobile);
  const html = await readFile(htmlPath, "utf8");
  const visual = {
    version: 1,
    producer: "capture-report.mjs",
    htmlPath,
    htmlSha256: sha256Text(html),
    screenshots: [
      { id: "desktop", viewport: "1440,1000", path: desktopPath, bytes: desktop.length, sha256: sha256Text(desktop), durationMs: 1 },
      { id: "mobile", viewport: "390,844", path: mobilePath, bytes: mobile.length, sha256: sha256Text(mobile), durationMs: 1 },
    ],
  };
  const visualPath = join(session, "report", "visual-check.json");
  await writeFile(visualPath, `${JSON.stringify(visual, null, 2)}\n`);
  return { visual, visualPath };
}

async function writeDraft(session) {
  const draftPath = join(session, "report", "design-result.draft.json");
  await writeFile(draftPath, JSON.stringify({
    status: "pass",
    viewports: { desktop: { pass: true }, mobile: { pass: true } },
    notes: [],
  }));
  return draftPath;
}

test("design template contract requires one immutable content slot", () => {
  assert.ok(validateDesignTemplate("<html><head></head><body></body></html>").length > 0);
  assert.ok(validateDesignTemplate("<!doctype html><html><head></head><body><!-- HTML_REPORT_CONTENT --><!-- HTML_REPORT_CONTENT --></body></html>").length > 0);
  assert.deepEqual(validateDesignTemplate("<!doctype html><html><head></head><body><!-- HTML_REPORT_CONTENT --></body></html>"), []);
  assert.ok(validateDesignTemplate([
    "<!doctype html><html><head></head><body>",
    "<!-- html-report:content-start sha256=\"abc\" -->",
    '<article data-html-report-content="immutable">copied business content</article>',
    "<!-- html-report:content-end -->",
    "<!-- HTML_REPORT_CONTENT -->",
    "</body></html>",
  ].join("\n")).some((error) => /must not embed immutable report\.content\.html/.test(error)));
  assert.ok(validateDesignTemplate(
    "<!doctype html><html><head></head><body><!-- html-report:full-explore-table task=\"x\" rows=\"1\" --><!-- HTML_REPORT_CONTENT --></body></html>"
  ).some((error) => /full-table markers/.test(error)));
});

test("compile, Designer shell, compose and stamped visual QA preserve exact content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-design-"));
  const session = join(root, ".harness", "state", "html-report", "s1");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedSession(session);

  const compiled = await compileReportContent(session);
  const templatePath = join(session, "report", "report.design.html");
  await writeFile(templatePath, shellTemplate());
  const composed = await composeReport(session);
  const html = await readFile(composed.htmlPath, "utf8");
  const content = await readFile(compiled.contentPath, "utf8");
  assert.equal(html.split(content.trimEnd()).length - 1, 1);
  assert.match(html, /<table>/);

  await writeVisualArtifacts(session, composed.htmlPath);
  const draftPath = await writeDraft(session);
  await finalizeDesign(session, draftPath);
  await advanceGateToB4Approval(session);

  const blocked = await checkSessionLayout(session, { phase: "html" });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some((error) => /B4_REVIEW.*not validly completed and approved/.test(error)));

  await approvePipelineStage(session);
  const layout = await checkSessionLayout(session, { phase: "html" });
  assert.equal(layout.ok, true, layout.errors.join("; "));

  const statePath = join(session, "debug", "pipeline-state.json");
  const validState = JSON.parse(await readFile(statePath, "utf8"));
  for (const [label, mutate] of [
    ["failed B4", (state) => { state.stages.B4_REVIEW.status = "failed"; }],
    ["stale approval", (state) => { state.approvals.at(-1).approvedAt = "2020-01-01T00:00:00.000Z"; }],
    ["forged actor", (state) => { state.approvals.at(-1).actor = "report-designer"; }],
    ["duplicate approval", (state) => { state.approvals.push({ ...state.approvals.at(-1) }); }],
    ["pipeline not advanced", (state) => { state.currentStage = "B4_REVIEW"; }],
    ["failed internal Editor", (state) => { state.stages.B25_EDITOR.status = "failed"; }],
  ]) {
    const forged = structuredClone(validState);
    mutate(forged);
    await writeFile(statePath, JSON.stringify(forged));
    const rejected = await checkSessionLayout(session, { phase: "html" });
    assert.equal(rejected.ok, false, label);
    assert.ok(rejected.errors.some((error) => /B25_EDITOR|B4_REVIEW|B5_DESIGN/.test(error)), `${label}: ${rejected.errors.join("; ")}`);
  }
  await writeFile(statePath, JSON.stringify(validState));

  const autoState = structuredClone(validState);
  autoState.mode = "auto";
  autoState.approvals = [];
  for (const stageId of ["A_CONFIG", "B0_PREFLIGHT", "B2_WRITER", "B3_RESEARCH", "B4_REVIEW"]) {
    autoState.stages[stageId].approvedAt = null;
  }
  await writeFile(statePath, JSON.stringify(autoState));
  const autoLayout = await checkSessionLayout(session, { phase: "html" });
  assert.equal(autoLayout.ok, true, autoLayout.errors.join("; "));

  for (const [label, mutate] of [
    ["auto pipeline not advanced", (state) => { state.currentStage = "B4_REVIEW"; }],
    ["auto prerequisite failed", (state) => { state.stages.B4_REVIEW.status = "failed"; }],
  ]) {
    const forged = structuredClone(autoState);
    mutate(forged);
    await writeFile(statePath, JSON.stringify(forged));
    const rejected = await checkSessionLayout(session, { phase: "html" });
    assert.equal(rejected.ok, false, label);
    assert.ok(rejected.errors.some((error) => /B4_REVIEW|B5_DESIGN/.test(error)), `${label}: ${rejected.errors.join("; ")}`);
  }
});

test("compose rejects forged Markdown, marker metadata and compiled content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-design-binding-"));
  const session = join(root, ".harness", "state", "html-report", "binding");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedSession(session);
  await compileReportContent(session);
  await writeFile(join(session, "report", "report.design.html"), shellTemplate());

  const markdownPath = join(session, "report", "report.md");
  const originalMarkdown = await readFile(markdownPath, "utf8");
  await writeFile(markdownPath, `${originalMarkdown}\n伪造正文\n`);
  await assert.rejects(composeReport(session), /render-manifest|markdownSha256|deterministic compilation/);
  await writeFile(markdownPath, originalMarkdown);

  const inputPath = join(session, "report", "design-input.json");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  input.fullTableMarkers = [];
  await writeFile(inputPath, JSON.stringify(input));
  await assert.rejects(composeReport(session), /fullTableMarkers mismatch/);

  await compileReportContent(session);
  await writeFile(join(session, "report", "report.content.html"), "forged compiled content");
  await assert.rejects(composeReport(session), /not the deterministic compilation/);
});

test("finalize rejects foreign assessment and forged screenshot declarations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-design-finalize-"));
  const session = join(root, ".harness", "state", "html-report", "finalize");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedSession(session);
  await compileReportContent(session);
  await writeFile(join(session, "report", "report.design.html"), shellTemplate());
  const composed = await composeReport(session);
  const { visual, visualPath } = await writeVisualArtifacts(session, composed.htmlPath);
  const draftPath = await writeDraft(session);
  const foreignDraft = join(root, "foreign-design-result.draft.json");
  await writeFile(foreignDraft, await readFile(draftPath));
  await assert.rejects(finalizeDesign(session, foreignDraft), /assessment file must be the current session draft/);

  for (const [label, mutate, expected] of [
    ["foreign path", (copy) => { copy.screenshots[0].path = foreignDraft; }, /desktop screenshot path/],
    ["wrong viewport", (copy) => { copy.screenshots[1].viewport = "391,844"; }, /mobile screenshot viewport/],
    ["duplicate", (copy) => { copy.screenshots[1] = { ...copy.screenshots[0] }; }, /screenshot 2 must be mobile/],
    ["extra", (copy) => { copy.screenshots.push({ ...copy.screenshots[1] }); }, /exactly desktop and mobile/],
  ]) {
    const forged = structuredClone(visual);
    mutate(forged);
    await writeFile(visualPath, JSON.stringify(forged));
    await assert.rejects(finalizeDesign(session, draftPath), expected, label);
  }
  const desktopPath = visual.screenshots[0].path;
  const desktop = await readFile(desktopPath);
  const corrupt = Buffer.from(desktop);
  corrupt[corrupt.length - 1] ^= 0xff;
  const corruptVisual = structuredClone(visual);
  corruptVisual.screenshots[0].bytes = corrupt.length;
  corruptVisual.screenshots[0].sha256 = sha256Text(corrupt);
  await writeFile(desktopPath, corrupt);
  await writeFile(visualPath, JSON.stringify(corruptVisual));
  await assert.rejects(finalizeDesign(session, draftPath), /screenshot PNG/);
  await writeFile(desktopPath, desktop);
  await writeFile(visualPath, `${JSON.stringify(visual, null, 2)}\n`);
  const finalized = await finalizeDesign(session, draftPath);
  finalized.result.screenshots = [];
  await writeFile(finalized.resultPath, JSON.stringify(finalized.result));
  await advanceGateToB4Approval(session);
  await approvePipelineStage(session);
  const layout = await checkSessionLayout(session, { phase: "html" });
  assert.equal(layout.ok, false);
  assert.ok(layout.errors.some((error) => /screenshots must exactly match/.test(error)));
});
