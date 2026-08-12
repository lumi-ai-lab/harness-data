#!/usr/bin/env node
/**
 * WRITE-VERDICT (Phase B4): normalize and stamp final quality/verdict.json.
 *
 * Only report-reviewer should call this. Report Editor must NOT hand-write verdict.json.
 *
 * Usage:
 *   node write-verdict.mjs --result <result.json> --verdict-file <draft.json>
 *   node write-verdict.mjs --session-dir <SESSION> --verdict-file <draft.json>
 *
 * Requires quality/scan.json (from quality-scan.mjs). Writes quality/verdict.json with:
 *   producer, producerVersion, sourceAgent, scanFingerprint, scores R1–R7 (0–2),
 *   requiredRubrics, gateFailures, total, pass, draft:false
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_CONTRACT_VERSION } from "./researcher-return.mjs";

const RUBRIC_IDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];
const PRODUCER = "write-verdict.mjs";
const PRODUCER_VERSION = 3;

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

/** SHA-256 hex of scan.json raw bytes (utf8 file content). */
export function fingerprintScanContent(scanText) {
  return createHash("sha256").update(String(scanText), "utf8").digest("hex");
}

export async function fingerprintScanFile(scanPath) {
  const text = await readFile(scanPath, "utf8");
  return { fingerprint: fingerprintScanContent(text), text };
}

