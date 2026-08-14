#!/usr/bin/env node
/**
 * Deterministic, fail-closed driver for the step-gated html-report Skill.
 *
 * The driver never calls stage-gate approve directly. It advances a single,
 * long-lived Pi RPC Session only by sending the same user input used during
 * manual testing: the fixed Skill prompt followed by exact `继续` messages.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PiRpcClient } from "./pi-rpc-client.mjs";
import { headlessConfirm } from "./headless-confirm.mjs";
import { browserConfirm } from "./browser-confirm.mjs";
import { checkSessionLayout } from "./check-session-layout.mjs";
import {
  DEFAULT_PERFORMANCE_CONFIG_PATH,
  analyzeHtmlReportRunWithTranscripts,
  writeHtmlReportRunReport,
} from "./analyze-html-report-run.mjs";
import {
  HTML_REPORT_GATE_CUSTOM_TYPE,
  HTML_REPORT_RUNTIME_SOURCE_FILES,
} from "../../../extensions/qdm-harness/index.ts";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const projectRootFromScript = resolve(new URL("../../../../../", import.meta.url).pathname);

export const ORIGINAL_PROMPT =
  "/skill: html-report 生成客数(客流)和客单的平衡在哪个点最好? 用门店毛利额做评估, 以门店:101001为分析样本";
export const EFFECTIVE_PROMPT =
  "/skill:html-report 生成客数(客流)和客单的平衡在哪个点最好? 用门店毛利额做评估, 以门店:101001为分析样本";
export const FIXED_BUSINESS_QUESTION =
  "生成客数(客流)和客单的平衡在哪个点最好? 用门店毛利额做评估, 以门店:101001为分析样本";
export const EXTERNAL_STAGE_ORDER = Object.freeze([
  "A_CONFIG",
  "B0_PREFLIGHT",
  "B2_WRITER",
  "B3_RESEARCH",
  "B4_REVIEW",
  "B5_DESIGN",
]);
export const INTERNAL_STAGE_ORDER = Object.freeze([
  "A_CONFIG",
  "A_CONFIRM",
  "B0_PREFLIGHT",
  "B2_WRITER",
  "B25_EDITOR",
  "B3_RESEARCH",
  "B4_REVIEW",
  "B5_DESIGN",
]);
export const DEFAULT_CONFIG_PATH = DEFAULT_PERFORMANCE_CONFIG_PATH;

const LAYOUT_PHASES = Object.freeze({
  A_CONFIG: ["a"],
  B0_PREFLIGHT: ["a"],
  B2_WRITER: ["writer"],
  B3_RESEARCH: ["b2", "explore"],
  B4_REVIEW: ["quality"],
  B5_DESIGN: ["html"],
});

const REQUIRED_PREVIOUS_STAGES = Object.freeze({
  A_CONFIG: [],
  B0_PREFLIGHT: ["A_CONFIG"],
  B2_WRITER: ["A_CONFIG", "B0_PREFLIGHT"],
  B3_RESEARCH: ["A_CONFIG", "B0_PREFLIGHT", "B2_WRITER", "B25_EDITOR"],
  B4_REVIEW: ["A_CONFIG", "B0_PREFLIGHT", "B2_WRITER", "B25_EDITOR", "B3_RESEARCH"],
  B5_DESIGN: [
    "A_CONFIG",
    "B0_PREFLIGHT",
    "B2_WRITER",
    "B25_EDITOR",
    "B3_RESEARCH",
    "B4_REVIEW",
  ],
});

const EXACT_SECRET_KEY = /^(?:api[-_]?key|authorization|cookie|set-cookie|secret|access[-_]?token|refresh[-_]?token)$/i;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
export const REQUIRED_RUNTIME_REPORT_AGENTS = Object.freeze([
  "report-writer",
  "report-researcher",
  "report-reviewer",
  "report-designer",
]);
export const RUNTIME_AGENT_LIST_AUDIT_DIR = Object.freeze(["debug", "runtime-agent-list"]);
export const RUNTIME_AGENT_LIST_AUDIT_PRODUCER = "qdm-harness";
export const RUNTIME_AGENT_LIST_AUDIT_MECHANISM = "extension-event-bridge";

const RUNTIME_AGENT_LIST_AUDIT_KEYS = Object.freeze([
  "version",
  "producer",
  "mechanism",
  "sessionId",
  "stageId",
  "attempt",
  "requestId",
  "status",
  "required",
  "observed",
  "missing",
  "startedAt",
  "result",
  "auditSha256",
]);
const RUNTIME_AGENT_LIST_AUDIT_OPTIONAL_KEYS = Object.freeze(["endedAt", "durationMs", "error"]);
const RUNTIME_AGENT_LIST_RESULT_KEYS = Object.freeze(["isError", "text", "sha256"]);
const SHA256_HEX = /^[a-f0-9]{64}$/;

function nowIso(now = Date.now) {
  return new Date(Number(now())).toISOString();
}

function elapsedMs(startedAt, endedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(endedAt || "");
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function exactObjectKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    actual.every((key) => allowed.has(key));
}

function validIsoTimestamp(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function uniqueStringArray(value) {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim() === item && item.length > 0) &&
    new Set(value).size === value.length;
}

export function runtimeAgentListAttemptToken(stageId, attempt) {
  const number = Number(attempt?.number);
  const startedAt = String(attempt?.startedAt || "");
  if (!new Set(["A_CONFIG", "B0_PREFLIGHT"]).has(stageId) ||
      !Number.isSafeInteger(number) || number <= 0 || !validIsoTimestamp(startedAt)) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "RUNTIME_AGENT_LIST_ATTEMPT_BINDING_MISSING",
      stageId,
      reason: `${stageId} runtime agent list 缺少合法 Gate attempt number/startedAt，无法绑定证据`,
      evidence: "pipeline-state.json",
    });
  }
  return `${stageId}:${number}:${startedAt}`;
}

export function runtimeAgentListAuditFileName(stageId, attempt) {
  const token = runtimeAgentListAttemptToken(stageId, attempt);
  return `${stageId}-${sha256Text(token).slice(0, 16)}.json`;
}

export function runtimeAgentListAuditSha256(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return "";
  const unsigned = { ...document };
  delete unsigned.auditSha256;
  return sha256Text(canonicalJson(unsigned));
}

function errorText(error) {
  return String(error?.message || error || "unknown error");
}

function exists(path) {
  return access(path).then(() => true, () => false);
}

export async function waitForAccessibleFile(path, {
  timeoutMs = 5_000,
  intervalMs = 25,
  accessImpl = access,
  now = Date.now,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
} = {}) {
  const timeout = Number(timeoutMs);
  const interval = Number(intervalMs);
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval <= 0) {
    throw new Error("waitForAccessibleFile requires positive timeoutMs and intervalMs");
  }
  const deadline = Number(now()) + timeout;
  let lastError;
  while (true) {
    try {
      await accessImpl(path);
      return { path, status: "accessible" };
    } catch (cause) {
      lastError = cause;
    }
    const remaining = deadline - Number(now());
    if (remaining <= 0) throw lastError;
    await sleep(Math.min(interval, remaining));
  }
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function regexpEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectResultText(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResultText(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const child of Object.values(value)) collectResultText(child, output);
  return output;
}

function listedAgentNames(value) {
  const names = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (["name", "agent"].includes(key) && typeof child === "string") names.add(child.trim());
      else visit(child);
    }
  };
  visit(value);
  for (const text of collectResultText(value)) {
    for (const match of text.matchAll(/(?:^|\n)\s*-\s+([A-Za-z0-9._-]+)(?=\s|\(|:|$)/g)) {
      names.add(match[1]);
    }
  }
  return [...names].filter(Boolean).sort();
}

function redact(value, key = "") {
  if (EXACT_SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  if (typeof value === "string") return value.replace(BEARER_SECRET, "Bearer [REDACTED]");
  return value;
}

function normalizeSnapshot(snapshot) {
  if (typeof snapshot === "string") return { sha256: snapshot, dirtyPaths: [] };
  return {
    sha256: String(snapshot?.sha256 || snapshot?.fingerprint || ""),
    dirtyPaths: Array.isArray(snapshot?.dirtyPaths) ? [...snapshot.dirtyPaths] : [],
  };
}

function parseJsonDocument(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "INVALID_JSON",
      reason: `${label} 不是合法 JSON：${cause.message}`,
    });
  }
}

export class SelfTestFailure extends Error {
  constructor({
    classification = "PRODUCT_CONTRACT",
    code = "SELF_TEST_FAILED",
    reason,
    stageId = null,
    evidence = null,
    cause,
  } = {}) {
    super(String(reason || code), cause ? { cause } : undefined);
    this.name = "SelfTestFailure";
    this.classification = classification;
    this.code = code;
    this.stageId = stageId;
    this.evidence = evidence;
  }
}

function b0GateMessageCandidate(event) {
  return event?.type === "message_end" &&
    event?.message?.role === "custom" &&
    event.message.customType === HTML_REPORT_GATE_CUSTOM_TYPE;
}

export function isB0GateCompletionEvent(event, { sessionId } = {}) {
  if (!b0GateMessageCandidate(event)) return false;
  const details = event.message.details;
  const requiredKeys = [
    "version",
    "producer",
    "sessionId",
    "stageId",
    "currentStage",
    "pipelineStatus",
    "stageStatus",
    "attempt",
  ];
  if (!exactObjectKeys(details, requiredKeys)) return false;
  if (
    details.version !== 1 ||
    details.producer !== "qdm-harness" ||
    details.sessionId !== sessionId ||
    details.stageId !== "B0_PREFLIGHT" ||
    details.currentStage !== "B0_PREFLIGHT"
  ) return false;
  const success = details.pipelineStatus === "awaiting_approval" &&
    details.stageStatus === "awaiting_approval";
  const failure = details.pipelineStatus === "failed" && details.stageStatus === "failed";
  if (!success && !failure) return false;
  return exactObjectKeys(details.attempt, ["number", "startedAt"]) &&
    Number.isSafeInteger(details.attempt.number) &&
    details.attempt.number > 0 &&
    validIsoTimestamp(details.attempt.startedAt);
}

export function inspectB0CompletionEvents(events, { sessionId } = {}) {
  const records = Array.isArray(events) ? events : [];
  if (records.some((event) => event?.type === "agent_start")) {
    throw new SelfTestFailure({
      code: "B0_MODEL_TURN_FORBIDDEN",
      stageId: "B0_PREFLIGHT",
      reason: "B0 确定性 Gate 回显期间出现 agent_start；该阶段不应启动父模型",
    });
  }
  const candidates = records.filter(b0GateMessageCandidate);
  if (candidates.length === 0) {
    throw new SelfTestFailure({
      code: "B0_HANDLED_GATE_MISSING",
      stageId: "B0_PREFLIGHT",
      reason: "B0 未收到 qdm-harness 的确定性 html-report-gate message_end",
    });
  }
  if (candidates.length !== 1) {
    throw new SelfTestFailure({
      code: "B0_HANDLED_GATE_AMBIGUOUS",
      stageId: "B0_PREFLIGHT",
      reason: `B0 确定性 Gate message_end 必须恰好一条，实际 ${candidates.length} 条`,
    });
  }
  if (!isB0GateCompletionEvent(candidates[0], { sessionId })) {
    throw new SelfTestFailure({
      code: "B0_HANDLED_GATE_INVALID",
      stageId: "B0_PREFLIGHT",
      reason: "B0 确定性 Gate 的 producer/session/stage/status/attempt 绑定无效",
    });
  }
  return { completionSignal: "custom_gate", event: candidates[0] };
}

export async function discoverPiSubagentExtensions({
  env = process.env,
  homeDir = homedir(),
  packageRoot: requestedPackageRoot,
  readFileImpl = readFile,
  lstatImpl = lstat,
} = {}) {
  const agentDir = resolve(String(env.PI_CODING_AGENT_DIR || join(homeDir, ".pi", "agent")));
  const packageRoot = resolve(requestedPackageRoot || join(agentDir, "npm", "node_modules", "pi-subagents"));
  const manifestPath = join(packageRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFileImpl(manifestPath, "utf8"));
  } catch (cause) {
    const missing = cause?.code === "ENOENT";
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: missing ? "PI_SUBAGENTS_PACKAGE_MISSING" : "PI_SUBAGENTS_MANIFEST_INVALID",
      stageId: "A_CONFIG",
      reason: missing
        ? `未找到已安装的 pi-subagents：${manifestPath}`
        : `无法读取 pi-subagents package.json：${errorText(cause)}`,
      cause,
    });
  }
  const declared = manifest?.pi?.extensions;
  if (manifest?.name !== "pi-subagents" || !Array.isArray(declared) || declared.length < 1) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "PI_SUBAGENTS_MANIFEST_INVALID",
      stageId: "A_CONFIG",
      reason: `${manifestPath} 必须声明非空 pi.extensions`,
    });
  }
  const extensions = [];
  for (const entry of declared) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new SelfTestFailure({
        classification: "TEST_HARNESS",
        code: "PI_SUBAGENTS_MANIFEST_INVALID",
        stageId: "A_CONFIG",
        reason: `${manifestPath} 包含非法 pi.extensions 条目`,
      });
    }
    const extensionPath = resolve(packageRoot, entry);
    const inside = relative(packageRoot, extensionPath);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      throw new SelfTestFailure({
        classification: "TEST_HARNESS",
        code: "PI_SUBAGENTS_EXTENSION_OUTSIDE_PACKAGE",
        stageId: "A_CONFIG",
        reason: `拒绝加载包目录之外的 pi-subagents 扩展：${extensionPath}`,
      });
    }
    try {
      const info = await lstatImpl(extensionPath);
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error("extension entry is not a file");
    } catch (cause) {
      throw new SelfTestFailure({
        classification: "TEST_HARNESS",
        code: "PI_SUBAGENTS_EXTENSION_MISSING",
        stageId: "A_CONFIG",
        reason: `pi-subagents 扩展入口不可用：${extensionPath}（${errorText(cause)}）`,
        cause,
      });
    }
    if (!extensions.includes(extensionPath)) extensions.push(extensionPath);
  }
  return {
    packageRoot,
    manifestPath,
    packageVersion: String(manifest.version || ""),
    extensions,
  };
}

export function withExplicitExtensions(args = [], extensionPaths = [], cwd = process.cwd()) {
  const result = [...args];
  const existing = new Set();
  for (let index = 0; index < result.length; index += 1) {
    const arg = result[index];
    if (arg === "--extension" || arg === "-e") {
      const value = result[index + 1];
      if (value) existing.add(resolve(cwd, value));
      index += 1;
      continue;
    }
    const match = String(arg).match(/^--extension=(.+)$/);
    if (match) existing.add(resolve(cwd, match[1]));
  }
  for (const path of extensionPaths) {
    const absolute = resolve(path);
    if (existing.has(absolute)) continue;
    result.push("--extension", absolute);
    existing.add(absolute);
  }
  return result;
}

export function normalizeSkillPrompt(prompt) {
  const source = String(prompt || "");
  return source.replace(/^\s*\/skill:\s+html-report(?=\s|$)/, "/skill:html-report");
}

export function assertFixedAConfigRecommendations(document, sessionId) {
  const cards = Array.isArray(document?.cards) ? document.cards : [];
  const card = cards[0];
  const filters = Array.isArray(card?.filters) ? card.filters : [];
  const storeFilter = filters.find((item) =>
    item?.type === "DIMENSION" && item?.dimUniqueCode === "storeId"
  );
  const errors = [];
  if (document?.version !== 1) errors.push("version must be 1");
  if (document?.sessionId !== sessionId) errors.push("sessionId mismatch");
  if (document?.mode !== "free") errors.push("mode must be free");
  if (document?.userQuestion !== FIXED_BUSINESS_QUESTION) {
    errors.push("userQuestion must equal the fixed business question exactly");
  }
  if (cards.length !== 1) errors.push("fixed preset must contain exactly one card");
  if (card?.id !== "debug-store-balance-001") errors.push("fixed card id mismatch");
  if (card?.chartType !== "table") errors.push("fixed card chartType must be table");
  if (JSON.stringify(card?.indicatorFieldList) !== JSON.stringify([
    "custNum", "perCustAmt", "profitLostRate", "profitAmt",
  ])) errors.push("fixed indicator list mismatch");
  if (JSON.stringify(card?.aggDimUniqueCodeList) !== JSON.stringify(["bizDate"])) {
    errors.push("fixed dimension list mismatch");
  }
  if (card?.storeCollectType !== 2) errors.push("fixed storeCollectType mismatch");
  if (JSON.stringify(storeFilter?.values) !== JSON.stringify(["101001"])) {
    errors.push("fixed store filter mismatch");
  }
  if (errors.length) {
    throw new SelfTestFailure({
      classification: "PRODUCT_CONTRACT",
      code: "FIXED_RECOMMENDATIONS_MISMATCH",
      stageId: "A_CONFIG",
      reason: `固定 A_CONFIG 推荐与 fixture 不一致：${errors.join("; ")}`,
    });
  }
  return { cardCount: cards.length, cardId: card.id };
}

export function normalizeStageId(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/[.\s-]+/g, "_");
  const aliases = {
    A: "A_CONFIG",
    A_CONFIG: "A_CONFIG",
    B0: "B0_PREFLIGHT",
    B0_PREFLIGHT: "B0_PREFLIGHT",
    B2: "B2_WRITER",
    B2_WRITER: "B2_WRITER",
    B3: "B3_RESEARCH",
    B3_RESEARCH: "B3_RESEARCH",
    B4: "B4_REVIEW",
    B4_REVIEW: "B4_REVIEW",
    B5: "B5_DESIGN",
    B5_DESIGN: "B5_DESIGN",
  };
  return aliases[raw] || null;
}

export function parseSelfTestArgs(argv = process.argv.slice(2)) {
  const options = {
    full: false,
    until: null,
    confirmMode: "http",
    configPath: DEFAULT_CONFIG_PATH,
    piBin: "pi",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    const map = {
      "--until": "until",
      "--confirm-mode": "confirmMode",
      "--config": "configPath",
      "--pi-bin": "piBin",
    };
    const field = map[arg];
    if (!field) throw new Error(`未知参数：${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少参数值`);
    options[field] = value;
    index += 1;
  }
  if (options.help) return options;
  if (options.full === Boolean(options.until)) {
    throw new Error("必须且只能指定 --full 或 --until <STAGE>");
  }
  if (!new Set(["http", "browser"]).has(options.confirmMode)) {
    throw new Error("--confirm-mode 只能是 http 或 browser");
  }
  options.until = options.full ? "B5_DESIGN" : normalizeStageId(options.until);
  if (!options.until) {
    throw new Error(`--until 阶段无效；允许：${EXTERNAL_STAGE_ORDER.join(", ")}`);
  }
  options.configPath = resolve(options.configPath);
  return options;
}

export function stageSequence(until) {
  const target = normalizeStageId(until);
  const index = EXTERNAL_STAGE_ORDER.indexOf(target);
  if (index < 0) throw new Error(`未知目标阶段：${until}`);
  return EXTERNAL_STAGE_ORDER.slice(0, index + 1);
}

export function expectedContinueCount(until) {
  return Math.max(0, stageSequence(until).length - 1);
}

export function hardTimeoutFor(stageId, config) {
  const budgets = config?.performanceBudgets || {};
  if (stageId === "B3_RESEARCH") {
    return Number(budgets.B25_EDITOR?.hardMs || 0) + Number(budgets.B3_RESEARCH?.hardMs || 0);
  }
  return Number(budgets[stageId]?.hardMs || 0);
}

function budgetFor(stageId, config) {
  const source = config?.performanceBudgets?.[stageId] || {};
  const softMs = Number(source.softMs);
  const hardMs = Number(source.hardMs);
  if (!Number.isFinite(softMs) || softMs <= 0 || !Number.isFinite(hardMs) || hardMs <= softMs) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "INVALID_PERFORMANCE_BUDGET",
      stageId,
      reason: `${stageId} 性能预算必须满足 0 < softMs < hardMs`,
    });
  }
  return { softMs, hardMs };
}

async function defaultWorkspaceSnapshot(root) {
  const { stdout: diff } = await execFileAsync(
    "git",
    ["diff", "--no-ext-diff", "--binary", "HEAD", "--"],
    { cwd: root, encoding: "buffer", maxBuffer: 128 * 1024 * 1024 }
  );
  const { stdout: untrackedRaw } = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }
  );
  const paths = untrackedRaw.toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256").update(diff);
  const included = [];
  for (const rel of paths) {
    if (rel === ".harness" || rel.startsWith(".harness/")) continue;
    const abs = resolve(root, rel);
    const inside = relative(root, abs);
    if (inside.startsWith("..") || isAbsolute(inside)) continue;
    const info = await lstat(abs);
    if (info.isDirectory()) continue;
    digest.update(`\0${rel}\0${info.mode}\0`, "utf8");
    if (info.isSymbolicLink()) digest.update(await readlink(abs), "utf8");
    else digest.update(await readFile(abs));
    included.push(rel);
  }
  const { stdout: status } = await execFileAsync(
    "git",
    ["status", "--short", "--untracked-files=all"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  return {
    sha256: digest.digest("hex"),
    dirtyPaths: status.split("\n").filter(Boolean).map((line) => line.slice(3)).filter((path) => !path.startsWith(".harness/")),
    untrackedPaths: included,
  };
}

async function defaultGitMetadata(root, piBin) {
  const [{ stdout: gitHead }, { stdout: piVersion }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
    execFileAsync(piBin, ["--version"], { cwd: root, encoding: "utf8" }),
  ]);
  return { gitHead: gitHead.trim(), piVersion: piVersion.trim() };
}

async function runtimeSourceDigest(root, relativePath, readFileImpl = readFile) {
  try {
    return createHash("sha256").update(await readFileImpl(join(root, relativePath))).digest("hex");
  } catch (error) {
    return `!${String(error?.code || "unreadable")}`;
  }
}

export async function validateRuntimeContract({
  root,
  sessionDir,
  sessionId,
  stageId = "A_CONFIG",
  sourceFiles = HTML_REPORT_RUNTIME_SOURCE_FILES,
  readFileImpl = readFile,
} = {}) {
  const contractPath = join(resolve(sessionDir), "debug", "runtime-contract.json");
  let marker;
  try {
    marker = parseJsonDocument(await readFileImpl(contractPath, "utf8"), contractPath);
  } catch (cause) {
    if (cause instanceof SelfTestFailure) throw cause;
    throw new SelfTestFailure({
      code: "RUNTIME_CONTRACT_MISSING",
      stageId,
      reason: `无法读取 runtime contract：${errorText(cause)}`,
      evidence: contractPath,
      cause,
    });
  }
  const expectedFiles = [...sourceFiles];
  const actualFiles = marker?.sources && typeof marker.sources === "object" && !Array.isArray(marker.sources)
    ? Object.keys(marker.sources)
    : [];
  const missingFiles = expectedFiles.filter((path) => !actualFiles.includes(path));
  const extraFiles = actualFiles.filter((path) => !expectedFiles.includes(path));
  if (
    marker?.version !== 1 ||
    marker?.producer !== "qdm-harness" ||
    marker?.sessionId !== sessionId ||
    missingFiles.length ||
    extraFiles.length
  ) {
    throw new SelfTestFailure({
      code: "RUNTIME_CONTRACT_SHAPE_MISMATCH",
      stageId,
      reason: `runtime contract 与当前 Session/source 清单不一致：missing=${missingFiles.join(",") || "none"} extra=${extraFiles.join(",") || "none"}`,
      evidence: contractPath,
    });
  }
  const invalidMarkerSources = expectedFiles.filter(
    (path) => typeof marker.sources[path] !== "string" || !/^[a-f0-9]{64}$/.test(marker.sources[path])
  );
  if (invalidMarkerSources.length) {
    throw new SelfTestFailure({
      code: "RUNTIME_CONTRACT_SOURCE_UNREADABLE",
      stageId,
      reason: `runtime contract 含缺失或不可读源码摘要：${invalidMarkerSources.join(",")}`,
      evidence: contractPath,
    });
  }
  const currentSources = Object.fromEntries(await Promise.all(expectedFiles.map(async (path) => [
    path,
    await runtimeSourceDigest(resolve(root), path, readFileImpl),
  ])));
  const invalidCurrentSources = expectedFiles.filter(
    (path) => typeof currentSources[path] !== "string" || !/^[a-f0-9]{64}$/.test(currentSources[path])
  );
  if (invalidCurrentSources.length) {
    throw new SelfTestFailure({
      code: "RUNTIME_CONTRACT_SOURCE_UNREADABLE",
      stageId,
      reason: `当前运行时源码缺失或不可读：${invalidCurrentSources.join(",")}`,
      evidence: contractPath,
    });
  }
  const changed = expectedFiles.filter((path) => marker.sources[path] !== currentSources[path]);
  const payload = expectedFiles.map((path) => [path, currentSources[path] ?? "!missing"]);
  const fingerprint = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  if (changed.length || marker.fingerprint !== fingerprint) {
    throw new SelfTestFailure({
      code: "RUNTIME_CONTRACT_FINGERPRINT_MISMATCH",
      stageId,
      reason: `runtime contract 与当前运行时源码不一致：changed=${changed.join(",") || "fingerprint"}`,
      evidence: contractPath,
    });
  }
  return {
    status: "pass",
    path: contractPath,
    fingerprint,
    sourceCount: expectedFiles.length,
  };
}

function commandHasOptionValue(command, option, value) {
  if (!value) return false;
  const optionPattern = regexpEscape(option);
  const valuePattern = regexpEscape(value);
  return new RegExp(`(?:^|\\s)${optionPattern}(?:=|\\s+)["']?${valuePattern}["']?(?=\\s|$)`).test(command);
}

export function parsePiSessionWriters(psOutput, { sessionId, sessionFile } = {}) {
  const writers = [];
  for (const line of String(psOutput || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (
      commandHasOptionValue(command, "--session-id", sessionId) ||
      commandHasOptionValue(command, "--session", sessionId) ||
      commandHasOptionValue(command, "--session", sessionFile)
    ) writers.push({ pid, command });
  }
  return writers;
}

async function defaultListPiSessionWriters({ sessionId, sessionFile }) {
  const { stdout } = await execFileAsync("ps", ["-ww", "-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePiSessionWriters(stdout, { sessionId, sessionFile });
}

export async function assertSinglePiSessionWriter({
  sessionId,
  sessionFile,
  expectedPid,
  stageId = "A_CONFIG",
  listWriters = defaultListPiSessionWriters,
} = {}) {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "PI_PROCESS_ID_MISSING",
      stageId,
      reason: "无法取得当前 Pi RPC 子进程 PID，不能审计同 Session writer",
    });
  }
  let writers;
  try {
    writers = await listWriters({ sessionId, sessionFile });
  } catch (cause) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "PI_SESSION_WRITER_AUDIT_FAILED",
      stageId,
      reason: `无法审计同 Session Pi writer：${errorText(cause)}`,
      cause,
    });
  }
  if (!Array.isArray(writers) || writers.some((item) =>
    !item || typeof item !== "object" || !Number.isSafeInteger(Number(item.pid)) || Number(item.pid) <= 0
  )) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "PI_SESSION_WRITER_AUDIT_INVALID",
      stageId,
      reason: "同 Session Pi writer 审计返回了非法进程列表",
      evidence: sessionFile,
    });
  }
  const pids = [...new Set(writers.map((item) => Number(item.pid)))];
  if (pids.some((pid) => pid !== expectedPid) || pids.length > 1) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "PI_SESSION_WRITER_CONFLICT",
      stageId,
      reason: `同 Session 必须只有当前 Pi RPC writer pid=${expectedPid}，实际 pids=${pids.join(",") || "none"}`,
      evidence: sessionFile,
    });
  }
  // Pi intentionally rewrites its process title to the bare string `pi`, so
  // macOS ps may hide every original CLI argument. In that case the ownership
  // evidence is the controller-generated UUID, the pre-start non-existent
  // Session path, and the live child PID returned by spawn(). Any visible
  // same-session command is still required to be that exact PID.
  return {
    status: "pass",
    pid: expectedPid,
    writerCount: 1,
    visibleWriterCount: pids.length,
    method: pids.length === 1 ? "visible_session_argument" : "fresh_session_owned_rpc_pid",
  };
}

function stageFromState(state, stageId) {
  const stage = state?.stages?.[stageId];
  if (!stage || typeof stage !== "object") {
    throw new SelfTestFailure({
      code: "STAGE_MISSING",
      stageId,
      reason: `pipeline-state.json 缺少 ${stageId}`,
    });
  }
  return stage;
}

function validatePipelineBoundary(state, stageId) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new SelfTestFailure({ code: "PIPELINE_STATE_INVALID", stageId, reason: "pipeline-state.json 必须是对象" });
  }
  if (state.mode !== "step") {
    throw new SelfTestFailure({ code: "GATE_MODE_CHANGED", stageId, reason: `Gate mode 应为 step，实际为 ${state.mode}` });
  }
  const stage = stageFromState(state, stageId);
  if (state.status === "failed" || stage.status === "failed") {
    throw new SelfTestFailure({
      code: "GATE_FAILED",
      stageId,
      reason: stage.failureReason || `${stageId} Gate failed`,
    });
  }
  if (state.currentStage !== stageId) {
    throw new SelfTestFailure({
      code: "UNEXPECTED_CURRENT_STAGE",
      stageId,
      reason: `预期停在 ${stageId}，实际为 ${state.currentStage || "<missing>"}`,
    });
  }
  const final = stageId === "B5_DESIGN";
  const expectedPipeline = final ? "completed" : "awaiting_approval";
  const expectedStage = final ? "completed" : "awaiting_approval";
  if (state.status !== expectedPipeline || stage.status !== expectedStage) {
    throw new SelfTestFailure({
      code: "GATE_NOT_AT_BOUNDARY",
      stageId,
      reason: `${stageId} 未停在验收边界：pipeline=${state.status} stage=${stage.status}`,
    });
  }
  if (!Array.isArray(stage.attempts) || stage.attempts.length !== 1 || stage.attempts[0]?.number !== 1) {
    throw new SelfTestFailure({
      code: "UNEXPECTED_GATE_RETRY",
      stageId,
      reason: `${stageId} 应仅有一次 Gate attempt，实际为 ${stage.attempts?.length || 0}`,
    });
  }
  for (const previousId of REQUIRED_PREVIOUS_STAGES[stageId] || []) {
    const previous = stageFromState(state, previousId);
    if (previous.status !== "completed") {
      throw new SelfTestFailure({
        code: "PREVIOUS_STAGE_INCOMPLETE",
        stageId,
        reason: `${previousId} 在 ${stageId} 验收时不是 completed`,
      });
    }
    if (!Array.isArray(previous.attempts) || previous.attempts.length !== 1) {
      throw new SelfTestFailure({
        code: "UNEXPECTED_GATE_RETRY",
        stageId,
        reason: `${previousId} 出现了 ${previous.attempts?.length || 0} 次 attempt`,
      });
    }
  }
  const expectedApprovals = EXTERNAL_STAGE_ORDER.indexOf(stageId);
  if (!Array.isArray(state.approvals) || state.approvals.length !== expectedApprovals) {
    throw new SelfTestFailure({
      code: "UNEXPECTED_GATE_APPROVAL_COUNT",
      stageId,
      reason: `${stageId} 前应有 ${expectedApprovals} 次批准，实际为 ${state.approvals?.length || 0}`,
    });
  }
  if (state.approvals.some((approval) => approval?.actor !== "user" || approval?.phrase !== "继续")) {
    throw new SelfTestFailure({
      code: "NON_USER_GATE_APPROVAL",
      stageId,
      reason: "Gate 只能由真实用户输入“继续”批准",
    });
  }
  return stage;
}

function assistantFailures(record) {
  const messages = [];
  if (record?.type === "message_end") messages.push(record.message);
  if (record?.type === "turn_end") messages.push(record.message);
  if (record?.type === "agent_end") messages.push(...(Array.isArray(record.messages) ? record.messages : []));
  return messages.filter((message) =>
    message?.role === "assistant" && ["error", "aborted"].includes(message?.stopReason)
  );
}

function assistantFailureReason(message) {
  const reason = [message?.errorMessage, message?.error]
    .find((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return String(reason || `Assistant stopReason=${message?.stopReason}`);
}

export function inspectRpcStageRecords(records, stageId) {
  const errors = [];
  let retryCount = 0;
  let toolCallCount = 0;
  const toolStarts = [];
  for (const [index, record] of records.entries()) {
    if (record?.type === "extension_error") {
      errors.push({
        code: "EXTENSION_ERROR",
        reason: String(record.error || record.message || "Pi extension_error"),
        evidence: `rpc stage record #${index + 1}`,
      });
    }
    if (record?.type === "tool_execution_start") {
      toolCallCount += 1;
      toolStarts.push(record);
    }
    if (record?.type === "tool_execution_end" && record.isError === true) {
      errors.push({
        code: "TOOL_EXECUTION_FAILED",
        reason: `${record.toolName || "tool"} 执行失败`,
        evidence: `rpc stage record #${index + 1}`,
      });
    }
    for (const message of assistantFailures(record)) {
      errors.push({
        code: `ASSISTANT_${String(message.stopReason).toUpperCase()}`,
        reason: assistantFailureReason(message),
        evidence: `rpc stage record #${index + 1}`,
      });
    }
    if ([
      "auto_retry_start",
      "summarization_retry_scheduled",
      "summarization_retry_attempt_start",
    ].includes(record?.type)) retryCount += 1;
  }
  if (retryCount) {
    errors.push({
      code: "UNEXPECTED_PROVIDER_RETRY",
      reason: `${stageId} 出现 ${retryCount} 次自动重试事件；自测已要求 set_auto_retry=false`,
      evidence: "rpc.jsonl",
    });
  }
  if (stageId === "A_CONFIG" && toolCallCount > 0) {
    const allowedAgentList = toolStarts.filter((record) => {
      if (String(record.toolName || "").toLowerCase() !== "subagent") return false;
      const input = record.args || record.input || {};
      return input && typeof input === "object" && !Array.isArray(input) &&
        input.action === "list" && Object.keys(input).every((key) => key === "action");
    });
    const allowedStatus = toolStarts.filter((record) => {
      if (String(record.toolName || "").toLowerCase() !== "bash") return false;
      const command = String(record.args?.command || record.input?.command || "")
        .replace(/\\\r?\n/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (/[;&|<>`]/.test(command) || /\$\(/.test(command)) return false;
      return /^node\s+(?:"[^"\n]*stage-gate\.mjs"|'[^'\n]*stage-gate\.mjs'|[^\s'"]*stage-gate\.mjs)\s+status\s+--session-dir\s+(?:"[^"\n]+"|'[^'\n]+'|[^\s]+)\s+--format\s+text$/.test(command);
    });
    const forbiddenCount = toolCallCount - allowedAgentList.length - allowedStatus.length;
    if (allowedAgentList.length > 1 || allowedStatus.length > 1 || forbiddenCount > 0) {
      errors.push({
        code: "A_CONFIG_TOOL_CALL_FORBIDDEN",
        reason: `固定 A_CONFIG 最多允许一次 subagent list 和一次只读 stage-gate status；总调用=${toolCallCount} list=${allowedAgentList.length} status=${allowedStatus.length} forbidden=${forbiddenCount}`,
        evidence: "rpc.jsonl",
      });
    }
  }
  return { errors, retryCount, toolCallCount };
}

export async function readRuntimeAgentListAuditCandidates(sessionDir, stageId, {
  attempt = null,
  readdirImpl = readdir,
  readFileImpl = readFile,
  lstatImpl = lstat,
} = {}) {
  if (!new Set(["A_CONFIG", "B0_PREFLIGHT"]).has(stageId)) return [];
  const auditDir = join(resolve(sessionDir), ...RUNTIME_AGENT_LIST_AUDIT_DIR);
  let names;
  try {
    names = await readdirImpl(auditDir);
  } catch (cause) {
    if (cause?.code === "ENOENT") return [];
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "RUNTIME_AGENT_LIST_AUDIT_READ_FAILED",
      stageId,
      reason: `无法读取 runtime agent list audit 目录：${errorText(cause)}`,
      evidence: auditDir,
      cause,
    });
  }
  const prefixed = names.filter((name) => String(name).startsWith(`${stageId}-`));
  const validName = new RegExp(`^${regexpEscape(stageId)}-[a-f0-9]{16}\\.json$`);
  const malformed = prefixed.filter((name) => !validName.test(String(name)));
  if (malformed.length) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "RUNTIME_AGENT_LIST_AUDIT_FILENAME_INVALID",
      stageId,
      reason: `${stageId} runtime agent list audit 文件名非法：${malformed.join(", ")}`,
      evidence: auditDir,
    });
  }
  const candidates = await Promise.all(prefixed.map(async (fileName) => {
    const path = join(auditDir, fileName);
    try {
      const info = await lstatImpl(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("audit path must be a regular non-symlink file");
      }
      const document = JSON.parse(await readFileImpl(path, "utf8"));
      return { fileName, path, document };
    } catch (cause) {
      throw new SelfTestFailure({
        classification: "TEST_HARNESS",
        code: "RUNTIME_AGENT_LIST_AUDIT_INVALID",
        stageId,
        reason: `${stageId} runtime agent list audit 不可读或不是合法 JSON：${errorText(cause)}`,
        evidence: path,
        cause,
      });
    }
  }));
  if (attempt == null) return candidates;
  const expectedFileName = runtimeAgentListAuditFileName(stageId, attempt);
  return candidates.filter((candidate) => candidate.fileName === expectedFileName);
}

function validateRuntimeAgentListAudit(candidate, { sessionId, stageId, attempt }) {
  const path = String(candidate?.path || "runtime-agent-list audit");
  const fileName = String(candidate?.fileName || "");
  const document = candidate?.document;
  const invalid = (code, reason) => {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code,
      stageId,
      reason,
      evidence: path,
    });
  };
  if (!exactObjectKeys(document, RUNTIME_AGENT_LIST_AUDIT_KEYS, RUNTIME_AGENT_LIST_AUDIT_OPTIONAL_KEYS)) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
      `${stageId} runtime agent list audit 顶层字段不符合 version 1 schema`
    );
  }
  const attemptToken = runtimeAgentListAttemptToken(stageId, attempt);
  const expectedFileName = runtimeAgentListAuditFileName(stageId, attempt);
  if (fileName !== expectedFileName) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_ATTEMPT_MISMATCH",
      `${stageId} runtime agent list audit 文件未绑定当前 attempt：expected=${expectedFileName} actual=${fileName || "<missing>"}`
    );
  }
  if (document.version !== 1 || document.producer !== RUNTIME_AGENT_LIST_AUDIT_PRODUCER ||
      document.mechanism !== RUNTIME_AGENT_LIST_AUDIT_MECHANISM) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
      `${stageId} runtime agent list audit version/producer/mechanism 非法`
    );
  }
  if (document.sessionId !== sessionId || document.stageId !== stageId || document.attempt !== attemptToken) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_BINDING_MISMATCH",
      `${stageId} runtime agent list audit 未绑定当前 session/stage/attempt`
    );
  }
  if (typeof document.requestId !== "string" || !document.requestId.trim()) {
    invalid("RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID", `${stageId} runtime agent list audit 缺少 requestId`);
  }
  if (!["inflight", "passed", "failed"].includes(document.status)) {
    invalid("RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID", `${stageId} runtime agent list audit status 非法`);
  }
  if (!uniqueStringArray(document.required) ||
      document.required.length !== REQUIRED_RUNTIME_REPORT_AGENTS.length ||
      document.required.some((name, index) => name !== REQUIRED_RUNTIME_REPORT_AGENTS[index])) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
      `${stageId} runtime agent list audit required 必须逐项等于四个 report-* Agent`
    );
  }
  if (!uniqueStringArray(document.observed) || !uniqueStringArray(document.missing)) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
      `${stageId} runtime agent list audit observed/missing 必须是唯一非空字符串数组`
    );
  }
  const observedFromResult = REQUIRED_RUNTIME_REPORT_AGENTS.filter((name) =>
    listedAgentNames({ content: [{ type: "text", text: document.result?.text || "" }] }).includes(name)
  );
  if (canonicalJson(document.observed) !== canonicalJson(observedFromResult)) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
      `${stageId} runtime agent list audit observed 与 result.text 不一致`
    );
  }
  const expectedMissing = REQUIRED_RUNTIME_REPORT_AGENTS.filter((name) => !document.observed.includes(name));
  if (canonicalJson(document.missing) !== canonicalJson(expectedMissing)) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
      `${stageId} runtime agent list audit missing 与 observed 不一致`
    );
  }
  if (!validIsoTimestamp(document.startedAt)) {
    invalid("RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID", `${stageId} runtime agent list audit startedAt 非法`);
  }
  if (document.status === "inflight") {
    if (![undefined, null].includes(document.endedAt) || ![undefined, null, 0].includes(document.durationMs)) {
      invalid(
        "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
        `${stageId} inflight runtime agent list audit 必须使用 endedAt=null 与 durationMs=null/0`
      );
    }
  } else {
    if (!validIsoTimestamp(document.endedAt) || Date.parse(document.endedAt) < Date.parse(document.startedAt) ||
        !Number.isFinite(document.durationMs) || document.durationMs < 0) {
      invalid(
        "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
        `${stageId} terminal runtime agent list audit endedAt/durationMs 非法`
      );
    }
  }
  if (!exactObjectKeys(document.result, RUNTIME_AGENT_LIST_RESULT_KEYS) ||
      typeof document.result.isError !== "boolean" || typeof document.result.text !== "string" ||
      !SHA256_HEX.test(String(document.result.sha256 || "")) ||
      document.result.sha256 !== sha256Text(document.result.text)) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_RESULT_INTEGRITY_MISMATCH",
      `${stageId} runtime agent list audit result 或 result.sha256 非法`
    );
  }
  if (!SHA256_HEX.test(String(document.auditSha256 || "")) ||
      document.auditSha256 !== runtimeAgentListAuditSha256(document)) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_INTEGRITY_MISMATCH",
      `${stageId} runtime agent list auditSha256 校验失败`
    );
  }
  if (document.status === "inflight") {
    throw new SelfTestFailure({
      code: "RUNTIME_AGENT_LIST_AUDIT_NOT_TERMINAL",
      stageId,
      reason: `${stageId} runtime agent list audit 仍为 inflight，不能作为验收证据`,
      evidence: path,
    });
  }
  if (document.status === "failed") {
    if (typeof document.error !== "string" || !document.error.trim()) {
      invalid(
        "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
        `${stageId} failed runtime agent list audit 必须包含非空 error`
      );
    }
    throw new SelfTestFailure({
      code: "RUNTIME_AGENT_LIST_FAILED",
      stageId,
      reason: `${stageId} extension-event-bridge runtime agent list 失败：${document.error}`,
      evidence: path,
    });
  }
  if (document.result.isError !== false || document.missing.length !== 0 ||
      (Object.prototype.hasOwnProperty.call(document, "error") && document.error != null)) {
    invalid(
      "RUNTIME_AGENT_LIST_AUDIT_SCHEMA_INVALID",
      `${stageId} passed runtime agent list audit 的 result/missing/error 状态不一致`
    );
  }
  return {
    source: "extension_audit",
    mechanism: document.mechanism,
    requestId: document.requestId,
    auditPath: path,
    auditSha256: document.auditSha256,
    sessionId,
    stageId,
    attempt: attemptToken,
    required: [...document.required],
    observed: [...document.observed].sort(),
    missing: [],
    status: "pass",
  };
}

export function inspectRuntimeAgentList(records, stageId, {
  auditCandidates = [],
  sessionId = null,
  attempt = null,
} = {}) {
  if (!new Set(["A_CONFIG", "B0_PREFLIGHT"]).has(stageId)) return null;
  const rpcStarts = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => {
      if (record?.type !== "tool_execution_start" || String(record.toolName || "").toLowerCase() !== "subagent") {
        return false;
      }
      const input = record.args || record.input || {};
      return input && typeof input === "object" && !Array.isArray(input) && input.action === "list";
    });
  const rpcSubagentEnds = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) =>
      record?.type === "tool_execution_end" && String(record.toolName || "").toLowerCase() === "subagent"
    );
  const audits = Array.isArray(auditCandidates) ? auditCandidates : [];
  const expectedAuditFileName = runtimeAgentListAuditFileName(stageId, attempt);
  const currentAudits = audits.filter((candidate) => candidate?.fileName === expectedAuditFileName);
  const hasRpcSource = rpcStarts.length > 0 || rpcSubagentEnds.length > 0;
  const hasAuditSource = currentAudits.length > 0;
  if (hasRpcSource && hasAuditSource) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "RUNTIME_AGENT_LIST_SOURCE_CONFLICT",
      stageId,
      reason: `${stageId} 同时出现 RPC subagent list 与 extension audit，两种来源只能恰好一种`,
      evidence: "rpc.jsonl + runtime-agent-list audit",
    });
  }
  if (currentAudits.length > 1) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "RUNTIME_AGENT_LIST_AUDIT_DUPLICATE",
      stageId,
      reason: `${stageId} 当前 Gate attempt 出现 ${currentAudits.length} 份 extension audit，必须恰好一份`,
      evidence: join("debug", "runtime-agent-list"),
    });
  }
  if (currentAudits.length === 1) {
    return validateRuntimeAgentListAudit(currentAudits[0], { sessionId, stageId, attempt });
  }
  if (!hasRpcSource) {
    throw new SelfTestFailure({
      code: "RUNTIME_AGENT_LIST_EVIDENCE_MISSING",
      stageId,
      reason: `${stageId} 缺少 runtime agent list 证据：既无 RPC subagent action=list，也无 extension audit`,
      evidence: "rpc.jsonl + debug/runtime-agent-list",
    });
  }
  if (rpcStarts.length !== 1) {
    throw new SelfTestFailure({
      code: "RUNTIME_AGENT_LIST_COUNT_MISMATCH",
      stageId,
      reason: `${stageId} RPC 必须恰好执行一次 subagent action=list，实际为 ${rpcStarts.length} 次`,
      evidence: "rpc.jsonl",
    });
  }
  const start = rpcStarts[0];
  const input = start.record.args || start.record.input || {};
  if (Object.keys(input).length !== 1 || input.action !== "list") {
    throw new SelfTestFailure({
      code: "RUNTIME_AGENT_LIST_CALL_SHAPE_INVALID",
      stageId,
      reason: `${stageId} RPC runtime list 必须是精确的 subagent({action:\"list\"})`,
      evidence: `rpc stage record #${start.index + 1}`,
    });
  }
  const toolCallId = String(start.record.toolCallId || start.record.id || "").trim();
  if (!toolCallId) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "RUNTIME_AGENT_LIST_CALL_ID_MISSING",
      stageId,
      reason: `${stageId} 的 subagent action=list 缺少 toolCallId，无法绑定结果`,
      evidence: `rpc stage record #${start.index + 1}`,
    });
  }
  const ends = rpcSubagentEnds.filter(({ record }) =>
    String(record.toolCallId || record.id || "") === toolCallId
  );
  if (ends.length !== 1 || rpcSubagentEnds.length !== 1) {
    throw new SelfTestFailure({
      classification: "TEST_HARNESS",
      code: "RUNTIME_AGENT_LIST_RESULT_MISSING",
      stageId,
      reason: `${stageId} 的 subagent action=list 应有一个唯一绑定结果，绑定=${ends.length} subagent结果总数=${rpcSubagentEnds.length}`,
      evidence: "rpc.jsonl",
    });
  }
  const end = ends[0];
  if (end.record.isError === true || end.record.result?.isError === true) {
    throw new SelfTestFailure({
      code: "RUNTIME_AGENT_LIST_FAILED",
      stageId,
      reason: `${stageId} 的 subagent action=list 执行失败`,
      evidence: `rpc stage record #${end.index + 1}`,
    });
  }
  const names = listedAgentNames(end.record.result ?? end.record);
  const missing = REQUIRED_RUNTIME_REPORT_AGENTS.filter((name) => !names.includes(name));
  if (missing.length) {
    throw new SelfTestFailure({
      code: "RUNTIME_REPORT_AGENTS_MISSING",
      stageId,
      reason: `${stageId} runtime list 缺少 ${missing.join(", ")}`,
      evidence: `rpc stage record #${end.index + 1}`,
    });
  }
  const attemptToken = runtimeAgentListAttemptToken(stageId, attempt);
  return {
    source: "rpc",
    mechanism: "subagent-tool",
    toolCallId,
    sessionId,
    stageId,
    attempt: attemptToken,
    required: [...REQUIRED_RUNTIME_REPORT_AGENTS],
    observed: names,
    missing: [],
    status: "pass",
  };
}

function agentNamesFromValue(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (typeof value.agent === "string") output.push(value.agent);
  if (Array.isArray(value)) {
    for (const item of value) agentNamesFromValue(item, output);
    return output;
  }
  for (const child of Object.values(value)) agentNamesFromValue(child, output);
  return output;
}

function plannerBridgeMarker(record) {
  if (
    record?.type !== "tool_execution_end" ||
    String(record.toolName || "").toLowerCase() !== "bash"
  ) return null;
  const marker = record?.result?.details?.qdmHarnessAutoSubagent;
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    marker.version !== 1 ||
    marker.producer !== "qdm-harness" ||
    marker.mechanism !== "extension-event-bridge" ||
    typeof marker.sessionId !== "string" ||
    !marker.sessionId ||
    typeof marker.attempt !== "string" ||
    !marker.attempt ||
    marker.stageId !== "B25_EDITOR" ||
    marker.role !== "report-editor-planner" ||
    marker.agent !== "report-researcher" ||
    typeof marker.requestId !== "string" ||
    !marker.requestId
  ) return null;
  return marker;
}

function researcherBridgeMarker(record) {
  if (
    record?.type !== "tool_execution_end" ||
    String(record.toolName || "").toLowerCase() !== "bash"
  ) return null;
  const marker = record?.result?.details?.qdmHarnessAutoResearcher;
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    marker.version !== 1 ||
    marker.producer !== "qdm-harness" ||
    marker.mechanism !== "extension-event-bridge" ||
    typeof marker.sessionId !== "string" ||
    !marker.sessionId ||
    typeof marker.attempt !== "string" ||
    !marker.attempt ||
    marker.stageId !== "B3_RESEARCH" ||
    marker.role !== "report-researcher" ||
    marker.agent !== "report-researcher" ||
    typeof marker.requestId !== "string" ||
    !marker.requestId
  ) return null;
  return marker;
}

export function countSubagentDispatches(records) {
  const counts = {};
  for (const record of records) {
    if (record?.type === "tool_execution_start" && String(record.toolName).toLowerCase() === "subagent") {
      const names = agentNamesFromValue(record.args || record.input || {});
      for (const name of names) counts[name] = (counts[name] || 0) + 1;
      continue;
    }
    const plannerMarker = plannerBridgeMarker(record);
    if (plannerMarker) {
      // The Planner is one semantic role implemented by one real
      // report-researcher process, so retain both comparable counters.
      counts[plannerMarker.role] = (counts[plannerMarker.role] || 0) + 1;
      counts[plannerMarker.agent] = (counts[plannerMarker.agent] || 0) + 1;
    }
    const researcherMarker = researcherBridgeMarker(record);
    if (researcherMarker) {
      counts[researcherMarker.agent] = (counts[researcherMarker.agent] || 0) + 1;
    }
  }
  return counts;
}

const DURABLE_DISPATCH_MECHANISMS = new Set(["model-tool", "extension-event-bridge"]);

function durableResearcherTaskId(record) {
  if (record?.role !== "report-researcher" || typeof record.label !== "string") return null;
  return record.label.match(/(?:^|\s)taskId=([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s|$)/)?.[1] || null;
}

async function readDispatchRecords(sessionDir) {
  const directory = join(sessionDir, "debug", "contract-runtime", "dispatches");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name))) {
    records.push(parseJsonDocument(await readFile(join(directory, entry.name), "utf8"), entry.name));
  }
  return records;
}

async function defaultReadJson(path) {
  return parseJsonDocument(await readFile(path, "utf8"), path);
}

async function validateDispatchPolicy({
  stageId,
  stageRecords,
  sessionDir,
  debugB5Skipped = false,
  readJson = defaultReadJson,
  readDispatches = readDispatchRecords,
}) {
  const observed = countSubagentDispatches(stageRecords);
  const durable = await readDispatches(sessionDir);
  const duplicateKeys = durable.map((record) => record.identityKey).filter((key, index, all) => key && all.indexOf(key) !== index);
  if (duplicateKeys.length) {
    throw new SelfTestFailure({
      code: "DUPLICATE_DURABLE_DISPATCH",
      stageId,
      reason: `${stageId} contract-runtime 存在重复 identityKey`,
    });
  }
  if (stageId === "B2_WRITER") {
    const result = await readJson(join(sessionDir, "result.json"));
    const expected = Array.isArray(result.cards) ? result.cards.length : 0;
    const durableCount = durable.filter((record) => record.role === "report-writer").length;
    if (expected < 1 || observed["report-writer"] !== expected || durableCount !== expected) {
      throw new SelfTestFailure({
        code: "WRITER_DISPATCH_COUNT_MISMATCH",
        stageId,
        reason: `Writer 应按 ${expected} 张卡各派发一次；RPC=${observed["report-writer"] || 0} durable=${durableCount}`,
      });
    }
  }
  if (stageId === "B3_RESEARCH") {
    const tasks = await readJson(join(sessionDir, "analysis", "tasks.json"));
    const taskIds = (Array.isArray(tasks.tasks) ? tasks.tasks : []).map((task) => String(task?.id || "")).filter(Boolean);
    const taskIdSet = new Set(taskIds);
    const planners = durable.filter((record) => record.role === "report-editor-planner");
    const researcher = durable.filter((record) => record.role === "report-researcher");
    const plannerMarkers = stageRecords.map(plannerBridgeMarker).filter(Boolean);
    const researcherMarkers = stageRecords.map(researcherBridgeMarker).filter(Boolean);
    const plannerMarkerCount = observed["report-editor-planner"] || 0;
    const observedCount = observed["report-researcher"] || 0;

    if (
      planners.length !== 1 ||
      !DURABLE_DISPATCH_MECHANISMS.has(planners[0]?.mechanism)
    ) {
      throw new SelfTestFailure({
        code: "EDITOR_PLANNER_DISPATCH_COUNT_MISMATCH",
        stageId,
        reason: `B2.5 Editor Planner 必须有且仅有一个合法 durable 派发；durable=${planners.length}`,
      });
    }

    const expectedPlannerMarkerCount = planners[0].mechanism === "extension-event-bridge" ? 1 : 0;
    const markerBindingMismatch = expectedPlannerMarkerCount === 1 && (
      plannerMarkers[0]?.sessionId !== planners[0]?.sessionId ||
      plannerMarkers[0]?.attempt !== planners[0]?.attempt
    );
    if (plannerMarkerCount !== expectedPlannerMarkerCount || markerBindingMismatch) {
      throw new SelfTestFailure({
        code: "EDITOR_PLANNER_RPC_MARKER_MISMATCH",
        stageId,
        reason: `B2.5 Editor Planner RPC marker 与 durable mechanism/session/attempt 不匹配；mechanism=${planners[0].mechanism} marker=${plannerMarkerCount}`,
      });
    }

    const invalidResearchers = researcher.filter((record) => {
      const taskId = durableResearcherTaskId(record);
      return !DURABLE_DISPATCH_MECHANISMS.has(record?.mechanism) || !taskId || !taskIdSet.has(taskId);
    });
    const countsByTask = new Map(taskIds.map((taskId) => [taskId, 0]));
    for (const record of researcher) {
      const taskId = durableResearcherTaskId(record);
      if (countsByTask.has(taskId)) countsByTask.set(taskId, countsByTask.get(taskId) + 1);
    }
    const invalidTaskCounts = [...countsByTask].filter(([, count]) => count < 1 || count > 2);
    if (invalidResearchers.length || invalidTaskCounts.length) {
      const counts = [...countsByTask].map(([taskId, count]) => `${taskId}:${count}`).join(",") || "none";
      throw new SelfTestFailure({
        code: taskIds.length === 0 ? "UNEXPECTED_RESEARCHER_DISPATCH" : "RESEARCHER_DISPATCH_COUNT_MISMATCH",
        stageId,
        reason: `每个 task 必须有 1 次 Researcher 派发，最多允许 1 次 successor 修复；counts=${counts} invalid=${invalidResearchers.length}`,
      });
    }

    const bridgedResearchers = researcher.filter((record) => record.mechanism === "extension-event-bridge");
    const researcherMarkerBindingMismatch = researcherMarkers.some((marker) =>
      !bridgedResearchers.some((record) =>
        marker.sessionId === record.sessionId && marker.attempt === record.attempt
      ));
    if (
      researcherMarkers.length !== bridgedResearchers.length ||
      researcherMarkerBindingMismatch
    ) {
      throw new SelfTestFailure({
        code: "RESEARCHER_RPC_MARKER_MISMATCH",
        stageId,
        reason: `B3 initial Researcher RPC marker 与 durable mechanism/session/attempt 不匹配；marker=${researcherMarkers.length} durableBridge=${bridgedResearchers.length}`,
      });
    }

    const expectedRpcResearcherCount = planners.length + researcher.length;
    if (observedCount !== expectedRpcResearcherCount) {
      throw new SelfTestFailure({
        code: "RESEARCHER_DISPATCH_COUNT_MISMATCH",
        stageId,
        reason: `RPC report-researcher 总数必须等于 durable Planner+Researcher；RPC=${observedCount} durable=${expectedRpcResearcherCount}`,
      });
    }
  }
  if (stageId === "B4_REVIEW") {
    const durableCount = durable.filter((record) => record.role === "report-reviewer").length;
    if (observed["report-reviewer"] !== 1 || durableCount !== 1) {
      throw new SelfTestFailure({
        code: "REVIEWER_DISPATCH_COUNT_MISMATCH",
        stageId,
        reason: `Reviewer 必须恰好派发一次；RPC=${observed["report-reviewer"] || 0} durable=${durableCount}`,
      });
    }
  }
  if (stageId === "B5_DESIGN") {
    const designerRpcCount = observed["report-designer"] || 0;
    const designerDurableCount = durable.filter((record) => record.role === "report-designer").length;
    if (debugB5Skipped && (designerRpcCount !== 0 || designerDurableCount !== 0)) {
      throw new SelfTestFailure({
        code: "DEBUG_B5_DESIGNER_DISPATCH_FORBIDDEN",
        stageId,
        reason: `固定推荐调试模式必须跳过 Designer；RPC=${designerRpcCount} durable=${designerDurableCount}`,
      });
    }
    if (!debugB5Skipped && designerRpcCount !== 1) {
      throw new SelfTestFailure({
        code: "DESIGNER_DISPATCH_COUNT_MISMATCH",
        stageId,
        reason: `Designer 必须恰好派发一次；RPC=${designerRpcCount}`,
      });
    }
  }
  return { observed, durableCount: durable.length };
}

async function defaultPreflightAgents(root) {
  const script = join(root, ".agents", "pi", "skills", "html-report", "scripts", "check-report-agents.mjs");
  try {
    const { stdout } = await execFileAsync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseJsonDocument(stdout, "check-report-agents 输出");
  } catch (error) {
    const detail = oneLine(error?.stdout || error?.stderr || errorText(error));
    throw new SelfTestFailure({
      code: "REPORT_AGENTS_PREFLIGHT_FAILED",
      stageId: "B0_PREFLIGHT",
      reason: `report-* Agent 仓库预检失败：${detail}`,
      cause: error,
    });
  }
}

async function runLayouts(stageId, sessionDir, checkLayoutImpl, { debugB5Skipped = false } = {}) {
  if (stageId === "B5_DESIGN" && debugB5Skipped) {
    return {
      ok: null,
      status: "skipped",
      phase: null,
      reports: [],
      errors: [],
      warnings: ["固定推荐调试模式自动跳过 B5 Report Designer；未执行 phase=html layout。"],
    };
  }
  const reports = [];
  for (const phase of LAYOUT_PHASES[stageId] || []) {
    const report = await checkLayoutImpl(sessionDir, { phase });
    reports.push(report);
    if (!report?.ok) {
      throw new SelfTestFailure({
        code: "LAYOUT_FAILED",
        stageId,
        reason: `${stageId} layout phase=${phase} 失败：${(report?.errors || []).join("; ")}`,
      });
    }
  }
  return {
    ok: reports.every((report) => report?.ok),
    status: reports.every((report) => report?.ok) ? "pass" : "fail",
    phase: (LAYOUT_PHASES[stageId] || []).join("+") || null,
    reports,
    errors: reports.flatMap((report) => report?.errors || []),
    warnings: reports.flatMap((report) => report?.warnings || []),
  };
}

function performanceFailure(stageId, durationMs, budget, kind = "execution") {
  if (durationMs <= budget.softMs) return null;
  return new SelfTestFailure({
    classification: "PERFORMANCE_REGRESSION",
    code: "SOFT_BUDGET_EXCEEDED",
    stageId,
    reason: `${stageId} ${kind}耗时 ${durationMs}ms 超过软阈值 ${budget.softMs}ms`,
  });
}

function usage() {
  return [
    "用法：",
    `  node ${basename(scriptPath)} --full`,
    `  node ${basename(scriptPath)} --until B3_RESEARCH`,
    "",
    "选项：",
    "  --confirm-mode http|browser  默认 http；browser 用于页面专项验收",
    "  --config <path>             覆盖性能阈值配置",
    "  --pi-bin <path>             覆盖 Pi 可执行文件",
  ].join("\n") + "\n";
}

async function writeRuntimeFiles({ runDir, run, rpc, observations, checkpoints }) {
  await Promise.all([
    writeFile(join(runDir, "run.json"), safeJson(run), "utf8"),
    writeFile(
      join(runDir, "rpc.jsonl"),
      rpc.getRecords().map((record) => JSON.stringify(redact(record))).join("\n") + (rpc.getRecords().length ? "\n" : ""),
      "utf8"
    ),
    writeFile(join(runDir, "stderr.log"), redact(rpc.getStderr()), "utf8"),
    writeFile(join(runDir, "stage-observations.json"), safeJson({ version: 1, stages: observations }), "utf8"),
    ...checkpoints.map((checkpoint) =>
      writeFile(join(runDir, "checkpoints", `${checkpoint.stageId}.json`), safeJson(checkpoint), "utf8")
    ),
  ]);
}

export async function safeAbort(rpc) {
  const recordStart = rpc.getRecords().length;
  let settledWait = null;
  try {
    // Register before sending abort: Pi may emit agent_settled while the abort
    // response itself is still in flight, and a later waiter would miss it.
    settledWait = Promise.resolve(rpc.waitForAgentSettled({ timeoutMs: 15_000 }))
      .then(() => true, () => false);
  } catch {
    // The process may not have started or may already be closed.
  }
  try { await rpc.abort({ timeoutMs: 10_000 }); } catch { /* process may already be idle/dead */ }
  try { await rpc.abortRetry({ timeoutMs: 10_000 }); } catch { /* no retry may be active */ }
  const settledObserved = rpc.getRecords()
    .slice(recordStart)
    .some((record) => record?.type === "agent_settled");
  if (!settledObserved && settledWait) await settledWait;
}

