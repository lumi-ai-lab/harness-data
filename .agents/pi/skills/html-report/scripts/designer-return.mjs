/**
 * Report Designer's fixed structured-return and persisted-artifact contract.
 *
 * The parent extension derives every path from the current html-report
 * SESSION, replaces the caller's output schema, then validates both the
 * structured value and the authoritative `--phase html` layout before B5 can
 * complete.
 */
import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { checkSessionLayout } from "./check-session-layout.mjs";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalAbsolute(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function lineValue(text, label) {
  const match = String(text || "").match(
    new RegExp(`^${label}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s]+))\\s*$`, "m")
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function designerReturnPaths({ sessionDir }) {
  if (!sessionDir || !isAbsolute(sessionDir)) {
    throw new Error("sessionDir must be an absolute path");
  }
  const session = resolve(sessionDir);
  const reportDir = join(session, "report");
  return {
    sessionDir: session,
    resultPath: join(session, "result.json"),
    reportHtml: join(reportDir, "report.html"),
    renderMeta: join(reportDir, "render.meta.json"),
    designResult: join(reportDir, "design-result.json"),
    desktopScreenshot: join(reportDir, "screenshots", "desktop-1440x1000.png"),
    mobileScreenshot: join(reportDir, "screenshots", "mobile-390x844.png"),
  };
}

/** Pin the child assignment to the current SESSION and its exact result.json. */
export function designerExpectedFromAssignment(taskText, { sessionDir } = {}) {
  if (!sessionDir || !isAbsolute(sessionDir)) {
    return { error: "当前 html-report SESSION 绝对路径缺失。" };
  }
  const assignedSession = lineValue(taskText, "SESSION");
  const assignedResult = lineValue(taskText, "result\\.json");
  if (!assignedSession || !assignedResult) {
    return { error: "Report Designer task 必须分别包含 SESSION=<ABS> 与 result.json=<ABS>。" };
  }
  if (!canonicalAbsolute(assignedSession) || !canonicalAbsolute(assignedResult)) {
    return { error: "Report Designer task 的 SESSION/result.json 必须是无 dot-segment 的规范绝对路径。" };
  }
  let expected;
  try {
    expected = designerReturnPaths({ sessionDir });
  } catch (error) {
    return { error: `无法建立 Report Designer 路径契约：${error.message || error}` };
  }
  if (
    resolve(assignedSession) !== expected.sessionDir ||
    resolve(assignedResult) !== expected.resultPath
  ) {
    return { error: "Report Designer task 的 SESSION/result.json 必须属于当前 html-report session 的固定路径。" };
  }
  return expected;
}

function pathsSchema(expected) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      reportHtml: { const: expected.reportHtml },
      renderMeta: { const: expected.renderMeta },
      designResult: { const: expected.designResult },
      desktopScreenshot: { const: expected.desktopScreenshot },
      mobileScreenshot: { const: expected.mobileScreenshot },
    },
    required: [
      "reportHtml",
      "renderMeta",
      "designResult",
      "desktopScreenshot",
      "mobileScreenshot",
    ],
  };
}

function residualNotesSchema({ minItems = 0 } = {}) {
  return {
    type: "array",
    minItems,
    maxItems: 8,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 500 },
  };
}

/** Build the exact per-session schema owned by qdm-harness. */
export function buildDesignerReturnSchema(expected) {
  if (
    !expected ||
    !["reportHtml", "renderMeta", "designResult", "desktopScreenshot", "mobileScreenshot"]
      .every((key) => canonicalAbsolute(expected[key]))
  ) {
    throw new Error("Designer return paths must be canonical absolute paths");
  }
  const common = {
    paths: pathsSchema(expected),
    repairRounds: { type: "integer", minimum: 0, maximum: 2 },
    elapsedMs: { type: "integer", minimum: 0 },
  };
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { const: "ok" },
          ...common,
          layoutOk: { const: true },
          residualNotes: residualNotesSchema(),
        },
        required: ["status", "paths", "layoutOk", "repairRounds", "elapsedMs", "residualNotes"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { const: "failed" },
          ...common,
          layoutOk: { const: false },
          error: { type: "string", minLength: 1, maxLength: 1000 },
          residualNotes: residualNotesSchema({ minItems: 1 }),
        },
        required: [
          "status",
          "paths",
          "layoutOk",
          "repairRounds",
          "elapsedMs",
          "error",
          "residualNotes",
        ],
      },
    ],
  };
}

