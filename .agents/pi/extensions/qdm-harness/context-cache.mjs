import { createHash } from "node:crypto";

export const HARNESS_CONTEXT_MARKER = "<qdm_harness_context>";
const HARNESS_CONTEXT_END_MARKER = "</qdm_harness_context>";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function contentDigest(content) {
  let serialized;
  try {
    serialized = JSON.stringify(content);
  } catch {
    serialized = contentText(content);
  }
  return createHash("sha256").update(serialized ?? "").digest("hex").slice(0, 20);
}

export function latestUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isObject(message) || message.role !== "user") continue;
    const prompt = contentText(message.content).trim();
    if (!prompt) continue;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
    return {
      index,
      prompt,
      key: `${timestamp}:${index}:${contentDigest(message.content)}`,
    };
  }
  return null;
}

function contextBlock(context) {
  return `${HARNESS_CONTEXT_MARKER}\n${context.trim()}\n${HARNESS_CONTEXT_END_MARKER}`;
}

export function appendHarnessContext(messages, targetIndex, context) {
  if (!Array.isArray(messages) || !context?.trim()) return messages;
  const message = messages[targetIndex];
  if (!isObject(message) || message.role !== "user") return messages;

  const existingText = contentText(message.content);
  if (existingText.includes(HARNESS_CONTEXT_MARKER)) return messages;

  const nextMessages = messages.slice();
  const nextMessage = { ...message };
  const block = contextBlock(context);
  if (typeof message.content === "string") {
    nextMessage.content = `${message.content}\n\n${block}`;
  } else if (Array.isArray(message.content)) {
    nextMessage.content = [...message.content, { type: "text", text: block }];
  } else {
    nextMessage.content = [{ type: "text", text: block }];
  }
  nextMessages[targetIndex] = nextMessage;
  return nextMessages;
}

export class ContextCache {
  constructor(limit = 64) {
    this.limit = Math.max(1, Number(limit) || 64);
    this.entries = new Map();
  }

  getOrCreate(key, loader) {
    if (this.entries.has(key)) {
      const existing = this.entries.get(key);
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing;
    }

    const pending = Promise.resolve().then(loader);
    this.entries.set(key, pending);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return pending;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
