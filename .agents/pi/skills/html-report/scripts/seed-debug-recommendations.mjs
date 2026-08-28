#!/usr/bin/env node
/**
 * Seed the fixed A_CONFIG recommendation used while debugging the HTML flow.
 *
 * This intentionally contains no recall, Spec lookup, or model decision. It
 * gives the existing local report builder a known-good card so Phase A can be
 * exercised independently from recommendation quality.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateShape } from "./validate-config.mjs";

export const FIXED_RECOMMENDATION_PRESET = "store-101001-customer-ticket-profit";
export const FIXED_DEBUG_MARKER_RELATIVE_PATH = ["debug", "fixed-recommendation.json"];

function formatDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Use the normal Phase-A default window without asking the model to choose it. */
export function defaultFixedDateRange(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() - 1);
  if (today.getDate() === 1) {
    endDate.setDate(0);
  }
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  return { startDate: formatDate(startDate), endDate: formatDate(endDate) };
}

export function sanitizeSessionId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function fixedRecommendations({ sessionId, userQuestion = "", now = new Date() }) {
  const safeSessionId = sanitizeSessionId(sessionId);
  if (!safeSessionId) throw new Error("--session-id is required");
  const { startDate, endDate } = defaultFixedDateRange(now);
  return {
    version: 1,
    sessionId: safeSessionId,
    mode: "free",
    userQuestion: userQuestion.trim() || "HTML 推荐配置调试：使用固定门店101001样本卡。",
    warnings: [
      "调试固定推荐：已跳过模型、Spec recall 与推荐生成；仅用于验证 HTML 确认及后续报告流水线。",
      "预设范围为门店101001、按日、来客数+客单价+门店毛利率+门店毛利额；日期仍采用当月1日至昨日。",
    ],
    cards: [
      {
        id: "debug-store-balance-001",
        title: "门店101001 客数-客单-毛利额 日度平衡分析（调试预设）",
        analysisFocus:
          "调试固定卡：以门店101001为样本，按日展示来客数、客单价、门店毛利率和门店毛利额，验证 HTML 配置确认、数据传递及后续报告章节链路。该预设不代表对当前用户问题的推荐结论。",
        chartType: "table",
        indicatorFieldList: ["custNum", "perCustAmt", "profitLostRate", "profitAmt"],
        aggDimUniqueCodeList: ["incDate"],
        startDate,
        endDate,
        storeCollectType: 2,
        filters: [
          {
            type: "DIMENSION",
            dimUniqueCode: "storeId",
            values: ["101001"],
          },
        ],
      },
    ],
  };
}

export async function seedFixedRecommendations({ root, sessionId, userQuestion, now }) {
  const safeSessionId = sanitizeSessionId(sessionId);
  const recommendations = fixedRecommendations({ sessionId: safeSessionId, userQuestion, now });
  const errors = validateShape(recommendations);
  if (errors.length) throw new Error(`fixed debug recommendation is invalid: ${errors.join("; ")}`);
  const sessionDir = join(resolve(root), ".harness", "state", "html-report", safeSessionId);
  const recommendationsPath = join(sessionDir, "recommendations.json");
  const debugDir = join(sessionDir, ...FIXED_DEBUG_MARKER_RELATIVE_PATH.slice(0, -1));
  const debugMarkerPath = join(sessionDir, ...FIXED_DEBUG_MARKER_RELATIVE_PATH);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(recommendationsPath, `${JSON.stringify(recommendations, null, 2)}\n`, "utf8");
  await mkdir(debugDir, { recursive: true });
  await writeFile(debugMarkerPath, `${JSON.stringify({
    version: 1,
    producer: "seed-debug-recommendations.mjs",
    sessionId: safeSessionId,
    preset: FIXED_RECOMMENDATION_PRESET,
    b5Design: "skip",
  }, null, 2)}\n`, "utf8");
  return { sessionDir, recommendationsPath, debugMarkerPath, recommendations };
}

function readArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
    } else {
      flags.add(key);
    }
  }
  return { values, flags };
}

async function main() {
  const { values, flags } = readArgs(process.argv.slice(2));
  const root = resolve(new URL("../../../../../", import.meta.url).pathname);
  const seeded = await seedFixedRecommendations({
    root,
    sessionId: values["session-id"],
    userQuestion: values.question || "",
  });
  let serverUrl = null;
  if (flags.has("open")) {
    const server = join(root, ".agents", "pi", "skills", "html-report", "scripts", "server.mjs");
    const result = spawnSync(
      process.execPath,
      [server, "--config", seeded.recommendationsPath, "--detach", "--open", "--session-id", seeded.recommendations.sessionId],
      { cwd: root, encoding: "utf8", env: process.env }
    );
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "failed to start fixed recommendation server").trim());
    }
    serverUrl = /https?:\/\/[^\s]+/.exec(result.stdout || "")?.[0] || null;
  }
  process.stdout.write(
    `${JSON.stringify({
      preset: FIXED_RECOMMENDATION_PRESET,
      sessionDir: seeded.sessionDir,
      recommendationsPath: seeded.recommendationsPath,
      debugMarkerPath: seeded.debugMarkerPath,
      serverUrl,
      cardCount: seeded.recommendations.cards.length,
    })}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
