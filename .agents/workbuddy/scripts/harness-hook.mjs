#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_TIMEOUT_MS = 8_500;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SHELL_TOOL_NAMES = new Set(["Bash", "PowerShell", "execute_command"]);
const AUTHZ_SHELL_TOOL_NAMES = new Set(["Bash", "execute_command"]);
export const WORKBUDDY_AUTH_MINIMUM_VERSION = "5.3.11";
export const CODEBUDDY_AUTH_MINIMUM_VERSION = "2.115.0";

function expectedEvent(mode) {
  if (mode === "authz") return "PreToolUse";
  return mode === "posttool" ? "PostToolUse" : "UserPromptSubmit";
}

export function safeOutput(mode, message) {
  if (mode === "authz") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: message,
      },
    };
  }
  return {
    continue: true,
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: expectedEvent(mode),
      additionalContext: message,
    },
  };
}

export function normalizePayload(mode, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const sessionID = typeof payload.session_id === "string" ? payload.session_id.trim() : "";

  if (mode === "context") {
    const rawPrompt = typeof payload.prompt === "string"
      ? payload.prompt
      : (typeof payload.user_prompt === "string" ? payload.user_prompt : "");
    if (!rawPrompt.trim()) return null;
    return { session_id: sessionID, prompt: rawPrompt };
  }

  if (mode === "posttool") {
    const rawToolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
    if (!SHELL_TOOL_NAMES.has(rawToolName)) return null;
    const toolInput = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : {};
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!command.trim()) return null;
    return {
      session_id: sessionID,
      tool_name: "Bash",
      tool_input: { command },
    };
  }

  if (mode === "authz") {
    if (payload.hook_event_name !== "PreToolUse") return null;
    const rawToolName = typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";
    if (!AUTHZ_SHELL_TOOL_NAMES.has(rawToolName)) return null;
    const toolInput = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? payload.tool_input
      : null;
    if (!toolInput || typeof toolInput.command !== "string" || !toolInput.command.trim()) return null;
    return {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { ...toolInput },
    };
  }

  return null;
}

function isDirectory(pathname) {
  try {
    return statSync(pathname).isDirectory();
  } catch {
    return false;
  }
}

function isHarnessRoot(pathname) {
  if (!isDirectory(pathname)) return false;
  const markers = [
    join(pathname, "config", "harness-config.yaml"),
    join(pathname, "config", "harness-paths.yaml"),
    join(pathname, "bootstrap", "cli-manifest.json"),
    join(pathname, "cli", "cmd", "data-harness-cli", "main.go"),
  ];
  return markers.some((marker) => existsSync(marker));
}

