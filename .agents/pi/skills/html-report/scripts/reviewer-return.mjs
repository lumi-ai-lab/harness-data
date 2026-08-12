/**
 * Report Reviewer's machine-checkable return and artifact contract.
 *
 * B4 must return one structured JSON object.  All paths are derived from the
 * current html-report SESSION, so a Reviewer cannot redirect the Editor to a
 * different report or describe a failed verdict as a successful run.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { collectRequiredRubrics, gateFailuresForScores } from "./write-verdict.mjs";

const MAX_TOTAL = 14;
const VERDICT_PRODUCER = "write-verdict.mjs";
const RUBRIC_IDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assignmentValue(task, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = String(task || "").match(new RegExp(`^.*?\\b${escaped}\\s*=\\s*(.+?)\\s*$`, "mi"));
  if (!line) return undefined;
  const value = line[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function reviewerReturnPaths({ sessionDir }) {
  if (!sessionDir || !isAbsolute(sessionDir)) {
    throw new Error("sessionDir must be an absolute path");
  }
  const session = resolve(sessionDir);
  const paths = {
    sessionDir: session,
    resultPath: join(session, "result.json"),
    scanPath: join(session, "quality", "scan.json"),
    reportPath: join(session, "quality", "report.md"),
    verdictPath: join(session, "quality", "verdict.json"),
  };
  for (const path of Object.values(paths).slice(1)) {
    if (!inside(session, path)) throw new Error("Reviewer artifact path escapes sessionDir");
  }
  return paths;
}

/**
 * Resolve the assignment against the authoritative current SESSION.  Prompt
 * paths are assertions only; they cannot choose another session or result.
 */
export function reviewerExpectedFromAssignment(taskText, { sessionDir } = {}) {
  if (!sessionDir || !isAbsolute(sessionDir)) {
    return { error: "当前 html-report SESSION 绝对路径缺失。" };
  }
  let paths;
  try {
    paths = reviewerReturnPaths({ sessionDir });
  } catch (error) {
    return { error: `无法建立 Report Reviewer 路径契约：${error.message || error}` };
  }

  const assignedSession = assignmentValue(taskText, "SESSION");
  const assignedResult = assignmentValue(taskText, "result.json");
  if (!assignedSession || !assignedResult) {
    return { error: "Report Reviewer task 必须包含 SESSION 与 result.json 的绝对路径。" };
  }
  if (!isAbsolute(assignedSession) || !isAbsolute(assignedResult)) {
    return { error: "Report Reviewer task 的 SESSION 与 result.json 必须是绝对路径。" };
  }
  if (resolve(assignedSession) !== paths.sessionDir || resolve(assignedResult) !== paths.resultPath) {
    return { error: "Report Reviewer task 的 SESSION/result.json 必须属于当前 html-report session 的固定路径。" };
  }
  return paths;
}

function repairHintsSchema({ minItems = 0 } = {}) {
  return {
    type: "array",
    minItems,
    maxItems: 20,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 1000 },
  };
}

function gateSourceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      taskId: { type: "string", minLength: 1 },
      requirementId: { type: ["string", "null"] },
      source: { enum: ["analysisRequirements[].targetRubric", "task.targetRubric"] },
    },
    required: ["taskId", "requirementId", "source"],
  };
}

function requiredRubricsSchema() {
  return {
    type: "array",
    maxItems: RUBRIC_IDS.length,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        rubric: { enum: RUBRIC_IDS },
        minScore: { enum: [1, 2] },
        sources: { type: "array", minItems: 1, items: gateSourceSchema() },
      },
      required: ["rubric", "minScore", "sources"],
    },
  };
}

function gateFailuresSchema() {
  return {
    type: "array",
    maxItems: RUBRIC_IDS.length,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        rubric: { enum: RUBRIC_IDS },
        minScore: { enum: [1, 2] },
        actualScore: { type: "integer", minimum: 0, maximum: 2 },
        sources: { type: "array", minItems: 1, items: gateSourceSchema() },
      },
      required: ["rubric", "minScore", "actualScore", "sources"],
    },
  };
}

