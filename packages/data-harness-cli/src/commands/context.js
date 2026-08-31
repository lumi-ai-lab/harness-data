import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";
import { printCompactJSON, printJSON } from "../lib/json-out.js";
import { build } from "../lib/context/build.js";
import { runClaudeHook, runWorkBuddyHook } from "../lib/context/hook.js";

export async function runContext(root, args, io = process, context = null) {
  const parsed = parseFlags(args, {
    question: { type: "string", default: "" },
    json: { type: "boolean", default: false },
    format: { type: "string", default: "text" },
  });
  let format = String(parsed.values.format || "text");
  if (parsed.values.json) format = "json";

  switch (format) {
    case "text":
    case "json": {
      const question = String(parsed.values.question || "");
      if (!question) throw new ExitError("context requires --question");
      const response = build(context || root, question);
      if (format === "json") {
        printJSON(response, io.stdout);
        return;
      }
      for (const ref of response.contextFiles) {
        io.stdout.write(`${ref.path}\t${ref.reason}\n`);
      }
      return;
    }
    case "claude-hook":
    case "codex-hook":
    case "agent-hook": {
      const input = await readStdin(io);
      const { ok, output } = runClaudeHook(root, input, context, { env: io.env || process.env });
      if (ok) {
        printCompactJSON(toHookJSON(output, { includeContextFiles: format === "agent-hook" }), io.stdout);
      }
      return;
    }
    case "workbuddy-hook": {
      const input = await readStdin(io);
      const { ok, output } = runWorkBuddyHook(root, input, context, { env: io.env || process.env });
      if (ok) printCompactJSON(toWorkBuddyJSON(output), io.stdout);
      return;
    }
    default:
      throw new ExitError(`unsupported context --format: ${format}`);
  }
}

// Keep the internal contextFiles allow-list out of standard host hook output.
function toHookJSON(output, { includeContextFiles = false } = {}) {
  const hook = {
    hookEventName: output.hookSpecificOutput.hookEventName,
    additionalContext: output.hookSpecificOutput.additionalContext,
  };
  if (includeContextFiles && output.hookSpecificOutput.contextFiles?.length) {
    hook.contextFiles = output.hookSpecificOutput.contextFiles;
  }
  return { hookSpecificOutput: hook };
}

function toWorkBuddyJSON(output) {
  const body = {
    continue: output.continue,
    hookSpecificOutput: toHookJSON(output, { includeContextFiles: true }).hookSpecificOutput,
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