function validatePaths(value, expected, errors) {
  const keys = [
    "reportHtml",
    "renderMeta",
    "designResult",
    "desktopScreenshot",
    "mobileScreenshot",
  ];
  if (!hasExactlyKeys(value, keys)) {
    errors.push("paths must contain only the five fixed Designer artifact paths");
    return;
  }
  for (const key of keys) {
    if (value[key] !== expected[key]) errors.push(`paths.${key} does not match the current SESSION`);
  }
}

/** Validate semantic constraints in addition to pi-subagents' JSON Schema. */
export function validateDesignerReturn(value, expected) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["Designer return must be one JSON object"] };
  if (!expected?.sessionDir || !expected?.resultPath) {
    return { ok: false, errors: ["expected Designer SESSION paths are required"] };
  }
  const success = value.status === "ok";
  const failure = value.status === "failed";
  const topKeys = success
    ? ["status", "paths", "layoutOk", "repairRounds", "elapsedMs", "residualNotes"]
    : ["status", "paths", "layoutOk", "repairRounds", "elapsedMs", "error", "residualNotes"];
  if (!success && !failure) errors.push('status must be "ok" or "failed"');
  if (!hasExactlyKeys(value, topKeys)) errors.push("Designer return has unexpected or missing fields");
  validatePaths(value.paths, expected, errors);
  if (success && value.layoutOk !== true) errors.push("status=ok requires layoutOk=true");
  if (failure && value.layoutOk !== false) errors.push("status=failed requires layoutOk=false");
  if (!Number.isSafeInteger(value.repairRounds) || value.repairRounds < 0 || value.repairRounds > 2) {
    errors.push("repairRounds must be an integer from 0 to 2");
  }
  if (!Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0) {
    errors.push("elapsedMs must be a non-negative integer");
  }
  if (
    !Array.isArray(value.residualNotes) ||
    value.residualNotes.length > 8 ||
    value.residualNotes.some((note) => typeof note !== "string" || !note.trim() || note.length > 500) ||
    new Set(value.residualNotes).size !== value.residualNotes.length
  ) {
    errors.push("residualNotes must contain at most eight unique non-empty strings");
  }
  if (failure) {
    if (typeof value.error !== "string" || !value.error.trim() || value.error.length > 1000) {
      errors.push("status=failed requires a concise non-empty error");
    }
    if (!Array.isArray(value.residualNotes) || value.residualNotes.length === 0) {
      errors.push("status=failed requires at least one residual note");
    }
  }
  return { ok: errors.length === 0, errors };
}

async function missingArtifacts(expected) {
  const missing = [];
  for (const key of [
    "reportHtml",
    "renderMeta",
    "designResult",
    "desktopScreenshot",
    "mobileScreenshot",
  ]) {
    try {
      await access(expected[key]);
    } catch {
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Accept a failed structured terminal without pretending its artifacts exist;
 * accept status=ok only after all fixed files and phase-html layout pass.
 */
export async function validateDesignerArtifacts(
  value,
  expected,
  { layoutCheck = checkSessionLayout } = {}
) {
  const checked = validateDesignerReturn(value, expected);
  if (!checked.ok || value.status === "failed") return checked;
  const errors = [];
  const missing = await missingArtifacts(expected);
  if (missing.length) errors.push(`missing Designer artifacts: ${missing.join(", ")}`);
  let layout = null;
  if (!missing.length) {
    try {
      layout = await layoutCheck(expected.sessionDir, { phase: "html" });
      if (!layout?.ok) {
        errors.push(`phase html layout failed: ${(layout?.errors || ["unknown layout error"]).join("; ")}`);
      }
    } catch (error) {
      errors.push(`phase html layout threw: ${error.message || error}`);
    }
  }
  return { ok: errors.length === 0, errors, layout };
}

/** Parse only one JSON document: no Markdown fence or prose. */
export function parseDesignerReturnText(text) {
  if (typeof text !== "string") throw new Error("Designer return must be text JSON");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Designer return must be one JSON object without prose: ${error.message || error}`);
  }
}
