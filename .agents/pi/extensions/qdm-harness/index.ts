import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type JsonObject = Record<string, unknown>;

interface PiExtensionContext {
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
}

interface PiContextEvent {
  messages?: unknown[];
}

interface PiBeforeAgentStartEvent {
  systemPrompt?: string;
}

interface PiToolCallEvent {
  toolName?: string;
  input?: JsonObject;
}

type ContextFormat = "agent-hook" | "json";

interface CliContextPayload {
  question?: string;
  contextFiles?: Array<{ path?: unknown }>;
  instruction?: string;
  constraints?: unknown;
}

const extensionDir = dirname(fileURLToPath(import.meta.url));
const extractContextScript = join(extensionDir, "extract-additional-context.mjs");
let contextFormat: ContextFormat | null = null;
let posttoolFormat: "agent-hook" | "claude-hook" = "agent-hook";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, "bin", "data-harness-cli"))) return current;
    if (existsSync(join(current, ".agents")) && existsSync(join(current, "wikis"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function sessionId(ctx?: PiExtensionContext): string {
  return (
    ctx?.sessionManager?.getSessionId?.() ||
    ctx?.sessionManager?.getSessionFile?.() ||
    process.env.PI_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    "unknown"
  );
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

function buildContextFromCliJson(payload: CliContextPayload): string {
  const files = Array.isArray(payload.contextFiles)
    ? payload.contextFiles
        .map((entry) => {
          const pathValue = entry?.path;
          return typeof pathValue === "string" && pathValue.trim() ? `- ${pathValue.trim()}` : "";
        })
        .filter(Boolean)
    : [];
  const constraints = Array.isArray(payload.constraints)
    ? payload.constraints
        .map((constraint) => (typeof constraint === "string" ? `- ${constraint}` : ""))
        .filter(Boolean)
    : [];

  return [
    "# Data Harness Context",
    "",
    files.length ? "必须先读取以下 contextFiles：" : "",
    ...files,
    payload.instruction ? "" : "",
    payload.instruction ?? "",
    constraints.length ? "- constraints:" : "",
    ...constraints,
  ]
    .filter(Boolean)
    .join("\n");
}

function detectContextFormat(cli: string): ContextFormat {
  if (contextFormat) return contextFormat;

  const probe = spawnSync(cli, ["context", "--help"], { encoding: "utf8" });
  const output = `${probe.stderr ?? ""}${probe.stdout ?? ""}`;
  if (/agent-hook/.test(output)) {
    contextFormat = "agent-hook";
    return contextFormat;
  }
  contextFormat = "json";
  return contextFormat;
}

function detectPosttoolFormat(cli: string): "agent-hook" | "claude-hook" {
  const probe = spawnSync(cli, ["posttool", "--help"], { encoding: "utf8" });
  const output = `${probe.stderr ?? ""}${probe.stdout ?? ""}`;
  if (/agent-hook/.test(output)) return "agent-hook";
  return "claude-hook";
}

function runHarnessContext(projectRoot: string, prompt: string, ctx?: PiExtensionContext): string {
  if (!prompt) return "";
  const cli = join(projectRoot, "bin", "data-harness-cli");
  const format = detectContextFormat(cli);
  const result =
    format === "agent-hook"
      ? spawnSync(cli, ["context", "--format", "agent-hook"], {
          cwd: projectRoot,
          input: JSON.stringify({ session_id: sessionId(ctx), prompt }),
          encoding: "utf8",
        })
      : spawnSync(cli, ["context", "--json", "--question", prompt], {
          cwd: projectRoot,
          encoding: "utf8",
        });

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "unknown error").trim();
    ctx?.ui?.notify?.(`QDM Harness context failed: ${message}`, "warning");
    return "";
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    if (format === "json") {
      const parsed = payload as CliContextPayload;
      return buildContextFromCliJson(parsed);
    }
    const hookPayload = payload as JsonObject;
    const hookOutput = isObject(hookPayload.hookSpecificOutput) ? hookPayload.hookSpecificOutput : null;
    const context = isObject(hookOutput) ? hookOutput.additionalContext : undefined;
    return typeof context === "string" ? addPiPathGuidance(context.trim()) : "";
  } catch {
    return "";
  }
}

function addPiPathGuidance(context: string): string {
  if (!context) return "";
  const selectedReadPath = context.match(/^- (wikis\/playbooks\/[^\s]+) \(selected playbook\)$/m)?.[1];
  return [
    "# Pi Path Guidance",
    "",
    "- `selectedPlaybook` and `selectedTemplate` are Harness logical IDs, not direct filesystem paths.",
    "- Read only the paths listed under `contextFiles`; those are already resolved through `config/harness-config.yaml` and usually start with `wikis/`.",
    "- If you need the selected playbook body, read the matching `wikis/playbooks/...` entry from `contextFiles`, not `playbooks/...`.",
    selectedReadPath ? `- Selected playbook read path: \`${selectedReadPath}\`.` : "",
    "",
    context,
  ].filter(Boolean).join("\n");
}

function qdmContextMessage(text: string): JsonObject {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isTemplateCommand(command: string): boolean {
  return /\bdata-harness-cli\b/.test(command) && /\b(inject-template|stage\s+template)\b/.test(command);
}

function injectPosttool(projectRoot: string, event: unknown, ctx?: PiExtensionContext): void {
  const toolCall = event as PiToolCallEvent;
  if (!["bash", "Bash"].includes(toolCall.toolName ?? "") || !isObject(toolCall.input)) return;
  const command = toolCall.input.command;
  if (typeof command !== "string" || !isTemplateCommand(command)) return;

  const payload = JSON.stringify({
    session_id: sessionId(ctx),
    tool_name: "Bash",
    tool_input: { command },
  });
  const cli = join(projectRoot, "bin", "data-harness-cli");
  if (posttoolFormat === "agent-hook") {
    const resolvedFormat = detectPosttoolFormat(cli);
    posttoolFormat = resolvedFormat;
  }
  toolCall.input.command = [
    "{",
    command,
    ";",
    "}",
    ";",
    "__qdm_status=$?",
    ";",
    "printf %s",
    shellQuote(payload),
    "|",
    shellQuote(cli),
    `posttool --format ${posttoolFormat}`,
    "| node",
    shellQuote(extractContextScript),
    ";",
    "exit $__qdm_status",
  ].join(" ");
}

export default function qdmHarnessExtension(pi: {
  on?: (event: string, handler: (event: unknown, ctx?: PiExtensionContext) => unknown) => void;
  cwd?: string;
}): void {
  const projectRoot = findProjectRoot(pi.cwd ?? process.cwd());
  let injectedPromptThisTurn = "";

  pi.on?.("input", () => {
    injectedPromptThisTurn = "";
    return { action: "continue" };
  });

  pi.on?.("before_agent_start", (event, ctx) => {
    const prompt = latestUserPrompt(event);
    const context = runHarnessContext(projectRoot, prompt, ctx);
    if (!context) return undefined;
    injectedPromptThisTurn = prompt;
    const current = (event as PiBeforeAgentStartEvent).systemPrompt ?? "";
    return {
      systemPrompt: [current, context].filter(Boolean).join("\n\n"),
    };
  });

  pi.on?.("context", (event, ctx) => {
    const messages = (event as PiContextEvent).messages;
    if (!Array.isArray(messages)) return undefined;
    const prompt = latestUserPrompt(event);
    if (!prompt || injectedPromptThisTurn === prompt) return { messages };
    const context = runHarnessContext(projectRoot, prompt, ctx);
    if (!context) return { messages };
    injectedPromptThisTurn = prompt;
    return { messages: [...messages, qdmContextMessage(context)] };
  });

  pi.on?.("tool_call", (event, ctx) => {
    injectPosttool(projectRoot, event, ctx);
    return undefined;
  });
}
