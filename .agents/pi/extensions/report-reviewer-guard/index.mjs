import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { submitReviewScorecard } from "../../skills/html-report/scripts/submit-review-scorecard.mjs";
import { buildReviewerReturnSchema } from "../../skills/html-report/scripts/reviewer-return.mjs";
import {
  prepareStructuredOutputCapture,
  writeStructuredOutputCapture,
} from "../shared/subagent-structured-output-capture.mjs";
import {
  initialReviewerGuardState,
  parseReviewerAssignment,
  reviewerToolDecision,
  reviewerToolResultState,
} from "./guard.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function reviewerAssignmentText(event) {
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

export default function registerReportReviewerGuard(pi) {
  let contract = { ok: false, errors: ["before_agent_start 尚未解析 Reviewer 任务"] };
  let state = initialReviewerGuardState();
  let assignmentText = "";
  let submitted = false;

  function captureAssignment(event) {
    const text = reviewerAssignmentText(event).trim();
    if (!text || text === assignmentText) return;
    assignmentText = text;
    contract = parseReviewerAssignment(text, { projectRoot });
    state = initialReviewerGuardState();
    submitted = false;
  }

  pi.on?.("before_agent_start", (event) => {
    contract = { ok: false, errors: ["等待从 child context 解析 Reviewer 任务"] };
    state = initialReviewerGuardState();
    assignmentText = "";
    submitted = false;
    captureAssignment(event);
    return undefined;
  });

  // pi-subagents normally exposes only systemPrompt at before_agent_start;
  // the assigned task is the last user message in the child context.
  pi.on?.("context", (event) => {
    captureAssignment(event);
    return undefined;
  });

  pi.on?.("tool_call", (event) => {
    const transition = reviewerToolDecision(contract, state, event);
    state = transition.state;
    return transition.decision;
  });

  pi.on?.("tool_result", (event) => {
    state = reviewerToolResultState(contract, state, event);
    return undefined;
  });

  const nonEmptyString = { type: "string", minLength: 1 };
  const scoreCell = {
    type: "object",
    properties: {
      score: { type: "integer", minimum: 0, maximum: 2 },
      note: nonEmptyString,
    },
    required: ["score", "note"],
    additionalProperties: false,
  };
  const issue = {
    type: "object",
    properties: {
      severity: { type: "string", enum: ["hard", "soft"] },
      code: nonEmptyString,
      rubric: { type: "string", enum: ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] },
      message: nonEmptyString,
      where: nonEmptyString,
    },
    required: ["severity", "code", "rubric", "message", "where"],
    additionalProperties: false,
  };
  const hardBlocker = {
    type: "object",
    properties: {
      code: nonEmptyString,
      rubric: { type: "string", enum: ["R1", "R2", "R3", "R4", "R5", "R6", "R7"] },
      message: nonEmptyString,
      where: nonEmptyString,
    },
    required: ["code", "rubric", "message", "where"],
    additionalProperties: false,
  };
  const scorecardMetaProperties = {
    summary: nonEmptyString,
    hardBlockers: { type: "array", items: hardBlocker },
    issues: { type: "array", items: issue },
    repairHints: { type: "array", items: nonEmptyString },
  };
  const rubricIds = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"];

  pi.registerTool({
    name: "submit_review_scorecard",
    label: "Submit review scorecard",
    description: "Persist one typed R1-R7 scorecard, safely serialize and stamp verdict.json, and generate quality/report.md. Call once after reading scan.json.",
    promptSnippet: "submit_review_scorecard: submit the typed Reviewer scorecard once; it owns draft JSON, verdict stamping, and quality report rendering.",
    promptGuidelines: [
      "After the fixed review reads and scan.json read, call submit_review_scorecard exactly once.",
      "On success it captures the attached structured output and terminates the child; do not call structured_output afterward.",
    ],
    parameters: {
      type: "object",
      properties: {
        scores: {
          type: "object",
          properties: {
            R1: scoreCell,
            R2: scoreCell,
            R3: scoreCell,
            R4: scoreCell,
            R5: scoreCell,
            R6: scoreCell,
            R7: scoreCell,
            ...scorecardMetaProperties,
          },
          required: rubricIds,
          additionalProperties: false,
        },
        ...scorecardMetaProperties,
      },
      required: ["scores"],
      anyOf: [
        { required: Object.keys(scorecardMetaProperties) },
        {
          properties: {
            scores: { required: [...rubricIds, ...Object.keys(scorecardMetaProperties)] },
          },
        },
      ],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (submitted) throw new Error("submit_review_scorecard may be called only once per Reviewer assignment");
      submitted = true;
      if (!contract.ok) throw new Error("Reviewer assignment is not valid");
      const capture = await prepareStructuredOutputCapture(
        buildReviewerReturnSchema(contract)
      );
      const reviewerReturn = await submitReviewScorecard(contract.resultPath, params);
      const structuredOutputPath = await writeStructuredOutputCapture(capture, reviewerReturn);
      return {
        content: [{ type: "text", text: "Reviewer scorecard committed; structured output captured." }],
        details: { reviewerReturn, structuredOutputPath },
        terminate: true,
      };
    },
  });
}

export * from "./guard.mjs";
