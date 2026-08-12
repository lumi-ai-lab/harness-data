/**
 * Child-only Report Writer tool.
 *
 * This deliberately replaces the Writer's general bash capability with one
 * operation: fetch exactly one confirmed card using the deterministic B2
 * adapter.  The tool's process-local single-use guard prevents a Writer from
 * issuing a second recall/query during the same assignment.
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllEntries } from "../../skills/html-report/scripts/fetch-entry.mjs";
import {
  buildWriterReturnSchema,
  buildWriterSubmitSchema,
  normalizeWriterSubmitValue,
  sanitizeCardId,
  validateWriterReturn,
} from "../../skills/html-report/scripts/writer-return.mjs";
import {
  prepareStructuredOutputCapture,
  writeStructuredOutputCapture,
} from "../shared/subagent-structured-output-capture.mjs";
import {
  initialWriterGuardState,
  parseWriterAssignment,
  WRITER_SUBMIT_TOOL,
  writerUnvalidatedSubmitFailureState,
  writerToolDecision,
  writerToolResultState,
} from "./lifecycle.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const sessionRoot = resolve(projectRoot, ".harness", "state", "html-report");

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(",")}}`;
}

async function resolveAllowedResult(resultPath) {
  if (typeof resultPath !== "string" || !isAbsolute(resultPath)) {
    throw new Error("resultPath must be an absolute session result.json path");
  }
  const absResult = resolve(resultPath);
  if (basename(absResult) !== "result.json" || dirname(dirname(absResult)) !== sessionRoot) {
    throw new Error("resultPath must be $PROJECT/.harness/state/html-report/<session>/result.json");
  }
  const [realRoot, realResult] = await Promise.all([realpath(sessionRoot), realpath(absResult)]);
  if (!isInside(realRoot, realResult) || basename(realResult) !== "result.json") {
    throw new Error("resultPath resolves outside the html-report session directory");
  }
  return realResult;
}

function outputFor(card) {
  const base = {
    cardId: card.cardId,
    fetchStatus: card.fetchStatus,
    dataPath: card.dataPath,
    metaPath: card.metaPath,
  };
  if (card.fetchStatus === "success") {
    return { ...base, rowCount: card.rowCount, rowsSha256: card.rowsSha256 };
  }
  return { ...base, error: card.error || "fetch failed" };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function writerAssignmentText(event) {
  if (typeof event === "string") return event;
  if (!event || typeof event !== "object") return "";
  for (const key of ["prompt", "input", "text", "message"]) {
    if (typeof event[key] === "string" && event[key].trim()) return event[key];
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    const text = messageText(messages[index].content);
    if (text.trim()) return text;
  }
  return "";
}

export default function registerReportWriterFetch(pi) {
  let contract = { ok: false, errors: ["before_agent_start 尚未解析 Writer 任务"] };
  let state = initialWriterGuardState();
  let assignmentText = "";
  let used = false;
  let submitted = false;
  let authorizedSubmit = "";

  function captureAssignment(event) {
    const text = writerAssignmentText(event).trim();
    if (!text || text === assignmentText) return;
    if (assignmentText) {
      contract = { ok: false, errors: ["同一 Writer run 出现冲突的第二份 assignment"] };
      state = {
        ...state,
        terminalFailure: state.terminalFailure || { error: "assignment changed after capture" },
      };
      return;
    }
    assignmentText = text;
    contract = parseWriterAssignment(text, { projectRoot });
    state = initialWriterGuardState();
    submitted = false;
    authorizedSubmit = "";
  }

  pi.on?.("before_agent_start", (event) => {
    contract = { ok: false, errors: ["等待从 child context 解析 Writer 任务"] };
    state = initialWriterGuardState();
    assignmentText = "";
    used = false;
    submitted = false;
    authorizedSubmit = "";
    captureAssignment(event);
    // The typed terminal owns the same parent-provided outputSchema capture,
    // so the generic structured_output wrapper is unnecessary and hidden.
    pi.setActiveTools?.(["read", "fetch_report_entry", WRITER_SUBMIT_TOOL]);
    return undefined;
  });

  // The assigned task is normally the last user message in child context.
  pi.on?.("context", (event) => {
    captureAssignment(event);
    return undefined;
  });

  pi.on?.("tool_call", (event) => {
    const transition = writerToolDecision(contract, state, event);
    state = transition.state;
    if (
      String(event?.toolName || "").toLowerCase() === WRITER_SUBMIT_TOOL &&
      !transition.decision
    ) {
      authorizedSubmit = canonicalJson(normalizeWriterSubmitValue(event.input));
    }
    return transition.decision;
  });

  pi.on?.("tool_result", (event) => {
    state = writerToolResultState(contract, state, event);
    return undefined;
  });

  // As with Researcher typed submit, core validates arguments before
  // tool_call. A schema-invalid first attempt is still terminal and cannot be
  // corrected into a hidden retry.
  pi.on?.("tool_execution_end", (event) => {
    const previousAttempts = state.structuredAttempts;
    state = writerUnvalidatedSubmitFailureState(contract, state, event);
    if (previousAttempts === 0 && state.structuredAttempts === 1) {
      // A core schema error never reaches tool_call, so guard state alone
      // cannot intercept another equally malformed attempt. Remove every tool
      // at this boundary: the child now fails closed and cannot enter a repair,
      // I/O, or resubmission chain.
      pi.setActiveTools?.([]);
    }
    return undefined;
  });

  pi.registerTool({
    name: "fetch_report_entry",
    label: "Fetch report entry",
    description: "Fetch exactly one assigned html-report card through analysis execute --meta. Call once, then only read its entry.json and entry.meta.json.",
    promptSnippet: "fetch_report_entry: the only Writer fetch; accepts absolute resultPath and assigned cardId; call once.",
    promptGuidelines: [
      "Use fetch_report_entry exactly once before reading this card's returned entry.json or entry.meta.json.",
      "Do not use it for another card or retry it; report its failure through submit_writer_result instead.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        resultPath: { type: "string", description: "Absolute $SESSION/result.json path" },
        cardId: { type: "string", minLength: 1, description: "The assigned, confirmed card id" },
      },
      required: ["resultPath", "cardId"],
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (used) throw new Error("fetch_report_entry may be called only once per Report Writer assignment");
      used = true;
      if (
        !contract.ok ||
        params.resultPath !== contract.resultPath ||
        params.cardId !== contract.cardId
      ) {
        throw new Error("fetch_report_entry parameters do not match the parsed Report Writer assignment");
      }
      const resultPath = await resolveAllowedResult(params.resultPath);
      const output = await fetchAllEntries(resultPath, { cardId: params.cardId });
      if (!Array.isArray(output.cards) || output.cards.length !== 1) {
        throw new Error("fetch_report_entry expected exactly one assigned card result");
      }
      const card = output.cards[0];
      if (card.cardId !== sanitizeCardId(params.cardId)) {
        throw new Error("fetch_report_entry returned a different card");
      }
      const value = outputFor(card);
      return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        details: value,
      };
    },
  });

  pi.registerTool({
    name: WRITER_SUBMIT_TOOL,
    label: "Submit Writer result",
    description: "Validate and capture the assigned Writer return directly, then terminate the child. Call exactly once after the fixed fetch/read sequence.",
    promptSnippet: "submit_writer_result: direct typed Writer terminal; pass the return object itself, without a value wrapper.",
    promptGuidelines: [
      "After the authorized reads, call submit_writer_result exactly once as the only tool in its assistant message.",
      "Pass cardId, fetchStatus, paths, and analysis directly; do not wrap them in value and do not call structured_output.",
    ],
    parameters: buildWriterSubmitSchema(),
    // Keep the public tool schema strict. Some OpenAI-compatible relays encode
    // a nested object argument as JSON text; Pi runs this transport shim before
    // schema validation, after which every guard/capture sees the canonical
    // object form only.
    prepareArguments(args) {
      return normalizeWriterSubmitValue(args);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (submitted) throw new Error("submit_writer_result may be called only once per Report Writer assignment");
      submitted = true;
      if (!contract.ok) {
        throw new Error("Report Writer assignment is unavailable for typed submit");
      }
      const normalized = normalizeWriterSubmitValue(params);
      if (!authorizedSubmit || authorizedSubmit !== canonicalJson(normalized)) {
        throw new Error("submit_writer_result was not authorized by the Writer guard");
      }
      const checked = validateWriterReturn(normalized, contract);
      if (!checked.ok) {
        throw new Error(`Writer return is invalid: ${checked.errors.join("; ")}`);
      }
      const capture = await prepareStructuredOutputCapture(
        buildWriterReturnSchema(contract)
      );
      const structuredOutputPath = await writeStructuredOutputCapture(capture, normalized);
      return {
        content: [{ type: "text", text: "Writer result committed; structured output captured." }],
        details: { writerReturn: normalized, structuredOutputPath },
        terminate: true,
      };
    },
  });
}

export * from "./lifecycle.mjs";
