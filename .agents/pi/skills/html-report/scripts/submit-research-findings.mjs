/**
 * Deterministically commit one current-contract Researcher result.
 *
 * The model supplies only requirement-bound findings. This module owns the
 * section citation layout, summary/envelope construction, validation, and the
 * two completion artifact writes. No business field, metric, store, or test
 * prompt is special-cased here.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  RESEARCHER_RETURN_LIMITS,
  deriveResearcherMachineSelfCheck,
  validateResearcherCompletionContent,
  validateResearcherReturn,
} from "./researcher-return.mjs";

const CLAIM_DISALLOWED_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MARKDOWN_BLOCK_PREFIX = /^(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s|`{3}|~{3}|\[[^\]]+\]:\s|(?:-{3,}|_{3,}|\*{3,})$)/u;
const HTML_BLOCK = /<!--|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)\b/iu;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonEmptyText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function characterLength(value) {
  return [...value].length;
}

function normalizeClaim(value, label) {
  const claim = nonEmptyText(value, label);
  if (characterLength(claim) > RESEARCHER_RETURN_LIMITS.claimCharacters) {
    throw new Error(`${label} must contain at most ${RESEARCHER_RETURN_LIMITS.claimCharacters} characters`);
  }
  if (CLAIM_DISALLOWED_CHARACTERS.test(claim)) {
    throw new Error(`${label} must be one line and contain no control characters`);
  }
  if (MARKDOWN_BLOCK_PREFIX.test(claim) || HTML_BLOCK.test(claim)) {
    throw new Error(`${label} must not contain a Markdown or HTML block`);
  }
  return claim;
}

function normalizeTextList(value, label, maxItems) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} items`);
  const items = value.map((item, index) => nonEmptyText(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${label} must be unique`);
  return items;
}

function normalizeFindings(value, requirements) {
  if (!Array.isArray(value) || value.length !== requirements.length) {
    throw new Error(`findings must contain exactly one item for each of ${requirements.length} requirements`);
  }
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const seen = new Set();
  return value.map((finding, index) => {
    if (!exactKeys(finding, ["requirementId", "claim", "evidencePointers"])) {
      throw new Error(`findings[${index}] must contain only requirementId, claim, and evidencePointers`);
    }
    const requirementId = nonEmptyText(finding.requirementId, `findings[${index}].requirementId`);
    if (!requirementIds.has(requirementId)) {
      throw new Error(`findings[${index}].requirementId is not assigned`);
    }
    if (seen.has(requirementId)) throw new Error(`requirement ${requirementId} has more than one finding`);
    seen.add(requirementId);
    return {
      requirementId,
      claim: normalizeClaim(finding.claim, `findings[${index}].claim`),
      evidencePointers: normalizeTextList(
        finding.evidencePointers,
        `findings[${index}].evidencePointers`,
        RESEARCHER_RETURN_LIMITS.findingPointers
      ),
    };
  });
}

export function renderResearcherSection(findings) {
  return findings.map((finding) => [
    `- ${finding.claim}`,
    `  证据：${finding.evidencePointers.map((pointer) => `\`${pointer}\``).join("、")}`,
  ].join("\n")).join("\n");
}

export function buildResearcherSubmission(expected, evidence, params) {
  if (!isObject(expected) || !isObject(expected.task)) throw new Error("Researcher expected contract is invalid");
  if (!isObject(evidence)) throw new Error("Researcher evidence is invalid");
  if (String(evidence.taskId) !== String(expected.taskId)) {
    throw new Error("Researcher evidence taskId does not match the expected task");
  }
  if (evidence.evidenceMode !== expected.mode) {
    throw new Error("Researcher evidenceMode does not match the expected mode");
  }
  if (!exactKeys(params, ["findings", "suggestedDeeper"])) {
    throw new Error("submit params must contain only findings and suggestedDeeper");
  }
  const requirements = Array.isArray(expected.analysisRequirements)
    ? expected.analysisRequirements
    : [];
  if (!requirements.length) throw new Error("typed submit requires non-empty analysisRequirements");
  const findings = normalizeFindings(params.findings, requirements);
  const suggestedDeeper = normalizeTextList(
    params.suggestedDeeper,
    "suggestedDeeper",
    RESEARCHER_RETURN_LIMITS.suggestedDeeperItems
  );
  const evidencePointers = [...new Set(findings.flatMap((finding) => finding.evidencePointers))];
  const noData = evidence?.source?.empty === true;
  const machineSelfCheck = deriveResearcherMachineSelfCheck(expected, evidence, findings);
  const section = renderResearcherSection(findings);
  const summary = findings.map((finding) => finding.claim).join(" ");
  if (characterLength(summary) > RESEARCHER_RETURN_LIMITS.summaryCharacters) {
    throw new Error(
      `summary must contain at most ${RESEARCHER_RETURN_LIMITS.summaryCharacters} characters`
    );
  }
  const researcherReturn = {
    taskId: expected.taskId,
    status: "ok",
    evidenceModeUsed: expected.mode,
    evidencePath: expected.evidencePath,
    sectionPath: expected.sectionPath,
    summaryPath: expected.summaryPath,
    summary,
    noData,
    evidencePointers,
    findings,
    selfCheck: {
      modeCompliant: true,
      evidenceTraceable: true,
      hasContrastOrBreakdown: machineSelfCheck.hasContrastOrBreakdown,
      answersGoal: machineSelfCheck.answersGoal,
      queryJustified: expected.mode === "new_query" ? true : null,
    },
    suggestedDeeper,
  };
  const envelope = validateResearcherReturn(researcherReturn, expected);
  const content = validateResearcherCompletionContent({
    evidence,
    section,
    summary: researcherReturn,
    evidencePointers,
    expected,
  });
  const errors = [
    ...envelope.errors,
    ...content.errors,
    ...(!machineSelfCheck.answersGoal
      ? [`findings must state at least one exact machine-verifiable fact for every requirement: ${machineSelfCheck.unansweredRequirementIds.join(", ")}`]
      : []),
  ];
  if (errors.length) throw new Error(`Researcher findings validation failed: ${errors.join("; ")}`);
  return { section, researcherReturn };
}

async function existingArtifact(path, expectedContent) {
  try {
    const actualContent = await readFile(path, "utf8");
    if (actualContent !== expectedContent) {
      throw new Error(`completion artifact conflicts with the typed submission: ${path}`);
    }
    return "matching";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function ensureArtifact(path, expectedContent) {
  const state = await existingArtifact(path, expectedContent);
  if (state === "matching") return;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, expectedContent, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // Another deterministic replay may have won the race. Accept only the
    // exact bytes we intended to persist; never replace or delete a conflict.
    await existingArtifact(path, expectedContent);
  }
}

export async function submitResearchFindings(expected, evidence, params) {
  const built = buildResearcherSubmission(expected, evidence, params);
  const sectionContent = built.section;
  const summaryContent = `${JSON.stringify(built.researcherReturn, null, 2)}\n`;
  const states = await Promise.all([
    existingArtifact(expected.sectionPath, sectionContent),
    existingArtifact(expected.summaryPath, summaryContent),
  ]);
  // Write sequentially. If the second write fails transiently, the first is an
  // exact recoverable artifact and a later replay can safely fill the missing
  // side. Existing conflicting bytes are never overwritten or removed.
  if (states[0] === "missing") await ensureArtifact(expected.sectionPath, sectionContent);
  if (states[1] === "missing") await ensureArtifact(expected.summaryPath, summaryContent);
  return built;
}
