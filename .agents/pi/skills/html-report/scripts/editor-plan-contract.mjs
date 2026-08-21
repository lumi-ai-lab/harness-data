/**
 * Typed, business-agnostic contract for the B2.5 Editor Planner.
 *
 * The Planner decides only semantic gaps, evidence modes, operations and
 * requirement coverage.  This module owns the compact input snapshot, strict
 * schema/semantic validation and deterministic tasks/main compilation.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  EVIDENCE_GAP_TYPES,
  evidenceGapTypes,
  isValidEvidenceGap,
} from "./research-contract.mjs";

export { persistEditorSourceInventory } from "../../../../../packages/html-report-kernel/src/editor/source-inventory-cache.mjs";

export const EDITOR_PLANNER_MARKER = "HTML_REPORT_EDITOR_PLAN_V1";
export const EDITOR_PLAN_VERSION = 1;
export const EDITOR_PLAN_INPUT_VERSION = 1;
export const EDITOR_PLANNER_CACHE_VERSION = 1;
export const EDITOR_PLANNER_CACHE_PRODUCER = "editor-plan-contract.mjs";

const MAX_TASKS = 4;
const MAX_OPERATIONS = 6;
const MAX_REQUIREMENTS = 8;
const MAX_FIELDS = 20;
const MAX_WHERE = 5;
const OPERATION_TYPES = new Set([
  "project",
  "sort",
  "topN",
  "bottomN",
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
const WHERE_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in"]);
const CAPABILITIES = new Set([
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
const NO_OP_COVERAGE_KIND = "empty_source";
const CAPABILITY_OPERATION_TYPES = Object.freeze({
  record: new Set(["project", "sort", "topN", "bottomN", "compareTopN"]),
  ranking: new Set(["sort", "topN", "bottomN", "compareTopN"]),
  comparison: new Set(["compare", "compareTopN"]),
  distribution: new Set(["stats", "range", "subsetStats"]),
  structural_breakdown: new Set(["groupBy", "quantileBins", "jointQuantileBins"]),
  joint_tradeoff: new Set(["jointQuantileBins"]),
  association: new Set(["correlation"]),
  data_quality: OPERATION_TYPES,
  no_data: new Set(["project"]),
});
const CAPABILITY_OPERATION_CONTRACT = Object.entries(CAPABILITY_OPERATION_TYPES)
  .map(([capability, types]) => `${capability}=${[...types].join("|")}`)
  .join("; ");
const CAPABILITY_REQUIRED_RUBRICS = Object.freeze({
  comparison: new Set(["R5"]),
  structural_breakdown: new Set(["R3", "R5"]),
  joint_tradeoff: new Set(["R3", "R5"]),
  association: new Set(["R5"]),
});
const STRUCTURAL_OPERATION_TYPES = new Set(["groupBy", "quantileBins", "jointQuantileBins"]);
const JOINT_TRADEOFF_CUE = /(?:平衡|权衡|取舍|折中|最佳组合|最优组合|trade[-\s]?off|sweet\s+spot|best\s+balance|optimal\s+combination)/iu;
const REQUIRED_RUBRIC_CONTRACT = [
  "comparison=>R5",
  "basic distribution stats/range=>no automatic R3/R5 floor",
  "association=>R5",
  "groupBy/quantileBins/jointQuantileBins=>R3+R5",
  "new_query missing_indicator/metric_definition=>R4",
].join("; ");
const RUBRIC_GLOSSARY = [
  "R1=directly answer the user question",
  "R2=traceable evidence and complete detail",
  "R3=meaningful dimension or structural depth",
  "R4=indicator sufficiency or justified extension",
  "R5=numeric comparison, decomposition, or observed drivers",
  "R6=consistency across claims and evidence",
  "R7=faithfulness to the confirmed scope",
].join("; ");

const OPERATION_KEYS = Object.freeze({
  project: { required: ["id", "type", "fields"], optional: ["count", "where"] },
  sort: { required: ["id", "type", "field", "fields"], optional: ["count", "direction", "where"] },
  topN: { required: ["id", "type", "field", "fields", "count"], optional: ["direction", "where"] },
  bottomN: { required: ["id", "type", "field", "fields", "count"], optional: ["where"] },
  stats: { required: ["id", "type", "fields"], optional: ["where"] },
  range: { required: ["id", "type", "fields"], optional: ["where"] },
  subsetStats: { required: ["id", "type", "sortBy", "fields", "count"], optional: ["direction", "where"] },
  compare: { required: ["id", "type", "sortBy", "fields", "count"], optional: ["direction", "where"] },
  compareTopN: { required: ["id", "type", "sortBy", "fields", "count"], optional: ["direction", "where"] },
  groupBy: { required: ["id", "type", "groupField", "fields"], optional: ["maxGroups", "where"] },
  correlation: { required: ["id", "type", "targetField", "fields"], optional: ["where"] },
  quantileBins: { required: ["id", "type", "targetField", "fields"], optional: ["binCount", "where"] },
  jointQuantileBins: {
    required: ["id", "type", "targetField", "fields", "direction"],
    optional: ["binCount", "where"],
  },
});
const TASK_KEYS = [
  "fromCardId",
  "goal",
  "gap",
  "mode",
  "reason",
  "evidenceGap",
  "candidateIndicators",
  "candidateDims",
  "operations",
  "requirements",
  "successCriteria",
  "hint",
];
const ANSWER_REQUIREMENT_KEYS = ["id", "question", "capability", "coverage"];
const ANSWER_COVERAGE_KEYS = ["kind", "cardId", "findingIndex"];
const OPERATION_KEY_CONTRACT = Object.entries(OPERATION_KEYS)
  .map(([type, keys]) => `${type}=required(${keys.required.join(",")}) optional(${keys.optional.join(",") || "none"})`)
  .join("; ");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message || error}`);
  }
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalAbsolute(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && !value.includes("\0");
}

function atomicWriteJsonSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function editorPlannerCachePaths(resultPath) {
  const absResult = resolve(String(resultPath || ""));
  const sessionDir = dirname(absResult);
  const cacheDir = join(sessionDir, "debug", "editor-planner");
  return {
    sessionDir,
    resultPath: absResult,
    sourceInventoryPath: join(cacheDir, "source-inventory.json"),
    writerReturnsPath: join(cacheDir, "writer-returns.json"),
  };
}

function currentResultSnapshot(resultPath) {
  const raw = readFileSync(resultPath, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`result.json must contain valid JSON: ${error.message || error}`);
  }
  if (!isPlainObject(value) || value.status !== "confirmed" || !Array.isArray(value.cards) || !value.cards.length) {
    throw new Error("result.json must be confirmed and contain a non-empty cards[]");
  }
  return { raw, value, sha256: sha256Text(raw) };
}

export function persistEditorWriterReturn(resultPath, writerReturn) {
  const paths = editorPlannerCachePaths(resultPath);
  const result = currentResultSnapshot(paths.resultPath);
  if (!isPlainObject(writerReturn) || typeof writerReturn.cardId !== "string" || writerReturn.fetchStatus !== "success") {
    throw new Error("Planner cache accepts only a successful validated Writer return");
  }
  const expectedCardIds = new Set(result.value.cards.map((card) => String(card?.id || "")));
  if (!expectedCardIds.has(writerReturn.cardId)) {
    throw new Error(`Writer return cardId=${writerReturn.cardId} is not present in result.json`);
  }
  let cards = {};
  if (existsSync(paths.writerReturnsPath)) {
    const existing = readJson(paths.writerReturnsPath, "Writer Planner cache");
    if (
      isPlainObject(existing) &&
      existing.version === EDITOR_PLANNER_CACHE_VERSION &&
      existing.producer === EDITOR_PLANNER_CACHE_PRODUCER &&
      existing.kind === "writer_returns" &&
      existing.resultPath === paths.resultPath &&
      existing.resultSha256 === result.sha256 &&
      isPlainObject(existing.cards)
    ) {
      cards = existing.cards;
    }
  }
  const document = {
    version: EDITOR_PLANNER_CACHE_VERSION,
    producer: EDITOR_PLANNER_CACHE_PRODUCER,
    kind: "writer_returns",
    resultPath: paths.resultPath,
    resultSha256: result.sha256,
    cards: { ...cards, [writerReturn.cardId]: writerReturn },
  };
  atomicWriteJsonSync(paths.writerReturnsPath, document);
  return paths.writerReturnsPath;
}

function checkedCache(path, kind, resultPath, resultSha256) {
  const document = readJson(path, `${kind} cache`);
  if (
    !isPlainObject(document) ||
    document.version !== EDITOR_PLANNER_CACHE_VERSION ||
    document.producer !== EDITOR_PLANNER_CACHE_PRODUCER ||
    document.kind !== kind ||
    document.resultPath !== resultPath ||
    document.resultSha256 !== resultSha256
  ) {
    throw new Error(`${kind} cache is stale or has an invalid provenance envelope`);
  }
  return document;
}

function compactQueryCoverage(cardQuery) {
  const request = isPlainObject(cardQuery) && isPlainObject(cardQuery.request) ? cardQuery.request : {};
  return {
    metrics: Array.isArray(request.metrics) ? request.metrics : [],
    statisticPolicy: typeof request.statisticPolicy === "string" ? request.statisticPolicy : null,
    dimensions: Array.isArray(request.dimensions) ? request.dimensions : [],
    time: isPlainObject(request.time)
      ? {
          startDate: typeof request.time.startDate === "string" ? request.time.startDate : null,
          endDate: typeof request.time.endDate === "string" ? request.time.endDate : null,
          grain: typeof request.time.grain === "string" ? request.time.grain : null,
        }
      : null,
    filters: isPlainObject(request.filters) ? request.filters : {},
    scopes: isPlainObject(request.scopes) ? request.scopes : null,
    measureFilters: Array.isArray(request.measureFilters) ? request.measureFilters : [],
    comparisons: Array.isArray(cardQuery?.comparisons) ? cardQuery.comparisons : [],
  };
}

/** Load the exact compact context handed to the fresh Planner child. */
export function loadEditorPlannerInput(resultPath) {
  const paths = editorPlannerCachePaths(resultPath);
  const result = currentResultSnapshot(paths.resultPath);
  const inventoryCache = checkedCache(
    paths.sourceInventoryPath,
    "source_inventory",
    paths.resultPath,
    result.sha256
  );
  const writerCache = checkedCache(
    paths.writerReturnsPath,
    "writer_returns",
    paths.resultPath,
    result.sha256
  );
  const inventory = inventoryCache.inventory;
  if (!isPlainObject(inventory) || !Array.isArray(inventory.sources)) {
    throw new Error("source inventory cache is missing inventory.sources[]");
  }
  if (!isPlainObject(writerCache.cards)) throw new Error("Writer cache is missing cards{}");

  const sources = new Map();
  for (const source of inventory.sources) {
    if (!isPlainObject(source) || typeof source.cardId !== "string") {
      throw new Error("source inventory contains an invalid card item");
    }
    if (sources.has(source.cardId)) throw new Error(`source inventory duplicates cardId=${source.cardId}`);
    sources.set(source.cardId, source);
  }

  // All card metadata (title, analysisFocus) and the user question come from
  // result.json — the sole A/B hard interface.  No recommendations.json read.
  const cards = result.value.cards.map((card, index) => {
    if (!isPlainObject(card) || typeof card.id !== "string" || !card.id.trim()) {
      throw new Error(`result.cards[${index}] is missing a non-empty id`);
    }
    const source = sources.get(card.id);
    if (!source) throw new Error(`source inventory is missing cardId=${card.id}`);
    const writer = writerCache.cards[card.id];
    if (!isPlainObject(writer) || writer.fetchStatus !== "success" || writer.cardId !== card.id) {
      throw new Error(`validated Writer return cache is missing cardId=${card.id}`);
    }
    return {
      id: card.id,
      title: String(card.title || card.id),
      analysisFocus: typeof card.analysisFocus === "string" ? card.analysisFocus : null,
      queryCoverage: compactQueryCoverage(card.query),
      writer: {
        summary: String(writer.analysis?.summary || ""),
        findings: Array.isArray(writer.analysis?.findings) ? writer.analysis.findings : [],
        recommendations: Array.isArray(writer.analysis?.recommendations) ? writer.analysis.recommendations : [],
      },
      source,
    };
  });
  if (sources.size !== cards.length) throw new Error("source inventory card set does not match result.json");

  const userQuestion = String(result.value.userQuestion || "").trim();
  if (!userQuestion) throw new Error("result.json is missing userQuestion");
  return {
    version: EDITOR_PLAN_INPUT_VERSION,
    producer: "editor-plan-contract.mjs",
    userQuestion,
    title: String(result.value.title || userQuestion),
    cards,
  };
}

