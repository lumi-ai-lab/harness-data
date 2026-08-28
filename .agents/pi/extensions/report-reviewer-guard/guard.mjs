import { isAbsolute, join, relative, resolve } from "node:path";
import { htmlReportScriptCandidates, matchesHtmlReportScript } from "../shared/script-paths.mjs";

const FINAL_TOOLS = new Set(["structured_output", "structured-output"]);
const SUBMIT_TOOL = "submit_review_scorecard";
const VERDICT_SCRIPTS = htmlReportScriptCandidates(import.meta.url, "write-verdict.mjs");
const RUBRIC_IDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];
export const PARENT_REVIEWER_SCAN_MARKER = "PARENT QUALITY SCAN: passed with hardIssues=0.";
export const REVIEWER_INPUT_MAX_BYTES = 512 * 1024;

function allow(state) {
  return { decision: undefined, state };
}

function block(reason, state) {
  return {
    decision: { block: true, reason: `Report Reviewer guard：${reason}` },
    state,
  };
}

function textValue(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)'|`([\s\S]*)`)$/.exec(trimmed);
  return (quoted ? quoted[1] ?? quoted[2] ?? quoted[3] : trimmed).trim();
}

function assignmentValues(prompt, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(?:^|\\b)${escaped}\\s*=\\s*(.+?)\\s*$`, "i");
  return String(prompt || "")
    .split(/\r?\n/)
    .map((line) => matcher.exec(line)?.[1])
    .filter((value) => value !== undefined)
    .map(textValue);
}

function normalizedAbsolute(path) {
  return typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\0") &&
    isAbsolute(path) &&
    resolve(path) === path;
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Parse the self-contained B4 assignment and derive every path Reviewer may
 * touch. Prompt paths are assertions only; they never grant new authority.
 */
export function parseReviewerAssignment(prompt, { projectRoot } = {}) {
  const errors = [];
  const root = normalizedAbsolute(projectRoot) ? projectRoot : "";
  if (!root) errors.push("projectRoot 不是规范绝对路径");
  if (typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, errors: [...errors, "缺少子代理任务文本"] };
  }
  if (!prompt.includes(PARENT_REVIEWER_SCAN_MARKER)) {
    errors.push("任务缺少父扩展 hard=0 quality-scan 前置标记");
  }

  const sessionValues = assignmentValues(prompt, "SESSION");
  const resultValues = assignmentValues(prompt, "result.json");
  if (sessionValues.length !== 1) errors.push("任务必须且只能声明一次 SESSION");
  if (resultValues.length !== 1) errors.push("任务必须且只能声明一次 result.json");
  const sessionDir = sessionValues[0] || "";
  const resultPath = resultValues[0] || "";

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

  const contract = {
    ok: true,
    projectRoot: root,
    sessionDir,
    resultPath,
    scanPath: join(sessionDir, "quality", "scan.json"),
    reportPath: join(sessionDir, "quality", "report.md"),
    verdictPath: join(sessionDir, "quality", "verdict.json"),
    draftPath: join(sessionDir, "quality", "verdict.draft.json"),
    candidateReportPath: join(sessionDir, "report", "report.md"),
    renderManifestPath: join(sessionDir, "report", "render-manifest.json"),
    rubricPath: join(root, "docs", "html-report-quality-rubric.md"),
  };

  for (const [label, path] of Object.entries(contract)) {
    if (!label.endsWith("Path")) continue;
    if (!normalizedAbsolute(path)) errors.push(`${label} 不是规范绝对路径`);
    if (label !== "rubricPath" && !pathInside(sessionDir, path)) {
      errors.push(`${label} 逃逸 SESSION`);
    }
  }

  // Optional explicit path assertions are accepted only when they repeat a
  // path derived above. `reportPath` has historically named either the frozen
  // report being reviewed or the generated quality report, so accept exactly
  // those two SESSION-owned paths without granting any redirect authority.
  for (const [label, expectedValues] of [
    ["scanPath", [contract.scanPath]],
    ["reportPath", [contract.candidateReportPath, contract.reportPath]],
    ["verdictPath", [contract.verdictPath]],
  ]) {
    const values = assignmentValues(prompt, label);
    if (values.length > 1) errors.push(`任务最多声明一次 ${label}`);
    if (values.length === 1 && !expectedValues.includes(values[0])) {
      errors.push(`${label} 与 SESSION 固定输入/输出路径不一致`);
    }
  }

  return errors.length ? { ok: false, errors } : contract;
}

export function initialReviewerGuardState() {
  return {
    reads: {},
    readSuccess: {},
    writes: {},
    writeSuccess: {},
    commands: {},
    commandSuccess: {},
    submissions: {},
    submissionSuccess: false,
    submissionReturn: null,
    pending: {},
    terminalFailure: null,
    structuredAttempts: 0,
  };
}

function increment(record, key) {
  return { ...record, [key]: (record[key] || 0) + 1 };
}

function eventPath(input) {
  if (!input || typeof input !== "object") return "";
  return textValue(input.path ?? input.filePath ?? input.file_path);
}

function eventContent(input) {
  if (!input || typeof input !== "object") return "";
  return typeof input.content === "string" ? input.content : "";
}

function tokenizeStandaloneShell(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  // A shell line continuation is semantically whitespace and appears in
  // Markdown command examples. Normalize only that exact safe form; reject
  // every other newline, substitution, NUL, or shell composition primitive.
  const normalized = command.replace(/\\\r?\n[ \t]*/g, " ");
  if (/[\r\n\0`$]/.test(normalized)) return null;
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let tokenStarted = false;

  for (const char of normalized.trim()) {
    if (escaped) {
      token += char;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      continue;
    }
    if (/[;&|<>]/.test(char)) return null;
    token += char;
    tokenStarted = true;
  }
  if (escaped || quote) return null;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function optionsFrom(tokens, start, valueOptions) {
  const values = {};
  for (let index = start; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (!valueOptions.has(flag) || Object.hasOwn(values, flag) || index + 1 >= tokens.length) return null;
    if (tokens[index + 1].startsWith("--")) return null;
    values[flag] = tokens[index + 1];
    index += 1;
  }
  return values;
}