function scoreOf(cell) {
  if (cell == null) return null;
  if (typeof cell === "number") return cell;
  if (typeof cell === "object" && cell.score != null) return Number(cell.score);
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function targetRubrics(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (!allowEmpty && value.length === 0) throw new Error(`${label} must not be empty`);
  const normalized = [];
  const seen = new Set();
  for (const rubric of value) {
    if (typeof rubric !== "string" || !RUBRIC_IDS.includes(rubric)) {
      throw new Error(`${label} may contain only R1-R7`);
    }
    if (!seen.has(rubric)) {
      seen.add(rubric);
      normalized.push(rubric);
    }
  }
  return normalized;
}

/**
 * Collect additional score gates declared by completed Researcher tasks.
 * Requirement-level targets are authoritative. The legacy task-level field
 * only fills rubrics not covered by that task's requirements.
 */
export function collectRequiredRubrics(tasksDocument) {
  if (tasksDocument == null) return [];
  if (!isPlainObject(tasksDocument) || !Array.isArray(tasksDocument.tasks)) {
    throw new Error("analysis/tasks.json must contain one object with tasks[]");
  }

  const collected = new Map();
  const add = (rubric, minScore, source) => {
    const current = collected.get(rubric) || { rubric, minScore, sources: [] };
    current.minScore = Math.max(current.minScore, minScore);
    current.sources.push(source);
    collected.set(rubric, current);
  };

  tasksDocument.tasks.forEach((task, taskIndex) => {
    if (!isPlainObject(task) || task.status !== "done") return;
    if (typeof task.id !== "string" || !task.id.trim()) {
      throw new Error(`analysis/tasks.json tasks[${taskIndex}] status=done requires a non-empty id`);
    }
    const taskId = task.id.trim();
    const hasContractVersion = Object.prototype.hasOwnProperty.call(task, "analysisContractVersion");
    if (hasContractVersion && task.analysisContractVersion !== ANALYSIS_CONTRACT_VERSION) {
      throw new Error(
        `task ${taskId} analysisContractVersion must be exactly ${ANALYSIS_CONTRACT_VERSION}`
      );
    }
    const requirements = task.analysisRequirements ?? [];
    if (!Array.isArray(requirements)) {
      throw new Error(`task ${taskId} analysisRequirements must be an array when present`);
    }
    if (task.analysisContractVersion === ANALYSIS_CONTRACT_VERSION && requirements.length === 0) {
      throw new Error(
        `task ${taskId} analysisRequirements must be non-empty for analysisContractVersion ${ANALYSIS_CONTRACT_VERSION}`
      );
    }

    const requirementTargets = new Set();
    requirements.forEach((requirement, requirementIndex) => {
      const label = `task ${taskId} analysisRequirements[${requirementIndex}]`;
      if (!isPlainObject(requirement)) throw new Error(`${label} must be an object`);
      if (typeof requirement.id !== "string" || !requirement.id.trim()) {
        throw new Error(`${label}.id must be a non-empty string`);
      }
      const rubrics = targetRubrics(requirement.targetRubric, `${label}.targetRubric`, {
        allowEmpty: false,
      });
      const hasMinScore = Object.prototype.hasOwnProperty.call(requirement, "minScore");
      const minScore = hasMinScore ? requirement.minScore : 2;
      if (minScore !== 1 && minScore !== 2) {
        throw new Error(`${label}.minScore must be 1 or 2 when present`);
      }
      for (const rubric of rubrics) {
        requirementTargets.add(rubric);
        add(rubric, minScore, {
          taskId,
          requirementId: requirement.id.trim(),
          source: "analysisRequirements[].targetRubric",
        });
      }
    });

    if (task.targetRubric !== undefined) {
      const legacyTargets = targetRubrics(task.targetRubric, `task ${taskId} targetRubric`);
      for (const rubric of legacyTargets) {
        if (requirementTargets.has(rubric)) continue;
        add(rubric, 2, {
          taskId,
          requirementId: null,
          source: "task.targetRubric",
        });
      }
    }
  });

  return RUBRIC_IDS.filter((rubric) => collected.has(rubric)).map((rubric) => collected.get(rubric));
}

/** Return every completed-task target whose stamped score is below its gate. */
export function gateFailuresForScores(requiredRubrics, scores) {
  if (!Array.isArray(requiredRubrics)) throw new Error("requiredRubrics must be an array");
  const seen = new Set();
  return requiredRubrics.flatMap((required, index) => {
    if (!isPlainObject(required) || !RUBRIC_IDS.includes(required.rubric)) {
      throw new Error(`requiredRubrics[${index}].rubric must be R1-R7`);
    }
    if (seen.has(required.rubric)) {
      throw new Error(`requiredRubrics contains duplicate ${required.rubric}`);
    }
    seen.add(required.rubric);
    if (required.minScore !== 1 && required.minScore !== 2) {
      throw new Error(`requiredRubrics[${index}].minScore must be 1 or 2`);
    }
    if (!Array.isArray(required.sources)) {
      throw new Error(`requiredRubrics[${index}].sources must be an array`);
    }
    const actualScore = scoreOf(scores?.[required.rubric]);
    if (!Number.isInteger(actualScore) || actualScore < 0 || actualScore > 2) {
      throw new Error(`scores.${required.rubric} must be exactly 0, 1, or 2`);
    }
    return actualScore < required.minScore
      ? [{
          rubric: required.rubric,
          minScore: required.minScore,
          actualScore,
          sources: required.sources.map((source) => ({ ...source })),
        }]
      : [];
  });
}

/**
 * Validate draft scores and build a stamped final verdict.
 * @param {object} draft - partial verdict from report-reviewer
 * @param {{ scanFingerprint: string, scanHardIssues?: unknown[], requiredRubrics?: object[], sessionDir?: string, scanPath?: string }} opts
 */
export function buildVerdict(draft, opts) {
  const errors = [];
  const input = draft && typeof draft === "object" ? draft : {};
  const scoresIn = input.scores && typeof input.scores === "object" ? input.scores : null;
  if (!scoresIn) {
    errors.push("scores (R1–R7) is required");
  }

  const scores = {};
  let sum = 0;
  if (scoresIn) {
    for (const id of RUBRIC_IDS) {
      const n = scoreOf(scoresIn[id]);
      if (n === null || Number.isNaN(n)) {
        errors.push(`scores.${id} missing or not a number`);
        continue;
      }
      if (!Number.isInteger(n) || n < 0 || n > 2) {
        errors.push(`scores.${id} must be exactly 0, 1, or 2, got ${JSON.stringify(n)}`);
        continue;
      }
      const prev = scoresIn[id];
      scores[id] =
        prev && typeof prev === "object"
          ? { ...prev, score: n, max: 2 }
          : { score: n, max: 2 };
      sum += n;
    }
  }

  const hardBlockers = Array.isArray(input.hardBlockers) ? input.hardBlockers : [];
  const issues = Array.isArray(input.issues) ? input.issues : [];
  const hardIssues = issues.filter((i) => i && i.severity === "hard");
  const scanHardIssues = Array.isArray(opts.scanHardIssues) ? opts.scanHardIssues : [];
  const hasHard = hardBlockers.length > 0 || hardIssues.length > 0 || scanHardIssues.length > 0;

  if (typeof input.total === "number" && Math.abs(input.total - sum) > 0.01 && scoresIn) {
    // Prefer computed sum; ignore mismatched draft total (do not error — script is source of truth)
  }

  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.validationErrors = errors;
    throw err;
  }

  const requiredRubrics = Array.isArray(opts.requiredRubrics)
    ? opts.requiredRubrics.map((required) => ({
        ...required,
        sources: Array.isArray(required?.sources)
          ? required.sources.map((source) => ({ ...source }))
          : required?.sources,
      }))
    : [];
  const gateFailures = gateFailuresForScores(requiredRubrics, scores);

  // The stamped verdict, not model discretion, owns the release decision.
  // Completed Researcher task targets are additional gates on top of the
  // stable base threshold; no targets preserves the historical formula.
  const basePass = !hasHard && sum >= 10 && scores.R1.score >= 1 && scores.R2.score >= 1;
  const pass = basePass && gateFailures.length === 0;

  const checkedAt = input.checkedAt || new Date().toISOString();
  return {
    version: input.version ?? 1,
    pass,
    draft: false,
    producer: PRODUCER,
    producerVersion: PRODUCER_VERSION,
    sourceAgent: input.sourceAgent || "report-reviewer",
    scanFingerprint: opts.scanFingerprint,
    scores,
    total: sum,
    maxTotal: 14,
    requiredRubrics,
    gateFailures,
    hardBlockers,
    issues,
    softIssues: Array.isArray(input.softIssues) ? input.softIssues : undefined,
    notes: input.notes,
    checkedAt,
    scanPath: input.scanPath || opts.scanPath || "quality/scan.json",
    sessionDir: opts.sessionDir || input.sessionDir,
  };
}

