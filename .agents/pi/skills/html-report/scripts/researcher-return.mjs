/**
 * Report Researcher's machine-checkable return and artifact contract.
 *
 * The parent extension derives all paths and the task mode from the persisted
 * SESSION tasks.json.  A Researcher therefore cannot redirect the Editor to a
 * different task/session or turn a non-completion response into a fake done
 * task.  The runtime schema checks the returned envelope; the semantic check
 * below verifies the two completion artifacts against deterministic evidence.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { canonicalizeJson, sanitizeTaskId } from "./prepare-research-evidence.mjs";

const MODES = new Set(["reuse_entry", "new_query"]);
const CONTRAST_CAPABLE_OPERATION_TYPES = new Set([
  "stats",
  "range",
  "subsetStats",
  "compare",
  "compareTopN",
  "groupBy",
  "correlation",
  "quantileBins",
  "jointQuantileBins",
]);
const ANALYSIS_CAPABILITIES = new Set([
  "record",
  "ranking",
  "comparison",
  "distribution",
  "structural_breakdown",
  "joint_tradeoff",
  "association",
  "data_quality",
  "no_data",
]);
const CAPABILITY_VIEW_TYPES = Object.freeze({
  record: new Set(["project", "sort", "topN", "bottomN", "compareTopN"]),
  ranking: new Set(["sort", "topN", "bottomN", "compareTopN"]),
  comparison: new Set(["compare", "compareTopN"]),
  distribution: new Set(["stats", "range", "subsetStats"]),
  structural_breakdown: new Set(["groupBy", "quantileBins", "jointQuantileBins"]),
  joint_tradeoff: new Set(["jointQuantileBins"]),
  association: new Set(["correlation"]),
  data_quality: new Set([
    "project", "sort", "topN", "bottomN", "stats", "range", "subsetStats",
    "compare", "compareTopN", "groupBy", "correlation", "quantileBins", "jointQuantileBins",
  ]),
  no_data: new Set(["project"]),
});
export const RESEARCHER_RETURN_LIMITS = Object.freeze({
  analysisRequirements: 8,
  findings: 12,
  findingPointers: 6,
  evidencePointers: 24,
  claimCharacters: 2400,
  summaryCharacters: 2400,
  suggestedDeeperItems: 3,
});
const MAX_ANALYSIS_REQUIREMENTS = RESEARCHER_RETURN_LIMITS.analysisRequirements;
const MAX_FINDINGS = RESEARCHER_RETURN_LIMITS.findings;
const MAX_FINDING_POINTERS = RESEARCHER_RETURN_LIMITS.findingPointers;
const MAX_EVIDENCE_POINTERS = RESEARCHER_RETURN_LIMITS.evidencePointers;
export const ANALYSIS_CONTRACT_VERSION = 1;
const NEW_QUERY_GAP_TYPES = [
  "missing_indicator",
  "missing_dimension",
  "missing_granularity",
  "missing_range",
  "missing_scope",
  "missing_comparison",
  "metric_definition",
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyUniqueStrings(value) {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim()) &&
    new Set(value).size === value.length;
}

/**
 * Validate the optional, business-agnostic analysis contract authored by the
 * Editor. Legacy tasks omit analysisRequirements (or use an empty array) and
 * keep the original Researcher return shape.
 */
