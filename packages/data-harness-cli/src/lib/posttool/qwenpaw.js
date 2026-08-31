import { load as loadState, MODE_FREE, save as saveState } from "../sessionstate.js";
import { addModule, getReportState, injectTemplate, REPORT_CONFIGS } from "./hook.js";

const SESSION_ID = /^qwenpaw:[0-9a-f]{64}$/;
const PAYLOAD_KEYS = new Set(["session_id", "tool_name", "status", "safe_command_args"]);

export function runQwenPawHook(root, input, context = null) {
  const rootOrContext = context || root;
  const payload = parseQwenPawPayload(input);
  if (!SESSION_ID.test(String(payload.session_id || "").trim()) || payload.tool_name !== "qdm_query") {
    throw new Error("invalid qwenpaw-hook identity");
  }
  if (payload.status !== "success" && payload.status !== "error") {
    throw new Error("invalid qwenpaw-hook status");
  }
  validateSafeCommandArgs(payload.safe_command_args || {});
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
  if (state.mode === MODE_FREE || !state.selected_template) {
    return { ok: true, mode: state.mode, diagnostic_code: "no_template_required" };
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

function validateSafeCommandArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid qwenpaw-hook payload");
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
