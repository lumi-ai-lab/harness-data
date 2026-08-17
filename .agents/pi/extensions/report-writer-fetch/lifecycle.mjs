import { isAbsolute, join, relative, resolve } from "node:path";
import {
  sanitizeCardId,
  writerReturnPaths,
  WRITER_ACK_TOOL,
  WRITER_CAPTION_TOOL,
} from "../../skills/html-report/scripts/writer-return.mjs";

export { WRITER_ACK_TOOL, WRITER_ACK_TOOL as WRITER_FETCH_TOOL, WRITER_CAPTION_TOOL };

function allow(state) {
  return { decision: undefined, state };
}

function block(reason, state) {
  return {
    decision: { block: true, reason: `Report Writer guard：${reason}` },
    state,
  };
}

function textValue(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)'|`([\s\S]*)`)$/.exec(trimmed);
  return (quoted ? quoted[1] ?? quoted[2] ?? quoted[3] : trimmed).trim();
}

function normalizedAbsolute(path) {
  return typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\0") &&
    isAbsolute(path) &&
    resolve(path) === path;
}

function assignmentLineValues(prompt, pattern) {
  return String(prompt || "")
    .split(/\r?\n/)
    .map((line) => pattern.exec(line)?.[1])
    .filter((value) => value !== undefined)
    .map(textValue);
}

