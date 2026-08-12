import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileReportContent, sha256Text } from "../scripts/compile-report-content.mjs";
import { composeReport, validateDesignTemplate } from "../scripts/compose-report.mjs";
import { finalizeDesign } from "../scripts/finalize-design.mjs";
import { checkSessionLayout } from "../scripts/check-session-layout.mjs";
import { writeVerdict } from "../scripts/write-verdict.mjs";
import { assembleReport } from "../scripts/assemble-report.mjs";
import { rowsSha256 } from "../scripts/prepare-research-evidence.mjs";

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
  await writeFile(
    join(session, "analysis", "main.md"),
    "# 经营分析\n\n## 结论\n\n> 数据完整。\n"
  );
  const rows = [{ 日期: "2026-07-01", 值: 1 }];
  await writeFile(join(session, "data", "cards", "c1", "entry.json"), JSON.stringify(rows));
  await writeFile(
    join(session, "data", "cards", "c1", "entry.meta.json"),
    JSON.stringify({ rowCount: rows.length, rowsSha256: rowsSha256(rows) })
  );
  await writeFile(
    join(session, "analysis", "tasks.json"),
    JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] })
  );
  await writeFile(join(session, "quality", "scan.json"), JSON.stringify({ version: 1, hardIssues: [], softIssues: [] }));
  await writeFile(join(session, "quality", "report.md"), "# quality\n");
  await writeVerdict(session, { pass: true, draft: false, scores: scores(), hardBlockers: [], issues: [] });
  await assembleReport(session);
}

test("design template contract requires one immutable content slot", () => {
  assert.ok(validateDesignTemplate("<html><head></head><body></body></html>").length > 0);
  assert.ok(validateDesignTemplate("<!doctype html><html><head></head><body><!-- HTML_REPORT_CONTENT --><!-- HTML_REPORT_CONTENT --></body></html>").length > 0);
  assert.deepEqual(
    validateDesignTemplate("<!doctype html><html><head></head><body><!-- HTML_REPORT_CONTENT --></body></html>"),
    []
  );
  assert.ok(validateDesignTemplate([
    "<!doctype html><html><head></head><body>",
    "<!-- html-report:content-start sha256=\"abc\" -->",
    '<article data-html-report-content="immutable">copied business content</article>',
    "<!-- html-report:content-end -->",
    "<!-- HTML_REPORT_CONTENT -->",
    "</body></html>",
  ].join("\n")).some((error) => /must not embed immutable report\.content\.html/.test(error)));
});

test("compile, Designer shell, compose and stamped visual QA preserve exact content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-design-"));
  const session = join(root, ".harness", "state", "html-report", "s1");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await seedSession(session);

  const compiled = await compileReportContent(session);
  const shell = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><title>{{HTML_REPORT_TITLE}}</title>',
    "<style>body{margin:0;color:#222}.table-wrap{overflow-x:auto}</style></head>",
    '<body><header><h1>{{HTML_REPORT_TITLE}}</h1><span>{{HTML_REPORT_QUALITY_BADGE}}</span></header>',
    "<main><!-- HTML_REPORT_CONTENT --></main></body></html>",
  ].join("\n");
  const templatePath = join(session, "report", "report.design.html");
  await writeFile(templatePath, shell);
  const composed = await composeReport(session);
  const html = await readFile(composed.htmlPath, "utf8");
  const content = await readFile(compiled.contentPath, "utf8");
  assert.ok(html.includes(content.trimEnd()));
  assert.match(html, /<table>/);

  const screenshotDir = join(session, "report", "screenshots");
  await mkdir(screenshotDir, { recursive: true });
  const desktopPath = join(screenshotDir, "desktop-1440x1000.png");
  const mobilePath = join(screenshotDir, "mobile-390x844.png");
  const desktop = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(2048, 1)]);
  const mobile = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(2048, 2)]);
  await writeFile(desktopPath, desktop);
  await writeFile(mobilePath, mobile);
  const visual = {
    version: 1,
    producer: "capture-report.mjs",
    htmlPath: composed.htmlPath,
    htmlSha256: sha256Text(html),
    screenshots: [
      { id: "desktop", path: desktopPath, sha256: sha256Text(desktop) },
      { id: "mobile", path: mobilePath, sha256: sha256Text(mobile) },
    ],
  };
  await writeFile(join(session, "report", "visual-check.json"), `${JSON.stringify(visual, null, 2)}\n`);
  const draftPath = join(session, "report", "design-result.draft.json");
  await writeFile(draftPath, JSON.stringify({
    status: "pass",
    viewports: { desktop: { pass: true }, mobile: { pass: true } },
    notes: [],
  }));
  await finalizeDesign(session, draftPath);

  await mkdir(join(session, "debug"), { recursive: true });
  const gateState = {
    version: 1,
    producer: "stage-gate.mjs",
    mode: "step",
    approvals: ["A_CONFIG", "B0_PREFLIGHT", "B2_WRITER", "B3_RESEARCH"].map((stage) => ({ stage })),
  };
  await writeFile(join(session, "debug", "pipeline-state.json"), JSON.stringify(gateState));
  const blocked = await checkSessionLayout(session, { phase: "html" });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some((error) => /B4_REVIEW.*not approved/.test(error)));

  gateState.approvals.push({ stage: "B4_REVIEW" });
  await writeFile(join(session, "debug", "pipeline-state.json"), JSON.stringify(gateState));
  const layout = await checkSessionLayout(session, { phase: "html" });
  assert.equal(layout.ok, true, layout.errors.join("; "));
});
