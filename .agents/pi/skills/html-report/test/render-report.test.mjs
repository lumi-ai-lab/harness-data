import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildStandaloneHtml,
  escapeHtml,
  extractTitle,
  markdownToHtml,
  renderInline,
} from "../scripts/render-report.mjs";

test("inline rendering escapes HTML and sanitizes links", () => {
  assert.equal(escapeHtml("<x&y>"), "&lt;x&amp;y&gt;");
  assert.match(renderInline("金额 **3,200** 元"), /<strong>3,200<\/strong>/);
  assert.match(renderInline("见 [文档](https:\/\/example.com)"), /rel="noreferrer"/);
  assert.doesNotMatch(renderInline("[危险](javascript:alert(1))"), /href=/);
});

test("markdown rendering supports headings, tables, lists, quotes and code", () => {
  const markdown = [
    "# 经营分析",
    "",
    "## 核心结论",
    "",
    "> 指标保持稳定。",
    "",
    "| 日期 | 数值 |",
    "| --- | --- |",
    "| 2026-08-01 | **120** |",
    "",
    "- 建议一",
    "- 建议二",
    "",
    "```json",
    "{\"ok\":true}",
    "```",
  ].join("\n");
  const html = markdownToHtml(markdown);
  assert.equal(extractTitle(markdown), "经营分析");
  assert.match(html, /<h2[^>]*>核心结论<\/h2>/);
  assert.match(html, /<blockquote class="callout">/);
  assert.match(html, /<table>/);
  assert.match(html, /<ul>/);
  assert.match(html, /data-lang="json"/);
});

test("table rendering preserves escaped pipes, backslashes and line breaks", () => {
  const html = markdownToHtml([
    "| 字段 | 值 |",
    "| --- | --- |",
    "| 特殊 | a\\|b\\\\c<br>\\`d\\` |",
  ].join("\n"));
  assert.match(html, /<td>a\|b\\c<br \/>`d`<\/td>/);
  assert.equal((html.match(/<td>/g) || []).length, 2);
});

test("standalone HTML contains inline styles and no external assets", () => {
  const html = buildStandaloneHtml({ title: "测试报告", bodyHtml: "<p>内容</p>" });
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i);
  assert.match(html, /测试报告/);
});

test("CLI writes a self-contained HTML file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "html-single-file-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const markdownPath = join(directory, "report.md");
  const htmlPath = join(directory, "output", "report.html");
  await writeFile(markdownPath, "# 单文件报告\n\n| 指标 | 值 |\n| --- | --- |\n| 销售额 | 100 |\n");

  const scriptPath = new URL("../scripts/render-report.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [scriptPath, "--md", markdownPath, "--out", htmlPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /单文件报告/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<link\b|<script\b[^>]*\bsrc=/i);
});

