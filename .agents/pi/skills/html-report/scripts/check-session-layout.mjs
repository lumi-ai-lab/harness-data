#!/usr/bin/env node
/**
 * Verify Phase B artifacts live under the html-report session directory
 * (never under repo-root analysis/).
 *
 * B2 data gates:
 *   - successful Writer data is an entry.json + minimal entry.meta.json pair
 *   - entry.meta.json contains only rowCount + rowsSha256 from CLI --meta
 *   - explore meta producer === fetch-explore.mjs
 *   - verdict.json producer === write-verdict.mjs + scanFingerprint match
 *
 * Usage:
 *   node check-session-layout.mjs --session-dir .harness/state/html-report/<id>
 *   node check-session-layout.mjs --result .harness/state/html-report/<id>/result.json
 *   node check-session-layout.mjs --session-dir ... --phase writer
 *   node check-session-layout.mjs --session-dir ... --phase b2
 *   node check-session-layout.mjs --session-dir ... --phase explore
 *   node check-session-layout.mjs --session-dir ... --phase quality
 *   node check-session-layout.mjs --session-dir ... --phase html
 */
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSourceFieldMetadata,
  canonicalizeJson,
  compactDecisionQueryScope,
  executeEvidenceOperations,
} from "./prepare-research-evidence.mjs";
import {
  materialQueryDelta,
  semanticQueryShape,
} from "./fetch-explore.mjs";
import {
  evidenceGapMatchesChangedKeys,
  isJsonObject,
  isValidEvidenceGap,
} from "./research-contract.mjs";
import {
  researcherContrastPolicy,
  validateResearcherAnalysisRequirements,
  validateResearcherArtifacts,
} from "./researcher-return.mjs";

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function scoreOf(cell) {
  if (cell == null) return null;
  if (typeof cell === "number") return cell;
  if (typeof cell === "object" && cell.score != null) return Number(cell.score);
  return null;
}

function fingerprintScanText(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function fingerprintData(data) {
  return createHash("sha256").update(data).digest("hex");
}

function sanitizeCardId(raw) {
  return String(raw || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Sanitize task id the same way as fetch-explore.mjs */
function sanitizeTaskId(raw) {
  const s = String(raw || "task").trim();
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned || "task";
}

async function checkEntryPair(abs, cardId, errors, resultMtimeMs) {
  const cardDir = join(abs, "data", "cards", cardId);
  const entryPath = join(cardDir, "entry.json");
  const metaPath = join(cardDir, "entry.meta.json");
  const hasEntry = await exists(entryPath);
  const hasMeta = await exists(metaPath);
  if (!hasEntry && !hasMeta) return false;
  if (!hasEntry || !hasMeta) {
    errors.push(`card ${cardId} must contain both entry.json and entry.meta.json`);
    return false;
  }

  try {
    const [entryStat, metaStat] = await Promise.all([stat(entryPath), stat(metaPath)]);
    if (Number.isFinite(resultMtimeMs)) {
      if (entryStat.mtimeMs < resultMtimeMs) {
        errors.push(`card ${cardId} entry.json is stale: it predates the current result.json`);
      }
      if (metaStat.mtimeMs < resultMtimeMs) {
        errors.push(`card ${cardId} entry.meta.json is stale: it predates the current result.json`);
      }
    }
    const rows = JSON.parse(await readFile(entryPath, "utf8"));
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    const validRows = Array.isArray(rows) && rows.every(
      (row) => row && typeof row === "object" && !Array.isArray(row)
    );
    if (!validRows) {
      errors.push(`card ${cardId} entry.json must be an array of row objects`);
    }
    const keys = meta && typeof meta === "object" && !Array.isArray(meta) ? Object.keys(meta).sort() : [];
    if (keys.length !== 2 || keys[0] !== "rowCount" || keys[1] !== "rowsSha256") {
      errors.push(`card ${cardId} entry.meta.json must contain only rowCount and rowsSha256`);
    } else {
      if (!Number.isSafeInteger(meta.rowCount) || meta.rowCount < 0 || meta.rowCount !== rows.length) {
        errors.push(`card ${cardId} entry.meta.json rowCount must equal entry.json rows.length`);
      }
      if (!/^[a-f0-9]{64}$/.test(meta.rowsSha256 || "")) {
        errors.push(`card ${cardId} entry.meta.json rowsSha256 must be 64 lowercase hexadecimal characters`);
      } else if (validRows && meta.rowsSha256 !== canonicalFingerprint(rows)) {
        errors.push(`card ${cardId} entry.meta.json rowsSha256 does not match entry.json rows`);
      }
    }
  } catch (error) {
    errors.push(`invalid Writer data artifacts for card ${cardId}: ${error.message || error}`);
  }
  for (const legacy of ["entry.profile.json", "entry.facts.json"]) {
    if (await exists(join(cardDir, legacy))) {
      errors.push(`card ${cardId} has forbidden legacy ${legacy}; B2 uses CLI --meta only`);
    }
  }
  return true;
}

/**
 * Validate each persisted successful Writer data pair. A failed Writer returns
 * its failure to the parent and deliberately leaves no data pair on disk.
 */
async function checkEntryData(abs, errors, warnings, result) {
  if (!result) return;
  let resultMtimeMs;
  try {
    resultMtimeMs = (await stat(join(abs, "result.json"))).mtimeMs;
  } catch (error) {
    errors.push(`cannot verify Writer freshness against result.json: ${error.message || error}`);
  }
  const cards = Array.isArray(result.cards) ? result.cards : [];
  const cardIds = new Map();
  let persistedCards = 0;
  for (const card of cards) {
    if (!card || !card.id) continue;
    const cardId = sanitizeCardId(card.id);
    if (cardIds.has(cardId)) {
      errors.push(`result card ids collide after sanitization: ${cardIds.get(cardId)} and ${card.id}`);
      continue;
    }
    cardIds.set(cardId, String(card.id));
    const persisted = await checkEntryPair(abs, cardId, errors, resultMtimeMs);
    if (persisted) persistedCards += 1;
    else warnings.push(`card ${card.id} has no persisted entry pair; confirm the Writer returned a fetch failure to the Report Editor`);
  }
  if (cards.length && persistedCards === 0) {
    errors.push("no confirmed card produced an entry.json + entry.meta.json pair");
  }
}

async function readResult(abs, errors) {
  const resultPath = join(abs, "result.json");
  if (!(await exists(resultPath))) return null;
  try {
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      errors.push("result.json must contain an object document");
      return null;
    }
    return result;
  } catch (error) {
    errors.push(`result.json is not valid JSON: ${error.message || error}`);
    return null;
  }
}

async function checkStrayAnalysis(abs, errors) {
  // Detect common mistake: writing to repo-root analysis/
  const root = resolve(new URL("../../../../../", import.meta.url).pathname);
  const stray = join(root, "analysis");
  if (await exists(stray)) {
    errors.push(
      `FORBIDDEN: repo-root analysis/ exists (${stray}). All Phase B outputs must be under the session dir, not the repository root. Delete it and rewrite under ${join(abs, "analysis")}.`
    );
  }
}

async function checkWriterArtifacts(abs, errors, warnings, result) {
  await checkEntryData(abs, errors, warnings, result);
  await checkStrayAnalysis(abs, errors);
}

async function checkB2Artifacts(abs, errors, warnings, result) {
  await checkWriterArtifacts(abs, errors, warnings, result);

  const main = join(abs, "analysis", "main.md");
  const tasks = join(abs, "analysis", "tasks.json");
  if (!(await exists(main))) errors.push("missing analysis/main.md under SESSION dir");
  else {
    try {
      const markdown = await readFile(main, "utf8");
      const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
      const hasMarkdownTable = lines.some((line, index) => {
        if (index === 0 || !line.includes("|")) return false;
        const delimiter = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
        if (delimiter.length < 2 || !delimiter.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))) return false;
        return lines[index - 1].includes("|");
      });
      if (hasMarkdownTable || /<table\b/i.test(markdown)) {
        errors.push(
          "analysis/main.md must not copy Markdown/HTML detail tables; assemble-report.mjs inserts the full Writer table"
        );
      }
    } catch (error) {
      errors.push(`analysis/main.md cannot be read: ${error.message || error}`);
    }
  }
  if (!(await exists(tasks))) errors.push("missing analysis/tasks.json under SESSION dir");
  if (await exists(tasks)) {
    try {
      const document = JSON.parse(await readFile(tasks, "utf8"));
      const resultCardIds = new Set(
        (Array.isArray(result?.cards) ? result.cards : []).map((card) => String(card?.id))
      );
      if (Number(document.version) !== 2) {
        errors.push("analysis/tasks.json version must be exactly 2 for the current B2+ pipeline");
      } else {
        validateTaskPlans(document, resultCardIds, errors, warnings);
      }
    } catch (error) {
      errors.push(`analysis/tasks.json is not valid JSON: ${error.message || error}`);
    }
  }
}

