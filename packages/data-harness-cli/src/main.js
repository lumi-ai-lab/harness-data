#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAuthzHook } from "./commands/authz-hook.js";
import { runContext } from "./commands/context.js";
import { runInjectTemplate } from "./commands/inject-template.js";
import { runPosttool } from "./commands/posttool.js";
import { runShow } from "./commands/show.js";
import { runStage } from "./commands/stage.js";
import { runWikis } from "./commands/wikis.js";
import { ExitError, isExitError } from "./lib/exit.js";
import { findRoot } from "./lib/harness.js";

export const USAGE = "usage: data-harness-cli <wikis|context|stage|inject-template|posttool|authz-hook|show>";

export function rootStart(env = process.env) {
  if (env.CODEBUDDY_PROJECT_DIR) return env.CODEBUDDY_PROJECT_DIR;
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  return ".";
}

export function isAgentHookFormat(format) {
  switch (format) {
    case "claude-hook":
    case "codex-hook":
    case "agent-hook":
    case "workbuddy-hook":
      return true;
    default:
      return false;
  }
}

/**
 * @param {string[]} argv
 * @param {{ stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream, stdin: NodeJS.ReadableStream, env?: NodeJS.ProcessEnv }} [io]
 */
export async function run(argv = process.argv.slice(2), io = process) {
  if (argv.length < 1) {
    throw new ExitError(USAGE);
  }
  if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    io.stdout.write(`${USAGE}\n`);
    return;
  }

  let root;
  try {
    root = findRoot(rootStart(io.env || process.env));
  } catch (error) {
    throw new ExitError(`cannot find harness root: ${error.message || error}`);
  }

  switch (argv[0]) {
    case "authz-hook":
      return runAuthzHook(root, argv.slice(1), io);
    case "wikis":
      return runWikis(root, argv.slice(1), io);
    case "context":
      return runContext(root, argv.slice(1), io);
    case "posttool":
      return runPosttool(root, argv.slice(1), io);
    case "inject-template":
      return runInjectTemplate(argv.slice(1), io);
    case "stage":
      return runStage(argv.slice(1), io);
    case "show":
      return runShow(root, argv.slice(1), io);
    default:
      throw new ExitError(`unknown command: ${argv[0]}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await run(argv);
  } catch (error) {
    if (isExitError(error)) {
      if (!error.silent && error.message) {
        process.stderr.write(`${error.message}\n`);
      }
      process.exitCode = error.code;
      return;
    }
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  await main();
}
