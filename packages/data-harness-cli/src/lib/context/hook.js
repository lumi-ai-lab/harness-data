import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { loadConfig, newPathResolver } from "../harness.js";
import { contextFromHookPayload, RootContextError } from "../root-context.js";
import { assertWorkspaceAllowed } from "../workspace-policy.js";
import { diagnosticsDir, load as loadState, MODE_FREE, MODE_MULTI, MODE_REPORT, MODE_SINGLE, safeSessionId, save as saveState } from "../sessionstate.js";
import { buildWithPlan } from "./build.js";

const WORKBUDDY_SESSION_PREFIX = "workbuddy:";

export function runClaudeHook(root, input, context = null, options = {}) {
  const payload = parsePromptPayload(input);
  if (!payload || !payload.prompt) return { ok: false, output: null };
  let effectiveContext = context;
  try {
    effectiveContext = contextFromHookPayload(payload, {
      root,
      env: options.env || process.env,
      baseContext: context,
    }) || effectiveContext;
  } catch (error) {
    if (error instanceof RootContextError) {
      return {
        ok: true,
        output: workspaceRequiredOutput(`${error.code}: ${error.message}`),
      };
    }
    return {
      ok: true,
      output: hookSafetyOutput(
        "QDM_HARNESS_UNAVAILABLE: Harness hook context could not be loaded. Do not run qdm-metric-cli or estimate values until the runtime configuration is repaired.",
      ),
    };
  }
  const sessionID = hookSessionID(payload);
  const workspaceDecision = checkWorkspacePolicy(effectiveContext);
  if (workspaceDecision === "denied") return { ok: false, output: null };
  if (workspaceDecision === "unavailable") {
    return {
      ok: true,
      output: hookSafetyOutput("QDM_SETUP_REQUIRED: configure the Harness Data workspace allowlist before using this project."),
    };
  }
  if (
    isOnDemandContext(effectiveContext, payload.prompt, sessionID, root) &&
    !shouldAutoRecall(effectiveContext, payload.prompt)
  ) {
    return { ok: false, output: null };
  }
  if (effectiveContext && (!effectiveContext.workspaceRoot || effectiveContext.capabilities?.canWriteWorkspace === false)) {
    // Only report operations require a writable workspace; read-only metric
    // context stays available for read-only hosts (QwenPaw ships with
    // canWriteWorkspace=false but still needs the injected manuals).
    let requiresWorkspace = true;
    try {
      requiresWorkspace = buildWithPlan(effectiveContext, payload.prompt).mode === MODE_REPORT;
    } catch {
      requiresWorkspace = true; // fail closed when the plan cannot be built
    }
    if (requiresWorkspace) {
      return {
        ok: true,
        output: workspaceRequiredOutput("QDM_WORKSPACE_REQUIRED: explicit context/report operations require workspaceRoot; read-only context is still available."),
      };
    }
  }
  try {
    const persistState = !effectiveContext ||
      String(effectiveContext.host || "").trim().toLowerCase() !== "codex" ||
      isExplicitContextPrompt(payload.prompt) ||
      isContinuationPrompt(payload.prompt);
    return runPromptHook(root, payload.prompt, sessionID, effectiveContext, { persistState });
  } catch (error) {
    return {
      ok: true,
      output: hookSafetyOutput(
        `QDM_HARNESS_UNAVAILABLE: Harness context could not be built${error?.code ? ` (${error.code})` : ""}. Do not run qdm-metric-cli or estimate values until the runtime configuration is repaired.`,
      ),
    };
  }
}

