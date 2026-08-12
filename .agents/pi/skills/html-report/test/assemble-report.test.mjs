import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleReport, extractRows, rowsToMarkdown } from "../scripts/assemble-report.mjs";
import { rowsSha256 } from "../scripts/prepare-research-evidence.mjs";

test("assemble-report generates full tables from entry.json, not section prose", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-assemble-"));
  const session = join(root, ".harness", "state", "html-report", "s1");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [{ id: "c1", title: "卡片一" }] }));
  await writeFile(join(session, "analysis", "main.md"), "# 主报告\n\n摘要 999\n");
  await writeFile(
    join(session, "analysis", "tasks.json"),
    JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] })
  );
  await writeFile(join(session, "analysis", "sections", "c1.md"), "只包含第一行的旧章节\n");
  const rows = [{ 日期: "2026-07-01", 销售额: 10 }, { 日期: "2026-07-02", 销售额: 20 }];
  await writeFile(
    join(session, "data", "cards", "c1", "entry.meta.json"),
    JSON.stringify({ rowCount: rows.length, rowsSha256: rowsSha256(rows) })
  );
  await writeFile(
    join(session, "data", "cards", "c1", "entry.json"),
    JSON.stringify(rows)
  );

  const output = await assembleReport(session);
  const report = await readFile(output.reportPath, "utf8");
  const manifest = JSON.parse(await readFile(output.manifestPath, "utf8"));
  assert.match(report, /## 数据附录/);
  assert.match(report, /### 全量明细：卡片一/);
  assert.match(report, /2026-07-01/);
  assert.match(report, /2026-07-02/);
  assert.match(report, /html-report:full-table card="c1" rows="2"/);
  assert.equal(manifest.cards[0].sourceRows, 2);
  assert.equal(manifest.cards[0].renderedRows, 2);
  assert.equal(manifest.cards[0].fullTable, true);

  await writeFile(join(session, "result.json"), JSON.stringify({ cards: [{ id: "c1", title: "卡片一" }] }));
  await assert.rejects(() => assembleReport(session), /result\.status must be confirmed/);
  await writeFile(
    join(session, "result.json"),
    JSON.stringify({ status: "confirmed", cards: [{ id: "c1", title: "卡片一" }] })
  );
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({ version: 1, tasks: [] }));
  await assert.rejects(() => assembleReport(session), /version 2 document/);
});

test("assemble-report exposes generic row extraction and markdown escaping", () => {
  assert.deepEqual(extractRows({ rows: [{ a: 1 }] }), [{ a: 1 }]);
  const table = rowsToMarkdown([{ a: "x|y", b: 2 }]);
  assert.equal(table.rowCount, 1);
  assert.match(table.markdown, /x\\\|y/);
});

test("assemble-report preserves a successful zero-row Writer result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-assemble-empty-"));
  const session = join(root, ".harness", "state", "html-report", "empty");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis"), { recursive: true });
  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  const rows = [];
  await writeFile(join(session, "result.json"), JSON.stringify({
    status: "confirmed",
    cards: [{ id: "c1", title: "空结果卡片" }],
  }));
  await writeFile(join(session, "analysis", "main.md"), "# 主报告\n");
  await writeFile(
    join(session, "analysis", "tasks.json"),
    JSON.stringify({ version: 2, round: 0, maxRounds: 2, tasks: [] })
  );
  await writeFile(join(session, "data", "cards", "c1", "entry.json"), JSON.stringify(rows));
  await writeFile(
    join(session, "data", "cards", "c1", "entry.meta.json"),
    JSON.stringify({ rowCount: 0, rowsSha256: rowsSha256(rows) })
  );

  const output = await assembleReport(session);
  const report = await readFile(output.reportPath, "utf8");
  const manifest = JSON.parse(await readFile(output.manifestPath, "utf8"));
  assert.match(report, /html-report:full-table card="c1" rows="0"/);
  assert.match(report, /本次查询返回 0 行明细/);
  assert.equal(manifest.cards[0].fullTable, true);
  assert.equal(manifest.cards[0].sourceRows, 0);
  assert.equal(manifest.cards[0].renderedRows, 0);
});

test("assemble-report reuses Writer table for reuse_entry and auto-renders new_query rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-assemble-research-"));
  const session = join(root, ".harness", "state", "html-report", "s2");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "analysis", "sections"), { recursive: true });
  await mkdir(join(session, "data", "cards", "c1"), { recursive: true });
  await mkdir(join(session, "data", "explore"), { recursive: true });
  const writerRows = [{ 日期: "07-01", 毛利额: 100 }];
  const exploreRows = [{ 品类: "A", 毛利额: 60 }, { 品类: "B", 毛利额: 40 }];
  await writeFile(join(session, "result.json"), JSON.stringify({ status: "confirmed", cards: [{ id: "c1", title: "卡片一" }] }));
  await writeFile(join(session, "analysis", "main.md"), "# 主报告\n");
  await writeFile(join(session, "data", "cards", "c1", "entry.json"), JSON.stringify(writerRows));
  await writeFile(join(session, "data", "cards", "c1", "entry.meta.json"), JSON.stringify({ rowCount: 1, rowsSha256: rowsSha256(writerRows) }));
  await writeFile(join(session, "data", "explore", "new-1.json"), JSON.stringify(exploreRows));
  await writeFile(join(session, "data", "explore", "new-1.meta.json"), JSON.stringify({ status: "ok", rowCount: 2, rowsSha256: rowsSha256(exploreRows) }));
  await writeFile(join(session, "analysis", "sections", "explore-reuse-1.md"), "复用 Writer 证据。\n");
  await writeFile(join(session, "analysis", "sections", "explore-new-1.md"), "解读新增查询证据。\n");
  await writeFile(join(session, "analysis", "tasks.json"), JSON.stringify({
    version: 2,
    round: 1,
    maxRounds: 2,
    tasks: [
      { id: "reuse-1", status: "done", fromCardId: "c1", evidencePlan: { mode: "reuse_entry" } },
      { id: "new-1", status: "done", goal: "品类对比", evidencePlan: { mode: "new_query" } },
    ],
  }));
  const output = await assembleReport(session);
  const report = await readFile(output.reportPath, "utf8");
  const manifest = JSON.parse(await readFile(output.manifestPath, "utf8"));
  assert.equal((report.match(/html-report:full-table card="c1"/g) || []).length, 1);
  assert.match(report, /html-report:full-explore-table task="new-1" rows="2"/);
  assert.match(report, /\| A \| 60 \|/);
  assert.ok(
    report.indexOf("## 深入分析：品类对比") < report.indexOf("## 数据附录"),
    "Researcher analysis must precede the full-data appendix"
  );
  assert.equal(manifest.tasks.find((task) => task.taskId === "reuse-1").fullTableSource, "writer_entry");
  assert.equal(manifest.tasks.find((task) => task.taskId === "new-1").renderedRows, 2);
});
