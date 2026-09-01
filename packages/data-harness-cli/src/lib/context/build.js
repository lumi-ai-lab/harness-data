import { statSync } from "node:fs";
import path from "node:path";

import { newPathResolver, newPathResolverWithPaths, pathsFromKnowledge } from "../harness.js";
import { search } from "../retrieval.js";
import { MODE_FREE, MODE_MULTI, MODE_REPORT, MODE_SINGLE } from "../sessionstate.js";
import { loadRuntimeIndex } from "../wikis/index.js";
import { isReferenceSpecPath, KIND_SPEC, samePath, SPEC_TYPE_CONCEPT, SPEC_TYPE_METRIC } from "../wikis/paths.js";

const MULTI_SINGLE_CANDIDATE_LIMIT = 20;

const CONSTRAINTS = [
  "values_must_come_from_cli",
  "do_not_estimate_missing_values",
  "do_not_write_report_file_unless_requested",
  "do_not_read_or_use_templates_unless_selectedTemplate_is_set",
  "Metric queries use qdm-metric-cli only; do not invent authentication or authorization flags; do not call qdm-cmr-cli, qdm-indicators-cli, qdm-sql-cli, or cas-cli",
];

export function build(root, question) {
  const { response } = buildWithPlan(root, question);
  return response;
}

export function buildWithPlan(root, question) {
  const index = loadRuntimeIndex(root);
  return buildWithRuntimeIndex(root, question, index);
}

export function buildWithRuntimeIndex(root, question, index) {
  const resolver = pathResolverForRuntimeIndex(root, index);
  return buildFromWikisRuntimeIndex(resolver, index, question);
}

function pathResolverForRuntimeIndex(root, index) {
  const cfg = pathsConfigFromIndex(index.meta?.paths);
  if (cfg) return newPathResolverWithPaths(root, cfg);
  return newPathResolver(root);
}

function pathsConfigFromIndex(paths) {
  if (!paths) return null;
  let cfg = {
    knowledge: String(paths.knowledge || "").trim(),
    spec: String(paths.spec || "").trim(),
    routing: String(paths.routing || "").trim(),
    playbooks: String(paths.playbooks || "").trim(),
    templates: String(paths.templates || "").trim(),
  };
  if (cfg.knowledge && (!cfg.spec || !cfg.playbooks || !cfg.templates)) {
    const derived = pathsFromKnowledge(cfg.knowledge);
    if (!cfg.spec) cfg.spec = derived.spec;
    if (!cfg.playbooks) cfg.playbooks = derived.playbooks;
    if (!cfg.templates) cfg.templates = derived.templates;
  }
  if (!cfg.spec || !cfg.playbooks || !cfg.templates) return null;
  return cfg;
}