/** Return the only legacy stamping command; parent owns quality-scan. */
export function classifyReviewerCommand(command, contract) {
  if (!contract?.ok) return null;
  const tokens = tokenizeStandaloneShell(command);
  if (!tokens || tokens[0] !== "node") return null;

  if (matchesHtmlReportScript(tokens[1], VERDICT_SCRIPTS)) {
    const options = optionsFrom(tokens, 2, new Set(["--result", "--verdict-file"]));
    if (
      options &&
      Object.keys(options).length === 2 &&
      options["--result"] === contract.resultPath &&
      options["--verdict-file"] === contract.draftPath
    ) return { kind: "stamp", failedStep: "stamp" };
  }
  return null;
}

function requiredReviewReads(contract) {
  return [
    contract.resultPath,
    contract.candidateReportPath,
    contract.renderManifestPath,
    contract.rubricPath,
    contract.scanPath,
  ];
}

function missingSuccessfulReads(contract, state) {
  return requiredReviewReads(contract).filter((path) => !state.readSuccess[path]);
}

function validDraft(content) {
  let draft;
  try {
    draft = JSON.parse(content);
  } catch (error) {
    return { ok: false, reason: `verdict.draft.json 不是有效 JSON：${error.message || error}` };
  }
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { ok: false, reason: "verdict.draft.json 必须是 JSON object" };
  }
  if (typeof draft.pass !== "boolean") return { ok: false, reason: "draft.pass 必须是 boolean" };
  if (!draft.scores || typeof draft.scores !== "object" || Array.isArray(draft.scores)) {
    return { ok: false, reason: "draft.scores 必须包含 R1–R7" };
  }
  for (const id of RUBRIC_IDS) {
    const cell = draft.scores[id];
    if (
      !cell ||
      typeof cell !== "object" ||
      !Number.isInteger(cell.score) ||
      cell.score < 0 ||
      cell.score > 2 ||
      cell.max !== 2
    ) {
      return { ok: false, reason: `draft.scores.${id} 必须使用 score=0|1|2、max=2` };
    }
  }
  if (!Array.isArray(draft.hardBlockers) || !Array.isArray(draft.issues)) {
    return { ok: false, reason: "draft.hardBlockers 与 draft.issues 必须是数组" };
  }
  return { ok: true };
}

function structuredValue(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.value && typeof input.value === "object" && !Array.isArray(input.value)) return input.value;
  return input;
}

