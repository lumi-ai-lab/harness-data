#!/usr/bin/env node
/**
 * Deprecated deterministic fallback renderer.
 *
 * Usage:
 *   node render-report.mjs --fallback --result <result.json>
 *   node render-report.mjs --fallback --session-dir .harness/state/html-report/<id>
 *   node render-report.mjs --md <report.md> --out <report.html>   # offline / test
 *
 * Gates (unless --force):
 *   - report/report.md exists
 *   - quality/verdict.json exists with pass === true and draft !== true
 *
 * Writes: $SESSION/report/report.html + render.meta.json
 */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline markdown: links, **bold**, *em*, `code`, bare text. */
export function renderInline(text) {
  // Extract links first so URL special chars are not double-escaped wrongly inside href.
  const linkSlots = [];
  let raw = String(text).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const i = linkSlots.length;
    linkSlots.push({ label, href });
    return `\u0000LINK${i}\u0000`;
  });
  let s = escapeHtml(raw);
  // code first
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italic (single *)
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  // restore links as <a> (or plain text if relative section path we keep as styled link text)
  s = s.replace(/\u0000LINK(\d+)\u0000/g, (_, idx) => {
    const { label, href } = linkSlots[Number(idx)] || { label: "", href: "#" };
    const safeHref = escapeHtml(href);
    const safeLabel = escapeHtml(label);
    // Relative ./sections/*.md is not served with report.html — show label as emphasis, not a broken link.
    if (/^\.\/|^sections\//i.test(href) || /\.md$/i.test(href)) {
      return `<span class="md-ref" title="${safeHref}">${safeLabel}</span>`;
    }
    return `<a href="${safeHref}">${safeLabel}</a>`;
  });
  return s;
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(line) && /---/.test(line);
}

function parseTableRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let index = 0; index < t.length; index += 1) {
    const char = t[index];
    if (char === "\\" && t[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isHtmlReportControlComment(line) {
  return /^<!--\s*html-report:[\s\S]*-->$/.test(String(line).trim());
}

/**
 * Convert a subset of GFM markdown (headers, tables, lists, quotes, hr, p)
 * into HTML body fragments. Does not invent content.
 */
export function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inUl = false;
  let inOl = false;
  let inBq = false;

  const closeLists = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };
  const closeBq = () => {
    if (inBq) {
      out.push("</blockquote>");
      inBq = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // blank
    if (!trimmed) {
      closeLists();
      closeBq();
      i += 1;
      continue;
    }

    // fenced code (keep literal)
    if (trimmed.startsWith("```")) {
      closeLists();
      closeBq();
      const lang = trimmed.slice(3).trim();
      i += 1;
      const buf = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      out.push(
        `<pre class="code-block"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(buf.join("\n"))}</code></pre>`
      );
      continue;
    }

    // Full-table markers must survive as raw comments for layout validation.
    // All other html-report control comments are internal metadata and must not
    // become visible escaped Markdown content. Fenced code is handled above, so
    // examples inside a code block remain literal.
    const fullTableMarker = /^<!--\s*html-report:full-table\s+card="([^"]+)"\s+rows="(\d+)"\s*-->$/.exec(trimmed);
    if (fullTableMarker) {
      closeLists();
      closeBq();
      out.push(`<!-- html-report:full-table card="${escapeHtml(fullTableMarker[1])}" rows="${fullTableMarker[2]}" -->`);
      i += 1;
      continue;
    }
    const fullExploreTableMarker = /^<!--\s*html-report:full-explore-table\s+task="([^"]+)"\s+rows="(\d+)"\s*-->$/.exec(trimmed);
    if (fullExploreTableMarker) {
      closeLists();
      closeBq();
      out.push(`<!-- html-report:full-explore-table task="${escapeHtml(fullExploreTableMarker[1])}" rows="${fullExploreTableMarker[2]}" -->`);
      i += 1;
      continue;
    }
    if (isHtmlReportControlComment(trimmed)) {
      closeLists();
      closeBq();
      i += 1;
      continue;
    }

    // hr
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeLists();
      closeBq();
      out.push("<hr />");
      i += 1;
      continue;
    }

    // headings
    const hm = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (hm) {
      closeLists();
      closeBq();
      const level = hm[1].length;
      const text = hm[2].trim();
      const id = text
        .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
        .slice(0, 64);
      const cls = level <= 2 ? ` class="heading-l${level}"` : "";
      out.push(`<h${level} id="${escapeHtml(id)}"${cls}>${renderInline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    // table: header + separator + rows
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      closeLists();
      closeBq();
      const header = parseTableRow(trimmed);
      i += 2; // skip sep
      const rows = [];
      while (i < lines.length && lines[i].trim().includes("|") && !isTableSeparator(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      out.push('<div class="table-wrap"><table>');
      out.push("<thead><tr>");
      for (const h of header) out.push(`<th>${renderInline(h)}</th>`);
      out.push("</tr></thead><tbody>");
      for (const row of rows) {
        // pad/truncate to header length
        out.push("<tr>");
        for (let c = 0; c < header.length; c += 1) {
          const cell = row[c] ?? "";
          const highlight = /\*\*.+\*\*/.test(cell) || /✅/.test(cell);
          out.push(`<td${highlight ? ' class="cell-highlight"' : ""}>${renderInline(cell)}</td>`);
        }
        out.push("</tr>");
      }
      out.push("</tbody></table></div>");
      continue;
    }

    // blockquote
    if (trimmed.startsWith(">")) {
      closeLists();
      if (!inBq) {
        out.push('<blockquote class="callout">');
        inBq = true;
      }
      const body = trimmed.replace(/^>\s?/, "");
      out.push(`<p>${renderInline(body)}</p>`);
      i += 1;
      continue;
    }
    if (inBq) closeBq();

    // unordered list
    const ulm = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (ulm) {
      closeBq();
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${renderInline(ulm[1])}</li>`);
      i += 1;
      continue;
    }

    // ordered list
    const olm = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olm) {
      closeBq();
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${renderInline(olm[1])}</li>`);
      i += 1;
      continue;
    }

    closeLists();
    // paragraph: merge consecutive non-blank non-special lines
    const para = [trimmed];
    i += 1;
    while (i < lines.length) {
      const n = lines[i].trim();
      if (!n) break;
      if (/^#{1,6}\s/.test(n) || n.startsWith(">") || /^[-*+]\s/.test(n) || /^\d+\.\s/.test(n)) break;
      if (n.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(n) || n.startsWith("```")) break;
      if (isHtmlReportControlComment(n)) break;
      para.push(n);
      i += 1;
    }
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  closeLists();
  closeBq();
  return out.join("\n");
}