function reviewerBranch(expected, { status, pass, requireRepairHint = false }) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { const: status },
      pass: { const: pass },
      total: { type: "integer", minimum: 0, maximum: MAX_TOTAL },
      maxTotal: { const: MAX_TOTAL },
      sessionDir: { const: expected.sessionDir },
      resultPath: { const: expected.resultPath },
      scanPath: { const: expected.scanPath },
      reportPath: { const: expected.reportPath },
      verdictPath: { const: expected.verdictPath },
      repairHints: repairHintsSchema({ minItems: requireRepairHint ? 1 : 0 }),
      requiredRubrics: requiredRubricsSchema(),
      gateFailures: gateFailuresSchema(),
    },
    required: [
      "status",
      "pass",
      "total",
      "maxTotal",
      "sessionDir",
      "resultPath",
      "scanPath",
      "reportPath",
      "verdictPath",
      "repairHints",
      "requiredRubrics",
      "gateFailures",
    ],
  };
}

function reviewerInfrastructureErrorBranch(expected) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { const: "infrastructure_error" },
      pass: { const: false },
      total: { const: 0 },
      maxTotal: { const: MAX_TOTAL },
      sessionDir: { const: expected.sessionDir },
      resultPath: { const: expected.resultPath },
      scanPath: { const: expected.scanPath },
      reportPath: { const: expected.reportPath },
      verdictPath: { const: expected.verdictPath },
      failedStep: { enum: ["read", "write", "stamp"] },
      error: { type: "string", minLength: 1, maxLength: 2000 },
      repairHints: repairHintsSchema({ minItems: 1 }),
    },
    required: [
      "status",
      "pass",
      "total",
      "maxTotal",
      "sessionDir",
      "resultPath",
      "scanPath",
      "reportPath",
      "verdictPath",
      "failedStep",
      "error",
      "repairHints",
    ],
  };
}

/** Build the exact one-object outputSchema for the B4 Reviewer chain. */
export function buildReviewerReturnSchema(expected) {
  for (const key of ["sessionDir", "resultPath", "scanPath", "reportPath", "verdictPath"]) {
    if (!expected?.[key] || !isAbsolute(expected[key])) {
      throw new Error(`Reviewer expected.${key} must be an absolute path`);
    }
  }
  return {
    oneOf: [
      reviewerBranch(expected, { status: "passed", pass: true }),
      reviewerBranch(expected, { status: "failed", pass: false, requireRepairHint: true }),
      reviewerInfrastructureErrorBranch(expected),
    ],
  };
}

/** Schema-independent validation for captured structured output. */
export function validateReviewerReturn(value, expected) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["Reviewer return must be one JSON object"] };
  }
  const commonKeys = [
    "status",
    "pass",
    "total",
    "maxTotal",
    "sessionDir",
    "resultPath",
    "scanPath",
    "reportPath",
    "verdictPath",
    "repairHints",
  ];
  const infrastructureError = value.status === "infrastructure_error";
  const keys = infrastructureError
    ? [...commonKeys, "failedStep", "error"]
    : [...commonKeys, "requiredRubrics", "gateFailures"];
  if (!hasExactlyKeys(value, keys)) errors.push("Reviewer return has unexpected or missing fields");
  if (value.pass !== true && value.pass !== false) errors.push("pass must be a boolean");
  const expectedStatus = value.pass === true ? "passed" : value.pass === false ? "failed" : undefined;
  if (!infrastructureError && value.status !== expectedStatus) {
    errors.push("status must be passed exactly when pass=true, and failed exactly when pass=false");
  }
  if (infrastructureError && value.pass !== false) {
    errors.push("infrastructure_error must use pass=false");
  }
  if (infrastructureError && value.total !== 0) {
    errors.push("infrastructure_error must use total=0 because no scorecard was completed");
  } else if (!Number.isSafeInteger(value.total) || value.total < 0 || value.total > MAX_TOTAL) {
    errors.push("total must be an integer from 0 to 14");
  }
  if (value.maxTotal !== MAX_TOTAL) errors.push("maxTotal must be exactly 14");
  for (const key of ["sessionDir", "resultPath", "scanPath", "reportPath", "verdictPath"]) {
    if (value[key] !== expected?.[key]) errors.push(`${key} does not match the current Reviewer assignment`);
  }
  if (
    !Array.isArray(value.repairHints) ||
    value.repairHints.length > 20 ||
    !value.repairHints.every((hint) => typeof hint === "string" && hint.trim() && hint.length <= 1000) ||
    new Set(value.repairHints).size !== value.repairHints.length
  ) {
    errors.push("repairHints must be an array of at most 20 unique non-empty strings");
  } else if ((value.status === "failed" || infrastructureError) && value.repairHints.length === 0) {
    errors.push(`${value.status} return requires at least one actionable repair hint`);
  }
  if (infrastructureError) {
    if (!["read", "write", "stamp"].includes(value.failedStep)) {
      errors.push("infrastructure_error failedStep must be read, write, or stamp");
    }
    if (typeof value.error !== "string" || !value.error.trim() || value.error.length > 2000) {
      errors.push("infrastructure_error requires a non-empty error of at most 2000 characters");
    }
  } else {
    validateDynamicAuditShape(value.requiredRubrics, value.gateFailures, errors, "Reviewer return");
  }
  return { ok: errors.length === 0, errors };
}