/**
 * @param {string} sessionDir
 * @param {object} draft
 */
export async function writeVerdict(sessionDir, draft) {
  const abs = resolve(sessionDir);
  const qualityDir = join(abs, "quality");
  const scanPath = join(qualityDir, "scan.json");
  const verdictPath = join(qualityDir, "verdict.json");

  if (!(await exists(scanPath))) {
    throw new Error(`missing quality/scan.json under ${abs}; run quality-scan.mjs first`);
  }

  const { fingerprint, text } = await fingerprintScanFile(scanPath);
  let scan;
  try {
    scan = JSON.parse(text);
  } catch (error) {
    throw new Error(`quality/scan.json is not valid JSON: ${error.message || error}`);
  }
  if (!scan || typeof scan !== "object" || Array.isArray(scan) || !Array.isArray(scan.hardIssues)) {
    throw new Error("quality/scan.json must contain a hardIssues array");
  }
  const tasksPath = join(abs, "analysis", "tasks.json");
  let tasksDocument;
  if (await exists(tasksPath)) {
    try {
      tasksDocument = JSON.parse(await readFile(tasksPath, "utf8"));
    } catch (error) {
      throw new Error(`analysis/tasks.json is not valid JSON: ${error.message || error}`);
    }
  }
  const requiredRubrics = collectRequiredRubrics(tasksDocument);
  const final = buildVerdict(draft, {
    scanFingerprint: fingerprint,
    scanHardIssues: scan.hardIssues,
    requiredRubrics,
    sessionDir: abs,
    scanPath: "quality/scan.json",
  });

  await mkdir(qualityDir, { recursive: true });
  await writeFile(verdictPath, `${JSON.stringify(final, null, 2)}\n`);
  return { verdictPath, verdict: final };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let sessionDir = value("--session-dir");
  const resultPath = value("--result");
  const verdictFile = value("--verdict-file");
  if (!sessionDir && resultPath) sessionDir = dirname(resolve(resultPath));
  if (!sessionDir || !verdictFile) {
    process.stderr.write(
      "usage: write-verdict.mjs --result <result.json> | --session-dir <SESSION> --verdict-file <draft.json>\n"
    );
    process.exit(2);
  }
  try {
    const draft = JSON.parse(await readFile(resolve(verdictFile), "utf8"));
    const { verdictPath, verdict } = await writeVerdict(sessionDir, draft);
    process.stdout.write(
      `${JSON.stringify({ ok: true, verdictPath, pass: verdict.pass, total: verdict.total, requiredRubrics: verdict.requiredRubrics, gateFailures: verdict.gateFailures, scanFingerprint: verdict.scanFingerprint }, null, 2)}\n`
    );
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
