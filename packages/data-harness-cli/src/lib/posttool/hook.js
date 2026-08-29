import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { loadConfig, newPathResolver, normalizeResolverOwners } from "../harness.js";
import { diagnosticsDir, load as loadState, MODE_FREE, safeSessionId, save as saveState } from "../sessionstate.js";
import { isAllowedTemplateSelectionPath } from "../wikis/template-selection.js";

const WORKBUDDY_SESSION_PREFIX = "workbuddy:";

export const REPORT_ORDER = ["store-overview", "member-overview", "financial-overview"];

export const REPORT_CONFIGS = {
  "store-overview": { report: "store", requiredModules: ["overview"] },
  "member-overview": { report: "user", requiredModules: ["overview"] },
  "financial-overview": { report: "company", requiredModules: ["indicators", "tree", "table"] },
};

export function runClaudeHook(root, input, context = null) {
  const payload = parsePayload(input);
  if (!payload || payload.tool_name !== "Bash" || !String(payload.tool_input?.command || "").trim()) {
    return { ok: false, output: null };
  }
  let sessionID = payload.session_id || process.env.CLAUDE_SESSION_ID || "unknown";
  if (context && (!context.workspaceRoot || context.capabilities?.canWriteWorkspace === false) && (isTemplateStageCommand(payload.tool_input.command) || isTemplateInjectionCommand(payload.tool_input.command))) {
    return {
      ok: true,
      output: workspaceRequiredOutput("QDM_WORKSPACE_REQUIRED: template/report operations require workspaceRoot; no project state was written."),
    };
  }
  return runTemplateHook(context || root, payload.tool_input.command, sessionID);
}

export function runWorkBuddyHook(root, input, context = null) {
  const payload = parsePayload(input);
  const command = String(payload?.tool_input?.command || "").trim();
  if (!payload || payload.tool_name !== "Bash" || !command) {
    return { ok: false, output: null };
  }
  const templateCommand = isTemplateStageCommand(command) || isTemplateInjectionCommand(command);
  const metricCommand = isQDMMetricCommand(command);
  if (!templateCommand && !metricCommand) return { ok: false, output: null };
  if (metricCommand && !templateCommand) return { ok: false, output: null };
  if (context && (!context.workspaceRoot || context.capabilities?.canWriteWorkspace === false) && templateCommand) {
    return {
      ok: true,
      output: workBuddySafetyOutput("QDM_WORKSPACE_REQUIRED: template/report operations require workspaceRoot; no project state was written."),
    };
  }

  const sessionID = String(payload.session_id || "").trim();
  if (!sessionID) {
    return {
      ok: true,
      output: workBuddySafetyOutput(
        "QDM_HARNESS_BLOCKED: WorkBuddy did not provide a stable session_id for template injection. Do not guess, read, or use any template; run context in a new WorkBuddy session first.",
      ),
    };
  }
  try {
    loadConfig(root);
  } catch {
    return {
      ok: true,
      output: workBuddySafetyOutput(
        "QDM_HARNESS_UNAVAILABLE: Harness configuration could not be loaded after the template tool call. Do not guess, read, or use a template.",
      ),
    };
  }
  try {
    const result = runTemplateHook(context || root, command, WORKBUDDY_SESSION_PREFIX + sessionID);
    if (!result.ok) return { ok: false, output: null };
    return {
      ok: true,
      output: {
        continue: true,
        hookSpecificOutput: result.output.hookSpecificOutput,
      },
    };
  } catch {
    return {
      ok: true,
      output: workBuddySafetyOutput(
        "QDM_HARNESS_UNAVAILABLE: The selected template could not be injected. Do not read another template, guess its structure, or produce a final report.",
      ),
    };
  }
}

function workBuddySafetyOutput(message) {
  return {
    continue: true,
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: message,
    },
  };
}

function workspaceRequiredOutput(message) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: message,
    },
  };
}

