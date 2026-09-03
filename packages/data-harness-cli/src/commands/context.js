import { readFileSync } from "node:fs";
import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";
import { printCompactJSON, printJSON } from "../lib/json-out.js";
import { build } from "../lib/context/build.js";
import { runClaudeHook, runWorkBuddyHook } from "../lib/context/hook.js";
import { newPathResolver } from "../lib/harness.js";

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
    case "qwenpaw-hook": {
      const input = await readStdin(io);
      const { ok, output } = runClaudeHook(root, input, context, { env: io.env || process.env });
      if (ok) {
        printCompactJSON(toQwenPawHookJSON(root, output, context), io.stdout);
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

// QwenPaw has no file tools, so the CLI embeds the selected wiki manuals
// directly into the additional context instead of exposing paths to read.
// Embedding is all-or-nothing: a partial set would let the agent query without
// the metric contract while the injected text still claimed completeness.
function toQwenPawHookJSON(root, output, context) {
  const hook = toHookJSON(output, { includeContextFiles: true });
  const selected = output.hookSpecificOutput.contextFiles || [];
  const resolver = newPathResolver(context || root);
  const manuals = [];
  const embedded = [];
  const failed = [];
  for (const ref of selected) {
    try {
      const body = readFileSync(resolver.resolve(ref.path), "utf8");
      embedded.push(ref.path);
      manuals.push(`\n--- ${ref.path} ---\n${body}\n`);
    } catch (error) {
      failed.push(`${ref.path} (${error.code || error.message})`);
    }
  }
  if (failed.length) {
    throw new ExitError(`qwenpaw-hook: failed to embed selected manuals: ${failed.join("; ")}`, { code: 2 });
  }
  if (manuals.length) {
    hook.hookSpecificOutput.additionalContext += `\n\n# QDM Harness selected manuals\n${manuals.join("")}`;
  }
  hook.hookSpecificOutput.embeddedContextFiles = embedded;
  return { hookSpecificOutput: hook.hookSpecificOutput };
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