function buildFromWikisRuntimeIndex(resolver, index, question) {
  const byPath = index.docsByPath || {};
  const refs = [];
  const seen = new Set();
  const add = (logical, reason) => {
    if (!logical) return;
    if (!runtimeDocExists(resolver, byPath, logical)) return;
    const physical = resolver.resolveRel(logical);
    if (seen.has(physical)) return;
    seen.add(physical);
    refs.push({ path: physical, reason });
  };

  let plan = { mode: MODE_FREE, reason: "no_recall_hit" };
  const matches = recallMatches(index, question, 0);
  let hits = recallHitsFromMatches(index, matches);
  let [ordinarySpecs, conceptSpecs] = classifyHits(hits);
  ordinarySpecs = collapseEquivalentMetricSpecs(ordinarySpecs);
  conceptSpecs = includeSpecificReportConcepts(byPath, question, conceptSpecs);
  sortRuntimeDocsByPath(ordinarySpecs);
  sortRuntimeDocsByPath(conceptSpecs);

  add("rules/qdm-metric-cli/spec.md", "default metric cli usage");
  for (const timeRule of [
    "rules/QDM 时间口径/spec.md",
    "rules/QDM 鏃堕棴鍙ｅ緞/spec.md",
    "rules/common/time-policy.md",
    "spec/common/time-policy.md",
  ]) {
    const before = refs.length;
    add(timeRule, "required time policy");
    if (refs.length > before) break;
  }

  const addDefaultFreeFiles = () => {
    add("index.md", "default knowledge index");
    add("metrics/index.md", "default metrics index");
    add("reports/index.md", "default reports index");
    add("dims/index.md", "default dims index");
    add("rules/index.md", "default rules index");
  };
  const selected = selectReportConcept(resolver, byPath, index.templateSelection || [], question, matches, conceptSpecs);
  const addSelectedReport = (item) => {
    plan = item.plan;
    addNearestIndex(add, byPath, item.spec.path, "report index");
    add(item.spec.path, "matched report spec");
    add(item.playbook.path, "selected report playbook");
  };

  if (selected && shouldPrioritizeReportConcept(question, selected)) {
    addSelectedReport(selected);
  } else if (ordinarySpecs.length === 1) {
    const spec = ordinarySpecs[0];
    if (isReferenceSpecPath(spec.path)) {
      plan.reason = "reference_spec";
      addFreeSpecFiles(add, byPath, [spec]);
    } else {
      const playbookPath = samePath(spec.path, "playbooks");
      if (runtimeDocExists(resolver, byPath, playbookPath)) {
        plan = { mode: MODE_SINGLE, selectedPlaybook: playbookPath };
        add(playbookPath, "selected playbook");
      } else {
        plan.reason = "single_spec_missing_playbook";
        addFreeSpecFiles(add, byPath, [spec]);
      }
    }
  } else if (ordinarySpecs.length > 1) {
    const multi = multiSingleCandidates(resolver, byPath, question, ordinarySpecs);
    if (multi.ok) {
      plan = { mode: MODE_MULTI, selectedPlaybooks: multi.candidates };
      for (const candidate of multi.candidates) add(candidate.path, "selected playbook");
    } else if (multi.reason === "multi_single_candidate_limit_exceeded") {
      // Fuzzy recall can flood siblings of one term (e.g. the "19点前*"
      // family) and blow past the candidate limit. Retry with only exact
      // recall matches so a genuine multi-metric question still gets its
      // playbooks instead of degrading to plain index files.
      const exactMulti = multiSingleCandidates(
        resolver,
        byPath,
        question,
        ordinarySpecs.filter((spec) => exactRecallMatchLen(matches, spec.path).exact),
      );
      if (exactMulti.ok) {
        plan = { mode: MODE_MULTI, selectedPlaybooks: exactMulti.candidates };
        for (const candidate of exactMulti.candidates) add(candidate.path, "selected playbook");
      } else {
        plan.reason = multi.reason;
        addDefaultFreeFiles();
      }
    } else {
      plan.reason = "multi_metric_non_direct";
      addFreeSpecFiles(add, byPath, ordinarySpecs);
    }
  } else if (conceptSpecs.length > 0) {
    if (selected) addSelectedReport(selected);
    else if (conceptSpecs.length === 1 && isReportSpecPath(conceptSpecs[0].path)) {
      const spec = conceptSpecs[0];
      if (!isReportIntentQuestion(question) && !hasExactRecallMatch(matches, spec.path)) {
        addDefaultFreeFiles();
      } else {
        plan.reason = "report_spec_missing_playbook";
        addNearestIndex(add, byPath, spec.path, "spec index");
        add(spec.path, "matched concept spec");
      }
    } else {
      plan.reason = "concept_only";
      for (const spec of conceptSpecs) {
        addNearestIndex(add, byPath, spec.path, "spec index");
        add(spec.path, "matched concept spec");
      }
    }
  } else {
    addDefaultFreeFiles();
  }

  plan.candidates = [...(plan.candidates || []), ...candidatesFromPlan(plan, byPath)];
  const response = {
    question,
    contextFiles: refs,
    instruction: instructionForPlan(plan),
    constraints: CONSTRAINTS,
  };
  return { response, plan };
}

