import { isAbsolute, join, relative, resolve } from "node:path";
import {
  sanitizeCardId,
  writerReturnPaths,
} from "../../skills/html-report/scripts/writer-return.mjs";

export const WRITER_SUBMIT_TOOL = "submit_writer_result";
const FINAL_TOOLS = new Set([WRITER_SUBMIT_TOOL]);
const FAILURE_ANALYSIS = {
  summary: "取数失败，未形成业务判断。",
  findings: [],
  recommendations: [],
};

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
  };
}

export function initialWriterGuardState() {
  return {
    fetchAttempts: 0,
    reads: {},
    readSuccess: {},
    pending: {},
    fetchResult: null,
    terminalFailure: null,
    structuredAttempts: 0,
  };
}

/** Consume a typed Writer submit rejected by core schema validation. */
export function writerUnvalidatedSubmitFailureState(contract, state, event) {
  const current = state || initialWriterGuardState();
  if (
    String(event?.toolName || "").toLowerCase() !== WRITER_SUBMIT_TOOL ||
    event?.isError !== true ||
    !contract?.ok ||
    current.structuredAttempts !== 0
  ) {
    return current;
  }
  const errorEvent = event?.result && typeof event.result === "object"
    ? event.result
    : event;
  return {
    ...current,
    structuredAttempts: 1,
    terminalFailure: current.terminalFailure || {
      error: conciseError(errorEvent, "submit_writer_result 参数校验失败；首次提交机会已消费"),
    },
  };
}

function increment(record, key) {
  return { ...record, [key]: (record[key] || 0) + 1 };
}

function eventPath(input) {
  if (!input || typeof input !== "object") return "";
  return textValue(input.path ?? input.filePath ?? input.file_path);
}

function structuredValue(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.value && typeof input.value === "object" && !Array.isArray(input.value)) return input.value;
  return input;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validFailureReturn(value, contract, expectedError = "") {
  if (!value || value.cardId !== contract.cardId || value.fetchStatus !== "failed") {
    return "失败返回必须绑定 assignment cardId 且 fetchStatus=failed";
  }
  if (value.dataPath !== null || value.metaPath !== null) return "失败返回的 dataPath/metaPath 必须为 null";
  if (typeof value.error !== "string" || !value.error.trim()) return "失败返回 error 不能为空";
  if (expectedError && value.error !== expectedError) {
    return "失败返回 error 必须逐字等于 guard 已记录的真实终端错误";
  }
  if (!exactKeys(value.analysis, ["summary", "findings", "recommendations"])) {
    return "失败返回 analysis 必须是固定三字段对象";
  }
  if (
    value.analysis.summary !== FAILURE_ANALYSIS.summary ||
    !Array.isArray(value.analysis.findings) || value.analysis.findings.length !== 0 ||
    !Array.isArray(value.analysis.recommendations) || value.analysis.recommendations.length !== 0
  ) return "失败返回 analysis 必须使用固定无业务判断内容";
  return "";
}

function validSuccessReturn(value, contract) {
  if (!value || value.cardId !== contract.cardId || value.fetchStatus !== "success") {
    return "成功返回必须绑定 assignment cardId 且 fetchStatus=success";
  }
  if (value.metaPath !== contract.metaPath || value.dataPath !== contract.dataPath) {
    return "成功返回必须使用 fetch 结果绑定的固定 metaPath/dataPath";
  }
  return "";
}

function terminalBlock(state, reason) {
  const next = state.terminalFailure
    ? state
    : { ...state, terminalFailure: { error: reason } };
  return block(`${reason}；当前 run 已终止，只允许一次匹配的 submit_writer_result fetchStatus=failed`, next);
}

function pendingKey(event, operation) {
  return String(event?.toolCallId || `<unknown:${operation.type}:${operation.path || "fetch"}>`);
}

function addPending(state, event, operation) {
  const key = pendingKey(event, operation);
  if (state.pending[key]) return null;
  return { ...state, pending: { ...state.pending, [key]: operation } };
}