function lineValue(text, label) {
  const match = String(text || "").match(new RegExp(`^${label}\\s*=\\s*(.+?)\\s*$`, "m"));
  return match ? match[1] : null;
}

export function isEditorPlannerAssignment(text) {
  const lines = String(text || "").trimStart().split(/\r?\n/);
  // pi-subagents moves long tasks into a temporary <file> block. Accept only
  // that exact wrapper position; the marker must still be the first task line,
  // so a mention later in arbitrary prose cannot switch the runtime mode.
  const firstLine = /^<file name="[^"\r\n]+">\s*$/.test(lines[0] || "")
    ? (lines[1] || "")
    : (lines[0] || "");
  const marker = firstLine.startsWith("Task: ")
    ? firstLine.slice("Task: ".length)
    : firstLine;
  return marker === EDITOR_PLANNER_MARKER;
}

export const EDITOR_PLANNER_SYSTEM_PROMPT = [
  "You are the html-report B2.5 Editor Planner. Make semantic planning decisions only from the compact input and attached schema.",
  "Latency-critical: make one silent pass: gap -> mode -> smallest operations -> requirements -> verify -> submit. Do not translate or restate input/schema, compare alternatives, narrate reasoning, or revise a valid draft.",
  "Do not read/query/write/recall, discuss implementation, or use fixed test/store/field/indicator assumptions; derive every choice from the input.",
  "Call structured_output exactly once with a schema-valid object; use no other tool or prose.",
].join("\n");