function exactReturnPaths(value, contract) {
  return value?.sessionDir === contract.sessionDir &&
    value?.resultPath === contract.resultPath &&
    value?.scanPath === contract.scanPath &&
    value?.reportPath === contract.reportPath &&
    value?.verdictPath === contract.verdictPath;
}

function validateInfrastructureReturn(value, contract, failure) {
  if (!value || value.status !== "infrastructure_error") return "失败后只允许 status=infrastructure_error";
  if (value.pass !== false || value.total !== 0 || value.maxTotal !== 14) {
    return "infrastructure_error 必须使用 pass=false、total=0、maxTotal=14";
  }
  if (!exactReturnPaths(value, contract)) return "infrastructure_error 必须返回 assignment 推导出的固定绝对路径";
  if (value.failedStep !== failure.failedStep) {
    return `infrastructure_error.failedStep 必须是 ${failure.failedStep}`;
  }
  if (typeof value.error !== "string" || !value.error.trim()) return "infrastructure_error.error 不能为空";
  if (value.error.trim() !== String(failure.error || "").trim()) {
    return "infrastructure_error.error 必须原样复制 guard 捕获的错误，不得自行改写或误诊";
  }
  if (
    !Array.isArray(value.repairHints) ||
    value.repairHints.length === 0 ||
    !value.repairHints.every((hint) => typeof hint === "string" && hint.trim())
  ) return "infrastructure_error.repairHints 至少包含一条具体动作";
  return "";
}

function validateNormalReturn(value, contract) {
  if (!value || !new Set(["passed", "failed"]).has(value.status)) {
    return "成功路径 structured_output.status 必须是 passed 或 failed";
  }
  if ((value.status === "passed") !== (value.pass === true)) {
    return "status 必须仅在 pass=true 时为 passed";
  }
  if (!Number.isInteger(value.total) || value.total < 0 || value.total > 14 || value.maxTotal !== 14) {
    return "structured_output total/maxTotal 不符合 0–14 契约";
  }
  if (!exactReturnPaths(value, contract)) return "structured_output 必须返回 assignment 推导出的固定绝对路径";
  if (!Array.isArray(value.repairHints) || (value.status === "failed" && value.repairHints.length === 0)) {
    return "failed 结果必须包含 repairHints";
  }
  return "";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
    if (Number.isInteger(details[key]) && details[key] !== 0) return true;
  }
  return false;
}

function conciseError(event, fallback) {
  const text = resultText(event).trim().replace(/\s+/g, " ");
  return (text || fallback).slice(0, 1200);
}

function currentFailedStep(contract, state) {
  if (missingSuccessfulReads(contract, state).length) return "read";
  if (state.submissions[SUBMIT_TOOL] && !state.submissionSuccess) return "write";
  if (!state.writeSuccess[contract.draftPath]) return "write";
  if (!state.commandSuccess.stamp) return "stamp";
  if (!state.readSuccess[contract.verdictPath]) return "read";
  return "write";
}

function terminalBlock(contract, state, reason, failedStep = currentFailedStep(contract, state)) {
  const next = state.terminalFailure
    ? state
    : { ...state, terminalFailure: { failedStep, error: reason } };
  return block(`${reason}；当前 run 已终止，只允许一次匹配 failedStep=${next.terminalFailure.failedStep} 的 structured_output infrastructure_error`, next);
}

function pendingKey(event, operation) {
  return String(event?.toolCallId || `<unknown:${operation.kind}:${operation.path || "command"}>`);
}

function addPending(state, event, operation) {
  const key = pendingKey(event, operation);
  if (state.pending[key]) return null;
  return { ...state, pending: { ...state.pending, [key]: operation } };
}

/**
 * Pure tool-call transition. Every filesystem/command attempt is one-shot;
 * policy violations enter the same terminal fail-fast state as runtime errors.
 */
