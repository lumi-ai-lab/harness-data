import { isAbsolute, join, relative, resolve } from "node:path";
import { validateDesignTemplate } from "../../skills/html-report/scripts/compose-report.mjs";
import { designerReturnPaths, validateDesignerReturn } from "../../skills/html-report/scripts/designer-return.mjs";

const FINAL_TOOLS = new Set(["structured_output", "structured-output"]);
const CONTENT_SLOT = "<!-- HTML_REPORT_CONTENT -->";
const SCRIPT_PATHS = Object.freeze({
  compile: ".agents/pi/skills/html-report/scripts/compile-report-content.mjs",
  compose: ".agents/pi/skills/html-report/scripts/compose-report.mjs",
  capture: ".agents/pi/skills/html-report/scripts/capture-report.mjs",
  finalize: ".agents/pi/skills/html-report/scripts/finalize-design.mjs",
  layout: ".agents/pi/skills/html-report/scripts/check-session-layout.mjs",
});

function allow(state) {
  return { decision: undefined, state };
}

function block(reason, state) {
  return {
    decision: { block: true, reason: `Report Designer guard：${reason}` },
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
  const matcher = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, "i");
  return String(prompt || "")
    .split(/\r?\n/)
    .map((line) => matcher.exec(line)?.[1])
    .filter((value) => value !== undefined)
    .map(textValue);
}

