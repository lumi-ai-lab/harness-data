import fs from "node:fs";
import path from "node:path";

import { run } from "../lib/exec.js";
import {
  ROOT_CONTEXT_ERROR_CODES,
  RootContextError,
  publicRootContext,
  resolveRootContext,
} from "../lib/root-context.js";
import { assertWorkspaceAllowed } from "../lib/workspace-policy.js";

const REPORT_COMMANDS = new Set(["start", "status", "advance", "approve", "retry", "cancel", "stop"]);

export async function reportCommand(options = {}, io = process) {
  const action = String(options._?.[0] || "").trim().toLowerCase();
  if (!REPORT_COMMANDS.has(action)) {
    throw new Error(`usage: qdm-harness report <${[...REPORT_COMMANDS].join("|")}> --session <id>`);
  }
  const context = resolveRootContext(options, { env: io.env || process.env, requirePluginRoot: true });
  const sessionId = String(options.sessionId || options.session || context.sessionId || "").trim();
  if (!sessionId) throw new Error(`report ${action} requires --session <id>`);
  if (action !== "status" && (!context.workspaceRoot || context.capabilities?.canWriteWorkspace === false)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED, `report ${action} requires workspaceRoot`);
  }
  if (context.workspaceRoot) assertWorkspaceAllowed(context);

  const runner = findRunner(context, options);
  const args = [action, "--session", sessionId];
  if (context.pluginRoot) args.push("--plugin-root", context.pluginRoot);
  if (context.dataRoot) args.push("--data-root", context.dataRoot);
  if (context.secretRoot) args.push("--secret-root", context.secretRoot);
  if (context.workspaceRoot) args.push("--workspace-root", context.workspaceRoot);
  const effectiveStateRoot = context.stateRoot || path.join(context.dataRoot, "state");
  if (effectiveStateRoot) args.push("--state-root", effectiveStateRoot);
  if (context.secretRef) args.push("--secret-ref", JSON.stringify(context.secretRef));
  if (options.phaseA) args.push("--phase-a", String(options.phaseA));
  if (options.question) args.push("--question", String(options.question));
  if (options.task) args.push("--task", String(options.task));
  if (options.format) args.push("--format", String(options.format));

  const env = {
    ...(io.env || process.env),
    HARNESS_PLUGIN_ROOT: context.pluginRoot,
    HARNESS_DATA_ROOT: context.dataRoot,
    HARNESS_SECRET_ROOT: context.secretRoot,
    HARNESS_STATE_ROOT: effectiveStateRoot,
    HARNESS_WORKSPACE_ROOT: context.workspaceRoot,
    HARNESS_HOST: context.host,
  };
  const result = await run(process.execPath, [runner, ...args], {
    cwd: context.workspaceRoot || context.pluginRoot,
    env,
    allowFailure: true,
  });
  const report = {
    ok: result.code === 0,
    action,
    sessionId,
    context: publicRootContext(context),
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (options.json) {
    (io.stdout || process.stdout).write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (result.stdout) (io.stdout || process.stdout).write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    if (result.stderr) (io.stderr || process.stderr).write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
  if (!report.ok && io === process) process.exitCode = result.code || 1;
  return report;
}

function findRunner(context, options) {
  const candidates = [
    options.runner,
    path.join(context.pluginRoot, "agents", "workbuddy", "scripts", "html-report-workbuddy.mjs"),
    path.join(context.pluginRoot, ".agents", "workbuddy", "scripts", "html-report-workbuddy.mjs"),
  ].filter(Boolean).map((value) => path.resolve(String(value)));
  const runner = candidates.find((value) => fs.existsSync(value));
  if (!runner) {
    throw new RootContextError(
      ROOT_CONTEXT_ERROR_CODES.SETUP_REQUIRED,
      "html-report runner is unavailable; install the WorkBuddy runtime or pass --runner <path>",
    );
  }
  return runner;
}
