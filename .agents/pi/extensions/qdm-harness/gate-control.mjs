import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  STAGE_DEFINITIONS,
  formatGateMessage,
  pipelineStatePath,
} from "../../skills/html-report/scripts/stage-gate.mjs";
import { EDITOR_PLANNER_MARKER } from "../../skills/html-report/scripts/editor-plan-contract.mjs";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MODEL_GATE_OPERATIONS = new Set(["status", "finish", "fail"]);
const packageResourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const HTML_REPORT_STAGE_TOOL = "html_report_run_stage";
export const HTML_REPORT_RUNNER_STAGES = new Set([
  "B2_WRITER",
  "B25_EDITOR",
  "B3_RESEARCH",
  "B4_REVIEW",
  "B5_DESIGN",
]);

export function sanitizeSessionId(raw) {
  return String(raw || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function htmlReportSessionDir(projectRoot, sessionId) {
  return join(resolve(projectRoot), ".harness", "state", "html-report", sanitizeSessionId(sessionId));
}

export function stageGateScriptPath(_projectRoot) {
  return join(packageResourceRoot, "skills", "html-report", "scripts", "stage-gate.mjs");
}

export function gateAttemptToken(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const stageId = state.currentStage;
  const stage = state.stages && typeof state.stages === "object" && !Array.isArray(state.stages)
    ? state.stages[stageId]
    : null;
  const attempts = stage && typeof stage === "object" && Array.isArray(stage.attempts) ? stage.attempts : [];
  const latest = attempts.length ? attempts.at(-1) : null;
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) return null;
  if (!Number.isSafeInteger(latest.number) || typeof latest.startedAt !== "string" || !latest.startedAt) return null;
  return `${stageId}:${latest.number}:${latest.startedAt}`;
}

export function b2WriterMainWorkAccepted(state) {
  const writer = state?.stages?.B2_WRITER?.status;
  const main = state?.stages?.B2_MAIN?.status;
  return writer === "completed" && (main === "completed" || main === "awaiting_approval");
}

export function htmlReportStageReservation(projectRoot, sessionId, state) {
  if (!state || state.status !== "running" || !HTML_REPORT_RUNNER_STAGES.has(state.currentStage)) return null;
  const attempt = gateAttemptToken(state);
  if (!attempt) return null;
  return `qdm-stage-v1-${createHash("sha256")
    .update(JSON.stringify([resolve(projectRoot), sanitizeSessionId(sessionId), state.currentStage, attempt]), "utf8")
    .digest("hex")}`;
}

/**
 * Distinguish an ordinary/new Session from an html-report Session whose
 * durable Gate state is missing or corrupt. Returning null for both cases
 * would let a damaged report Session silently fall back to unrestricted mode.
 */
export function inspectGateState(projectRoot, sessionId) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const statePath = pipelineStatePath(sessionDir);
  if (!existsSync(sessionDir)) return { kind: "absent", sessionDir, statePath };
  try {
    if (!statSync(sessionDir).isDirectory()) {
      return { kind: "invalid", sessionDir, statePath, error: "html-report Session path is not a directory" };
    }
  } catch (error) {
    return { kind: "invalid", sessionDir, statePath, error: `cannot inspect Session directory: ${error.message || error}` };
  }
  if (!existsSync(statePath)) {
    return { kind: "invalid", sessionDir, statePath, error: "debug/pipeline-state.json is missing" };
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return { kind: "invalid", sessionDir, statePath, error: "pipeline state must be one JSON object" };
    }
    const expectedSessionId = sanitizeSessionId(sessionId);
    const errors = [];
    if (state.version !== 1) errors.push("version must be 1");
    if (state.producer !== "stage-gate.mjs") errors.push("producer must be stage-gate.mjs");
    if (state.sessionId !== expectedSessionId) errors.push("sessionId does not match the Pi Session");
    if (typeof state.sessionDir !== "string" || resolve(state.sessionDir) !== sessionDir) {
      errors.push("sessionDir does not match the html-report Session directory");
    }
    if (!Object.hasOwn(STAGE_DEFINITIONS, state.currentStage)) errors.push("currentStage is invalid");
    if (!state.stages || typeof state.stages !== "object" || Array.isArray(state.stages)) {
      errors.push("stages must be an object");
    } else if (!state.stages[state.currentStage] || typeof state.stages[state.currentStage] !== "object") {
      errors.push("currentStage is missing from stages");
    }
    if (!new Set(["step", "auto"]).has(state.mode)) errors.push("mode must be step or auto");
    if (!new Set(["paused", "running", "awaiting_approval", "failed", "completed"]).has(state.status)) {
      errors.push("status is invalid");
    }
    return errors.length
      ? { kind: "invalid", sessionDir, statePath, error: errors.join("; ") }
      : { kind: "valid", sessionDir, statePath, state };
  } catch (error) {
    return { kind: "invalid", sessionDir, statePath, error: `cannot parse pipeline state: ${error.message || error}` };
  }
}