function shouldPrioritizeReportConcept(question, selected) {
  if (selected.exact || selected.orgSpecific) return true;
  return (
    isReportIntentQuestion(question) &&
    selected.plan.templateSelection?.status === "selected" &&
    selected.plan.templateSelection?.reason === "covers_all_specs"
  );
}

function recallHitsFromMatches(index, matches) {
  const byPath = index.docsByPath || {};
  const seen = new Set();
  const docs = [];
  for (const match of matches) {
    if (seen.has(match.targetPath)) continue;
    const doc = byPath[match.targetPath];
    if (!doc) continue;
    seen.add(match.targetPath);
    docs.push(doc);
  }
  return docs;
}

function hasExactRecallMatch(matches, targetPath) {
  return matches.some((match) => match.targetPath === targetPath && match.exact);
}

function exactRecallMatchLen(matches, targetPath) {
  let exact = false;
  let maxLen = 0;
  for (const match of matches) {
    if (match.targetPath !== targetPath || !match.exact) continue;
    exact = true;
    if (match.termRuneLen > maxLen) maxLen = match.termRuneLen;
  }
  return { exact, maxLen };
}

export function recallMatches(index, question, top) {
  const items = (index.recall || []).map((item) => ({ term: item.term, targetPath: item.targetPath }));
  return search(items, question, { topN: top });
}

function classifyHits(hits) {
  const ordinarySpecs = [];
  const conceptSpecs = [];
  for (const doc of hits) {
    if (doc.kind === KIND_SPEC && doc.specType === SPEC_TYPE_METRIC) ordinarySpecs.push(doc);
    else if (doc.kind === KIND_SPEC && doc.specType === SPEC_TYPE_CONCEPT) conceptSpecs.push(doc);
  }
  return [ordinarySpecs, conceptSpecs];
}

function includeSpecificReportConcepts(byPath, question, specs) {
  for (const profitAnalysisSpec of profitAnalysisSpecPaths()) {
    if (!isOrganizationProfitSalesReportSpec(profitAnalysisSpec, question)) continue;
    if (hasRuntimeDoc(specs, profitAnalysisSpec)) return specs;
    const doc = byPath[profitAnalysisSpec];
    if (!doc || doc.kind !== KIND_SPEC || doc.specType !== SPEC_TYPE_CONCEPT) continue;
    return [...specs, doc];
  }
  return specs;
}

function hasRuntimeDoc(docs, docPath) {
  return docs.some((doc) => doc.path === docPath);
}

