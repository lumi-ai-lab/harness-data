import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";
import { printCompactJSON } from "../lib/json-out.js";
import { runClaudeHook, runWorkBuddyHook } from "../lib/posttool/hook.js";
import { runQwenPawHook } from "../lib/posttool/qwenpaw.js";

export async function runPosttool(root, args, io = process, context = null) {
  const parsed = parseFlags(args, {
    format: { type: "string", default: "claude-hook" },
  });
  const format = String(parsed.values.format || "claude-hook");
  const input = await readStdin(io);
  if (format === "workbuddy-hook") {
    const { ok, output } = runWorkBuddyHook(root, input, context, { env: io.env || process.env });
    if (ok) printCompactJSON(toWorkBuddyJSON(output), io.stdout);
    return;
  }
  if (format === "qwenpaw-hook") {
    try {
      printCompactJSON(runQwenPawHook(root, input, context), io.stdout);
    } catch (error) {
      throw new ExitError(error.message || error, { code: 2 });
    }
    return;
  }
  if (!["claude-hook", "codex-hook", "agent-hook"].includes(format)) {
    throw new ExitError(`unsupported posttool --format: ${format}`);
  }
  const { ok, output } = runClaudeHook(root, input, context, { env: io.env || process.env });
  if (ok) printCompactJSON(toJSON(output), io.stdout);
}

function toJSON(output) {
  return {
    hookSpecificOutput: {
      hookEventName: output.hookSpecificOutput.hookEventName,
      additionalContext: output.hookSpecificOutput.additionalContext,
    },
  };
}

function toWorkBuddyJSON(output) {
  const body = {
    continue: output.continue !== false,
    hookSpecificOutput: {
      hookEventName: output.hookSpecificOutput.hookEventName,
      additionalContext: output.hookSpecificOutput.additionalContext,
    },
  };
  if (output.systemMessage) body.systemMessage = output.systemMessage;
  return body;
}

async function readStdin(io) {
  if (typeof io.stdin === "string") return Buffer.from(io.stdin);
  if (Buffer.isBuffer(io.stdin)) return io.stdin;
  if (!io.stdin || typeof io.stdin.on !== "function") return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of io.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