export function runWorkBuddyHook(root, input, context = null, options = {}) {
  const payload = parsePromptPayload(input);
  if (!payload || !String(payload.prompt || "").trim()) return { ok: false, output: null };
  let effectiveContext = context;
  try {
    effectiveContext = contextFromHookPayload(payload, {
      root,
      env: options.env || process.env,
      baseContext: context,
    }) || effectiveContext;
  } catch (error) {
    if (error instanceof RootContextError) {
      return {
        ok: true,
        output: workBuddySafetyOutput(`${error.code}: ${error.message}`),
      };
    }
    throw error;
  }
  const workspaceDecision = checkWorkspacePolicy(effectiveContext);
  if (workspaceDecision === "denied") return { ok: false, output: null };
  if (workspaceDecision === "unavailable") {
    return {
      ok: true,
      output: workBuddySafetyOutput("QDM_SETUP_REQUIRED: configure the Harness Data workspace allowlist before using this project."),
    };
  }
  const sessionID = String(payload.session_id || "").trim();
  if (!sessionID) {
    return {
      ok: true,
      output: workBuddySafetyOutput(
        "QDM_HARNESS_BLOCKED: WorkBuddy did not provide a stable session_id. Do not run qdm-metric-cli, do not estimate data, and do not run template commands in this turn. Start a new WorkBuddy session or update WorkBuddy before retrying.",
      ),
    };
  }
  if (isOnDemandContext(effectiveContext, payload.prompt, WORKBUDDY_SESSION_PREFIX + sessionID, root)) {
    return { ok: false, output: null };
  }
  if (effectiveContext && (!effectiveContext.workspaceRoot || effectiveContext.capabilities?.canWriteWorkspace === false)) {
    return {
      ok: true,
      output: workspaceRequiredOutput("QDM_WORKSPACE_REQUIRED: explicit context/report operations require workspaceRoot; read-only context is still available."),
    };
  }
  let cfg;
  try {
    cfg = loadConfig(effectiveContext || root);
  } catch {
    return {
      ok: true,
      output: workBuddySafetyOutput(
        "QDM_HARNESS_UNAVAILABLE: Harness configuration could not be loaded. Do not run qdm-metric-cli or estimate data until the runtime configuration is repaired.",
      ),
    };
  }
  let result;
  try {
    result = runPromptHook(root, payload.prompt, WORKBUDDY_SESSION_PREFIX + sessionID, effectiveContext);
  } catch {
    return {
      ok: true,
      output: workBuddySafetyOutput(
        "QDM_HARNESS_UNAVAILABLE: Harness context could not be built. Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
      ),
    };
  }
  if (!result.ok) return { ok: false, output: null };
  result.output.hookSpecificOutput.additionalContext =
    `authzMode: ${cfg.authz.mode}\n\n${result.output.hookSpecificOutput.additionalContext}`;
  return {
    ok: true,
    output: {
      continue: true,
      hookSpecificOutput: result.output.hookSpecificOutput,
    },
  };
}

function workBuddySafetyOutput(message) {
  return {
    continue: true,
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: message,
    },
  };
}

function checkWorkspacePolicy(context) {
  if (!context?.workspaceRoot) return "ok";
  try {
    assertWorkspaceAllowed(context);
    return "ok";
  } catch (error) {
    if (error?.code === "QDM_WORKSPACE_NOT_ALLOWED") return "denied";
    if (error?.code === "QDM_SETUP_REQUIRED") return "unavailable";
    throw error;
  }
}

function workspaceRequiredOutput(message) {
  return hookSafetyOutput(message);
}

function hookSafetyOutput(message) {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: message,
    },
  };
}

function runPromptHook(root, prompt, sessionID, context = null, { persistState = true } = {}) {
  const rootOrContext = context || root;
  const resolver = newPathResolver(rootOrContext);
  const tc = buildTimeContext(prompt, resolver, !context);
  const { response, plan } = buildWithPlan(rootOrContext, prompt);
  const additionalContext = buildWikiAdditionalContext(tc, response, plan, resolver);
  if (persistState) writeWikiPlanState(rootOrContext, sessionID, prompt, plan, context);
  if (process.env.QDM_HARNESS_DIAG === "1" && (!context || context.capabilities?.hasStableSessionId)) {
    recordDiagnostic(rootOrContext, sessionID, prompt, additionalContext, tc, response);
  }
  return {
    ok: true,
    output: {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
        contextFiles: [...response.contextFiles],
      },
    },
  };
}

function buildWikiAdditionalContext(tc, response, plan, resolver) {
  let b = "# Data Harness Context\n\n";
  b += `时间解析 JSON：\`${JSON.stringify(tc)}\`\n`;
  b += `resourceRoot: \`${resolver.resourceRoot}\`\n\n`;
  b += `Harness mode: ${plan.mode}\n`;
  if (plan.selectedPlaybook) b += `selectedPlaybook: ${plan.selectedPlaybook}\n`;
  if (plan.selectedTemplate) b += `selectedTemplate: ${plan.selectedTemplate}\n`;
  if (plan.templateSelection?.status) {
    b += `templateSelection: ${plan.templateSelection.status}`;
    if (plan.templateSelection.reason) b += ` (${plan.templateSelection.reason})`;
    b += "\n";
  }
  if (plan.selectedPlaybooks?.length) {
    b += "selectedPlaybooks:\n";
    for (const playbook of plan.selectedPlaybooks) b += `- ${playbook.path}\n`;
  }
  if (plan.mode === MODE_FREE) b += `reason: ${plan.reason || ""}\n`;
  b += "\n必须先读取以下 contextFiles（可信绝对路径，不得按 workspaceRoot 解析）：\n";
  for (const ref of response.contextFiles) {
    b += `- \`${resolver.resolve(ref.path)}\``;
    const annotations = [];
    if (ref.reason) annotations.push(ref.reason);
    annotations.push(`logical: \`${ref.path}\``);
    b += ` (${annotations.join("; ")})\n`;
  }
  b += `\nInstruction: ${response.instruction}`;
  b += "\n\nConstraints:\n";
  for (const constraint of response.constraints) b += `- ${constraint}\n`;
  return b;
}

