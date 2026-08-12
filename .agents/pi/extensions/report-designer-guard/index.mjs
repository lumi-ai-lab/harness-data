import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  designerToolDecision,
  designerToolResultState,
  initialDesignerGuardState,
  parseDesignerAssignment,
} from "./guard.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item?.type === "text" && typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

export function designerAssignmentText(event) {
  if (typeof event === "string") return event;
  if (!event || typeof event !== "object") return "";
  for (const key of ["prompt", "input", "text", "message"]) {
    if (typeof event[key] === "string" && event[key].trim()) return event[key];
  }
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    const text = messageText(messages[index].content);
    if (text.trim()) return text;
  }
  return "";
}

export default function registerReportDesignerGuard(pi) {
  let contract = { ok: false, errors: ["before_agent_start 尚未解析 Designer 任务"] };
  let state = initialDesignerGuardState();
  let assignmentText = "";

  function captureAssignment(event) {
    const text = designerAssignmentText(event).trim();
    if (!text || text === assignmentText) return;
    assignmentText = text;
    contract = parseDesignerAssignment(text, { projectRoot });
    state = initialDesignerGuardState();
  }

  pi.on?.("before_agent_start", (event) => {
    contract = { ok: false, errors: ["等待从 child context 解析 Designer 任务"] };
    state = initialDesignerGuardState();
    assignmentText = "";
    captureAssignment(event);
    return undefined;
  });

  // The task normally appears as the last user message only in the context
  // hook. Repeated context events after tools must not reset one-shot state.
  pi.on?.("context", (event) => {
    captureAssignment(event);
    return undefined;
  });

  pi.on?.("tool_call", (event) => {
    const transition = designerToolDecision(contract, state, event);
    state = transition.state;
    return transition.decision;
  });

  pi.on?.("tool_result", (event) => {
    state = designerToolResultState(contract, state, event);
    return undefined;
  });
}

export * from "./guard.mjs";
