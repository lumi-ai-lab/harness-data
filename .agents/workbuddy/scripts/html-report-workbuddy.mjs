#!/usr/bin/env node
/**
 * WorkBuddy 薄入口 —— html-report Stage Runner。
 *
 * 只做转发，不建第二状态源：start/status/advance/approve/retry/cancel/stop 全部转调
 * scripts/html-report-stage-runner.mjs 的导出函数；Gate 状态与人工 Gate 一律来自
 * Runner 读取的 stage-gate 状态文件，本入口只展示、不写入任何状态。
 *
 * 阶段 A 默认打开 qdm-metric-cli ui（对齐 PI html-report 流水线）：用户在该页面搭卡
 * 点「保存」写 result.json，回话回复「继续」后再 advance。`--phase-a agent` 可动态
 * 切换回「agent 解析问题并构建 result.json」的旧路径（调试/自动化用）。
 *
 * 命令面：
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs start   --session <id> [--phase-a ui|agent] [--question <原问题>]
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs status  --session <id> [--format text|json]
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs advance --session <id>
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs approve --session <id>
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs retry   --session <id> --task <cardId>
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs cancel  --session <id>
 *   node agents/workbuddy/scripts/html-report-workbuddy.mjs stop    --session <id>
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
import { openMetricCliUi, stopMetricCliUi } from "../../../packages/harness-runtime-node/src/open-metric-cli-ui.mjs";

export const WORKBUDDY_COMMANDS = Object.freeze(["start", "status", "advance", "approve", "retry", "cancel", "stop"]);

const USAGE = [
  "用法：",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs start   --session <id> [--phase-a ui|agent] [--question <原问题>]",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs status  --session <id> [--format text|json]",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs advance --session <id>",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs approve --session <id>",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs retry   --session <id> --task <cardId>",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs cancel  --session <id>",
  "  node agents/workbuddy/scripts/html-report-workbuddy.mjs stop    --session <id>",
  "  --phase-a：默认 ui（打开 qdm-metric-cli ui 让用户保存 result.json，对齐 PI）；agent 表示本会话构建 result.json。",
  "  --question：阶段 A 原问题，持久化到 <session>/debug/a-config-question.json，供 result.json 缺 userQuestion 时回填。",
  "可选：--root <projectRoot>（默认自动探测）。全部命令转调 Runner，Gate 状态由 Runner 唯一 owner。",
].join("\n");

function parsePhaseA(value) {
  const v = String(value || "ui").trim().toLowerCase();
  if (v !== "ui" && v !== "agent") {
    return { ok: false, error: `--phase-a 仅支持 ui|agent，收到 ${JSON.stringify(value)}` };
  }
  return { ok: true, value: v };
}

function cliValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : "";
}

/** 从 Runner 返回的 Gate state 中挑出等待批准的人工 Gate，附加在 status 摘要尾部。 */
function humanGateHint(state) {
  if (!state) return "";
  const entry = Object.entries(state.stages || {}).find(([, stage]) => stage.status === "awaiting_approval");
  if (!entry) return "";
  if (entry[0] === "B2_MAIN") return "";
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
    case "start": {
      const phaseA = parsePhaseA(cliValue(argv, "--phase-a"));
      if (!phaseA.ok) return { ok: false, exitCode: 2, error: phaseA.error };
      output = await start(projectRoot, sessionId);
      if (!output.ok) break;
      if (phaseA.value === "ui") {
        const question = cliValue(argv, "--question");
        try {
          const opened = await openMetricCliUi({
            projectRoot,
            sessionId,
            userQuestion: question,
            open: true,
            detach: true,
            watchPid: "none",
          });
          const uiNote = opened.serverUrl
            ? `qdm-metric-cli ui 已打开：${opened.serverUrl}\n请在 UI 里搭卡并点击「保存」写 result.json；回到会话回复「继续」后再运行 advance --session ${sessionId}。`
            : `qdm-metric-cli ui 未获取到监听地址（marker：${opened.markerPath}）。`;
          output = { ...output, message: `${output.message}\n${uiNote}` };
        } catch (error) {
          const message = `${error?.message || error}`;
          const hint = /AUTHORIZATION_FAILED/.test(message)
            ? "\n（提示：qdm-metric-cli ui 需要 QDM_AUTH_BLOB 提供 qdm.admin 权限；见 html-report skill 阶段 A。）"
            : "";
          output = { ok: false, error: `启动 qdm-metric-cli ui 失败：${message}${hint}` };
        }
      }
      break;
    }
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
    case "stop": {
      const stopped = await stopMetricCliUi({ projectRoot, sessionId });
      output = {
        ok: true,
        message: stopped.stopped
          ? `已停止 qdm-metric-cli ui（pid=${stopped.pid || 0}，cliPid=${stopped.cliPid || 0}）。`
          : `没有正在运行的 qdm-metric-cli ui（session ${sessionId} 无 marker）。`,
      };
      break;
    }
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