function sortRuntimeDocsByPath(docs) {
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function collapseEquivalentMetricSpecs(specs) {
  const byKey = new Map();
  for (const spec of specs) {
    const key = metricIdentityKey(spec.path);
    const existing = byKey.get(key);
    if (existing && preferMetricSpec(existing, spec)) continue;
    byKey.set(key, spec);
  }
  const out = [...byKey.values()];
  sortRuntimeDocsByPath(out);
  return out;
}

function metricIdentityKey(logical) {
  if (logical.startsWith("metrics/")) return path.posix.dirname(logical);
  return path.posix.basename(logical);
}

function preferMetricSpec(current, candidate) {
  const currentCmr = String(current.domain || "").startsWith("cmr/");
  const candidateCmr = String(candidate.domain || "").startsWith("cmr/");
  if (currentCmr !== candidateCmr) return currentCmr;
  return current.path < candidate.path;
}

function addNearestIndex(add, byPath, docPath, reason) {
  const dir = path.posix.dirname(docPath);
  if (dir === ".") return;
  const indexPath = path.posix.join(dir, "index.md");
  if (indexPath === docPath) return;
  if (byPath[indexPath]) add(indexPath, reason);
}

function addFreeSpecFiles(add, byPath, specs) {
  for (const spec of specs) {
    addNearestIndex(add, byPath, spec.path, "spec index");
    add(spec.path, "matched spec");
    if (isReferenceSpecPath(spec.path)) continue;
    const playbookPath = samePath(spec.path, "playbooks");
    if (byPath[playbookPath]) {
      addNearestIndex(add, byPath, playbookPath, "playbook index");
      add(playbookPath, "matched playbook");
    }
  }
}

function runtimeDocExists(resolver, byPath, logical) {
  if (!byPath[logical]) return false;
  try {
    const info = statSync(resolver.resolve(logical));
    return !info.isDirectory();
  } catch {
    return false;
  }
}

function isReportSpecPath(logical) {
  if (logical.startsWith("reports/")) return path.posix.basename(logical) === "spec.md";
  return logical.startsWith("spec/") && path.posix.basename(logical).startsWith("r-");
}

function isReportIntentQuestion(question) {
  return hasAny(question, ["报告", "诊断", "经营分析", "综合分析", "整体分析", "经营大盘", "业务大盘", "生成经营"]);
}

function selectReportConcept(resolver, byPath, rules, question, matches, specs) {
  const reportIntent = isReportIntentQuestion(question);
  const candidates = [];
  for (const spec of specs) {
    if (!isReportSpecPath(spec.path)) continue;
    const { exact, maxLen } = exactRecallMatchLen(matches, spec.path);
    const orgSpecific = isOrganizationProfitSalesReportSpec(spec.path, question);
    if (!reportIntent && !exact && !orgSpecific) continue;
    const playbookPath = samePath(spec.path, "playbooks");
    if (!runtimeDocExists(resolver, byPath, playbookPath)) continue;
    const playbook = byPath[playbookPath];
    const selection = selectTemplate(rules, question, [spec], playbookPath);
    let selectedTemplate = selectedTemplateFromDiagnostic(selection);
    if (!selectedTemplate && selection.status === "none" && selection.reason === "no_selection_policy") {
      selectedTemplate = existingPlaybookTemplatePath(resolver, byPath, playbook);
    }
    const { score, priority } = templateSelectionScore(selection);
    candidates.push({
      plan: {
        mode: MODE_REPORT,
        selectedPlaybook: playbookPath,
        selectedTemplate,
        templateSelection: selection,
      },
      spec,
      playbook,
      orgSpecific,
      exact,
      exactTermRuneLen: maxLen,
      templateScore: score,
      templatePriority: priority,
    });
  }
  if (candidates.length === 0) return null;
  if (!reportIntent && !candidates.some((c) => c.orgSpecific) && reportSpecCount(specs) > 1) return null;
  candidates.sort((a, b) => {
    if (a.orgSpecific !== b.orgSpecific) return a.orgSpecific ? -1 : 1;
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.exactTermRuneLen !== b.exactTermRuneLen) return b.exactTermRuneLen - a.exactTermRuneLen;
    if (a.templateScore !== b.templateScore) return b.templateScore - a.templateScore;
    if (a.templatePriority !== b.templatePriority) return b.templatePriority - a.templatePriority;
    return a.spec.path < b.spec.path ? -1 : a.spec.path > b.spec.path ? 1 : 0;
  });
  return candidates[0];
}

function reportSpecCount(specs) {
  return specs.filter((spec) => isReportSpecPath(spec.path)).length;
}

function isOrganizationProfitSalesReportSpec(specPath, question) {
  if (!profitAnalysisSpecPaths().includes(specPath)) return false;
  return hasAny(question, ["门店", "所有门店", "管理区域", "大区", "督导"]) && hasAny(question, ["盈利情况", "销售情况"]);
}

function profitAnalysisSpecPaths() {
  return ["reports/盈利情况分析报告/spec.md", "spec/indicators/business/r-profit-analysis-report.md"];
}

function templateSelectionScore(selection) {
  if (!selection.candidates?.length) return { score: 0, priority: 0 };
  return { score: selection.candidates[0].score, priority: selection.candidates[0].priority };
}