function validateTaskPlans(document, resultCardIds, errors, warnings) {
  if (!Array.isArray(document.tasks)) {
    errors.push("tasks.json version 2 requires tasks to be an array");
    return;
  }
  if (!Number.isSafeInteger(document.round) || document.round < 0) {
    errors.push("tasks.json version 2 requires a non-negative integer round");
  }
  if (!Number.isSafeInteger(document.maxRounds) || document.maxRounds < 2 || document.maxRounds > 3) {
    errors.push("tasks.json version 2 requires maxRounds between 2 and 3");
  } else if (Number.isSafeInteger(document.round) && document.round > document.maxRounds) {
    errors.push("tasks.json round must not exceed maxRounds");
  }
  const tasks = document.tasks;
  const ids = new Map();
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task) || !task.id) {
      errors.push("tasks.json version 2 requires every task to have an id");
      continue;
    }
    const safe = sanitizeTaskId(task.id);
    if (safe === "." || safe === "..") {
      errors.push(`task ${task.id} id must not be a dot path segment`);
    }
    if (ids.has(safe)) {
      errors.push(`task ids collide after sanitization: ${ids.get(safe)} and ${task.id}`);
    }
    ids.set(safe, String(task.id));
    const fromCardId = String(task.fromCardId || "").trim();
    if (!String(task.goal || "").trim()) {
      errors.push(`task ${task.id} goal is required`);
    }
    const requirements = validateResearcherAnalysisRequirements(task);
    for (const error of requirements.errors) {
      errors.push(`task ${task.id} ${error}`);
    }
    if (!fromCardId) {
      errors.push(`task ${task.id} fromCardId is required`);
    } else if (!resultCardIds.has(fromCardId)) {
      errors.push(`task ${task.id} fromCardId is not present in result.json`);
    }
    const plan = task.evidencePlan;
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      errors.push(`task ${task.id} missing evidencePlan`);
      continue;
    }
    if (!new Set(["reuse_entry", "new_query"]).has(plan.mode)) {
      errors.push(`task ${task.id} evidencePlan.mode must be reuse_entry or new_query`);
    }
    if (!String(plan.reason || "").trim()) {
      errors.push(`task ${task.id} evidencePlan.reason is required`);
    }
    if (plan.sourceCardId != null && String(plan.sourceCardId) !== fromCardId) {
      errors.push(`task ${task.id} evidencePlan.sourceCardId must equal task.fromCardId`);
    }
    if (!Array.isArray(plan.requiredColumns)) {
      errors.push(`task ${task.id} evidencePlan.requiredColumns must be an array`);
    }
    if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
      errors.push(`task ${task.id} evidencePlan.operations must be a non-empty array`);
    }
    const status = String(task.status || "pending").toLowerCase();
    if (!new Set(["pending", "running", "done", "failed", "skipped"]).has(status)) {
      errors.push(`task ${task.id} has unsupported status ${JSON.stringify(status)}`);
    }
    if (status === "skipped" && !String(task.skipReason || "").trim()) {
      errors.push(`task ${task.id} skipped status requires skipReason`);
    }
    if (plan.mode === "reuse_entry" && (task.mustChange || task.queryDelta)) {
      warnings.push(`task ${task.id} reuse_entry ignores mustChange/queryDelta; mechanical analysis must use Writer evidence`);
    }
    if (plan.mode === "reuse_entry" && task.evidenceGap != null) {
      errors.push(`task ${task.id} reuse_entry evidenceGap must be null`);
    }
    if (plan.mode === "new_query" && !isValidEvidenceGap(task.evidenceGap)) {
      errors.push(`task ${task.id} new_query requires allowed evidenceGap.type or evidenceGap.types[] + evidenceGap.reason`);
    }
  }
}

function validateExploreMeta(meta, taskId, errors, warnings) {
  if (meta.producer !== "fetch-explore.mjs") {
    errors.push(
      `forged or non-script explore meta for task ${taskId}: producer must be fetch-explore.mjs (got ${JSON.stringify(meta.producer)}). Re-spawn report-researcher; do NOT hand-write data/explore/*`
    );
  }
  if (!Array.isArray(meta.attempts)) {
    errors.push(
      `explore meta for task ${taskId} missing attempts[] (expected from fetch-explore.mjs)`
    );
  }
  if (meta.status !== "ok") {
    errors.push(`explore meta for task ${taskId} must have status=ok`);
  }
  if (!Array.isArray(meta.attempts) || !meta.attempts.some((attempt) => attempt?.status === 0 && !attempt?.error)) {
    errors.push(`explore meta for task ${taskId} must contain a successful attempt`);
  }
  if (meta.pagination?.mode !== "all-pages" || meta.pagination?.singlePage !== false) {
    errors.push(
      `explore meta for task ${taskId} must record all-pages with singlePage=false`
    );
  }
}