function validGateSource(source) {
  return isPlainObject(source) &&
    hasExactlyKeys(source, ["taskId", "requirementId", "source"]) &&
    typeof source.taskId === "string" &&
    Boolean(source.taskId.trim()) &&
    (source.requirementId === null || (typeof source.requirementId === "string" && Boolean(source.requirementId.trim()))) &&
    ["analysisRequirements[].targetRubric", "task.targetRubric"].includes(source.source);
}

function validateDynamicAuditShape(requiredRubrics, gateFailures, errors, label) {
  if (!Array.isArray(requiredRubrics) || requiredRubrics.length > RUBRIC_IDS.length) {
    errors.push(`${label} requiredRubrics must be an array with at most 7 items`);
  } else {
    const seen = new Set();
    requiredRubrics.forEach((required, index) => {
      const prefix = `${label} requiredRubrics[${index}]`;
      if (!isPlainObject(required) || !hasExactlyKeys(required, ["rubric", "minScore", "sources"])) {
        errors.push(`${prefix} must contain exactly rubric, minScore, and sources`);
        return;
      }
      if (!RUBRIC_IDS.includes(required.rubric) || seen.has(required.rubric)) {
        errors.push(`${prefix}.rubric must be one unique R1-R7 value`);
      }
      seen.add(required.rubric);
      if (![1, 2].includes(required.minScore)) errors.push(`${prefix}.minScore must be 1 or 2`);
      if (!Array.isArray(required.sources) || required.sources.length === 0 || !required.sources.every(validGateSource)) {
        errors.push(`${prefix}.sources must contain exact auditable task sources`);
      }
    });
  }

  if (!Array.isArray(gateFailures) || gateFailures.length > RUBRIC_IDS.length) {
    errors.push(`${label} gateFailures must be an array with at most 7 items`);
  } else {
    const seen = new Set();
    gateFailures.forEach((failure, index) => {
      const prefix = `${label} gateFailures[${index}]`;
      if (!isPlainObject(failure) || !hasExactlyKeys(failure, ["rubric", "minScore", "actualScore", "sources"])) {
        errors.push(`${prefix} must contain exactly rubric, minScore, actualScore, and sources`);
        return;
      }
      if (!RUBRIC_IDS.includes(failure.rubric) || seen.has(failure.rubric)) {
        errors.push(`${prefix}.rubric must be one unique R1-R7 value`);
      }
      seen.add(failure.rubric);
      if (![1, 2].includes(failure.minScore)) errors.push(`${prefix}.minScore must be 1 or 2`);
      if (!Number.isInteger(failure.actualScore) || failure.actualScore < 0 || failure.actualScore > 2) {
        errors.push(`${prefix}.actualScore must be 0, 1, or 2`);
      }
      if (!Array.isArray(failure.sources) || failure.sources.length === 0 || !failure.sources.every(validGateSource)) {
        errors.push(`${prefix}.sources must contain exact auditable task sources`);
      }
    });
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isReviewerInfrastructureError(value) {
  return isPlainObject(value) && value.status === "infrastructure_error";
}

function requireFile(path, label, errors) {
  if (!existsSync(path)) {
    errors.push(`missing Reviewer ${label}: ${path}`);
    return false;
  }
  try {
    if (!statSync(path).isFile()) {
      errors.push(`Reviewer ${label} must be a file: ${path}`);
      return false;
    }
  } catch (error) {
    errors.push(`cannot inspect Reviewer ${label}: ${error.message || error}`);
    return false;
  }
  return true;
}

/**
 * Validate the stamped on-disk verdict and all mandatory B4 artifacts.  The
 * structured return is only accepted when it reports the verdict's exact
 * pass/total; in particular a failed verdict can never be wrapped as success.
 */
export function validateReviewerArtifacts(value, expected) {
  const envelope = validateReviewerReturn(value, expected);
  if (!envelope.ok) return envelope;
  // Child infrastructure failures intentionally stop before a complete scorecard
  // artifact set exists. The parent scan has already succeeded; their strict envelope is the artifact;
  // the parent must terminate this Gate attempt without running quality layout.
  if (isReviewerInfrastructureError(value)) return envelope;

  const errors = [];
  requireFile(expected.resultPath, "result.json", errors);
  const hasScan = requireFile(expected.scanPath, "quality/scan.json", errors);
  const hasReport = requireFile(expected.reportPath, "quality/report.md", errors);
  const hasVerdict = requireFile(expected.verdictPath, "quality/verdict.json", errors);

  let expectedRequiredRubrics = null;
  const tasksPath = join(expected.sessionDir, "analysis", "tasks.json");
  try {
    const tasksDocument = existsSync(tasksPath) ? JSON.parse(readFileSync(tasksPath, "utf8")) : undefined;
    expectedRequiredRubrics = collectRequiredRubrics(tasksDocument);
  } catch (error) {
    errors.push(`cannot derive dynamic gates from analysis/tasks.json: ${error.message || error}`);
  }

  let scanText = "";
  let scanHardIssues = null;
  if (hasScan) {
    try {
      scanText = readFileSync(expected.scanPath, "utf8");
      const scan = JSON.parse(scanText);
      if (!isPlainObject(scan)) {
        errors.push("quality/scan.json must contain one JSON object");
      } else if (!Array.isArray(scan.hardIssues)) {
        errors.push("quality/scan.json hardIssues must be an array");
      } else {
        scanHardIssues = scan.hardIssues;
      }
    } catch (error) {
      errors.push(`cannot read quality/scan.json: ${error.message || error}`);
    }
  }
  if (hasReport) {
    try {
      if (!readFileSync(expected.reportPath, "utf8").trim()) errors.push("quality/report.md must not be empty");
    } catch (error) {
      errors.push(`cannot read quality/report.md: ${error.message || error}`);
    }
  }
  if (hasVerdict) {
    try {
      const verdict = JSON.parse(readFileSync(expected.verdictPath, "utf8"));
      if (!isPlainObject(verdict)) {
        errors.push("quality/verdict.json must contain one JSON object");
      } else {
        if (verdict.producer !== VERDICT_PRODUCER) {
          errors.push(`quality/verdict.json producer must be ${VERDICT_PRODUCER}`);
        }
        if (verdict.draft !== false) errors.push("quality/verdict.json must be a final stamped verdict (draft=false)");
        if (verdict.pass !== value.pass) errors.push("Reviewer return pass must exactly match quality/verdict.json");
        if (verdict.total !== value.total) errors.push("Reviewer return total must exactly match quality/verdict.json");
        if (!sameJson(verdict.requiredRubrics, value.requiredRubrics)) {
          errors.push("Reviewer return requiredRubrics must exactly match quality/verdict.json");
        }
        if (!sameJson(verdict.gateFailures, value.gateFailures)) {
          errors.push("Reviewer return gateFailures must exactly match quality/verdict.json");
        }
        if (verdict.maxTotal !== MAX_TOTAL) errors.push("quality/verdict.json maxTotal must be exactly 14");
        const expectedFingerprint = scanText
          ? createHash("sha256").update(scanText, "utf8").digest("hex")
          : "";
        if (!expectedFingerprint || verdict.scanFingerprint !== expectedFingerprint) {
          errors.push("quality/verdict.json scanFingerprint must match the current quality/scan.json");
        }
        if (verdict.sessionDir !== expected.sessionDir || verdict.scanPath !== "quality/scan.json") {
          errors.push("quality/verdict.json must point to the current SESSION and quality/scan.json");
        }
        validateDynamicAuditShape(
          verdict.requiredRubrics,
          verdict.gateFailures,
          errors,
          "quality/verdict.json"
        );
        if (expectedRequiredRubrics && !sameJson(verdict.requiredRubrics, expectedRequiredRubrics)) {
          errors.push("quality/verdict.json requiredRubrics must be derived from completed current-Session tasks");
        }
        let scoreTotal = 0;
        for (const id of RUBRIC_IDS) {
          const score = verdict.scores?.[id]?.score;
          const max = verdict.scores?.[id]?.max;
          if (!Number.isInteger(score) || score < 0 || score > 2 || max !== 2) {
            errors.push(`quality/verdict.json scores.${id} must be exactly 0, 1, or 2 with max=2`);
          } else {
            scoreTotal += score;
          }
        }
        if (scoreTotal !== verdict.total) errors.push("quality/verdict.json total must equal the R1–R7 score sum");
        const hasHard =
          (Array.isArray(verdict.hardBlockers) && verdict.hardBlockers.length > 0) ||
          (Array.isArray(verdict.issues) && verdict.issues.some((issue) => issue?.severity === "hard"));
        if (hasHard && verdict.pass !== false) errors.push("quality/verdict.json with hard blockers/issues must use pass=false");
        const scanHasHard = Array.isArray(scanHardIssues) && scanHardIssues.length > 0;
        if (scanHasHard && verdict.pass !== false) {
          errors.push("quality/verdict.json must use pass=false when quality/scan.json has hardIssues");
        }
        const scoresValid = RUBRIC_IDS.every((id) => {
          const score = verdict.scores?.[id]?.score;
          return Number.isInteger(score) && score >= 0 && score <= 2 && verdict.scores?.[id]?.max === 2;
        });
        if (scoresValid) {
          let expectedGateFailures = null;
          if (expectedRequiredRubrics) {
            try {
              expectedGateFailures = gateFailuresForScores(expectedRequiredRubrics, verdict.scores);
            } catch (error) {
              errors.push(`cannot recompute dynamic task gates: ${error.message || error}`);
            }
          }
          if (expectedGateFailures && !sameJson(verdict.gateFailures, expectedGateFailures)) {
            errors.push("quality/verdict.json gateFailures must match completed-task targets and stamped scores");
          }
          const formulaPass =
            !hasHard &&
            !scanHasHard &&
            scoreTotal >= 10 &&
            verdict.scores.R1.score >= 1 &&
            verdict.scores.R2.score >= 1 &&
            Array.isArray(expectedGateFailures) &&
            expectedGateFailures.length === 0;
          if (verdict.pass !== formulaPass) {
            errors.push("quality/verdict.json pass must equal the base formula plus all completed-task dynamic rubric gates");
          }
        }
      }
    } catch (error) {
      errors.push(`cannot read quality/verdict.json: ${error.message || error}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Parse one bare JSON document; Markdown fences and acceptance prose fail. */
export function parseReviewerReturnText(text) {
  if (typeof text !== "string") throw new Error("Reviewer return must be text JSON");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Reviewer return must be one JSON object without prose: ${error.message || error}`);
  }
}