function normalizedAbsolute(path) {
  return typeof path === "string" && path.length > 0 && !path.includes("\0") &&
    isAbsolute(path) && resolve(path) === path;
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Parse the self-contained B5 assignment and derive every authorized path. */
export function parseDesignerAssignment(prompt, { projectRoot } = {}) {
  const errors = [];
  const root = normalizedAbsolute(projectRoot) ? projectRoot : "";
  if (!root) errors.push("projectRoot 不是规范绝对路径");
  if (typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, errors: [...errors, "缺少子代理任务文本"] };
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
  if (normalizedAbsolute(sessionDir) && resultPath !== join(sessionDir, "result.json")) {
    errors.push("result.json 与 SESSION 不一致");
  }
  if (errors.length) return { ok: false, errors };

  const paths = designerReturnPaths({ sessionDir });
  const designSkillDir = join(root, ".agents", "pi", "skills", "html-report-design");
  const reportDir = join(sessionDir, "report");
  const contract = {
    ok: true,
    projectRoot: root,
    sessionDir,
    resultPath,
    designInputPath: join(reportDir, "design-input.json"),
    contentPath: join(reportDir, "report.content.html"),
    referencePath: join(designSkillDir, "references", "report-design-system.md"),
    starterPath: join(designSkillDir, "assets", "report-shell-starter.html"),
    templatePath: join(reportDir, "report.design.html"),
    draftPath: join(reportDir, "design-result.draft.json"),
    desktopScreenshot: paths.desktopScreenshot,
    mobileScreenshot: paths.mobileScreenshot,
    returnPaths: paths,
    scripts: Object.fromEntries(
      Object.entries(SCRIPT_PATHS).map(([kind, path]) => [kind, join(root, path)])
    ),
  };
  for (const [label, path] of Object.entries(contract)) {
    if (!label.endsWith("Path") && !new Set(["desktopScreenshot", "mobileScreenshot"]).has(label)) continue;
    if (!normalizedAbsolute(path)) errors.push(`${label} 不是规范绝对路径`);
    if (![contract.referencePath, contract.starterPath].includes(path) && !pathInside(sessionDir, path)) {
      errors.push(`${label} 逃逸 SESSION`);
    }
  }
  return errors.length ? { ok: false, errors } : contract;
}

export function initialDesignerGuardState() {
  return {
    pending: {},
    terminalFailure: null,
    structuredAttempts: 0,
    compileSuccess: false,
    inputReads: {},
    templateWritten: false,
    composeSuccess: false,
    captureSuccess: false,
    screenshotReads: {},
    visualReady: false,
    repairRounds: 0,
    draftWritten: false,
    finalizeSuccess: false,
    layoutSuccess: false,
  };
}

function eventPath(input) {
  if (!input || typeof input !== "object") return "";
  return textValue(input.path ?? input.filePath ?? input.file_path);
}

function eventContent(input) {
  if (!input || typeof input !== "object") return "";
  return typeof input.content === "string" ? input.content : "";
}

function eventOldText(input) {
  if (!input || typeof input !== "object") return "";
  return typeof (input.oldText ?? input.old_text) === "string" ? input.oldText ?? input.old_text : "";
}

function eventNewText(input) {
  if (!input || typeof input !== "object") return "";
  return typeof (input.newText ?? input.new_text) === "string" ? input.newText ?? input.new_text : "";
}

function tokenizeStandaloneShell(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  const normalized = command.replace(/\\\r?\n[ \t]*/g, " ");
  if (/[\r\n\0`$]/.test(normalized)) return null;
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const char of normalized.trim()) {
    if (escaped) {
      token += char;
      started = true;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    if (/[;&|<>]/.test(char)) return null;
    token += char;
    started = true;
  }
  if (escaped || quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

function optionsFrom(tokens, start, allowed) {
  const options = {};
  for (let index = start; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--") || Object.hasOwn(options, flag)) {
      return null;
    }
    options[flag] = value;
  }
  return options;
}

/** Classify only the five fixed Designer commands. */
export function classifyDesignerCommand(command, contract) {
  if (!contract?.ok) return null;
  const tokens = tokenizeStandaloneShell(command);
  if (!tokens || tokens[0] !== "node" || tokens.length < 4) return null;
  const script = tokens[1];
  const kind = Object.keys(contract.scripts).find((name) =>
    script === contract.scripts[name] || script === SCRIPT_PATHS[name]
  );
  if (!kind) return null;
  const allowed = kind === "finalize"
    ? new Set(["--result", "--assessment-file"])
    : kind === "layout"
      ? new Set(["--result", "--phase"])
      : new Set(["--result"]);
  const options = optionsFrom(tokens, 2, allowed);
  if (!options || options["--result"] !== contract.resultPath) return null;
  if (Object.keys(options).length !== allowed.size) return null;
  if (kind === "finalize" && options["--assessment-file"] !== contract.draftPath) return null;
  if (kind === "layout" && options["--phase"] !== "html") return null;
  return kind;
}

function addPending(state, event, operation) {
  const key = String(event?.toolCallId || `<unknown:${operation.type}:${operation.path || operation.kind}>`);
  if (state.pending[key]) return null;
  return { ...state, pending: { ...state.pending, [key]: operation } };
}

function terminalBlock(state, reason, failedStep = "contract") {
  const terminalFailure = state.terminalFailure || { failedStep, error: reason.slice(0, 900) };
  return block(
    `${reason}；当前 run 已终止，禁止重试，只允许一次 structured_output status=failed`,
    { ...state, terminalFailure }
  );
}

function initialInputPaths(contract) {
  return [contract.designInputPath, contract.contentPath, contract.referencePath, contract.starterPath];
}

function screenshots(contract) {
  return [contract.desktopScreenshot, contract.mobileScreenshot];
}

function allSuccessful(record, paths) {
  return paths.every((path) => record[path] === true);
}

function hasPending(state) {
  return Object.keys(state.pending).length > 0;
}

function validateAssessmentDraft(content) {
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    return `design-result.draft.json 不是合法 JSON：${error.message || error}`;
  }
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (keys.join(",") !== "notes,status,viewports") return "design draft 只能包含 status、viewports、notes";
  if (value.status !== "pass" || !Array.isArray(value.notes)) return "design draft 必须 status=pass 且 notes 为数组";
  const viewportKeys = value.viewports && typeof value.viewports === "object" && !Array.isArray(value.viewports)
    ? Object.keys(value.viewports).sort()
    : [];
  if (viewportKeys.join(",") !== "desktop,mobile") return "design draft.viewports 必须且只能包含 desktop、mobile";
  for (const id of ["desktop", "mobile"]) {
    const viewport = value.viewports[id];
    if (!viewport || typeof viewport !== "object" || Array.isArray(viewport) || viewport.pass !== true) {
      return `design draft ${id}.pass 必须为 true`;
    }
    const viewportFields = Object.keys(viewport).sort();
    if (viewportFields.join(",") !== "notes,pass" || typeof viewport.notes !== "string" || !viewport.notes.trim()) {
      return `design draft ${id} 必须且只能包含 pass=true 与非空 notes`;
    }
  }
  if (value.notes.some((note) => typeof note !== "string" || !note.trim())) {
    return "design draft notes 只能包含非空字符串";
  }
  return "";
}

function structuredValue(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.value && typeof input.value === "object" && !Array.isArray(input.value)) return input.value;
  return input;
}

function validateStructured(value, contract, state) {
  const checked = validateDesignerReturn(value, contract.returnPaths);
  if (!checked.ok) return checked.errors.join("；");
  if (value.repairRounds !== state.repairRounds) {
    return `repairRounds 必须等于 guard 记录的 ${state.repairRounds}`;
  }
  if (state.terminalFailure) {
    if (value.status !== "failed") return "失败终止后只能返回 status=failed";
    return "";
  }
  if (value.status !== "ok") return "正常路径必须返回 status=ok";
  if (hasPending(state) || !state.layoutSuccess) return "structured_output 过早：phase-html layout 尚未成功";
  return "";
}

function commandPrecondition(kind, state) {
  if (hasPending(state)) return "上一工具结果尚未返回";
  if (kind === "compile") {
    return state.compileSuccess || state.templateWritten ? "compile 只能作为首个命令执行一次" : "";
  }
  if (!state.compileSuccess) return "必须先成功 compile";
  if (kind === "compose") {
    if (!state.templateWritten) return "compose 前必须先写入合法 report.design.html";
    if (state.composeSuccess) return "当前模板已 compose，禁止重复 compose";
    if (state.draftWritten) return "draft 写入后禁止 compose";
    return "";
  }
  if (kind === "capture") {
    if (!state.composeSuccess) return "capture 前必须成功 compose";
    if (state.captureSuccess) return "当前 HTML 已 capture，禁止重复 capture";
    return "";
  }
  if (kind === "finalize") {
    if (!state.draftWritten) return "finalize 前必须写入合法 design draft";
    if (state.finalizeSuccess) return "finalize 只能执行一次";
    return "";
  }
  if (kind === "layout") {
    if (!state.finalizeSuccess) return "layout 前必须成功 finalize";
    if (state.layoutSuccess) return "layout 只能执行一次";
    return "";
  }
  return "未知命令";
}

/** Pure one-shot state machine for the Designer child. */
export function designerToolDecision(contract, state, event) {
  const current = state || initialDesignerGuardState();
  const toolName = String(event?.toolName || "").toLowerCase();
  if (!contract?.ok) return block(`任务契约解析失败：${contract?.errors?.join("；") || "unknown"}`, current);

  if (FINAL_TOOLS.has(toolName)) {
    if (current.structuredAttempts > 0) return block("structured_output 最多调用一次", current);
    const next = { ...current, structuredAttempts: current.structuredAttempts + 1 };
    const error = validateStructured(structuredValue(event?.input), contract, next);
    return error ? block(error, next) : allow(next);
  }
  if (current.structuredAttempts > 0) return block("structured_output 后禁止任何工具", current);
  if (current.terminalFailure) {
    return block("run 已失败终止；禁止后续 I/O、命令或重试，只允许 structured_output status=failed", current);
  }

  if (toolName === "bash") {
    const kind = classifyDesignerCommand(event?.input?.command, contract);
    if (!kind) return terminalBlock(current, "只允许五条固定 Designer 命令，禁止 shell 组合、临时脚本与额外参数", "command");
    const precondition = commandPrecondition(kind, current);
    if (precondition) return terminalBlock(current, precondition, kind);
    const withPending = addPending(current, event, { type: "command", kind, failedStep: kind });
    return withPending ? allow(withPending) : terminalBlock(current, `${kind} toolCallId 重复`, kind);
  }

  if (toolName === "read") {
    const path = eventPath(event?.input);
    if (!normalizedAbsolute(path)) return terminalBlock(current, "read path 必须是规范绝对路径", "read");
    const inputs = initialInputPaths(contract);
    const viewportPaths = screenshots(contract);
    if (inputs.includes(path)) {
      if (!current.compileSuccess || current.templateWritten) {
        return terminalBlock(current, "四个固定设计输入只能在 compile 后、首次写模板前各读一次", "read");
      }
      if (current.inputReads[path] || Object.values(current.pending).some((item) => item.path === path)) {
        return terminalBlock(current, `固定设计输入最多读取一次：${path}`, "read");
      }
      const withPending = addPending(current, event, { type: "read-input", path, failedStep: "read" });
      return withPending ? allow(withPending) : terminalBlock(current, "read toolCallId 重复", "read");
    }
    if (viewportPaths.includes(path)) {
      if (!current.captureSuccess || current.visualReady || current.draftWritten) {
        return terminalBlock(current, "截图只能在当前 capture 成功后、draft 前各读一次", "read");
      }
      if (current.screenshotReads[path] || Object.values(current.pending).some((item) => item.path === path)) {
        return terminalBlock(current, `当前截图最多读取一次：${path}`, "read");
      }
      const withPending = addPending(current, event, { type: "read-screenshot", path, failedStep: "read" });
      return withPending ? allow(withPending) : terminalBlock(current, "read toolCallId 重复", "read");
    }
    return terminalBlock(current, "read 只能访问四个固定设计输入或当前轮两张固定截图", "read");
  }

  if (toolName === "write") {
    const path = eventPath(event?.input);
    const content = eventContent(event?.input);
    if (path === contract.templatePath) {
      if (!current.compileSuccess || !allSuccessful(current.inputReads, initialInputPaths(contract)) || hasPending(current)) {
        return terminalBlock(current, "report.design.html 必须在 compile 与四个固定读取全部成功后写入", "write");
      }
      if (current.templateWritten) return terminalBlock(current, "report.design.html 只能首次 write 一次；截图后修复必须使用 edit", "write");
      const errors = validateDesignTemplate(content);
      if (errors.length) return terminalBlock(current, `非法 Designer 模板：${errors.join("；")}`, "write");
      const withPending = addPending(current, event, { type: "write-template", path, failedStep: "write" });
      return withPending ? allow(withPending) : terminalBlock(current, "write toolCallId 重复", "write");
    }
    if (path === contract.draftPath) {
      if (!current.visualReady || hasPending(current) || current.draftWritten) {
        return terminalBlock(current, "design draft 只能在当前轮两张截图读取成功后写一次", "write");
      }
      const error = validateAssessmentDraft(content);
      if (error) return terminalBlock(current, error, "write");
      const withPending = addPending(current, event, { type: "write-draft", path, failedStep: "write" });
      return withPending ? allow(withPending) : terminalBlock(current, "write toolCallId 重复", "write");
    }
    return terminalBlock(current, "write 只能写一次 report.design.html 与一次 design-result.draft.json", "write");
  }

  if (toolName === "edit") {
    const path = eventPath(event?.input);
    if (path !== contract.templatePath) return terminalBlock(current, "edit 只能修改固定 report.design.html", "edit");
    if (!current.visualReady || hasPending(current) || current.draftWritten) {
      return terminalBlock(current, "首次 capture 并读完两张截图前禁止 edit；draft 后也禁止 edit", "edit");
    }
    if (current.repairRounds >= 2) return terminalBlock(current, "视觉修复最多两轮", "edit");
    const oldText = eventOldText(event?.input);
    const newText = eventNewText(event?.input);
    if (!oldText || !newText || oldText === newText) return terminalBlock(current, "edit 必须提供不同的非空 oldText/newText", "edit");
    if (oldText.includes(CONTENT_SLOT) || newText.includes(CONTENT_SLOT) || /data-html-report-content|html-report:content-(?:start|end)/i.test(newText)) {
      return terminalBlock(current, "edit 不得触碰唯一内容 slot 或手工插入 immutable report.content.html", "edit");
    }
    const withPending = addPending(current, event, { type: "edit-template", path, failedStep: "edit" });
    return withPending ? allow(withPending) : terminalBlock(current, "edit toolCallId 重复", "edit");
  }

  return terminalBlock(current, `禁止未授权工具：${toolName || "unknown"}`, "contract");
}

function resultText(event) {
  if (typeof event?.content === "string") return event.content;
  if (!Array.isArray(event?.content)) return "";
  return event.content
    .map((item) => item?.type === "text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function resultFailed(event) {
  if (event?.isError === true) return true;
  if (event?.isError !== false) return true;
  const details = event?.details;
  if (!details || typeof details !== "object") return false;
  return ["exitCode", "code", "statusCode"].some((key) => Number.isInteger(details[key]) && details[key] !== 0);
}

function conciseError(event, fallback) {
  return (resultText(event).trim().replace(/\s+/g, " ") || fallback).slice(0, 900);
}

/** Record success/failure; every authorized operation is one-shot. */
export function designerToolResultState(contract, state, event) {
  const current = state || initialDesignerGuardState();
  if (!contract?.ok || current.terminalFailure || FINAL_TOOLS.has(String(event?.toolName || "").toLowerCase())) {
    return current;
  }
  const requested = String(event?.toolCallId || "");
  let key = requested && current.pending[requested] ? requested : "";
  if (!key && !requested) {
    const toolName = String(event?.toolName || "").toLowerCase();
    const candidates = Object.entries(current.pending).filter(([, operation]) =>
      (toolName === "bash" && operation.type === "command") ||
      (toolName === "read" && operation.type.startsWith("read-")) ||
      (toolName === "write" && operation.type.startsWith("write-")) ||
      (toolName === "edit" && operation.type === "edit-template")
    );
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
        error: conciseError(event, `${operation.type} failed`),
      },
    };
  }
  if (operation.type === "command") {
    if (operation.kind === "compile") return { ...next, compileSuccess: true };
    if (operation.kind === "compose") return { ...next, composeSuccess: true, captureSuccess: false };
    if (operation.kind === "capture") {
      return { ...next, captureSuccess: true, screenshotReads: {}, visualReady: false };
    }
    if (operation.kind === "finalize") return { ...next, finalizeSuccess: true };
    if (operation.kind === "layout") return { ...next, layoutSuccess: true };
  }
  if (operation.type === "read-input") {
    return { ...next, inputReads: { ...next.inputReads, [operation.path]: true } };
  }
  if (operation.type === "read-screenshot") {
    const screenshotReads = { ...next.screenshotReads, [operation.path]: true };
    return {
      ...next,
      screenshotReads,
      visualReady: allSuccessful(screenshotReads, screenshots(contract)) && Object.keys(next.pending).length === 0,
    };
  }
  if (operation.type === "write-template") {
    return { ...next, templateWritten: true, composeSuccess: false, captureSuccess: false };
  }
  if (operation.type === "edit-template") {
    return {
      ...next,
      repairRounds: next.repairRounds + 1,
      composeSuccess: false,
      captureSuccess: false,
      screenshotReads: {},
      visualReady: false,
    };
  }
  if (operation.type === "write-draft") return { ...next, draftWritten: true };
  return next;
}
