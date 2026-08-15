/**
 * Child-only Report Writer tools.
 *
 * The journalist calls ack_cli_data once, then submit_card_caption once.
 * Fetch failure writes the parent receipt and terminates. Fetch success
 * returns compact evidence; caption writes caption.md and the parent receipt.
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllEntries } from "../../skills/html-report/scripts/fetch-entry.mjs";
import {
  buildCaptionEvidence,
  persistCaptionEvidence,
  prepareCardCaptionEvidence,
} from "../../skills/html-report/scripts/prepare-card-caption-evidence.mjs";
import { writeCardCaption } from "../../skills/html-report/scripts/submit-card-caption.mjs";
import {
  buildWriterReturnSchema,
  sanitizeCardId,
  validateWriterReturn,
  WRITER_ACK_TOOL,
  WRITER_CAPTION_TOOL,
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
  let captionUsed = false;
  let acceptedReceipt = null;

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
    captionUsed = false;
    acceptedReceipt = null;
  }

  async function captureReceipt(receipt) {
    const capture = await prepareStructuredOutputCapture(buildWriterReturnSchema(contract));
    await writeStructuredOutputCapture(capture, receipt);
  }

  pi.on?.("before_agent_start", (event) => {
    contract = { ok: false, errors: ["等待从 child context 解析 Writer 任务"] };
    state = initialWriterGuardState();
    assignmentText = "";
    used = false;
    captionUsed = false;
    acceptedReceipt = null;
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
    state = writerUnvalidatedSubmitFailureState(contract, state, event);
    if (state.terminalFailure) pi.setActiveTools?.([]);
    return undefined;
  });

  pi.registerTool({
    name: WRITER_ACK_TOOL,
    label: "Ack CLI data",
    description:
      "Fetch the assigned html-report card through qdm-metric-cli, persist entry/meta, and return a compact topN/bottomN packet. Call exactly once. On success, next call submit_card_caption. Do not read files.",
    promptSnippet: "ack_cli_data: call once with assigned resultPath and cardId; on success, use the returned evidence and call submit_card_caption.",
    promptGuidelines: [
      "Call ack_cli_data exactly once with the assigned resultPath and cardId.",
      "On success, write the short caption from evidence.views only, then call submit_card_caption. Do not mention rowCount or 行数.",
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
      let resultPath;
      try {
        resultPath = await resolveAllowedResult(params.resultPath);
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
      if (receipt.fetchStatus !== "success") {
        await captureReceipt(receipt);
        pi.setActiveTools?.([]);
        return {
          content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }],
          details: receipt,
          terminate: true,
        };
      }

      let evidence;
      try {
        evidence = (await prepareCardCaptionEvidence({
          resultPath,
          cardId: params.cardId,
        })).evidence;
      } catch (error) {
        evidence = buildCaptionEvidence({
          cardId: sanitizeCardId(params.cardId),
          query: { metrics: [], dimensions: [], statisticPolicy: null, comparisons: [] },
          rows: [],
        });
        evidence.error = String(error?.message || error);
        await persistCaptionEvidence(contract.evidencePath, evidence);
      }
      acceptedReceipt = receipt;
      pi.setActiveTools?.([WRITER_CAPTION_TOOL]);
      const payload = { receipt, evidence };
      return {
        content: [{
          type: "text",
          text: [
            "取数成功。不要读 entry.json。只用下面 evidence.views 写本卡短分析，然后调用 submit_card_caption。",
            JSON.stringify(payload, null, 2),
          ].join("\n"),
        }],
        details: payload,
        terminate: false,
      };
    },
  });

  pi.registerTool({
    name: WRITER_CAPTION_TOOL,
    label: "Submit card caption",
    description:
      "Submit the short per-card analysis. Pass only paragraphs and /views/... pointers copied from the ack_cli_data evidence. The tool writes caption.md and the editor receipt.",
    promptSnippet: "submit_card_caption: after a successful ack_cli_data, call once with paragraphs and pointers from the compact evidence.",
    promptGuidelines: [
      "Cite only /views/... pointers from the evidence packet (not /evidence/views/...). You may cite every view in that packet.",
      "Every number in paragraphs must appear in the evidence packet views (any view, not only pointed-at nodes). Prefer the views digits; 万/亿元 of the same cell is allowed. Do not write 超/约/近 with a number that is not itself in the packet. Copy metric and dimension names from views; do not translate or guess Chinese labels.",
      "Do not read files or call structured_output.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        paragraphs: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1 },
        },
        pointers: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "JSON pointers into evidence.views; at most one per view in this card's packet",
        },
      },
      required: ["paragraphs", "pointers"],
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (captionUsed) throw new Error("submit_card_caption may be called only once per Report Writer assignment");
      captionUsed = true;
      if (!contract.ok) throw new Error("submit_card_caption has no parsed Writer assignment");
      if (!acceptedReceipt || acceptedReceipt.fetchStatus !== "success") {
        throw new Error("submit_card_caption requires a successful ack_cli_data in this assignment");
      }
      let captionResult;
      try {
        captionResult = await writeCardCaption({
          input: params,
          evidencePath: contract.evidencePath,
          captionPath: contract.captionPath,
        });
      } catch (error) {
        const failed = {
          cardId: contract.cardId,
          fetchStatus: "failed",
          dataPath: null,
          metaPath: null,
          error: String(error?.message || error || "submit_card_caption failed"),
        };
        await captureReceipt(failed);
        pi.setActiveTools?.([]);
        return {
          content: [{ type: "text", text: JSON.stringify(failed, null, 2) }],
          details: failed,
          terminate: true,
        };
      }
      const checked = validateWriterReturn(acceptedReceipt, contract);
      if (!checked.ok) {
        throw new Error(`Writer receipt is invalid: ${checked.errors.join("; ")}`);
      }
      await captureReceipt(acceptedReceipt);
      pi.setActiveTools?.([]);
      const violationCount = captionResult?.violations?.length || 0;
      const textParts = [JSON.stringify(acceptedReceipt, null, 2)];
      if (violationCount > 0) {
        textParts.unshift(
          `caption 已写入，但校验发现 ${violationCount} 条违规（已持久化到 violations.json，不阻断 Writer）。`,
        );
      }
      return {
        content: [{ type: "text", text: textParts.join("\n") }],
        details: acceptedReceipt,
        terminate: true,
      };
    },
  });
}

export * from "./lifecycle.mjs";
