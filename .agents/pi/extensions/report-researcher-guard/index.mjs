import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initialResearcherGuardState,
  parseEditorPlannerGuardAssignment,
  parseResearcherAssignment,
  RESEARCHER_SUBMIT_TOOL,
  researcherUnvalidatedSubmitFailureState,
  researcherToolDecision,
  researcherToolResultState,
} from "./guard.mjs";
import { submitResearchFindings } from "../../skills/html-report/scripts/submit-research-findings.mjs";
import {
  buildResearcherReturnSchema,
  RESEARCHER_RETURN_LIMITS,
} from "../../skills/html-report/scripts/researcher-return.mjs";
import {
  EDITOR_PLANNER_SYSTEM_PROMPT,
  isEditorPlannerAssignment,
} from "../../skills/html-report/scripts/editor-plan-contract.mjs";
import {
  handoffOfficialStructuredOutput,
  prepareStructuredOutputCapture,
} from "../shared/subagent-structured-output-capture.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));

export const TYPED_RESEARCHER_SYSTEM_PROMPT = [
  "You are the html-report Researcher for one B3 task. Follow the assigned evidencePlan.mode and decide only from the task plus its authorized evidence.",
  "Latency-critical: after the authorized evidence read, make one silent pass from requirement -> exact view pointer -> concise claim -> submit. Do not restate the task/evidence, enumerate rows, compare drafts, narrate checks, or rate reliability without explicit threshold metadata.",
  "Use no fixed test, store, indicator, field or expected answer. Never broaden scope, query in reuse_entry, read full entries, scan files, or use tools outside the injected mode contract.",
  "Cover each assigned requirement once. Use only a few complete numeric literals copied verbatim from that finding's allowed /views node, preserving every decimal place. Never round, subtract, calculate ratios, derive ranges, or borrow store/date/scope numbers from the question or source.queryCoverage.",
  "Separate marginal views never prove a joint best combination; claim a joint observed cell only from an authorized joint/cross view. Keep association sample-scoped and non-causal. When zero sensitivity exists, copy the primary and alternate exact values side by side and say only that the result is sensitive to zero handling.",
  "For a jointQuantileBins requirement, inspect evaluation.status, support, stability, and bestSupportedCandidates, then use only returned cells. Always state each cited cell rowCount and the minimum support rule. If the observed winner has low support or evaluation.status is not ok, explicitly label that boundary, never call the sparse cell a best balance interval or robust result, and use a support-qualified candidate only when bestSupportedCandidates.status=available while labeling it as an alternative rather than the raw winner. Do not enumerate the grid or call any result a global optimum.",
  "Answer-minimum: for ranking, cite only the requested record facts and never enumerate full TopN unless the user explicitly requests a list/count. For joint_tradeoff, use one compact answer-first claim: lead with support-qualified operating candidate(s) when available, then explain the raw observed winner and its support boundary; if mean/median candidates differ, say there is no single stable point. Omit bin counts, grid shape/cell totals, and method/protocol metadata. Write plain user-facing business prose; never echo JSON keys, enum values, methods, policy strings, or field=value diagnostics. Set suggestedDeeper=[] unless a concrete unresolved gap requires a different metric, dimension, scope, comparison, or query.",
  "Without explicit proof metadata, do not use significance language even negatively, or attribution words such as 显著、影响、拉动、拉升、驱动、导致、推高. Do not invent universal thresholds, global optima, or high/low reliability labels.",
  "For an ok analysisContractVersion=1 result, call submit_research_findings as the only tool in its assistant message. It validates artifacts and writes them; next call structured_output exactly once with the returned researcherReturn. Do not call write afterward.",
  "For needs_evidence_plan, needs_new_query or failed, write no completion artifact and call structured_output exactly once with the attached branch. Any submit_research_findings error consumes the only attempt: never correct or resubmit; the next and only call is structured_output status=failed.",
].join("\n");

