/**
 * Report Writer's small, machine-checkable return contract.
 *
 * The B2 parent passes `buildWriterReturnSchema()` to pi-subagents as the
 * one-step chain's `outputSchema`.  Pi then rejects a Writer that does not
 * submit this exact structured output through `structured_output`.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";

export function sanitizeCardId(raw) {
  const value = String(raw || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  if (value === "." || value === "..") {
    throw new Error("cardId must not be a dot path segment");
  }
  return value;
}

export function writerReturnPaths({ sessionDir, cardId }) {
  if (!sessionDir || !isAbsolute(sessionDir)) {
    throw new Error("sessionDir must be an absolute path");
  }
  const safeCardId = sanitizeCardId(cardId);
  const cardDir = join(resolve(sessionDir), "data", "cards", safeCardId);
  return {
    cardId: String(cardId),
    dataPath: join(cardDir, "entry.json"),
    metaPath: join(cardDir, "entry.meta.json"),
  };
}

function analysisSchema({ failure = false } = {}) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string", minLength: 1 },
      findings: failure
        ? { type: "array", maxItems: 0 }
        : {
            type: "array",
            maxItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                statement: { type: "string", minLength: 1 },
                evidence: {
                  type: "array",
                  minItems: 1,
                  maxItems: 1,
                  items: {
                    type: "string",
                    pattern: "^entry\\.json#(?:/(?:[^~/]|~[01])*)*$",
                  },
                },
              },
              required: ["statement", "evidence"],
            },
          },
      recommendations: failure
        ? { type: "array", maxItems: 0 }
        : {
            type: "array",
            minItems: 1,
            maxItems: 1,
            items: { type: "string", minLength: 1 },
          },
    },
    required: ["summary", "findings", "recommendations"],
  };
}

/**
 * Build an exact per-card JSON Schema for pi-subagents' `outputSchema`.
 * `dataPath`/`metaPath` are constants, so a Writer cannot point the parent at
 * another card or another session.
 */
export function buildWriterReturnSchema({ cardId, dataPath, metaPath }) {
  if (!cardId || !dataPath || !metaPath || !isAbsolute(dataPath) || !isAbsolute(metaPath)) {
    throw new Error("cardId, dataPath, and metaPath must be supplied as absolute per-card values");
  }
  const common = {
    cardId: { const: String(cardId) },
    analysis: analysisSchema(),
  };
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          ...common,
          fetchStatus: { const: "success" },
          dataPath: { const: dataPath },
          metaPath: { const: metaPath },
        },
        required: ["cardId", "fetchStatus", "dataPath", "metaPath", "analysis"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          cardId: { const: String(cardId) },
          fetchStatus: { const: "failed" },
          dataPath: { const: null },
          metaPath: { const: null },
          error: { type: "string", minLength: 1 },
          analysis: analysisSchema({ failure: true }),
        },
        required: ["cardId", "fetchStatus", "dataPath", "metaPath", "error", "analysis"],
      },
    ],
  };
}

/**
 * Model-facing parameters for the Writer's typed terminal tool.
 *
 * Assignment-specific card/path authority remains a runtime validation in
 * validateWriterReturn(), while this schema makes the direct success/failure
 * shape explicit without the extra structured_output.value wrapper.
 */
export function buildWriterSubmitSchema() {
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          cardId: { type: "string", minLength: 1 },
          fetchStatus: { const: "success" },
          dataPath: { type: "string", minLength: 1 },
          metaPath: { type: "string", minLength: 1 },
          analysis: analysisSchema(),
        },
        required: ["cardId", "fetchStatus", "dataPath", "metaPath", "analysis"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          cardId: { type: "string", minLength: 1 },
          fetchStatus: { const: "failed" },
          dataPath: { type: "null" },
          metaPath: { type: "null" },
          error: { type: "string", minLength: 1 },
          analysis: analysisSchema({ failure: true }),
        },
        required: ["cardId", "fetchStatus", "dataPath", "metaPath", "error", "analysis"],
      },
    ],
  };
}

/**
 * Normalize the only provider-dependent part of the typed tool transport.
 *
 * Some OpenAI-compatible relays occasionally serialize a nested object tool
 * argument as JSON text. Accept that transport form at the tool boundary, but
 * immediately restore it to an object; the persisted/parent return still goes
 * through the unchanged strict Writer schema and can never contain the string.
 */
