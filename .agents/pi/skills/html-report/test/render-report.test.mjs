import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  escapeHtml,
  renderInline,
  markdownToHtml,
  extractTitle,
  renderSessionReport,
} from "../scripts/render-report.mjs";

test("escapeHtml and renderInline handle bold and code", () => {
  assert.equal(escapeHtml("<x&y>"), "&lt;x&amp;y&gt;");
  assert.match(renderInline("金额 **3,200** 元"), /<strong>3,200<\/strong>/);
  assert.match(renderInline("用 `entry.json`"), /<code>entry\.json<\/code>/);
});

test("renderInline turns markdown links into anchors or md-ref spans", () => {
  const external = renderInline("见 [文档](https://example.com/a)");
  assert.match(external, /<a href="https:\/\/example\.com\/a">文档<\/a>/);
  // Relative section paths should not appear as raw [text](./x.md) in HTML
  const rel = renderInline("- [Section: balance-001](./sections/balance-001.md) — 说明");
  assert.doesNotMatch(rel, /\[Section: balance-001\]\(\.\/sections\//);
  assert.match(rel, /md-ref|Section: balance-001/);
});

test("markdownToHtml converts headers, tables, lists, blockquotes", () => {
  const md = [
    "# 主标题",
    "",
    "## 核心结论",
    "",
    "> **客流保底620+**",
    "",
    "| 维度 | 值 |",
    "| --- | --- |",
    "| 来客数 | **650** ✅ |",
    "",
    "- 建议一",
    "- 建议二",
    "",
    "1. 第一步",
    "",
    "普通段落。",
  ].join("\n");
  const html = markdownToHtml(md);
  assert.match(html, /<h1[^>]*>主标题<\/h1>/);
  assert.match(html, /<h2[^>]*>核心结论<\/h2>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>维度<\/th>/);
  assert.match(html, /cell-highlight/);
  assert.match(html, /<blockquote/);
  assert.match(html, /<ul>/);
  assert.match(html, /<ol>/);
  assert.match(html, /普通段落/);
  assert.equal(extractTitle(md), "主标题");
});

test("markdownToHtml keeps escaped pipes inside one table cell", () => {
  const html = markdownToHtml("| label | value |\n| --- | --- |\n| A \\| B | 1 |\n");
  assert.match(html, /<td>A \| B<\/td>/);
  assert.equal((html.match(/<td>/g) || []).length, 2);
});

test("markdownToHtml hides internal control comments but preserves table validation markers", () => {
  const html = markdownToHtml([
    "正文前段",
    '<!-- html-report:research-summary:start -->',
    "正文后段",
    '<!-- html-report:research-summary:end -->',
    '<!-- html-report:research-section task="drill-1" sha256="abc" -->',
    '<!-- html-report:full-table card="card-1" rows="2" -->',
    '<!-- html-report:full-explore-table task="explore-1" rows="3" -->',
  ].join("\n"));

  assert.match(html, /<p>正文前段<\/p>/);
  assert.match(html, /<p>正文后段<\/p>/);
  assert.doesNotMatch(html, /research-summary|research-section/);
  assert.doesNotMatch(html, /&lt;!--\s*html-report:/);
  assert.match(html, /<!-- html-report:full-table card="card-1" rows="2" -->/);
  assert.match(html, /<!-- html-report:full-explore-table task="explore-1" rows="3" -->/);
});

test("markdownToHtml keeps html-report control comments literal inside fenced code", () => {
  const html = markdownToHtml([
    "```html",
    '<!-- html-report:research-section task="drill-1" sha256="abc" -->',
    '<!-- html-report:full-table card="card-1" rows="2" -->',
    "```",
  ].join("\n"));

  assert.match(html, /<pre class="code-block" data-lang="html"><code>/);
  assert.match(html, /&lt;!-- html-report:research-section task=&quot;drill-1&quot; sha256=&quot;abc&quot; --&gt;/);
  assert.match(html, /&lt;!-- html-report:full-table card=&quot;card-1&quot; rows=&quot;2&quot; --&gt;/);
});

test("renderSessionReport refuses without quality pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-render-deny-"));
  const session = join(root, ".harness", "state", "html-report", "r1");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "report"), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ session_id: "r1" }));
  await writeFile(join(session, "report", "report.md"), "# t\n\nok\n");
  await assert.rejects(() => renderSessionReport(session, { fallback: true }), /verdict|quality/i);
});

test("renderSessionReport is disabled on the normal B5 path", async () => {
  await assert.rejects(() => renderSessionReport("/tmp/unused"), /deprecated fallback only/i);
});

test("renderSessionReport writes report.html after quality pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "html-report-render-ok-"));
  const session = join(root, ".harness", "state", "html-report", "r2");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(session, "report"), { recursive: true });
  await mkdir(join(session, "quality"), { recursive: true });
  await writeFile(join(session, "result.json"), JSON.stringify({ session_id: "r2", title: "t" }));
  await writeFile(
    join(session, "quality", "verdict.json"),
    JSON.stringify({ version: 1, pass: true, draft: false })
  );
  await writeFile(
    join(session, "report", "report.md"),
    ["# 平衡点分析", "", "| a | b |", "| --- | --- |", "| 1 | **2** |", "", "> 结论"].join("\n")
  );

  const meta = await renderSessionReport(session, { fallback: true });
  assert.equal(meta.title, "平衡点分析");
  assert.equal(meta.qualityPass, true);
  const html = await readFile(join(session, "report", "report.html"), "utf8");
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /平衡点分析/);
  assert.match(html, /<table>/);
  assert.match(html, /质量门禁已通过/);
  const diskMeta = JSON.parse(await readFile(join(session, "report", "render.meta.json"), "utf8"));
  assert.equal(diskMeta.version, 2);
  assert.equal(diskMeta.fallback, true);
});