export function runTemplateHook(root, command, sessionID) {
  if (!isTemplateStageCommand(command) && !isTemplateInjectionCommand(command)) {
    return { ok: false, output: null };
  }
  const injected = injectTemplate(root, sessionID);
  const updated = loadState(root, sessionID);
  recordTemplateDiagnostic(root, sessionID, updated, getReportState(updated, "template"), injected.outcome, injected.templateRel);
  return { ok: true, output: buildOutput(injected.message) };
}

export function injectTemplate(root, sessionID) {
  const state = loadState(root, sessionID);
  const reportState = getReportState(state, "template");
  if (!state.mode) {
    saveState(root, sessionID, state);
    return {
      message: "QDM_INJECT_TEMPLATE session state missing. Do not guess a template; run context first.",
      outcome: "missing_session_state",
      templateRel: "",
    };
  }
  if (state.mode === MODE_FREE) {
    state.selected_playbook = "";
    state.selected_template = "";
    state.selected_playbooks = undefined;
    saveState(root, sessionID, state);
    return {
      message:
        "QDM_FREE_ANALYSIS current session is free mode. Do not run inject-template; continue free analysis and do not read template files.",
      outcome: "free_mode_no_template",
      templateRel: "",
    };
  }
  const { templateRel, message: validationMessage } = selectedTemplatePath(root, state);
  if (validationMessage) {
    saveState(root, sessionID, state);
    return { message: validationMessage, outcome: "template_selection_error", templateRel };
  }
  const resolver = newPathResolver(root);
  let template;
  try {
    template = readFileSync(resolver.resolve(templateRel));
  } catch {
    saveState(root, sessionID, state);
    return {
      message: `QDM_INJECT_TEMPLATE missing ${templateRel}. Wiki integrity error; do not read any other template.`,
      outcome: "missing_template",
      templateRel,
    };
  }
  state.template_injected = true;
  reportState.template_injected = true;
  saveState(root, sessionID, state);
  return {
    message: `${stripMarkdownFrontmatter(template.toString("utf8"))}${finalOutputContract()}`,
    outcome: "template_injected",
    templateRel,
  };
}

function finalOutputContract() {
  return "\n\nQDM_DELIVERY_MODE=chat\nQDM_FINAL_OUTPUT_CONTRACT:\n- Use the injected template to organize the final response in the current conversation.\n- Do not write the final result or intermediate analysis result to a file.\n- Only create an export file when the user explicitly asks to export, save, or generate a file.\n";
}

function buildOutput(message) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: message,
    },
  };
}

export function recordCommandModules(state, command) {
  let handled = false;
  for (const reportName of REPORT_ORDER) {
    const config = REPORT_CONFIGS[reportName];
    const modules = extractReportModules(command, reportName, config);
    if (!modules.length) continue;
    const reportState = getReportState(state, reportName);
    for (const module of modules) {
      if (addModule(reportState, module)) handled = true;
    }
  }
  return handled;
}

function extractReportModules(command, reportName, config) {
  const normalized = normalizeCommand(command);
  const lowered = normalized.toLowerCase();
  if (reportName === "financial-overview") {
    const modules = extractStandardModules(lowered, config.report, config.requiredModules);
    if (financialTableCommand(normalized, lowered) && !modules.includes("table")) modules.push("table");
    return modules;
  }
  return extractStandardModules(lowered, config.report, config.requiredModules);
}

function extractStandardModules(lowered, report, required) {
  const pattern = new RegExp(`\\breport\\s+${escapeRegExp(report)}\\s+(${required.map(escapeRegExp).join("|")})\\b`, "g");
  const matches = [...lowered.matchAll(pattern)];
  const modules = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const module = match[1];
    const segmentEnd = i + 1 < matches.length ? matches[i + 1].index : lowered.length;
    const segment = lowered.slice(match.index, segmentEnd);
    if (module === "tree" && !segment.includes("--values")) continue;
    if (!modules.includes(module)) modules.push(module);
  }
  return modules;
}

function financialTableCommand(normalized, lowered) {
  const hasReport = /\btable\b/.test(lowered) && /--report\s+company\b/.test(lowered);
  const hasIndicator = /--indicator\s+(ebitda|ebitdacompanyprofit)\b/.test(lowered);
  const hasDim = /--dim-type\s+(管理区域|manageareaid)(\s|$)/i.test(normalized);
  return hasReport && hasIndicator && hasDim;
}