export function buildEditorPlannerAssignment({ sessionDir, resultPath, input }) {
  return [
    EDITOR_PLANNER_MARKER,
    `SESSION=${sessionDir}`,
    `result.json=${resultPath}`,
    "",
    "COMPACT EDITOR INPUT JSON:",
    JSON.stringify(input),
    "",
    "PLANNING CONTRACT:",
    "- Choose one typed branch: create tasks for analytical answers whenever any Writer source is non-empty, or use tasks=[] only when every source is a validated zero-row source and every source has typed capability=no_data coverage via empty_source; noDeeperReason explains the branch but never proves coverage.",
    "- A Writer row finding is only an editorial starting point and never bypasses B3. For non-empty sources, record, comparison, distribution, association, and data_quality answers require a task.",
    "- Prefer one consolidated task per source. Reuse available rows for projection, sorting, TopN, grouping, ranges, comparisons, bins, or associations; use new_query only for a material missing indicator, dimension/granularity, range, scope/comparison, or metric definition. Derived analysis over available fields is reuse_entry, not an evidenceGap; copy source.availableFields names verbatim and let new_query candidates describe only the authorized gap.",
    `- Capability -> operation: ${CAPABILITY_OPERATION_CONTRACT}`,
    "- Operation exact keys: sort/topN/bottomN require field (never sortBy); subsetStats/compare/compareTopN require sortBy (never field). Use only keys authorized for the selected type; aliases are forbidden.",
    "- For correlation/quantileBins/jointQuantileBins, fields contains driver fields only and must never repeat targetField; jointQuantileBins requires exactly two drivers.",
    "- Choose the smallest evidence views that answer a decision, with at most six non-overlapping operations in the single consolidated task for one source: sort/topN/bottomN select records; compare/compareTopN compare selected versus remaining rows; stats/range summarize a basic distribution; groupBy/quantileBins describe structural breakdowns; correlation is non-causal association in the observed sample. B2 already contains the full detail table, so do not plan a re-display or re-sort unless the user explicitly asks for a literal record answer.",
    "- Use the most specific capability: ranking for ordered records, structural_breakdown for groups or one-driver bins, joint_tradeoff for a two-driver balance/trade-off, and association for correlation. Do not downgrade these to record/comparison/distribution merely because the referenced operation is also broadly compatible.",
    "- A balance/trade-off/best point over exactly two available drivers needs capability=joint_tradeoff and must use jointQuantileBins with direction=desc when higher target is better or asc otherwise; one maximum record and separate quantileBins winners cannot prove it. These words alone do not request dates, records, or ranking: never add sort/topN/bottomN or a ranking requirement unless the user explicitly asks for them. Describe only best observed complete-case cells, never a global optimum.",
    "- Apply data-quality signals only to fields used by the task. Put material missing/null/blank exclusions or zero-value sensitivity exposed by an analytical view into that same requirement; add a separate data_quality requirement only for a material uncovered boundary. Never label reliability high/low without explicit threshold metadata, and mention zero values only when material.",
    `- Requirements ask for decisions or interpretations, not row enumeration. Rubrics: ${RUBRIC_GLOSSARY}. Select only rubrics materially improved by the requirement; each selected rubric uses the fixed score-2 quality gate.`,
    `- Required rubric floor: ${REQUIRED_RUBRIC_CONTRACT}. These are semantic minimums from capability and operation shape, never from memorized business fields.`,
    "- Call structured_output exactly once now. Do not call read, bash, write, or submit_research_findings.",
  ].join("\n");
}

/** Validate the parent's minimal marker and replace it with authoritative compact input. */
export function editorPlannerExpectedFromAssignment(taskText, { sessionDir } = {}) {
  if (!isEditorPlannerAssignment(taskText)) return { error: "missing Editor Planner marker" };
  if (!sessionDir || !canonicalAbsolute(sessionDir)) return { error: "current SESSION path is unavailable" };
  const assignedSession = lineValue(taskText, "SESSION");
  const assignedResult = lineValue(taskText, "result\\.json");
  const expectedSession = resolve(sessionDir);
  const expectedResult = join(expectedSession, "result.json");
  if (!canonicalAbsolute(assignedSession) || !canonicalAbsolute(assignedResult)) {
    return { error: "Editor Planner SESSION/result.json must be canonical absolute paths" };
  }
  if (resolve(assignedSession) !== expectedSession || resolve(assignedResult) !== expectedResult) {
    return { error: "Editor Planner assignment must target the current SESSION/result.json" };
  }
  try {
    const input = loadEditorPlannerInput(expectedResult);
    return {
      sessionDir: expectedSession,
      resultPath: expectedResult,
      input,
      assignment: buildEditorPlannerAssignment({
        sessionDir: expectedSession,
        resultPath: expectedResult,
        input,
      }),
    };
  } catch (error) {
    return { error: `Editor Planner input is not ready: ${error.message || error}` };
  }
}

function stringArraySchema({ minItems = 0, maxItems = MAX_FIELDS, enumValues } = {}) {
  return {
    type: "array",
    minItems,
    maxItems,
    uniqueItems: true,
    items: enumValues
      ? { type: "string", enum: enumValues }
      : { type: "string", minLength: 1 },
  };
}

function whereSchema() {
  // Keep provider-facing schemas on ordinary scalar branches. Although the
  // local TypeBox compiler accepts JSON Schema union type arrays, some model
  // gateways stall before the first token when tool parameters contain them.
  const scalar = {
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
    ],
  };
  const scalarClause = {
    type: "object",
    additionalProperties: false,
    properties: {
      field: { type: "string", minLength: 1 },
      op: { enum: [...WHERE_OPERATORS].filter((operator) => operator !== "in") },
      value: scalar,
    },
    required: ["field", "op", "value"],
  };
  const inClause = {
    type: "object",
    additionalProperties: false,
    properties: {
      field: { type: "string", minLength: 1 },
      op: { const: "in" },
      value: { type: "array", minItems: 1, maxItems: 50, items: scalar },
    },
    required: ["field", "op", "value"],
  };
  return {
    type: "array",
    minItems: 1,
    maxItems: MAX_WHERE,
    items: { oneOf: [scalarClause, inClause] },
  };
}

function compactOperationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      type: {
        enum: [...OPERATION_TYPES],
        description: `Select one type and obey its exact required/optional keys: ${OPERATION_KEY_CONTRACT}`,
      },
      fields: {
        ...stringArraySchema(),
        description: "Selected fields. For correlation/quantileBins/jointQuantileBins these are drivers only; exclude targetField, and jointQuantileBins requires exactly two.",
      },
      where: whereSchema(),
      field: {
        type: "string",
        minLength: 1,
        description: "Required sort/rank key for sort, topN, and bottomN. Never use sortBy for these types.",
      },
      sortBy: {
        type: "string",
        minLength: 1,
        description: "Required only for subsetStats, compare, and compareTopN.",
      },
      groupField: { type: "string", minLength: 1 },
      targetField: {
        type: "string",
        minLength: 1,
        description: "Outcome field for correlation/quantileBins/jointQuantileBins; do not repeat it in fields.",
      },
      count: { type: "integer", minimum: 1, maximum: 50 },
      direction: { enum: ["asc", "desc"] },
      maxGroups: { type: "integer", minimum: 1, maximum: 20 },
      binCount: { type: "integer", minimum: 2, maximum: 10 },
    },
    required: ["id", "type", "fields"],
  };
}