export const TYPED_RESEARCHER_NEW_QUERY_SYSTEM_PROMPT = [
  "You are the html-report Researcher for one current B3 new_query task. Use only the assigned task/evidenceGap, its exact paths, and the fixed sequence below; never use a memorized field, store, metric, or answer.",
  "1) Read the assigned absolute result.json exactly once. Select cards[].id === fromCardId and deep-copy its query.request as the immutable baseline.",
  "2) Run exactly once: bin/data-harness-cli wikis recall-debug --question \"<only the evidenceGap>\" --json --doc-set specs. Read each returned gap-relevant Spec path at most once (maximum two); do not scan Wiki/indexes.",
  "3) Treat query.request as the single canonical Metric QueryRequest. Change only metrics, dimensions, time.*, filters/scopes/measureFilters, comparisons, or statisticPolicy fields explicitly authorized by evidenceGap. Preserve all other baseline fields; requestId, orderBy, pageNo and pageSize are never a material delta, and unknown fields are forbidden.",
  "4) Write exactly $SESSION/data/explore/<taskId>.payload.json as temporary input. Then run exactly once: node .agents/pi/skills/html-report/scripts/fetch-explore.mjs --result <ABS_RESULT_JSON> --task-id <TASK_ID> --payload-file <ABS_PAYLOAD_JSON> --goal <EXACT_TASK_GOAL> --from-card-id <EXACT_FROM_CARD_ID>.",
  "5) After fetch success run exactly once: node .agents/pi/skills/html-report/scripts/prepare-research-evidence.mjs --result <ABS_RESULT_JSON> --task-id <TASK_ID>. Then read the assigned evidencePath exactly once; never read full explore rows.",
  "6) Make one silent pass requirement -> allowed exact /views pointer -> concise claim. Copy each complete numeric literal verbatim with all decimals; never round, calculate, borrow scope numbers, combine marginal winners into a joint optimum, narrate checks, or upgrade sample association to causality/significance/global optimum.",
  "For jointQuantileBins, inspect evaluation.status/support/stability/bestSupportedCandidates and use only returned cells. Disclose each cited cell rowCount and the minimum support rule; when the raw winner is low-support, do not call it a best balance interval or robust result, and present a support-qualified candidate only as a labeled alternative when available. Do not enumerate the grid.",
  "Answer-minimum: never enumerate full TopN unless the user explicitly requests a list/count. For joint_tradeoff, lead with support-qualified operating candidate(s), then explain the raw winner/support boundary; if mean/median candidates differ, say there is no single stable point. Use plain business prose and never echo JSON keys, enum values, methods, policy strings, or field=value diagnostics. Set suggestedDeeper=[] unless a concrete unresolved gap requires a materially different query.",
  "7) For status=ok call submit_research_findings as the only tool in its assistant message with one finding per assigned requirement plus suggestedDeeper. It validates and writes artifacts; next call structured_output exactly once with the returned researcherReturn. Do not call write afterward.",
  "On any read/recall/write/fetch/prepare/submit failure, do not retry or repair. A submit failure consumes the only attempt. For needs_evidence_plan, needs_new_query or failed, write no completion artifact and call structured_output exactly once with the attached branch.",
].join("\n");

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function researcherAssignmentText(event) {
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

export function researcherAssignmentTextFromContext(ctx) {
  const getBranch = ctx?.sessionManager?.getBranch;
  if (typeof getBranch !== "function") return "";
  let entries;
  try {
    entries = getBranch.call(ctx.sessionManager);
  } catch {
    return "";
  }
  if (!Array.isArray(entries)) return "";
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const message = entry?.type === "message" ? entry.message : entry?.message;
    if (!message || message.role !== "user") continue;
    const text = messageText(message.content);
    if (text.trim()) return text;
  }
  return "";
}