export function normalizeWriterSubmitValue(value) {
  if (!isPlainObject(value)) return value;
  let normalized = value;
  if (typeof value.analysis === "string") {
    let analysis;
    try {
      analysis = JSON.parse(value.analysis);
    } catch (error) {
      throw new Error(`analysis string must contain one JSON object: ${error.message || error}`);
    }
    if (!isPlainObject(analysis)) {
      throw new Error("analysis string must contain one JSON object");
    }
    normalized = { ...normalized, analysis };
  }

  // Some OpenAI-compatible relays stringify JSON null tool arguments. Restore
  // only the exact, paired failed-branch transport form. Partial conversion,
  // other spellings, and every success payload remain invalid; the canonical
  // return still passes the unchanged strict schema and semantic validator.
  if (
    normalized.fetchStatus === "failed" &&
    normalized.dataPath === "null" &&
    normalized.metaPath === "null"
  ) {
    normalized = { ...normalized, dataPath: null, metaPath: null };
  }
  return normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validPointer(value) {
  return typeof value === "string" && /^entry\.json#(?:\/(?:[^~/]|~[01])*)*$/.test(value);
}

function validateAnalysis(analysis, { failure }, errors) {
  if (!isPlainObject(analysis) || !hasExactlyKeys(analysis, ["summary", "findings", "recommendations"])) {
    errors.push("analysis must contain only summary, findings, and recommendations");
    return;
  }
  if (typeof analysis.summary !== "string" || !analysis.summary.trim()) {
    errors.push("analysis.summary must be a non-empty string");
  }
  if (!Array.isArray(analysis.findings)) {
    errors.push("analysis.findings must be an array");
  } else if (failure && analysis.findings.length) {
    errors.push("a failed fetch must return no findings");
  } else if (!failure) {
    if (analysis.findings.length > 1) {
      errors.push("a successful Writer return may contain at most one finding");
    }
    for (const [index, finding] of analysis.findings.entries()) {
      if (!isPlainObject(finding) || !hasExactlyKeys(finding, ["statement", "evidence"])) {
        errors.push(`analysis.findings[${index}] must contain only statement and evidence`);
        continue;
      }
      if (typeof finding.statement !== "string" || !finding.statement.trim()) {
        errors.push(`analysis.findings[${index}].statement must be a non-empty string`);
      }
      if (!Array.isArray(finding.evidence) || finding.evidence.length !== 1 || !finding.evidence.every(validPointer)) {
        errors.push(`analysis.findings[${index}].evidence must contain exactly one entry.json row JSON Pointer`);
      }
    }
  }
  if (!Array.isArray(analysis.recommendations) || !analysis.recommendations.every((item) => typeof item === "string" && item.trim())) {
    errors.push("analysis.recommendations must be an array of non-empty strings");
  } else if (failure && analysis.recommendations.length) {
    errors.push("a failed fetch must return no recommendations");
  } else if (!failure && analysis.recommendations.length !== 1) {
    errors.push("a successful Writer return must contain exactly one recommendation");
  }
}

/**
 * Useful for local checks and tests. Runtime enforcement is the chain
 * `outputSchema`; this gives the parent the same semantic validation when it
 * needs to inspect a captured structured result.
 */
export function validateWriterReturn(value, expected) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["Writer return must be one JSON object"] };
  if (!expected?.cardId || !expected?.dataPath || !expected?.metaPath) {
    return { ok: false, errors: ["expected cardId, dataPath, and metaPath are required"] };
  }
  if (value.cardId !== String(expected.cardId)) errors.push("cardId does not match the assigned card");
  if (value.fetchStatus === "success") {
    if (!hasExactlyKeys(value, ["cardId", "fetchStatus", "dataPath", "metaPath", "analysis"])) {
      errors.push("successful Writer return has unexpected or missing fields");
    }
    if (value.dataPath !== expected.dataPath) errors.push("dataPath does not match this card's entry.json");
    if (value.metaPath !== expected.metaPath) errors.push("metaPath does not match this card's entry.meta.json");
    validateAnalysis(value.analysis, { failure: false }, errors);
  } else if (value.fetchStatus === "failed") {
    if (!hasExactlyKeys(value, ["cardId", "fetchStatus", "dataPath", "metaPath", "error", "analysis"])) {
      errors.push("failed Writer return has unexpected or missing fields");
    }
    if (value.dataPath !== null || value.metaPath !== null) errors.push("failed Writer return must use null dataPath and metaPath");
    if (typeof value.error !== "string" || !value.error.trim()) errors.push("failed Writer return requires a non-empty error");
    validateAnalysis(value.analysis, { failure: true }, errors);
  } else {
    errors.push('fetchStatus must be "success" or "failed"');
  }
  return { ok: errors.length === 0, errors };
}

/** Parse only a JSON document: no Markdown fences and no explanatory preface. */
export function parseWriterReturnText(text) {
  if (typeof text !== "string") throw new Error("Writer return must be text JSON");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Writer return must be one JSON object without prose: ${error.message || error}`);
  }
}

/** Derive the exact paths from the only allowed result.json input. */
export function writerReturnPathsForResult({ resultPath, cardId }) {
  const absResult = resolve(resultPath);
  return writerReturnPaths({ sessionDir: dirname(absResult), cardId });
}