function canonicalFingerprint(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

async function validateEvidencePacket(abs, task, mode, errors) {
  const id = sanitizeTaskId(task.id);
  const evidencePath = join(abs, "analysis", "evidence", `${id}.json`);
  if (!(await exists(evidencePath))) {
    errors.push(`missing analysis/evidence/${id}.json for done task ${task.id}`);
    return;
  }
  let evidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    errors.push(`analysis/evidence/${id}.json is not valid JSON: ${error.message || error}`);
    return;
  }
  if (evidence.producer !== "prepare-research-evidence.mjs") {
    errors.push(`task ${task.id} evidence producer must be prepare-research-evidence.mjs`);
  }
  if (String(evidence.taskId) !== String(task.id)) {
    errors.push(`task ${task.id} evidence taskId mismatch`);
  }
  if (evidence.evidenceMode !== mode) {
    errors.push(`task ${task.id} evidenceMode ${JSON.stringify(evidence.evidenceMode)} != ${mode}`);
  }
  const expectedPlanFingerprint = canonicalFingerprint(task.evidencePlan?.operations);
  if (evidence.operationPlanSha256 !== expectedPlanFingerprint) {
    errors.push(`task ${task.id} evidence operationPlanSha256 does not match tasks.json`);
  }
  if (canonicalizeJson(evidence.requiredColumns) !== canonicalizeJson(task.evidencePlan?.requiredColumns)) {
    errors.push(`task ${task.id} evidence requiredColumns do not match tasks.json`);
  }
  if (!evidence.views || typeof evidence.views !== "object" || Array.isArray(evidence.views)) {
    errors.push(`task ${task.id} evidence views are missing`);
  }

  const sourceCardId = sanitizeCardId(task.fromCardId);
  const expectedData = mode === "reuse_entry"
    ? join(abs, "data", "cards", sourceCardId, "entry.json")
    : join(abs, "data", "explore", `${id}.json`);
  const expectedMeta = mode === "reuse_entry"
    ? join(abs, "data", "cards", sourceCardId, "entry.meta.json")
    : join(abs, "data", "explore", `${id}.meta.json`);
  if (resolve(evidence.source?.dataPath || "") !== expectedData) {
    errors.push(`task ${task.id} evidence source.dataPath is not the contracted source`);
  }
  if (resolve(evidence.source?.metaPath || "") !== expectedMeta) {
    errors.push(`task ${task.id} evidence source.metaPath is not the contracted source`);
  }
  if (evidence.source?.kind !== (mode === "reuse_entry" ? "writer_entry" : "explore_query")) {
    errors.push(`task ${task.id} evidence source.kind does not match ${mode}`);
  }

  const hasExpectedData = await exists(expectedData);
  const hasExpectedMeta = await exists(expectedMeta);
  if (!hasExpectedData) errors.push(`task ${task.id} evidence source data is missing`);
  if (!hasExpectedMeta) errors.push(`task ${task.id} evidence source metadata is missing`);
  if (!hasExpectedData || !hasExpectedMeta) return;
  try {
    const rows = JSON.parse(await readFile(expectedData, "utf8"));
    const meta = JSON.parse(await readFile(expectedMeta, "utf8"));
    const resultDocument = JSON.parse(await readFile(join(abs, "result.json"), "utf8"));
    const rawSourceCardId = String(task.fromCardId || "");
    const sourceCard = (Array.isArray(resultDocument.cards) ? resultDocument.cards : []).find(
      (card) => String(card?.id) === rawSourceCardId
    );
    if (!isJsonObject(sourceCard?.requestBody)) {
      errors.push(`task ${task.id} source card has no valid requestBody baseline`);
    }
    const expectedQueryCoverage = mode === "reuse_entry"
      ? (isJsonObject(sourceCard?.requestBody) ? semanticQueryShape(sourceCard.requestBody) : null)
      : meta.queryShape;
    const computed = Array.isArray(rows) ? canonicalFingerprint(rows) : null;
    if (!Array.isArray(rows)) errors.push(`task ${task.id} evidence source data must be a rows array`);
    if (meta.rowCount !== rows.length || evidence.source?.rowCount !== rows.length) {
      errors.push(`task ${task.id} evidence rowCount does not match source`);
    }
    if (!computed || meta.rowsSha256 !== computed || evidence.source?.rowsSha256 !== computed) {
      errors.push(`task ${task.id} evidence rowsSha256 does not match source`);
    }
    const expectedFieldMetadata = buildSourceFieldMetadata(rows, task.evidencePlan?.requiredColumns || []);
    if (
      evidence.source?.declaredRowsSha256 !== meta.rowsSha256 ||
      evidence.source?.empty !== expectedFieldMetadata.empty ||
      canonicalizeJson(evidence.source?.availableFields) !== canonicalizeJson(expectedFieldMetadata.availableFields) ||
      canonicalizeJson(evidence.source?.fieldCoverage) !== canonicalizeJson(expectedFieldMetadata.fieldCoverage)
    ) {
      errors.push(`task ${task.id} evidence source field metadata does not match rows`);
    }
    if (
      !expectedQueryCoverage ||
      canonicalizeJson(evidence.source?.queryCoverage) !== canonicalizeJson(expectedQueryCoverage) ||
      evidence.source?.queryCoverageSha256 !== canonicalFingerprint(expectedQueryCoverage)
    ) {
      errors.push(`task ${task.id} evidence queryCoverage does not match source query`);
    }
    if (Array.isArray(rows)) {
      const expectedViews = executeEvidenceOperations(rows, task.evidencePlan?.operations);
      const decisionQueryScope = compactDecisionQueryScope(expectedQueryCoverage);
      if (decisionQueryScope) {
        for (const view of Object.values(expectedViews)) {
          if (view?.decisionBrief && typeof view.decisionBrief === "object") {
            view.decisionBrief.queryScope = decisionQueryScope;
          }
        }
      }
      if (canonicalizeJson(evidence.views) !== canonicalizeJson(expectedViews)) {
        errors.push(`task ${task.id} evidence views do not match deterministic operations`);
      }
    }
  } catch (error) {
    errors.push(`cannot validate evidence source for task ${task.id}: ${error.message || error}`);
  }
}

function resolveJsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  let current = document;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      current == null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) return undefined;
    current = current[part];
  }
  return current;
}