function evidenceGapSchema() {
  const common = { reason: { type: "string", minLength: 1 } };
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: { ...common, type: { enum: [...EVIDENCE_GAP_TYPES] } },
        required: ["type", "reason"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...common,
          types: stringArraySchema({ minItems: 1, maxItems: EVIDENCE_GAP_TYPES.size, enumValues: [...EVIDENCE_GAP_TYPES] }),
        },
        required: ["types", "reason"],
      },
    ],
  };
}

function requirementSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      question: { type: "string", minLength: 1 },
      capability: {
        enum: [...CAPABILITIES],
        description: `Must be supported by at least one referenced operation: ${CAPABILITY_OPERATION_CONTRACT}`,
      },
      evidenceViewIds: {
        ...stringArraySchema({ minItems: 1, maxItems: MAX_OPERATIONS }),
        description: "Exact operations[].id values from this same task; at least one must support capability.",
      },
      targetRubric: stringArraySchema({ minItems: 1, maxItems: 7, enumValues: ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] }),
    },
    required: ["id", "question", "capability", "evidenceViewIds", "targetRubric"],
  };
}

function answerRequirementSchema(cardIds) {
  const coverage = {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { const: NO_OP_COVERAGE_KIND },
      cardId: { type: "string", enum: cardIds },
      findingIndex: { type: "null" },
    },
    required: ANSWER_COVERAGE_KEYS,
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" },
      question: { type: "string", minLength: 1 },
      capability: { const: "no_data" },
      coverage,
    },
    required: ANSWER_REQUIREMENT_KEYS,
  };
}

function taskProperties(cardIds) {
  return {
    fromCardId: { type: "string", enum: cardIds },
    goal: { type: "string", minLength: 1 },
    gap: { type: "string", minLength: 1 },
    mode: { enum: ["reuse_entry", "new_query"] },
    reason: { type: "string", minLength: 1 },
    evidenceGap: { oneOf: [{ type: "null" }, evidenceGapSchema()] },
    candidateIndicators: stringArraySchema(),
    candidateDims: stringArraySchema(),
    operations: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OPERATIONS,
      items: compactOperationSchema(),
    },
    requirements: {
      type: "array",
      minItems: 1,
      maxItems: MAX_REQUIREMENTS,
      items: requirementSchema(),
    },
    successCriteria: { type: "string", minLength: 1 },
    hint: { type: "string", minLength: 1 },
  };
}

export function buildEditorPlanSchema(input) {
  const cardIds = Array.isArray(input?.cards) ? input.cards.map((card) => String(card?.id || "")).filter(Boolean) : [];
  if (!cardIds.length) throw new Error("Editor Planner schema requires at least one card id");
  const task = {
    type: "object",
    additionalProperties: false,
    properties: taskProperties(cardIds),
    required: TASK_KEYS,
    oneOf: [
      {
        properties: {
          mode: { const: "reuse_entry" },
          evidenceGap: { type: "null" },
          candidateIndicators: { type: "array", maxItems: 0 },
          candidateDims: { type: "array", maxItems: 0 },
        },
        required: ["mode", "evidenceGap", "candidateIndicators", "candidateDims"],
      },
      {
        properties: {
          mode: { const: "new_query" },
          evidenceGap: evidenceGapSchema(),
        },
        required: ["mode", "evidenceGap"],
      },
    ],
  };
  const answerRequirements = {
    type: "array",
    maxItems: MAX_REQUIREMENTS,
    items: answerRequirementSchema(cardIds),
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      version: { const: EDITOR_PLAN_VERSION },
      tasks: { type: "array", maxItems: MAX_TASKS, items: task },
      answerRequirements,
      // Pi validates ordinary JSON Schema tool parameters after coercion.  A
      // string-first union converts JSON null to "" before the root XOR is
      // checked, so keep the exact null branch first.  This is a runtime
      // compatibility ordering; the semantic contract below remains strict.
      noDeeperReason: { oneOf: [{ type: "null" }, { type: "string" }] },
    },
    required: ["version", "tasks", "answerRequirements", "noDeeperReason"],
    oneOf: [
      {
        properties: {
          tasks: { minItems: 1 },
          answerRequirements: { type: "array", maxItems: 0 },
          noDeeperReason: { type: "null" },
        },
        required: ["tasks", "answerRequirements", "noDeeperReason"],
      },
      {
        properties: {
          tasks: { maxItems: 0 },
          answerRequirements: { ...answerRequirements, minItems: 1 },
          noDeeperReason: { type: "string", minLength: 1 },
        },
        required: ["tasks", "answerRequirements", "noDeeperReason"],
      },
    ],
  };
}

function hasExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(value, { min = 0, max = MAX_FIELDS } = {}) {
  return Array.isArray(value) && value.length >= min && value.length <= max &&
    value.every(nonEmptyString) && new Set(value).size === value.length;
}

function safeId(value) {
  return nonEmptyString(value) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function operationFieldReferences(operation) {
  const fields = Array.isArray(operation?.fields)
    ? operation.fields.filter(nonEmptyString)
    : [];
  for (const key of ["field", "sortBy", "groupField", "targetField"]) {
    if (nonEmptyString(operation?.[key])) fields.push(operation[key]);
  }
  for (const clause of Array.isArray(operation?.where) ? operation.where : []) {
    if (nonEmptyString(clause?.field)) fields.push(clause.field);
  }
  return [...new Set(fields)];
}

function validateWhere(where, label, errors) {
  if (where === undefined) return;
  if (!Array.isArray(where) || where.length < 1 || where.length > MAX_WHERE) {
    errors.push(`${label}.where must contain 1-${MAX_WHERE} clauses`);
    return;
  }
  for (const [index, clause] of where.entries()) {
    const path = `${label}.where[${index}]`;
    if (!hasExactKeys(clause, ["field", "op", "value"])) {
      errors.push(`${path} must contain only field, op, and value`);
      continue;
    }
    if (!nonEmptyString(clause.field)) errors.push(`${path}.field must be non-empty`);
    if (!WHERE_OPERATORS.has(clause.op)) errors.push(`${path}.op is unsupported`);
    const scalar = clause.value === null || ["string", "number", "boolean"].includes(typeof clause.value);
    const scalarArray = Array.isArray(clause.value) && clause.value.length > 0 && clause.value.length <= 50 &&
      clause.value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item));
    if (!scalar && !scalarArray) errors.push(`${path}.value must be a scalar or non-empty scalar array`);
    if (clause.op === "in" && !scalarArray) errors.push(`${path}.op=in requires an array value`);
    if (clause.op !== "in" && scalarArray) errors.push(`${path}.op=${clause.op} requires a scalar value`);
  }
}