/** Parse the self-contained B2 child assignment and derive its only paths. */
export function parseWriterAssignment(prompt, { projectRoot } = {}) {
  const errors = [];
  const root = normalizedAbsolute(projectRoot) ? projectRoot : "";
  if (!root) errors.push("projectRoot 不是规范绝对路径");
  if (typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, errors: [...errors, "缺少子代理任务文本"] };
  }

  const cardValues = assignmentLineValues(
    prompt,
    /^\s*.*\breport-writer\b.*\bcardId\s*=\s*([^\s`"']+)\s*$/i
  );
  const sessionValues = assignmentLineValues(prompt, /^\s*SESSION\s*=\s*(.+?)\s*$/i);
  const resultValues = assignmentLineValues(prompt, /^\s*result\.json\s*=\s*(.+?)\s*$/i);
  if (cardValues.length !== 1) errors.push("任务必须且只能在 report-writer 指派行声明一次 cardId");
  if (sessionValues.length !== 1) errors.push("任务必须且只能声明一次 SESSION");
  if (resultValues.length !== 1) errors.push("任务必须且只能声明一次 result.json");

  const cardId = cardValues[0] || "";
  const sessionDir = sessionValues[0] || "";
  const resultPath = resultValues[0] || "";
  if (!cardId) errors.push("cardId 不能为空");
  try {
    if (cardId && (sanitizeCardId(cardId) !== cardId || cardId === "." || cardId === "..")) {
      errors.push("cardId 必须是安全且无需改写的路径段");
    }
  } catch {
    errors.push("cardId 不是安全路径段");
  }
  if (!normalizedAbsolute(sessionDir)) errors.push("SESSION 不是规范绝对路径");
  if (!normalizedAbsolute(resultPath)) errors.push("result.json 不是规范绝对路径");

  const sessionRoot = root ? join(root, ".harness", "state", "html-report") : "";
  if (sessionRoot && normalizedAbsolute(sessionDir)) {
    const rel = relative(sessionRoot, sessionDir);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) {
      errors.push("SESSION 必须是当前项目 html-report 根下的单一 session 目录");
    }
  }
  const expectedResult = normalizedAbsolute(sessionDir) ? join(sessionDir, "result.json") : "";
  if (resultPath && expectedResult && resultPath !== expectedResult) {
    errors.push("result.json 与 SESSION 不一致");
  }
  if (errors.length) return { ok: false, errors };

  const paths = writerReturnPaths({ sessionDir, cardId });
  return {
    ok: true,
    projectRoot: root,
    sessionDir,
    resultPath,
    cardId,
    dataPath: paths.dataPath,
    metaPath: paths.metaPath,
    evidencePath: paths.evidencePath,
    captionPath: paths.captionPath,
  };
}

export function initialWriterGuardState() {
  return {
    fetchAttempts: 0,
    captionAttempts: 0,
    captionFailures: 0,
    lastCaptionFailId: null,
    pending: {},
    fetchResult: null,
    captionSubmitted: false,
    terminalFailure: null,
    structuredAttempts: 0,
  };
}

export const WRITER_CAPTION_RETRY_LIMIT = 1;

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function pendingKey(event, fallbackTool) {
  return String(event?.toolCallId || `<unknown:${fallbackTool}>`);
}

function fetchReceiptFromEvent(event) {
  const details = event?.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    if (details.fetchStatus === "success" || details.fetchStatus === "failed") return details;
    if (details.receipt && typeof details.receipt === "object") return details.receipt;
  }
  return null;
}

function captionInputShape(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  if (!keys.includes("paragraphs")) return false;
  return keys.every((key) => key === "paragraphs" || key === "pointers");
}

/** Ack once, then caption once; one incomplete/schema caption retry is allowed. */
export function writerToolDecision(contract, state, event) {
  const current = state || initialWriterGuardState();
  const toolName = String(event?.toolName || "").toLowerCase();

  if (!contract?.ok) {
    return block(`任务契约解析失败，已 fail closed：${contract?.errors?.join("；") || "unknown error"}`, current);
  }
  if (
    current.terminalFailure ||
    current.captionSubmitted ||
    current.captionFailures > WRITER_CAPTION_RETRY_LIMIT
  ) {
    return block("submit_card_caption 最多调用一次；禁止其它工具或重试", current);
  }
  if (current.fetchResult?.fetchStatus === "failed") {
    return block("ack_cli_data 已失败，禁止其它工具", current);
  }

  if (!current.fetchResult) {
    if (current.fetchAttempts > 0) {
      return block("ack_cli_data 最多调用一次；禁止其它工具或重试", current);
    }
    if (toolName !== WRITER_ACK_TOOL) {
      return block(`先调用 ack_cli_data 一次，禁止 ${toolName || "unknown"}`, current);
    }
    const input = event?.input;
    if (
      !input || typeof input !== "object" || Array.isArray(input) ||
      input.resultPath !== contract.resultPath || input.cardId !== contract.cardId ||
      !exactKeys(input, ["resultPath", "cardId"])
    ) {
      return block("ack_cli_data 参数必须逐字等于 assignment 的 result.json 与 cardId", current);
    }
    const key = pendingKey(event, WRITER_ACK_TOOL);
    if (current.pending[key]) return block("ack_cli_data toolCallId 重复", current);
    return allow({
      ...current,
      fetchAttempts: 1,
      pending: { ...current.pending, [key]: { type: WRITER_ACK_TOOL } },
    });
  }

  if (toolName !== WRITER_CAPTION_TOOL) {
    return block(`取数成功后只允许调用 submit_card_caption 一次，禁止 ${toolName || "unknown"}`, current);
  }
  const input = event?.input;
  if (!captionInputShape(input)) {
    return block("submit_card_caption 只接受 paragraphs，pointers 可省略", current);
  }
  const key = pendingKey(event, WRITER_CAPTION_TOOL);
  if (current.pending[key]) return block("submit_card_caption toolCallId 重复", current);
  return allow({
    ...current,
    captionAttempts: current.captionAttempts + 1,
    structuredAttempts: Math.max(1, current.structuredAttempts),
    pending: { ...current.pending, [key]: { type: WRITER_CAPTION_TOOL } },
  });
}

function resultText(event) {
  if (typeof event?.content === "string") return event.content;
  if (!Array.isArray(event?.content)) return "";
  return event.content
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function conciseError(event, fallback) {
  const detailsError = typeof event?.details?.error === "string" ? event.details.error : "";
  const text = (detailsError || resultText(event) || fallback).trim().replace(/\s+/g, " ");
  return text.slice(0, 1200);
}

function withCaptionFailure(current, error, toolCallId) {
  const failId = String(toolCallId || "");
  if (failId && current.lastCaptionFailId === failId) return current;
  const captionFailures = (current.captionFailures || 0) + 1;
  const next = {
    ...current,
    captionFailures,
    lastCaptionFailId: failId || current.lastCaptionFailId || null,
  };
  if (captionFailures > WRITER_CAPTION_RETRY_LIMIT) {
    return {
      ...next,
      terminalFailure: current.terminalFailure || { error },
    };
  }
  return next;
}

/** Record the fetch or caption result. Capture/terminate happens in the tool. */
export function writerToolResultState(contract, state, event) {
  const current = state || initialWriterGuardState();
  if (!contract?.ok) return current;
  const toolName = String(event?.toolName || "").toLowerCase();
  if (toolName !== WRITER_ACK_TOOL && toolName !== WRITER_CAPTION_TOOL) return current;
  const key = String(event?.toolCallId || "");
  const pending = { ...current.pending };
  if (key) delete pending[key];
  const next = { ...current, pending };
  if (toolName === WRITER_CAPTION_TOOL && event?.details && event.details.captionRetry === true) {
    return withCaptionFailure(next, conciseError(event, "submit_card_caption 未受理，可再交一次"), event?.toolCallId);
  }
  if (event?.isError === true) {
    if (toolName === WRITER_CAPTION_TOOL && current.fetchResult?.fetchStatus === "success") {
      return withCaptionFailure(next, conciseError(event, "submit_card_caption failed"), event?.toolCallId);
    }
    return {
      ...next,
      terminalFailure: {
        error: conciseError(event, toolName === WRITER_CAPTION_TOOL ? "submit_card_caption failed" : "ack_cli_data failed"),
      },
    };
  }
  if (toolName === WRITER_CAPTION_TOOL) {
    return { ...next, captionSubmitted: true };
  }
  return { ...next, fetchResult: fetchReceiptFromEvent(event) };
}

/** Schema-invalid fetch is terminal. First schema-invalid caption is retryable. */
export function writerUnvalidatedSubmitFailureState(contract, state, event) {
  const current = state || initialWriterGuardState();
  const toolName = String(event?.toolName || "").toLowerCase();
  if (event?.isError !== true || !contract?.ok) return current;
  const errorEvent = event?.result && typeof event.result === "object"
    ? event.result
    : event;
  if (toolName === WRITER_ACK_TOOL && current.fetchAttempts === 0) {
    return {
      ...current,
      fetchAttempts: 1,
      terminalFailure: current.terminalFailure || {
        error: conciseError(errorEvent, "ack_cli_data 参数校验失败；首次取数机会已消费"),
      },
    };
  }
  if (toolName === WRITER_CAPTION_TOOL && current.fetchResult?.fetchStatus === "success") {
    return withCaptionFailure(
      {
        ...current,
        captionAttempts: Math.max(1, current.captionAttempts),
        structuredAttempts: Math.max(1, current.structuredAttempts),
      },
      conciseError(errorEvent, "submit_card_caption 参数校验失败；可再交一次"),
      event?.toolCallId,
    );
  }
  return current;
}

/** Backward-compatible direct guard used by older focused tests. */
export function writerCoordinationDecision(event) {
  if (!["contact_supervisor", "intercom"].includes(String(event?.toolName || "").toLowerCase())) {
    return undefined;
  }
  return {
    block: true,
    reason: "Report Writer 不允许进入 supervisor/intercom 等待；只调用 ack_cli_data 与 submit_card_caption。",
  };
}
