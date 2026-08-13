/**
 * Child-only Report Writer tool.
 *
 * The journalist may call ack_cli_data exactly once. The adapter writes
 * entry/meta and writes that same receipt to the parent-owned outputSchema
 * capture. The child never authors the schema or the JSON.
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllEntries } from "../../skills/html-report/scripts/fetch-entry.mjs";
import {
  buildWriterReturnSchema,
  sanitizeCardId,
  validateWriterReturn,
  WRITER_ACK_TOOL,
} from "../../skills/html-report/scripts/writer-return.mjs";
import {
  prepareStructuredOutputCapture,
  writeStructuredOutputCapture,
} from "../shared/subagent-structured-output-capture.mjs";
import {
  initialWriterGuardState,
  parseWriterAssignment,
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

export function receiptFor(card) {
  if (card.fetchStatus === "success") {
    return {
      cardId: card.cardId,
      fetchStatus: "success",
      dataPath: card.dataPath,
      metaPath: card.metaPath,
      rowCount: card.rowCount,
      rowsSha256: card.rowsSha256,
    };
  }
  return {
    cardId: card.cardId,
    fetchStatus: "failed",
    dataPath: null,
    metaPath: null,
    error: card.error || "fetch failed",
  };
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
    used = false;
  }

  pi.on?.("before_agent_start", (event) => {
    contract = { ok: false, errors: ["等待从 child context 解析 Writer 任务"] };
    state = initialWriterGuardState();
    assignmentText = "";
    used = false;
    captureAssignment(event);
    pi.setActiveTools?.([WRITER_ACK_TOOL]);
    return undefined;
  });

  pi.on?.("context", (event) => {
    captureAssignment(event);
    return undefined;
  });

  pi.on?.("tool_call", (event) => {
    const transition = writerToolDecision(contract, state, event);
    state = transition.state;
    return transition.decision;
  });

  pi.on?.("tool_result", (event) => {
    state = writerToolResultState(contract, state, event);
    return undefined;
  });

  pi.on?.("tool_execution_end", (event) => {
    const previousAttempts = state.structuredAttempts;
    state = writerUnvalidatedSubmitFailureState(contract, state, event);
    if (previousAttempts === 0 && state.structuredAttempts === 1) {
      pi.setActiveTools?.([]);
    }
    return undefined;
  });

  pi.registerTool({
    name: WRITER_ACK_TOOL,
    label: "Ack CLI data",
    description:
      "Fetch the assigned html-report card through qdm-metric-cli, persist entry/meta, and return that receipt. Call exactly once. Do not read files or call any other tool.",
    promptSnippet: "ack_cli_data: the only Writer tool; call once with assigned resultPath and cardId; its return is the editor receipt.",
    promptGuidelines: [
      "Call ack_cli_data exactly once with the assigned resultPath and cardId.",
      "Do not read files, do not retry, and do not call submit_writer_result or structured_output.",
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
      if (used) throw new Error("ack_cli_data may be called only once per Report Writer assignment");
      used = true;
      if (
        !contract.ok ||
        params.resultPath !== contract.resultPath ||
        params.cardId !== contract.cardId
      ) {
        throw new Error("ack_cli_data parameters do not match the parsed Report Writer assignment");
      }

      let receipt;
      try {
        const resultPath = await resolveAllowedResult(params.resultPath);
        const output = await fetchAllEntries(resultPath, { cardId: params.cardId });
        if (!Array.isArray(output.cards) || output.cards.length !== 1) {
          throw new Error("ack_cli_data expected exactly one assigned card result");
        }
        const card = output.cards[0];
        if (card.cardId !== sanitizeCardId(params.cardId)) {
          throw new Error("ack_cli_data returned a different card");
        }
        receipt = receiptFor(card);
      } catch (error) {
        receipt = {
          cardId: params.cardId,
          fetchStatus: "failed",
          dataPath: null,
          metaPath: null,
          error: String(error?.message || error || "fetch failed"),
        };
      }

      const checked = validateWriterReturn(receipt, contract);
      if (!checked.ok) {
        throw new Error(`Writer receipt is invalid: ${checked.errors.join("; ")}`);
      }
      const capture = await prepareStructuredOutputCapture(buildWriterReturnSchema(contract));
      await writeStructuredOutputCapture(capture, receipt);
      return {
        content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }],
        details: receipt,
        terminate: true,
      };
    },
  });
}

export * from "./lifecycle.mjs";