function validateOperation(operation, label, errors) {
  if (!isPlainObject(operation) || !OPERATION_TYPES.has(operation.type)) {
    errors.push(`${label}.type is unsupported`);
    return null;
  }
  const spec = OPERATION_KEYS[operation.type];
  if (!hasExactKeys(operation, spec.required, spec.optional)) {
    errors.push(`${label} has missing, extra, or aliased keys for type=${operation.type}`);
  }
  if (!safeId(operation.id)) errors.push(`${label}.id must be a stable safe id`);
  const minFields = operation.type === "project" ? 0 : 1;
  if (!uniqueStrings(operation.fields, { min: minFields })) {
    errors.push(`${label}.fields must be a unique string array with at least ${minFields} item(s)`);
  }
  for (const key of ["field", "sortBy", "groupField", "targetField"]) {
    if (spec.required.includes(key) && !nonEmptyString(operation[key])) errors.push(`${label}.${key} must be non-empty`);
  }
  if (Object.prototype.hasOwnProperty.call(operation, "count") &&
      (!Number.isSafeInteger(operation.count) || operation.count < 1 || operation.count > 50)) {
    errors.push(`${label}.count must be an integer between 1 and 50`);
  }
  if (Object.prototype.hasOwnProperty.call(operation, "maxGroups") &&
      (!Number.isSafeInteger(operation.maxGroups) || operation.maxGroups < 1 || operation.maxGroups > 20)) {
    errors.push(`${label}.maxGroups must be an integer between 1 and 20`);
  }
  if (Object.prototype.hasOwnProperty.call(operation, "binCount") &&
      (!Number.isSafeInteger(operation.binCount) || operation.binCount < 2 || operation.binCount > 10)) {
    errors.push(`${label}.binCount must be an integer between 2 and 10`);
  }
  if (Object.prototype.hasOwnProperty.call(operation, "direction") && !["asc", "desc"].includes(operation.direction)) {
    errors.push(`${label}.direction must be asc or desc`);
  }
  if (["correlation", "quantileBins", "jointQuantileBins"].includes(operation.type) &&
      Array.isArray(operation.fields) && operation.fields.includes(operation.targetField)) {
    errors.push(`${label}.fields must contain driver fields only and exclude targetField`);
  }
  if (operation.type === "jointQuantileBins") {
    if (!Array.isArray(operation.fields) || operation.fields.length !== 2) {
      errors.push(`${label}.jointQuantileBins requires exactly two driver fields`);
    }
    if (operation.binCount != null && operation.binCount > 5) {
      errors.push(`${label}.jointQuantileBins binCount must be at most 5`);
    }
  }
  validateWhere(operation.where, label, errors);
  return operation;
}

function normalizedWhereSignature(where) {
  if (!Array.isArray(where)) return null;
  return where
    .map((clause) => {
      if (!isPlainObject(clause)) return clause;
      const value = clause.op === "in" && Array.isArray(clause.value)
        ? [...clause.value].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)))
        : clause.value;
      return { field: clause.field, op: clause.op, value };
    })
    .sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
}

function exactOperationSignature(operation) {
  if (!isPlainObject(operation)) return null;
  const { id: _id, where: _where, fields: _fields, ...rest } = operation;
  return canonicalize({
    ...rest,
    fields: Array.isArray(operation.fields) ? [...operation.fields].sort() : operation.fields,
    where: normalizedWhereSignature(operation.where),
  });
}

function mergeableAnalysisSignature(operation) {
  if (!isPlainObject(operation) || !["correlation", "quantileBins"].includes(operation.type)) return null;
  return canonicalize({
    type: operation.type,
    targetField: operation.targetField,
    binCount: operation.type === "quantileBins" ? (operation.binCount ?? 4) : null,
    where: normalizedWhereSignature(operation.where),
  });
}

/**
 * Canonicalize schema-valid semantic aliases before strict validation.
 *
 * A Planner may express the same deterministic view more than once under
 * different ids.  Re-running the model to repair that representation adds
 * latency without adding a semantic decision, so merge only operations whose
 * equivalence can be proven locally and rewrite requirement foreign keys.
 * Invalid or ambiguous operations are left untouched for fail-closed
 * validation below.
 */
export function normalizeEditorPlan(plan) {
  if (!isPlainObject(plan)) return plan;
  const normalized = structuredClone(plan);
  if (!Array.isArray(normalized.tasks)) return normalized;

  for (const task of normalized.tasks) {
    if (!isPlainObject(task) || !Array.isArray(task.operations)) continue;
    const requirementsByView = new Map();
    for (const requirement of Array.isArray(task.requirements) ? task.requirements : []) {
      if (!isPlainObject(requirement) || !Array.isArray(requirement.evidenceViewIds)) continue;
      for (const viewId of requirement.evidenceViewIds) {
        const requirements = requirementsByView.get(viewId) || [];
        requirements.push(requirement);
        requirementsByView.set(viewId, requirements);
      }
    }
    // compareTopN carries a large comparison payload. If every consumer asks
    // only for the selected record, topN is provably equivalent for those
    // requirements and keeps the Researcher evidence packet compact.
    task.operations = task.operations.map((operation) => {
      let canonicalOperation = operation;
      if (
        isPlainObject(canonicalOperation) &&
        ["correlation", "quantileBins", "jointQuantileBins"].includes(canonicalOperation.type) &&
        nonEmptyString(canonicalOperation.targetField) &&
        uniqueStrings(canonicalOperation.fields, { min: 1 }) &&
        canonicalOperation.fields.includes(canonicalOperation.targetField)
      ) {
        const spec = OPERATION_KEYS[canonicalOperation.type];
        if (hasExactKeys(canonicalOperation, spec.required, spec.optional)) {
          canonicalOperation = {
            ...canonicalOperation,
            fields: canonicalOperation.fields.filter((field) => field !== canonicalOperation.targetField),
          };
        }
      }
      if (
        isPlainObject(canonicalOperation) &&
        ["sort", "topN", "bottomN"].includes(canonicalOperation.type) &&
        nonEmptyString(canonicalOperation.sortBy)
      ) {
        const spec = OPERATION_KEYS[canonicalOperation.type];
        const aliasRequired = spec.required.map((key) => key === "field" ? "sortBy" : key);
        if (hasExactKeys(canonicalOperation, aliasRequired, spec.optional)) {
          const { sortBy, ...rest } = canonicalOperation;
          canonicalOperation = { ...rest, field: sortBy };
        }
      }
      const consumers = isPlainObject(canonicalOperation)
        ? (requirementsByView.get(canonicalOperation.id) || [])
        : [];
      if (
        canonicalOperation?.type !== "compareTopN" ||
        consumers.length === 0 ||
        consumers.some((requirement) => !["record", "ranking"].includes(requirement.capability))
      ) return canonicalOperation;
      const operationErrors = [];
      validateOperation(canonicalOperation, "operation", operationErrors);
      if (operationErrors.length > 0) return canonicalOperation;
      return {
        id: canonicalOperation.id,
        type: "topN",
        field: canonicalOperation.sortBy,
        fields: Array.isArray(canonicalOperation.fields) &&
            typeof canonicalOperation.sortBy === "string" &&
            !canonicalOperation.fields.includes(canonicalOperation.sortBy)
          ? [...canonicalOperation.fields, canonicalOperation.sortBy]
          : canonicalOperation.fields,
        count: canonicalOperation.count,
        ...(canonicalOperation.direction !== undefined ? { direction: canonicalOperation.direction } : {}),
        ...(canonicalOperation.where !== undefined ? { where: canonicalOperation.where } : {}),
      };
    });
    const idCounts = new Map();
    for (const operation of task.operations) {
      if (!isPlainObject(operation) || !safeId(operation.id)) continue;
      idCounts.set(operation.id, (idCounts.get(operation.id) || 0) + 1);
    }
    const isSafeToNormalize = (operation) => {
      if (!isPlainObject(operation) || idCounts.get(operation.id) !== 1) return false;
      const errors = [];
      validateOperation(operation, "operation", errors);
      return errors.length === 0;
    };

    const aliases = new Map();
    const mergedAnalysis = [];
    const analysisBySignature = new Map();
    for (const operation of task.operations) {
      const signature = isSafeToNormalize(operation)
        ? mergeableAnalysisSignature(operation)
        : null;
      const existing = signature ? analysisBySignature.get(signature) : null;
      if (!existing) {
        mergedAnalysis.push(operation);
        if (signature) analysisBySignature.set(signature, operation);
        continue;
      }
      existing.fields = [...new Set([...existing.fields, ...operation.fields])];
      aliases.set(operation.id, existing.id);
    }

    const deduplicated = [];
    const exactBySignature = new Map();
    for (const operation of mergedAnalysis) {
      const signature = isSafeToNormalize(operation)
        ? exactOperationSignature(operation)
        : null;
      const existing = signature ? exactBySignature.get(signature) : null;
      if (!existing) {
        deduplicated.push(operation);
        if (signature) exactBySignature.set(signature, operation);
        continue;
      }
      aliases.set(operation.id, existing.id);
    }

    const resolveAlias = (id) => {
      let resolved = id;
      const seen = new Set();
      while (aliases.has(resolved) && !seen.has(resolved)) {
        seen.add(resolved);
        resolved = aliases.get(resolved);
      }
      return resolved;
    };
    task.operations = deduplicated;
    if (Array.isArray(task.requirements)) {
      for (const requirement of task.requirements) {
        if (!isPlainObject(requirement) || !Array.isArray(requirement.evidenceViewIds)) continue;
        requirement.evidenceViewIds = [
          ...new Set(requirement.evidenceViewIds.map((id) => resolveAlias(id))),
        ];
      }
    }
  }
  return normalized;
}