export function reviewerToolDecision(contract, state, event) {
  const current = state || initialReviewerGuardState();
  const toolName = String(event?.toolName || "").toLowerCase();

  if (!contract?.ok) {
    return block(`任务契约解析失败，已 fail closed：${contract?.errors?.join("；") || "unknown error"}`, current);
  }

  if (FINAL_TOOLS.has(toolName)) {
    if (current.structuredAttempts > 0) return block("structured_output 最多调用一次", current);
    const next = { ...current, structuredAttempts: current.structuredAttempts + 1 };
    const value = structuredValue(event?.input);
    if (current.terminalFailure) {
      const error = validateInfrastructureReturn(value, contract, current.terminalFailure);
      return error ? block(error, next) : allow(next);
    }
    const missing = [];
    if (Object.keys(current.pending).length) missing.push("pending tool results");
    if (current.submissionSuccess) {
      if (!current.submissionReturn) missing.push("typed scorecard result");
      if (missing.length) return block(`structured_output 过早，尚缺：${missing.join("、")}`, next);
      const error = validateNormalReturn(value, contract);
      if (error) return block(error, next);
      if (canonicalJson(value) !== canonicalJson(current.submissionReturn)) {
        return block("structured_output 必须原样复制 submit_review_scorecard 返回的 reviewerReturn", next);
      }
      return allow(next);
    }
    if (missingSuccessfulReads(contract, current).length) missing.push("fixed review reads");
    if (!current.writeSuccess[contract.draftPath]) missing.push("verdict draft write");
    if (!current.commandSuccess.stamp) missing.push("write-verdict success");
    if (!current.readSuccess[contract.verdictPath]) missing.push("stamped verdict read");
    if (!current.writeSuccess[contract.reportPath]) missing.push("quality report write");
    if (missing.length) return block(`structured_output 过早，尚缺：${missing.join("、")}`, next);
    const error = validateNormalReturn(value, contract);
    return error ? block(error, next) : allow(next);
  }

  if (current.structuredAttempts > 0) {
    return block("structured_output 已调用；禁止其后的任何 I/O、命令或其他工具", current);
  }

  if (current.terminalFailure) {
    return block(`run 已因 ${current.terminalFailure.failedStep} 失败终止；禁止后续 I/O、命令或重试，只允许 structured_output infrastructure_error`, current);
  }

  if (toolName === SUBMIT_TOOL) {
    if (current.submissions[SUBMIT_TOOL]) {
      return terminalBlock(contract, current, "submit_review_scorecard 最多调用一次，不允许重试", "write");
    }
    if (missingSuccessfulReads(contract, current).length) {
      return terminalBlock(contract, current, "submit_review_scorecard 前必须完成父级 scan 标记约束下的全部固定读取", "write");
    }
    if (
      Object.keys(current.writes).length ||
      current.commands.stamp ||
      current.reads[contract.verdictPath]
    ) {
      return terminalBlock(contract, current, "typed scorecard 路径禁止与旧 draft/stamp/report 流程混用", "write");
    }
    const withPending = addPending(current, event, {
      kind: SUBMIT_TOOL,
      type: SUBMIT_TOOL,
      failedStep: "write",
    });
    if (!withPending) return terminalBlock(contract, current, "submit_review_scorecard toolCallId 重复", "write");
    return allow({ ...withPending, submissions: increment(current.submissions, SUBMIT_TOOL) });
  }

  if (toolName === "bash") {
    const classified = classifyReviewerCommand(event?.input?.command, contract);
    if (!classified) {
      return terminalBlock(
        contract,
        current,
        "父扩展已完成 quality-scan；Reviewer 禁止 Bash。assemble、check-session-layout、重复 scan、write-verdict、cat、临时 Node/Python、ls/find/grep 与 shell 组合均禁止"
      );
    }
    const { kind, failedStep } = classified;
    if (current.commands[kind]) {
      return terminalBlock(contract, current, `${kind} 固定命令最多调用一次，不允许失败重试`, failedStep);
    }
    if (kind === "stamp" && !current.writeSuccess[contract.draftPath]) {
      return terminalBlock(contract, current, "write-verdict 前必须成功写入固定 verdict.draft.json", "stamp");
    }
    const withPending = addPending(current, event, { kind, type: "command", failedStep });
    if (!withPending) return terminalBlock(contract, current, `${kind} toolCallId 重复`, failedStep);
    return allow({ ...withPending, commands: increment(current.commands, kind) });
  }

  if (toolName === "read") {
    const path = eventPath(event?.input);
    const reviewPaths = requiredReviewReads(contract);
    const verdictRead = path === contract.verdictPath;
    if (!normalizedAbsolute(path) || (!reviewPaths.includes(path) && !verdictRead)) {
      return terminalBlock(
        contract,
        current,
        "read 只能访问固定 result、assembled report、render manifest、rubric、scan 与 stamped verdict；禁止扫描 data、analysis、临时目录或源码",
        "read"
      );
    }
    if (verdictRead && !current.commandSuccess.stamp) {
      return terminalBlock(contract, current, "只能在 write-verdict 成功后读取固定 verdict.json", "read");
    }
    if (current.reads[path]) return terminalBlock(contract, current, `固定文件最多读取一次：${path}`, "read");
    const withPending = addPending(current, event, { kind: "read", type: "read", path, failedStep: "read" });
    if (!withPending) return terminalBlock(contract, current, "read toolCallId 重复", "read");
    return allow({ ...withPending, reads: increment(current.reads, path) });
  }

  if (toolName === "write") {
    const path = eventPath(event?.input);
    if (![contract.draftPath, contract.reportPath].includes(path)) {
      return terminalBlock(contract, current, "write 只能写一次固定 verdict.draft.json 与一次固定 quality/report.md", "write");
    }
    if (current.writes[path]) return terminalBlock(contract, current, `固定产物最多写一次：${path}`, "write");
    const content = eventContent(event?.input);
    if (path === contract.draftPath) {
      const missing = missingSuccessfulReads(contract, current);
      if (missing.length) {
        return terminalBlock(contract, current, `写 verdict draft 前尚未成功读取：${missing.join("、")}`, "write");
      }
      const checked = validDraft(content);
      if (!checked.ok) return terminalBlock(contract, current, checked.reason, "write");
    } else {
      if (!current.readSuccess[contract.verdictPath]) {
        return terminalBlock(contract, current, "写 quality/report.md 前必须成功读取 stamped verdict.json", "write");
      }
      if (!content.trim()) return terminalBlock(contract, current, "quality/report.md 不能为空", "write");
    }
    const withPending = addPending(current, event, { kind: "write", type: "write", path, failedStep: "write" });
    if (!withPending) return terminalBlock(contract, current, "write toolCallId 重复", "write");
    return allow({ ...withPending, writes: increment(current.writes, path) });
  }

  return terminalBlock(
    contract,
    current,
    `禁止目录扫描、编辑、召回、协调或其他未授权工具：${toolName || "unknown"}`
  );
}

