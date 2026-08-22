#!/usr/bin/env node
/**
 * WorkBuddy 薄入口 —— html-report Stage Runner。
 *
 * 只做转发，不建第二状态源：start/status/advance/approve/retry/cancel 全部转调
 * scripts/html-report-stage-runner.mjs 的导出函数；Gate 状态与人工 Gate 一律来自
 * Runner 读取的 stage-gate 状态文件，本入口只展示、不写入任何状态。
 *
 * 命令面：
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs start   --session <id>
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs status  --session <id> [--format text|json]
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs advance --session <id>
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs approve --session <id>
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs retry   --session <id> --task <cardId>
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs cancel  --session <id>
 * 可选：--root <projectRoot>（默认自动探测）。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  advance,
  approveGate,
  cancel,
  retryTask,
  resolveProjectRoot,
  start,
  status,
} from "./html-report-stage-runner.mjs";

export const WORKBUDDY_COMMANDS = Object.freeze(["start", "status", "advance", "approve", "retry", "cancel"]);

const USAGE = [
  "用法：",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs start   --session <id>",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs status  --session <id> [--format text|json]",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs advance --session <id>",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs approve --session <id>",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs retry   --session <id> --task <cardId>",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs cancel  --session <id>",
  "可选：--root <projectRoot>（默认自动探测）。全部命令转调 Runner，Gate 状态由 Runner 唯一 owner。",
].join("\n");

function cliValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : "";
}

/** 从 Runner 返回的 Gate state 中挑出等待批准的人工 Gate，附加在 status 摘要尾部。 */
function humanGateHint(state) {
  if (!state) return "";
  const entry = Object.entries(state.stages || {}).find(([, stage]) => stage.status === "awaiting_approval");
  if (!entry) return "";
  return `\n人工 Gate：${entry[0]} 等待批准 —— 运行 approve --session <id> 通过并继续推进。`;
}

export async function runWorkbuddy(argv = []) {
  const command = argv[0];
  if (!command || command === "-h" || command === "--help") {
    return { ok: true, usage: USAGE };
  }
  if (!WORKBUDDY_COMMANDS.includes(command)) {
    return { ok: false, exitCode: 2, error: `未知命令 ${JSON.stringify(command)}；WorkBuddy 支持：${WORKBUDDY_COMMANDS.join(" / ")}` };
  }
  const sessionId = cliValue(argv, "--session") || cliValue(argv, "--session-id");
  const rootArg = cliValue(argv, "--root");
  const taskId = cliValue(argv, "--task");
  const format = cliValue(argv, "--format") || "text";
  if (!sessionId) {
    return { ok: false, exitCode: 2, error: `命令 ${command} 需要 --session <id>` };
  }
  let projectRoot;
  try {
    projectRoot = resolveProjectRoot(rootArg);
  } catch (error) {
    return { ok: false, exitCode: 2, error: error?.message || String(error) };
  }
  let output;
  switch (command) {
    case "start":
      output = await start(projectRoot, sessionId);
      break;
    case "status":
      output = status(projectRoot, sessionId, { format });
      break;
    case "advance":
      output = await advance(projectRoot, sessionId);
      break;
    case "approve":
      output = await approveGate(projectRoot, sessionId);
      break;
    case "retry":
      output = await retryTask(projectRoot, sessionId, taskId);
      break;
    case "cancel":
      output = cancel(projectRoot, sessionId);
      break;
    default:
      output = { ok: false, error: "unreachable" };
  }
  let message = output.message || JSON.stringify(output);
  if (command === "status" && output.ok && format === "text") {
    message = `${message}${humanGateHint(output.state)}`;
  }
  return { ok: Boolean(output.ok), exitCode: output.ok ? 0 : 1, message, state: output.state, error: output.ok ? "" : output.error };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runWorkbuddy(process.argv.slice(2));
  if (result.ok && result.usage) {
    process.stdout.write(`${result.usage}\n`);
  } else if (result.ok) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.error || result.message || "失败"}\n`);
    process.exitCode = result.exitCode || 1;
  }
}