export function validateResearcherAnalysisRequirements(task) {
  const errors = [];
  const hasContractVersion = isPlainObject(task) &&
    Object.prototype.hasOwnProperty.call(task, "analysisContractVersion");
  const contractVersion = hasContractVersion ? task.analysisContractVersion : null;
  if (hasContractVersion && contractVersion !== ANALYSIS_CONTRACT_VERSION) {
    errors.push(`analysisContractVersion must be exactly ${ANALYSIS_CONTRACT_VERSION}`);
  }
  const requiresStructuredAnalysis = contractVersion === ANALYSIS_CONTRACT_VERSION;
  const raw = task?.analysisRequirements;
  if (raw == null) {
    if (requiresStructuredAnalysis) {
      errors.push("analysisRequirements must be a non-empty array for the current analysis contract");
    }
    return { ok: errors.length === 0, errors, requirements: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      errors: [...errors, "analysisRequirements must be an array when present"],
      requirements: [],
    };
  }
  if (requiresStructuredAnalysis && raw.length === 0) {
    errors.push("analysisRequirements must be a non-empty array for the current analysis contract");
  }
  if (raw.length > MAX_ANALYSIS_REQUIREMENTS) {
    errors.push(`analysisRequirements must contain at most ${MAX_ANALYSIS_REQUIREMENTS} items`);
  }

  const requirements = [];
  const ids = new Set();
  const operationById = new Map(
    (Array.isArray(task?.evidencePlan?.operations) ? task.evidencePlan.operations : [])
      .filter((operation) => isPlainObject(operation) && typeof operation.id === "string" && operation.id)
      .map((operation) => [operation.id, operation])
  );
  for (const [index, requirement] of raw.entries()) {
    const label = `analysisRequirements[${index}]`;
    if (!isPlainObject(requirement)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const allowedKeys = ["id", "question", "capability", "evidenceViewIds", "targetRubric", "minScore"];
    if (Object.keys(requirement).some((key) => !allowedKeys.includes(key)) ||
      !["id", "question", "evidenceViewIds", "targetRubric"].every((key) => key in requirement)) {
      errors.push(`${label} must contain id, question, evidenceViewIds, targetRubric, and optional minScore only`);
    }
    const id = typeof requirement.id === "string" ? requirement.id.trim() : "";
    if (!id) errors.push(`${label}.id must be a non-empty string`);
    else if (ids.has(id)) errors.push(`analysisRequirements id must be unique: ${id}`);
    else ids.add(id);
    if (typeof requirement.question !== "string" || !requirement.question.trim()) {
      errors.push(`${label}.question must be a non-empty string`);
    }
    if (
      Object.prototype.hasOwnProperty.call(requirement, "capability") &&
      !ANALYSIS_CAPABILITIES.has(requirement.capability)
    ) {
      errors.push(`${label}.capability must be a supported generic analysis capability when present`);
    }
    if (!nonEmptyUniqueStrings(requirement.evidenceViewIds)) {
      errors.push(`${label}.evidenceViewIds must be a non-empty unique string array`);
    } else if (requirement.evidenceViewIds.length > MAX_FINDING_POINTERS) {
      errors.push(`${label}.evidenceViewIds must contain at most ${MAX_FINDING_POINTERS} items`);
    } else {
      for (const viewId of requirement.evidenceViewIds) {
        if (!operationById.has(viewId)) {
          errors.push(`${label}.evidenceViewIds references unknown evidencePlan operation: ${viewId}`);
        }
      }
      if (ANALYSIS_CAPABILITIES.has(requirement.capability)) {
        const allowedTypes = CAPABILITY_VIEW_TYPES[requirement.capability];
        const referenced = requirement.evidenceViewIds
          .map((viewId) => operationById.get(viewId))
          .filter(Boolean);
        if (!referenced.some((operation) => allowedTypes.has(operation.type))) {
          errors.push(`${label}.capability=${requirement.capability} is not supported by its evidence views`);
        }
      }
    }
    if (
      !nonEmptyUniqueStrings(requirement.targetRubric) ||
      requirement.targetRubric.some((rubric) => !/^R[1-7]$/.test(rubric))
    ) {
      errors.push(`${label}.targetRubric must be a non-empty unique array containing only R1-R7`);
    }
    if (
      Object.prototype.hasOwnProperty.call(requirement, "minScore") &&
      ![1, 2].includes(requirement.minScore)
    ) {
      errors.push(`${label}.minScore must be 1 or 2 when present`);
    }
    requirements.push(requirement);
  }
  return { ok: errors.length === 0, errors, requirements };
}

/**
 * Decide whether a persisted task promises contrast/breakdown evidence from
 * the deterministic operation types bound by each typed requirement. The
 * Editor-only capability is intentionally not persisted. A fully legacy task
 * keeps the historical non-empty-evidence requirement.
 */
export function researcherContrastPolicy(task) {
  const checked = validateResearcherAnalysisRequirements(task);
  if (!checked.ok) return { ok: false, errors: checked.errors, required: false };
  if (checked.requirements.length === 0) {
    return { ok: true, errors: [], required: true, source: "legacy" };
  }
  const operationById = new Map(
    (Array.isArray(task?.evidencePlan?.operations) ? task.evidencePlan.operations : [])
      .filter((operation) => isPlainObject(operation) && typeof operation.id === "string")
      .map((operation) => [operation.id, operation])
  );
  const required = checked.requirements.some((requirement) =>
    requirement.evidenceViewIds.some((viewId) =>
      CONTRAST_CAPABLE_OPERATION_TYPES.has(operationById.get(viewId)?.type)
    )
  );
  return { ok: true, errors: [], required, source: "typed" };
}

function expectedAnalysisRequirements(expected) {
  const task = isPlainObject(expected?.task)
    ? expected.task
    : { analysisRequirements: expected?.analysisRequirements };
  return validateResearcherAnalysisRequirements(task);
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function lineValue(task, labelPattern) {
  const match = String(task || "").match(new RegExp(`^${labelPattern}\\s*[:=]\\s*(?:\"([^\"]+)\"|'([^']+)'|([^\\s]+))\\s*$`, "m"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function canonicalAbsolute(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && !value.includes("\0");
}

function assignedTaskObject(task) {
  const prompt = String(task || "");
  const label = "完整 task 对象:";
  const labelIndex = prompt.indexOf(label);
  const start = labelIndex >= 0 ? prompt.indexOf("{", labelIndex + label.length) : -1;
  if (start < 0) return { error: "Report Researcher task 必须包含完整 task 对象 JSON。" };
  let depth = 0;
  let inString = false;
  let escaped = false;
  let jsonText = "";
  for (let index = start; index < prompt.length; index += 1) {
    const char = prompt[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        jsonText = prompt.slice(start, index + 1);
        break;
      }
    }
  }
  if (!jsonText) return { error: "Report Researcher 完整 task 对象 JSON 不完整。" };
  try {
    const value = JSON.parse(jsonText);
    return isPlainObject(value) ? { value } : { error: "Report Researcher 完整 task 对象必须是 JSON object。" };
  } catch (error) {
    return { error: `Report Researcher 完整 task 对象不是合法 JSON：${error.message || error}` };
  }
}

export function researcherReturnPaths({ sessionDir, taskId }) {
  if (!sessionDir || !isAbsolute(sessionDir)) throw new Error("sessionDir must be an absolute path");
  const rawTaskId = String(taskId || "");
  const safeTaskId = sanitizeTaskId(rawTaskId);
  if (!rawTaskId || safeTaskId === "." || safeTaskId === "..") {
    throw new Error("taskId must be a non-empty safe path segment");
  }
  const session = resolve(sessionDir);
  return {
    taskId: rawTaskId,
    safeTaskId,
    sessionDir: session,
    resultPath: join(session, "result.json"),
    tasksPath: join(session, "analysis", "tasks.json"),
    evidencePath: join(session, "analysis", "evidence", `${safeTaskId}.json`),
    sectionPath: join(session, "analysis", "sections", `explore-${safeTaskId}.md`),
    summaryPath: join(session, "analysis", "sections", `explore-${safeTaskId}.summary.json`),
    explorePayloadPath: join(session, "data", "explore", `${safeTaskId}.payload.json`),
  };
}

/**
 * Resolve an assignment only from the current html-report SESSION and its
 * persisted tasks.json.  The task JSON embedded in the prompt must be an exact
 * copy; it is context for the child, never an authority that can change mode.
 */
export function researcherExpectedFromAssignment(taskText, { sessionDir } = {}) {
  if (!sessionDir || !isAbsolute(sessionDir)) return { error: "当前 html-report SESSION 绝对路径缺失。" };
  const taskId = lineValue(taskText, "(?:按 report-researcher 处理 )?taskId");
  const assignedSession = lineValue(taskText, "SESSION");
  const assignedResult = lineValue(taskText, "result\\.json");
  const assignedEvidence = lineValue(taskText, "evidencePath(?:（reuse_entry）)?");
  if (!taskId || !assignedSession || !assignedResult || !assignedEvidence) {
    return { error: "Report Researcher task 必须包含 taskId、SESSION、result.json 与 evidencePath 的绝对路径。" };
  }
  if (![assignedSession, assignedResult, assignedEvidence].every(canonicalAbsolute)) {
    return { error: "Report Researcher task 的 SESSION/result.json/evidencePath 必须是无 dot-segment 的规范绝对路径。" };
  }

  let paths;
  try {
    paths = researcherReturnPaths({ sessionDir, taskId });
  } catch (error) {
    return { error: `无法建立 Report Researcher 路径契约：${error.message || error}` };
  }
  if (
    resolve(assignedSession) !== paths.sessionDir ||
    resolve(assignedResult) !== paths.resultPath ||
    resolve(assignedEvidence) !== paths.evidencePath
  ) {
    return { error: "Report Researcher task 的 SESSION/result.json/evidencePath 必须属于当前任务的固定路径。" };
  }
  if (!inside(paths.sessionDir, paths.sectionPath) || !inside(paths.sessionDir, paths.summaryPath)) {
    return { error: "Report Researcher 产物路径越出当前 SESSION。" };
  }

  let tasksDocument;
  try {
    tasksDocument = JSON.parse(readFileSync(paths.tasksPath, "utf8"));
  } catch (error) {
    return { error: `无法读取当前 SESSION 的 analysis/tasks.json：${error.message || error}` };
  }
  const tasks = Array.isArray(tasksDocument?.tasks) ? tasksDocument.tasks : [];
  const matches = tasks.filter((candidate) => String(candidate?.id) === taskId);
  if (matches.length !== 1) return { error: `analysis/tasks.json 必须恰好包含一个 taskId=${taskId}。` };
  const persistedTask = matches[0];
  const mode = persistedTask?.evidencePlan?.mode;
  if (!MODES.has(mode)) return { error: `task ${taskId} evidencePlan.mode 不合法。` };
  if (!["pending", "running"].includes(persistedTask.status)) {
    return { error: `task ${taskId} 当前 status=${JSON.stringify(persistedTask.status)}，不能重复派发 Researcher。` };
  }

  const requirements = validateResearcherAnalysisRequirements(persistedTask);
  if (!requirements.ok) {
    return { error: `task ${taskId} analysisRequirements 不合法：${requirements.errors.join("；")}` };
  }

  const embedded = assignedTaskObject(taskText);
  if (embedded.error) return embedded;
  if (canonicalizeJson(embedded.value) !== canonicalizeJson(persistedTask)) {
    return { error: `Report Researcher prompt 中的完整 task 对象与 analysis/tasks.json 的 task ${taskId} 不一致。` };
  }
  return { ...paths, mode, task: persistedTask, analysisRequirements: requirements.requirements };
}

function stringArraySchema({ minItems = 0, maxItems = 20 } = {}) {
  return {
    type: "array",
    minItems,
    maxItems,
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
  };
}

function fieldMismatchGapSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: "field_mismatch" },
      reason: { const: "EVIDENCE_FIELD_MISMATCH" },
      availableFields: stringArraySchema(),
      missingFields: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            field: { type: "string", minLength: 1 },
            references: stringArraySchema({ minItems: 1 }),
          },
          required: ["field", "references"],
        },
      },
    },
    required: ["type", "reason", "availableFields", "missingFields"],
  };
}

function missingOperationGapSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { const: "missing_operation" },
      reason: { type: "string", minLength: 1 },
      requiredOperations: { type: "array", minItems: 1, maxItems: 12, items: { type: "object" } },
    },
    required: ["type", "reason", "requiredOperations"],
  };
}

function newQueryGapSchema() {
  const common = {
    reason: { type: "string", minLength: 1 },
    requiredIndicators: stringArraySchema(),
    requiredDims: stringArraySchema(),
  };
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: { ...common, type: { enum: NEW_QUERY_GAP_TYPES } },
        required: ["type", "reason"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...common,
          types: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { enum: NEW_QUERY_GAP_TYPES },
          },
        },
        required: ["types", "reason"],
      },
    ],
  };
}

export function buildResearcherReturnSchema(expected) {
  if (!expected?.taskId || !MODES.has(expected.mode)) throw new Error("taskId and mode are required");
  for (const path of [expected.evidencePath, expected.sectionPath, expected.summaryPath]) {
    if (!path || !isAbsolute(path)) throw new Error("Researcher return paths must be absolute");
  }
  const base = {
    taskId: { const: String(expected.taskId) },
    evidenceModeUsed: { const: expected.mode },
  };
  const requirementsCheck = expectedAnalysisRequirements(expected);
  if (!requirementsCheck.ok) {
    throw new Error(`invalid analysisRequirements: ${requirementsCheck.errors.join("; ")}`);
  }
  const requirements = requirementsCheck.requirements;
  const findingsSchema = {
    type: "array",
    minItems: requirements.length,
    maxItems: MAX_FINDINGS,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        requirementId: { enum: requirements.map((requirement) => requirement.id) },
        claim: {
          type: "string",
          minLength: 1,
          maxLength: RESEARCHER_RETURN_LIMITS.claimCharacters,
        },
        evidencePointers: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FINDING_POINTERS,
          uniqueItems: true,
          items: { type: "string", pattern: "^/views/" },
        },
      },
      required: ["requirementId", "claim", "evidencePointers"],
    },
  };
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...base,
          status: { const: "ok" },
          evidencePath: { const: expected.evidencePath },
          sectionPath: { const: expected.sectionPath },
          summaryPath: { const: expected.summaryPath },
          summary: {
            type: "string",
            minLength: 1,
            maxLength: RESEARCHER_RETURN_LIMITS.summaryCharacters,
          },
          noData: { type: "boolean" },
          evidencePointers: {
            type: "array",
            minItems: 1,
            maxItems: MAX_EVIDENCE_POINTERS,
            uniqueItems: true,
            items: { type: "string", pattern: "^/views/" },
          },
          ...(requirements.length ? { findings: findingsSchema } : {}),
          selfCheck: {
            type: "object",
            additionalProperties: false,
            properties: {
              modeCompliant: { const: true },
              evidenceTraceable: { const: true },
              hasContrastOrBreakdown: { type: "boolean" },
              answersGoal: { const: true },
              queryJustified: { const: expected.mode === "new_query" ? true : null },
            },
            required: ["modeCompliant", "evidenceTraceable", "hasContrastOrBreakdown", "answersGoal", "queryJustified"],
          },
          suggestedDeeper: stringArraySchema({
            maxItems: RESEARCHER_RETURN_LIMITS.suggestedDeeperItems,
          }),
        },
        required: [
          "taskId", "status", "evidenceModeUsed", "evidencePath", "sectionPath",
          "summaryPath", "summary", "noData", "evidencePointers",
          ...(requirements.length ? ["findings"] : []),
          "selfCheck", "suggestedDeeper",
        ],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...base,
          status: { const: "needs_evidence_plan" },
          evidenceGap: { oneOf: [fieldMismatchGapSchema(), missingOperationGapSchema()] },
        },
        required: ["taskId", "status", "evidenceModeUsed", "evidenceGap"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...base,
          status: { const: "needs_new_query" },
          evidenceGap: newQueryGapSchema(),
        },
        required: ["taskId", "status", "evidenceModeUsed", "evidenceGap"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...base,
          status: { const: "failed" },
          error: { type: "string", minLength: 1 },
        },
        required: ["taskId", "status", "evidenceModeUsed", "error"],
      },
    ],
  };
}

export function resolveJsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return undefined;
  let current = document;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function numericValues(value, out = []) {
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?%?$/.test(trimmed)) out.push(Number(trimmed.replace(/%$/, "")));
    // Dates and other deterministic scalar labels may contain multiple
    // numeric components; those components are scope/evidence too.
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(trimmed)) {
      for (const token of trimmed.match(/\d+/g) || []) out.push(Number(token));
    }
  } else if (Array.isArray(value)) {
    for (const item of value) numericValues(item, out);
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) numericValues(item, out);
  }
  return out;
}