export default function registerReportResearcherGuard(pi) {
  let contract = { ok: false, errors: ["before_agent_start 尚未解析 Researcher 任务"] };
  let state = initialResearcherGuardState();
  let assignmentText = "";
  let submitted = false;

  function captureAssignment(event) {
    const text = researcherAssignmentText(event).trim();
    if (!text || text === assignmentText) return;
    assignmentText = text;
    contract = isEditorPlannerAssignment(text)
      ? parseEditorPlannerGuardAssignment(text, { projectRoot })
      : parseResearcherAssignment(text, { projectRoot });
    state = initialResearcherGuardState();
    submitted = false;
  }

  pi.on?.("before_agent_start", (event, ctx) => {
    contract = { ok: false, errors: ["等待从 child context 解析 Researcher 任务"] };
    state = initialResearcherGuardState();
    assignmentText = "";
    submitted = false;
    captureAssignment(event);
    if (!assignmentText) captureAssignment(researcherAssignmentTextFromContext(ctx));
    if (contract?.kind === "editor_plan") {
      // Planner is a semantic-only typed decision. Runtime guards remain as a
      // fail-closed backstop, but removing the ordinary Researcher tools here
      // also keeps them out of the provider request altogether.
      pi.setActiveTools?.(["structured_output"]);
      return { systemPrompt: EDITOR_PLANNER_SYSTEM_PROMPT };
    }
    if (contract?.ok && Number(contract?.task?.analysisContractVersion) === 1) {
      return {
        systemPrompt: contract.mode === "reuse_entry"
          ? TYPED_RESEARCHER_SYSTEM_PROMPT
          : TYPED_RESEARCHER_NEW_QUERY_SYSTEM_PROMPT,
      };
    }
    return undefined;
  });

  // pi-subagents normally supplies only { systemPrompt } to
  // before_agent_start; the assigned task itself is the last user message in
  // the context hook. Capture it here without changing the message list. Do
  // not reset counters when the same context is presented again after a tool
  // call, otherwise one-shot guards could be bypassed.
  pi.on?.("context", (event) => {
    captureAssignment(event);
    if (contract?.kind === "editor_plan") {
      // Long pi-subagents tasks arrive inside a temporary <file> user message,
      // after before_agent_start. Narrow the visible tools at the first context
      // boundary so Planner mode remains semantic-only in the real runtime.
      pi.setActiveTools?.(["structured_output"]);
    }
    return undefined;
  });

  pi.on?.("tool_call", (event) => {
    const transition = researcherToolDecision(contract, state, event);
    state = transition.state;
    return transition.decision;
  });

  pi.on?.("tool_result", (event) => {
    state = researcherToolResultState(contract, state, event);
    return undefined;
  });

  // Core argument validation runs before tool_call. A malformed first submit
  // therefore has no guard admission, but it still emits tool_execution_end.
  // Consume that attempt here so a corrected second submit cannot bypass the
  // one-shot contract. A normally admitted call has already incremented
  // submitAttempts in tool_call, so this transition ignores it.
  pi.on?.("tool_execution_end", (event) => {
    state = researcherUnvalidatedSubmitFailureState(contract, state, event);
    return undefined;
  });

  const nonEmptyString = { type: "string", minLength: 1 };
  const findingClaim = {
    ...nonEmptyString,
    maxLength: RESEARCHER_RETURN_LIMITS.claimCharacters,
    pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029]+$",
    description: "Copy complete numeric literals verbatim from this requirement's allowed /views nodes with all decimals. No rounding, arithmetic, scope-number borrowing, marginal-to-joint inference, significance, or causal attribution.",
  };
  pi.registerTool({
    name: RESEARCHER_SUBMIT_TOOL,
    label: "Submit research findings",
    description: "Validate requirement-bound findings, render cited section Markdown, and persist the complete Researcher summary envelope. Call exactly once after reading evidence; any error consumes the attempt.",
    promptSnippet: "submit_research_findings: submit only requirement-bound findings; the tool owns citations, section rendering, summary construction, validation, and artifact writes.",
    promptGuidelines: [
      "After the single evidence read, call submit_research_findings exactly once instead of write.",
      "Call it as the only tool in that assistant message. On success, call structured_output exactly once with the returned researcherReturn.",
      "Every complete numeric literal must be copied unchanged with all decimal places from the finding's allowed /views node. Never round or calculate a new value.",
      "Satisfy the persisted capability fact roles: both sides for comparison, two units for structural breakdown, coefficient plus eligible rows for association, and observed-cell facts plus rowCount and minimum support for joint trade-off.",
      "Any submit error consumes the only attempt. Never correct or submit again; call structured_output once with status=failed.",
    ],
    parameters: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          minItems: 1,
          maxItems: RESEARCHER_RETURN_LIMITS.analysisRequirements,
          items: {
            type: "object",
            properties: {
              requirementId: nonEmptyString,
              claim: findingClaim,
              evidencePointers: {
                type: "array",
                minItems: 1,
                maxItems: RESEARCHER_RETURN_LIMITS.findingPointers,
                uniqueItems: true,
                items: { type: "string", pattern: "^/views/" },
              },
            },
            required: ["requirementId", "claim", "evidencePointers"],
            additionalProperties: false,
          },
        },
        suggestedDeeper: {
          type: "array",
          maxItems: RESEARCHER_RETURN_LIMITS.suggestedDeeperItems,
          uniqueItems: true,
          items: nonEmptyString,
        },
      },
      required: ["findings", "suggestedDeeper"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (submitted) throw new Error("submit_research_findings may be called only once per Researcher assignment");
      submitted = true;
      if (
        !contract.ok ||
        Number(contract?.task?.analysisContractVersion) !== 1 ||
        !state.evidence ||
        !state.readSuccess[contract.evidencePath]
      ) {
        throw new Error("Researcher assignment/evidence is not ready for typed submit");
      }
      const expected = {
        taskId: contract.taskId,
        mode: contract.mode,
        evidencePath: contract.evidencePath,
        sectionPath: contract.sectionPath,
        summaryPath: contract.summaryPath,
        task: contract.task,
        analysisRequirements: contract.task.analysisRequirements,
      };
      try {
        await prepareStructuredOutputCapture(
          buildResearcherReturnSchema(expected)
        );
        const result = await submitResearchFindings(expected, state.evidence, params);
        return handoffOfficialStructuredOutput(pi, result.researcherReturn, {
          researcherReturn: result.researcherReturn,
        });
      } catch (error) {
        throw new Error(
          `${error?.message || error}；该失败已消费唯一提交机会；禁止修正或再次提交；下一步且仅允许 structured_output status=failed`
        );
      }
    },
  });
}

export * from "./guard.mjs";
