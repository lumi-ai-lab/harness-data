#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeLink(href) {
  const value = String(href || "").trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  return null;
}

export function renderInline(value) {
  const slots = [];
  const reserve = (html) => {
    const index = slots.length;
    slots.push(html);
    return `\u0000INLINE${index}\u0000`;
  };

  let text = String(value)
    .replace(/`([^`]+)`/g, (_match, code) => reserve(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
      const safeHref = safeLink(href);
      if (!safeHref) return reserve(`<span class="md-ref">${escapeHtml(label)}</span>`);
      return reserve(
        `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
      );
    });

  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\u0000INLINE(\d+)\u0000/g, (_match, index) => slots[Number(index)] || "");
  return text;
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(line) && /---/.test(line);
}

function parseTableRow(line) {
  let text = String(line).trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);

  const cells = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && index + 1 < text.length) {
      current += character + text[index + 1];
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function renderTableCell(value) {
  const slots = [];
  const reserve = (content) => {
    const index = slots.length;
    slots.push(content);
    return `\u0000TABLE${index}\u0000`;
  };
  const protectedValue = String(value || "")
    .replace(/\\\\/g, () => reserve("\\"))
    .replace(/\\\|/g, () => reserve("|"))
    .replace(/\\`/g, () => reserve("`"))
    .replace(/<br\s*\/?\s*>/gi, () => reserve("<br />"));

  return renderInline(protectedValue).replace(/\u0000TABLE(\d+)\u0000/g, (_match, index) => {
    const content = slots[Number(index)] || "";
    return content === "<br />" ? content : escapeHtml(content);
  });
}

function headingId(value) {
  return String(value)
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 64);
}

export function markdownToHtml(markdown) {
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let index = 0;
  let listType = null;
  let inQuote = false;

  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = null;
  };
  const closeQuote = () => {
    if (!inQuote) return;
    output.push("</blockquote>");
    inQuote = false;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      closeQuote();
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      closeList();
      closeQuote();
      const language = trimmed.slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(
        `<pre class="code-block"${language ? ` data-lang="${escapeHtml(language)}"` : ""}><code>${escapeHtml(code.join("\n"))}</code></pre>`
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      closeQuote();
      const level = heading[1].length;
      const text = heading[2].trim();
      output.push(`<h${level} id="${escapeHtml(headingId(text))}">${renderInline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (trimmed.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      closeList();
      closeQuote();
      const headers = parseTableRow(trimmed);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|") && !isTableSeparator(lines[index])) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }
      output.push('<div class="table-wrap"><table><thead><tr>');
      for (const header of headers) output.push(`<th>${renderTableCell(header)}</th>`);
      output.push("</tr></thead><tbody>");
      for (const row of rows) {
        output.push("<tr>");
        for (let column = 0; column < headers.length; column += 1) {
          output.push(`<td>${renderTableCell(row[column] || "")}</td>`);
        }
        output.push("</tr>");
      }
      output.push("</tbody></table></div>");
      continue;
    }

    if (trimmed.startsWith(">")) {
      closeList();
      if (!inQuote) {
        output.push('<blockquote class="callout">');
        inQuote = true;
      }
      output.push(`<p>${renderInline(trimmed.replace(/^>\s?/, ""))}</p>`);
      index += 1;
      continue;
    }
    closeQuote();

    const unordered = /^[-*+]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) closeList();
      if (!listType) {
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      index += 1;
      continue;
    }
    closeList();

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      output.push("<hr />");
      index += 1;
      continue;
    }

    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next) break;
      if (/^(#{1,6})\s+/.test(next) || next.startsWith(">") || next.startsWith("```")) break;
      if (/^[-*+]\s+/.test(next) || /^\d+\.\s+/.test(next)) break;
      if (next.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) break;
      paragraph.push(next);
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  closeList();
  closeQuote();
  return output.join("\n");
}

export function extractTitle(markdown) {
  return /^#\s+(.+)$/m.exec(String(markdown))?.[1]?.trim() || "分析报告";
}

export function buildStandaloneHtml({ title, bodyHtml, generatedAt = new Date().toISOString() }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; --accent:#155e75; --surface:#fff; --page:#f4f7f9; --line:#dbe4ea; --muted:#64748b; }
    * { box-sizing: border-box; }
    body { margin:0; color:#172033; background:var(--page); font:15px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
    .page { width:min(960px,calc(100% - 32px)); margin:32px auto 64px; }
    .report-header { padding:28px 30px; color:#fff; background:linear-gradient(135deg,#155e75,#0f766e); border-radius:18px 18px 0 0; }
    .report-header h1 { margin:0; font-size:clamp(1.55rem,4vw,2.2rem); line-height:1.25; }
    .report-header p { margin:10px 0 0; opacity:.82; font-size:.86rem; }
    .report-body { padding:22px 30px 38px; background:var(--surface); border:1px solid var(--line); border-top:0; border-radius:0 0 18px 18px; box-shadow:0 18px 45px rgba(15,23,42,.08); }
    .report-body > h1:first-child { display:none; }
    h2 { margin:1.7em 0 .65em; color:#134e4a; border-bottom:2px solid #ccfbf1; }
    h3,h4 { color:#155e75; }
    a { color:#0369a1; }
    code { padding:.1em .35em; background:#eef2f6; border-radius:4px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
    .code-block { padding:16px; overflow:auto; color:#e2e8f0; background:#0f172a; border-radius:10px; }
    .code-block code { padding:0; color:inherit; background:transparent; }
    .callout { margin:1em 0; padding:12px 16px; color:#134e4a; background:#ecfeff; border-left:4px solid var(--accent); border-radius:0 10px 10px 0; }
    .callout p { margin:.2em 0; }
    .table-wrap { margin:1em 0; overflow:auto; }
    table { width:100%; min-width:480px; border-collapse:collapse; }
    th,td { padding:9px 11px; text-align:left; vertical-align:top; border:1px solid var(--line); }
    th { color:#fff; background:var(--accent); white-space:nowrap; }
    tbody tr:nth-child(even) { background:#f8fafc; }
    .md-ref { color:var(--muted); border-bottom:1px dashed #94a3b8; }
    hr { margin:1.5em 0; border:0; border-top:1px solid var(--line); }
    @media (max-width:640px) { .page{width:100%;margin:0}.report-header,.report-body{border-radius:0}.report-header,.report-body{padding-left:20px;padding-right:20px} }
    @media print { body{background:#fff}.page{width:100%;margin:0}.report-header,.report-body{box-shadow:none;border-radius:0} }
  </style>
</head>
<body>
  <main class="page">
    <header class="report-header">
      <h1>${escapeHtml(title)}</h1>
      <p>生成时间：${escapeHtml(generatedAt)}</p>
    </header>
    <article class="report-body">
${bodyHtml}
    </article>
  </main>
</body>
</html>
`;
}

export async function renderMarkdownFile(markdownPath, outputPath) {
  const markdown = await readFile(resolve(markdownPath), "utf8");
  const title = extractTitle(markdown);
  const html = buildStandaloneHtml({ title, bodyHtml: markdownToHtml(markdown) });
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, html);
  return { title, htmlPath: absoluteOutput, bytes: Buffer.byteLength(html, "utf8") };
}

function optionValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const argumentsList = process.argv.slice(2);
    const markdownPath = optionValue(argumentsList, "--md");
    const outputPath = optionValue(argumentsList, "--out");
    if (!markdownPath || !outputPath) {
      process.stderr.write("usage: render-report.mjs --md <report.md> --out <report.html>\n");
      process.exit(2);
    }
    const result = await renderMarkdownFile(markdownPath, outputPath);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

