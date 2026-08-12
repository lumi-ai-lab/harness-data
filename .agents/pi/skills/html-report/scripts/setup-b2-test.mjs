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
import { spawnSync } from "node:child_process";

const projectRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const sessionId = "test-b2";
const sessionDir = join(projectRoot, ".harness", "state", "html-report", sessionId);

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

// 0. 清理旧 session（自动，无需手动删除）
if (existsSync(sessionDir)) {
  rmSync(sessionDir, { recursive: true, force: true });
  console.log("🧹 已清理旧 .harness session");
}
// 同时清理 Pi 的 session JSONL，否则 Pi 会恢复旧的 paused/failed Gate 状态
const piSessionsDir = join(
  process.env.HOME || "",
  ".pi",
  "agent",
  "sessions",
  "--Users-pengmd-c-qdm-harenss-data-feat-skill-html-report--"
);
if (existsSync(piSessionsDir)) {
  for (const f of readdirSync(piSessionsDir)) {
    if (f.includes(`_${sessionId}.jsonl`) || f === sessionId) {
      rmSync(join(piSessionsDir, f), { force: true });
      console.log(`🧹 已清理 Pi session JSONL: ${f}`);
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

// 2. 写入测试 result.json (模拟 A_CONFIG 确认后的产物)
//    使用与固定推荐调试模式一致的卡片配置
const resultJson = {
  status: "confirmed",
  submitted_at: new Date().toISOString(),
  title: "门店101001 客数与客单价平衡点分析",
  mode: "free",
  session_id: sessionId,
  result_path: join(sessionDir, "result.json"),
  recommendations_path: join(sessionDir, "recommendations.json"),
  already_validated: false,
  validation: [],
  cards: [
    {
      id: "balance-custNum-perCustAmt-001",
      title: "门店101001 客数与客单价平衡点分析（逐日趋势）",
      headingLevel: 2,
      analysisFocus:
        "以门店101001为样本，按日分析来客数、客单价与门店毛利额的关系，寻找毛利额最优的客数-客单价平衡点。",
      chartType: "table",
      statisticPolicy: "SUMMARY",
      indicatorBizId: "retail",
      query: {
        request: {
          metrics: ["custNum", "perCustAmt", "profitAmt", "profitLostRate"],
          statisticPolicy: "SUMMARY",
          time: { startDate, endDate: yesterdayStr },
          dimensions: ["incDate"],
          filters: { storeId: ["101001"] },
          pageNo: 1,
          pageSize: 500,
        },
        comparisons: [],
      },
    },
  ],
};

writeFileSync(join(sessionDir, "result.json"), JSON.stringify(resultJson, null, 2));
console.log(`✅ result.json 已写入 (status=confirmed, 1 card, ${startDate} ~ ${yesterdayStr})`);

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
console.log("\n" + "=".repeat(60));
console.log("🧪 B2_WRITER 手动测试就绪！");
console.log("=".repeat(60));
console.log(`\nSession ID: ${sessionId}`);
console.log(`Session 目录: ${sessionDir}`);
console.log(`\n📌 启动 Pi（需 pi-subagents 扩展）：`);
console.log(`\n  pisub --session-id ${sessionId}\n`);
console.log("   或：pi --extension ~/.pi/agent/npm/node_modules/pi-subagents/src/extension/index.ts --session-id " + sessionId);
console.log("📌 在 Pi 中发送技能问题：");
console.log('  /skill:html-report 生成客数(客流)和客单的平衡在哪个点最好? 用门店毛利额做评估, 以门店:101001为分析样本');
console.log("\n📌 扩展会检测到已有 B2_WRITER running 状态，直接开始逐卡派发");
console.log("   report-writer 子代理。Writer 会调用 fetch-entry.mjs 全量取数，");
console.log("   产出 entry.json + entry.meta.json。");
console.log("\n📌 如果 bin/qdm-metric-cli 不存在，取数会失败但流程结构仍可验证：");
console.log("   - Writer 返回 fetchStatus=failed");
console.log("   - 单卡失败不阻断");
console.log("   - B2 完成后 check-session-layout --phase writer 仍会检查产物结构");
console.log("\n📌 重新测试只需重跑此脚本（自动清理旧 session）：");
console.log(`  node ${join(projectRoot, ".agents", "pi", "skills", "html-report", "scripts", "setup-b2-test.mjs")}`);
