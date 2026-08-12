#!/usr/bin/env node
/** Stamp the Designer's visual assessment to the exact HTML and screenshots. */
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text } from "./compile-report-content.mjs";

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

export async function finalizeDesign(sessionDir, assessmentPath) {
  const abs = resolve(sessionDir);
  const reportDir = join(abs, "report");
  const draftPath = resolve(assessmentPath || join(reportDir, "design-result.draft.json"));
  const visualPath = join(reportDir, "visual-check.json");
  const htmlPath = join(reportDir, "report.html");
  for (const path of [draftPath, visualPath, htmlPath]) {
    if (!(await exists(path))) throw new Error(`missing design finalization input: ${path}`);
  }

  const draft = JSON.parse(await readFile(draftPath, "utf8"));
  if (draft.status !== "pass") throw new Error("design assessment status must be pass");
  for (const id of ["desktop", "mobile"]) {
    if (draft.viewports?.[id]?.pass !== true) throw new Error(`design assessment must pass viewport ${id}`);
  }
  const visualText = await readFile(visualPath, "utf8");
  const visual = JSON.parse(visualText);
  if (visual.producer !== "capture-report.mjs") {
    throw new Error("visual-check.json producer must be capture-report.mjs");
  }
  const html = await readFile(htmlPath, "utf8");
  const htmlSha256 = sha256Text(html);
  if (visual.htmlSha256 !== htmlSha256) {
    throw new Error("HTML changed after screenshots; capture again before finalizing");
  }

  const result = {
    version: 1,
    producer: "finalize-design.mjs",
    status: "pass",
    finalizedAt: new Date().toISOString(),
    htmlPath,
    htmlSha256,
    visualCheckPath: visualPath,
    visualCheckSha256: sha256Text(visualText),
    screenshots: visual.screenshots,
    viewports: draft.viewports,
    notes: Array.isArray(draft.notes) ? draft.notes : [],
  };
  const resultPath = join(reportDir, "design-result.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return { resultPath, result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir) {
    process.stderr.write("usage: finalize-design.mjs --result <result.json> | --session-dir <SESSION> [--assessment-file <draft.json>]\n");
    process.exit(2);
  }
  try {
    const output = await finalizeDesign(sessionDir, value("--assessment-file"));
    process.stdout.write(`${JSON.stringify({ ok: true, designResultPath: output.resultPath, htmlPath: output.result.htmlPath }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