function validateRequirements(task, operationById, label, errors) {
  if (!Array.isArray(task.requirements) || task.requirements.length < 1 || task.requirements.length > MAX_REQUIREMENTS) {
    errors.push(`${label}.requirements must contain 1-${MAX_REQUIREMENTS} items`);
    return;
  }
  const ids = new Set();
  for (const [index, requirement] of task.requirements.entries()) {
    const path = `${label}.requirements[${index}]`;
    if (!hasExactKeys(requirement, ["id", "question", "capability", "evidenceViewIds", "targetRubric"])) {
      errors.push(`${path} has missing or extra keys`);
      continue;
    }
    if (!safeId(requirement.id)) errors.push(`${path}.id must be a stable safe id`);
    else if (ids.has(requirement.id)) errors.push(`${path}.id is duplicated`);
    else ids.add(requirement.id);
    if (!nonEmptyString(requirement.question)) errors.push(`${path}.question must be non-empty`);
    if (!CAPABILITIES.has(requirement.capability)) errors.push(`${path}.capability is unsupported`);
    if (!uniqueStrings(requirement.evidenceViewIds, { min: 1, max: MAX_OPERATIONS })) {
      errors.push(`${path}.evidenceViewIds must be a non-empty unique array`);
    } else {
      const referenced = requirement.evidenceViewIds.map((id) => operationById.get(id)).filter(Boolean);
      if (referenced.length !== requirement.evidenceViewIds.length) {
        errors.push(`${path}.evidenceViewIds references an unknown operation`);
      } else if (CAPABILITIES.has(requirement.capability)) {
        const allowed = CAPABILITY_OPERATION_TYPES[requirement.capability];
        if (!referenced.some((operation) => allowed.has(operation.type))) {
          errors.push(`${path}.capability=${requirement.capability} is not supported by its evidence views`);
        }
        const structuralTypes = new Set(
          referenced
            .map((operation) => operation.type)
            .filter((type) => STRUCTURAL_OPERATION_TYPES.has(type))
        );
        if (
          structuralTypes.has("jointQuantileBins") &&
          !["joint_tradeoff", "structural_breakdown", "data_quality"].includes(requirement.capability)
        ) {
          errors.push(
            `${path}.jointQuantileBins requires the specific joint_tradeoff or structural_breakdown capability`
          );
        } else if (
          [...structuralTypes].some((type) => type !== "jointQuantileBins") &&
          !["structural_breakdown", "data_quality"].includes(requirement.capability)
        ) {
          errors.push(
            `${path}.groupBy/quantileBins requires the specific structural_breakdown capability`
          );
        }
        if (requirement.capability === "association" && !referenced.some((operation) => operation.type === "correlation")) {
          errors.push(`${path}.association requires a correlation view`);
        }
        if (requirement.capability === "joint_tradeoff" &&
            !referenced.some((operation) => operation.type === "jointQuantileBins")) {
          errors.push(`${path}.joint_tradeoff requires a jointQuantileBins view`);
        }
        if (requirement.capability === "no_data" && referenced.some((operation) => operation.type !== "project")) {
          errors.push(`${path}.no_data may reference only a project view`);
        }
      }
    }
    if (!uniqueStrings(requirement.targetRubric, { min: 1, max: 7 }) ||
        requirement.targetRubric.some((rubric) => !/^R[1-7]$/.test(rubric))) {
      errors.push(`${path}.targetRubric must contain unique R1-R7 values`);
    } else {
      const requiredRubrics = new Set(CAPABILITY_REQUIRED_RUBRICS[requirement.capability] || []);
      if (
        task.mode === "new_query" &&
        evidenceGapTypes(task.evidenceGap).some((type) => ["missing_indicator", "metric_definition"].includes(type))
      ) {
        requiredRubrics.add("R4");
      }
      for (const rubric of requiredRubrics) {
        if (!requirement.targetRubric.includes(rubric)) {
          errors.push(`${path}.targetRubric must include ${rubric} for its capability/evidence contract`);
        }
      }
    }
  }
}

