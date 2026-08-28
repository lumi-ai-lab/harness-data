#!/usr/bin/env node
/** Capture deterministic desktop/mobile screenshots for Designer visual QA. */
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sha256Text } from "./compile-report-content.mjs";
import { screenshotSpecsForSession } from "./design-artifact-contract.mjs";

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

export function screenshotArgs(url, outputPath, viewport, { channel = "chrome" } = {}) {
  const args = ["screenshot", "--browser", "chromium"];
  if (channel) args.push("--channel", channel);
  args.push("--viewport-size", viewport, "--full-page", "--wait-for-timeout", "250", url, outputPath);
  return args;
}

export async function captureReport(sessionDir, { playwright = process.env.PLAYWRIGHT_CLI || "playwright" } = {}) {
  const abs = resolve(sessionDir);
  const reportDir = join(abs, "report");
  const htmlPath = join(reportDir, "report.html");
  if (!(await exists(htmlPath))) throw new Error("missing report/report.html; run compose-report.mjs first");
  const screenshotDir = join(reportDir, "screenshots");
  await mkdir(screenshotDir, { recursive: true });
  const url = pathToFileURL(htmlPath).href;
  const channel = process.env.HTML_REPORT_BROWSER_CHANNEL ?? "chrome";
  const targets = screenshotSpecsForSession(abs);
  const screenshots = [];
  for (const target of targets) {
    const started = Date.now();
    const run = spawnSync(playwright, screenshotArgs(url, target.path, target.viewport, { channel }), {
      cwd: abs,
      encoding: "utf8",
      timeout: 120000,
    });
    if (run.status !== 0) {
      throw new Error(`screenshot ${target.id} failed: ${(run.stderr || run.stdout || run.error || "unknown error").toString().slice(-2000)}`);
    }
    const bytes = (await stat(target.path)).size;
    const data = await readFile(target.path);
    screenshots.push({
      id: target.id,
      viewport: target.viewport,
      path: target.path,
      bytes,
      sha256: sha256Text(data),
      durationMs: Date.now() - started,
    });
  }

  const html = await readFile(htmlPath, "utf8");
  const output = {
    version: 1,
    producer: "capture-report.mjs",
    capturedAt: new Date().toISOString(),
    htmlPath,
    htmlSha256: sha256Text(html),
    screenshots,
  };
  const outputPath = join(reportDir, "visual-check.json");
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return { outputPath, output };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir) {
    process.stderr.write("usage: capture-report.mjs --result <result.json> | --session-dir <SESSION>\n");
    process.exit(2);
  }
  try {
    const output = await captureReport(sessionDir);
    process.stdout.write(`${JSON.stringify({ ok: true, visualCheckPath: output.outputPath, screenshots: output.output.screenshots }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