export function findHarnessRoot(start) {
  if (!start || typeof start !== "string") return "";
  let current = resolve(start);
  if (!isDirectory(current)) current = dirname(current);
  for (;;) {
    if (isHarnessRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return "";
    current = parent;
  }
}

export function resolveWorkspace(payload, env = process.env) {
  const declared = [
    env.CODEBUDDY_PROJECT_DIR,
    env.CLAUDE_PROJECT_DIR,
    payload && typeof payload.cwd === "string" ? payload.cwd : "",
  ].filter((candidate) => typeof candidate === "string" && candidate.trim());
  const candidates = declared.length > 0 ? declared : [process.cwd()];
  for (const candidate of candidates) {
    const root = findHarnessRoot(candidate);
    if (root) return root;
  }
  return "";
}

export function resolveHarnessCLI(root, env = process.env) {
  const explicit = typeof env.QDM_HARNESS_CLI === "string" ? env.QDM_HARNESS_CLI.trim() : "";
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(root || process.cwd(), explicit);

  const binary = process.platform === "win32" ? "data-harness-cli.exe" : "data-harness-cli";
  const candidates = [
    root ? join(root, "bin", binary) : "",
    join(PLUGIN_ROOT, "..", "..", "bin", binary),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

function readJSON(pathname) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

function versionAtLeast(actual, minimum) {
  const parseVersion = (value) => String(value || "").trim().replace(/^v(?=\d)/i, "")
    .split(".").map((part) => Number.parseInt(part, 10) || 0);
  const current = parseVersion(actual);
  const required = parseVersion(minimum);
  for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
    if ((current[index] || 0) > (required[index] || 0)) return true;
    if ((current[index] || 0) < (required[index] || 0)) return false;
  }
  return true;
}

function normalizeWorkBuddyAppRoot(value) {
  const candidate = resolve(value);
  const resources = dirname(candidate);
  const contents = dirname(resources);
  if (parse(candidate).base.toLowerCase() === "app.asar" &&
      parse(resources).base.toLowerCase() === "resources" &&
      parse(contents).base.toLowerCase() === "contents") {
    return dirname(contents);
  }
  return candidate;
}

export function detectAuthRuntime(env = process.env, platform = process.platform) {
  if (platform !== "darwin") return { supported: false, workBuddyVersion: "", codeBuddyVersion: "" };
  const appRoot = typeof env.WORKBUDDY_APP_PATH === "string" && env.WORKBUDDY_APP_PATH.trim()
    ? normalizeWorkBuddyAppRoot(env.WORKBUDDY_APP_PATH)
    : "/Applications/WorkBuddy.app";
  const cliRoot = join(appRoot, "Contents", "Resources", "app.asar.unpacked", "cli");
  const product = readJSON(join(cliRoot, "product.json"));
  const packageJSON = readJSON(join(cliRoot, "package.json"));
  const workBuddyVersion = String(env.WORKBUDDY_VERSION || product?.genieVersion || "").trim();
  const codeBuddyVersion = String(
    env.CODEBUDDY_CLI_VERSION || packageJSON?.publishConfig?.customPackage?.version || "",
  ).trim();
  return {
    supported: Boolean(workBuddyVersion && codeBuddyVersion &&
      versionAtLeast(workBuddyVersion, WORKBUDDY_AUTH_MINIMUM_VERSION) &&
      versionAtLeast(codeBuddyVersion, CODEBUDDY_AUTH_MINIMUM_VERSION)),
    workBuddyVersion,
    codeBuddyVersion,
  };
}

function hookTimeout(env = process.env) {
  const parsed = Number.parseInt(env.QDM_HARNESS_HOOK_TIMEOUT_MS || "", 10);
  if (!Number.isFinite(parsed) || parsed < 10) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, DEFAULT_TIMEOUT_MS);
}

export function validateHookOutput(mode, stdout, canonicalPayload = null) {
  const text = String(stdout || "").trim();
  if (!text) return mode === "authz" ? null : {};
  let output;
  try {
    output = JSON.parse(text);
  } catch {
    return null;
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  if (Object.keys(output).length === 0) return {};
  if (mode === "authz") {
    const hook = output.hookSpecificOutput;
    if (!hook || typeof hook !== "object" || hook.hookEventName !== "PreToolUse") return null;
    if (hook.permissionDecision !== "allow" && hook.permissionDecision !== "deny") return null;
    if (hook.permissionDecisionReason !== undefined && typeof hook.permissionDecisionReason !== "string") return null;
    if (hook.permissionDecision === "deny") {
      return typeof hook.permissionDecisionReason === "string" && hook.permissionDecisionReason.trim() ? output : null;
    }
    const updatedInput = hook.updatedInput;
    if (!updatedInput || typeof updatedInput !== "object" || Array.isArray(updatedInput) ||
      typeof updatedInput.command !== "string" || !updatedInput.command.trim()) return null;
    const originalInput = canonicalPayload?.tool_input || {};
    for (const [key, value] of Object.entries(originalInput)) {
      if (key === "command") continue;
      if (!(key in updatedInput) || JSON.stringify(updatedInput[key]) !== JSON.stringify(value)) return null;
    }
    return output;
  }
  if (typeof output.continue !== "boolean") return null;
  if (output.systemMessage !== undefined && typeof output.systemMessage !== "string") return null;
  const hook = output.hookSpecificOutput;
  if (!hook || typeof hook !== "object") return null;
  if (hook.hookEventName !== expectedEvent(mode) || typeof hook.additionalContext !== "string") return null;
  return output;
}

export function runCanonicalHook(mode, canonicalPayload, root, env = process.env) {
  const cli = resolveHarnessCLI(root, env);
  if (!cli || !existsSync(cli)) {
    return safeOutput(
      mode,
      "QDM_HARNESS_UNAVAILABLE: data-harness-cli is missing or not executable for this WorkBuddy project. " +
        "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates until Harness is repaired.",
    );
  }

  const command = mode === "authz" ? "authz-hook" : (mode === "posttool" ? "posttool" : "context");
  const args = mode === "authz" ? [command, "--agent", "workbuddy"] : [command, "--format", "workbuddy-hook"];
  const result = spawnSync(cli, args, {
    cwd: root,
    env: { ...env, CODEBUDDY_PROJECT_DIR: root },
    input: `${JSON.stringify(canonicalPayload)}\n`,
    encoding: "utf8",
    timeout: hookTimeout(env),
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT" ? "timed out" : "failed";
    process.stderr.write(`[qdm-harness] data-harness-cli ${command} ${reason}\n`);
    return safeOutput(
      mode,
      `QDM_HARNESS_UNAVAILABLE: WorkBuddy Harness ${command} ${reason}. ` +
        "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
    );
  }

  const output = validateHookOutput(mode, result.stdout, canonicalPayload);
  if (output) return output;
  process.stderr.write(`[qdm-harness] data-harness-cli ${command} returned invalid JSON\n`);
  return safeOutput(
    mode,
    `QDM_HARNESS_UNAVAILABLE: WorkBuddy Harness ${command} returned an invalid response. ` +
      "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
  );
}

const HTML_REPORT_SKILL_PATTERN = /(<skill\s+name=["']html-report["']|\/skill:\s*html-report\b|\bskill:\s*html-report\b)/i;
const HTML_REPORT_TEXT_PATTERNS = [/html[- ]?report/i, /html\s*报告/i];
const REPORT_TRIGGERS = ["生成", "做", "制作", "输出", "写", "创建", "出一份", "来一份", "周例会", "经营分析", "盈利情况", "销售情况", "分析报告"];
const CONTINUATION_TRIGGERS = ["继续", "确认", "已保存", "保存好了", "保存完", "下一步", "往下", "推进", "开始生成", "开始取数", "advance"];

export function shouldBypassHtmlReportContext(root, canonicalPayload) {
  const sessionID = typeof canonicalPayload?.session_id === "string" ? canonicalPayload.session_id.trim() : "";
  const prompt = typeof canonicalPayload?.prompt === "string" ? canonicalPayload.prompt : "";
  if (!root || !sessionID || !prompt.trim()) return false;
  if (isHtmlReportPrompt(prompt)) {
    rememberHtmlReportSession(root, sessionID);
    return true;
  }
  if (!htmlReportSessionMarked(root, sessionID)) return false;
  if (isHtmlReportContinuation(prompt)) return true;
  forgetHtmlReportSession(root, sessionID);
  return false;
}

function isHtmlReportPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (HTML_REPORT_SKILL_PATTERN.test(text) || HTML_REPORT_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (!text.includes("报告")) return false;
  return REPORT_TRIGGERS.some((trigger) => text.includes(trigger));
}

function isHtmlReportContinuation(prompt) {
  const text = String(prompt || "").trim().replace(/^[，。,.!！?？；;：:"'“”‘’\s]+|[，。,.!！?？；;：:"'“”‘’\s]+$/g, "").toLowerCase();
  return Boolean(text) && CONTINUATION_TRIGGERS.some((trigger) => text.includes(trigger));
}

function rememberHtmlReportSession(root, sessionID) {
  const marker = htmlReportSessionMarkerPath(root, sessionID);
  if (!marker) return;
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, "{}\n", { mode: 0o644 });
  } catch {
    // A marker failure must not block WorkBuddy; the first html-report turn is still bypassed.
  }
}

function forgetHtmlReportSession(root, sessionID) {
  const marker = htmlReportSessionMarkerPath(root, sessionID);
  if (!marker) return;
  try {
    rmSync(marker, { force: true });
  } catch {
    // Ignore stale marker cleanup failures.
  }
}

function htmlReportSessionMarked(root, sessionID) {
  const marker = htmlReportSessionMarkerPath(root, sessionID);
  if (!marker) return false;
  return existsSync(marker);
}

function htmlReportRunnerEntry(root) {
  const candidates = [
    join(root, "agents", "workbuddy", "scripts", "html-report-workbuddy.mjs"),
    join(root, ".agents", "workbuddy", "scripts", "html-report-workbuddy.mjs"),
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) return "";
  try { return realpathSync(candidate); } catch { return candidate; }
}

export function autoStartHtmlReport(root, sessionID, prompt, env = process.env) {
  if (env.QDM_HARNESS_HTML_REPORT_AUTOSTART === "0") return { ok: true, skipped: true };
  const entry = htmlReportRunnerEntry(root);
  if (!entry) return { ok: false, error: "html-report WorkBuddy Stage Runner is missing" };
  const result = spawnSync(process.execPath, [
    entry,
    "start",
    "--session",
    sessionID,
    "--root",
    root,
    "--phase-a",
    "ui",
    "--question",
    prompt,
  ], {
    cwd: root,
    env: { ...env, CODEBUDDY_PROJECT_DIR: root },
    encoding: "utf8",
    timeout: hookTimeout(env),
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === "ETIMEDOUT"
      ? "timed out"
      : (result.stderr || result.error?.message || "failed").trim();
    return { ok: false, error: `html-report 自动启动失败：${reason}` };
  }
  return { ok: true, message: (result.stdout || "html-report session 已启动").trim() };
}

function htmlReportSessionMarkerPath(root, sessionID) {
  if (!root || !sessionID) return "";
  const digest = createHash("sha256").update(sessionID).digest("hex");
  return join(root, ".harness", "state", "workbuddy-html-report", `${digest}.json`);
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function emit(output) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output?.hookSpecificOutput?.hookEventName === "PreToolUse" &&
      output.hookSpecificOutput.permissionDecision === "deny") {
    process.exitCode = 2;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const mode = argv[0];
  if (mode !== "context" && mode !== "posttool" && mode !== "authz") {
    emit({});
    return;
  }

  let payload;
  try {
    const raw = await readStdin();
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    const root = resolveWorkspace({}, env);
    emit(mode === "authz" && root
      ? safeOutput(mode, "QDM_HARNESS_AUTHZ_DENIED: WorkBuddy provided invalid PreToolUse JSON; the command was blocked.")
      : {});
    return;
  }

  const root = resolveWorkspace(payload, env);
  if (!root) {
    // The plugin may be enabled globally; outside a Harness workspace it must
    // not change ordinary WorkBuddy behavior.
    emit({});
    return;
  }
  const canonical = normalizePayload(mode, payload);
  if (!canonical) {
    emit(mode === "authz"
      ? safeOutput(mode, "QDM_HARNESS_AUTHZ_DENIED: WorkBuddy provided an invalid PreToolUse payload; the command was blocked.")
      : {});
    return;
  }
  const htmlReportWasMarked = mode === "context" && htmlReportSessionMarked(root, canonical.session_id);
  if (mode === "context" && shouldBypassHtmlReportContext(root, canonical)) {
    const firstTurn = isHtmlReportPrompt(canonical.prompt) && !htmlReportWasMarked;
    if (firstTurn) {
      const started = autoStartHtmlReport(root, canonical.session_id, canonical.prompt, env);
      if (!started.ok) {
        forgetHtmlReportSession(root, canonical.session_id);
        emit(safeOutput("context", `${started.error}\n请修复 WorkBuddy html-report runtime 后重试；本轮未执行取数。`));
        return;
      }
      emit(safeOutput("context", `${started.message}\n请在 qdm-metric-cli UI 中配置卡片并点击“保存”；完成后回复“继续”。`));
      return;
    }
    emit(safeOutput("context", "html-report 会话已就绪。请执行当前 WorkBuddy html-report Stage Runner 的 advance，完成后返回阶段摘要；不要读取或猜测模板。"));
    return;
  }
  const output = runCanonicalHook(mode, canonical, root, env);
  if (mode === "authz" && Object.keys(output).length > 0 && !detectAuthRuntime(env).supported) {
    emit(safeOutput(
      mode,
      `QDM_HARNESS_AUTHZ_DENIED: WorkBuddy ${WORKBUDDY_AUTH_MINIMUM_VERSION}+ with CodeBuddy CLI ${CODEBUDDY_AUTH_MINIMUM_VERSION}+ is required for auth command rewriting.`,
    ));
    return;
  }
  emit(output);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch(() => emit(safeOutput(
    process.argv[2] === "authz" ? "authz" : (process.argv[2] === "posttool" ? "posttool" : "context"),
    "QDM_HARNESS_UNAVAILABLE: The WorkBuddy Harness adapter failed unexpectedly. " +
      "Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
  )));
}