function validateTask(task, index, cardsById, reuseCards, errors) {
  const label = `tasks[${index}]`;
  if (!hasExactKeys(task, TASK_KEYS)) {
    errors.push(`${label} has missing or extra keys`);
    return;
  }
  const card = cardsById.get(task.fromCardId);
  if (!card) errors.push(`${label}.fromCardId is not in Planner input`);
  for (const key of ["goal", "gap", "reason", "successCriteria", "hint"]) {
    if (!nonEmptyString(task[key])) errors.push(`${label}.${key} must be non-empty`);
  }
  const candidateIndicators = Array.isArray(task.candidateIndicators) ? task.candidateIndicators : [];
  const candidateDims = Array.isArray(task.candidateDims) ? task.candidateDims : [];
  const requirements = Array.isArray(task.requirements) ? task.requirements : [];
  if (!uniqueStrings(task.candidateIndicators) || !uniqueStrings(task.candidateDims)) {
    errors.push(`${label}.candidateIndicators/candidateDims must be unique string arrays`);
  }
  if (!Array.isArray(task.operations) || task.operations.length < 1 || task.operations.length > MAX_OPERATIONS) {
    errors.push(`${label}.operations must contain 1-${MAX_OPERATIONS} items`);
    return;
  }
  const operationById = new Map();
  const exactOperations = new Map();
  const mergeableAnalysisOperations = new Map();
  for (const [operationIndex, raw] of task.operations.entries()) {
    const operation = validateOperation(raw, `${label}.operations[${operationIndex}]`, errors);
    if (!operation || !safeId(operation.id)) continue;
    if (operationById.has(operation.id)) errors.push(`${label}.operations has duplicate id=${operation.id}`);
    operationById.set(operation.id, operation);
    const exactSignature = exactOperationSignature(operation);
    if (exactSignature && exactOperations.has(exactSignature)) {
      errors.push(`${label}.operations[${operationIndex}] duplicates operation id=${exactOperations.get(exactSignature)}`);
    } else if (exactSignature) {
      exactOperations.set(exactSignature, operation.id);
    }
    const mergeableSignature = mergeableAnalysisSignature(operation);
    if (mergeableSignature && mergeableAnalysisOperations.has(mergeableSignature)) {
      errors.push(
        `${label}.operations[${operationIndex}] must merge fields[] with operation id=${mergeableAnalysisOperations.get(mergeableSignature)}`
      );
    } else if (mergeableSignature) {
      mergeableAnalysisOperations.set(mergeableSignature, operation.id);
    }
  }
  validateRequirements(task, operationById, label, errors);

  if (task.mode === "reuse_entry") {
    if (task.evidenceGap !== null) errors.push(`${label}.reuse_entry evidenceGap must be null`);
    if (candidateIndicators.length || candidateDims.length) {
      errors.push(`${label}.reuse_entry candidate lists must be empty`);
    }
    if (reuseCards.has(task.fromCardId)) errors.push(`${label} duplicates a reuse_entry task for the same card`);
    reuseCards.add(task.fromCardId);
    if (card && card.source?.status !== "available") {
      errors.push(`${label}.reuse_entry requires an available Writer source`);
    }
    const availableFields = new Set(Array.isArray(card?.source?.availableFields) ? card.source.availableFields : []);
    const empty = card?.source?.empty === true;
    if (empty) {
      if (task.operations.length !== 1 || task.operations[0]?.type !== "project" ||
          task.operations[0]?.fields?.length !== 0 || task.operations[0]?.where !== undefined) {
        errors.push(`${label}.empty reuse source requires one field-free project operation without where`);
      }
      if (requirements.some((requirement) => !["no_data", "data_quality"].includes(requirement?.capability))) {
        errors.push(`${label}.empty reuse source may contain only no_data/data_quality requirements`);
      }
    } else {
      for (const [operationIndex, operation] of task.operations.entries()) {
        for (const field of operationFieldReferences(operation)) {
          if (!availableFields.has(field)) {
            errors.push(`${label}.operations[${operationIndex}] field ${JSON.stringify(field)} is not in source.availableFields`);
          }
        }
      }
    }
  } else if (task.mode === "new_query") {
    if (!isValidEvidenceGap(task.evidenceGap)) {
      errors.push(`${label}.new_query requires a valid typed evidenceGap`);
    } else if (!hasExactKeys(task.evidenceGap, [task.evidenceGap.type ? "type" : "types", "reason"])) {
      errors.push(`${label}.evidenceGap contains unsupported keys`);
    }
    const gapTypes = evidenceGapTypes(task.evidenceGap);
    if (gapTypes.includes("missing_indicator") && candidateIndicators.length === 0) {
      errors.push(`${label}.missing_indicator requires candidateIndicators`);
    }
    if ((gapTypes.includes("missing_dimension") || gapTypes.includes("missing_granularity")) && candidateDims.length === 0) {
      errors.push(`${label}.missing dimension/granularity requires candidateDims`);
    }
  } else {
    errors.push(`${label}.mode must be reuse_entry or new_query`);
  }
}

/**
 * Validate the only deterministic no-op proof available before B3. Writer
 * findings are editorial starting points, not analytical completion proofs;
 * therefore every relevant source must be a validated zero-row source and
 * must have explicit typed no-data coverage.
 */
function validateNoOpAnswerRequirements(answerRequirements, cardsById, errors) {
  if (!Array.isArray(answerRequirements) || answerRequirements.length < 1 ||
      answerRequirements.length > MAX_REQUIREMENTS) {
    errors.push(`empty tasks requires answerRequirements with 1-${MAX_REQUIREMENTS} items`);
    return;
  }
  const ids = new Set();
  const coveredCardIds = new Set();
  for (const [cardId, card] of cardsById) {
    if (card?.source?.status !== "available" || card.source?.empty !== true || card.source?.rowCount !== 0) {
      errors.push(`empty tasks requires every Planner source to be a validated zero-row source; card=${cardId}`);
    }
  }
  for (const [index, requirement] of answerRequirements.entries()) {
    const label = `answerRequirements[${index}]`;
    if (!hasExactKeys(requirement, ANSWER_REQUIREMENT_KEYS)) {
      errors.push(`${label} must contain only id, question, capability, and coverage`);
      continue;
    }
    if (!safeId(requirement.id)) errors.push(`${label}.id must be a stable safe id`);
    else if (ids.has(requirement.id)) errors.push(`${label}.id is duplicated`);
    else ids.add(requirement.id);
    if (!nonEmptyString(requirement.question)) errors.push(`${label}.question must be non-empty`);
    if (!CAPABILITIES.has(requirement.capability)) errors.push(`${label}.capability is unsupported`);

    const coverage = requirement.coverage;
    if (!hasExactKeys(coverage, ANSWER_COVERAGE_KEYS)) {
      errors.push(`${label}.coverage must contain only kind, cardId, and findingIndex`);
      continue;
    }
    if (coverage.kind !== NO_OP_COVERAGE_KIND) {
      errors.push(`${label}.coverage.kind must be empty_source`);
      continue;
    }
    const card = cardsById.get(coverage.cardId);
    if (!card) {
      errors.push(`${label}.coverage.cardId is not in Planner input`);
      continue;
    }

    coveredCardIds.add(coverage.cardId);
    if (coverage.findingIndex !== null) {
      errors.push(`${label}.empty_source coverage requires findingIndex=null`);
    }
    if (requirement.capability !== "no_data") {
      errors.push(`${label}.empty_source coverage can prove only capability=no_data`);
    }
    if (card.source?.status !== "available" || card.source?.empty !== true || card.source?.rowCount !== 0) {
      errors.push(`${label}.empty_source coverage requires a validated zero-row source`);
    }
  }
  for (const cardId of cardsById.keys()) {
    if (!coveredCardIds.has(cardId)) {
      errors.push(`empty tasks requires typed no_data coverage for every Planner source; missing card=${cardId}`);
    }
  }
}

