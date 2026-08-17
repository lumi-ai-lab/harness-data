#!/usr/bin/env node
/**
 * B2_WRITER 手动测试 setup 脚本
 *
 * 创建一个预置的 html-report session，模拟 A_CONFIG 和 B0_PREFLIGHT
 * 均已完成的状态，使 B2_WRITER 可以直接被触发测试。
 *
 * 每次运行自动清理旧 session 并重建，无需手动删除。
 *
 * 用法:
 *   node .agents/pi/skills/html-report/scripts/setup-b2-test.mjs
 *   node .agents/pi/skills/html-report/scripts/setup-b2-test.mjs \
 *     --result /abs/path/to/result.json
 *
 * `--result` 会把指定 confirmed result.json 拷进 session，并改写
 * session_id / result_path / recommendations_path；缺 userQuestion 时用
 * title 补上。落盘前按现行 Metric query 契约校验每一张卡。
 *
 * 然后启动 Pi:
 *   pi --session-id test-b2
 *
 * 在 Pi 中发送技能问题即可触发 B2_WRITER：
 *   /skill:html-report 生成客数(客流)和客单的平衡在哪个点最好? 用门店毛利额做评估, 以门店:101001为分析样本
 *
 * 扩展会检测到已有 Gate 状态（B2_WRITER running），直接开始逐卡派发
 * report-writer，调用 fetch-entry.mjs 全量取数。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { metricQueryFromCard } from "./metric-query-contract.mjs";
import { sanitizeCardId } from "./writer-return.mjs";

const projectRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const sessionId = "test-b2";
const sessionDir = join(projectRoot, ".harness", "state", "html-report", sessionId);

export function parseSetupB2Args(argv = process.argv.slice(2)) {
  const resultIndex = argv.indexOf("--result");
  if (resultIndex < 0) return { fixturePath: "" };
  const fixturePath = argv[resultIndex + 1];
  if (!fixturePath || fixturePath.startsWith("--")) {
    throw new Error("--result requires a path to a result.json file");
  }
  return { fixturePath: resolve(fixturePath) };
}

export function defaultB2Result({ sessionId: sid, sessionDir: dir, startDate, endDate }) {
  return {
    status: "confirmed",
    submitted_at: new Date().toISOString(),
    title: "区域客数与门店运营分析",
    userQuestion: "分析各区域的客数与门店运营表现",
    mode: "free",
    session_id: sid,
    result_path: join(dir, "result.json"),
    recommendations_path: join(dir, "recommendations.json"),
    already_validated: false,
    validation: [],
    cards: [
      {
        id: "regional-custNum-summary",
        title: "区域客数与门店运营汇总分析",
        headingLevel: 2,
        analysisFocus:
          "按管理区域分析来客数、开业门店数、签约门店数及流失率，识别客数与运营效率的区域差异。",
        chartType: "table",
        indicatorBizId: "retail",
        query: {
          request: {
            metrics: ["bf19CustNum", "openStores", "contractStores", "unknowLostRate"],
            statisticPolicy: "SUMMARY",
            time: { startDate, endDate },
            dimensions: ["manageAreaId"],
            filters: { manageAreaId: ["CN01", "CN04", "CN05", "CN07", "CN12"] },
            pageNo: 1,
            pageSize: 500,
          },
          comparisons: ["YOY", "MOM"],
        },
      },
    ],
  };
}

export function normalizeSessionResult(raw, { sessionId: sid, sessionDir: dir }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("result.json must be one JSON object");
  }
  const title = String(raw.title || "").trim();
  const userQuestion = String(raw.userQuestion || title).trim();
  return {
    ...raw,
    status: "confirmed",
    title: title || String(raw.title || ""),
    userQuestion,
    session_id: sid,
    result_path: join(dir, "result.json"),
    recommendations_path: join(dir, "recommendations.json"),
  };
}

export function validateSessionResult(result) {
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, errors: ["result.json must be one JSON object"] };
  }
  if (result.status !== "confirmed") errors.push(`result.status must be confirmed, got ${JSON.stringify(result.status)}`);
  if (!String(result.userQuestion || "").trim()) errors.push("result.json is missing userQuestion");
  if (!Array.isArray(result.cards) || !result.cards.length) {
    errors.push("result.cards must be a non-empty array");
    return { ok: false, errors };
  }
  const seen = new Set();
  result.cards.forEach((card, index) => {
    const label = `cards[${index}]`;
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const cardId = String(card.id || "").trim();
    if (!cardId) {
      errors.push(`${label}.id is required`);
      return;
    }
    try {
      if (sanitizeCardId(cardId) !== cardId) errors.push(`${label}.id must already be a safe path segment`);
    } catch {
      errors.push(`${label}.id is not a safe path segment`);
    }
    if (seen.has(cardId)) errors.push(`${label}.id duplicates ${cardId}`);
    seen.add(cardId);
    try {
      metricQueryFromCard(card);
    } catch (error) {
      errors.push(`${label} (${cardId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { ok: errors.length === 0, errors };
}

export function loadB2SessionResult({ fixturePath, sessionId: sid, sessionDir: dir, startDate, endDate }) {
  const raw = fixturePath
    ? JSON.parse(readFileSync(fixturePath, "utf8"))
    : defaultB2Result({ sessionId: sid, sessionDir: dir, startDate, endDate });
  const result = normalizeSessionResult(raw, { sessionId: sid, sessionDir: dir });
  const checked = validateSessionResult(result);
  if (!checked.ok) {
    const prefix = fixturePath ? `invalid --result ${fixturePath}` : "invalid default result.json";
    throw new Error(`${prefix}:\n${checked.errors.map((item) => `- ${item}`).join("\n")}`);
  }
  return result;
}

// 与 qdm-harness/index.ts 中 HTML_REPORT_RUNTIME_SOURCE_FILES 完全一致
const RUNTIME_SOURCE_FILES = [
  ".agents/pi/extensions/qdm-harness/index.ts",
  ".agents/pi/extensions/qdm-harness/gate-control.mjs",
  ".agents/pi/extensions/qdm-harness/extract-additional-context.mjs",
  ".agents/pi/extensions/report-writer-fetch/index.mjs",
  ".agents/pi/extensions/report-writer-fetch/lifecycle.mjs",
  ".agents/pi/extensions/report-researcher-guard/index.mjs",
  ".agents/pi/extensions/report-researcher-guard/guard.mjs",
  ".agents/pi/extensions/shared/subagent-structured-output-capture.mjs",
  ".agents/pi/extensions/report-reviewer-guard/index.mjs",
  ".agents/pi/extensions/report-reviewer-guard/guard.mjs",
  ".agents/pi/extensions/report-designer-guard/index.mjs",
  ".agents/pi/extensions/report-designer-guard/guard.mjs",
  ".agents/pi/skills/html-report/SKILL.md",
  ".agents/pi/agents/report-writer.md",
  ".agents/pi/agents/report-researcher.md",
  ".agents/pi/agents/report-reviewer.md",
  ".agents/pi/agents/report-designer.md",
  ".agents/pi/skills/html-report/agents/report-writer.md",
  ".agents/pi/skills/html-report/agents/report-researcher.md",
  ".agents/pi/skills/html-report/agents/report-reviewer.md",
  ".agents/pi/skills/html-report/agents/report-designer.md",
  ".agents/pi/skills/html-report-design/SKILL.md",
  ".agents/pi/skills/html-report-design/references/report-design-system.md",
  ".agents/pi/skills/html-report-design/assets/report-shell-starter.html",
  ".agents/pi/skills/html-report/scripts/stage-gate.mjs",
  ".agents/pi/skills/html-report/scripts/open-metric-cli-ui.mjs",
  ".agents/pi/skills/html-report/scripts/writer-return.mjs",
  ".agents/pi/skills/html-report/scripts/fetch-entry.mjs",
  ".agents/pi/skills/html-report/scripts/fetch-explore.mjs",
  ".agents/pi/skills/html-report/scripts/metric-cli-executor.mjs",
  ".agents/pi/skills/html-report/scripts/metric-query-contract.mjs",
  ".agents/pi/skills/html-report/scripts/research-contract.mjs",
  ".agents/pi/skills/html-report/scripts/metric-retry.mjs",
  ".agents/pi/skills/html-report/scripts/metric-timeout.mjs",
  ".agents/pi/skills/html-report/scripts/researcher-return.mjs",
  ".agents/pi/skills/html-report/scripts/submit-research-findings.mjs",
  ".agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs",
  ".agents/pi/skills/html-report/scripts/editor-plan-contract.mjs",
  ".agents/pi/skills/html-report/scripts/editor-plan.mjs",
  ".agents/pi/skills/html-report/scripts/finalize-editor-stage.mjs",
  ".agents/pi/skills/html-report/scripts/finalize-research-stage.mjs",
  ".agents/pi/skills/html-report/scripts/reviewer-return.mjs",
  ".agents/pi/skills/html-report/scripts/designer-return.mjs",
  ".agents/pi/skills/html-report/scripts/assemble-report.mjs",
  ".agents/pi/skills/html-report/scripts/compose-main.mjs",
  ".agents/pi/skills/html-report/scripts/quality-scan.mjs",
  ".agents/pi/skills/html-report/scripts/submit-review-scorecard.mjs",
  ".agents/pi/skills/html-report/scripts/write-verdict.mjs",
  ".agents/pi/skills/html-report/scripts/render-report.mjs",
  ".agents/pi/skills/html-report/scripts/report-content-binding.mjs",
  ".agents/pi/skills/html-report/scripts/design-artifact-contract.mjs",
  ".agents/pi/skills/html-report/scripts/compile-report-content.mjs",
  ".agents/pi/skills/html-report/scripts/compose-report.mjs",
  ".agents/pi/skills/html-report/scripts/capture-report.mjs",
  ".agents/pi/skills/html-report/scripts/finalize-design.mjs",
  ".agents/pi/skills/html-report/scripts/check-session-layout.mjs",
];

function main() {
// 0. 清理旧 session（自动，无需手动删除）
if (existsSync(sessionDir)) {
  rmSync(sessionDir, { recursive: true, force: true });
  console.log("🧹 已清理旧 .harness session");
}
// 同时清理 Pi 的 session JSONL 和目录，否则 Pi 会恢复旧的 paused/failed Gate 状态
const piSessionsDir = join(
  process.env.HOME || "",
  ".pi",
  "agent",
  "sessions",
  "--Users-pengmd-c-qdm-harenss-data-feat-skill-html-report--"
);
if (existsSync(piSessionsDir)) {
  for (const f of readdirSync(piSessionsDir)) {
    // Match both JSONL files and session directories: *_test-b2.jsonl, *_test-b2/
    if (f.includes(`_${sessionId}`) || f === sessionId) {
      rmSync(join(piSessionsDir, f), { recursive: true, force: true });
      console.log(`🧹 已清理 Pi session: ${f}`);
    }
  }
}

// 0.1 写入运行时契约标记（与 qdm-harness 扩展 writeHtmlReportRuntimeContract 一致）
function runtimeSourceDigest(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    const code = error?.code || "unreadable";
    return `!${code}`;
  }
}

function writeRuntimeContract() {
  const sources = Object.fromEntries(
    RUNTIME_SOURCE_FILES.map((rel) => [rel, runtimeSourceDigest(join(projectRoot, rel))])
  );
  const payload = RUNTIME_SOURCE_FILES.map((rel) => [rel, sources[rel]]);
  const fingerprint = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  const marker = {
    version: 1,
    producer: "qdm-harness",
    sessionId,
    fingerprint,
    sources,
    createdAt: new Date().toISOString(),
  };
  const contractPath = join(sessionDir, "debug", "runtime-contract.json");
  writeFileSync(contractPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log("✅ 运行时契约标记已写入 (runtime-contract.json)");
}

// 动态日期：当月1日至昨日（与固定推荐调试模式一致）
const now = new Date();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, "0");
const yesterday = new Date(now);
yesterday.setDate(yesterday.getDate() - 1);
const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
const startDate = `${year}-${month}-01`;

// 1. 创建 session 目录
mkdirSync(join(sessionDir, "debug"), { recursive: true });
console.log(`✅ Session 目录: ${sessionDir}`);

// 1.1 写入运行时契约标记（必须在 stage-gate init 之前，扩展启动时会校验）
writeRuntimeContract();

// 2. 写入测试 result.json（默认小卡，或 --result 指定的 confirmed 输入）
let resultJson;
try {
  const { fixturePath } = parseSetupB2Args();
  resultJson = loadB2SessionResult({
    fixturePath,
    sessionId,
    sessionDir,
    startDate,
    endDate: yesterdayStr,
  });
  if (fixturePath) console.log(`✅ 使用 --result ${fixturePath}`);
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

writeFileSync(join(sessionDir, "result.json"), `${JSON.stringify(resultJson, null, 2)}\n`);
console.log(
  `✅ result.json 已写入 (status=confirmed, ${resultJson.cards.length} card${resultJson.cards.length === 1 ? "" : "s"})`
);

// 3. 运行 stage-gate: init → start → finish → approve for A_CONFIG
const stageGate = join(
  projectRoot,
  ".agents",
  "pi",
  "skills",
  "html-report",
  "scripts",
  "stage-gate.mjs"
);

const run = (op, ...args) => {
  const result = spawnSync("node", [stageGate, op, "--session-dir", sessionDir, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`❌ stage-gate ${op} 失败:`, result.stderr || result.stdout);
    process.exit(1);
  }
  return JSON.parse(result.stdout);
};

console.log("⏳ 初始化 Gate (step mode)...");
const initResult = run("init", "--mode", "step");
if (!initResult.ok) {
  console.error("❌ init 失败:", initResult);
  process.exit(1);
}

console.log("⏳ 启动 A_CONFIG...");
run("start", "--stage", "A_CONFIG");

console.log("⏳ 完成 A_CONFIG...");
run("finish", "--stage", "A_CONFIG");

console.log("⏳ 批准 A_CONFIG → 进入 B0_PREFLIGHT...");
run("approve");

console.log("⏳ 完成 B0_PREFLIGHT...");
run("finish", "--stage", "B0_PREFLIGHT");

console.log("⏳ 批准 B0_PREFLIGHT → 进入 B2_WRITER...");
run("approve");

// 4. 验证当前状态
const statusResult = run("status");
const currentStage = statusResult.state?.currentStage;
const status = statusResult.state?.status;

if (currentStage !== "B2_WRITER") {
  console.error(`❌ 预期 B2_WRITER，实际 ${currentStage}（status=${status}）`);
  process.exit(1);
}

console.log(`✅ 当前阶段: ${currentStage} (status=${status})`);

// 5. 输出测试指南
const cardCount = resultJson.cards.length;
// 启动 + 预取 + Writer串行(~45s/卡) + compose-main
const estimatedSeconds = 15 + 60 + cardCount * 45 + 30;
// 40% 缓冲，向上取整到分钟
const recommendedTimeoutMs = Math.ceil(estimatedSeconds * 1.4 / 60) * 60 * 1000;

console.log("\n" + "=".repeat(60));
console.log("🧪 B2_WRITER 手动测试就绪！");
console.log("=".repeat(60));
console.log(`\nSession ID: ${sessionId}`);
console.log(`Session 目录: ${sessionDir}`);
console.log(`\n📌 启动 Pi（需 pi-subagents 扩展）：`);
console.log(`\n  pisub --session-id ${sessionId}\n`);
console.log("   或：pi --extension ~/.pi/agent/npm/node_modules/pi-subagents/src/extension/index.ts --session-id " + sessionId);
console.log("📌 非交互模式运行（--approve --print）：");
console.log(`\n  pisub --session-id ${sessionId} --approve --print \\`);
console.log('    "/skill:html-report 生成运营中心管理周例会报告，分析各区域经营表现"\n');
console.log(`📌 ⚠️ 超时提醒：${cardCount} 张卡预计 ~${Math.ceil(estimatedSeconds / 60)}min，`);
console.log(`   终端超时至少 ${recommendedTimeoutMs / 1000 / 60}min (${recommendedTimeoutMs}ms)，`);
console.log("   否则最后几张卡会被杀。实测 14 卡约 11min，含 40% 缓冲后建议如上。");
console.log("\n📌 扩展会检测到已有 B2_WRITER running 状态，先并行预取全部卡数据，");
console.log("   再逐卡串行派发 report-writer（缓存命中，跳过 CLI 等待）。");
console.log("   全部卡成功后扩展会自动 compose-main 写出 analysis/main.md，");
console.log("   并停在 B2_MAIN Gate。");
console.log("\n📌 如果 bin/qdm-metric-cli 不存在，取数会失败但流程结构仍可验证：");
console.log("   - Writer 返回 fetchStatus=failed");
console.log("   - 单卡失败不阻断");
console.log("   - B2 完成后 check-session-layout --phase writer 仍会检查产物结构");
console.log("\n📌 重新测试只需重跑此脚本（自动清理旧 session）：");
console.log(`  node ${join(projectRoot, ".agents", "pi", "skills", "html-report", "scripts", "setup-b2-test.mjs")}`);
console.log("  或带自定义 result.json：");
console.log(`  node ${join(projectRoot, ".agents", "pi", "skills", "html-report", "scripts", "setup-b2-test.mjs")} --result <abs/result.json>`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