async function validateResearchSummary(abs, task, mode, id, summaryPath, sectionPath, errors) {
  let summary;
  let section;
  let evidence;
  const evidencePath = join(abs, "analysis", "evidence", `${id}.json`);
  try {
    summary = JSON.parse(await readFile(summaryPath, "utf8"));
    section = await readFile(sectionPath, "utf8");
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    errors.push(`cannot validate Researcher summary for task ${task.id}: ${error.message || error}`);
    return;
  }
  if (String(summary.taskId) !== String(task.id)) errors.push(`task ${task.id} summary taskId mismatch`);
  if (summary.status !== "ok") errors.push(`task ${task.id} done summary status must be ok`);
  if (summary.evidenceModeUsed !== mode) errors.push(`task ${task.id} summary evidenceModeUsed must be ${mode}`);
  if (resolve(summary.evidencePath || "") !== evidencePath) {
    errors.push(`task ${task.id} summary evidencePath is not the contracted path`);
  }
  if (resolve(summary.sectionPath || "") !== sectionPath) {
    errors.push(`task ${task.id} summary sectionPath is not the contracted path`);
  }
  if (resolve(summary.summaryPath || "") !== summaryPath) {
    errors.push(`task ${task.id} summary summaryPath is not the contracted path`);
  }
  if (!String(summary.summary || "").trim()) errors.push(`task ${task.id} summary text is required`);
  for (const key of ["modeCompliant", "evidenceTraceable", "answersGoal"]) {
    if (summary.selfCheck?.[key] !== true) errors.push(`task ${task.id} summary selfCheck.${key} must be true`);
  }
  if (evidence.source?.empty === true) {
    if (summary.noData !== true || summary.selfCheck?.hasContrastOrBreakdown !== false) {
      errors.push(`task ${task.id} empty evidence requires noData=true and hasContrastOrBreakdown=false`);
    }
  } else {
    if (summary.noData !== false) {
      errors.push(`task ${task.id} non-empty evidence requires noData=false`);
    }
    const contrastPolicy = researcherContrastPolicy(task);
    if (!contrastPolicy.ok) {
      for (const error of contrastPolicy.errors) {
        errors.push(`task ${task.id} cannot determine contrast requirement: ${error}`);
      }
    } else if (
      contrastPolicy.required &&
      summary.selfCheck?.hasContrastOrBreakdown !== true
    ) {
      errors.push(
        `task ${task.id} analysis requirement contract requires hasContrastOrBreakdown=true`
      );
    }
  }
  const expectedQueryJustified = mode === "new_query" ? true : null;
  if (summary.selfCheck?.queryJustified !== expectedQueryJustified) {
    errors.push(`task ${task.id} summary selfCheck.queryJustified does not match ${mode}`);
  }
  if (!Array.isArray(summary.evidencePointers) || summary.evidencePointers.length === 0) {
    errors.push(`task ${task.id} summary evidencePointers must be a non-empty array`);
  } else {
    for (const pointer of summary.evidencePointers) {
      if (!String(pointer).startsWith("/views/") || resolveJsonPointer(evidence, pointer) === undefined) {
        errors.push(`task ${task.id} summary has invalid evidence pointer ${JSON.stringify(pointer)}`);
      }
      if (!section.includes(String(pointer))) {
        errors.push(`task ${task.id} section must cite evidence pointer ${JSON.stringify(pointer)}`);
      }
    }
  }
  const semantic = validateResearcherArtifacts(summary, {
    taskId: String(task.id),
    mode,
    evidencePath,
    sectionPath,
    summaryPath,
    task,
  });
  for (const error of semantic.errors) {
    errors.push(`task ${task.id} Researcher completion contract: ${error}`);
  }
}

/**
 * After B3.5: every done version-2 task requires compact evidence + section/summary.
 * Only new_query requires data/explore; version-1 task documents are rejected upstream.
 */
