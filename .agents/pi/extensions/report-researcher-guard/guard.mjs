import { isAbsolute, join, relative, resolve } from "node:path";
import {
  validateResearcherAnalysisRequirements,
  validateResearcherCompletionContent,
  validateResearcherReturn,
} from "../../skills/html-report/scripts/researcher-return.mjs";
import { canonicalizeJson } from "../../skills/html-report/scripts/prepare-research-evidence.mjs";
import {
  EDITOR_PLANNER_MARKER,
  isEditorPlannerAssignment,
} from "../../skills/html-report/scripts/editor-plan-contract.mjs";
import { htmlReportScriptCandidates, matchesHtmlReportScript } from "../shared/script-paths.mjs";

export const RESEARCHER_SUBMIT_TOOL = "submit_research_findings";
const RESEARCHER_TOOLS = new Set(["read", "write", "bash", RESEARCHER_SUBMIT_TOOL]);
const FINAL_TOOLS = new Set(["structured_output", "structured-output"]);
const FETCH_SCRIPTS = htmlReportScriptCandidates(import.meta.url, "fetch-explore.mjs");
const PREPARE_SCRIPTS = htmlReportScriptCandidates(import.meta.url, "prepare-research-evidence.mjs");
const MAX_RECALLED_SPEC_PATHS = 2;

function block(reason, state) {
  return {
    decision: { block: true, reason: `Report Researcher guard：${reason}` },
    state,
  };
}

function allow(state) {
  return { decision: undefined, state };
}

function textValue(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)'|`([\s\S]*)`)$/.exec(trimmed);
  return (quoted ? quoted[1] ?? quoted[2] ?? quoted[3] : trimmed).trim();
}

function lineValue(prompt, pattern) {
  const match = pattern.exec(prompt);
  return match ? textValue(match[1]) : "";
}

