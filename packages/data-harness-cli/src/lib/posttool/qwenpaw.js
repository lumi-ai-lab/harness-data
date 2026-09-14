import { load as loadState, MODE_FREE, MODE_REPORT, save as saveState } from "../sessionstate.js";
import { addModule, getReportState, injectTemplate, REPORT_CONFIGS } from "./hook.js";

const SESSION_ID = /^qwenpaw:[0-9a-f]{64}$/;
const PAYLOAD_KEYS = new Set(["session_id", "tool_name", "status", "safe_command_args"]);
const REPORT_STAGE_TOOL = "qdm_report_stage";
const QUERY_TOOL = "qdm_query";

export function runQwenPawHook(root, input, context = null) {
  const rootOrContext = context || root;
  const payload = parseQwenPawPayload(input);
  if (
    !SESSION_ID.test(String(payload.session_id || "").trim()) ||
    ![QUERY_TOOL, REPORT_STAGE_TOOL].includes(payload.tool_name)
  ) {
    throw new Error("invalid qwenpaw-hook identity");
  }
  if (payload.status !== "success" && payload.status !== "error") {
    throw new Error("invalid qwenpaw-hook status");
  }
  validateSafeCommandArgs(payload.safe_command_args || {}, payload.tool_name);
  if (payload.status !== "success") {
    return { ok: true, diagnostic_code: "tool_failed" };
  }
  let state;
  try {
    state = loadState(rootOrContext, payload.session_id);
  } catch {
    return { ok: false, diagnostic_code: "session_state_unavailable" };
  }
  if (!state.mode) return { ok: false, diagnostic_code: "missing_session_state" };
  if (payload.tool_name === REPORT_STAGE_TOOL && state.mode !== MODE_REPORT) {
    return { ok: false, mode: state.mode, diagnostic_code: "report_mode_required" };
  }
  if (state.mode === MODE_FREE || !state.selected_template) {
    return {
      ok: payload.tool_name !== REPORT_STAGE_TOOL,
      mode: state.mode,
      diagnostic_code: payload.tool_name === REPORT_STAGE_TOOL ? "no_selected_template" : "no_template_required",
    };
  }
  const { reportName, module } = safeReportModule(payload.safe_command_args || {});
  if (reportName && module) {
    try {
      recordQwenPawModule(state, reportName, module);
      saveState(rootOrContext, payload.session_id, state);
    } catch {
      return { ok: false, mode: state.mode, diagnostic_code: "safe_args_invalid" };
    }
  }
  let injected;
  try {
    injected = injectTemplate(rootOrContext, payload.session_id);
  } catch {
    return { ok: false, mode: state.mode, diagnostic_code: "template_injection_failed" };
  }
  return {
    ok: injected.outcome === "template_injected",
    additional_context: injected.message,
    mode: state.mode,
    selected_template: injected.templateRel,
    diagnostic_code: injected.outcome,
  };
}

function parseQwenPawPayload(input) {
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : String(input || ""));
  } catch {
    throw new Error("invalid qwenpaw-hook payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid qwenpaw-hook payload");
  }
  for (const key of Object.keys(payload)) {
    if (!PAYLOAD_KEYS.has(key)) throw new Error("invalid qwenpaw-hook payload");
  }
  return payload;
}

function validateSafeCommandArgs(args, toolName) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid qwenpaw-hook payload");
  if (toolName === REPORT_STAGE_TOOL && Object.keys(args).length > 0) {
    throw new Error("qwenpaw report stage does not accept safe command arguments");
  }
  for (const [key, value] of Object.entries(args)) {
    if (key !== "report_name" && key !== "report_module") throw new Error("unsupported qwenpaw safe command argument");
    if (typeof value !== "string" || !value.trim() || value.length > 128) {
      throw new Error("invalid qwenpaw safe command argument");
    }
  }
}

function safeReportModule(args) {
  return {
    reportName: String(args.report_name || "").trim(),
    module: String(args.report_module || "").trim(),
  };
}

function recordQwenPawModule(state, reportName, module) {
  const config = REPORT_CONFIGS[reportName];
  if (!config || !config.requiredModules.includes(module)) throw new Error("unsupported report module");
  addModule(getReportState(state, reportName), module);
}