export function readGateState(projectRoot, sessionId) {
  const inspected = inspectGateState(projectRoot, sessionId);
  return inspected.kind === "valid" ? inspected.state : null;
}

function normalizeInput(text) {
  return String(text || "")
    .trim()
    .replace(/[。！!]+$/g, "")
    .replace(/\s+/g, "");
}

/** Only explicit control phrases may mutate a waiting gate. */
export function classifyGateInput(text) {
  const normalized = normalizeInput(text);
  if (normalized === "继续") return "continue";
  if (normalized === "确认生成报告") return "confirm";
  if (normalized === "重试当前阶段") return "retry";
  if (normalized === "关闭单步调试并继续") return "disable_step";
  if (normalized === "生成HTML") return "generate_html";
  if (normalized === "重试HTML生成") return "retry_html";
  if (normalized === "暂不生成HTML") return "skip_html";
  return null;
}

/**
 * Minimal shell tokenizer for direct `node stage-gate.mjs ...` calls.
 * Control operators, redirects, substitutions and multiline commands make a
 * command non-standalone and are rejected before execution.
 */
function shellWords(command) {
  const source = String(command || "").replace(/\\\r?\n/g, " ");
  if (!source.trim() || /[\r\n;&|<>`]/.test(source) || /\$\(/.test(source)) return null;
  const words = [];
  let word = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const char of source) {
    if (escaped) {
      word += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }
  if (escaped || quote) return null;
  if (started) words.push(word);
  return words;
}

export function parseStandaloneStageGateCommand(command) {
  const words = shellWords(command);
  if (!words || words.length < 3) return null;
  if (basename(words[0]) !== "node") return null;
  if (basename(words[1]) !== "stage-gate.mjs") return null;
  const operation = words[2];
  if (!/^[a-z]+$/.test(operation)) return null;
  const options = {};
  for (let index = 3; index < words.length; index += 2) {
    const flag = words[index];
    const value = words[index + 1];
    if (!/^--[a-z-]+$/.test(flag) || value === undefined) return null;
    if (Object.hasOwn(options, flag)) return null;
    options[flag] = value;
  }
  return { operation, options, words };
}

/** Parse only the exact terminal B25 Editor finalizer invocation. */
export function parseStandaloneEditorFinalizerCommand(command) {
  const words = shellWords(command);
  if (!words || words.length !== 4) return null;
  if (basename(words[0]) !== "node") return null;
  if (basename(words[1]) !== "finalize-editor-stage.mjs") return null;
  if (words[2] !== "--result" || !words[3]) return null;
  return { scriptPath: words[1], resultPath: words[3], words };
}

function repairObservedMissingMacRoot(source) {
  const quoted = source.match(/^(\s*node\s+)(['"])\.Users\/([^'"]+)\2(?=\s)/);
  if (quoted) {
    const correctedPath = `/Users/${quoted[3]}`;
    const corrected = source.replace(quoted[0], `${quoted[1]}${quoted[2]}${correctedPath}${quoted[2]}`);
    if (
      basename(correctedPath) === "stage-gate.mjs" &&
      existsSync(correctedPath) &&
      parseStandaloneStageGateCommand(corrected)
    ) return corrected;
  }
  const unquoted = source.match(/^(\s*node\s+)\.Users\/(\S+)(?=\s)/);
  if (unquoted) {
    const correctedPath = `/Users/${unquoted[2]}`;
    const corrected = source.replace(unquoted[0], `${unquoted[1]}${correctedPath}`);
    if (
      basename(correctedPath) === "stage-gate.mjs" &&
      existsSync(correctedPath) &&
      parseStandaloneStageGateCommand(corrected)
    ) return corrected;
  }
  return source;
}

/**
 * Normalize two observed, unambiguous model drifts only when the result is a
 * valid standalone stage-gate command. Pi already captures stderr, so a final
 * `2>&1` is redundant. On macOS, a model may also copy the real `/Users/...`
 * script path as `.Users/...`; repair that typo only when the corrected script
 * exists. Never relax chaining, arbitrary redirects, substitutions or paths.
 */
export function normalizeStandaloneStageGateCommand(command) {
  const source = String(command || "");
  const repaired = repairObservedMissingMacRoot(source);
  const stripped = repaired.replace(/[ \t]+2>&1[ \t]*$/, "").trimEnd();
  if (stripped !== repaired && parseStandaloneStageGateCommand(stripped)) return stripped;
  return repaired;
}

function blockedReason(state) {
  if (state.status === "failed") return formatGateMessage(state);
  if (state.status === "awaiting_approval") {
    return `${formatGateMessage(state)}\n当前必须立即停止工具调用并返回 Gate 文本，不得主动检查目录或文件。仅在用户明确要求只读诊断时才允许 read/grep/find/ls 或 stage-gate status。`;
  }
  if (state.status === "paused") {
    return `${formatGateMessage(state)}\n当前阶段已暂停，须由用户回复“继续”恢复。`;
  }
  return "stage-gate finish 正在执行；它必须是本阶段最后一个且独立的工具调用。";
}

const B25_EDITOR_DISCOVERY_TOOLS = new Set(["find", "grep", "ls"]);
const B25_EDITOR_WRITER_ARTIFACT = /(?:data[\\/]cards(?:[\\/]|$)|entry\.meta\.json|entry\.json|\.pi-subagents(?:[\\/]|$))/i;

function shellInvokes(command, names) {
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // Cover a standalone command, a command after a shell separator/subshell,
  // and absolute executable paths such as /bin/ls. Quoted prose and script
  // filenames containing these strings do not match.
  return new RegExp(
    `(?:^|[\\n;&|()]\\s*)(?:command\\s+|sudo\\s+)?(?:/[^\\s;&|()]+/)?(?:${alternatives})(?=\\s|$|[;&|()])`,
    "m"
  ).test(String(command || ""));
}

/**
 * B2.5 has one inventory bridge followed by one typed Planner call. Directory
 * discovery, manual artifact authorship, or lifecycle commands can only
 * duplicate extension-owned work and introduce a full model/tool round trip,
 * so fail closed at the runtime boundary instead of relying on prompts alone.
 */
export function b25EditorToolDecision(state, event) {
  if (
    state?.status !== "running" ||
    state?.currentStage !== "B25_EDITOR"
  ) {
    return null;
  }
  const toolName = String(event?.toolName || "").toLowerCase();
  if (["write", "edit"].includes(toolName)) {
    return {
      block: true,
      reason: "B2.5 的 tasks.json/main.md 由 typed Planner 返回后的确定性 materializer 写入；父代理禁止手工 write/edit。",
    };
  }
  if (B25_EDITOR_DISCOVERY_TOOLS.has(toolName)) {
    return {
      block: true,
      reason: "B2.5 analysis 目录已由 Gate 准备；禁止 ls/find/grep，等待 typed Planner 后由扩展确定性写入产物。",
    };
  }
  if (toolName === "read") {
    const input = JSON.stringify(event?.input || {});
    if (B25_EDITOR_WRITER_ARTIFACT.test(input)) {
      return {
        block: true,
        reason: "B2.5 禁止重新读取 Writer entry/meta 或 .pi-subagents；请使用已返回的结构化结果与 --source-fields 输出。",
      };
    }
  }
  if (toolName !== "bash") return null;
  const command = String(event?.input?.command || "");
  const stageGate = parseStandaloneStageGateCommand(command);
  if (stageGate?.operation === "finish") {
    return {
      block: true,
      reason: "B25_EDITOR 只能由 typed Planner result 的父扩展自动 finish；父代理禁止提前或重复 finish。",
    };
  }
  if (/finalize-editor-stage\.mjs/.test(command)) {
    return {
      block: true,
      reason: "B2.5 finalizer 由 Planner structured result 的父扩展自动执行；父代理禁止手工调用或重试。",
    };
  }
  if (
    /prepare-research-evidence\.mjs[\s\S]*--pending-reuse/.test(command) ||
    /assemble-report\.mjs/.test(command) ||
    (/check-session-layout\.mjs/.test(command) && /--phase\s+["']?b2(?:["']?)(?=\s|$)/.test(command))
  ) {
    return {
      block: true,
      reason: "B2.5 写完 tasks.json/main.md 后只允许一次 finalize-editor-stage.mjs；禁止拆分执行 pending-reuse、assemble 或 b2 layout。",
    };
  }
  if (shellInvokes(command, ["ls", "find", "grep", "mkdir"])) {
    return {
      block: true,
      reason: "B2.5 analysis 目录已由 Gate 准备；禁止执行 ls/find/grep/mkdir，等待 typed Planner 后由扩展确定性写入产物。",
    };
  }
  if (B25_EDITOR_WRITER_ARTIFACT.test(command)) {
    return {
      block: true,
      reason: "B2.5 禁止通过 Bash 重新探测或读取 Writer entry/meta 与 .pi-subagents。",
    };
  }
  return null;
}

/** Return null to allow, or a Pi ToolCallEventResult-compatible block. */
export function gateToolDecision(state, event, { finishInFlight = false, stageReservation = null } = {}) {
  if (!state) return null;
  const toolName = String(event?.toolName || "").toLowerCase();
  const command = toolName === "bash" ? String(event?.input?.command || "") : "";
  const parsedGateCommand = command ? parseStandaloneStageGateCommand(command) : null;

  if (finishInFlight) {
    return { block: true, reason: blockedReason(state) };
  }

  if (state.status === "running" && HTML_REPORT_RUNNER_STAGES.has(state.currentStage)) {
    if (toolName !== HTML_REPORT_STAGE_TOOL) {
      return {
        block: true,
        reason: `当前 ${state.currentStage} 只允许调用 ${HTML_REPORT_STAGE_TOOL}；子代理队列和阶段脚本由 qdm-harness 内部执行。`,
      };
    }
    return null;
  }

  const editorDecision = b25EditorToolDecision(state, event);
  if (editorDecision) return editorDecision;

  if (["paused", "failed"].includes(state.status) ||
      (state.mode === "step" && state.status === "awaiting_approval")) {
    if (READ_ONLY_TOOLS.has(toolName)) return null;
    if (toolName === "bash" && parsedGateCommand?.operation === "status") return null;
    return { block: true, reason: blockedReason(state) };
  }

  if (toolName === "bash" && /stage-gate\.mjs/.test(command)) {
    if (!parsedGateCommand) {
      return {
        block: true,
        reason: "stage-gate 命令必须是独立、无管道/重定向/命令拼接的 node 调用。",
      };
    }
    if (!MODEL_GATE_OPERATIONS.has(parsedGateCommand.operation)) {
      return {
        block: true,
        reason: `模型不能执行 stage-gate ${parsedGateCommand.operation}；批准、重试和恢复仅由用户输入触发。`,
      };
    }
    if (["finish", "fail"].includes(parsedGateCommand.operation)) {
      const requestedStage = parsedGateCommand.options["--stage"];
      if (requestedStage !== state.currentStage) {
        return {
          block: true,
          reason: `stage mismatch: current=${state.currentStage}, requested=${requestedStage || "<missing>"}`,
        };
      }
    }
  }
  if (state.mode === "auto") return null;
  return null;
}

export function runStageGate(projectRoot, sessionId, operation, args = []) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const script = stageGateScriptPath(projectRoot);
  const result = spawnSync(
    process.execPath,
    [script, operation, "--session-dir", sessionDir, ...args.map(String)],
    { cwd: resolve(projectRoot), encoding: "utf8" }
  );
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || result.stderr || "null");
  } catch {
    payload = null;
  }
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: payload?.error || (result.stderr || result.stdout || "stage-gate failed").trim(),
      payload,
    };
  }
  return { ok: true, status: 0, payload };
}

export function initializeGateForHtmlReport(projectRoot, sessionId, mode = "step") {
  const initialized = runStageGate(projectRoot, sessionId, "init", [
    "--mode",
    mode,
    "--session-id",
    sanitizeSessionId(sessionId),
  ]);
  if (!initialized.ok) return initialized;
  const state = initialized.payload?.state;
  const current = state?.stages?.[state.currentStage];
  if (state?.status === "paused" && current && !current.attempts?.length) {
    return runStageGate(projectRoot, sessionId, "start", ["--stage", state.currentStage]);
  }
  return initialized;
}

function htmlGateRejected(action, rejected, message) {
  return { handled: true, action, rejected, exportResult: null, message };
}

function formatHtmlExportMessage(action, exportResult, state) {
  const gateText = state ? formatGateMessage(state, { stageId: "B2_MAIN" }) : "";
  if (action === "skip_html") {
    return ["已跳过 HTML 导出。", gateText].filter(Boolean).join("\n");
  }
  if (!exportResult?.ok) {
    return [
      `HTML 生成失败：${exportResult?.error || "unknown error"}`,
      "analysis/main.md 未改写；B2_MAIN 仍可批准。",
      "回复“重试 HTML 生成”重试导出，或回复“继续”/“暂不生成 HTML”跳过。",
      gateText,
    ].filter(Boolean).join("\n");
  }
  if (exportResult.status === "up_to_date") {
    return [
      "analysis/main.html 已是最新，未重复导出。",
      exportResult.htmlPath ? `路径：${exportResult.htmlPath}` : "",
      gateText,
    ].filter(Boolean).join("\n");
  }
  return [
    "已生成 analysis/main.html。",
    exportResult.htmlPath ? `路径：${exportResult.htmlPath}` : "",
    gateText,
  ].filter(Boolean).join("\n");
}

async function exportMainHtmlForSession(sessionDir, exportHtml) {
  if (typeof exportHtml === "function") return exportHtml(sessionDir);
  const { exportMainHtml } = await import("../../skills/html-report/scripts/export-main-html.mjs");
  return exportMainHtml(sessionDir);
}

export async function applyGateInput(projectRoot, sessionId, text, { exportHtml } = {}) {
  const action = classifyGateInput(text);
  if (!action) return { handled: false, action: null };
  const state = readGateState(projectRoot, sessionId);
  if (!state) return { handled: false, action, reason: "gate_not_initialized" };

  if (action === "disable_step") {
    const result = runStageGate(projectRoot, sessionId, "resume", [
      "--mode",
      "auto",
      "--phrase",
      text,
      "--actor",
      "user",
    ]);
    return { handled: true, action, result };
  }
  if (action === "retry") {
    if (state.status !== "failed") {
      return { handled: true, action, rejected: "current_stage_not_failed" };
    }
    const result = runStageGate(projectRoot, sessionId, "retry", [
      "--phrase",
      text,
      "--actor",
      "user",
    ]);
    return { handled: true, action, result };
  }
  if (action === "confirm" && state.currentStage !== "A_CONFIG") {
    return { handled: true, action, rejected: "confirm_only_approves_A_CONFIG" };
  }
  if (action === "generate_html" || action === "retry_html" || action === "skip_html") {
    if (state.currentStage !== "B2_MAIN") {
      return htmlGateRejected(action, "html_only_on_b2_main", "“生成 HTML”仅用于 B2 Main 阶段。");
    }
    if (state.status === "failed") {
      return htmlGateRejected(action, "failed_stage_requires_retry", "当前阶段失败；请回复“重试当前阶段”。");
    }
    if (!["awaiting_approval", "completed"].includes(state.status)) {
      return htmlGateRejected(action, "html_gate_not_ready", "当前 B2_MAIN 尚未完成 main.md，不能导出 HTML。");
    }
    if (action === "skip_html") {
      if (state.status !== "awaiting_approval") {
        return htmlGateRejected(action, "gate_not_waiting", "当前没有等待批准的 HTML 导出。");
      }
      const result = runStageGate(projectRoot, sessionId, "approve", [
        "--phrase",
        text,
        "--actor",
        "user",
      ]);
      const after = result.payload?.state || readGateState(projectRoot, sessionId);
      return {
        handled: true,
        action,
        result,
        exportResult: null,
        message: formatHtmlExportMessage(action, null, after),
      };
    }
    const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
    let exportResult;
    try {
      exportResult = await exportMainHtmlForSession(sessionDir, exportHtml);
    } catch (error) {
      exportResult = {
        ok: false,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!exportResult?.ok) {
      const current = readGateState(projectRoot, sessionId);
      return {
        handled: true,
        action,
        result: null,
        exportResult,
        message: formatHtmlExportMessage(action, exportResult, current),
      };
    }
    let result = null;
    if (state.status === "awaiting_approval") {
      result = runStageGate(projectRoot, sessionId, "approve", [
        "--phrase",
        text,
        "--actor",
        "user",
      ]);
    }
    const after = result?.payload?.state || readGateState(projectRoot, sessionId);
    return {
      handled: true,
      action,
      result,
      exportResult,
      message: formatHtmlExportMessage(action, exportResult, after),
    };
  }
  if (state.status === "failed") {
    return { handled: true, action, rejected: "failed_stage_requires_retry" };
  }
  if (state.status === "awaiting_approval") {
    const result = runStageGate(projectRoot, sessionId, "approve", [
      "--phrase",
      text,
      "--actor",
      "user",
    ]);
    return { handled: true, action, result };
  }
  if (state.status === "paused") {
    const result = runStageGate(projectRoot, sessionId, "resume", [
      "--phrase",
      text,
      "--actor",
      "user",
    ]);
    return { handled: true, action, result };
  }
  return { handled: true, action, rejected: "gate_not_waiting" };
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * One source of truth for the B2.5 bootstrap handoff.  The parent model still
 * emits the required read-only Gate status and source inventory calls, while
 * qdm-harness can bind their exact inputs and take over the typed Planner
 * dispatch after both results succeed.
 */
export function b25EditorBootstrapContract(projectRoot, sessionId) {
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const statusCommand = `node ${shellArg(stageGateScriptPath(projectRoot))} status --session-dir ${shellArg(sessionDir)} --format text`;
  const sourceFieldsScript = join(
    packageResourceRoot,
    "skills",
    "html-report",
    "scripts",
    "prepare-research-evidence.mjs"
  );
  const sourceFieldsCommand = `node ${shellArg(sourceFieldsScript)} --result ${shellArg(join(sessionDir, "result.json"))} --source-fields`;
  const plannerTask = [
    EDITOR_PLANNER_MARKER,
    `SESSION=${sessionDir}`,
    `result.json=${join(sessionDir, "result.json")}`,
  ].join("\n");
  return {
    sessionDir,
    statusCommand,
    sourceFieldsCommand,
    plannerInput: {
      context: "fresh",
      chain: [{ agent: "report-researcher", task: plannerTask }],
    },
  };
}

export function gateContextBanner(projectRoot, sessionId, state, options = {}) {
  if (!state) return "";
  const stageId = state.currentStage;
  const definition = STAGE_DEFINITIONS[stageId];
  const sessionDir = htmlReportSessionDir(projectRoot, sessionId);
  const script = stageGateScriptPath(projectRoot);
  const statusCommand = `node ${shellArg(script)} status --session-dir ${shellArg(sessionDir)} --format text`;
  const finishCommand = `node ${shellArg(script)} finish --session-dir ${shellArg(sessionDir)} --stage ${stageId} --format text`;
  const failCommand = `node ${shellArg(script)} fail --session-dir ${shellArg(sessionDir)} --stage ${stageId} --reason '<失败原因>' --format text`;
  const writerCardIds = Array.isArray(options.writerCardIds)
    ? options.writerCardIds.filter((value) => typeof value === "string" && value)
    : [];
  if (state.status === "running" && HTML_REPORT_RUNNER_STAGES.has(stageId)) {
    if (!htmlReportStageReservation(projectRoot, sessionId, state)) {
      return `# html-report Gate 错误\n- 当前 ${stageId} 缺少有效 attempt reservation；停止工具调用并回复“重试当前阶段”。`;
    }
    return `NEXT_TOOL_ONLY：${HTML_REPORT_STAGE_TOOL}()`;
  }
  const lines = [
    "# html-report 单步调试 Gate（强制）",
    `- SESSION: \`${sessionDir}\``,
    `- Gate 模式: \`${state.mode}\``,
    `- 当前阶段: \`${stageId}\`（${definition?.label || stageId}）`,
    `- 当前状态: \`${state.status}\`${state.status === "awaiting_approval"
      ? "（流水线正在等待批准；下方 Gate 文本的“状态：completed”表示本阶段工作已完成，两者含义不同）"
      : ""}`,
    `- 状态查询（只读）: \`${statusCommand}\``,
  ];

  if (state.mode === "auto") {
    lines.push(
      "- 自动模式不等待人工批准；仍需按阶段记录 start/finish/fail，完成后继续下一阶段。",
      `- 当前阶段完成时，最后独立调用：\`${finishCommand}\``
    );
    return lines.join("\n");
  }

  if (state.status === "running") {
    if (stageId === "A_CONFIG" && options.fixedAConfig === true) {
      lines.push(
        "- 扩展已打开 qdm-metric-cli ui；本轮不写 recommendations.json，也不启动旧 HTML。",
        "- runtime agent list 由扩展通过真实 pi-subagents 事件桥自动执行和验收。",
        "- 模型不得自行调用 subagent list 或 stage-gate；自动检查成功后扩展会完成 A_CONFIG。",
        "- 用户点「保存」只写出 result.json；回复一次「继续」批准 A_CONFIG 后会自动执行 B0。",
        "- B0 通过后直接进入 B2 Writer；自动检查失败、超时或缺少 Agent 时才会停在 Gate。"
      );
    } else if (!["B0_PREFLIGHT", "B2_WRITER", "B2_MAIN", "B3_RESEARCH"].includes(stageId)) {
      lines.push(
        "- 只执行当前阶段；顺序必须是：start（扩展已完成）→ 工作 → layout → finish → stop。",
        `- 成功时最后一个且独立的工具调用必须是：\`${finishCommand}\``,
        `- 失败时最后一个且独立的工具调用必须是：\`${failCommand}\``,
        "- finish/fail 不得与其他命令拼接，也不得在同一模型消息中并发启动下一阶段。"
      );
    }
    const chainAgent = {
      B2_WRITER: "report-writer",
      B3_RESEARCH: "report-researcher",
      B4_REVIEW: "report-reviewer",
    }[stageId];
    if (chainAgent && stageId !== "B2_WRITER") {
      lines.push(
        `- 当前阶段的 contract 子代理必须复制此参数外形：\`subagent({"chain":[{"agent":"${chainAgent}","task":"<完整任务>"}]})\`。`,
        "- 不要在调用中写 `context` 字段；`qdm-harness` 会在 `tool_call` hook 中自动注入 `context: \"fresh\"`。`chain[0]` 只放 `agent` 和 `task`，多余字段会被 pi-subagents 的 `prepareArguments` 在扩展修正前拒绝。"
      );
    }
    if (stageId === "B0_PREFLIGHT") {
      lines.push(
        "- B0 会由扩展重新执行一次独立的 runtime agent list；不得复用 A_CONFIG 的审计结果。",
        "- 扩展直接通过真实 pi-subagents 事件桥验收 `report-writer`、`report-researcher`、`report-reviewer`、`report-designer`，再确定性执行 phase-a layout 和 finish/fail。",
        "- 模型不得调用 subagent list、Bash、layout 或 stage-gate；自动检查完成后只返回最新 Gate 文本。",
        "- 缺少任一 report-* Agent、事件桥异常或 phase-a layout 失败时，扩展会自动 fail，不得继续 B2。"
      );
    }
    if (stageId === "B2_WRITER") {
      if (writerCardIds.length) {
        const statusDispatch = `bash(${JSON.stringify({ command: statusCommand })})`;
        lines.push(
          `- IMMEDIATE B2 STATUS MESSAGE — NEXT_TOOL_ONLY：下一条 assistant 消息只原样调用 \`${statusDispatch}\`。`,
          "- 不得在同一消息并发或嵌入 subagent，不得复述、解释或规划后续。status 成功的 tool result 会给出下一条唯一 Writer 调用。"
        );
      }
    }
    if (stageId === "B2_MAIN") {
      lines.push(
        "- 扩展正在调用 compose-main 合并初版 analysis/main.md；不要派发子代理，不要手写 MAIN，不要调用 stage-gate。",
        "- 合并完成后扩展会 finish B2_MAIN 并停在人工 Gate。"
      );
    }
    if (stageId === "B3_RESEARCH") {
      const finalizer = join(
        resolve(projectRoot),
        ".agents",
        "pi",
        "skills",
        "html-report",
        "scripts",
        "finalize-research-stage.mjs"
      );
      lines.push(
        `- B2.5 已预生成 reuse_entry evidence。直接使用 Planner tool result 的 researchTasks[] 派发 Researcher，不要再次 prepare/read tasks。全部 task 返回 ok 后，只运行一次：\`node ${shellArg(finalizer)} --result ${shellArg(join(sessionDir, "result.json"))}\`。`,
        "- Researcher task 必须逐字包含 `evidencePath=<ABS>`；`evidencePath` 是机器键名，不得翻译成“证据路径”、添加括注或改写分隔符。",
        "- finalizer 会统一更新 tasks/main、assemble 并做 explore layout；成功后 qdm-harness 自动 finish B3_RESEARCH 并进入既有人工 Gate。",
        "- finalizer 必须是本阶段最后且独立的模型工具调用；不要重读 summary、逐文件 edit、重复运行命令或手工调用 stage-gate finish。"
      );
    }
    if (stageId === "B25_EDITOR") {
      const bootstrap = b25EditorBootstrapContract(projectRoot, sessionId);
      const plannerDispatch = `subagent(${JSON.stringify(bootstrap.plannerInput)})`;
      lines.push(
        "- B2.5 是 B3 Gate 的内部计时段：finish 后无需用户回复，继续已自动启动的 B3_RESEARCH。 ",
        `- IMMEDIATE B25 TOOL MESSAGE：下一条 assistant 消息现在必须只包含两个 sibling Bash，并按以下固定排列列出：1) \`${bootstrap.statusCommand}\`；2) \`${bootstrap.sourceFieldsCommand}\`。列表顺序只确定消息形状，不要求等待前一个结果；不要再判断“顺序还是并行”。`,
        "- 立即发出上述两个工具调用；不要在调用前复述 Gate/Skill、比较执行方案、解释计划或继续推理。`$SESSION/analysis` 已由 Gate 创建，不要检查目录。",
        `- 自动接棒契约：两个 Bash 都成功后，qdm-harness 直接通过真实 pi-subagents 事件桥派发一次 \`${plannerDispatch}\`；父模型不得再生成或重复调用 Planner。`,
        "- 父扩展会把权威 userQuestion、卡片查询范围、已验收 Writer structured returns 与 source inventory 注入 fresh Planner，并强制短系统提示词和 typed outputSchema。",
        "- Planner 只允许一次 structured_output；返回后扩展自动校验、生成 tasks.json/main.md、prepare reuse evidence、assemble、b2 layout 和 finish B25。失败即自动 fail，本 attempt 禁止重派。",
        "- B2.5 的 ls/find/grep/mkdir 与针对 Writer entry/meta、.pi-subagents 的 read/Bash 已由运行时禁止。",
        "- Planner 成功且任务非空时，qdm-harness 会在同一 bootstrap 内立即通过事件桥派发并验收首个 Researcher；父模型不得再生成、重复或改写该调用，只处理 successor、剩余 task 或固定 finalizer。空任务仍给出唯一固定 B3 finalizer；不要手工调用 B25 finalizer 或 stage-gate finish。"
      );
    }
  } else if (state.status === "awaiting_approval") {
    if (stageId === "A_CONFIG" && options.fixedAConfig === true) {
      const message = formatGateMessage(state)
        .split("\n")
        .filter((line) => !line.startsWith("当前必须立即停止工具调用"))
        .join("\n");
      lines.push(
        `\n${message}`,
        "- runtime agent list 已由扩展通过真实 pi-subagents 事件桥自动验收，并写入当前 attempt 的审计文件。",
        "- 立即原样返回上面的 Gate 文本并停止；不要调用 subagent、status 或其他工具。",
        "- 用户需先在 qdm-metric-cli ui 点「保存」写出 result.json，再回复一次「继续」。",
        "- A_CONFIG 只有在四个 report-* Agent 全部存在时才会到达此状态；随后 B0 通过会自动进入 B2。"
      );
    } else if (stageId === "B0_PREFLIGHT") {
      const message = formatGateMessage(state)
        .split("\n")
        .filter((line) => !line.startsWith("当前必须立即停止工具调用"))
        .join("\n");
      lines.push(
        `\n${message}`,
        "- 当前 Session 的显式兼容策略把 B0 配置成了人工 Gate；默认策略下 B0 成功会自动进入 B2。",
        "- CURRENT INPUT IS CONSUMED：本轮开始前，扩展已把当前用户的“继续”只用于进入并完成这个兼容 B0 Gate；同一输入不能再次批准 B0。",
        "- 下一条 assistant 响应必须只原样返回上面的 B0 Gate 文本，不得回顾上一阶段、比较旧状态、调用工具或继续推理。返回后立即停止。",
        "- 用户随后新发一条“继续”后才会批准该兼容 Gate 并启动 B2 Writer。"
      );
    } else if (stageId === "B2_MAIN") {
      const message = formatGateMessage(state)
        .split("\n")
        .filter((line) => !line.startsWith("当前必须立即停止工具调用"))
        .join("\n");
      lines.push(
        `\n${message}`,
        "- 初版 `$SESSION/analysis/main.md` 已由 compose-main 按卡片顺序合并。",
        "- HTML 是 B2_MAIN 的可选动作，不是新 stage；禁止手写 HTML，禁止直接调用 md2html 或 Bash。",
        "- 立即原样返回上面的 Gate 文本并停止；不要改 MAIN、不要派 Planner/Researcher。",
        "- 用户回复“生成 HTML”成功后结束 B2_MAIN；回复“继续”或“暂不生成 HTML”跳过 HTML 并结束。",
        "- “重试 HTML 生成”只重试导出，绝不重跑 Writer 或 compose-main。HTML 失败时 Gate 保持可批准。"
      );
    } else {
      lines.push(
        `\n${formatGateMessage(state)}`,
        "- 立即停止并返回 Gate 文本；不得主动检查目录或文件。read/grep/find/ls/status 仅供用户明确要求只读诊断时使用。"
      );
    }
  } else if (state.status === "failed") {
    lines.push(`\n${formatGateMessage(state)}`, "- 普通“继续”不能越过失败阶段。 ");
  } else if (state.status === "paused") {
    lines.push(`\n${formatGateMessage(state)}`, "- 未恢复前不得推进流水线。 ");
  } else if (state.status === "completed") {
    lines.push(`\n${formatGateMessage(state)}`);
  }
  return lines.join("\n");
}