function multiSingleCandidates(resolver, byPath, question, specs) {
  if (specs.length < 2 || isNonDirectMultiSingleQuestion(question)) return { ok: false, candidates: [], reason: "" };
  const candidates = [];
  const playbooks = [];
  const seen = new Set();
  for (const spec of specs) {
    if (isReferenceSpecPath(spec.path)) return { ok: false, candidates: [], reason: "" };
    const playbookPath = samePath(spec.path, "playbooks");
    if (!runtimeDocExists(resolver, byPath, playbookPath)) return { ok: false, candidates: [], reason: "" };
    const doc = byPath[playbookPath];
    if (!doc || seen.has(doc.path)) continue;
    const candidate = candidateFromDoc(doc, "selected");
    candidate.template = "";
    candidates.push(candidate);
    playbooks.push(doc);
    seen.add(doc.path);
    if (candidates.length > MULTI_SINGLE_CANDIDATE_LIMIT) {
      return { ok: false, candidates: [], reason: "multi_single_candidate_limit_exceeded" };
    }
  }
  if (playbooks.length < 2) return { ok: false, candidates: [], reason: "" };
  candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ok: candidates.length >= 2, candidates, reason: "" };
}

function isNonDirectMultiSingleQuestion(question) {
  if (hasAny(question, ["为什么", "原因", "归因", "影响", "带动", "拖累", "波动", "下降", "上升", "下滑", "增长", "关系", "拆解", "概览", "报告"])) return true;
  // 分析 alone signals attribution/interpretation, but an explicit metric
  // enumeration (、/，/, separated) is still a direct multi-metric request.
  if (hasAny(question, ["分析"]) && !hasAny(question, ["、", "，", ","])) return true;
  return false;
}

function candidatesFromPlan(plan, byPath) {
  if (plan.mode === MODE_MULTI) return [...(plan.selectedPlaybooks || [])];
  if (!plan.selectedPlaybook) return [];
  const doc = byPath[plan.selectedPlaybook];
  if (!doc) return [];
  const candidate = candidateFromDoc(doc, "selected");
  candidate.template = plan.selectedTemplate || "";
  return [candidate];
}

function candidateFromDoc(doc, reason) {
  return {
    path: doc.path,
    template: playbookTemplatePath(doc),
    domain: doc.domain,
    reason,
  };
}

function existingPlaybookTemplatePath(resolver, byPath, doc) {
  const templatePath = playbookTemplatePath(doc);
  if (!templatePath || !runtimeDocExists(resolver, byPath, templatePath)) return "";
  return templatePath;
}

function playbookTemplatePath(doc) {
  return doc.playbook?.templatePath || "";
}

function selectedTemplateFromDiagnostic(selection) {
  if (selection.status !== "selected" || !selection.candidates?.length) return "";
  return selection.candidates[0].template;
}

function selectTemplate(rules, question, specs, playbookPath) {
  if (!rules?.length) return { status: "none", reason: "no_selection_policy" };
  const specPaths = Object.fromEntries(specs.map((spec) => [spec.path, true]));
  const questionIntents = inferTemplateQuestionIntents(question);
  const candidates = [];
  for (const rule of rules) {
    if (rule.playbook !== playbookPath) continue;
    const candidate = scoreTemplateSelectionRule(rule, specPaths, questionIntents);
    if (candidate.score <= 0) continue;
    candidates.push(candidate);
  }
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.template < b.template ? -1 : a.template > b.template ? 1 : 0;
  });
  if (candidates.length === 0) return { status: "none", reason: "no_candidate" };
  if (candidates.length > 1 && candidates[0].score === candidates[1].score && candidates[0].priority === candidates[1].priority) {
    return { status: "ambiguous", reason: "top_candidates_tied", candidates };
  }
  let statusReason = "best_score";
  if (coversAll(candidates[0].matchedCovers, specPaths)) statusReason = "covers_all_specs";
  return { status: "selected", reason: statusReason, candidates };
}

