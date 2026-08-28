#!/usr/bin/env node
/**
 * Assemble the user-facing Markdown report from the Editor narrative and
 * script-generated full tables. The narrative is LLM-authored; evidence tables
 * are generated from entry.json so the final report cannot silently omit rows.
 *
 * Usage:
 *   node assemble-report.mjs --session-dir .harness/state/html-report/<id>
 *   node assemble-report.mjs --result <result.json>
 *
 * Writes:
 *   $SESSION/report/report.md
 *   $SESSION/report/render-manifest.json
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { columnMetaPathFor, rowsSha256 } from "../data/fetch-entry.mjs";
import { sortDimensionColumns, resolveDimensionColumn } from "../evidence/caption-dims.mjs";
import { metricQueryFromCard } from "../query/metric-query-contract.mjs";
import { applyQueryPatch } from "../data/fetch-explore.mjs";

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

export function sanitizeId(raw) {
  return String(raw || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["rows", "data", "result", "items"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function rowsToMarkdown(rows, { columnLabels = {}, dimensions = [] } = {}) {
  const objects = rows.filter((row) => row && typeof row === "object" && !Array.isArray(row));
  if (!objects.length) return { markdown: "", headers: [], rowCount: 0 };
  const allKeys = [];
  for (const row of objects) {
    for (const key of Object.keys(row)) if (!allKeys.includes(key)) allKeys.push(key);
  }
  // Sort dimension columns to the front using two-level group/dim priority
  // (no caps), then resolve actual column keys via --dim-labels mapping.
  const sampleRow = objects[0];
  const dimColumns = [];
  const dimCodeByCol = new Map();
  for (const dim of sortDimensionColumns(dimensions)) {
    const col = resolveDimensionColumn(dim, sampleRow);
    if (allKeys.includes(col) && !dimColumns.includes(col)) {
      dimColumns.push(col);
      dimCodeByCol.set(col, dim);
    }
  }
  const nonDimColumns = allKeys.filter((key) => !dimColumns.includes(key));
  const orderedColumns = [...dimColumns, ...nonDimColumns];
  const displayHeaders = orderedColumns.map((key) => {
    if (columnLabels[key]) return columnLabels[key];
    const dimCode = dimCodeByCol.get(key);
    if (dimCode && columnLabels[dimCode]) return columnLabels[dimCode];
    return key;
  });
  const lines = [
    `| ${displayHeaders.map(cellText).join(" | ")} |`,
    `| ${displayHeaders.map(() => "---").join(" | ")} |`,
  ];
  for (const row of objects) {
    lines.push(`| ${orderedColumns.map((key) => cellText(row[key])).join(" | ")} |`);
  }
  return { markdown: lines.join("\n"), headers: displayHeaders, rowCount: objects.length };
}

function titleForCard(card, cardId) {
  return String(card?.title || card?.id || cardId || "数据明细").trim();
}

export async function assembleReport(sessionDir) {
  const abs = resolve(sessionDir);
  const resultPath = join(abs, "result.json");
  const mainPath = join(abs, "analysis", "main.md");
  const reportDir = join(abs, "report");
  const reportPath = join(reportDir, "report.md");
  const manifestPath = join(reportDir, "render-manifest.json");

  const resultText = await readFile(resultPath, "utf8");
  const result = JSON.parse(resultText);
  if (result.status !== "confirmed") {
    throw new Error(`result.status must be confirmed, got ${JSON.stringify(result.status)}`);
  }
  const main = await readFile(mainPath, "utf8");
  const cards = Array.isArray(result.cards) ? result.cards : [];
  const analysisSections = [];
  const dataSections = [];
  const manifestCards = [];
  const manifestTasks = [];

  for (const card of cards) {
    const cardId = sanitizeId(card?.id);
    const metaPath = join(abs, "data", "cards", cardId, "entry.meta.json");
    const entryPath = join(abs, "data", "cards", cardId, "entry.json");
    let meta = {};
    if (await exists(metaPath)) meta = JSON.parse(await readFile(metaPath, "utf8"));
    if (!Number.isSafeInteger(meta.rowCount) || !meta.rowsSha256) {
      manifestCards.push({ cardId, status: "missing", sourceRows: 0, renderedRows: 0, fullTable: false });
      continue;
    }
    if (!(await exists(entryPath))) throw new Error(`missing entry.json for successful card ${cardId}`);
    const payload = JSON.parse(await readFile(entryPath, "utf8"));
    const rows = extractRows(payload);
    const columnMetaPath = join(abs, "data", "cards", cardId, "entry.column-meta.json");
    let columnLabels = {};
    if (await exists(columnMetaPath)) {
      columnLabels = JSON.parse(await readFile(columnMetaPath, "utf8"));
    }
    let cardDimensions = [];
    try { cardDimensions = metricQueryFromCard(card).dimensions || []; } catch { /* card query unreadable */ }
    const table = rowsToMarkdown(rows, { columnLabels, dimensions: cardDimensions });
    if (meta.rowCount !== rows.length) {
      throw new Error(`entry.meta.json rowCount does not match entry.json for card ${cardId}`);
    }
    const computedRowsSha256 = rowsSha256(rows);
    if (meta.rowsSha256 !== computedRowsSha256) {
      throw new Error(`entry.meta.json rowsSha256 does not match entry.json for card ${cardId}`);
    }
    const marker = `<!-- html-report:full-table card="${cardId}" rows="${table.rowCount}" -->`;
    dataSections.push([
      `### 全量明细：${titleForCard(card, cardId)}`,
      "",
      marker,
      "",
      table.markdown || "_本次查询返回 0 行明细。_",
      "",
    ].join("\n"));
    manifestCards.push({
      cardId,
      status: "ok",
      sourceRows: table.rowCount,
      renderedRows: table.rowCount,
      headers: table.headers,
      fullTable: true,
      entryPath: `data/cards/${cardId}/entry.json`,
      sourceRowsSha256: meta.rowsSha256,
    });
  }

  const tasksPath = join(abs, "analysis", "tasks.json");
  if (!(await exists(tasksPath))) {
    throw new Error("missing analysis/tasks.json; current report assembly requires version 2 tasks");
  }
  const tasksText = await readFile(tasksPath, "utf8");
  const tasksSha256 = sha256(tasksText);
  const tasksDocument = JSON.parse(tasksText);
  if (Number(tasksDocument.version) !== 2 || !Array.isArray(tasksDocument.tasks)) {
    throw new Error("analysis/tasks.json must be a version 2 document with tasks[]");
  }
  for (const task of tasksDocument.tasks) {
    if (String(task?.status || "").toLowerCase() !== "done") continue;
    const taskId = sanitizeId(task?.id);
    const mode = task?.evidencePlan?.mode;
    const evidencePath = `analysis/evidence/${taskId}.json`;
    const researchSectionPath = join(abs, "analysis", "sections", `explore-${taskId}.md`);
    if (!(await exists(researchSectionPath))) {
      manifestTasks.push({ taskId, mode, status: "missing", evidencePath, sectionIncluded: false });
      continue;
    }
    const researchSection = await readFile(researchSectionPath, "utf8");
    const sectionSha256 = sha256(researchSection);
    const sectionMarker = `<!-- html-report:research-section task="${taskId}" sha256="${sectionSha256}" -->`;
    analysisSections.push([
      `## 深入分析：${String(task.goal || taskId).trim()}`,
      "",
      sectionMarker,
      "",
      researchSection.trim(),
      "",
    ].join("\n"));
    const taskManifestBase = {
      taskId,
      mode,
      evidencePath,
      sectionPath: `analysis/sections/explore-${taskId}.md`,
      sectionSha256,
      sectionIncluded: true,
    };
    if (mode === "reuse_entry") {
      const sourceCardId = sanitizeId(task?.fromCardId);
      const sourceCard = manifestCards.find((card) => card.cardId === sourceCardId);
      if (!sourceCard || sourceCard.status !== "ok") {
        manifestTasks.push({
          ...taskManifestBase,
          taskId,
          mode,
          status: "missing",
          fullTable: false,
          fullTableSource: "writer_entry",
          sourceCardId,
          evidencePath,
        });
        continue;
      }
      manifestTasks.push({
        ...taskManifestBase,
        status: "ok",
        fullTableSource: "writer_entry",
        sourceCardId,
        sourceRowsSha256: sourceCard.sourceRowsSha256,
        evidencePath,
      });
      continue;
    }
    if (mode !== "new_query") continue;
    const dataPath = join(abs, "data", "explore", `${taskId}.json`);
    const metaPath = join(abs, "data", "explore", `${taskId}.meta.json`);
    if (!(await exists(dataPath)) || !(await exists(metaPath))) {
      manifestTasks.push({ ...taskManifestBase, status: "missing", fullTable: false });
      continue;
    }
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    const payload = JSON.parse(await readFile(dataPath, "utf8"));
    const rows = extractRows(payload);
    const exploreColumnMetaPath = columnMetaPathFor(dataPath);
    let columnLabels = {};
    if (await exists(exploreColumnMetaPath)) {
      columnLabels = JSON.parse(await readFile(exploreColumnMetaPath, "utf8"));
    }
    let exploreDimensions = [];
    const sourceCard = cards.find((c) => c?.id === meta.fromCardId);
    if (sourceCard) {
      try {
        const sourceQuery = metricQueryFromCard(sourceCard);
        exploreDimensions = applyQueryPatch(sourceQuery, meta.queryPatch || {}).dimensions || [];
      } catch { /* explore query unreadable */ }
    }
    const table = rowsToMarkdown(rows, { columnLabels, dimensions: exploreDimensions });
    if (meta.status !== "ok" || meta.rowCount !== rows.length || !meta.rowsSha256) {
      throw new Error(`invalid explore data/meta pair for task ${taskId}`);
    }
    const computedRowsSha256 = rowsSha256(rows);
    if (meta.rowsSha256 !== computedRowsSha256) {
      throw new Error(`explore rowsSha256 does not match data for task ${taskId}`);
    }
    const marker = `<!-- html-report:full-explore-table task="${taskId}" rows="${table.rowCount}" -->`;
    dataSections.push([
      `### 全量探索明细：${String(task.goal || taskId).trim()}`,
      "",
      marker,
      "",
      table.markdown || "_本次探索查询返回 0 行明细。_",
      "",
    ].join("\n"));
    manifestTasks.push({
      ...taskManifestBase,
      status: "ok",
      sourceRows: table.rowCount,
      renderedRows: table.rowCount,
      headers: table.headers,
      fullTable: true,
      fullTableSource: "explore_query",
      dataPath: `data/explore/${taskId}.json`,
      sourceRowsSha256: meta.rowsSha256,
      evidencePath,
    });
  }

  const appendix = dataSections.length
    ? ["## 数据附录", "", ...dataSections].join("\n\n")
    : "";
  const report = [main.trimEnd(), ...analysisSections, appendix].filter(Boolean).join("\n\n") + "\n";
  const manifest = {
    version: 1,
    producer: "assemble-report.mjs",
    sessionDir: abs,
    source: "analysis/main.md + done Researcher sections + Writer/new_query full data appendix",
    generatedAt: new Date().toISOString(),
    resultSha256: sha256(resultText),
    mainSha256: sha256(main),
    tasksSha256,
    reportSha256: sha256(report),
    cards: manifestCards,
    tasks: manifestTasks,
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, report);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { reportPath, manifestPath, manifest };
}

export async function runCli() {

  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir) {
    process.stderr.write("usage: assemble-report.mjs --session-dir <SESSION> | --result <result.json>\n");
    process.exit(2);
  }
  try {
    const output = await assembleReport(sessionDir);
    process.stdout.write(`${JSON.stringify({ ok: true, ...output }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli();
}