export function watchInternalStageBudgets({ readPipelineState, sessionDir, config, now = Date.now, intervalMs = 500 }) {
  let stopped = false;
  let timer = null;
  let rejectWatch;
  const promise = new Promise((_, reject) => { rejectWatch = reject; });
  const tick = async () => {
    if (stopped) return;
    try {
      const state = await readPipelineState(sessionDir);
      const currentId = state?.currentStage;
      if (["B25_EDITOR", "B3_RESEARCH"].includes(currentId) && state?.status === "running") {
        if (currentId === "B3_RESEARCH") {
          const editor = state.stages?.B25_EDITOR;
          const editorDurationMs = Number(editor?.executionDurationMs || 0);
          const editorRegression = editor?.status === "completed"
            ? performanceFailure("B25_EDITOR", editorDurationMs, budgetFor("B25_EDITOR", config), "执行")
            : null;
          if (editorRegression) {
            stopped = true;
            rejectWatch(editorRegression);
            return;
          }
        }
        const stage = state.stages?.[currentId];
        const attempt = Array.isArray(stage?.attempts) ? stage.attempts.at(-1) : null;
        const interval = Array.isArray(attempt?.executionIntervals) ? attempt.executionIntervals.at(-1) : null;
        const activeStartedAt = interval?.startedAt || attempt?.startedAt || stage?.startedAt;
        const activeMs = activeStartedAt ? Math.max(0, Number(now()) - Date.parse(activeStartedAt)) : 0;
        const persistedMs = Number(stage?.executionDurationMs || attempt?.executionDurationMs || 0);
        const observedMs = Math.max(activeMs, persistedMs);
        const hardMs = budgetFor(currentId, config).hardMs;
        if (observedMs > hardMs) {
          stopped = true;
          rejectWatch(new SelfTestFailure({
            classification: "PERFORMANCE_REGRESSION",
            code: "HARD_BUDGET_EXCEEDED",
            stageId: currentId,
            reason: `${currentId} 仍在运行且已超过硬超时 ${hardMs}ms（观测 ${observedMs}ms）`,
          }));
          return;
        }
      }
    } catch (error) {
      // The state file can be between atomic renames. A later tick retries;
      // the outer RPC timeout still provides a final hard stop.
      if (error instanceof SelfTestFailure) {
        stopped = true;
        rejectWatch(error);
        return;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    promise,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function anomalyFrom(error, fallbackStage) {
  return {
    classification: error?.classification || (/timeout/i.test(errorText(error)) ? "INFRASTRUCTURE" : "TEST_HARNESS"),
    code: error?.code || "UNEXPECTED_ERROR",
    reason: errorText(error),
    stageId: error?.stageId || fallbackStage || null,
    evidence: error?.evidence || null,
    occurredAt: new Date().toISOString(),
  };
}

const ABORT_CONSEQUENCE_CODES = new Set([
  "ASSISTANT_ABORTED",
  "PI_SESSION_ASSISTANT_ABORTED",
]);

function sameAnomalyKind(left, right) {
  return left?.code === right?.code && String(left?.stageId || "") === String(right?.stageId || "");
}

/**
 * Keep the controller's hard-budget failure as the primary diagnosis when the
 * subsequent assistant abort is only a consequence, and collapse independently
 * derived copies of the same stage hard-budget failure into one report entry.
 */
export function reconcileSelfTestDiagnostics(report, run) {
  if (!report || typeof report !== "object") return report;
  const primary = run?.firstAnomaly || run?.anomaly || null;
  const primaryHardBudget = primary?.code === "HARD_BUDGET_EXCEEDED" ? primary : null;
  const sourceAnomalies = Array.isArray(report.anomalies) ? report.anomalies : [];
  const canonicalPrimary = primaryHardBudget
    ? sourceAnomalies.find((issue) =>
        sameAnomalyKind(issue, primaryHardBudget) &&
        issue?.reason === primaryHardBudget.reason &&
        issue?.occurredAt === primaryHardBudget.occurredAt
      ) || {
        ...primaryHardBudget,
        source: "run",
        toolOrAgent: primaryHardBudget.toolOrAgent || null,
        evidence: primaryHardBudget.evidence || null,
      }
    : null;
  const seenHardBudgets = new Set();
  const anomalies = [];
  for (const issue of sourceAnomalies) {
    if (issue?.code !== "HARD_BUDGET_EXCEEDED") {
      anomalies.push(issue);
      continue;
    }
    const key = String(issue?.stageId || "");
    if (seenHardBudgets.has(key)) continue;
    seenHardBudgets.add(key);
    anomalies.push(primaryHardBudget && sameAnomalyKind(issue, primaryHardBudget)
      ? canonicalPrimary
      : issue);
  }
  if (primaryHardBudget && !seenHardBudgets.has(String(primaryHardBudget.stageId || ""))) {
    anomalies.push(canonicalPrimary);
  }

  let firstAnomaly = report.firstAnomaly || null;
  if (primaryHardBudget && sameAnomalyKind(firstAnomaly, primaryHardBudget)) {
    firstAnomaly = canonicalPrimary;
  }
  if (primaryHardBudget && (!firstAnomaly || ABORT_CONSEQUENCE_CODES.has(firstAnomaly.code))) {
    const canonicalIndex = anomalies.indexOf(canonicalPrimary);
    if (canonicalIndex >= 0) anomalies.splice(canonicalIndex, 1);
    anomalies.unshift(canonicalPrimary);
    firstAnomaly = canonicalPrimary;
  }
  return { ...report, firstAnomaly, anomalies };
}

/**
 * Execute a new Session through the requested external stage.
 * Dependencies are injectable so unit tests never start a real model.
 */
export async function runHtmlReportSelfTest(options = {}, dependencies = {}) {
  const root = resolve(options.projectRoot || projectRootFromScript);
  const configPath = resolve(options.configPath || DEFAULT_CONFIG_PATH);
  const targetStage = normalizeStageId(options.until || (options.full ? "B5_DESIGN" : ""));
  if (!targetStage) throw new Error("runHtmlReportSelfTest requires full=true or a valid until stage");
  const confirmMode = options.confirmMode || "http";
  if (!new Set(["http", "browser"]).has(confirmMode)) throw new Error("confirmMode must be http or browser");

  const now = dependencies.now || Date.now;
  const uuid = dependencies.uuid || randomUUID;
  const workspaceSnapshot = dependencies.workspaceSnapshot || defaultWorkspaceSnapshot;
  const gitMetadata = dependencies.gitMetadata || defaultGitMetadata;
  const readJson = dependencies.readJson || defaultReadJson;
  const readPipelineState = dependencies.readPipelineState || ((sessionDir) => readJson(join(sessionDir, "debug", "pipeline-state.json")));
  const readRuntimeAgentListAudits = dependencies.readRuntimeAgentListAudits || readRuntimeAgentListAuditCandidates;
  const checkLayoutImpl = dependencies.checkSessionLayout || checkSessionLayout;
  const preflightAgents = dependencies.preflightAgents || defaultPreflightAgents;
  const confirmHttp = dependencies.headlessConfirm || headlessConfirm;
  const confirmBrowser = dependencies.browserConfirm || browserConfirm;
  const readDispatches = dependencies.readDispatches || readDispatchRecords;
  const createRpcClient = dependencies.createRpcClient || ((settings) => new PiRpcClient(settings));
  const discoverExtensions = dependencies.discoverPiSubagentExtensions || discoverPiSubagentExtensions;
  const validateRuntimeContractImpl = dependencies.validateRuntimeContract || validateRuntimeContract;
  const listPiSessionWriters = dependencies.listPiSessionWriters || defaultListPiSessionWriters;
  const waitForSessionFile = dependencies.waitForSessionFile || waitForAccessibleFile;
  const analyzeRun = dependencies.analyzeHtmlReportRun || analyzeHtmlReportRunWithTranscripts;
  const writeReport = dependencies.writeHtmlReportRunReport || writeHtmlReportRunReport;

  const sessionId = String(uuid());
  const sessionDir = join(root, ".harness", "state", "html-report", sessionId);
  const runDir = join(root, ".harness", "test-runs", "html-report", sessionId);
  const checkpointsDir = join(runDir, "checkpoints");
  if (await exists(sessionDir)) throw new Error(`refusing to reuse existing html-report Session: ${sessionDir}`);
  await mkdir(checkpointsDir, { recursive: true });

  const config = parseJsonDocument(await readFile(configPath, "utf8"), configPath);
  for (const id of INTERNAL_STAGE_ORDER) budgetFor(id, config);
  const originalPrompt = options.originalPrompt || ORIGINAL_PROMPT;
  const effectivePrompt = normalizeSkillPrompt(originalPrompt);
  if (effectivePrompt !== EFFECTIVE_PROMPT && originalPrompt === ORIGINAL_PROMPT) {
    throw new Error("fixed Prompt normalization changed unexpectedly");
  }
  const baseline = normalizeSnapshot(await workspaceSnapshot(root));
  const metadata = await gitMetadata(root, options.piBin || "pi");
  const startedAt = nowIso(now);
  const runtimeEnv = {
    ...(options.env || {}),
    HTML_REPORT_GATE_MODE: "step",
    HTML_REPORT_A_CONFIG_MODE: "fixed",
    HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN: "0",
  };
  const run = {
    version: 1,
    producer: "html-report-self-test.mjs",
    status: "running",
    sessionId,
    projectRoot: root,
    runDir,
    htmlReportSessionDir: sessionDir,
    pipelineStatePath: join(sessionDir, "debug", "pipeline-state.json"),
    checkpointsDir,
    rpcLogPath: join(runDir, "rpc.jsonl"),
    stderrLogPath: join(runDir, "stderr.log"),
    stageObservationsPath: join(runDir, "stage-observations.json"),
    performanceConfigPath: configPath,
    startedAt,
    endedAt: null,
    stoppedStage: null,
    targetStage,
    confirmMode,
    originalPrompt,
    effectivePrompt,
    gitHead: metadata.gitHead,
    workspaceFingerprint: baseline.sha256,
    source: { gitHead: metadata.gitHead, workspaceFingerprint: baseline.sha256, dirtyPaths: baseline.dirtyPaths },
    piVersion: metadata.piVersion,
    provider: null,
    modelId: null,
    thinkingLevel: null,
    sessionFile: null,
    piProcessId: null,
    runtimeEnv: {
      HTML_REPORT_GATE_MODE: runtimeEnv.HTML_REPORT_GATE_MODE,
      HTML_REPORT_A_CONFIG_MODE: runtimeEnv.HTML_REPORT_A_CONFIG_MODE,
      HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN: runtimeEnv.HTML_REPORT_FIXED_RECOMMENDATIONS_OPEN,
    },
    sessionWriterAudit: null,
    sessionWriterAudits: [],
    runtimeContract: null,
    piSubagents: null,
    anomaly: null,
    firstAnomaly: null,
  };
  const observations = [];
  const checkpoints = [];
  let currentStage = "A_CONFIG";
  let pipelineState = { sessionId, sessionDir, status: "running", currentStage, stages: {} };
  let report;

  let extensionDiscoveryError = null;
  let piSubagents = null;
  try {
    const discovered = await discoverExtensions({
      env: { ...process.env, ...runtimeEnv },
      projectRoot: root,
      piBin: options.piBin || "pi",
    });
    const extensions = [...new Set((discovered?.extensions || []).map((path) => resolve(path)))];
    if (extensions.length < 1) {
      throw new SelfTestFailure({
        classification: "TEST_HARNESS",
        code: "PI_SUBAGENTS_EXTENSION_MISSING",
        stageId: "A_CONFIG",
        reason: "pi-subagents 自动发现未返回任何扩展入口",
      });
    }
    piSubagents = {
      packageRoot: discovered.packageRoot ? resolve(discovered.packageRoot) : null,
      manifestPath: discovered.manifestPath ? resolve(discovered.manifestPath) : null,
      packageVersion: String(discovered.packageVersion || ""),
      extensions,
      runtimeVerified: false,
      commandSource: null,
    };
    run.piSubagents = piSubagents;
  } catch (error) {
    extensionDiscoveryError = error instanceof SelfTestFailure
      ? error
      : new SelfTestFailure({
          classification: "TEST_HARNESS",
          code: "PI_SUBAGENTS_DISCOVERY_FAILED",
          stageId: "A_CONFIG",
          reason: `pi-subagents 自动发现失败：${errorText(error)}`,
          cause: error,
        });
  }
  const rpcArgs = withExplicitExtensions(options.piArgs || [], piSubagents?.extensions || [], root);

  const rpc = createRpcClient({
    cwd: root,
    sessionId,
    piBin: options.piBin || "pi",
    env: runtimeEnv,
    args: rpcArgs,
    requestTimeoutMs: Number(config.rpc?.requestTimeoutMs || 30_000),
    settledTimeoutMs: Math.max(...Object.values(config.performanceBudgets).map((value) => Number(value.hardMs))),
  });

  async function checkpoint(stageId, details) {
    const item = {
      version: 1,
      stageId,
      observedAt: nowIso(now),
      sessionWriterAudit: run.sessionWriterAudit,
      ...details,
    };
    checkpoints.push(item);
    await writeRuntimeFiles({ runDir, run, rpc, observations, checkpoints });
    return item;
  }

  async function auditSessionWriter(stageId, boundary) {
    const audit = await assertSinglePiSessionWriter({
      sessionId,
      sessionFile: run.sessionFile,
      expectedPid: rpc.processId,
      stageId,
      listWriters: listPiSessionWriters,
    });
    const observed = {
      ...audit,
      stageId,
      boundary,
      observedAt: nowIso(now),
    };
    run.sessionWriterAudit = observed;
    run.sessionWriterAudits.push(observed);
    return observed;
  }

  async function assertWorkspaceUnchanged(stageId, before) {
    const after = normalizeSnapshot(await workspaceSnapshot(root));
    if (after.sha256 !== baseline.sha256 || after.sha256 !== before.sha256) {
      throw new SelfTestFailure({
        classification: "PRODUCT_CONTRACT",
        code: "SOURCE_MUTATION_DETECTED",
        stageId,
        reason: `${stageId} 执行期间修改了 Git 工作区源码；baseline=${baseline.sha256} after=${after.sha256}`,
      });
    }
    return after;
  }

  async function executeStage(stageId, message) {
    currentStage = stageId;
    run.stoppedStage = stageId;
    const budget = budgetFor(stageId, config);
    const hardMs = hardTimeoutFor(stageId, config);
    const recordStart = rpc.getRecords().length;
    const sourceBefore = normalizeSnapshot(await workspaceSnapshot(root));
    const stageStartedAt = nowIso(now);
    let settled;
    let stopFailureWatch = () => {};
    let rejectFailureWatch;
    let failureWatchStopped = false;
    const failureWatch = new Promise((_, reject) => { rejectFailureWatch = reject; });
    stopFailureWatch = rpc.onEvent((record) => {
      if (failureWatchStopped) return;
      const first = inspectRpcStageRecords([record], stageId).errors[0];
      if (!first) return;
      failureWatchStopped = true;
      rejectFailureWatch(new SelfTestFailure({
        code: first.code,
        stageId,
        reason: first.reason,
        evidence: first.evidence,
      }));
    });
    const internalWatch = stageId === "B3_RESEARCH"
      ? watchInternalStageBudgets({
          readPipelineState,
          sessionDir,
          config,
          now,
          intervalMs: Number(config.pollIntervalMs || 500),
        })
      : null;
    try {
      const prompt = rpc.promptAndWait(message, {
        requestId: `stage-${stageId.toLowerCase()}-${observations.length + 1}`,
        requestTimeoutMs: Number(config.rpc?.requestTimeoutMs || 30_000),
        settledTimeoutMs: hardMs,
        ...(stageId === "B0_PREFLIGHT" ? {
          completionPredicate: (event) => event?.type === "agent_settled" || b0GateMessageCandidate(event),
          completionDescription: "B0 html-report-gate message_end",
        } : {}),
      });
      settled = await Promise.race([
        prompt,
        failureWatch,
        ...(internalWatch ? [internalWatch.promise] : []),
      ]);
    } catch (cause) {
      if (cause instanceof SelfTestFailure) throw cause;
      throw new SelfTestFailure({
        classification: /TIMEOUT/.test(String(cause?.code || "")) ? "PERFORMANCE_REGRESSION" : "INFRASTRUCTURE",
        code: cause?.code || "PI_STAGE_FAILED",
        stageId,
        reason: `${stageId} 未在硬超时 ${hardMs}ms 内稳定结束：${errorText(cause)}`,
        cause,
      });
    } finally {
      failureWatchStopped = true;
      stopFailureWatch();
      internalWatch?.stop();
    }
    const completion = stageId === "B0_PREFLIGHT"
      ? inspectB0CompletionEvents(settled?.events, { sessionId })
      : { completionSignal: "agent_settled", event: null };
    if (stageId === "A_CONFIG") {
      try {
        await waitForSessionFile(run.sessionFile, {
          timeoutMs: Math.min(5_000, Number(config.rpc?.requestTimeoutMs || 30_000)),
        });
      } catch (cause) {
        throw new SelfTestFailure({
          classification: "TEST_HARNESS",
          code: "PI_SESSION_FILE_MISSING",
          stageId,
          reason: `Pi 首轮稳定结束后 sessionFile 仍不可访问：${run.sessionFile}`,
          evidence: run.sessionFile,
          cause,
        });
      }
    }
    await auditSessionWriter(stageId, "post_stage_completion");
    const stageEndedAt = nowIso(now);
    const recordEnd = rpc.getRecords().length - 1;
    const stageRecords = rpc.getRecords().slice(recordStart);
    const rpcInspection = inspectRpcStageRecords(stageRecords, stageId);
    if (rpcInspection.errors.length) {
      const first = rpcInspection.errors[0];
      throw new SelfTestFailure({
        code: first.code,
        stageId,
        reason: first.reason,
        evidence: first.evidence,
      });
    }
    pipelineState = await readPipelineState(sessionDir);
    const stage = validatePipelineBoundary(pipelineState, stageId);
    const activeAttempt = stage.attempts.at(-1);
    const runtimeAgentStage = stageId === "A_CONFIG" || stageId === "B0_PREFLIGHT";
    const auditCandidates = runtimeAgentStage
      ? await readRuntimeAgentListAudits(sessionDir, stageId, { attempt: activeAttempt })
      : [];
    const runtimeAgents = inspectRuntimeAgentList(stageRecords, stageId, {
      auditCandidates,
      sessionId,
      attempt: activeAttempt,
    });
    const runtimeContract = runtimeAgentStage
      ? await validateRuntimeContractImpl({
          root,
          sessionDir,
          sessionId,
          stageId,
        })
      : null;
    if (stageId === "A_CONFIG") run.runtimeContract = runtimeContract;
    // A_CONFIG reaches its Gate before result.json exists. Its phase=a layout
    // is executed by the real silent confirmation immediately afterwards.
    const layout = stageId === "A_CONFIG"
      ? { ok: null, status: "deferred", phase: "a", reports: [], errors: [], warnings: [] }
      : await runLayouts(stageId, sessionDir, checkLayoutImpl, {
          debugB5Skipped: stageId === "B5_DESIGN" && runtimeEnv.HTML_REPORT_A_CONFIG_MODE === "fixed",
        });
    let agentPreflight = null;
    if (stageId === "B0_PREFLIGHT") agentPreflight = await preflightAgents(root);
    const dispatch = await validateDispatchPolicy({
      stageId,
      stageRecords,
      sessionDir,
      debugB5Skipped: stageId === "B5_DESIGN" && runtimeEnv.HTML_REPORT_A_CONFIG_MODE === "fixed",
      readJson,
      readDispatches,
    });
    const sourceAfter = await assertWorkspaceUnchanged(stageId, sourceBefore);
    const combinedWallClockDurationMs = elapsedMs(stageStartedAt, stageEndedAt);
    const wallClockDurationMs = stageId === "B3_RESEARCH"
      ? (elapsedMs(stage.startedAt, stage.completedAt) || Number(stage.executionDurationMs || 0))
      : combinedWallClockDurationMs;
    const executionDurationMs = Number(stage.executionDurationMs || 0);
    let editorObservation = null;
    if (stageId === "B3_RESEARCH") {
      const editor = stageFromState(pipelineState, "B25_EDITOR");
      const editorBudget = budgetFor("B25_EDITOR", config);
      const editorDurationMs = Number(editor.executionDurationMs || 0);
      const editorLayoutReport = layout.reports.find((report) => report?.phase === "b2") || layout.reports[0];
      editorObservation = {
        stageId: "B25_EDITOR",
        status: editor.status,
        startedAt: editor.startedAt,
        endedAt: editor.completedAt,
        wallClockDurationMs: elapsedMs(editor.startedAt, editor.completedAt) || editorDurationMs,
        executionDurationMs: editorDurationMs,
        attempt: editor.attempts.at(-1).number,
        budget: editorBudget,
        layout: {
          ok: editorLayoutReport?.ok === true,
          status: editorLayoutReport?.ok === true ? "pass" : "fail",
          phase: "b2",
          reports: editorLayoutReport ? [editorLayoutReport] : [],
          errors: editorLayoutReport?.errors || [],
          warnings: editorLayoutReport?.warnings || [],
        },
        sourceBefore: sourceBefore.sha256,
        sourceAfter: sourceAfter.sha256,
        anomalies: [],
      };
      observations.push(editorObservation);
    }
    const observation = {
      stageId,
      status: stage.status,
      startedAt: stageStartedAt,
      endedAt: stageEndedAt,
      wallClockDurationMs,
      combinedWallClockDurationMs,
      executionDurationMs,
      attempt: activeAttempt.number,
      budget,
      rpcStartIndex: recordStart,
      rpcEndIndex: recordEnd,
      agentSettled: Boolean(settled?.events?.some((event) => event?.type === "agent_settled")),
      completionSignal: completion.completionSignal,
      retryCount: rpcInspection.retryCount,
      toolCallCount: rpcInspection.toolCallCount,
      runtimeAgents,
      runtimeContract,
      dispatch,
      layout,
      agentPreflight,
      sourceBefore: sourceBefore.sha256,
      sourceAfter: sourceAfter.sha256,
      anomalies: [],
    };
    observations.push(observation);
    if (editorObservation) {
      await checkpoint("B25_EDITOR", {
        status: editorObservation.status,
        attempt: editorObservation.attempt,
        wallClockDurationMs: editorObservation.wallClockDurationMs,
        executionDurationMs: editorObservation.executionDurationMs,
        budget: editorObservation.budget,
        gate: { pipelineStatus: pipelineState.status, stageStatus: editorObservation.status, currentStage: pipelineState.currentStage },
        layout: editorObservation.layout,
        sourceBefore: sourceBefore.sha256,
        sourceAfter: sourceAfter.sha256,
      });
    }
    await checkpoint(stageId, {
      status: stage.status,
      attempt: activeAttempt.number,
      wallClockDurationMs,
      combinedWallClockDurationMs,
      executionDurationMs,
      budget,
      gate: { pipelineStatus: pipelineState.status, stageStatus: stage.status, currentStage: pipelineState.currentStage },
      layout,
      rpcStartIndex: recordStart,
      rpcEndIndex: recordEnd,
      runtimeAgents,
      runtimeContract,
      sourceBefore: sourceBefore.sha256,
      sourceAfter: sourceAfter.sha256,
    });
    const executionRegression = performanceFailure(stageId, executionDurationMs, budget, "执行");
    const wallRegression = performanceFailure(stageId, wallClockDurationMs, budget, "墙钟");
    const editorRegression = editorObservation
      ? performanceFailure("B25_EDITOR", editorObservation.executionDurationMs, editorObservation.budget, "执行") ||
        performanceFailure("B25_EDITOR", editorObservation.wallClockDurationMs, editorObservation.budget, "墙钟")
      : null;
    if (editorRegression || executionRegression || wallRegression) {
      const failure = editorRegression || executionRegression || wallRegression;
      if (editorRegression) editorObservation.anomalies.push(anomalyFrom(failure, "B25_EDITOR"));
      observation.anomalies.push(anomalyFrom(failure, stageId));
      await writeRuntimeFiles({ runDir, run, rpc, observations, checkpoints });
      throw failure;
    }
    return observation;
  }

  async function confirmAConfig() {
    const stageId = "A_CONFIRM";
    currentStage = stageId;
    const budget = budgetFor(stageId, config);
    const started = nowIso(now);
    const sourceBefore = normalizeSnapshot(await workspaceSnapshot(root));
    const recommendationsPath = join(sessionDir, "recommendations.json");
    try {
      assertFixedAConfigRecommendations(await readJson(recommendationsPath), sessionId);
    } catch (cause) {
      throw new SelfTestFailure({
        classification: "PRODUCT_CONTRACT",
        code: "A_CONFIRM_RECOMMENDATIONS_INVALID",
        stageId,
        reason: `A_CONFIRM recommendations.json 非法：${errorText(cause)}`,
        cause,
      });
    }
    let result;
    try {
      const confirmationOptions = {
        recommendationsPath,
        sessionId,
        startupTimeoutMs: Math.min(60_000, budget.hardMs),
        confirmTimeoutMs: budget.hardMs,
        totalTimeoutMs: budget.hardMs,
      };
      result = confirmMode === "browser"
        ? await confirmBrowser(confirmationOptions)
        : await confirmHttp(confirmationOptions);
    } catch (cause) {
      if (cause instanceof SelfTestFailure) throw cause;
      const allowed = new Set([
        "PRODUCT_CONTRACT",
        "TEST_HARNESS",
        "INFRASTRUCTURE",
        "PERFORMANCE_REGRESSION",
      ]);
      throw new SelfTestFailure({
        classification: allowed.has(cause?.classification) ? cause.classification : "TEST_HARNESS",
        code: String(cause?.code || "A_CONFIRM_FAILED"),
        stageId,
        reason: `A_CONFIRM 失败：${errorText(cause)}`,
        cause,
      });
    }
    const ended = nowIso(now);
    const sourceAfter = await assertWorkspaceUnchanged(stageId, sourceBefore);
    const duration = elapsedMs(started, ended);
    const observation = {
      stageId,
      status: "completed",
      startedAt: started,
      endedAt: ended,
      wallClockDurationMs: duration,
      executionDurationMs: duration,
      attempt: 1,
      budget,
      layout: result.layout,
      resultPath: result.resultPath,
      cardCount: result.cardCount,
      validationCount: result.validationCount,
      sourceBefore: sourceBefore.sha256,
      sourceAfter: sourceAfter.sha256,
      anomalies: [],
    };
    observations.push(observation);
    const configObservation = observations.find((item) => item.stageId === "A_CONFIG");
    if (configObservation) configObservation.layout = result.layout;
    const configCheckpoint = checkpoints.find((item) => item.stageId === "A_CONFIG");
    if (configCheckpoint) configCheckpoint.layout = result.layout;
    await checkpoint(stageId, {
      status: "completed",
      attempt: 1,
      wallClockDurationMs: duration,
      executionDurationMs: duration,
      budget,
      layout: result.layout,
      resultPath: result.resultPath,
      sourceBefore: sourceBefore.sha256,
      sourceAfter: sourceAfter.sha256,
    });
    const regression = performanceFailure(stageId, duration, budget, "墙钟");
    if (regression) {
      observation.anomalies.push(anomalyFrom(regression, "A_CONFIG"));
      throw regression;
    }
    return result;
  }

  try {
    if (extensionDiscoveryError) throw extensionDiscoveryError;
    rpc.start();
    const state = await rpc.getState({ id: "state-0" });
    if (state?.sessionId !== sessionId || !state?.sessionFile || !isAbsolute(state.sessionFile)) {
      throw new SelfTestFailure({
        classification: "TEST_HARNESS",
        code: "PI_SESSION_MISMATCH",
        stageId: "A_CONFIG",
        reason: `Pi get_state 与新 Session 不匹配：${JSON.stringify({ sessionId: state?.sessionId, sessionFile: state?.sessionFile })}`,
      });
    }
    run.piProcessId = rpc.processId;
    run.sessionFile = state.sessionFile;
    await auditSessionWriter("A_CONFIG", "startup");
    const commands = await rpc.getCommands({ id: "commands-0" });
    if (!commands.some((command) => command?.name === "skill:html-report")) {
      throw new SelfTestFailure({
        classification: "TEST_HARNESS",
        code: "HTML_REPORT_SKILL_NOT_LOADED",
        stageId: "A_CONFIG",
        reason: "Pi get_commands 未发现 skill:html-report；请检查项目信任和 Skill 注册",
      });
    }
    const extensionPaths = new Set((piSubagents?.extensions || []).map((path) => resolve(path)));
    const subagentsCommand = commands.find((command) =>
      command?.name === "subagents" && command?.sourceInfo?.path &&
      extensionPaths.has(resolve(command.sourceInfo.path))
    );
    if (!subagentsCommand) {
      throw new SelfTestFailure({
        classification: "TEST_HARNESS",
        code: "PI_SUBAGENTS_EXTENSION_NOT_LOADED",
        stageId: "A_CONFIG",
        reason: `Pi get_commands 未确认显式 pi-subagents 扩展入口：${[...extensionPaths].join(", ")}`,
      });
    }
    piSubagents.runtimeVerified = true;
    piSubagents.commandSource = resolve(subagentsCommand.sourceInfo.path);
    await rpc.request({ type: "set_auto_retry", enabled: false }, { id: "auto-retry-off" });
    run.provider = state.model?.provider || null;
    run.modelId = state.model?.id || null;
    run.thinkingLevel = state.thinkingLevel || null;
    await writeRuntimeFiles({ runDir, run, rpc, observations, checkpoints });

    const sequence = stageSequence(targetStage);
    for (const [index, stageId] of sequence.entries()) {
      await executeStage(stageId, index === 0 ? effectivePrompt : "继续");
      if (stageId === "A_CONFIG") await confirmAConfig();
    }
    run.status = "pass";
    run.stoppedStage = targetStage;
  } catch (error) {
    const anomaly = anomalyFrom(error, currentStage);
    run.status = anomaly.classification === "PERFORMANCE_REGRESSION" ? "performance_regression" : "failed";
    run.stoppedStage = anomaly.stageId || currentStage;
    run.anomaly = anomaly;
    run.firstAnomaly = anomaly;
    const observation = observations.find((item) => item.stageId === run.stoppedStage);
    if (observation && !observation.anomalies?.length) observation.anomalies = [anomaly];
    // Record the triggering failure before aborting. Assistant-aborted messages
    // emitted by the abort are consequences and must not predate the root cause.
    await safeAbort(rpc);
  } finally {
    run.endedAt = nowIso(now);
    try { pipelineState = await readPipelineState(sessionDir); } catch { /* startup may have failed before Gate init */ }
    await writeRuntimeFiles({ runDir, run, rpc, observations, checkpoints });
    try {
      await rpc.close({
        eofTimeoutMs: Number(config.close?.eofTimeoutMs || 5_000),
        termTimeoutMs: Number(config.close?.termTimeoutMs || 5_000),
        killTimeoutMs: Number(config.close?.killTimeoutMs || 5_000),
      });
    } catch (closeError) {
      if (run.status === "pass") {
        run.status = "failed";
        run.anomaly = anomalyFrom(new SelfTestFailure({
          classification: "TEST_HARNESS",
          code: "PI_CLOSE_FAILED",
          stageId: run.stoppedStage,
          reason: `Pi 无法安全关闭：${errorText(closeError)}`,
        }), run.stoppedStage);
        run.firstAnomaly = run.anomaly;
      }
    }
    await writeRuntimeFiles({ runDir, run, rpc, observations, checkpoints });
    report = reconcileSelfTestDiagnostics(await analyzeRun({
      run,
      pipelineState,
      rpcEvents: rpc.getRecords(),
      checkpoints,
      stageObservations: observations,
      performanceConfig: config,
      baseDir: runDir,
      generatedAt: run.endedAt,
      paths: {
        runDir,
        runMetadata: join(runDir, "run.json"),
        pipelineState: run.pipelineStatePath,
        checkpointsDir,
        rpcLog: run.rpcLogPath,
        stderrLog: run.stderrLogPath,
        htmlReportSession: sessionDir,
        piSessionJsonl: run.sessionFile,
        performanceConfig: configPath,
        reportJson: join(runDir, "self-test-report.json"),
        reportMarkdown: join(runDir, "self-test-report.md"),
      },
    }), run);
    await writeReport(report);
  }
  return { report, run, runDir, sessionDir, observations, checkpoints };
}

async function main() {
  try {
    const options = parseSelfTestArgs();
    if (options.help) return void process.stdout.write(usage());
    const result = await runHtmlReportSelfTest(options);
    const report = result.report;
    process.stdout.write([
      `结果：${report.result}`,
      `停止阶段：${report.session.stoppedStage || "—"}`,
      `Session ID：${report.session.id}`,
      `原因：${report.firstAnomaly?.reason || "无"}`,
      `报告：${report.artifacts.reportMarkdown}`,
      "",
    ].join("\n"));
    if (report.result !== "PASS") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`html-report-self-test: ${errorText(error)}\n${usage()}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await main();