/** Record success/failure of the exact one-shot operation authorized above. */
export function reviewerToolResultState(contract, state, event) {
  const current = state || initialReviewerGuardState();
  if (!contract?.ok || current.terminalFailure) return current;
  const toolName = String(event?.toolName || "").toLowerCase();
  if (FINAL_TOOLS.has(toolName)) return current;

  const requestedKey = String(event?.toolCallId || "");
  let key = requestedKey && current.pending[requestedKey] ? requestedKey : "";
  if (!key && !requestedKey) {
    const candidates = Object.entries(current.pending).filter(([, operation]) => operation.type === toolName ||
      (toolName === "bash" && operation.type === "command"));
    if (candidates.length === 1) key = candidates[0][0];
  }
  const operation = key ? current.pending[key] : null;
  if (!operation) return current;

  const pending = { ...current.pending };
  delete pending[key];
  const next = { ...current, pending };
  if (resultFailed(event)) {
    return {
      ...next,
      terminalFailure: {
        failedStep: operation.failedStep,
        error: conciseError(event, `${operation.kind} operation failed`),
      },
    };
  }

  if (operation.type === "command") {
    return { ...next, commandSuccess: { ...next.commandSuccess, [operation.kind]: true } };
  }
  if (operation.type === "read") {
    return { ...next, readSuccess: increment(next.readSuccess, operation.path) };
  }
  if (operation.type === SUBMIT_TOOL) {
    let reviewerReturn = event?.details?.reviewerReturn;
    if (!reviewerReturn || typeof reviewerReturn !== "object" || Array.isArray(reviewerReturn)) {
      try {
        reviewerReturn = JSON.parse(resultText(event));
      } catch {
        reviewerReturn = null;
      }
    }
    const error = validateNormalReturn(reviewerReturn, contract);
    if (error) {
      return {
        ...next,
        terminalFailure: { failedStep: "write", error: `submit_review_scorecard 返回非法：${error}` },
      };
    }
    return { ...next, submissionSuccess: true, submissionReturn: reviewerReturn };
  }
  return { ...next, writeSuccess: increment(next.writeSuccess, operation.path) };
}
