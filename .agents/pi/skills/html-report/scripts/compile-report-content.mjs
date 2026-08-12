#!/usr/bin/env node
/**
 * Compile frozen report.md into an immutable semantic HTML fragment and a
 * compact design brief. This script makes no visual design decisions.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileContentBinding,
  sha256Text,
  validateReportManifestBinding,
} from "./report-content-binding.mjs";

export { sha256Text } from "./report-content-binding.mjs";

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

function outlineFromMarkdown(markdown) {
  return String(markdown)
    .split(/\r?\n/)
    .map((line) => /^(#{1,4})\s+(.+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => ({ level: match[1].length, text: match[2].trim() }));
}

async function requireQualityPass(sessionDir) {
  const verdictPath = join(sessionDir, "quality", "verdict.json");
  if (!(await exists(verdictPath))) throw new Error("missing quality/verdict.json");
  const verdict = JSON.parse(await readFile(verdictPath, "utf8"));
  if (verdict.pass !== true || verdict.draft === true) {
    throw new Error("quality verdict must be final pass=true before design compilation");
  }
  if (verdict.producer !== "write-verdict.mjs") {
    throw new Error("quality verdict must be stamped by write-verdict.mjs");
  }
  return verdict;
}

export async function compileReportContent(sessionDir) {
  const abs = resolve(sessionDir);
  await requireQualityPass(abs);
  const reportDir = join(abs, "report");
  const markdownPath = join(reportDir, "report.md");
  const manifestPath = join(reportDir, "render-manifest.json");
  const contentPath = join(reportDir, "report.content.html");
  const inputPath = join(reportDir, "design-input.json");
  if (!(await exists(markdownPath))) throw new Error("missing report/report.md");
  if (!(await exists(manifestPath))) throw new Error("missing report/render-manifest.json");

  const markdown = await readFile(markdownPath, "utf8");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifestErrors = validateReportManifestBinding(markdown, manifest);
  if (manifestErrors.length) throw new Error(manifestErrors.join("; "));
  const binding = compileContentBinding(markdown);

  let sessionId = basename(abs);
  try {
    const result = JSON.parse(await readFile(join(abs, "result.json"), "utf8"));
    sessionId = result.session_id || result.sessionId || sessionId;
  } catch {
    // basename is a safe fallback for design-only metadata.
  }

  const generatedAt = new Date().toISOString();
  const input = {
    version: 1,
    producer: "compile-report-content.mjs",
    sessionDir: abs,
    title: binding.title,
    sessionId,
    generatedAt,
    markdownPath,
    contentPath,
    markdownSha256: binding.markdownSha256,
    contentSha256: binding.contentSha256,
    contentFileSha256: binding.contentFileSha256,
    renderManifestPath: manifestPath,
    renderManifestSha256: sha256Text(await readFile(manifestPath)),
    outline: outlineFromMarkdown(markdown),
    fullTableMarkers: binding.fullTableMarkers,
    designContract: {
      contentIsImmutable: true,
      templateSlot: "<!-- HTML_REPORT_CONTENT -->",
      requiredViewports: ["desktop-1440x1000", "mobile-390x844"],
      output: "single-file responsive HTML",
    },
  };

  await mkdir(reportDir, { recursive: true });
  await writeFile(contentPath, binding.content);
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  return { contentPath, inputPath, input };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir) {
    process.stderr.write("usage: compile-report-content.mjs --result <result.json> | --session-dir <SESSION>\n");
    process.exit(2);
  }
  try {
    const output = await compileReportContent(sessionDir);
    process.stdout.write(`${JSON.stringify({ ok: true, contentPath: output.contentPath, inputPath: output.inputPath }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