export function extractTitle(md) {
  const m = /^#\s+(.+)$/m.exec(String(md));
  return m ? m[1].trim() : "分析报告";
}

export function buildReportHtml({ title, bodyHtml, meta = {} }) {
  const generatedAt = meta.generatedAt || new Date().toISOString();
  const sessionId = meta.sessionId || "";
  const qualityPass = meta.qualityPass;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #f6f7f9;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --border: #e5e7eb;
      --accent: #0f766e;
      --accent-soft: #ccfbf1;
      --highlight: #fef3c7;
      --thead: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
      color: var(--text);
      background: var(--bg);
      line-height: 1.65;
      font-size: 15px;
    }
    .page {
      max-width: 920px;
      margin: 0 auto;
      padding: 28px 20px 64px;
    }
    header.report-header {
      background: linear-gradient(135deg, #0f766e 0%, #115e59 55%, #134e4a 100%);
      color: #fff;
      border-radius: 14px;
      padding: 22px 24px;
      margin-bottom: 22px;
      box-shadow: 0 8px 24px rgba(15, 118, 110, 0.18);
    }
    header.report-header h1 {
      margin: 0 0 8px;
      font-size: 1.45rem;
      font-weight: 650;
      letter-spacing: 0.02em;
    }
    header.report-header .meta {
      font-size: 0.85rem;
      opacity: 0.9;
      display: flex;
      flex-wrap: wrap;
      gap: 10px 18px;
    }
    header.report-header .badge {
      display: inline-block;
      background: rgba(255,255,255,0.18);
      border: 1px solid rgba(255,255,255,0.28);
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 0.78rem;
    }
    article.report-body {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 8px 28px 32px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    article.report-body h1 { display: none; /* title in header */ }
    article.report-body h2 {
      margin: 1.6em 0 0.6em;
      padding-bottom: 0.35em;
      border-bottom: 2px solid var(--accent-soft);
      color: #134e4a;
      font-size: 1.2rem;
    }
    article.report-body h3 {
      margin: 1.25em 0 0.5em;
      color: #115e59;
      font-size: 1.05rem;
    }
    article.report-body h4 { margin: 1em 0 0.4em; color: #374151; }
    article.report-body p { margin: 0.65em 0; }
    article.report-body ul, article.report-body ol { margin: 0.5em 0 0.8em; padding-left: 1.4em; }
    article.report-body li { margin: 0.25em 0; }
    article.report-body a { color: #0f766e; }
    span.md-ref { color: #0f766e; font-weight: 600; border-bottom: 1px dashed #99f6e4; }
    blockquote.callout {
      margin: 1em 0;
      padding: 12px 16px;
      background: var(--accent-soft);
      border-left: 4px solid var(--accent);
      border-radius: 0 10px 10px 0;
      color: #134e4a;
    }
    blockquote.callout p { margin: 0.2em 0; font-weight: 560; }
    .table-wrap { overflow-x: auto; margin: 0.9em 0 1.2em; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
      min-width: 420px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--thead);
      color: #fff;
      font-weight: 600;
      white-space: nowrap;
    }
    tbody tr:nth-child(even) { background: #f9fafb; }
    td.cell-highlight, td strong { background: var(--highlight); }
    td.cell-highlight { font-weight: 600; }
    hr {
      border: 0;
      border-top: 1px dashed var(--border);
      margin: 1.5em 0;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.88em;
      background: #f3f4f6;
      padding: 1px 5px;
      border-radius: 4px;
    }
    pre.code-block {
      background: #111827;
      color: #e5e7eb;
      padding: 12px 14px;
      border-radius: 10px;
      overflow-x: auto;
      font-size: 0.85rem;
    }
    pre.code-block code { background: transparent; color: inherit; padding: 0; }
    footer.report-footer {
      margin-top: 18px;
      color: var(--muted);
      font-size: 0.8rem;
      text-align: center;
    }
    @media print {
      body { background: #fff; }
      .page { max-width: none; padding: 0; }
      header.report-header {
        box-shadow: none;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      article.report-body { box-shadow: none; border: none; padding: 0; }
      th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="report-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        ${qualityPass === true ? '<span class="badge">质量门禁已通过</span>' : ""}
        ${sessionId ? `<span>Session: ${escapeHtml(sessionId)}</span>` : ""}
        <span>生成时间: ${escapeHtml(generatedAt)}</span>
      </div>
    </header>
    <article class="report-body">
${bodyHtml}
    </article>
    <footer class="report-footer">
      由 html-report P5（render-report.mjs）从 report.md 渲染 · 数值以 SESSION data 与 MD 为准
    </footer>
  </div>
</body>
</html>
`;
}

export async function renderSessionReport(sessionDir, { force = false, fallback = false } = {}) {
  if (!fallback) {
    throw new Error("render-report.mjs is deprecated fallback only; normal B5 must use the Report Designer compile/compose pipeline");
  }
  const abs = resolve(sessionDir);
  const mdPath = join(abs, "report", "report.md");
  const htmlPath = join(abs, "report", "report.html");
  const metaPath = join(abs, "report", "render.meta.json");
  const verdictPath = join(abs, "quality", "verdict.json");

  if (!(await exists(mdPath))) {
    throw new Error(`missing report/report.md under ${abs} (freeze main.md after quality pass first)`);
  }

  let qualityPass = null;
  if (await exists(verdictPath)) {
    const verdict = JSON.parse(await readFile(verdictPath, "utf8"));
    qualityPass = verdict.pass === true && verdict.draft !== true;
    if (!force && !qualityPass) {
      throw new Error("quality/verdict.json is not pass=true; refuse to render HTML (use --force to override)");
    }
  } else if (!force) {
    throw new Error("missing quality/verdict.json; refuse to render HTML (use --force to override)");
  }

  const md = await readFile(mdPath, "utf8");
  const title = extractTitle(md);
  const bodyHtml = markdownToHtml(md);
  let sessionId = basename(abs);
  try {
    const result = JSON.parse(await readFile(join(abs, "result.json"), "utf8"));
    if (result.session_id || result.sessionId) sessionId = result.session_id || result.sessionId;
  } catch {
    // ignore
  }

  const generatedAt = new Date().toISOString();
  const html = buildReportHtml({
    title,
    bodyHtml,
    meta: { generatedAt, sessionId, qualityPass: qualityPass === true },
  });

  await mkdir(join(abs, "report"), { recursive: true });
  await writeFile(htmlPath, html);
  const meta = {
    version: 2,
    producer: "render-report.mjs",
    source: "render-report.mjs",
    fallback: true,
    mdPath,
    htmlPath,
    title,
    generatedAt,
    qualityPass: qualityPass === true,
    bytes: Buffer.byteLength(html, "utf8"),
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const force = has("--force");
    const mdArg = value("--md");
    const outArg = value("--out");
    if (mdArg && outArg) {
      const md = await readFile(resolve(mdArg), "utf8");
      const title = extractTitle(md);
      const html = buildReportHtml({
        title,
        bodyHtml: markdownToHtml(md),
        meta: { generatedAt: new Date().toISOString(), qualityPass: true },
      });
      await mkdir(dirname(resolve(outArg)), { recursive: true });
      await writeFile(resolve(outArg), html);
      process.stdout.write(`${JSON.stringify({ ok: true, htmlPath: resolve(outArg), title }, null, 2)}\n`);
      process.exit(0);
    }

    let sessionDir = value("--session-dir");
    const resultPath = value("--result");
    if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
    if (!sessionDir) {
      process.stderr.write(
        "usage: render-report.mjs --fallback --result <result.json> | --fallback --session-dir <dir> | --md <md> --out <html> [--force]\n"
      );
      process.exit(2);
    }
    const meta = await renderSessionReport(sessionDir, { force, fallback: has("--fallback") });
    process.stdout.write(`${JSON.stringify({ ok: true, ...meta }, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