function stripNonClaims(text) {
  return String(text || "")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/`\/views[^`]*`/g, " ")
    .replace(/\/views\/[^\s`]+/gu, " ")
    .replace(/^\s*\d+[.)、]\s+/gm, "");
}

function numericClaims(text) {
  const normalized = stripNonClaims(text);
  const out = [];
  const pattern = /(?<![A-Za-z0-9_.-])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g;
  for (const match of normalized.matchAll(pattern)) {
    const raw = match[0];
    const value = Number(raw.replace(/,/g, "").replace(/%$/, ""));
    if (Number.isFinite(value)) out.push({ raw, value });
  }
  return out;
}

function exactNumericMatch(value, candidates) {
  return candidates.some((candidate) => Object.is(candidate, value) || Math.abs(candidate - value) < 1e-9);
}

function hasUnqualifiedTerm(text, pattern) {
  const source = String(text || "");
  for (const match of source.matchAll(pattern)) {
    const prefix = source.slice(Math.max(0, match.index - 12), match.index);
    if (!/(?:不|未|无|非|无法|不能|不足以|不可|尚不能|并非)(?:代表|证明|说明|推断|建立|支持)?\s*$/u.test(prefix)) {
      return true;
    }
  }
  return false;
}

function semanticProofInValue(value, kind) {
  if (Array.isArray(value)) return value.some((item) => semanticProofInValue(item, kind));
  if (!isPlainObject(value)) return false;
  const patterns = {
    significance: /^(?:p[_-]?value|significant|significance|confidence[_-]?interval)$/i,
    causality: /(?:causal|randomi[sz]ed|treatment[_-]?effect|counterfactual|experiment[_-]?design)/i,
    universal: /(?:global[_-]?optimum|universal[_-]?threshold|exhaustive[_-]?optimum)/i,
  };
  for (const [key, item] of Object.entries(value)) {
    if (patterns[kind].test(key)) {
      if (typeof item === "boolean" ? item : item != null && item !== "") return true;
    }
    if (semanticProofInValue(item, kind)) return true;
  }
  return false;
}

function correlationPopulationSizes(value, sizes = []) {
  if (Array.isArray(value)) {
    for (const item of value) correlationPopulationSizes(item, sizes);
    return sizes;
  }
  if (!isPlainObject(value)) return sizes;
  if (value.type === "correlation" && isPlainObject(value.correlations)) {
    for (const item of Object.values(value.correlations)) {
      if (!isPlainObject(item)) continue;
      if (Number.isSafeInteger(item.eligibleRows)) sizes.push(item.eligibleRows);
      if (item.zeroValueSensitivity?.applied === true && Number.isSafeInteger(item.zeroValueSensitivity.eligibleRows)) {
        sizes.push(item.zeroValueSensitivity.eligibleRows);
      }
    }
    return sizes;
  }
  for (const item of Object.values(value)) correlationPopulationSizes(item, sizes);
  return sizes;
}

function validateSemanticClaimSafety(text, citedNodes, errors, label = "Researcher prose") {
  const nodes = Array.isArray(citedNodes) ? citedNodes : [];
  if (
    hasUnqualifiedTerm(text, /显著|statistically\s+significant/giu) &&
    !nodes.some((node) => semanticProofInValue(node, "significance"))
  ) {
    errors.push(`${label} claims significance without cited significance evidence`);
  }
  if (
    hasUnqualifiedTerm(
      text,
      /导致|证明|必然|因果|核心驱动|驱动因素|核心因素|推高|拉动|影响(?:力)?(?:远?大于|更大|更强|较大|强于|弱于)|caus(?:e|al)|prove[sd]?/giu
    ) &&
    !nodes.some((node) => semanticProofInValue(node, "causality"))
  ) {
    errors.push(`${label} claims causality without cited causal evidence`);
  }
  if (
    hasUnqualifiedTerm(text, /全局最优|全月最优|普适阈值|global\s+optimum|universal\s+threshold/giu) &&
    !nodes.some((node) => semanticProofInValue(node, "universal"))
  ) {
    errors.push(`${label} claims a global optimum or universal threshold without cited proof`);
  }
  if (
    hasUnqualifiedTerm(text, /相关(?:性|关系)?|correlat(?:ion|ed|es?)/giu) &&
    !/(?:样本|sample)/iu.test(String(text || ""))
  ) {
    errors.push(`${label} must qualify correlation as sample-scoped`);
  }
  const populationSizes = nodes.flatMap((node) => correlationPopulationSizes(node));
  if (
    new Set(populationSizes).size > 1 &&
    /(?:上述|全部|所有|异常(?:样本|记录|行)?).{0,8}(?:已)?(?:排除|剔除|删除)/u.test(String(text || ""))
  ) {
    errors.push(`${label} uses a blanket exclusion claim although cited calculations have different populations`);
  }
}

function markdownTableLines(section) {
  const lines = String(section || "").split(/\r?\n/);
  const found = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("|") && trimmed.endsWith("|") && (trimmed.match(/\|/g) || []).length >= 3;
  });
  // GFM also accepts a table without outer pipes. Its delimiter row is the
  // reliable signature, so `A | B\n--- | ---` must be rejected as well.
  for (let index = 1; index < lines.length; index += 1) {
    const delimiter = lines[index].trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = delimiter.split("|").map((cell) => cell.trim());
    if (
      cells.length >= 2 &&
      cells.every((cell) => /^:?-{3,}:?$/.test(cell)) &&
      lines[index - 1].includes("|")
    ) {
      found.push(lines[index - 1], lines[index]);
    }
  }
  return [...new Set(found)];
}

/**
 * Extract the compact `/views/...` JSON Pointers that Researcher prose cites.
 * This intentionally excludes surrounding Markdown punctuation/backticks so
 * the same result can be resolved against the evidence packet directly.
 */