function scoreTemplateSelectionRule(rule, specPaths, questionIntents) {
  const candidate = {
    template: rule.template,
    playbook: rule.playbook,
    priority: rule.priority || 0,
    domain: rule.domain,
    type: rule.type,
    id: rule.id,
    matchedCovers: [],
    matchedIntents: [],
    score: 0,
  };
  for (const cover of rule.covers || []) {
    if (specPaths[cover]) candidate.matchedCovers.push(cover);
  }
  for (const intent of rule.intents || []) {
    if (questionIntents[intent]) candidate.matchedIntents.push(intent);
  }
  if (candidate.matchedCovers.length === 0 && candidate.matchedIntents.length === 0) return candidate;
  candidate.score = candidate.priority;
  candidate.score += candidate.matchedCovers.length * 100;
  candidate.score += candidate.matchedIntents.length * 20;
  if (coversAll(candidate.matchedCovers, specPaths)) candidate.score += 50;
  if (rule.type === "report" || rule.type === "composite") candidate.score += 10;
  candidate.matchedCovers.sort();
  candidate.matchedIntents.sort();
  return candidate;
}

function coversAll(covers, specPaths) {
  const keys = Object.keys(specPaths);
  if (keys.length === 0) return false;
  const covered = new Set(covers || []);
  return keys.every((spec) => covered.has(spec));
}

function inferTemplateQuestionIntents(question) {
  const intents = {};
  if (isReportIntentQuestion(question)) intents.report = true;
  if (hasAny(question, ["诊断", "原因", "归因", "分析", "为什么"])) intents.diagnosis = true;
  if (hasAny(question, ["趋势", "走势", "变化"])) intents.trend = true;
  if (hasAny(question, ["多少", "是多少", "当前", "现在", "查一下", "看一下"])) intents.current_value = true;
  return intents;
}

function instructionForPlan(plan) {
  const common =
    "All modes: read all contextFiles before running data CLI. Numeric values must come from CLI; do not estimate or invent. Deliver Harness analysis results, query results, reports, summaries, and diagnostic conclusions directly in the conversation by default. Do not write final results or intermediate analysis results to files unless the user explicitly asks to export, save, or generate a file. Use qdm-metric-cli as the only data-query CLI, and do not invent authentication or authorization flags.";
  switch (plan.mode) {
    case MODE_SINGLE:
      return `${common} Harness mode: single. selectedPlaybook=${plan.selectedPlaybook}. In single mode, only run data CLI commands explicitly described by selectedPlaybook. If the primary indicator command returns empty items or null values, do not switch to a broader report command unless selectedPlaybook explicitly says so; report the missing CLI evidence instead. Do not derive the primary metric by summing or transforming breakdown rows unless selectedPlaybook explicitly instructs it. After selected playbook data collection, answer the metric value directly with the CLI evidence. Do not run bin/data-harness-cli inject-template, and do not read, open, guess, or use template files.`;
    case MODE_MULTI:
      return `${common} Harness mode: multi_single. Read every selected playbook in contextFiles. Apply the same user-specified filters to each metric unless a playbook says otherwise. For each metric, default to current-value collection unless the question explicitly asks for a supported non-default entry such as trend or area performance. Answer with those per-metric results and shared口径. Do not run bin/data-harness-cli inject-template, do not use template files, and do not turn this into a report-style analysis.`;
    case MODE_REPORT: {
      let templateInstruction =
        "After report playbook data collection and evidence preparation, run bin/data-harness-cli stage template. Do not read, open, guess, or use template files before stage template. Only after the PostToolUse hook injects selectedTemplate may you generate the final report body.";
      if (!plan.selectedTemplate) {
        templateInstruction =
          "No selectedTemplate is available; after report playbook data collection, answer directly with CLI evidence and do not read, open, guess, or use template files.";
      }
      return `${common} Harness mode: report. selectedPlaybook=${plan.selectedPlaybook} selectedTemplate=${plan.selectedTemplate || ""}. Read the report index when present, the matched report spec, and the selected report playbook in contextFiles. Use the report index as the Agent knowledge directory, the report playbook for data collection and JSON handling, and the report spec for business reasoning. Do not run single-metric playbooks unless the selected report playbook explicitly asks for a drilldown. ${templateInstruction}`;
    }
    default:
      return `${common} Harness mode: free. reason=${plan.reason || ""}. Do not run bin/data-harness-cli inject-template. Do not read, open, guess, or use template files. You may reference specs/playbooks, but must not apply any template.`;
  }
}

function hasAny(s, keywords) {
  return keywords.some((kw) => kw && s.includes(kw));
}
