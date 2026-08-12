/**
 * Deterministically persist one Report Reviewer scorecard.
 *
 * The Reviewer supplies a typed object through its child-only tool. This
 * module, rather than the model, owns JSON serialization, verdict stamping,
 * and quality report rendering.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { writeVerdict } from "./write-verdict.mjs";

export const REVIEW_RUBRICS = Object.freeze({
  R1: "题面回答",
  R2: "证据与全量表",
  R3: "维度/结构深度",
  R4: "指标丰富度",
  R5: "对比与拆解",
  R6: "一致性",
  R7: "范围忠实",
});

const RUBRIC_IDS = Object.keys(REVIEW_RUBRICS);
const SCORECARD_META_KEYS = ["summary", "hardBlockers", "issues", "repairHints"];

function normalizeObservedNestedEnvelope(input) {
  const scores = input?.scores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) return input;
  const nestedKeys = SCORECARD_META_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(scores, key));
  if (!nestedKeys.length) return input;
  const topLevelKeys = SCORECARD_META_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (topLevelKeys.length || nestedKeys.length !== SCORECARD_META_KEYS.length) {
    throw new Error("scorecard metadata must be either all top-level or all nested under scores, never mixed");
  }
  const allowedNestedKeys = new Set([...RUBRIC_IDS, ...SCORECARD_META_KEYS]);
  const unknownNestedKeys = Object.keys(scores).filter((key) => !allowedNestedKeys.has(key));
  if (unknownNestedKeys.length) {
    throw new Error(`scores contains unsupported fields: ${unknownNestedKeys.join(", ")}`);
  }
  return {
    ...input,
    scores: Object.fromEntries(RUBRIC_IDS.map((id) => [id, scores[id]])),
    ...Object.fromEntries(SCORECARD_META_KEYS.map((key) => [key, scores[key]])),
  };
}

function nonEmptyText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeTextList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => nonEmptyText(item, `${label}[${index}]`));
}

function normalizeIssue(issue, index) {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    throw new Error(`issues[${index}] must be an object`);
  }
  const severity = nonEmptyText(issue.severity, `issues[${index}].severity`);
  if (!new Set(["hard", "soft"]).has(severity)) {
    throw new Error(`issues[${index}].severity must be hard or soft`);
  }
  const rubric = nonEmptyText(issue.rubric, `issues[${index}].rubric`);
  if (!RUBRIC_IDS.includes(rubric)) {
    throw new Error(`issues[${index}].rubric must be R1-R7`);
  }
  return {
    severity,
    code: nonEmptyText(issue.code, `issues[${index}].code`),
    rubric,
    message: nonEmptyText(issue.message, `issues[${index}].message`),
    where: nonEmptyText(issue.where, `issues[${index}].where`),
  };
}

function normalizeHardBlocker(blocker, index) {
  if (!blocker || typeof blocker !== "object" || Array.isArray(blocker)) {
    throw new Error(`hardBlockers[${index}] must be an object`);
  }
  const rubric = nonEmptyText(blocker.rubric, `hardBlockers[${index}].rubric`);
  if (!RUBRIC_IDS.includes(rubric)) {
    throw new Error(`hardBlockers[${index}].rubric must be R1-R7`);
  }
  return {
    code: nonEmptyText(blocker.code, `hardBlockers[${index}].code`),
    rubric,
    message: nonEmptyText(blocker.message, `hardBlockers[${index}].message`),
    where: nonEmptyText(blocker.where, `hardBlockers[${index}].where`),
  };
}

function normalizeScanIssue(issue, severity) {
  if (typeof issue === "string") {
    return { severity, code: "QUALITY_SCAN", message: issue, where: "quality/scan.json" };
  }
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    return { severity, code: "QUALITY_SCAN", message: String(issue), where: "quality/scan.json" };
  }
  return { ...issue, severity };
}

export function normalizeReviewScorecard(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("scorecard must be an object");
  }
  input = normalizeObservedNestedEnvelope(input);
  if (!input.scores || typeof input.scores !== "object" || Array.isArray(input.scores)) {
    throw new Error("scores must contain R1-R7");
  }
  const scores = {};
  for (const id of RUBRIC_IDS) {
    const cell = input.scores[id];
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
      throw new Error(`scores.${id} must be an object`);
    }
    if (!Number.isInteger(cell.score) || cell.score < 0 || cell.score > 2) {
      throw new Error(`scores.${id}.score must be 0, 1, or 2`);
    }
    scores[id] = {
      score: cell.score,
      max: 2,
      name: REVIEW_RUBRICS[id],
      note: nonEmptyText(cell.note, `scores.${id}.note`),
    };
  }
  return {
    scores,
    summary: nonEmptyText(input.summary, "summary"),
    hardBlockers: (input.hardBlockers ?? []).map(normalizeHardBlocker),
    issues: (input.issues ?? []).map(normalizeIssue),
    repairHints: normalizeTextList(input.repairHints ?? [], "repairHints"),
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function issueLine(issue) {
  if (typeof issue === "string") return issue;
  const code = issue?.code ? `[${issue.code}] ` : "";
  const rubric = issue?.rubric ? `${issue.rubric} ` : "";
  const where = issue?.where ? `（${issue.where}）` : "";
  return `${code}${rubric}${issue?.message || JSON.stringify(issue)}${where}`;
}

function gateSourceLabel(source) {
  const requirement = source?.requirementId ? `/${source.requirementId}` : "";
  return `${source?.taskId || "unknown-task"}${requirement}`;
}

function requiredRubricLine(required, scores) {
  const actual = scores?.[required.rubric]?.score;
  const sources = required.sources.map(gateSourceLabel).join("、");
  return `- ${required.rubric}：要求 ≥ ${required.minScore}，实际 ${actual}（来源：${sources}）`;
}

function gateFailureRepairHint(failure) {
  const sources = failure.sources.map(gateSourceLabel).join("、");
  return `${failure.rubric} 动态任务门槛未达标（实际 ${failure.actualScore}，要求 ≥ ${failure.minScore}；任务：${sources}），请针对对应已完成 Researcher requirement 补强报告证据与结论后重新审核`;
}

export function renderQualityReport({ verdict, scan, summary, repairHints }) {
  const scoreRows = RUBRIC_IDS.map((id) => {
    const cell = verdict.scores[id];
    return `| ${id} | ${REVIEW_RUBRICS[id]} | ${cell.score} / 2 | ${markdownCell(cell.note)} |`;
  });
  const hardBlockers = Array.isArray(verdict.hardBlockers) && verdict.hardBlockers.length
    ? verdict.hardBlockers.map((issue) => `- ${issueLine(issue)}`)
    : ["- 无"];
  const issues = Array.isArray(verdict.issues) && verdict.issues.length
    ? verdict.issues.map((issue) => `- ${issueLine(issue)}`)
    : ["- 无"];
  const repairs = repairHints.length ? repairHints.map((hint) => `- ${hint}`) : ["- 无"];
  const requiredRubrics = Array.isArray(verdict.requiredRubrics) && verdict.requiredRubrics.length
    ? verdict.requiredRubrics.map((required) => requiredRubricLine(required, verdict.scores))
    : ["- 无（沿用基础门禁）"];
  const gateFailures = Array.isArray(verdict.gateFailures) && verdict.gateFailures.length
    ? verdict.gateFailures.map((failure) => `- ${failure.rubric}：实际 ${failure.actualScore} < 要求 ${failure.minScore}`)
    : ["- 无"];
  return [
    "# 质量审核报告",
    "",
    "## 结论",
    `- pass: ${verdict.pass}`,
    `- total: ${verdict.total} / 14`,
    `- 摘要：${summary}`,
    "",
    "## 评分表（R1–R7）",
    "| 编号 | 维度 | 得分 | 依据 |",
    "| --- | --- | ---: | --- |",
    ...scoreRows,
    "",
    "## 机械扫描",
    `- matched: ${Number(scan?.report?.matchedCount || 0)}`,
    `- unmatched: ${Number(scan?.report?.unmatchedCount || 0)}`,
    `- hard: ${Array.isArray(scan?.hardIssues) ? scan.hardIssues.length : 0}`,
    `- soft: ${Array.isArray(scan?.softIssues) ? scan.softIssues.length : 0}`,
    "",
    "## 动态任务门禁",
    ...requiredRubrics,
    "",
    "### 未达标项",
    ...gateFailures,
    "",
    "## Hard blockers",
    ...hardBlockers,
    "",
    "## Issues",
    ...issues,
    "",
    "## 建议修订",
    ...repairs,
    "",
  ].join("\n");
}

export async function submitReviewScorecard(resultPath, rawScorecard) {
  const absoluteResult = resolve(resultPath);
  if (basename(absoluteResult) !== "result.json") {
    throw new Error("resultPath must end with result.json");
  }
  await access(absoluteResult);
  const sessionDir = dirname(absoluteResult);
  const qualityDir = join(sessionDir, "quality");
  const scanPath = join(qualityDir, "scan.json");
  const draftPath = join(qualityDir, "verdict.draft.json");
  const reportPath = join(qualityDir, "report.md");
  const verdictPath = join(qualityDir, "verdict.json");
  const scorecard = normalizeReviewScorecard(rawScorecard);

  let scan;
  try {
    scan = JSON.parse(await readFile(scanPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read valid quality/scan.json: ${error.message || error}`);
  }
  if (!scan || typeof scan !== "object" || !Array.isArray(scan.hardIssues)) {
    throw new Error("quality/scan.json must contain hardIssues[]");
  }

  const scanHard = scan.hardIssues.map((issue) => normalizeScanIssue(issue, "hard"));
  const scanSoft = Array.isArray(scan.softIssues)
    ? scan.softIssues.map((issue) => normalizeScanIssue(issue, "soft"))
    : [];
  const draft = {
    version: 1,
    sourceAgent: "report-reviewer",
    scores: scorecard.scores,
    hardBlockers: [...scorecard.hardBlockers, ...scanHard],
    issues: scorecard.issues,
    softIssues: scanSoft,
    notes: scorecard.summary,
    checkedAt: new Date().toISOString(),
    scanPath: "quality/scan.json",
  };

  await mkdir(qualityDir, { recursive: true });
  await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`);
  const { verdict } = await writeVerdict(sessionDir, draft);
  const dynamicRepairHints = verdict.gateFailures.map(gateFailureRepairHint);
  const suppliedRepairHints = [...new Set([...scorecard.repairHints, ...dynamicRepairHints])];
  const repairHints = verdict.pass
    ? suppliedRepairHints
    : suppliedRepairHints.length
      ? suppliedRepairHints
      : ["按 verdict 的具体失分项修正报告后重新审核"];
  await writeFile(
    reportPath,
    renderQualityReport({ verdict, scan, summary: scorecard.summary, repairHints })
  );

  return {
    status: verdict.pass ? "passed" : "failed",
    pass: verdict.pass,
    total: verdict.total,
    maxTotal: 14,
    requiredRubrics: verdict.requiredRubrics,
    gateFailures: verdict.gateFailures,
    sessionDir,
    resultPath: absoluteResult,
    scanPath,
    reportPath,
    verdictPath,
    repairHints,
  };
}
