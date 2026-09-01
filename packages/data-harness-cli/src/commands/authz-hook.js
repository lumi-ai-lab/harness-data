import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";
import { printCompactJSON } from "../lib/json-out.js";
import { run, runAdapterEnvelope, runQwenPawAdapterEnvelope, toGoEnvelopeJSON, toGoHookJSON } from "../lib/authz/hook.js";

export async function runAuthzHook(root, args, io = process, context = null) {
  const rootOrContext = context || root;
  let parsed;
  try {
    parsed = parseFlags(args, {
      agent: { type: "string", default: "codex" },
      format: { type: "string", default: "hook" },
    });
  } catch (error) {
    if (error instanceof ExitError) throw new ExitError(error.message, { code: 2 });
    throw error;
  }
  if (parsed.rest.length !== 0) {
    throw new ExitError("authz-hook does not accept positional arguments", { code: 2 });
  }
  const agent = String(parsed.values.agent || "codex");
  const format = String(parsed.values.format || "hook");
  const input = await readStdin(io);

  if (format === "adapter-envelope") {
    if (agent.trim().toLowerCase() === "qwenpaw") {
      const envelope = runQwenPawAdapterEnvelope(rootOrContext, input);
      // The qwenpaw envelope carries the scope and normalized filters, so
      // print the hook output verbatim instead of the Go hook projection.
      printCompactJSON({
        schemaVersion: envelope.schemaVersion,
        status: envelope.status,
        hookOutput: envelope.hookOutput?.hookSpecificOutput || envelope.hookOutput,
      }, io.stdout);
      return;
    }
    if (agent.trim().toLowerCase() !== "workbuddy") {
      throw new ExitError("adapter-envelope format requires --agent workbuddy or --agent qwenpaw", { code: 2 });
    }
    const envelope = runAdapterEnvelope(rootOrContext, agent, input);
    printCompactJSON(toGoEnvelopeJSON(envelope), io.stdout);
    return;
  }
  if (format !== "hook") {
    throw new ExitError(`unsupported authz-hook format ${JSON.stringify(format)}`, { code: 2 });
  }
  const { ok, output } = run(rootOrContext, agent, input);
  if (ok) {
    printCompactJSON(toGoHookJSON(output), io.stdout);
    return;
  }
  if (agent === "workbuddy") {
    printCompactJSON({}, io.stdout);
  }
}

async function readStdin(io) {
  if (io.stdinBytes != null) return Buffer.from(io.stdinBytes);
  if (typeof io.stdin === "string") return Buffer.from(io.stdin);
  if (Buffer.isBuffer(io.stdin)) return io.stdin;
  const stream = io.stdin;
  if (!stream || typeof stream.on !== "function") return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