function extractTaskObject(prompt) {
  const label = "完整 task 对象:";
  const startLabel = prompt.indexOf(label);
  if (startLabel < 0) return null;
  const start = prompt.indexOf("{", startLabel + label.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < prompt.length; index += 1) {
    const char = prompt[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(prompt.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizedAbsolute(path) {
  return typeof path === "string" && isAbsolute(path) && resolve(path) === path && !path.includes("\0");
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeTaskId(taskId) {
  return String(taskId || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "task";
}

function validTaskId(taskId) {
  if (typeof taskId !== "string" || !taskId.trim() || taskId.includes("\0")) return false;
  const safe = safeTaskId(taskId);
  return safe !== "." && safe !== "..";
}

function validEvidenceGap(gap) {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) return false;
  if (typeof gap.reason !== "string" || !gap.reason.trim()) return false;
  const hasType = Boolean(typeof gap.type === "string" && gap.type.trim());
  const hasTypes = Boolean(Array.isArray(gap.types) && gap.types.length > 0 &&
    gap.types.every((item) => typeof item === "string" && item.trim()));
  return hasType !== hasTypes;
}

/** Parse the separate B2.5 Planner mode without loading or reading any data. */
export function parseEditorPlannerGuardAssignment(prompt, { projectRoot } = {}) {
  if (!isEditorPlannerAssignment(prompt)) return { ok: false, errors: ["missing Editor Planner marker"] };
  const errors = [];
  const root = normalizedAbsolute(projectRoot) ? projectRoot : "";
  if (!root) errors.push("projectRoot 不是规范绝对路径");
  const session = lineValue(prompt, /^\s*SESSION\s*=\s*(.+?)\s*$/im);
  const resultPath = lineValue(prompt, /^\s*result\.json\s*=\s*(.+?)\s*$/im);
  if (!normalizedAbsolute(session)) errors.push("SESSION 不是规范绝对路径");
  if (!normalizedAbsolute(resultPath)) errors.push("result.json 不是规范绝对路径");
  const sessionRoot = root ? join(root, ".harness", "state", "html-report") : "";
  if (sessionRoot && normalizedAbsolute(session)) {
    const rel = relative(sessionRoot, session);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/")) {
      errors.push("SESSION 必须是当前项目 html-report 根下的单一 session 目录");
    }
  }
  if (normalizedAbsolute(session) && normalizedAbsolute(resultPath) && resultPath !== join(session, "result.json")) {
    errors.push("result.json 与 SESSION 不一致");
  }
  return errors.length
    ? { ok: false, kind: "editor_plan", errors }
    : { ok: true, kind: "editor_plan", projectRoot: root, session, resultPath, marker: EDITOR_PLANNER_MARKER };
}

/**
 * Parse the self-contained child assignment and derive every writable path.
 * No filesystem access is used, which keeps this function deterministic and
 * makes malformed or conflicting prompt data fail closed.
 */
export function parseResearcherAssignment(prompt, { projectRoot } = {}) {
  const errors = [];
  const root = normalizedAbsolute(projectRoot) ? projectRoot : "";
  if (!root) errors.push("projectRoot 不是规范绝对路径");
  if (typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, errors: [...errors, "缺少子代理任务文本"] };
  }

  const taskId = lineValue(prompt, /taskId\s*=\s*([^\s\r\n]+)/i);
  const session = lineValue(prompt, /^\s*SESSION\s*=\s*(.+?)\s*$/im);
  const resultPath = lineValue(prompt, /^\s*result\.json\s*=\s*(.+?)\s*$/im);
  const evidencePath = lineValue(
    prompt,
    /^\s*evidencePath(?:（reuse_entry）|\s*\(reuse_entry\))?\s*[:=]\s*(.+?)\s*$/im
  );
  const task = extractTaskObject(prompt);
  const mode = task?.evidencePlan?.mode;
  const directMode = /^\s*MODE RULE:\s*(reuse_entry|new_query)\b/im.exec(prompt)?.[1] || null;

  if (!validTaskId(taskId)) errors.push("taskId 缺失或包含不安全路径字符");
  if (!task || typeof task !== "object" || Array.isArray(task)) errors.push("完整 task 对象不是有效 JSON object");
  if (task && task.id !== taskId) errors.push("taskId 与完整 task 对象的 id 不一致");
  if (task && (typeof task.fromCardId !== "string" || !task.fromCardId.trim())) errors.push("完整 task 对象缺少 fromCardId");
  if (task && (typeof task.goal !== "string" || !task.goal.trim())) errors.push("完整 task 对象缺少 goal");
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const requirements = validateResearcherAnalysisRequirements(task);
    if (!requirements.ok) {
      errors.push(...requirements.errors.map((error) => `analysisRequirements：${error}`));
    }
  }
  if (!new Set(["reuse_entry", "new_query"]).has(mode)) errors.push("evidencePlan.mode 必须是 reuse_entry 或 new_query");
  if (directMode && mode && directMode !== mode) errors.push("MODE RULE 与 evidencePlan.mode 冲突");
  if (mode === "new_query" && !validEvidenceGap(task?.evidenceGap)) {
    errors.push("new_query 缺少有效 evidenceGap.type/types 与 reason");
  }

  if (!normalizedAbsolute(session)) errors.push("SESSION 不是规范绝对路径");
  if (!normalizedAbsolute(resultPath)) errors.push("result.json 不是规范绝对路径");
  if (!normalizedAbsolute(evidencePath)) errors.push("evidencePath 不是规范绝对路径");

  const sessionRoot = root ? join(root, ".harness", "state", "html-report") : "";
  if (sessionRoot && normalizedAbsolute(session)) {
    const rel = relative(sessionRoot, session);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/")) {
      errors.push("SESSION 必须是当前项目 html-report 根下的单一 session 目录");
    }
  }

  const expectedResult = normalizedAbsolute(session) ? join(session, "result.json") : "";
  const safeId = validTaskId(taskId) ? safeTaskId(taskId) : "";
  const expectedEvidence = normalizedAbsolute(session) && safeId
    ? join(session, "analysis", "evidence", `${safeId}.json`)
    : "";
  if (resultPath && expectedResult && resultPath !== expectedResult) errors.push("result.json 与 SESSION 不一致");
  if (evidencePath && expectedEvidence && evidencePath !== expectedEvidence) errors.push("evidencePath 与 taskId/SESSION 不一致");

  if (errors.length) return { ok: false, errors };

  const sectionPath = join(session, "analysis", "sections", `explore-${safeId}.md`);
  const summaryPath = join(session, "analysis", "sections", `explore-${safeId}.summary.json`);
  const payloadPath = join(session, "data", "explore", `${safeId}.payload.json`);
  return {
    ok: true,
    projectRoot: root,
    session,
    taskId,
    safeTaskId: safeId,
    task,
    mode,
    resultPath,
    evidencePath,
    sectionPath,
    summaryPath,
    payloadPath,
  };
}

export function initialResearcherGuardState() {
  return {
    reads: {},
    readSuccess: {},
    writes: {},
    writeSuccess: {},
    commands: {},
    commandSuccess: {},
    allowedSpecPaths: [],
    pending: {},
    recallResultSeen: false,
    evidence: null,
    sectionContent: null,
    summaryValue: null,
    submitAttempts: 0,
    submitSuccess: 0,
    terminalFailure: null,
    structuredAttempts: 0,
  };
}

/**
 * Consume a typed-submit attempt that Pi rejected before the tool_call hook.
 *
 * Pi emits tool_execution_end for schema-validation failures, but it does not
 * invoke tool_call first. Keeping this transition pure lets the extension
 * close that gap without weakening the model-visible submit schema. Once the
 * first malformed attempt is observed, the assignment may only finish through
 * a failed structured_output branch; a corrected submit is deliberately not a
 * retry path.
 */
export function researcherUnvalidatedSubmitFailureState(contract, state, event) {
  const current = state || initialResearcherGuardState();
  if (
    String(event?.toolName || "").toLowerCase() !== RESEARCHER_SUBMIT_TOOL ||
    event?.isError !== true ||
    !contract?.ok ||
    !currentAnalysisContract(contract) ||
    current.submitAttempts !== 0 ||
    current.submitSuccess > 0 ||
    current.terminalFailure ||
    current.structuredAttempts > 0
  ) {
    return current;
  }
  const errorEvent = event?.result && typeof event.result === "object"
    ? event.result
    : event;
  return {
    ...current,
    submitAttempts: 1,
    terminalFailure: {
      failedStep: "write",
      error: conciseError(
        errorEvent,
        "submit_research_findings 参数校验失败；首次提交机会已消费"
      ),
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

function tokenizeStandaloneShell(command) {
  if (typeof command !== "string" || !command.trim() || /[\r\n\0`$]/.test(command)) return null;
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let tokenStarted = false;

  for (const char of command.trim()) {
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

function optionsFrom(tokens, start, valueOptions, booleanOptions = new Set()) {
  const values = {};
  for (let index = start; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (!flag.startsWith("--") || flag in values) return null;
    if (booleanOptions.has(flag)) {
      values[flag] = true;
      continue;
    }
    if (!valueOptions.has(flag) || index + 1 >= tokens.length || tokens[index + 1].startsWith("--")) return null;
    values[flag] = tokens[index + 1];
    index += 1;
  }
  return values;
}

/** Return the sole authorized new_query Bash operation, or null. */
export function classifyResearcherCommand(command, contract) {
  if (!contract?.ok || contract.mode !== "new_query") return null;
  const tokens = tokenizeStandaloneShell(command);
  if (!tokens) return null;

  if (tokens[0] === "bin/data-harness-cli" && tokens[1] === "wikis" && tokens[2] === "recall-debug") {
    const options = optionsFrom(
      tokens,
      3,
      new Set(["--question", "--doc-set"]),
      new Set(["--json"])
    );
    if (
      options &&
      typeof options["--question"] === "string" &&
      options["--question"].trim() &&
      options["--question"].length <= 500 &&
      options["--json"] === true &&
      options["--doc-set"] === "specs" &&
      Object.keys(options).length === 3
    ) return { kind: "recall" };
    return null;
  }

  if (tokens[0] !== "node") return null;
  if (matchesHtmlReportScript(tokens[1], FETCH_SCRIPTS)) {
    const options = optionsFrom(
      tokens,
      2,
      new Set(["--result", "--task-id", "--payload-file", "--goal", "--from-card-id"])
    );
    if (
      options &&
      Object.keys(options).length === 5 &&
      options["--result"] === contract.resultPath &&
      options["--task-id"] === contract.taskId &&
      options["--payload-file"] === contract.payloadPath &&
      options["--goal"] === contract.task.goal &&
      options["--from-card-id"] === contract.task.fromCardId
    ) return { kind: "fetch" };
    return null;
  }

  if (matchesHtmlReportScript(tokens[1], PREPARE_SCRIPTS)) {
    const options = optionsFrom(tokens, 2, new Set(["--result", "--task-id"]));
    if (
      options &&
      Object.keys(options).length === 2 &&
      options["--result"] === contract.resultPath &&
      options["--task-id"] === contract.taskId
    ) return { kind: "prepare" };
  }
  return null;
}

function allowedRead(contract, state, path) {
  if (!normalizedAbsolute(path)) return { ok: false, reason: "read 必须使用任务中解析出的规范绝对路径" };
  if (contract.mode === "reuse_entry") {
    if (path !== contract.evidencePath) return { ok: false, reason: "reuse_entry 只能读取精确 evidencePath" };
    if (state.reads[path]) return { ok: false, reason: "reuse_entry evidencePath 最多读取一次" };
    return { ok: true };
  }

  if (path === contract.resultPath) {
    if (state.reads[path]) return { ok: false, reason: "new_query result.json 最多读取一次" };
    return { ok: true };
  }
  if (path === contract.evidencePath) {
    if (!state.commandSuccess.prepare) return { ok: false, reason: "必须先成功执行固定 prepare-research-evidence 命令" };
    if (state.reads[path]) return { ok: false, reason: "new_query evidencePath 最多读取一次" };
    return { ok: true };
  }
  if (state.allowedSpecPaths.includes(path)) {
    if (state.reads[path]) return { ok: false, reason: "召回返回的每个 Spec 最多读取一次" };
    return { ok: true };
  }
  return { ok: false, reason: "new_query 只能读取 result.json、召回返回的 Spec 或生成的 evidencePath" };
}

function allowedWrite(contract, state, path) {
  if (!normalizedAbsolute(path)) return { ok: false, reason: "write 必须使用任务推导出的规范绝对路径" };
  const allowed = contract.mode === "reuse_entry"
    ? [contract.sectionPath, contract.summaryPath]
    : [contract.payloadPath, contract.sectionPath, contract.summaryPath];
  if (!allowed.includes(path)) return { ok: false, reason: `${contract.mode} 的 write 路径不在固定产物白名单` };
  if (state.writes[path]) return { ok: false, reason: `固定产物最多写一次：${path}` };

  if (path === contract.payloadPath && !state.readSuccess[contract.resultPath]) {
    return { ok: false, reason: "new_query 必须先成功读取固定 result.json 再写 payload" };
  }
  if (path === contract.payloadPath && !state.commandSuccess.recall) {
    return { ok: false, reason: "new_query 必须先成功执行固定 recall-debug 再写 payload" };
  }
  if (path === contract.sectionPath && !state.readSuccess[contract.evidencePath]) {
    return { ok: false, reason: "写 section 前必须成功读取一次固定 evidencePath" };
  }
  const pendingSection = Object.values(state.pending || {}).find(
    (operation) =>
      operation?.type === "write" &&
      operation?.path === contract.sectionPath &&
      typeof operation?.content === "string"
  );
  if (
    path === contract.summaryPath &&
    !state.writeSuccess[contract.sectionPath] &&
    !pendingSection
  ) {
    return { ok: false, reason: "summary 必须在固定 section 写入之后或作为紧邻的 sibling write 提交" };
  }
  return { ok: true };
}

function sectionContentForSummary(contract, state) {
  if (typeof state.sectionContent === "string") return state.sectionContent;
  const pendingSection = Object.values(state.pending || {}).find(
    (operation) =>
      operation?.type === "write" &&
      operation?.path === contract.sectionPath &&
      typeof operation?.content === "string"
  );
  return pendingSection?.content ?? null;
}

function structuredValue(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.value && typeof input.value === "object" && !Array.isArray(input.value)) return input.value;
  return input;
}

function writeContent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  return typeof input.content === "string"
    ? input.content
    : typeof input.text === "string"
      ? input.text
      : "";
}

function researcherExpectedFromContract(contract) {
  return {
    taskId: contract.taskId,
    mode: contract.mode,
    evidencePath: contract.evidencePath,
    sectionPath: contract.sectionPath,
    summaryPath: contract.summaryPath,
    task: contract.task,
    analysisRequirements: contract.task?.analysisRequirements,
  };
}

function pendingKey(event, operation) {
  return String(event?.toolCallId || `<unknown:${operation.type}:${operation.kind}:${operation.path || "command"}>`);
}

function addPending(state, event, operation) {
  const key = pendingKey(event, operation);
  if (state.pending[key]) return null;
  return { ...state, pending: { ...state.pending, [key]: operation } };
}

function terminalBlock(state, reason, failedStep = "contract") {
  const next = state.terminalFailure
    ? state
    : { ...state, terminalFailure: { failedStep, error: reason } };
  return block(
    `${reason}；当前 run 已终止，禁止后续 I/O、命令或重试，只允许一次 structured_output`,
    next
  );
}

function missingOkDependencies(contract, state) {
  const missing = [];
  if (contract.mode === "new_query") {
    if (!state.readSuccess[contract.resultPath]) missing.push("result read success");
    if (!state.commandSuccess.recall) missing.push("recall success");
    if (!state.writeSuccess[contract.payloadPath]) missing.push("payload write success");
    if (!state.commandSuccess.fetch) missing.push("fetch success");
    if (!state.commandSuccess.prepare) missing.push("prepare success");
  }
  if (!state.readSuccess[contract.evidencePath]) missing.push("evidence read success");
  if (!state.writeSuccess[contract.sectionPath]) missing.push("section write success");
  if (!state.writeSuccess[contract.summaryPath]) missing.push("summary write success");
  return missing;
}

function currentAnalysisContract(contract) {
  return Number(contract?.task?.analysisContractVersion) === 1;
}

function sameStringList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  if (!left.every((item) => typeof item === "string") || !right.every((item) => typeof item === "string")) {
    return false;
  }
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((item, index) => item === rightSorted[index]);
}

function sameMissingFields(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const byField = (items) => new Map(items.map((item) => [item?.field, item]));
  const leftByField = byField(left);
  const rightByField = byField(right);
  if (leftByField.size !== left.length || rightByField.size !== right.length) return false;
  for (const [field, item] of leftByField) {
    if (typeof field !== "string" || !field || !rightByField.has(field)) return false;
    if (!sameStringList(item?.references, rightByField.get(field)?.references)) return false;
  }
  return true;
}

function matchesCapturedFieldMismatch(value, failure) {
  const captured = failure?.evidenceFieldMismatch;
  const gap = value?.evidenceGap;
  return Boolean(
    captured &&
    gap &&
    typeof gap === "object" &&
    !Array.isArray(gap) &&
    gap.type === "field_mismatch" &&
    gap.reason === "EVIDENCE_FIELD_MISMATCH" &&
    sameStringList(gap.availableFields, captured.availableFields) &&
    sameMissingFields(gap.missingFields, captured.missingFields)
  );
}

/**
 * Pure tool-call transition. The returned state must replace the caller's
 * previous state; blocked calls never consume their one-shot allowance.
 */
export function researcherToolDecision(contract, state, event) {
  const current = state || initialResearcherGuardState();
  const toolName = String(event?.toolName || "").toLowerCase();

  if (contract?.kind === "editor_plan") {
    if (!contract.ok) {
      return block(`Editor Planner 契约解析失败：${contract.errors?.join("；") || "unknown error"}`, current);
    }
    if (FINAL_TOOLS.has(toolName)) {
      if (current.structuredAttempts > 0) return block("Editor Planner structured_output 最多调用一次", current);
      return allow({ ...current, structuredAttempts: current.structuredAttempts + 1 });
    }
    return block("Editor Planner 禁止 read/bash/write/submit_research_findings；只允许一次 structured_output", current);
  }

  if (FINAL_TOOLS.has(toolName)) {
    if (current.structuredAttempts > 0) return block("structured_output 最多调用一次", current);
    const value = structuredValue(event?.input);
    const status = value?.status;
    if (!new Set(["ok", "needs_evidence_plan", "needs_new_query", "failed"]).has(status)) {
      return terminalBlock(
        current,
        "structured_output.status 必须是 ok、needs_evidence_plan、needs_new_query 或 failed",
        "structured_output"
      );
    }
    if (!contract?.ok && status !== "failed") {
      return terminalBlock(
        current,
        "任务契约解析失败时只允许 structured_output status=failed",
        "structured_output"
      );
    }
    if (current.terminalFailure) {
      if (status === "failed") {
        return allow({ ...current, structuredAttempts: current.structuredAttempts + 1 });
      }
      if (
        status === "needs_evidence_plan" &&
        matchesCapturedFieldMismatch(value, current.terminalFailure)
      ) {
        return allow({ ...current, structuredAttempts: current.structuredAttempts + 1 });
      }
      return terminalBlock(
        current,
        current.terminalFailure.evidenceFieldMismatch
          ? "prepare 仅允许返回与 EVIDENCE_FIELD_MISMATCH 完整字段清单精确一致的 status=needs_evidence_plan，或 status=failed"
          : `${current.terminalFailure.failedStep} 失败后只能返回 status=failed`,
        current.terminalFailure.failedStep
      );
    }
    if (status === "ok") {
      const missing = missingOkDependencies(contract, current);
      if (missing.length) {
        return terminalBlock(
          current,
          `structured_output 过早，尚缺成功依赖：${missing.join("、")}`,
          "structured_output"
        );
      }
      if (
        !current.summaryValue ||
        canonicalizeJson(value) !== canonicalizeJson(current.summaryValue)
      ) {
        return terminalBlock(
          current,
          "structured_output 必须与已成功写入的 summary JSON 完全一致",
          "structured_output"
        );
      }
    }
    // needs_* and failed are intentional early exits and must not require
    // completion artifacts. Their full schema remains owned by the parent.
    return allow({ ...current, structuredAttempts: current.structuredAttempts + 1 });
  }

  if (!contract?.ok) {
    return block(`任务契约解析失败，已 fail closed：${contract?.errors?.join("；") || "unknown error"}`, current);
  }

  if (current.structuredAttempts > 0) {
    return block("structured_output 已调用；禁止其后的任何 I/O、命令或其他工具", current);
  }

  if (current.terminalFailure) {
    return block(
      `run 已因 ${current.terminalFailure.failedStep} 失败终止：${current.terminalFailure.error}；禁止后续 I/O、命令或重试，只允许 structured_output`,
      current
    );
  }

  if (toolName === RESEARCHER_SUBMIT_TOOL) {
    if (!currentAnalysisContract(contract)) {
      return block("submit_research_findings 只用于 current analysis contract", current);
    }
    if (current.submitAttempts > 0) {
      return terminalBlock(current, "submit_research_findings 最多调用一次，不允许重试", "write");
    }
    const missing = [];
    if (contract.mode === "new_query") {
      if (!current.readSuccess[contract.resultPath]) missing.push("result read success");
      if (!current.commandSuccess.recall) missing.push("recall success");
      if (!current.writeSuccess[contract.payloadPath]) missing.push("payload write success");
      if (!current.commandSuccess.fetch) missing.push("fetch success");
      if (!current.commandSuccess.prepare) missing.push("prepare success");
    }
    if (!current.readSuccess[contract.evidencePath] || !current.evidence) {
      missing.push("evidence read success");
    }
    if (missing.length) {
      return terminalBlock(
        current,
        `submit_research_findings 过早，尚缺成功依赖：${missing.join("、")}`,
        "write"
      );
    }
    const withPending = addPending(current, event, {
      type: RESEARCHER_SUBMIT_TOOL,
      kind: "submit",
      failedStep: "write",
    });
    if (!withPending) return terminalBlock(current, "submit_research_findings toolCallId 重复", "write");
    return allow({ ...withPending, submitAttempts: current.submitAttempts + 1 });
  }

  if (toolName === "read") {
    const path = eventPath(event.input);
    if (path && current.reads[path]) {
      return terminalBlock(current, `固定文件最多读取一次：${path}`, "read");
    }
    const checked = allowedRead(contract, current, path);
    if (!checked.ok) return block(checked.reason, current);
    const withPending = addPending(current, event, { type: "read", kind: "read", path, failedStep: "read" });
    if (!withPending) return terminalBlock(current, "read toolCallId 重复", "read");
    return allow({ ...withPending, reads: increment(current.reads, path) });
  }

  if (toolName === "write") {
    const path = eventPath(event.input);
    if (
      currentAnalysisContract(contract) &&
      [contract.sectionPath, contract.summaryPath].includes(path)
    ) {
      return terminalBlock(
        current,
        "current analysis contract 禁止模型手写 section/summary；必须调用 submit_research_findings",
        "write"
      );
    }
    if (path && current.writes[path]) {
      return terminalBlock(current, `固定产物最多写一次：${path}`, "write");
    }
    const checked = allowedWrite(contract, current, path);
    if (!checked.ok) return block(checked.reason, current);
    const content = writeContent(event.input);
    if (path === contract.sectionPath) {
      const preflight = validateResearcherCompletionContent({
        evidence: current.evidence,
        section: content,
      });
      if (!preflight.ok) {
        return terminalBlock(
          current,
          `section 内容预检失败：${preflight.errors.join("；")}`,
          "write"
        );
      }
    }
    let summaryValue = null;
    if (path === contract.summaryPath) {
      summaryValue = parseJsonText(content);
      if (!summaryValue || typeof summaryValue !== "object" || Array.isArray(summaryValue)) {
        return terminalBlock(current, "summary 内容预检失败：必须是单个 JSON object", "write");
      }
      const envelope = validateResearcherReturn(
        summaryValue,
        researcherExpectedFromContract(contract)
      );
      const contentCheck = validateResearcherCompletionContent({
        evidence: current.evidence,
        // Pi preflights sibling tool calls in source order before executing
        // them concurrently. Accept the fixed section+summary pair in one
        // assistant message by validating summary against the already checked
        // pending section content. Final ok still requires both write results
        // to succeed, so this does not weaken the persisted-artifact contract.
        section: sectionContentForSummary(contract, current),
        summary: summaryValue,
        evidencePointers: summaryValue.evidencePointers,
        expected: researcherExpectedFromContract(contract),
      });
      const errors = [...envelope.errors, ...contentCheck.errors];
      if (errors.length) {
        return terminalBlock(
          current,
          `summary 内容预检失败：${errors.join("；")}`,
          "write"
        );
      }
    }
    const withPending = addPending(current, event, {
      type: "write",
      kind: "write",
      path,
      failedStep: "write",
      ...(path === contract.sectionPath ? { content } : {}),
      ...(path === contract.summaryPath ? { summaryValue } : {}),
    });
    if (!withPending) return terminalBlock(current, "write toolCallId 重复", "write");
    return allow({ ...withPending, writes: increment(current.writes, path) });
  }

  if (toolName === "bash") {
    if (contract.mode === "reuse_entry") return block("reuse_entry 禁止所有 Bash", current);
    const classified = classifyResearcherCommand(event?.input?.command, contract);
    if (!classified) {
      return block("new_query 只允许一次 recall-debug、一次 fetch-explore 和一次 prepare-research-evidence 固定命令；临时 Python/Node/jq、ls/find/grep 与裸 Indicators CLI 均禁止", current);
    }
    const kind = classified.kind;
    if (current.commands[kind]) {
      return terminalBlock(current, `${kind} 固定命令最多调用一次，不允许失败重试`, kind);
    }
    if (kind === "recall" && !current.readSuccess[contract.resultPath]) {
      return block("new_query 必须先成功读取 result.json 再召回 Spec", current);
    }
    if (kind === "fetch" && !current.writeSuccess[contract.payloadPath]) {
      return block("fetch-explore 前必须先成功写入固定 payloadPath", current);
    }
    if (kind === "prepare" && !current.commandSuccess.fetch) {
      return block("prepare-research-evidence 前必须先成功执行固定 fetch-explore", current);
    }
    const withPending = addPending(current, event, { type: "bash", kind, failedStep: kind });
    if (!withPending) return terminalBlock(current, `${kind} toolCallId 重复`, kind);
    return allow({ ...withPending, commands: increment(current.commands, kind) });
  }

  if (RESEARCHER_TOOLS.has(toolName)) return block(`工具 ${toolName} 未通过固定契约`, current);
  return block(`禁止目录扫描、编辑、协调或其他未授权工具：${toolName || "unknown"}`, current);
}

function resultText(event) {
  if (typeof event?.content === "string") return event.content;
  if (Array.isArray(event?.content)) {
    return event.content
      .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseJsonText(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
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
  const text = resultText(event).trim().replace(/\s+/g, " ");
  return (text || fallback).slice(0, 1200);
}

function capturedEvidenceFieldMismatch(contract, operation, event) {
  if (operation?.kind !== "prepare") return null;
  const payload = parseJsonText(resultText(event));
  if (
    !payload ||
    payload.code !== "EVIDENCE_FIELD_MISMATCH" ||
    payload.taskId !== contract.taskId ||
    !Array.isArray(payload.availableFields) ||
    !payload.availableFields.every((field) => typeof field === "string") ||
    !Array.isArray(payload.missingFields) ||
    payload.missingFields.length === 0 ||
    !payload.missingFields.every((item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof item.field === "string" &&
      item.field &&
      Array.isArray(item.references) &&
      item.references.length > 0 &&
      item.references.every((reference) => typeof reference === "string" && reference)
    )
  ) return null;
  return {
    availableFields: [...payload.availableFields],
    missingFields: payload.missingFields.map((item) => ({
      field: item.field,
      references: [...item.references],
    })),
  };
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

/** Record success/failure of the exact one-shot read, write, or command. */
export function researcherToolResultState(contract, state, event) {
  const current = state || initialResearcherGuardState();
  if (!contract?.ok || current.terminalFailure || current.structuredAttempts > 0) return current;
  const [key, operation] = matchingPending(current, event);
  if (!operation) return current;

  const pending = { ...current.pending };
  delete pending[key];
  const next = { ...current, pending };
  if (resultFailed(event)) {
    const evidenceFieldMismatch = capturedEvidenceFieldMismatch(contract, operation, event);
    return {
      ...next,
      terminalFailure: {
        failedStep: operation.failedStep,
        error: conciseError(event, `${operation.kind} operation failed`),
        ...(evidenceFieldMismatch ? { evidenceFieldMismatch } : {}),
      },
    };
  }

  if (operation.type === "read") {
    if (operation.path === contract.evidencePath) {
      const evidence = parseJsonText(resultText(event));
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
        return {
          ...next,
          terminalFailure: {
            failedStep: "read",
            error: "evidence read 未返回单个有效 JSON object",
          },
        };
      }
      return {
        ...next,
        evidence,
        readSuccess: increment(next.readSuccess, operation.path),
      };
    }
    return { ...next, readSuccess: increment(next.readSuccess, operation.path) };
  }
  if (operation.type === "write") {
    return {
      ...next,
      ...(operation.path === contract.sectionPath ? { sectionContent: operation.content } : {}),
      ...(operation.path === contract.summaryPath ? { summaryValue: operation.summaryValue } : {}),
      writeSuccess: increment(next.writeSuccess, operation.path),
    };
  }
  if (operation.type === RESEARCHER_SUBMIT_TOOL) {
    const detailedReturn = event?.details?.researcherReturn;
    const researcherReturn = detailedReturn && typeof detailedReturn === "object" && !Array.isArray(detailedReturn)
      ? detailedReturn
      : parseJsonText(resultText(event));
    const checked = validateResearcherReturn(
      researcherReturn,
      researcherExpectedFromContract(contract)
    );
    if (!checked.ok) {
      return {
        ...next,
        terminalFailure: {
          failedStep: "write",
          error: `submit_research_findings 返回非法：${checked.errors.join("；")}`,
        },
      };
    }
    return {
      ...next,
      summaryValue: researcherReturn,
      submitSuccess: next.submitSuccess + 1,
      writeSuccess: {
        ...next.writeSuccess,
        [contract.sectionPath]: 1,
        [contract.summaryPath]: 1,
      },
    };
  }

  const commandNext = {
    ...next,
    commandSuccess: { ...next.commandSuccess, [operation.kind]: true },
  };
  if (operation.kind !== "recall") return commandNext;
  const payload = parseJsonText(resultText(event));
  const files = Array.isArray(payload?.contextFiles) ? payload.contextFiles : [];
  const wikiRoot = join(contract.projectRoot, "wikis");
  const paths = [];
  for (const item of files) {
    const raw = textValue(typeof item === "string" ? item : item?.path);
    if (!raw) continue;
    const candidate = isAbsolute(raw) ? raw : resolve(contract.projectRoot, raw);
    if (!normalizedAbsolute(candidate) || !isInside(wikiRoot, candidate)) continue;
    if (!/(?:^|\/)spec\.md$/.test(candidate) && !/\/spec\//.test(candidate)) continue;
    if (!paths.includes(candidate)) paths.push(candidate);
    if (paths.length >= MAX_RECALLED_SPEC_PATHS) break;
  }
  return {
    ...commandNext,
    recallResultSeen: true,
    allowedSpecPaths: paths,
  };
}
