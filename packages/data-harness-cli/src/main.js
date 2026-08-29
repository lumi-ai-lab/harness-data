#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAuthzHook } from "./commands/authz-hook.js";
import { runContext } from "./commands/context.js";
import { runInjectTemplate } from "./commands/inject-template.js";
import { runPosttool } from "./commands/posttool.js";
import { runPaths } from "./commands/paths.js";
import { runShow } from "./commands/show.js";
import { runStage } from "./commands/stage.js";
import { runWikis } from "./commands/wikis.js";
import { ExitError, isExitError } from "./lib/exit.js";
import { findLegacyRoot } from "./lib/harness.js";
import {
  RootContextError,
  parseRootContextArgs,
  resolveRootContext,
} from "./lib/root-context.js";

export const USAGE = "usage: data-harness-cli [root-options] <wikis|context|stage|inject-template|posttool|authz-hook|show|paths>";

export function rootStart(env = process.env) {
  if (env.HARNESS_WORKSPACE_ROOT) return env.HARNESS_WORKSPACE_ROOT;
  if (env.CODEX_WORKSPACE_ROOT) return env.CODEX_WORKSPACE_ROOT;
  if (env.CODEBUDDY_PROJECT_DIR) return env.CODEBUDDY_PROJECT_DIR;
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  if (env.PWD) return env.PWD;
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

  let invocation;
  try {
    invocation = parseRootContextArgs(argv);
  } catch (error) {
    if (error instanceof RootContextError) {
      throw new ExitError(`${error.code}: ${error.message}`, { code: 2 });
    }
    throw error;
  }
  if (!invocation.command) throw new ExitError(USAGE, { code: 2 });

  const env = io.env || process.env;
  let root = "";
  let context = null;
  try {
    const needsStructuredContext = invocation.command === "paths";
    context = resolveRootContext({ contextFile: invocation.contextFile, explicit: invocation.fields, env });
    if (needsStructuredContext && !context) {
      throw new RootContextError("QDM_CONTEXT_INVALID", "paths requires a structured Root Context");
    }
    if (context) {
      // Existing command handlers still use a single resource root. Until the
      // owner-aware PathResolver lands, pluginRoot is the explicit compatibility
      // root; data/workspace/state/secret paths remain available via `paths`.
      root = context.pluginRoot;
    } else {
      root = findLegacyRoot(rootStart(env));
    }
  } catch (error) {
    if (error instanceof RootContextError) {
      throw new ExitError(`${error.code}: ${error.message}`, { code: 2 });
    }
    throw new ExitError(`cannot find harness root: ${error.message || error}`);
  }

  try {
    switch (invocation.command) {
      case "authz-hook":
        return await runAuthzHook(root, invocation.commandArgs, io, context);
      case "wikis":
        return await runWikis(root, invocation.commandArgs, io, context);
      case "context":
        return await runContext(root, invocation.commandArgs, io, context);
      case "posttool":
        return await runPosttool(root, invocation.commandArgs, io, context);
      case "inject-template":
        return await runInjectTemplate(invocation.commandArgs, io, context);
      case "stage":
        return await runStage(invocation.commandArgs, io, context);
      case "show":
        return await runShow(root, invocation.commandArgs, io, context);
      case "paths":
        return await runPaths(context, invocation.commandArgs, io);
      default:
        throw new ExitError(`unknown command: ${invocation.command}`);
    }
  } catch (error) {
    if (error instanceof RootContextError) {
      throw new ExitError(`${error.code}: ${error.message}`, { code: 2 });
    }
    throw error;
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