export function extractResearcherEvidencePointers(text) {
  const raw = String(text || "").match(/\/views\/[^\s`]+/gu) || [];
  return [...new Set(raw.map((pointer) =>
    pointer.replace(/[),.;:!?，。；：！？]+$/gu, "")
  ).filter(Boolean))];
}

function pointerViewId(pointer) {
  if (typeof pointer !== "string") return null;
  const parts = pointer.split("/");
  if (parts.length < 3 || parts[0] !== "" || parts[1] !== "views") return null;
  return parts[2].replace(/~1/g, "/").replace(/~0/g, "~");
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function numericStat(value) {
  return isPlainObject(value) && nonNegativeInteger(value.count) &&
    nonNegativeInteger(value.numericCount);
}

function statsMap(value) {
  return isPlainObject(value) && Object.values(value).some(numericStat);
}

/** Require the deterministic shape produced for the assigned operation. */
function machineViewMatchesOperation(operation, view) {
  if (!isPlainObject(operation) || !isPlainObject(view) || view.type !== operation.type) return false;
  switch (operation.type) {
    case "project":
    case "sort":
    case "topN":
    case "bottomN":
      return nonNegativeInteger(view.matchedRows) && nonNegativeInteger(view.returnedRows) &&
        Array.isArray(view.rows);
    case "stats":
    case "range":
      return nonNegativeInteger(view.matchedRows) && statsMap(view.stats);
    case "subsetStats":
      return isPlainObject(view.population) && nonNegativeInteger(view.population.selectedCount) &&
        statsMap(view.selectedStats);
    case "compare":
    case "compareTopN":
      return isPlainObject(view.population) && nonNegativeInteger(view.population.selectedCount) &&
        nonNegativeInteger(view.population.remainingCount) && statsMap(view.selectedStats) &&
        statsMap(view.remainingStats);
    case "groupBy":
      return nonNegativeInteger(view.groupCount) && Array.isArray(view.groups);
    case "correlation":
      return isPlainObject(view.population) && nonNegativeInteger(view.population.matchedRows) &&
        isPlainObject(view.correlations);
    case "quantileBins":
      return isPlainObject(view.population) && nonNegativeInteger(view.population.matchedRows) &&
        isPlainObject(view.grids);
    case "jointQuantileBins":
      return isPlainObject(view.grid) && nonNegativeInteger(view.grid.observedCellCount) &&
        Array.isArray(view.grid.cells) && isPlainObject(view.evaluation);
    default:
      return false;
  }
}

function machineViewHasContrastOrBreakdown(operation, view) {
  if (!machineViewMatchesOperation(operation, view)) return false;
  if (["stats", "range"].includes(operation.type)) {
    return Object.values(view.stats).some((stat) => numericStat(stat) && stat.numericCount > 0);
  }
  if (operation.type === "subsetStats") {
    return view.population.selectedCount > 0 &&
      Object.values(view.selectedStats).some((stat) => numericStat(stat) && stat.numericCount > 0);
  }
  if (["compare", "compareTopN"].includes(operation.type)) {
    if (view.population.selectedCount <= 0 || view.population.remainingCount <= 0) return false;
    return Object.keys(view.selectedStats).some((field) =>
      numericStat(view.selectedStats[field]) && view.selectedStats[field].numericCount > 0 &&
      numericStat(view.remainingStats[field]) && view.remainingStats[field].numericCount > 0
    );
  }
  if (operation.type === "groupBy") {
    return view.groups.filter((group) => isPlainObject(group) && nonNegativeInteger(group.rowCount) &&
      group.rowCount > 0 && statsMap(group.stats)).length >= 2;
  }
  if (operation.type === "correlation") {
    return Object.values(view.correlations).some((item) =>
      isPlainObject(item) && item.status === "ok" && Number.isFinite(item.coefficient) &&
      Number.isSafeInteger(item.eligibleRows) && item.eligibleRows >= 2
    );
  }
  if (operation.type === "quantileBins") {
    return Object.values(view.grids).some((grid) => isPlainObject(grid) &&
      nonNegativeInteger(grid.actualBinCount) && grid.actualBinCount >= 2 &&
      Array.isArray(grid.bins) && grid.bins.filter((bin) =>
        isPlainObject(bin) && nonNegativeInteger(bin.rowCount) && bin.rowCount > 0 &&
        numericStat(bin.targetStats) && bin.targetStats.numericCount > 0
      ).length >= 2);
  }
  if (operation.type === "jointQuantileBins") {
    return view.grid.observedCellCount >= 2 && view.grid.cells.filter((cell) =>
      isPlainObject(cell) && nonNegativeInteger(cell.rowCount) && cell.rowCount > 0 &&
      numericStat(cell.targetStats) && cell.targetStats.numericCount > 0
    ).length >= 2;
  }
  return false;
}

const NON_FACT_STRING_KEYS = new Set([
  "type",
  "method",
  "status",
  "direction",
  "scope",
  "policy",
  "reason",
  "sourcePointer",
  "targetField",
  "groupField",
  "sortBy",
  "rule",
  "rationale",
]);

function scalarTextFacts(value, out = [], key = "") {
  if (typeof value === "string") {
    const fact = value.trim();
    if (
      fact &&
      fact.length <= 200 &&
      !NON_FACT_STRING_KEYS.has(key) &&
      !/^-?\d+(?:\.\d+)?%?$/.test(fact)
    ) out.push(fact);
  } else if (Array.isArray(value)) {
    for (const item of value) scalarTextFacts(item, out, key);
  } else if (isPlainObject(value)) {
    for (const [childKey, item] of Object.entries(value)) scalarTextFacts(item, out, childKey);
  }
  return out;
}

function matchedFactKeys(claim, node) {
  const keys = new Set();
  const numbers = numericClaims(claim);
  for (const candidate of numericValues(node, [])) {
    if (numbers.some((item) => Math.abs(item.value - candidate) < 1e-9)) {
      keys.add(`number:${candidate}`);
    }
  }
  for (const fact of scalarTextFacts(node, [])) {
    if (claim.includes(fact)) keys.add(`text:${fact}`);
  }
  return keys;
}

function unionFactKeys(claim, nodes) {
  const keys = new Set();
  for (const node of nodes) {
    for (const key of matchedFactKeys(claim, node)) keys.add(key);
  }
  return keys;
}

function hasDistinctClaimFacts(claim, nodes, minimum = 1) {
  return unionFactKeys(claim, nodes).size >= minimum;
}

function structuralUnits(view) {
  if (!isPlainObject(view)) return [];
  if (view.type === "groupBy") return Array.isArray(view.groups) ? view.groups : [];
  if (view.type === "quantileBins") {
    return Object.values(isPlainObject(view.grids) ? view.grids : {})
      .flatMap((grid) => Array.isArray(grid?.bins) ? grid.bins : []);
  }
  if (view.type === "jointQuantileBins") {
    return Array.isArray(view.grid?.cells) ? view.grid.cells : [];
  }
  return [];
}

function structuralClaimHasTwoUnits(claim, views) {
  const matched = [];
  for (const unit of views.flatMap(structuralUnits)) {
    const keys = matchedFactKeys(claim, unit);
    if (keys.size) matched.push(keys);
  }
  if (matched.length < 2) return false;
  const combined = new Set(matched.flatMap((keys) => [...keys]));
  return combined.size >= 2;
}

function comparisonClaimHasBothSides(claim, views) {
  for (const view of views) {
    if (!isPlainObject(view) || !["compare", "compareTopN"].includes(view.type)) continue;
    const selected = unionFactKeys(claim, [view.selectedStats, view.population?.selectedCount]);
    const remaining = unionFactKeys(claim, [view.remainingStats, view.population?.remainingCount]);
    if (selected.size && remaining.size && new Set([...selected, ...remaining]).size >= 2) return true;
  }
  return structuralClaimHasTwoUnits(claim, views);
}

function associationClaimHasCoefficientAndPopulation(claim, views) {
  for (const view of views) {
    if (!isPlainObject(view) || view.type !== "correlation" || !isPlainObject(view.correlations)) continue;
    for (const item of Object.values(view.correlations)) {
      if (!isPlainObject(item) || item.status !== "ok" || !Number.isFinite(item.coefficient) ||
          !Number.isSafeInteger(item.eligibleRows)) continue;
      if (
        matchedFactKeys(claim, item.coefficient).size &&
        matchedFactKeys(claim, item.eligibleRows).size
      ) return true;
    }
  }
  return false;
}

function jointTradeoffClaimHasCandidateAndSupport(claim, views) {
  for (const view of views) {
    if (!isPlainObject(view) || view.type !== "jointQuantileBins") continue;
    const winnerIds = new Set([
      ...(Array.isArray(view.evaluation?.bestObservedByMean?.cellIds)
        ? view.evaluation.bestObservedByMean.cellIds
        : []),
      ...(Array.isArray(view.evaluation?.bestObservedByMedian?.cellIds)
        ? view.evaluation.bestObservedByMedian.cellIds
        : []),
    ]);
    const candidateCells = (Array.isArray(view.grid?.cells) ? view.grid.cells : [])
      .filter((cell) => isPlainObject(cell) && winnerIds.has(cell.cellId));
    const supportMinimum = view.evaluation?.support?.minimumCellRowCount;
    if (!Number.isSafeInteger(supportMinimum)) continue;
    for (const cell of candidateCells) {
      const candidateFacts = unionFactKeys(claim, [cell.cellId, cell.coordinates, cell.targetStats]);
      const rowCountFacts = matchedFactKeys(claim, cell.rowCount);
      const supportFacts = matchedFactKeys(claim, supportMinimum);
      if (
        candidateFacts.size && rowCountFacts.size && supportFacts.size &&
        new Set([...candidateFacts, ...rowCountFacts, ...supportFacts]).size >= 3
      ) return true;
    }
  }
  return false;
}

function capabilityFactRoleCheck(capability, claim, citedViews, citedNodes) {
  if (!capability) {
    return { answered: hasDistinctClaimFacts(claim, citedNodes, 1), hasContrastOrBreakdown: null };
  }
  if (capability === "joint_tradeoff") {
    const answered = jointTradeoffClaimHasCandidateAndSupport(claim, citedViews);
    return { answered, hasContrastOrBreakdown: answered };
  }
  if (capability === "structural_breakdown") {
    const answered = structuralClaimHasTwoUnits(claim, citedViews);
    return { answered, hasContrastOrBreakdown: answered };
  }
  if (capability === "comparison") {
    const answered = comparisonClaimHasBothSides(claim, citedViews);
    return { answered, hasContrastOrBreakdown: answered };
  }
  if (capability === "association") {
    const answered = associationClaimHasCoefficientAndPopulation(claim, citedViews);
    return { answered, hasContrastOrBreakdown: answered };
  }
  if (capability === "ranking") {
    return {
      answered: hasDistinctClaimFacts(claim, citedNodes, 2),
      hasContrastOrBreakdown: false,
    };
  }
  if (capability === "distribution") {
    return {
      answered: hasDistinctClaimFacts(claim, citedNodes, 2),
      hasContrastOrBreakdown: citedViews.some((view) =>
        isPlainObject(view) && machineViewHasContrastOrBreakdown(
          { type: view.type },
          view
        )
      ),
    };
  }
  return {
    answered: hasDistinctClaimFacts(claim, citedNodes, 1),
    hasContrastOrBreakdown: false,
  };
}

/**
 * Derive the two semantic self-check flags only from task bindings, operation
 * types, deterministic view shapes, and exact scalar facts in cited nodes.
 * No business vocabulary or question-specific text is interpreted here.
 */
export function deriveResearcherMachineSelfCheck(expected, evidence, findings) {
  const requirementsCheck = expectedAnalysisRequirements(expected);
  const requirements = requirementsCheck.ok ? requirementsCheck.requirements : [];
  const operations = new Map(
    (Array.isArray(expected?.task?.evidencePlan?.operations)
      ? expected.task.evidencePlan.operations
      : [])
      .filter((operation) => isPlainObject(operation) && typeof operation.id === "string")
      .map((operation) => [operation.id, operation])
  );
  const findingById = new Map(
    (Array.isArray(findings) ? findings : [])
      .filter((finding) => isPlainObject(finding) && typeof finding.requirementId === "string")
      .map((finding) => [finding.requirementId, finding])
  );
  const checks = requirements.map((requirement) => {
    const finding = findingById.get(requirement.id);
    const claim = typeof finding?.claim === "string" ? finding.claim : "";
    const allowedViews = new Set(requirement.evidenceViewIds);
    const cited = (Array.isArray(finding?.evidencePointers) ? finding.evidencePointers : []).flatMap((pointer) => {
      const viewId = pointerViewId(pointer);
      const operation = viewId && allowedViews.has(viewId) ? operations.get(viewId) : null;
      const view = viewId ? evidence?.views?.[viewId] : null;
      const node = resolveJsonPointer(evidence, pointer);
      if (!operation || !machineViewMatchesOperation(operation, view) || node === undefined) return [];
      return [{ operation, view, node }];
    });
    const roleCheck = capabilityFactRoleCheck(
      requirement.capability,
      claim,
      [...new Set(cited.map((item) => item.view))],
      cited.map((item) => item.node)
    );
    const hasMachineContrast = cited.some((item) =>
      machineViewHasContrastOrBreakdown(item.operation, item.view)
    );
    return {
      requirementId: requirement.id,
      answered: cited.length > 0 && roleCheck.answered,
      hasContrastOrBreakdown: roleCheck.hasContrastOrBreakdown == null
        ? roleCheck.answered && hasMachineContrast
        : roleCheck.hasContrastOrBreakdown && hasMachineContrast,
    };
  });
  return {
    answersGoal: requirements.length > 0 && checks.every((check) => check.answered),
    hasContrastOrBreakdown: evidence?.source?.empty === true
      ? false
      : checks.some((check) => check.hasContrastOrBreakdown),
    unansweredRequirementIds: checks.filter((check) => !check.answered).map((check) => check.requirementId),
  };
}

function validateRequirementFindingsEnvelope(value, expected, errors) {
  const requirementsCheck = expectedAnalysisRequirements(expected);
  if (!requirementsCheck.ok) {
    errors.push(...requirementsCheck.errors);
    return;
  }
  const requirements = requirementsCheck.requirements;
  if (!requirements.length) return;
  if (!Array.isArray(value.findings)) {
    errors.push("findings must be an array when analysisRequirements are present");
    return;
  }
  if (value.findings.length > MAX_FINDINGS) {
    errors.push(`findings must contain at most ${MAX_FINDINGS} items`);
  }

  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const covered = new Set();
  const globalPointers = new Set(Array.isArray(value.evidencePointers) ? value.evidencePointers : []);
  for (const [index, finding] of value.findings.entries()) {
    const label = `findings[${index}]`;
    if (!isPlainObject(finding)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (!hasExactlyKeys(finding, ["requirementId", "claim", "evidencePointers"])) {
      errors.push(`${label} must contain only requirementId, claim, and evidencePointers`);
    }
    const requirement = byId.get(finding.requirementId);
    if (!requirement) {
      errors.push(`${label}.requirementId does not match analysisRequirements`);
      continue;
    }
    covered.add(finding.requirementId);
    if (typeof finding.claim !== "string" || !finding.claim.trim()) {
      errors.push(`${label}.claim must be a non-empty string`);
    }
    if (!nonEmptyUniqueStrings(finding.evidencePointers)) {
      errors.push(`${label}.evidencePointers must be a non-empty unique string array`);
      continue;
    }
    if (finding.evidencePointers.length > MAX_FINDING_POINTERS) {
      errors.push(`${label}.evidencePointers must contain at most ${MAX_FINDING_POINTERS} items`);
    }
    const allowedViews = new Set(requirement.evidenceViewIds);
    for (const pointer of finding.evidencePointers) {
      const viewId = pointerViewId(pointer);
      if (!viewId || !allowedViews.has(viewId)) {
        errors.push(
          `${label} pointer ${JSON.stringify(pointer)} is outside requirement ${finding.requirementId} evidenceViewIds`
        );
      }
      if (!globalPointers.has(pointer)) {
        errors.push(`${label} pointer ${JSON.stringify(pointer)} is missing from top-level evidencePointers`);
      }
    }
  }
  for (const requirement of requirements) {
    if (!covered.has(requirement.id)) {
      errors.push(`analysis requirement is not covered by findings: ${requirement.id}`);
    }
  }
}

function validateRequirementFindingsContent(value, expected, evidence, section, errors) {
  const requirementsCheck = expectedAnalysisRequirements(expected);
  if (!requirementsCheck.ok || !requirementsCheck.requirements.length || !Array.isArray(value.findings)) return;
  const sectionText = String(section || "");
  const claimSummary = value.findings
    .filter((finding) => isPlainObject(finding) && typeof finding.claim === "string")
    .map((finding) => finding.claim.trim())
    .join(" ");
  if (typeof value.summary === "string" && value.summary.trim() !== claimSummary) {
    errors.push("summary must concatenate findings[].claim in order without rewriting or rounding");
  }
  for (const [index, finding] of value.findings.entries()) {
    if (!isPlainObject(finding) || typeof finding.claim !== "string" || !Array.isArray(finding.evidencePointers)) {
      continue;
    }
    const claim = finding.claim.trim();
    if (claim && !sectionText.includes(claim)) {
      errors.push(`section does not contain findings[${index}].claim verbatim`);
    }
    // A requirement finding is narrower than the whole section: every number
    // must be owned by one of this finding's explicit /views/ pointers. Source
    // scope metadata remains available to the legacy/top-level prose check but
    // cannot satisfy a per-finding claim by numeric coincidence.
    const citedValues = [];
    const citedNodes = [];
    for (const pointer of finding.evidencePointers) {
      const node = resolveJsonPointer(evidence, pointer);
      if (node === undefined) {
        errors.push(`findings[${index}] evidence pointer does not resolve: ${pointer}`);
        continue;
      }
      citedNodes.push(node);
      numericValues(node, citedValues);
    }
    const untraceable = numericClaims(claim)
      .filter((numericClaim) => !exactNumericMatch(numericClaim.value, citedValues))
      .map((numericClaim) => numericClaim.raw);
    if (untraceable.length) {
      errors.push(
        `findings[${index}].claim contains numbers absent from its cited evidence: ${[...new Set(untraceable)].join(", ")}`
      );
    }
    validateSemanticClaimSafety(claim, citedNodes, errors, `findings[${index}].claim`);
  }
}

/**
 * Pure preflight for model-authored Researcher completion content.
 *
 * The child guard can call this before either completion artifact is written:
 * - for the section write, omit `summary`/`evidencePointers`; pointers are
 *   extracted from the section itself;
 * - for the summary write, pass the parsed summary object and the previously
 *   accepted section text.
 *
 * No filesystem access occurs here. Only numbers in cited view nodes or the
 * packet's deterministic source query scope may appear in the prose.
 */
export function validateResearcherCompletionContent({
  evidence,
  section,
  summary,
  evidencePointers,
  expected,
} = {}) {
  const errors = [];
  const sectionText = typeof section === "string" ? section : "";
  const summaryText = isPlainObject(summary)
    ? String(summary.summary || "")
    : typeof summary === "string"
      ? summary
      : "";
  const explicitPointers = evidencePointers ?? (isPlainObject(summary) ? summary.evidencePointers : undefined);
  const pointers = explicitPointers == null
    ? extractResearcherEvidencePointers(sectionText)
    : Array.isArray(explicitPointers)
      ? explicitPointers
      : [];

  if (!isPlainObject(evidence)) errors.push("Researcher evidence must be one JSON object");
  if (!sectionText.trim()) errors.push("Researcher section must be non-empty");
  if (markdownTableLines(sectionText).length) {
    errors.push("Researcher section must not contain a Markdown table; assemble-report owns full tables");
  }
  if (!pointers.length) {
    errors.push("Researcher completion must cite at least one /views/ evidence pointer");
  }

  const citedValues = numericValues(evidence?.source?.queryCoverage || {});
  const citedNodes = [];
  for (const pointer of pointers) {
    if (typeof pointer !== "string" || !pointer.startsWith("/views/")) {
      errors.push(`invalid Researcher evidence pointer: ${JSON.stringify(pointer)}`);
      continue;
    }
    const node = resolveJsonPointer(evidence, pointer);
    if (node === undefined) {
      errors.push(`evidence pointer does not resolve: ${pointer}`);
      continue;
    }
    if (!sectionText.includes(pointer)) errors.push(`section does not cite evidence pointer: ${pointer}`);
    citedNodes.push(node);
    numericValues(node, citedValues);
  }

  const claims = [...numericClaims(sectionText), ...numericClaims(summaryText)];
  const untraceable = claims
    .filter((claim) => !exactNumericMatch(claim.value, citedValues))
    .map((claim) => claim.raw);
  if (untraceable.length) {
    errors.push(
      `Researcher prose contains numbers absent from cited deterministic evidence: ${[...new Set(untraceable)].join(", ")}`
    );
  }
  validateSemanticClaimSafety(
    [sectionText, summaryText].filter(Boolean).join("\n"),
    citedNodes,
    errors
  );
  if (isPlainObject(summary) && expected) {
    validateRequirementFindingsContent(summary, expected, evidence, sectionText, errors);
  }
  return { ok: errors.length === 0, errors };
}

function validateGap(value, errors) {
  if (!isPlainObject(value.evidenceGap) || typeof value.evidenceGap.reason !== "string" || !value.evidenceGap.reason.trim()) {
    errors.push(`${value.status} requires a structured evidenceGap with reason`);
  }
}

/** Schema-independent semantic validation used again on captured results. */
export function validateResearcherReturn(value, expected) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["Researcher return must be one JSON object"] };
  if (value.taskId !== String(expected?.taskId)) errors.push("taskId does not match the assigned task");
  if (value.evidenceModeUsed !== expected?.mode) errors.push("evidenceModeUsed does not match tasks.json");
  if (value.status === "ok") {
    const requirementsCheck = expectedAnalysisRequirements(expected);
    const hasRequirements = requirementsCheck.ok && requirementsCheck.requirements.length > 0;
    const keys = [
      "taskId", "status", "evidenceModeUsed", "evidencePath", "sectionPath", "summaryPath",
      "summary", "noData", "evidencePointers", ...(hasRequirements ? ["findings"] : []),
      "selfCheck", "suggestedDeeper",
    ];
    if (!hasExactlyKeys(value, keys)) errors.push("ok Researcher return has unexpected or missing fields");
    for (const key of ["evidencePath", "sectionPath", "summaryPath"]) {
      if (value[key] !== expected?.[key]) errors.push(`${key} does not match this task's contracted path`);
    }
    if (typeof value.summary !== "string" || !value.summary.trim()) errors.push("summary must be non-empty");
    if (!Array.isArray(value.evidencePointers) || !value.evidencePointers.length) {
      errors.push("evidencePointers must be non-empty");
    } else if (value.evidencePointers.some((pointer) => typeof pointer !== "string" || !/^\/views\//.test(pointer))) {
      errors.push("every evidence pointer must start with /views/");
    } else {
      if (value.evidencePointers.length > MAX_EVIDENCE_POINTERS) {
        errors.push(`evidencePointers must contain at most ${MAX_EVIDENCE_POINTERS} items`);
      }
      if (new Set(value.evidencePointers).size !== value.evidencePointers.length) {
        errors.push("evidencePointers must be unique");
      }
    }
    if (!isPlainObject(value.selfCheck) || value.selfCheck.modeCompliant !== true || value.selfCheck.evidenceTraceable !== true || value.selfCheck.answersGoal !== true) {
      errors.push("selfCheck must attest mode, traceability, and goal coverage");
    }
    const expectedQuery = expected?.mode === "new_query" ? true : null;
    if (value.selfCheck?.queryJustified !== expectedQuery) errors.push("selfCheck.queryJustified does not match mode");
    validateRequirementFindingsEnvelope(value, expected, errors);
  } else if (value.status === "needs_evidence_plan" || value.status === "needs_new_query") {
    if (!hasExactlyKeys(value, ["taskId", "status", "evidenceModeUsed", "evidenceGap"])) {
      errors.push(`${value.status} return has unexpected or missing fields`);
    }
    validateGap(value, errors);
  } else if (value.status === "failed") {
    if (!hasExactlyKeys(value, ["taskId", "status", "evidenceModeUsed", "error"])) {
      errors.push("failed Researcher return has unexpected or missing fields");
    }
    if (typeof value.error !== "string" || !value.error.trim()) errors.push("failed return requires error");
  } else {
    errors.push("Researcher status must be ok, needs_evidence_plan, needs_new_query, or failed");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Verify persisted completion artifacts before the parent can mark a task done.
 * Numeric prose must quote a value that exists in one of the cited deterministic
 * views (or source scope metadata); model-side rounding/recalculation is rejected.
 */
export function validateResearcherArtifacts(value, expected) {
  const envelope = validateResearcherReturn(value, expected);
  if (!envelope.ok) return envelope;
  const errors = [];
  const completionPaths = [expected.sectionPath, expected.summaryPath];
  if (value.status !== "ok") {
    for (const path of completionPaths) {
      if (existsSync(path)) errors.push(`${value.status} must not leave completion artifact ${path}`);
    }
    return { ok: errors.length === 0, errors };
  }

  let evidence;
  let persistedSummary;
  let section;
  try {
    evidence = JSON.parse(readFileSync(expected.evidencePath, "utf8"));
    persistedSummary = JSON.parse(readFileSync(expected.summaryPath, "utf8"));
    section = readFileSync(expected.sectionPath, "utf8");
  } catch (error) {
    return { ok: false, errors: [`cannot read Researcher completion artifacts: ${error.message || error}`] };
  }
  if (String(evidence?.taskId) !== String(expected.taskId) || evidence?.evidenceMode !== expected.mode) {
    errors.push("evidence taskId/mode does not match the assignment");
  }
  if (canonicalizeJson(persistedSummary) !== canonicalizeJson(value)) {
    errors.push("summary artifact must exactly equal the structured Researcher return");
  }
  const expectedNoData = evidence?.source?.empty === true;
  if (value.noData !== expectedNoData) errors.push("noData does not match evidence.source.empty");
  const requirementsCheck = expectedAnalysisRequirements(expected);
  if (requirementsCheck.ok && requirementsCheck.requirements.length > 0) {
    const machineSelfCheck = deriveResearcherMachineSelfCheck(expected, evidence, value.findings);
    if (value.selfCheck?.answersGoal !== machineSelfCheck.answersGoal) {
      errors.push("answersGoal does not match requirement-bound machine facts");
    }
    if (value.selfCheck?.hasContrastOrBreakdown !== machineSelfCheck.hasContrastOrBreakdown) {
      errors.push("hasContrastOrBreakdown does not match cited operation/view facts");
    }
  } else if (value.selfCheck?.hasContrastOrBreakdown !== !expectedNoData) {
    errors.push("legacy hasContrastOrBreakdown does not match evidence emptiness");
  }
  const content = validateResearcherCompletionContent({
    evidence,
    section,
    summary: value,
    evidencePointers: value.evidencePointers,
    expected,
  });
  for (const error of content.errors) {
    errors.push(error);
  }
  return { ok: errors.length === 0, errors };
}