async function checkExploreArtifacts(abs, errors, warnings) {
  const tasksPath = join(abs, "analysis", "tasks.json");
  if (!(await exists(tasksPath))) {
    errors.push("missing analysis/tasks.json under SESSION dir");
    return;
  }

  let tasksDoc;
  let resultDocument;
  try {
    tasksDoc = JSON.parse(await readFile(tasksPath, "utf8"));
    resultDocument = JSON.parse(await readFile(join(abs, "result.json"), "utf8"));
  } catch (e) {
    errors.push(`analysis/tasks.json is not valid JSON: ${e.message || e}`);
    return;
  }

  if (Number(tasksDoc.version) !== 2 || !Array.isArray(tasksDoc.tasks)) return;
  const tasks = tasksDoc.tasks;
  const version2 = true;
  const doneStatuses = new Set(["done"]);
  const failedStatuses = new Set(["failed"]);
  let doneCount = 0;

  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const status = String(t.status || "pending").toLowerCase();
    const id = sanitizeTaskId(t.id);
    if (!t.id) {
      warnings.push("tasks.json has a task without id");
      continue;
    }
    const completionSection = join(abs, "analysis", "sections", `explore-${id}.md`);
    const completionSummary = join(abs, "analysis", "sections", `explore-${id}.summary.json`);

    // Completion artifacts are authoritative only for a done task. A failed,
    // skipped, needs_*, pending, or running task must not leave a model-written
    // section/summary that assemble/report stages could accidentally consume.
    if (status !== "done") {
      if (await exists(completionSection)) {
        errors.push(`task ${t.id} status=${status} must not leave completion artifact analysis/sections/explore-${id}.md`);
      }
      if (await exists(completionSummary)) {
        errors.push(`task ${t.id} status=${status} must not leave completion artifact analysis/sections/explore-${id}.summary.json`);
      }
    }

    if (status === "running" || status === "needs_new_query" || status === "needs_evidence_plan") {
      errors.push(`task ${t.id} still status=${status} (B3.5 incomplete)`);
    }
    if (version2 && status === "pending") {
      errors.push(`task ${t.id} still status=pending (B3.5 incomplete)`);
    }

    if (doneStatuses.has(status)) {
      doneCount += 1;
      const mode = version2 ? String(t.evidencePlan?.mode || "") : "new_query";
      const meta = join(abs, "data", "explore", `${id}.meta.json`);
      const data = join(abs, "data", "explore", `${id}.json`);
      const payload = join(abs, "data", "explore", `${id}.payload.json`);
      const md = completionSection;
      const sum = completionSummary;
      if (!(await exists(md))) {
        errors.push(`missing analysis/sections/explore-${id}.md for done task ${t.id}`);
      }
      if (!(await exists(sum))) {
        errors.push(`missing analysis/sections/explore-${id}.summary.json for done task ${t.id}`);
      } else if (version2) {
        await validateResearchSummary(abs, t, mode, id, sum, md, errors);
      }
      if (version2) await validateEvidencePacket(abs, t, mode, errors);

      if (mode === "reuse_entry") {
        if ((await exists(meta)) || (await exists(data)) || (await exists(payload))) {
          errors.push(`reuse_entry task ${t.id} must not create data/explore/${id}.*`);
        }
      } else {
        if (!(await exists(meta))) {
          errors.push(`missing data/explore/${id}.meta.json for done new_query task ${t.id}`);
        }
        if (!(await exists(data))) {
          errors.push(`missing data/explore/${id}.json for done new_query task ${t.id}`);
        }
        if (!(await exists(payload))) {
          errors.push(`missing data/explore/${id}.payload.json for done new_query task ${t.id}`);
        }
      }
      if (mode === "new_query" && (await exists(meta))) {
        try {
          const metaObj = JSON.parse(await readFile(meta, "utf8"));
          validateExploreMeta(metaObj, t.id, errors, warnings);
          if (String(metaObj.taskId) !== id) {
            errors.push(`new_query task ${t.id} explore meta taskId must be ${id}`);
          }
          const contractedCardId = String(t.fromCardId || "");
          if (String(metaObj.fromCardId || "") !== contractedCardId) {
            errors.push(`new_query task ${t.id} explore meta fromCardId does not match tasks.json`);
          }
          if (metaObj.status === "ok" && !(await exists(data))) {
            errors.push(`missing data/explore/${id}.json though meta status=ok for task ${t.id}`);
          }
          if (version2 && metaObj.queryDelta?.material !== true) {
            errors.push(`new_query task ${t.id} explore meta must record a material queryDelta`);
          }
          if (version2 && !evidenceGapMatchesChangedKeys(t.evidenceGap, metaObj.queryDelta?.changedKeys)) {
            errors.push(`new_query task ${t.id} queryDelta does not address the contracted evidenceGap types`);
          }
          if (version2 && (!Number.isSafeInteger(metaObj.rowCount) || !/^[a-f0-9]{64}$/.test(metaObj.rowsSha256 || ""))) {
            errors.push(`new_query task ${t.id} explore meta requires rowCount + rowsSha256`);
          }
          if (version2 && (await exists(payload))) {
            const persistedPayload = JSON.parse(await readFile(payload, "utf8"));
            const sourceCardId = String(t.fromCardId || "");
            const sourceCard = (Array.isArray(resultDocument.cards) ? resultDocument.cards : []).find(
              (card) => String(card?.id) === sourceCardId
            );
            if (!isJsonObject(sourceCard?.requestBody)) {
              errors.push(`new_query task ${t.id} source card has no valid requestBody baseline`);
              continue;
            }
            const sourceShape = semanticQueryShape(sourceCard.requestBody);
            const queryShape = semanticQueryShape(persistedPayload);
            const queryDelta = materialQueryDelta(sourceCard.requestBody, persistedPayload);
            if (queryDelta.changedUnclassifiedKeys.length > 0) {
              errors.push(`new_query task ${t.id} changes unclassified query fields`);
            }
            if (resolve(metaObj.payloadPath || "") !== payload) {
              errors.push(`new_query task ${t.id} explore meta payloadPath is not the contracted path`);
            }
            if (metaObj.payloadSha256 !== canonicalFingerprint(persistedPayload)) {
              errors.push(`new_query task ${t.id} explore payloadSha256 mismatch`);
            }
            if (
              canonicalizeJson(metaObj.sourceQueryShape) !== canonicalizeJson(sourceShape) ||
              metaObj.sourceQueryShapeSha256 !== canonicalFingerprint(sourceShape)
            ) {
              errors.push(`new_query task ${t.id} source query shape mismatch`);
            }
            if (
              canonicalizeJson(metaObj.queryShape) !== canonicalizeJson(queryShape) ||
              metaObj.queryShapeSha256 !== canonicalFingerprint(queryShape)
            ) {
              errors.push(`new_query task ${t.id} query shape mismatch`);
            }
            if (canonicalizeJson(metaObj.queryDelta) !== canonicalizeJson(queryDelta) || queryDelta.material !== true) {
              errors.push(`new_query task ${t.id} queryDelta cannot be reproduced from payload`);
            }
          }
        } catch (e) {
          errors.push(`data/explore/${id}.meta.json is not valid JSON: ${e.message || e}`);
        }
      }
    } else if (failedStatuses.has(status)) {
      const mode = t.evidencePlan?.mode;
      const meta = join(abs, "data", "explore", `${id}.meta.json`);
      if (mode === "new_query" && !(await exists(meta))) {
        warnings.push(`failed task ${t.id} missing data/explore/${id}.meta.json`);
      } else if (await exists(meta)) {
        try {
          const metaObj = JSON.parse(await readFile(meta, "utf8"));
          if (metaObj.producer && metaObj.producer !== "fetch-explore.mjs") {
            errors.push(
              `forged or non-script explore meta for failed task ${t.id}: producer must be fetch-explore.mjs`
            );
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (tasks.length === 0) {
    warnings.push("tasks.json has empty tasks[] — explore phase is a no-op");
  } else if (doneCount === 0) {
    const pending = tasks.filter((t) => String(t?.status || "pending").toLowerCase() === "pending");
    if (pending.length === tasks.length) {
      warnings.push(
        "all tasks still pending — either skip B3.5 or run report-researcher before --phase explore"
      );
    }
  }
}

async function checkVerdictProvenance(abs, verdict, errors, warnings) {
  if (verdict.producer !== "write-verdict.mjs") {
    errors.push(
      `quality/verdict.json missing producer=write-verdict.mjs (got ${JSON.stringify(verdict.producer)}). Re-spawn report-reviewer to run write-verdict.mjs; Editor must NOT edit verdict.json`
    );
  }

  const scanPath = join(abs, "quality", "scan.json");
  if (await exists(scanPath)) {
    try {
      const scanText = await readFile(scanPath, "utf8");
      const expected = fingerprintScanText(scanText);
      if (!verdict.scanFingerprint) {
        errors.push(
          "quality/verdict.json missing scanFingerprint; write via write-verdict.mjs after quality-scan"
        );
      } else if (verdict.scanFingerprint !== expected) {
        errors.push(
          "quality/verdict.json scanFingerprint does not match quality/scan.json; re-run write-verdict.mjs (do not hand-edit verdict)"
        );
      }
    } catch (e) {
      warnings.push(`could not fingerprint scan.json: ${e.message || e}`);
    }
  }
}

async function checkQualityArtifacts(abs, errors, warnings) {
  const qualityDir = join(abs, "quality");
  let finalVerdict = null;
  if (!(await exists(qualityDir))) {
    errors.push("missing quality/ under SESSION dir (run quality-scan + report-reviewer)");
    return;
  }

  for (const rel of ["quality/scan.json", "quality/report.md", "quality/verdict.json"]) {
    if (!(await exists(join(abs, rel)))) {
      errors.push(`missing ${rel}`);
    }
  }

  const verdictPath = join(abs, "quality", "verdict.json");
  if (await exists(verdictPath)) {
    try {
      const verdict = JSON.parse(await readFile(verdictPath, "utf8"));
      finalVerdict = verdict;
      if (verdict.draft === true) {
        errors.push("quality/verdict.json is still draft=true; QUALITY agent must write final verdict");
      }
      if (typeof verdict.pass !== "boolean") {
        errors.push("quality/verdict.json missing boolean pass");
      }
      if (Array.isArray(verdict.issues)) {
        const hard = verdict.issues.filter((i) => i && i.severity === "hard");
        if (hard.length > 0 && verdict.pass === true) {
          errors.push("quality/verdict.json has hard issues but pass=true");
        }
      }

      const ids = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];
      if (verdict.draft === false) {
        if (!verdict.scores || typeof verdict.scores !== "object") {
          errors.push("quality/verdict.json missing scores (R1–R7 rubric); see docs/html-report-quality-rubric.md");
        } else {
          for (const id of ids) {
            const n = scoreOf(verdict.scores[id]);
            if (n === null || n === undefined || Number.isNaN(n)) {
              errors.push(`quality/verdict.json scores missing ${id}`);
            } else if (!Number.isInteger(n) || n < 0 || n > 2) {
              errors.push(`quality/verdict.json scores.${id} must be exactly 0, 1, or 2, got ${JSON.stringify(n)}`);
            }
          }
          if (!Number.isSafeInteger(verdict.total)) {
            errors.push("quality/verdict.json total must be an integer from 0 to 14");
          } else {
            let sum = 0;
            for (const id of ids) {
              sum += scoreOf(verdict.scores[id]) || 0;
            }
            if (Math.abs(sum - verdict.total) > 0.01) {
              errors.push(`quality/verdict.json total ${verdict.total} != sum of scores ${sum}`);
            }
          }
        }
      }
      if (Array.isArray(verdict.hardBlockers) && verdict.hardBlockers.length > 0 && verdict.pass === true) {
        errors.push("quality/verdict.json has hardBlockers but pass=true");
      }

      await checkVerdictProvenance(abs, verdict, errors, warnings);
    } catch (e) {
      errors.push(`quality/verdict.json is not valid JSON: ${e.message || e}`);
    }
  }

  const scanPath = join(abs, "quality", "scan.json");
  if (await exists(scanPath)) {
    try {
      const scan = JSON.parse(await readFile(scanPath, "utf8"));
      if (scan.version == null) warnings.push("quality/scan.json missing version");
      if (!Array.isArray(scan.hardIssues)) {
        errors.push("quality/scan.json missing hardIssues array");
      } else if (scan.hardIssues.length > 0 && finalVerdict?.pass === true) {
        errors.push("quality/verdict.json must use pass=false when quality/scan.json has hardIssues");
      }
    } catch (e) {
      errors.push(`quality/scan.json is not valid JSON: ${e.message || e}`);
    }
  }
}

async function checkReportAssembly(abs, errors) {
  const mainPath = join(abs, "analysis", "main.md");
  const tasksPath = join(abs, "analysis", "tasks.json");
  const reportPath = join(abs, "report", "report.md");
  const manifestPath = join(abs, "report", "render-manifest.json");
  if (!(await exists(reportPath))) {
    errors.push("missing report/report.md (run assemble-report.mjs after main.md)");
    return;
  }
  if (!(await exists(manifestPath))) {
    errors.push("missing report/render-manifest.json (run assemble-report.mjs)");
    return;
  }
  let manifest;
  let report;
  let main;
  let tasksText;
  let tasksDocument;
  let resultText;
  let resultDocument;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    report = await readFile(reportPath, "utf8");
    main = await readFile(mainPath, "utf8");
    tasksText = await readFile(tasksPath, "utf8");
    tasksDocument = JSON.parse(tasksText);
    resultText = await readFile(join(abs, "result.json"), "utf8");
    resultDocument = JSON.parse(resultText);
  } catch (e) {
    errors.push(`invalid assembled report artifacts: ${e.message || e}`);
    return;
  }
  if (manifest.producer !== "assemble-report.mjs") {
    errors.push(`report/render-manifest.json producer must be assemble-report.mjs (got ${JSON.stringify(manifest.producer)})`);
  }
  if (manifest.mainSha256 !== fingerprintScanText(main)) {
    errors.push("report/render-manifest.json is stale: re-run assemble-report.mjs after the final Researcher/main merge");
  }
  if (manifest.resultSha256 !== fingerprintScanText(resultText)) {
    errors.push("report/render-manifest.json is stale: re-run assemble-report.mjs after result.json changes");
  }
  if (manifest.tasksSha256 !== fingerprintScanText(tasksText)) {
    errors.push("report/render-manifest.json is stale: re-run assemble-report.mjs after the final tasks.json update");
  }
  if (manifest.reportSha256 !== fingerprintScanText(report)) {
    errors.push("report/render-manifest.json reportSha256 does not match report/report.md");
  }
  for (const card of Array.isArray(manifest.cards) ? manifest.cards : []) {
    if (card.status !== "ok") {
      const entryNow = await exists(join(abs, "data", "cards", card.cardId, "entry.json"));
      const metaNow = await exists(join(abs, "data", "cards", card.cardId, "entry.meta.json"));
      if (entryNow || metaNow) {
        errors.push(`assembled card ${card.cardId} is stale: Writer artifacts now exist; re-run assemble-report.mjs`);
      }
      continue;
    }
    if (card.sourceRows !== card.renderedRows || card.fullTable !== true) {
      errors.push(`assembled full table row mismatch for card ${card.cardId}`);
    }
    const marker = `html-report:full-table card="${card.cardId}" rows="${card.sourceRows}"`;
    if (!report.includes(marker)) errors.push(`report/report.md missing full-table marker for card ${card.cardId}`);
    try {
      const rows = JSON.parse(await readFile(join(abs, "data", "cards", card.cardId, "entry.json"), "utf8"));
      const currentRowsSha256 = canonicalFingerprint(rows);
      if (card.sourceRowsSha256 !== currentRowsSha256) {
        errors.push(`assembled Writer source hash is stale for card ${card.cardId}`);
      }
    } catch (error) {
      errors.push(`cannot verify assembled Writer source for card ${card.cardId}: ${error.message || error}`);
    }
  }
  for (const task of Array.isArray(manifest.tasks) ? manifest.tasks : []) {
    if (task.status !== "ok") {
      errors.push(`assembled Researcher table is missing for task ${task.taskId}`);
      continue;
    }
    const expectedSectionPath = join(abs, "analysis", "sections", `explore-${task.taskId}.md`);
    try {
      const section = await readFile(expectedSectionPath, "utf8");
      const sectionSha256 = fingerprintScanText(section);
      const sectionMarker = `html-report:research-section task="${task.taskId}" sha256="${sectionSha256}"`;
      if (
        task.sectionIncluded !== true ||
        task.sectionPath !== `analysis/sections/explore-${task.taskId}.md` ||
        task.sectionSha256 !== sectionSha256 ||
        !report.includes(sectionMarker)
      ) {
        errors.push(`assembled Researcher section is stale or missing for task ${task.taskId}`);
      }
    } catch (error) {
      errors.push(`cannot verify assembled Researcher section for task ${task.taskId}: ${error.message || error}`);
    }
    if (task.mode === "reuse_entry") {
      if (task.fullTableSource !== "writer_entry") {
        errors.push(`reuse_entry task ${task.taskId} must reuse the Writer full table`);
      }
      const marker = `html-report:full-table card="${task.sourceCardId}"`;
      if (!task.sourceCardId || !report.includes(marker)) {
        errors.push(`reuse_entry task ${task.taskId} source Writer full table is missing`);
      }
      const sourceCard = (Array.isArray(manifest.cards) ? manifest.cards : []).find(
        (card) => card.cardId === task.sourceCardId
      );
      if (!sourceCard || task.sourceRowsSha256 !== sourceCard.sourceRowsSha256) {
        errors.push(`reuse_entry task ${task.taskId} source hash is stale`);
      }
      continue;
    }
    if (task.mode === "new_query") {
      if (task.sourceRows !== task.renderedRows || task.fullTable !== true) {
        errors.push(`assembled full explore table row mismatch for task ${task.taskId}`);
      }
      const marker = `html-report:full-explore-table task="${task.taskId}" rows="${task.sourceRows}"`;
      if (!report.includes(marker)) {
        errors.push(`report/report.md missing full-explore-table marker for task ${task.taskId}`);
      }
      try {
        const rows = JSON.parse(await readFile(join(abs, "data", "explore", `${task.taskId}.json`), "utf8"));
        if (task.sourceRowsSha256 !== canonicalFingerprint(rows)) {
          errors.push(`assembled explore source hash is stale for task ${task.taskId}`);
        }
      } catch (error) {
        errors.push(`cannot verify assembled explore source for task ${task.taskId}: ${error.message || error}`);
      }
    }
  }
  const expectedCards = (Array.isArray(resultDocument.cards) ? resultDocument.cards : [])
    .map((card) => sanitizeCardId(card?.id))
    .sort();
  const actualCards = (Array.isArray(manifest.cards) ? manifest.cards : [])
    .map((card) => String(card?.cardId || ""))
    .sort();
  if (canonicalizeJson(actualCards) !== canonicalizeJson(expectedCards)) {
    errors.push("report/render-manifest.json cards do not exactly cover current result.json cards");
  }
  if (Number(tasksDocument.version) === 2) {
    const expectedTasks = (Array.isArray(tasksDocument.tasks) ? tasksDocument.tasks : [])
      .filter((task) => String(task?.status || "").toLowerCase() === "done")
      .map((task) => ({ taskId: sanitizeTaskId(task.id), mode: task.evidencePlan?.mode }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || String(a.mode).localeCompare(String(b.mode)));
    const actualTasks = (Array.isArray(manifest.tasks) ? manifest.tasks : [])
      .map((task) => ({ taskId: String(task?.taskId || ""), mode: task?.mode }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || String(a.mode).localeCompare(String(b.mode)));
    if (canonicalizeJson(actualTasks) !== canonicalizeJson(expectedTasks)) {
      errors.push("report/render-manifest.json tasks do not exactly cover current done tasks");
    }
  }
}

async function checkStepGateApprovals(abs, phase, errors) {
  const statePath = join(abs, "debug", "pipeline-state.json");
  if (!(await exists(statePath))) return;
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    errors.push(`debug/pipeline-state.json is invalid: ${error.message || error}`);
    return;
  }
  if (state.producer !== "stage-gate.mjs") {
    errors.push("debug/pipeline-state.json producer must be stage-gate.mjs");
    return;
  }
  if (state.mode !== "step") return;

  const required =
    phase === "html"
      ? ["A_CONFIG", "B0_PREFLIGHT", "B2_WRITER", "B3_RESEARCH", "B4_REVIEW"]
      : ["A_CONFIG", "B0_PREFLIGHT", "B2_WRITER", "B3_RESEARCH"];
  const approved = new Set(
    (Array.isArray(state.approvals) ? state.approvals : []).map((item) => item?.stage)
  );
  for (const stageId of required) {
    if (!approved.has(stageId)) {
      errors.push(
        `step Gate prerequisite ${stageId} is not approved before --phase ${phase}`
      );
    }
  }
}

async function checkHtmlArtifacts(abs, errors, warnings) {
  const reportDir = join(abs, "report");
  const markdownPath = join(reportDir, "report.md");
  const htmlPath = join(reportDir, "report.html");
  const contentPath = join(reportDir, "report.content.html");
  const designInputPath = join(reportDir, "design-input.json");
  const templatePath = join(reportDir, "report.design.html");
  const renderMetaPath = join(reportDir, "render.meta.json");
  const visualPath = join(reportDir, "visual-check.json");
  const designResultPath = join(reportDir, "design-result.json");

  if (!(await exists(markdownPath))) {
    errors.push("missing report/report.md (freeze after quality pass)");
  }
  for (const [path, message] of [
    [contentPath, "missing report/report.content.html (run compile-report-content.mjs)"],
    [designInputPath, "missing report/design-input.json (run compile-report-content.mjs)"],
    [templatePath, "missing report/report.design.html (Report Designer must create it)"],
    [renderMetaPath, "missing report/render.meta.json (run compose-report.mjs)"],
    [visualPath, "missing report/visual-check.json (run capture-report.mjs)"],
    [designResultPath, "missing report/design-result.json (run finalize-design.mjs)"],
  ]) {
    if (!(await exists(path))) errors.push(message);
  }

  if (!(await exists(htmlPath))) {
    errors.push("missing report/report.html (run compose-report.mjs)");
  } else {
    try {
      const html = await readFile(htmlPath, "utf8");
      if (!/<html[\s>]/i.test(html)) errors.push("report/report.html does not look like HTML");
      if (!/<table[\s>]/i.test(html) && (await exists(markdownPath))) {
        const md = await readFile(markdownPath, "utf8");
        if (/\|.+\|/.test(md) && /---/.test(md)) {
          warnings.push("report.md has tables but report.html has no <table>");
        }
      }
      if (html.length < 200) warnings.push("report/report.html is unusually short");
      const manifestPath = join(abs, "report", "render-manifest.json");
      if (await exists(manifestPath)) {
        try {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          for (const card of Array.isArray(manifest.cards) ? manifest.cards : []) {
            if (card.status !== "ok") continue;
            const marker = `html-report:full-table card="${card.cardId}" rows="${card.sourceRows}"`;
            if (!html.includes(marker)) {
              errors.push(`report/report.html missing full-table marker for card ${card.cardId}`);
            }
          }
          for (const task of Array.isArray(manifest.tasks) ? manifest.tasks : []) {
            if (task.status !== "ok" || task.mode !== "new_query") continue;
            const marker = `html-report:full-explore-table task="${task.taskId}" rows="${task.sourceRows}"`;
            if (!html.includes(marker)) {
              errors.push(`report/report.html missing full-explore-table marker for task ${task.taskId}`);
            }
          }
        } catch {
          // checkReportAssembly reports the manifest parse error
        }
      }

      if (
        await Promise.all([markdownPath, contentPath, designInputPath, templatePath, renderMetaPath]
          .map((path) => exists(path))).then((values) => values.every(Boolean))
      ) {
        const markdown = await readFile(markdownPath, "utf8");
        const content = await readFile(contentPath, "utf8");
        const input = JSON.parse(await readFile(designInputPath, "utf8"));
        const template = await readFile(templatePath, "utf8");
        const meta = JSON.parse(await readFile(renderMetaPath, "utf8"));
        if (input.producer !== "compile-report-content.mjs") {
          errors.push("report/design-input.json producer must be compile-report-content.mjs");
        }
        if (meta.producer !== "compose-report.mjs") {
          errors.push("report/render.meta.json producer must be compose-report.mjs");
        }
        if (fingerprintScanText(markdown) !== input.markdownSha256 || meta.markdownSha256 !== input.markdownSha256) {
          errors.push("report Markdown changed after content compilation");
        }
        if (fingerprintScanText(content) !== input.contentFileSha256 || meta.contentFileSha256 !== input.contentFileSha256) {
          errors.push("compiled report content fingerprint mismatch");
        }
        if (fingerprintScanText(template) !== meta.templateSha256) {
          errors.push("report.design.html changed after compose-report.mjs");
        }
        if (fingerprintScanText(html) !== meta.htmlSha256) {
          errors.push("report.html changed after compose-report.mjs");
        }
        const boundary = /<!-- html-report:content-start sha256="([a-f0-9]{64})" -->\n([\s\S]*?)\n<!-- html-report:content-end -->/.exec(html);
        if (!boundary) {
          errors.push("report.html missing immutable content boundary");
        } else if (fingerprintScanText(boundary[2]) !== boundary[1] || boundary[1] !== input.contentSha256) {
          errors.push("report.html immutable content hash mismatch");
        }
        if (!html.includes(content.trimEnd())) {
          errors.push("report.html does not contain the exact compiled content fragment");
        }
      }

      if ((await exists(visualPath)) && (await exists(designResultPath))) {
        const visualText = await readFile(visualPath, "utf8");
        const visual = JSON.parse(visualText);
        const designResult = JSON.parse(await readFile(designResultPath, "utf8"));
        const htmlHash = fingerprintScanText(html);
        if (visual.producer !== "capture-report.mjs" || visual.htmlSha256 !== htmlHash) {
          errors.push("visual-check.json is not bound to the current report.html");
        }
        const screenshots = Array.isArray(visual.screenshots) ? visual.screenshots : [];
        for (const id of ["desktop", "mobile"]) {
          const shot = screenshots.find((item) => item.id === id);
          if (!shot?.path || !(await exists(shot.path))) {
            errors.push(`missing ${id} report screenshot`);
          } else if (fingerprintData(await readFile(shot.path)) !== shot.sha256) {
            errors.push(`${id} screenshot fingerprint mismatch`);
          }
        }
        if (
          designResult.producer !== "finalize-design.mjs" ||
          designResult.status !== "pass" ||
          designResult.htmlSha256 !== htmlHash ||
          designResult.visualCheckSha256 !== fingerprintScanText(visualText) ||
          designResult.viewports?.desktop?.pass !== true ||
          designResult.viewports?.mobile?.pass !== true
        ) {
          errors.push("design-result.json is missing a stamped desktop/mobile visual pass");
        }
      }
    } catch (e) {
      errors.push(`cannot read report/report.html: ${e.message || e}`);
    }
  }

  const verdictPath = join(abs, "quality", "verdict.json");
  if (await exists(verdictPath)) {
    try {
      const verdict = JSON.parse(await readFile(verdictPath, "utf8"));
      if (verdict.pass !== true) {
        errors.push("quality/verdict.json pass is not true; HTML phase requires quality pass");
      }
      if (verdict.draft === true) {
        errors.push("quality/verdict.json is still draft");
      }
      // Re-check producer on html phase (prevent mid-flight hand-edit)
      if (verdict.producer !== "write-verdict.mjs") {
        errors.push(
          "quality/verdict.json missing producer=write-verdict.mjs; HTML requires stamped verdict"
        );
      }
    } catch (e) {
      errors.push(`quality/verdict.json is not valid JSON: ${e.message || e}`);
    }
  } else {
    errors.push("missing quality/verdict.json (HTML requires quality pass)");
  }
}

export async function checkSessionLayout(sessionDir, { phase = "b2" } = {}) {
  const abs = resolve(sessionDir);
  const errors = [];
  const warnings = [];
  const allowedPhases = new Set(["a", "b1", "writer", "b2", "explore", "quality", "html"]);
  if (!allowedPhases.has(phase)) {
    errors.push(`unknown layout phase ${JSON.stringify(phase)}`);
  }

  if (!abs.includes(`${join(".harness", "state", "html-report")}`) && !abs.includes(".harness/state/html-report")) {
    errors.push(`session dir must be under .harness/state/html-report/: got ${abs}`);
  }

  const requiredAlways = ["result.json"];
  for (const rel of requiredAlways) {
    if (!(await exists(join(abs, rel)))) errors.push(`missing ${rel}`);
  }

  const result = await readResult(abs, errors);
  if (result && result.status !== "confirmed") {
    errors.push(`result.status must be confirmed for phase ${phase}, got ${JSON.stringify(result.status)}`);
  }

  if (phase === "b1") {
    await checkWriterArtifacts(abs, errors, warnings, result);
  }

  if (phase === "writer") {
    await checkWriterArtifacts(abs, errors, warnings, result);
  }

  if (phase === "b2" || phase === "explore" || phase === "quality" || phase === "html") {
    await checkB2Artifacts(abs, errors, warnings, result);
  }

  if (phase === "explore") {
    await checkExploreArtifacts(abs, errors, warnings);
    await checkReportAssembly(abs, errors);
  }

  if (phase === "quality" || phase === "html") {
    await checkExploreArtifacts(abs, errors, warnings);
    await checkStepGateApprovals(abs, phase, errors);
    await checkQualityArtifacts(abs, errors, warnings);
    await checkReportAssembly(abs, errors);
  }

  if (phase === "html") {
    await checkHtmlArtifacts(abs, errors, warnings);
  }

  return {
    ok: errors.length === 0,
    sessionDir: abs,
    phase,
    errors,
    warnings,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  const phase = value("--phase") || "b2";
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir) {
    die("usage: check-session-layout.mjs --session-dir <dir> | --result <result.json> [--phase a|b1|writer|b2|explore|quality|html]");
  }
  const report = await checkSessionLayout(sessionDir, { phase });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}
