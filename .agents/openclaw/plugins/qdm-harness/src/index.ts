import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractAdditionalContext } from "./extract-additional-context.ts";

type JsonObject = Record<string, unknown>;

const pluginDir = dirname(fileURLToPath(import.meta.url));
const workspaceHint = resolve(pluginDir, "../../../../..");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findProjectRoot(startDir = process.cwd()): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, "bin", "data-harness-cli"))) return current;
    if (existsSync(join(current, ".agents")) && existsSync(join(current, "wikis"))) return current;
    const parent = dirname(current);
    if (parent === current) return workspaceHint;
    current = parent;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function latestUserPrompt(event: unknown): string {
  if (typeof event === "string") return event.trim();
  if (!isObject(event)) return "";
  for (const key of ["prompt", "input", "text", "message"]) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isObject(message) || message.role !== "user") continue;
    const text = contentText(message.content).trim();
    if (text) return text;
  }
  return "";
}

function sessionId(event: unknown): string {
  if (isObject(event)) {
    for (const key of ["session_id", "sessionId", "conversation_id", "threadId"]) {
      const value = event[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return process.env.OPENCLAW_SESSION_ID || process.env.CLAUDE_SESSION_ID || "unknown";
}

function toolName(event: unknown): string {
  if (!isObject(event)) return "";
  for (const key of ["tool_name", "toolName", "name", "type"]) {
    const value = event[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function toolInput(event: unknown): JsonObject {
  if (!isObject(event)) return {};
  for (const key of ["tool_input", "toolInput", "input", "arguments", "args"]) {
    const value = event[key];
    if (isObject(value)) return value;
  }
  return event;
}

function commandFromEvent(event: unknown): string {
  const input = toolInput(event);
  const command = input.command ?? input.cmd ?? input.script;
  return typeof command === "string" ? command : "";
}

function isShellTool(name: string): boolean {
  return /^(bash|shell|exec|terminal)$/i.test(name);
}

function isTemplateCommand(command: string): boolean {
  return /\bdata-harness-cli\b/.test(command) && /\b(inject-template|stage\s+template)\b/.test(command);
}

function runHarnessContext(projectRoot: string, event: unknown): string {
  const prompt = latestUserPrompt(event);
  if (!prompt) return "";
  const cli = join(projectRoot, "bin", "data-harness-cli");
  const result = spawnSync(cli, ["context", "--format", "agent-hook"], {
    cwd: projectRoot,
    input: JSON.stringify({ session_id: sessionId(event), prompt }),
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return extractAdditionalContext(result.stdout);
}

function runPosttool(projectRoot: string, event: unknown, command: string): string {
  const cli = join(projectRoot, "bin", "data-harness-cli");
  const result = spawnSync(cli, ["posttool", "--format", "agent-hook"], {
    cwd: projectRoot,
    input: JSON.stringify({
      session_id: sessionId(event),
      tool_name: "Bash",
      tool_input: { command },
    }),
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return extractAdditionalContext(result.stdout);
}

function contextPatch(context: string): JsonObject | undefined {
  if (!context) return undefined;
  return {
    context,
    additionalContext: context,
    systemPromptAppend: context,
    messages: [{ role: "user", content: context }],
  };
}

export const hooks = {
  before_prompt_build(event: unknown): JsonObject | undefined {
    const projectRoot = findProjectRoot();
    return contextPatch(runHarnessContext(projectRoot, event));
  },

  after_tool_call(event: unknown): JsonObject | undefined {
    const name = toolName(event);
    const command = commandFromEvent(event);
    if (!isShellTool(name) || !isTemplateCommand(command)) return undefined;
    const projectRoot = findProjectRoot();
    return contextPatch(runPosttool(projectRoot, event, command));
  },
};

export default { hooks };
