#!/usr/bin/env node
/**
 * B0 手动测试 setup 脚本
 *
 * 创建一个预置的 html-report session，模拟 A_CONFIG 已完成的状态，
 * 使 B0_PREFLIGHT 可以直接被触发测试。
 *
 * 用法:
 *   node .agents/pi/skills/html-report/scripts/setup-b0-test.mjs
 *
 * 然后启动 Pi:
 *   PI_SESSION_ID=<脚本输出的 session-id> HTML_REPORT_TEST_B0=1 pi --skill html-report
 *
 * 在 Pi 中回复「继续」即可触发 B0 确定性预检。
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(new URL("../../../../../", import.meta.url).pathname);
const sessionId = `test-b0-${Date.now()}`;
const sessionDir = join(projectRoot, ".harness", "state", "html-report", sessionId);

// 1. 创建 session 目录
mkdirSync(join(sessionDir, "debug"), { recursive: true });
console.log(`✅ Session 目录: ${sessionDir}`);

// 2. 写入测试 result.json (模拟 A_CONFIG 确认后的产物)
const resultJson = {
  version: 1,
  sessionId,
  mode: "free",
  userQuestion: "门店101001的客流和客单价趋势如何？",
  title: "门店101001客流与客单价分析",
  status: "confirmed",
  confirmedAt: new Date().toISOString(),
  cards: [
    {
      id: "test-card-001",
      title: "门店101001客流与客单价日趋势",
      analysisFocus: "分析门店101001的客流和客单价日趋势，评估是否有异常波动",
      chartType: "table",
      indicatorFieldList: ["custNum", "perCustAmt"],
      aggDimUniqueCodeList: ["incDate"],
      startDate: "2026-08-01",
      endDate: "2026-08-10",
      storeCollectType: 2,
      filters: [
        { type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] },
      ],
      requestBody: {
        indicatorFieldList: ["custNum", "perCustAmt"],
        aggDimUniqueCodeList: ["incDate"],
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        storeCollectType: 2,
        filters: [
          { type: "DIMENSION", dimUniqueCode: "storeId", values: ["101001"] },
        ],
      },
    },
  ],
  validation: [],
};

writeFileSync(join(sessionDir, "result.json"), JSON.stringify(resultJson, null, 2));
console.log("✅ result.json 已写入 (status=confirmed, 1 card)");

// 3. 运行 stage-gate: init → start → finish for A_CONFIG
const stageGate = join(
  projectRoot, ".agents", "pi", "skills", "html-report", "scripts", "stage-gate.mjs",
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

console.log("⏳ 初始化 Gate (A_CONFIG)...");
const initResult = run("init", "--mode", "step");
if (!initResult.ok) { console.error("❌ init 失败:", initResult); process.exit(1); }

console.log("⏳ 启动 A_CONFIG...");
const startResult = run("start", "--stage", "A_CONFIG");
if (!startResult.ok) { console.error("❌ start 失败:", startResult); process.exit(1); }

console.log("⏳ 完成 A_CONFIG...");
const finishResult = run("finish", "--stage", "A_CONFIG");
if (!finishResult.ok) { console.error("❌ finish 失败:", finishResult); process.exit(1); }

console.log("✅ A_CONFIG 已完成 (awaiting_approval → B0_PREFLIGHT)");

// 4. 输出测试指南
console.log("\n" + "=".repeat(60));
console.log("🧪 B0 手动测试就绪！");
console.log("=".repeat(60));
console.log(`\nSession ID: ${sessionId}`);
console.log(`Session 目录: ${sessionDir}`);
console.log(`\n📌 启动 Pi 命令:`);
console.log(`\n  PI_SESSION_ID=${sessionId} HTML_REPORT_TEST_B0=1 pi --skill html-report\n`);
console.log("📌 在 Pi 中回复「继续」即可触发 B0 确定性预检。");
console.log("📌 B0 会通过 pi-subagents 事件桥验收 4 个 report-* agent，");
console.log("   然后执行 check-session-layout --phase a，最后 finish/fail B0。");
console.log("📌 B0 完成后，Gate 会显示 awaiting_approval 状态，");
console.log("   再次回复「继续」才会进入 B2_WRITER（但 B2 尚未实现）。");
console.log("\n📌 如需重新测试，删除 session 目录后重跑此脚本：");
console.log(`  rm -rf ${sessionDir}`);
console.log(`  node ${join(projectRoot, ".agents", "pi", "skills", "html-report", "scripts", "setup-b0-test.mjs")}`);
