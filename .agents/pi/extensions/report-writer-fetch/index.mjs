/**
 * Child-only Report Writer tools.
 *
 * The journalist calls ack_cli_data once, then submit_card_caption.
 * One incomplete/schema caption retry is allowed. Fetch failure writes the
 * parent receipt and terminates. Fetch success returns compact evidence;
 * caption writes caption.md and the parent receipt.
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
import {
  CAPTION_MAX_PARAGRAPH_CHARS,
  captionCitesDataNumber,
  captionParagraphLimitError,
  loadCaptionEvidence,
  normalizeCaptionToolInput,
  writeCardCaption,
} from "../../skills/html-report/scripts/submit-card-caption.mjs";
import {
  buildWriterReturnSchema,
  sanitizeCardId,
  validateWriterReturn,
  WRITER_ACK_TOOL,
  WRITER_CAPTION_TOOL,
} from "../../skills/html-report/scripts/writer-return.mjs";
import {
  handoffOfficialStructuredOutput,
  prepareStructuredOutputCapture,
} from "../shared/subagent-structured-output-capture.mjs";
import {
  initialWriterGuardState,
  parseWriterAssignment,
  WRITER_CAPTION_RETRY_LIMIT,
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

function asCaptionRejected(message) {
  const text = String(message || "submit_card_caption failed").trim();
  return text.startsWith("caption rejected:") ? text : `caption rejected: ${text}`;
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

  async function finishWithReceipt(receipt) {
    await prepareStructuredOutputCapture(buildWriterReturnSchema(contract));
    return handoffOfficialStructuredOutput(pi, receipt, { receipt });
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
    if (state.finalizedReceipt) pi.setActiveTools?.(["structured_output"]);
    else if (state.terminalFailure) pi.setActiveTools?.([]);
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
      "Do not read files, do not retry, and do not call submit_writer_result. After a failed receipt, call structured_output once with that exact object.",
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
        return finishWithReceipt(receipt);
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
      "Submit the short per-card analysis. Pass paragraphs; pointers may be omitted and are filled from evidence.views. The tool writes caption.md and the editor receipt.",
    promptSnippet: "submit_card_caption: after a successful ack_cli_data, call with paragraphs. pointers are optional.",
    promptGuidelines: [
      "Pass paragraphs only if you want; pointers are optional and filled from evidence.views when omitted.",
      "Cite only /views/... pointers from the evidence packet (not /evidence/views/...). You may cite every view in that packet.",
      "Every number in paragraphs must appear in the evidence packet views (any view, not only pointed-at nodes). Prefer the views digits; 万/亿元 of the same cell is allowed. Do not write 超/约/近 with a number that is not itself in the packet. Copy metric and dimension names from views; do not translate or guess Chinese labels.",
      `Each paragraph must be at most ${CAPTION_MAX_PARAGRAPH_CHARS} characters. If the first submit is rejected as incomplete or too long, split or complete paragraphs and call once more. Do not read files. After a successful or failed receipt, call structured_output once with that exact object.`,
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        paragraphs: {
          anyOf: [
            {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { type: "string", minLength: 1 },
            },
            { type: "string", minLength: 1 },
          ],
        },
        pointers: {
          anyOf: [
            { type: "array", items: { type: "string", minLength: 1 } },
            { type: "string", minLength: 1 },
          ],
          description: "Optional JSON pointers into evidence.views; omitted or empty pointers are filled from the packet",
        },
      },
      required: ["paragraphs"],
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (captionUsed) throw new Error("submit_card_caption may be called only once per Report Writer assignment");
      if (!contract.ok) throw new Error("submit_card_caption has no parsed Writer assignment");
      if (!acceptedReceipt || acceptedReceipt.fetchStatus !== "success") {
        throw new Error("submit_card_caption requires a successful ack_cli_data in this assignment");
      }
      let evidence;
      try {
        evidence = await loadCaptionEvidence(contract.evidencePath);
      } catch (error) {
        throw new Error(String(error?.message || error || "caption evidence is missing"));
      }
      const normalized = normalizeCaptionToolInput(params, evidence);
      const limitError = normalized.ok
        ? captionParagraphLimitError(normalized.input.paragraphs)
        : "";
      const retryableError = !normalized.ok
        ? normalized.error
        : limitError
          || (captionCitesDataNumber(normalized.input.paragraphs, evidence)
            ? ""
            : "段落里没有 evidence 中的数据数字，像是半截交稿");
      if (retryableError) {
        if (state.captionFailures >= WRITER_CAPTION_RETRY_LIMIT) {
          const failed = {
            cardId: contract.cardId,
            fetchStatus: "failed",
            dataPath: null,
            metaPath: null,
            error: asCaptionRejected(retryableError),
          };
          return finishWithReceipt(failed);
        }
        return {
          content: [{
            type: "text",
            text: `submit_card_caption 未受理：${retryableError}。拆短（每段不超过 ${CAPTION_MAX_PARAGRAPH_CHARS} 字）或补全后只再调用一次；pointers 可省略。`,
          }],
          details: { captionRetry: true, error: retryableError },
          terminate: false,
        };
      }
      captionUsed = true;
      let captionResult;
      try {
        captionResult = await writeCardCaption({
          input: normalized.input,
          evidencePath: contract.evidencePath,
          captionPath: contract.captionPath,
        });
      } catch (error) {
        const failed = {
          cardId: contract.cardId,
          fetchStatus: "failed",
          dataPath: null,
          metaPath: null,
          error: asCaptionRejected(error?.message || error || "submit_card_caption failed"),
        };
        return finishWithReceipt(failed);
      }
      const checked = validateWriterReturn(acceptedReceipt, contract);
      if (!checked.ok) {
        throw new Error(`Writer receipt is invalid: ${checked.errors.join("; ")}`);
      }
      const handed = await finishWithReceipt(acceptedReceipt);
      const violationCount = captionResult?.violations?.length || 0;
      if (violationCount > 0) {
        handed.content[0].text = [
          `caption 已写入，但校验发现 ${violationCount} 条违规（已持久化到 violations.json，不阻断 Writer）。`,
          handed.content[0].text,
        ].join("\n");
      }
      return handed;
    },
  });
}

export * from "./lifecycle.mjs";