export function validateEditorPlan(plan, input) {
  const errors = [];
  if (!hasExactKeys(plan, ["version", "tasks", "answerRequirements", "noDeeperReason"])) {
    return {
      ok: false,
      errors: ["Editor plan must contain only version, tasks, answerRequirements, and noDeeperReason"],
    };
  }
  if (plan.version !== EDITOR_PLAN_VERSION) errors.push(`version must be exactly ${EDITOR_PLAN_VERSION}`);
  if (!Array.isArray(plan.tasks) || plan.tasks.length > MAX_TASKS) {
    errors.push(`tasks must be an array with at most ${MAX_TASKS} items`);
    return { ok: false, errors };
  }
  const cards = Array.isArray(input?.cards) ? input.cards : [];
  const cardsById = new Map(cards.map((card) => [card?.id, card]));
  if (!nonEmptyString(input?.userQuestion) || cardsById.size === 0) {
    errors.push("Planner input must contain userQuestion and cards");
    return { ok: false, errors };
  }
  if (plan.tasks.length === 0) {
    if (!nonEmptyString(plan.noDeeperReason)) errors.push("empty tasks requires a non-empty noDeeperReason");
    validateNoOpAnswerRequirements(plan.answerRequirements, cardsById, errors);
  } else if (plan.noDeeperReason !== null) {
    errors.push("non-empty tasks requires noDeeperReason=null");
  } else if (!Array.isArray(plan.answerRequirements) || plan.answerRequirements.length !== 0) {
    errors.push("non-empty tasks requires answerRequirements=[]");
  }
  const reuseCards = new Set();
  for (const [index, task] of plan.tasks.entries()) validateTask(task, index, cardsById, reuseCards, errors);
  if (
    plan.tasks.length > 0 &&
    JOINT_TRADEOFF_CUE.test(String(input.userQuestion || ""))
  ) {
    const jointRequirements = plan.tasks.flatMap((task) =>
      Array.isArray(task?.requirements)
        ? task.requirements.filter((requirement) => requirement?.capability === "joint_tradeoff")
        : []
    );
    if (jointRequirements.length === 0) {
      errors.push(
        "userQuestion expresses a generic balance/trade-off decision and requires a joint_tradeoff requirement"
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export function requiredColumnsForOperations(operations) {
  return [...new Set(operations.flatMap(operationFieldReferences))];
}

function rubricUnion(requirements) {
  const values = new Set(requirements.flatMap((requirement) => requirement.targetRubric));
  return [...values].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
}

export function compileEditorTasksDocument(plan, input) {
  const checked = validateEditorPlan(plan, input);
  if (!checked.ok) throw new Error(`invalid Editor plan: ${checked.errors.join("; ")}`);
  const tasks = plan.tasks.map((task, index) => ({
      id: `drill-${String(index + 1).padStart(3, "0")}`,
      analysisContractVersion: 1,
      fromCardId: task.fromCardId,
      goal: task.goal,
      gap: task.gap,
      evidencePlan: {
        mode: task.mode,
        sourceCardId: task.fromCardId,
        reason: task.reason,
        requiredColumns: requiredColumnsForOperations(task.operations),
        operations: task.operations,
      },
      evidenceGap: task.evidenceGap,
      exploreType: task.mode,
      candidateIndicators: task.candidateIndicators,
      candidateDims: task.candidateDims,
      // Persist the semantic answer shape so Researcher validation can check
      // operation-specific fact roles instead of trusting prose-only self-checks.
      analysisRequirements: task.requirements.map((requirement) => ({ ...requirement })),
      successCriteria: task.successCriteria,
      targetRubric: rubricUnion(task.requirements),
      reason: task.reason,
      hint: task.hint,
      status: "pending",
    }));
  return {
    version: 2,
    round: 0,
    maxRounds: 2,
    source: "phase-b2",
    editorial: {
      userQuestion: input.userQuestion,
      gaps: plan.tasks.map((task) => task.gap),
      directAnswerRequirements: plan.tasks.length ? [] : plan.answerRequirements,
      notes: plan.tasks.length ? null : plan.noDeeperReason,
    },
    tasks,
  };
}

function inline(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "｜")
    .replace(/\s+/g, " ")
    .trim();
}

function scopeLine(card) {
  const coverage = card.queryCoverage || {};
  const parts = [];
  // Read time as an object (new compactQueryCoverage structure).
  const time = isPlainObject(coverage.time) ? coverage.time : {};
  if (time.startDate || time.endDate) parts.push(`日期 ${inline(time.startDate || "未指定")} 至 ${inline(time.endDate || "未指定")}`);
  if (Array.isArray(coverage.dimensions) && coverage.dimensions.length) parts.push(`维度 ${coverage.dimensions.map(inline).join("、")}`);
  // Read filters as a map object { field: [values] } (new compactQueryCoverage structure).
  if (isPlainObject(coverage.filters) && Object.keys(coverage.filters).length) {
    const filters = Object.entries(coverage.filters).map(([field, values]) => {
      const code = inline(field || "筛选");
      const valueList = Array.isArray(values) ? values.map(inline).join("、") : "已确认";
      return `${code}=${valueList}`;
    });
    parts.push(`筛选 ${filters.join("；")}`);
  }
  return parts.length ? parts.join("；") : "范围以确认卡片为准";
}

function writerPointers(card) {
  const pointers = (Array.isArray(card.writer?.findings) ? card.writer.findings : [])
    .flatMap((finding) => Array.isArray(finding?.evidence) ? finding.evidence : [])
    .filter((pointer) => typeof pointer === "string" && pointer.startsWith("entry.json#"));
  if (pointers.length) return [...new Set(pointers)];
  return card.source?.rowCount > 0 ? ["entry.json#/0"] : ["entry.json#"];
}

function writerStartingPoint(card) {
  const findings = (Array.isArray(card.writer?.findings) ? card.writer.findings : [])
    .filter((finding) => nonEmptyString(finding?.statement))
    .map((finding) => {
      const pointers = (Array.isArray(finding.evidence) ? finding.evidence : [])
        .filter((pointer) => typeof pointer === "string" && pointer.startsWith("entry.json#"));
      return pointers.length
        ? `${inline(finding.statement)}；evidence: ${[...new Set(pointers)].map(inline).join(", ")}`
        : "";
    })
    .filter(Boolean);
  if (findings.length) return findings.join("；");
  return `已取得确认范围内的明细；evidence: ${writerPointers(card).map(inline).join(", ")}`;
}

export function renderEditorMain(plan, input) {
  const checked = validateEditorPlan(plan, input);
  if (!checked.ok) throw new Error(`invalid Editor plan: ${checked.errors.join("; ")}`);
  const lines = [
    `# ${inline(input.title || "分析报告")}`,
    "",
    "## 用户问题",
    inline(input.userQuestion),
    "",
    "## 范围",
    ...input.cards.map((card) => `- ${inline(card.id)}：${inline(card.title)}；${scopeLine(card)}`),
    "",
    "## Writer 起点",
    ...input.cards.map((card) => `- ${inline(card.id)}：${writerStartingPoint(card)}`),
    "",
    "## 待加深分析",
    ...(plan.tasks.length
      ? plan.tasks.map((task) => `- ${inline(task.gap)}`)
      : [`- ${inline(plan.noDeeperReason)}`]),
    "",
    "## 待 B3 Researcher 结论",
    "- 待 Researcher 基于结构化证据补全结论。",
    "",
  ];
  const markdown = lines.join("\n");
  if (markdown.includes("|")) throw new Error("compiled analysis/main.md must not contain pipe characters");
  if (/<table\b/i.test(markdown)) throw new Error("compiled analysis/main.md must not contain HTML tables");
  return markdown;
}

export function compileEditorArtifacts(plan, input) {
  return {
    tasks: compileEditorTasksDocument(plan, input),
    main: renderEditorMain(plan, input),
  };
}