function isQueuedDataRead(contract, state, event) {
  if (!state.fetchResult || String(event?.toolName || "").toLowerCase() !== "read") return false;
  if (eventPath(event?.input) !== contract.dataPath) return false;
  if (state.reads[contract.metaPath] !== 1 || state.reads[contract.dataPath]) return false;
  const pending = Object.values(state.pending);
  return pending.length === 1 &&
    pending[0]?.type === "read" &&
    pending[0]?.path === contract.metaPath;
}

/** Pure fail-fast Writer tool-call transition. */
export function writerToolDecision(contract, state, event) {
  const current = state || initialWriterGuardState();
  const toolName = String(event?.toolName || "").toLowerCase();

  if (FINAL_TOOLS.has(toolName)) {
    if (current.structuredAttempts > 0) return block("submit_writer_result 最多调用一次", current);
    const next = { ...current, structuredAttempts: current.structuredAttempts + 1 };
    if (!contract?.ok) {
      return block(`任务契约解析失败，无法验证 submit_writer_result：${contract?.errors?.join("；") || "unknown error"}`, next);
    }
    const value = structuredValue(event?.input);
    if (current.terminalFailure) {
      const error = validFailureReturn(value, contract, current.terminalFailure.error);
      return error ? block(error, next) : allow(next);
    }
    if (Object.keys(current.pending).length) return block("工具结果尚未返回，submit_writer_result 过早", next);
    if (!current.fetchResult || !current.readSuccess[contract.metaPath] || !current.readSuccess[contract.dataPath]) {
      return block("成功 submit_writer_result 前必须完成一次 fetch、metaPath read、dataPath read", next);
    }
    const error = validSuccessReturn(value, contract);
    return error ? block(error, next) : allow(next);
  }

  if (!contract?.ok) {
    return block(`任务契约解析失败，已 fail closed：${contract?.errors?.join("；") || "unknown error"}`, current);
  }
  if (current.structuredAttempts > 0) {
    return block("submit_writer_result 已调用；禁止其后的任何 I/O、协调或其他工具", current);
  }
  if (current.terminalFailure) {
    return block("run 已失败终止；禁止后续 I/O、协调或重试，只允许 submit_writer_result fetchStatus=failed", current);
  }
  // Pi may emit the two immutable, assignment-bound reads in one assistant
  // message. Queue only the exact dataPath read behind the already-authorized
  // metaPath read; every other overlapping or interleaved call still fails.
  if (Object.keys(current.pending).length && !isQueuedDataRead(contract, current, event)) {
    return terminalBlock(current, "上一工具结果尚未返回，禁止并行或穿插调用");
  }

  if (toolName === "fetch_report_entry") {
    if (current.fetchAttempts > 0) return terminalBlock(current, "fetch_report_entry 最多调用一次，禁止重试");
    const input = event?.input;
    if (
      !input || typeof input !== "object" || Array.isArray(input) ||
      input.resultPath !== contract.resultPath || input.cardId !== contract.cardId ||
      !exactKeys(input, ["resultPath", "cardId"])
    ) return terminalBlock(current, "fetch_report_entry 参数必须逐字等于 assignment 的 result.json 与 cardId");
    const withPending = addPending(current, event, { type: "fetch_report_entry" });
    if (!withPending) return terminalBlock(current, "fetch_report_entry toolCallId 重复");
    return allow({ ...withPending, fetchAttempts: 1 });
  }

  if (toolName === "read") {
    if (!current.fetchResult) return terminalBlock(current, "read 必须在唯一 fetch_report_entry 成功后执行");
    const path = eventPath(event?.input);
    const expected = !current.reads[contract.metaPath] ? contract.metaPath : contract.dataPath;
    if (path !== expected) {
      return terminalBlock(current, `read 顺序固定为 metaPath 后 dataPath；当前只允许 ${expected}`);
    }
    if (current.reads[path]) return terminalBlock(current, `固定文件最多读取一次：${path}`);
    const withPending = addPending(current, event, { type: "read", path });
    if (!withPending) return terminalBlock(current, "read toolCallId 重复");
    return allow({ ...withPending, reads: increment(current.reads, path) });
  }

  return terminalBlock(
    current,
    `禁止其他 read、目录扫描、协调、召回、命令或未授权工具：${toolName || "unknown"}`
  );
}

