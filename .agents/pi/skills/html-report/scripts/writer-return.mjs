/**
 * Report Writer's small, machine-checkable return contract.
 *
 * ack_cli_data returns this receipt and writes the same object to the
 * parent-owned outputSchema capture. The editor LLM never authors the schema.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const WRITER_ACK_TOOL = "ack_cli_data";
export const WRITER_CAPTION_TOOL = "submit_card_caption";

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
    columnMetaPath: join(cardDir, "entry.column-meta.json"),
    evidencePath: join(cardDir, "caption-evidence.json"),
    captionPath: join(cardDir, "caption.md"),
  };
}

/** Programmatic outputSchema for the ack_cli_data receipt. */
export function buildWriterReturnSchema({ cardId, dataPath, metaPath }) {
  if (!cardId || !dataPath || !metaPath || !isAbsolute(dataPath) || !isAbsolute(metaPath)) {
    throw new Error("cardId, dataPath, and metaPath must be supplied as absolute per-card values");
  }
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          cardId: { const: String(cardId) },
          fetchStatus: { const: "success" },
          dataPath: { const: dataPath },
          metaPath: { const: metaPath },
          rowCount: { type: "integer", minimum: 0 },
          rowsSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: ["cardId", "fetchStatus", "dataPath", "metaPath", "rowCount", "rowsSha256"],
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
        },
        required: ["cardId", "fetchStatus", "dataPath", "metaPath", "error"],
      },
    ],
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function asReceiptCandidate(value) {
  if (!isPlainObject(value)) return null;
  if (value.fetchStatus !== "success" && value.fetchStatus !== "failed") return null;
  return value;
}

function receiptFromToolMessage(message) {
  if (!isPlainObject(message)) return null;
  const role = String(message.role || "");
  if (role !== "toolResult" && role !== "tool") return null;
  const toolName = String(message.toolName || message.name || "").toLowerCase();
  if (toolName !== WRITER_ACK_TOOL && toolName !== WRITER_CAPTION_TOOL) return null;
  const fromDetails = asReceiptCandidate(message.details);
  if (fromDetails) return fromDetails;
  const text = messageText(message.content) || (typeof message.text === "string" ? message.text : "");
  if (!text.trim()) return null;
  try {
    return asReceiptCandidate(JSON.parse(text));
  } catch {
    return null;
  }
}

function extractWriterReceiptFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const direct = receiptFromToolMessage(message);
    if (direct) return direct;
    if (isPlainObject(message) && isPlainObject(message.message)) {
      const nested = receiptFromToolMessage(message.message);
      if (nested) return nested;
    }
  }
  return null;
}

function extractWriterReceiptFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl")) {
    return null;
  }
  let text;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip a damaged line and keep looking for a later ack.
    }
  }
  return extractWriterReceiptFromMessages(records);
}

/** Read the last ack_cli_data tool result from a pi-subagents child result. */
export function extractWriterReceipt(result) {
  if (!isPlainObject(result)) return null;
  const fromMessages = extractWriterReceiptFromMessages(result.messages);
  if (fromMessages) return fromMessages;
  const transcriptPath = typeof result.transcriptPath === "string"
    ? result.transcriptPath
    : (isPlainObject(result.artifactPaths) && typeof result.artifactPaths.transcriptPath === "string"
      ? result.artifactPaths.transcriptPath
      : "");
  return extractWriterReceiptFromTranscript(transcriptPath);
}

export function isWriterEmptyOutputError(error) {
  return typeof error === "string" && /produced no output/i.test(error);
}

/** Semantic check for the ack_cli_data receipt the parent lifted from the child. */
export function validateWriterReturn(value, expected) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["Writer return must be one JSON object"] };
  if (!expected?.cardId || !expected?.dataPath || !expected?.metaPath) {
    return { ok: false, errors: ["expected cardId, dataPath, and metaPath are required"] };
  }
  if (value.cardId !== String(expected.cardId)) errors.push("cardId does not match the assigned card");
  if (value.fetchStatus === "success") {
    if (!hasExactlyKeys(value, ["cardId", "fetchStatus", "dataPath", "metaPath", "rowCount", "rowsSha256"])) {
      errors.push("successful Writer return has unexpected or missing fields");
    }
    if (value.dataPath !== expected.dataPath) errors.push("dataPath does not match this card's entry.json");
    if (value.metaPath !== expected.metaPath) errors.push("metaPath does not match this card's entry.meta.json");
    if (!Number.isSafeInteger(value.rowCount) || value.rowCount < 0) {
      errors.push("successful Writer return requires a non-negative rowCount");
    }
    if (typeof value.rowsSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.rowsSha256)) {
      errors.push("successful Writer return requires a 64-character rowsSha256");
    }
  } else if (value.fetchStatus === "failed") {
    if (!hasExactlyKeys(value, ["cardId", "fetchStatus", "dataPath", "metaPath", "error"])) {
      errors.push("failed Writer return has unexpected or missing fields");
    }
    if (value.dataPath !== null || value.metaPath !== null) errors.push("failed Writer return must use null dataPath and metaPath");
    if (typeof value.error !== "string" || !value.error.trim()) errors.push("failed Writer return requires a non-empty error");
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

/** Derive the caption.md path from an entry.json data path. */
export function captionPathFor(dataPath) {
  return String(dataPath || "").replace(/entry\.json$/, "caption.md");
}
