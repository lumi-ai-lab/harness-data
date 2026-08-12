#!/usr/bin/env node
/** Compose Designer-owned shell/CSS with the immutable compiled report body. */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./render-report.mjs";
import { sha256Text } from "./compile-report-content.mjs";

const CONTENT_SLOT = "<!-- HTML_REPORT_CONTENT -->";
const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function replaceAll(text, token, replacement) {
  return text.split(token).join(replacement);
}

export function validateDesignTemplate(template) {
  const errors = [];
  if (!/<!doctype html>/i.test(template)) errors.push("template must contain <!DOCTYPE html>");
  if (!/<html\b/i.test(template) || !/<head\b/i.test(template) || !/<body\b/i.test(template)) {
    errors.push("template must contain html/head/body elements");
  }
  const slots = template.split(CONTENT_SLOT).length - 1;
  if (slots !== 1) errors.push(`template must contain exactly one ${CONTENT_SLOT} slot`);
  if (/html-report:full-table/.test(template)) errors.push("template must not copy report business content or full-table markers");
  if (/html-report:content-(?:start|end)|data-html-report-content\s*=\s*["']immutable["']/i.test(template)) {
    errors.push("template must not embed immutable report.content.html; compose-report.mjs owns content insertion");
  }
  return errors;
}

export async function composeReport(sessionDir, { templatePath } = {}) {
  const abs = resolve(sessionDir);
  const reportDir = join(abs, "report");
  const inputPath = join(reportDir, "design-input.json");
  const contentPath = join(reportDir, "report.content.html");
  const shellPath = resolve(templatePath || join(reportDir, "report.design.html"));
  const htmlPath = join(reportDir, "report.html");
  const metaPath = join(reportDir, "render.meta.json");
  for (const required of [inputPath, contentPath, shellPath]) {
    if (!(await exists(required))) throw new Error(`missing required design artifact: ${required}`);
  }

  const input = JSON.parse(await readFile(inputPath, "utf8"));
  if (input.producer !== "compile-report-content.mjs") {
    throw new Error("design-input.json producer must be compile-report-content.mjs");
  }
  const content = await readFile(contentPath, "utf8");
  const template = await readFile(shellPath, "utf8");
  const templateErrors = validateDesignTemplate(template);
  if (templateErrors.length) throw new Error(templateErrors.join("; "));
  if (sha256Text(content) !== input.contentFileSha256) {
    throw new Error("report.content.html fingerprint mismatch; re-run compile-report-content.mjs");
  }

  let html = template.replace(CONTENT_SLOT, content.trimEnd());
  html = replaceAll(html, "{{HTML_REPORT_TITLE}}", escapeHtml(input.title));
  html = replaceAll(html, "{{HTML_REPORT_SESSION_ID}}", escapeHtml(input.sessionId));
  html = replaceAll(html, "{{HTML_REPORT_GENERATED_AT}}", escapeHtml(input.generatedAt));
  html = replaceAll(html, "{{HTML_REPORT_QUALITY_BADGE}}", "质量门禁已通过");
  if (/\{\{HTML_REPORT_[A-Z_]+\}\}/.test(html)) {
    throw new Error("design template contains an unsupported or unresolved HTML_REPORT token");
  }
  for (const marker of input.fullTableMarkers || []) {
    const expected = `html-report:full-table card="${marker.cardId}" rows="${marker.rows}"`;
    if (!html.includes(expected)) throw new Error(`composed HTML lost full-table marker for ${marker.cardId}`);
  }

  await mkdir(reportDir, { recursive: true });
  await writeFile(htmlPath, html);
  const meta = {
    version: 2,
    producer: "compose-report.mjs",
    designOwner: "report-designer",
    designSkill: "html-report-design",
    templatePath: shellPath,
    templateSha256: sha256Text(template),
    contentPath,
    contentFileSha256: sha256Text(content),
    contentSha256: input.contentSha256,
    markdownSha256: input.markdownSha256,
    htmlPath,
    htmlSha256: sha256Text(html),
    generatedAt: new Date().toISOString(),
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { htmlPath, metaPath, meta };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir) {
    process.stderr.write("usage: compose-report.mjs --result <result.json> | --session-dir <SESSION> [--template <report.design.html>]\n");
    process.exit(2);
  }
  try {
    const output = await composeReport(sessionDir, { templatePath: value("--template") });
    process.stdout.write(`${JSON.stringify({ ok: true, htmlPath: output.htmlPath, metaPath: output.metaPath }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