function resultText(event) {
  if (typeof event?.content === "string") return event.content;
  if (!Array.isArray(event?.content)) return "";
  return event.content
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function resultFailed(event) {
  if (event?.isError === true) return true;
  const details = event?.details;
  if (!details || typeof details !== "object") return false;
  for (const key of ["exitCode", "code", "statusCode"]) {
    const value = details[key];
    if (value === undefined || value === null || value === 0 || value === "0" || value === "") continue;
    return true;
  }
  return false;
}

function conciseError(event, fallback) {
  const detailsError = typeof event?.details?.error === "string" ? event.details.error : "";
  const text = (detailsError || resultText(event) || fallback).trim().replace(/\s+/g, " ");
  return text.slice(0, 1200);
}

function matchingPending(state, event) {
  const requestedKey = String(event?.toolCallId || "");
  const toolName = String(event?.toolName || "").toLowerCase();
  if (requestedKey && state.pending[requestedKey]) {
    const operation = state.pending[requestedKey];
    return operation.type === toolName ? [requestedKey, operation] : ["", null];
  }
  if (requestedKey) return ["", null];
  const candidates = Object.entries(state.pending).filter(([, operation]) => operation.type === toolName);
  return candidates.length === 1 ? candidates[0] : ["", null];
}

function validFetchDetails(details, contract) {
  return details && typeof details === "object" && !Array.isArray(details) &&
    details.fetchStatus === "success" &&
    details.cardId === contract.cardId &&
    details.metaPath === contract.metaPath &&
    details.dataPath === contract.dataPath &&
    Number.isSafeInteger(details.rowCount) && details.rowCount >= 0 &&
    typeof details.rowsSha256 === "string" && /^[a-f0-9]{64}$/i.test(details.rowsSha256);
}

/** Record the exact one-shot fetch/read result; any failure is terminal. */
export function writerToolResultState(contract, state, event) {
  const current = state || initialWriterGuardState();
  if (!contract?.ok || current.terminalFailure || current.structuredAttempts > 0) return current;
  if (FINAL_TOOLS.has(String(event?.toolName || "").toLowerCase())) return current;
  const [key, operation] = matchingPending(current, event);
  if (!operation) {
    return { ...current, terminalFailure: { error: "收到无法匹配已授权调用的 tool_result" } };
  }
  const pending = { ...current.pending };
  delete pending[key];
  const next = { ...current, pending };
  if (resultFailed(event)) {
    return { ...next, terminalFailure: { error: conciseError(event, `${operation.type} failed`) } };
  }

  if (operation.type === "fetch_report_entry") {
    if (event?.details?.fetchStatus === "failed") {
      return {
        ...next,
        terminalFailure: { error: conciseError(event, event.details.error || "fetch_report_entry returned failed") },
      };
    }
    if (!validFetchDetails(event?.details, contract)) {
      return { ...next, terminalFailure: { error: "fetch_report_entry 返回未绑定 assignment 的路径/cardId/meta" } };
    }
    return { ...next, fetchResult: { ...event.details } };
  }
  return { ...next, readSuccess: increment(next.readSuccess, operation.path) };
}

/** Backward-compatible direct guard used by older focused tests. */
export function writerCoordinationDecision(event) {
  if (!["contact_supervisor", "intercom"].includes(String(event?.toolName || "").toLowerCase())) {
    return undefined;
  }
  return {
    block: true,
    reason: "Report Writer 不允许进入 supervisor/intercom 等待；请直接按固定 schema 提交 submit_writer_result。",
  };
}