function parsePromptPayload(input) {
  try {
    const text = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object") return null;
    return payload;
  } catch {
    return null;
  }
}

function buildTimeContext(prompt, resolver, includePrompt = true) {
  let current;
  const currentDate = process.env.QDM_HARNESS_CURRENT_DATE || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) current = currentDate;
  else current = formatDate(new Date());
  let timezone = process.env.QDM_HARNESS_TIMEZONE || process.env.TZ || "";
  if (!timezone) timezone = "Asia/Shanghai";
  let timePolicy = "spec/common/time-policy.md";
  try {
    const info = statSync(resolver.resolve("rules/QDM 时间口径/spec.md"));
    if (!info.isDirectory()) timePolicy = "rules/QDM 时间口径/spec.md";
  } catch {
    // keep default
  }
  const context = {
    current_date: current,
    timezone,
    time_policy: `Use ${resolver.resolve(timePolicy)} to infer --date, --week, or --month. Do not use date ranges.`,
  };
  if (includePrompt) context.prompt = prompt;
  return context;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hookSessionID(payload) {
  if (payload.session_id) return payload.session_id;
  return process.env.CLAUDE_SESSION_ID || "unknown";
}

function writeWikiPlanState(root, sessionID, prompt, plan, context = null) {
  if (context && (!context.capabilities?.hasStableSessionId || !context.stateRoot)) return;
  const state = loadState(root, sessionID);
  state.mode = plan.mode;
  if (context) {
    delete state.prompt;
    state.prompt_sha256 = createHash("sha256").update(prompt).digest("hex");
  } else {
    state.prompt = prompt;
  }
  state.started_at = new Date().toISOString();
  state.playbook_candidates = plan.candidates || [];
  state.selected_playbook = "";
  state.selected_template = "";
  state.selected_playbooks = undefined;
  state.composite = undefined;
  state.reason = "";
  state.template_injected = false;
  state.reports = {};
  switch (plan.mode) {
    case MODE_SINGLE:
      state.selected_playbook = plan.selectedPlaybook;
      state.selected_template = plan.selectedTemplate;
      break;
    case MODE_MULTI:
      state.selected_playbooks = [...(plan.selectedPlaybooks || [])];
      break;
    case MODE_REPORT:
      state.selected_playbook = plan.selectedPlaybook;
      state.selected_template = plan.selectedTemplate;
      break;
    case MODE_FREE:
      state.reason = plan.reason;
      break;
    default:
      break;
  }
  saveState(root, sessionID, state);
}

function recordDiagnostic(root, sessionID, prompt, context, tc, response) {
  const event = {
    ts: new Date().toISOString(),
    session_id: sessionID,
    event: "user_prompt_context",
    context_files: response.contextFiles,
    prompt_bytes: Buffer.byteLength(prompt),
    context_bytes: Buffer.byteLength(context),
    time_context: tc,
  };
  const dir = diagnosticsDir(root);
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, `${safeSessionId(sessionID)}.jsonl`), `${JSON.stringify(event)}\n`);
}

function shouldAutoRecall(context, prompt) {
  if (String(context?.host || "").trim().toLowerCase() !== "codex") return false;
  try {
    return buildWithPlan(context, prompt).plan.mode !== MODE_FREE;
  } catch {
    return false;
  }
}

/**
 * Structured plugin hooks default to on-demand context. Codex prompts that
 * match a known Harness plan are still injected automatically; legacy
 * string-root callers retain the historical auto-context behavior.
 */
function isOnDemandContext(context, prompt, sessionID, root) {
  if (!context) return false;
  const mode = String(process.env.QDM_HARNESS_HOOK_MODE || "on-demand").trim().toLowerCase();
  if (mode === "auto-context") return false;
  if (isExplicitContextPrompt(prompt)) return false;
  if (isContinuationPrompt(prompt)) {
    try {
      const prior = loadState(context || root, sessionID);
      if (prior?.mode) return false;
    } catch {
      // If state cannot be read, fail closed and do not inject context.
    }
  }
  return true;
}

export function isExplicitContextPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (/<skill\b[^>]*name\s*=\s*["'](?:qdm-harness|html-report)["']/i.test(text)) return true;
  if (/(?:^|[\s/])skill\s*:\s*(?:qdm-harness|html-report)\b/i.test(text)) return true;
  if (/\b(?:qdm-harness|html-report)\b/i.test(text)) return true;
  return text.includes("报告") && /生成|做|制作|输出|写|创建|来一份|周例会|经营分析|盈利情况|销售情况|分析报告/.test(text);
}

export function isContinuationPrompt(prompt) {
  return /继续|确认|已保存|保存好了|保存完|下一步|往下|推进|开始生成|开始取数|\badvance\b/i.test(String(prompt || ""));
}