export function isTemplateInjectionCommand(command) {
  return hasHarnessCLICommand(command, ["inject-template"]);
}

export function isTemplateStageCommand(command) {
  return hasHarnessCLICommand(command, ["stage", "template"]);
}

export function isQDMMetricCommand(command) {
  for (const segment of shellCommandSegments(command)) {
    const invocation = unwrapShellCommand(segment);
    if (invocation.length > 0 && isQDMMetricExecutable(invocation[0])) return true;
  }
  return false;
}

function hasHarnessCLICommand(command, expectedArgs) {
  for (const segment of shellCommandSegments(command)) {
    const invocation = unwrapShellCommand(segment);
    if (invocation.length < expectedArgs.length + 1 || !isExecutableNamed(invocation[0], "data-harness-cli")) continue;
    let matched = true;
    for (let i = 0; i < expectedArgs.length; i++) {
      if (invocation[i + 1].toLowerCase() !== expectedArgs[i].toLowerCase()) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function isQDMMetricExecutable(word) {
  const normalized = String(word || "").trim().toLowerCase();
  if (
    normalized === "$qdm_metric_cli" ||
    normalized === "$env:qdm_metric_cli" ||
    (normalized.startsWith("${qdm_metric_cli") && normalized.endsWith("}"))
  ) {
    return true;
  }
  return isExecutableNamed(word, "qdm-metric-cli");
}

function isExecutableNamed(word, name) {
  const normalized = String(word || "").trim().replaceAll("\\", "/");
  const base = path.posix.basename(normalized).toLowerCase();
  return base === name || base === `${name}.exe`;
}

export function shellCommandSegments(command) {
  const segments = [];
  let words = [];
  let word = "";
  let quote = "";
  const flushWord = () => {
    if (!word) return;
    words.push(word);
    word = "";
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const text = String(command || "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
        continue;
      }
      if (ch === "\\") {
        if (quote === '"' && i + 1 < text.length && (text[i + 1] === '"' || text[i + 1] === "\\")) {
          word += text[i + 1];
          i += 1;
          continue;
        }
        word += "/";
        continue;
      }
      word += ch;
      continue;
    }
    if (ch === "$" && i + 1 < text.length && text[i + 1] === "{") {
      word += "${";
      i += 2;
      for (; i < text.length; i++) {
        word += text[i];
        if (text[i] === "}") break;
      }
      continue;
    }
    if (ch === "$" && i + 1 < text.length && text[i + 1] === "(") {
      flushSegment();
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < text.length && (text[i + 1] === " " || text[i + 1] === "\t" || text[i + 1] === "\n")) {
        word += text[i + 1];
        i += 1;
      } else {
        word += "/";
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flushWord();
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      flushSegment();
      continue;
    }
    word += ch;
  }
  flushSegment();
  return segments;
}

function unwrapShellCommand(words) {
  let i = 0;
  while (i < words.length && (isShellAssignment(words[i]) || isShellControlWord(words[i]))) i += 1;
  while (i < words.length) {
    switch (words[i].toLowerCase()) {
      case "command":
      case "exec":
      case "nohup":
      case "builtin":
      case "time":
        i += 1;
        break;
      case "sudo":
        i += 1;
        while (i < words.length && words[i].startsWith("-")) i += 1;
        break;
      case "env":
        i += 1;
        while (i < words.length && (words[i].startsWith("-") || isShellAssignment(words[i]))) i += 1;
        break;
      default:
        return words.slice(i);
    }
  }
  return [];
}

function isShellControlWord(word) {
  switch (String(word || "").toLowerCase()) {
    case "if":
    case "then":
    case "elif":
    case "else":
    case "while":
    case "until":
    case "do":
      return true;
    default:
      return false;
  }
}

function isShellAssignment(word) {
  const cut = String(word || "").indexOf("=");
  if (cut <= 0) return false;
  const name = word.slice(0, cut);
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const isAlpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
    const isDigit = code >= 48 && code <= 57;
    if (!isAlpha && (i === 0 || !isDigit)) return false;
  }
  return true;
}

function selectedTemplatePath(root, state) {
  if (!state.selected_playbook) {
    return {
      templateRel: "",
      message: "QDM_INJECT_TEMPLATE no selectedPlaybook in session state. Do not guess a template; continue without template injection.",
    };
  }
  if (!state.selected_template) {
    return {
      templateRel: "",
      message: "QDM_INJECT_TEMPLATE no selectedTemplate in session state. Do not guess a template; continue without template injection.",
    };
  }
  if (!isAllowedTemplateSelectionPath(state.selected_template)) {
    return {
      templateRel: state.selected_template,
      message: `QDM_INJECT_TEMPLATE template must be templates/... or reports/.../template.md: ${state.selected_template}.`,
    };
  }
  let resolver;
  try {
    resolver = newPathResolver(root);
  } catch (error) {
    return {
      templateRel: state.selected_template,
      message: `QDM_INJECT_TEMPLATE path config error: ${error.message || error}.`,
    };
  }
  try {
    const info = statSync(resolver.resolve(state.selected_template));
    if (info.isDirectory()) {
      return { templateRel: state.selected_template, message: `QDM_INJECT_TEMPLATE missing ${state.selected_template}.` };
    }
  } catch {
    return { templateRel: state.selected_template, message: `QDM_INJECT_TEMPLATE missing ${state.selected_template}.` };
  }
  return { templateRel: state.selected_template, message: "" };
}

function stripMarkdownFrontmatter(text) {
  const lines = String(text).split("\n");
  if (!lines.length || lines[0].trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return text;
}

function normalizeCommand(command) {
  return String(command || "").replaceAll("\\", "/").trim().split(/\s+/).filter(Boolean).join(" ");
}

export function getReportState(state, reportName = "template") {
  if (!state.reports) state.reports = {};
  if (!reportName) reportName = "template";
  if (!state.reports[reportName]) {
    state.reports[reportName] = { recorded_modules: [], template_injected: false };
  }
  const current = state.reports[reportName];
  if (!Array.isArray(current.recorded_modules)) current.recorded_modules = [];
  return current;
}

export function addModule(reportState, module) {
  if (reportState.recorded_modules.includes(module)) return false;
  reportState.recorded_modules.push(module);
  return true;
}

function recordTemplateDiagnostic(root, sessionID, session, reportState, outcome, templatePath) {
  if (process.env.QDM_HARNESS_DIAG !== "1") return;
  let resolver;
  try {
    resolver = newPathResolver(root);
  } catch {
    const resourceRoot = normalizeResolverOwners(root).resourceRoot;
    resolver = { resolve: (rel) => path.join(resourceRoot, rel) };
  }
  const event = {
    ts: new Date().toISOString(),
    session_id: sessionID,
    event: "inject_template",
    selected_playbook: session.selected_playbook,
    selected_playbooks: session.selected_playbooks,
    mode: session.mode,
    composite: session.composite,
    template_path: templatePath,
    template_stats: pathStats(resolver.resolve(templatePath || "")),
    template_already_injected: Boolean(reportState?.template_injected),
    outcome,
  };
  try {
  const dir = diagnosticsDir(root);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `${safeSessionId(sessionID)}.jsonl`), `${JSON.stringify(event)}\n`);
  } catch {
    // diagnostics are best-effort
  }
}

function pathStats(filePath) {
  try {
    const data = readFileSync(filePath);
    return { path: filePath, exists: true, bytes: data.length, lines: countLines(data) };
  } catch {
    return { path: filePath, exists: false, bytes: 0, lines: 0 };
  }
}

function countLines(data) {
  if (!data.length) return 0;
  let lines = 0;
  for (const byte of data) {
    if (byte === 10) lines += 1;
  }
  if (data[data.length - 1] !== 10) lines += 1;
  return lines;
}

function parsePayload(input) {
  try {
    const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
