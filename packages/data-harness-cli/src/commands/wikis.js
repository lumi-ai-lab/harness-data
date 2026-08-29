import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";
import { printJSON } from "../lib/json-out.js";
import { buildWithRuntimeIndex, recallMatches } from "../lib/context/build.js";
import { ngrams, normalizeChinese } from "../lib/retrieval.js";
import {
  buildAliasesReport,
  checkAliasesQualityFile,
  exportAliases,
  exportAliasesLite,
  importAliases,
  lintAliasesFile,
  marshalAliasesJSON,
  marshalAliasesLiteJSON,
  writeAliasesLiteYAML,
  writeAliasesYAML,
} from "../lib/wikis/aliases.js";
import {
  buildMetricDuplicatesReport,
  exportMetricDuplicates,
  exportMetricDuplicatesLite,
  importMetricDuplicates,
  lintMetricDuplicatesFile,
  marshalMetricDuplicatesJSON,
  writeMetricDuplicatesLiteYAML,
  writeMetricDuplicatesYAML,
} from "../lib/wikis/metric-duplicates.js";
import { makeCheckResult, runAllChecks, runCheck } from "../lib/wikis/checks.js";
import { buildIndex, CheckFailedError, loadRuntimeIndex } from "../lib/wikis/index.js";
import { syncIndexMD } from "../lib/wikis/sync-index-md.js";
import { buildTemplateDoctor, templateDoctorJSON } from "../lib/wikis/template-selection.js";

const USAGE =
  "usage: data-harness-cli wikis <check-index-md|check-titles|check-frontmatter|check-aliases|check-covers|check-links|check-context|context-stats|recall-debug|templates|aliases|metric-duplicates|check-all|build-index|sync-index-md>";

const SIMPLE_CHECKS = new Set([
  "check-index-md",
  "check-titles",
  "check-frontmatter",
  "check-aliases",
  "check-covers",
  "check-links",
]);

export async function runWikis(root, args, io = process, context = null) {
  const rootOrContext = context || root;
  if (args.length < 1) throw new ExitError(USAGE, { code: 2 });
  const name = args[0];
  if (SIMPLE_CHECKS.has(name)) {
    const result = runSingleWikiCheck(root, name, args.slice(1), io);
    if (result.totalErrors > 0) {
      throw new ExitError(`${name} failed with ${result.totalErrors} error(s)`, { code: 1, silent: true });
    }
    return;
  }
  switch (name) {
    case "check-context": {
      const result = runWikiCheckContext(rootOrContext, args.slice(1), io);
      if (result.totalErrors > 0) {
        throw new ExitError(`${result.check} failed with ${result.totalErrors} error(s)`, { code: 1, silent: true });
      }
      return;
    }
    case "context-stats":
      return runWikiContextStats(rootOrContext, args.slice(1), io);
    case "recall-debug":
      return runWikiRecallDebug(rootOrContext, args.slice(1), io);
    case "templates":
      return runWikiTemplates(rootOrContext, args.slice(1), io);
    case "aliases":
      return runWikiAliases(root, args.slice(1), io);
    case "metric-duplicates":
      return runWikiMetricDuplicates(root, args.slice(1), io);
    case "check-all": {
      const results = runWikiCheckAll(root, args.slice(1), io);
      const total = results.reduce((sum, result) => sum + result.totalErrors, 0);
      if (total > 0) {
        throw new ExitError(`check-all failed with ${total} error(s)`, { code: 1, silent: true });
      }
      return;
    }
    case "build-index":
      return runBuildIndex(root, args.slice(1), io);
    case "sync-index-md":
      return runWikiSyncIndexMD(root, args.slice(1), io);
    default:
      throw new ExitError(`unknown wikis command: ${name}`, { code: 2 });
  }
}

function runSingleWikiCheck(root, name, args, io) {
  const parsed = parseFlags(args, {
    json: { type: "boolean", default: false },
    "max-errors": { type: "number", default: 100 },
    "fail-fast": { type: "boolean", default: false },
  });
  if (parsed.rest.length) throw new ExitError(`${name} does not accept positional arguments`, { code: 2 });
  const result = runCheck(root, name, {
    maxErrors: parsed.values["max-errors"],
    failFast: parsed.values["fail-fast"],
  });
  if (parsed.values.json) printJSON(checkJSONEnvelope([result]), io.stdout);
  else printCheckResult(result, io);
  return result;
}

function runWikiCheckAll(root, args, io) {
  const parsed = parseFlags(args, {
    json: { type: "boolean", default: false },
    "max-errors": { type: "number", default: 500 },
    "fail-fast": { type: "boolean", default: false },
  });
  if (parsed.rest.length) throw new ExitError("check-all does not accept positional arguments", { code: 2 });
  const results = runAllChecks(root, {
    maxErrors: parsed.values["max-errors"],
    failFast: parsed.values["fail-fast"],
  });
  if (parsed.values.json) printJSON(checkJSONEnvelope(results), io.stdout);
  else for (const result of results) printCheckResult(result, io);
  return results;
}

function runWikiCheckContext(root, args, io) {
  const checkName = "check-context";
  const parsed = parseFlags(args, {
    json: { type: "boolean", default: false },
    "max-errors": { type: "number", default: 100 },
    "fail-fast": { type: "boolean", default: false },
    "max-files": { type: "number", default: 10 },
  });
  if (parsed.rest.length) throw new ExitError(`${checkName} does not accept positional arguments`, { code: 2 });
  if (parsed.values["max-files"] < 0) throw new ExitError("--max-files must be >= 0", { code: 2 });
  const index = loadRuntimeIndex(root);
  const seen = new Set();
  const errs = [];
  for (const item of index.recall || []) {
    if (!item.term || !item.targetPath) continue;
    const key = `${item.term}\0${item.targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { response, plan } = buildWithRuntimeIndex(root, item.term, index);
    const count = response.contextFiles.length;
    if (count <= parsed.values["max-files"]) continue;
    errs.push({
      check: checkName,
      path: item.targetPath,
      code: "context_files_exceeded",
      message: `contextFiles exceeds max-files: got ${count} > ${parsed.values["max-files"]}`,
      target: "term",
      value: item.term,
      other: `mode=${plan.mode}`,
    });
    if (parsed.values["fail-fast"]) break;
  }
  const result = makeCheckResult(checkName, errs, { maxErrors: parsed.values["max-errors"] });
  if (parsed.values.json) printJSON(checkJSONEnvelope([result]), io.stdout);
  else printCheckResult(result, io);
  return result;
}

function runWikiContextStats(root, args, io) {
  const parsed = parseFlags(args, {
    json: { type: "boolean", default: false },
    top: { type: "number", default: 20 },
  });
  if (parsed.rest.length) throw new ExitError("context-stats does not accept positional arguments", { code: 2 });
  if (parsed.values.top < 0) throw new ExitError("--top must be >= 0", { code: 2 });
  const index = loadRuntimeIndex(root);
  const stats = buildContextStats(root, index, parsed.values.top);
  if (parsed.values.json) printJSON(stats, io.stdout);
  else printContextStats(stats, io);
}

function buildContextStats(root, index, topN) {
  const seen = new Set();
  const entries = [];
  const distribution = new Map();
  for (const item of index.recall || []) {
    if (!item.term || !item.targetPath) continue;
    const key = `${item.term}\0${item.targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { response, plan } = buildWithRuntimeIndex(root, item.term, index);
    const count = response.contextFiles.length;
    distribution.set(count, (distribution.get(count) || 0) + 1);
    entries.push({
      term: item.term,
      targetPath: item.targetPath,
      mode: plan.mode,
      contextFiles: count,
    });
  }
  entries.sort((a, b) => {
    if (a.contextFiles !== b.contextFiles) return b.contextFiles - a.contextFiles;
    if (a.targetPath !== b.targetPath) return a.targetPath < b.targetPath ? -1 : 1;
    return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
  });
  const counts = entries.map((entry) => entry.contextFiles).sort((a, b) => a - b);
  const buckets = [...distribution.keys()]
    .sort((a, b) => a - b)
    .map((contextFiles) => ({ contextFiles, count: distribution.get(contextFiles) }));
  const top = topN > 0 && entries.length > topN ? entries.slice(0, topN) : entries;
  const result = { distribution: buckets, top };
  if (!counts.length) return result;
  result.total = counts.length;
  result.min = counts[0];
  result.p50 = percentileNearestRank(counts, 50);
  result.p90 = percentileNearestRank(counts, 90);
  result.p95 = percentileNearestRank(counts, 95);
  result.p99 = percentileNearestRank(counts, 99);
  result.max = counts[counts.length - 1];
  return result;
}

function percentileNearestRank(sorted, percentile) {
  if (!sorted.length) return 0;
  let rank = Math.floor((percentile * sorted.length + 99) / 100);
  if (rank < 1) rank = 1;
  if (rank > sorted.length) rank = sorted.length;
  return sorted[rank - 1];
}

function printContextStats(stats, io) {
  io.stdout.write(
    `context-stats total=${stats.total || 0} min=${stats.min || 0} p50=${stats.p50 || 0} p90=${stats.p90 || 0} p95=${stats.p95 || 0} p99=${stats.p99 || 0} max=${stats.max || 0}\n`,
  );
  io.stdout.write("\ncontextFiles\tcount\n");
  for (const bucket of stats.distribution || []) {
    io.stdout.write(`${bucket.contextFiles}\t${bucket.count}\n`);
  }
  if (!(stats.top || []).length) return;
  io.stdout.write("\ntop contextFiles:\n");
  for (const entry of stats.top) {
    io.stdout.write(`${entry.contextFiles}\t${entry.term}\t${entry.targetPath}\tmode=${entry.mode}\n`);
  }
}

function runWikiRecallDebug(root, args, io) {
  const parsed = parseFlags(args, {
    question: { type: "string", default: "" },
    top: { type: "number", default: 20 },
    json: { type: "boolean", default: false },
  });
  if (parsed.rest.length) throw new ExitError("recall-debug does not accept positional arguments", { code: 2 });
  if (!parsed.values.question) throw new ExitError("recall-debug requires --question", { code: 2 });
  if (parsed.values.top < 0) throw new ExitError("--top must be >= 0", { code: 2 });
  const index = loadRuntimeIndex(root);
  const { response, plan } = buildWithRuntimeIndex(root, parsed.values.question, index);
  const normalizedQuestion = normalizeChinese(parsed.values.question);
  const result = {
    question: parsed.values.question,
    normalizedQuestion,
    queryBigrams: ngrams(normalizedQuestion, 2),
    queryTrigrams: ngrams(normalizedQuestion, 3),
    matches: recallMatches(index, parsed.values.question, parsed.values.top),
    plan: recallDebugPlanFromWikiPlan(plan),
    contextFiles: response.contextFiles,
  };
  if (parsed.values.json) printJSON(result, io.stdout);
  else printRecallDebug(result, io);
}

function recallDebugPlanFromWikiPlan(plan) {
  const out = { mode: plan.mode };
  if (plan.selectedPlaybook) out.selectedPlaybook = plan.selectedPlaybook;
  if (plan.selectedPlaybooks?.length) out.selectedPlaybooks = plan.selectedPlaybooks;
  if (plan.selectedTemplate) out.selectedTemplate = plan.selectedTemplate;
  if (plan.reason) out.reason = plan.reason;
  if (plan.candidates?.length) out.candidates = plan.candidates;
  if (plan.templateSelection && Object.keys(plan.templateSelection).length) out.templateSelection = plan.templateSelection;
  return out;
}

function printRecallDebug(result, io) {
  io.stdout.write(`question\t${result.question}\n`);
  io.stdout.write(`normalized\t${result.normalizedQuestion}\n`);
  io.stdout.write(`mode\t${result.plan.mode}\n`);
  if (result.plan.selectedPlaybook) io.stdout.write(`selectedPlaybook\t${result.plan.selectedPlaybook}\n`);
  if (result.plan.selectedTemplate) io.stdout.write(`selectedTemplate\t${result.plan.selectedTemplate}\n`);
  if (result.plan.reason) io.stdout.write(`reason\t${result.plan.reason}\n`);
  io.stdout.write("\nmatches:\n");
  for (const match of result.matches || []) {
    io.stdout.write(`${match.score}\t${match.term}\t${match.targetPath}\t${match.matchType}\n`);
  }
  io.stdout.write("\ncontextFiles:\n");
  for (const ref of result.contextFiles || []) {
    io.stdout.write(`${ref.path}\t${ref.reason}\n`);
  }
}

function runWikiTemplates(root, args, io) {
  if (args.length < 1) throw new ExitError("usage: data-harness-cli wikis templates <doctor|select-debug>", { code: 2 });
  if (args[0] === "select-debug") {
    const parsed = parseFlags(args.slice(1), {
      question: { type: "string", default: "" },
      json: { type: "boolean", default: false },
    });
    if (parsed.rest.length) throw new ExitError("templates select-debug does not accept positional arguments", { code: 2 });
    if (!parsed.values.question) throw new ExitError("templates select-debug requires --question", { code: 2 });
    const index = loadRuntimeIndex(root);
    const { response, plan } = buildWithRuntimeIndex(root, parsed.values.question, index);
    const result = {
      question: parsed.values.question,
      matches: recallMatches(index, parsed.values.question, 20),
      plan: recallDebugPlanFromWikiPlan(plan),
      contextFiles: response.contextFiles,
    };
    if (parsed.values.json) printJSON(result, io.stdout);
    else printTemplatesSelectDebug(result, io);
    return;
  }
  if (args[0] === "doctor") {
    const parsed = parseFlags(args.slice(1), {
      out: { type: "string", default: "" },
      json: { type: "boolean", default: false },
    });
    if (parsed.rest.length) throw new ExitError("templates doctor does not accept positional arguments", { code: 2 });
    let result;
    try {
      result = buildTemplateDoctor(root, parsed.values.out);
    } catch (error) {
      throw new ExitError(error.message || String(error), { code: 2 });
    }
    if (parsed.values.json) printJSON(templateDoctorJSON(result), io.stdout);
    else printTemplatesDoctor(result, io);
    if (result.status === "FAIL") {
      throw new ExitError(`templates doctor failed with ${result.errors.length} error(s)`, { code: 1 });
    }
    return;
  }
  throw new ExitError(`unknown wikis templates command: ${args[0]}`, { code: 2 });
}

function printTemplatesDoctor(result, io) {
  io.stdout.write(`templates doctor: ${result.status}\n`);
  io.stdout.write(`selection: ${result.selectionPath}\n`);
  io.stdout.write(`rules: ${(result.rules || []).length}\n`);
  for (const err of result.errors || []) io.stdout.write(`FAIL\t${err}\n`);
  for (const warning of result.warnings || []) io.stdout.write(`WARN\t${warning}\n`);
  if ((result.suggestions || []).length) {
    io.stdout.write(`suggestions: ${result.suggestions.length}\n`);
    for (const rule of result.suggestions) {
      io.stdout.write(`suggest\t${rule.id}\t${rule.playbook}\t${rule.template}\n`);
    }
  }
  if (result.suggestionWritten) io.stdout.write(`wrote ${result.suggestionPath}\n`);
}

function printTemplatesSelectDebug(result, io) {
  io.stdout.write(`question: ${result.question}\n`);
  io.stdout.write(`mode: ${result.plan.mode}\n`);
  if (result.plan.selectedPlaybook) io.stdout.write(`selectedPlaybook: ${result.plan.selectedPlaybook}\n`);
  if (result.plan.selectedTemplate) io.stdout.write(`selectedTemplate: ${result.plan.selectedTemplate}\n`);
  const selection = result.plan.templateSelection || {};
  if (!selection.status) io.stdout.write("templateSelection: none\n");
  else io.stdout.write(`templateSelection: ${selection.status} reason=${selection.reason || ""}\n`);
  for (const candidate of selection.candidates || []) {
    io.stdout.write(
      `candidate score=${candidate.score} priority=${candidate.priority || 0} template=${candidate.template} playbook=${candidate.playbook} covers=${(candidate.matchedCovers || []).join(",")} intents=${(candidate.matchedIntents || []).join(",")}\n`,
    );
  }
  io.stdout.write("contextFiles:\n");
  for (const ref of result.contextFiles || []) {
    io.stdout.write(`${ref.path}\t${ref.reason}\n`);
  }
}

function runWikiAliases(root, args, io) {
  if (args.length < 1) throw new ExitError("usage: data-harness-cli wikis aliases <report|export|lint|quality|import>", { code: 2 });
  switch (args[0]) {
    case "report": {
      const parsed = parseFlags(args.slice(1), { json: { type: "boolean", default: false } });
      if (parsed.rest.length) throw new ExitError("aliases report does not accept positional arguments", { code: 2 });
      const report = buildAliasesReport(root);
      if (parsed.values.json) printJSON(report, io.stdout);
      else {
        io.stdout.write(`spec files: ${report.specFiles}\n`);
        io.stdout.write(`spec with aliases: ${report.specWithAliases}\n`);
        io.stdout.write(`spec with negative_aliases: ${report.specWithNegativeAliases}\n\n`);
        io.stdout.write(`playbook files: ${report.playbookFiles}\n`);
        io.stdout.write(`playbook with aliases: ${report.playbookWithAliases}\n`);
        io.stdout.write(`playbook with negative_aliases: ${report.playbookWithNegativeAliases}\n\n`);
        io.stdout.write(`duplicate aliases: ${report.duplicateAliases}\n`);
        io.stdout.write(`label conflicts: ${report.duplicateLabels}\n`);
        io.stdout.write(`placeholder short docs: ${report.placeholderShortDocs}\n`);
      }
      return;
    }
    case "export": {
      const parsed = parseFlags(args.slice(1), {
        out: { type: "string", default: "" },
        format: { type: "string", default: "lite" },
        include: { type: "string", default: "spec,playbooks" },
        root: { type: "string", default: "wikis" },
      });
      if (parsed.rest.length) throw new ExitError("aliases export does not accept positional arguments", { code: 2 });
      if (!parsed.values.out) throw new ExitError("aliases export requires --out", { code: 2 });
      const include = splitCSV(parsed.values.include);
      switch (parsed.values.format) {
        case "lite":
        case "yaml":
        case "yml":
          writeAliasesLiteYAML(parsed.values.out, exportAliasesLite(root, include));
          return;
        case "full": {
          const data = exportAliases(root, include);
          data.root = parsed.values.root;
          writeAliasesYAML(parsed.values.out, data);
          return;
        }
        case "json": {
          const data = exportAliases(root, include);
          data.root = parsed.values.root;
          writeFile(parsed.values.out, marshalAliasesJSON(data));
          return;
        }
        case "lite-json":
          writeFile(parsed.values.out, marshalAliasesLiteJSON(exportAliasesLite(root, include)));
          return;
        default:
          throw new ExitError(`unsupported aliases export --format: ${parsed.values.format}`, { code: 2 });
      }
    }
    case "lint": {
      const parsed = parseFlags(args.slice(1), {
        file: { type: "string", default: "" },
        json: { type: "boolean", default: false },
      });
      if (parsed.rest.length) throw new ExitError("aliases lint does not accept positional arguments", { code: 2 });
      if (!parsed.values.file) throw new ExitError("aliases lint requires --file", { code: 2 });
      const result = lintAliasesFile(root, parsed.values.file);
      if (parsed.values.json) printJSON(result, io.stdout);
      else printAliasesLint(result, io);
      if (result.errors.length > 0) throw new ExitError(`aliases lint failed with ${result.errors.length} error(s)`, { code: 1 });
      return;
    }
    case "quality": {
      const parsed = parseFlags(args.slice(1), {
        file: { type: "string", default: "" },
        "min-length": { type: "number", default: 3 },
        "max-length": { type: "number", default: 40 },
        "require-aliases": { type: "boolean", default: false },
        "min-spec-aliases": { type: "number", default: 0 },
        "min-combo-playbook-aliases": { type: "number", default: 0 },
        json: { type: "boolean", default: false },
      });
      if (parsed.rest.length) throw new ExitError("aliases quality does not accept positional arguments", { code: 2 });
      if (!parsed.values.file) throw new ExitError("aliases quality requires --file", { code: 2 });
      const result = checkAliasesQualityFile(root, parsed.values.file, {
        minAliasRunes: parsed.values["min-length"],
        maxAliasRunes: parsed.values["max-length"],
        requireAliases: parsed.values["require-aliases"],
        minSpecAliases: parsed.values["min-spec-aliases"],
        minComboPlaybookAliases: parsed.values["min-combo-playbook-aliases"],
      });
      if (parsed.values.json) printJSON(result, io.stdout);
      else printAliasesLint(result, io);
      if (result.errors.length > 0) throw new ExitError(`aliases quality failed with ${result.errors.length} error(s)`, { code: 1 });
      return;
    }
    case "import": {
      const parsed = parseFlags(args.slice(1), {
        file: { type: "string", default: "" },
        apply: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      });
      if (parsed.rest.length) throw new ExitError("aliases import does not accept positional arguments", { code: 2 });
      if (!parsed.values.file) throw new ExitError("aliases import requires --file", { code: 2 });
      const result = importAliases(root, parsed.values.file, Boolean(parsed.values.apply));
      if (parsed.values.json) printJSON(result, io.stdout);
      else printAliasesImport(result, io);
      if (result.lint.errors.length > 0) {
        throw new ExitError(`aliases import failed lint with ${result.lint.errors.length} error(s)`, { code: 1 });
      }
      return;
    }
    default:
      throw new ExitError(`unknown wikis aliases command: ${args[0]}`, { code: 2 });
  }
}

function runWikiMetricDuplicates(root, args, io) {
  if (args.length < 1) throw new ExitError("usage: data-harness-cli wikis metric-duplicates <report|export|lint|import>", { code: 2 });
  switch (args[0]) {
    case "report": {
      const parsed = parseFlags(args.slice(1), { json: { type: "boolean", default: false } });
      if (parsed.rest.length) throw new ExitError("metric-duplicates report does not accept positional arguments", { code: 2 });
      const report = buildMetricDuplicatesReport(root);
      if (parsed.values.json) printJSON(report, io.stdout);
      else printMetricDuplicatesReport(report, io);
      return;
    }
    case "export": {
      const parsed = parseFlags(args.slice(1), {
        out: { type: "string", default: "" },
        format: { type: "string", default: "lite" },
        root: { type: "string", default: "wikis" },
      });
      if (parsed.rest.length) throw new ExitError("metric-duplicates export does not accept positional arguments", { code: 2 });
      if (!parsed.values.out) throw new ExitError("metric-duplicates export requires --out", { code: 2 });
      switch (parsed.values.format) {
        case "lite":
        case "yaml":
        case "yml": {
          const data = exportMetricDuplicatesLite(root);
          if (!(data.duplicates || []).length) return skipEmptyMetricDuplicatesExport(parsed.values.out, io);
          writeMetricDuplicatesLiteYAML(parsed.values.out, data);
          return;
        }
        case "full": {
          const data = exportMetricDuplicates(root, parsed.values.root);
          if (!(data.groups || []).length) return skipEmptyMetricDuplicatesExport(parsed.values.out, io);
          writeMetricDuplicatesYAML(parsed.values.out, data);
          return;
        }
        case "json": {
          const data = exportMetricDuplicates(root, parsed.values.root);
          if (!(data.groups || []).length) return skipEmptyMetricDuplicatesExport(parsed.values.out, io);
          writeFile(parsed.values.out, marshalMetricDuplicatesJSON(data));
          return;
        }
        default:
          throw new ExitError(`unsupported metric-duplicates export --format: ${parsed.values.format}`, { code: 2 });
      }
    }
    case "lint": {
      const parsed = parseFlags(args.slice(1), {
        file: { type: "string", default: "" },
        json: { type: "boolean", default: false },
      });
      if (parsed.rest.length) throw new ExitError("metric-duplicates lint does not accept positional arguments", { code: 2 });
      if (!parsed.values.file) throw new ExitError("metric-duplicates lint requires --file", { code: 2 });
      const result = lintMetricDuplicatesFile(root, parsed.values.file);
      if (parsed.values.json) printJSON(result, io.stdout);
      else printMetricDuplicatesLint(result, io);
      if (result.errors.length > 0) throw new ExitError(`metric-duplicates lint failed with ${result.errors.length} error(s)`, { code: 1 });
      return;
    }
    case "import": {
      const parsed = parseFlags(args.slice(1), {
        file: { type: "string", default: "" },
        apply: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      });
      if (parsed.rest.length) throw new ExitError("metric-duplicates import does not accept positional arguments", { code: 2 });
      if (!parsed.values.file) throw new ExitError("metric-duplicates import requires --file", { code: 2 });
      const result = importMetricDuplicates(root, parsed.values.file, Boolean(parsed.values.apply));
      if (parsed.values.json) printJSON(result, io.stdout);
      else printMetricDuplicatesImport(result, io);
      if (result.lint.errors.length > 0) {
        throw new ExitError(`metric-duplicates import failed lint with ${result.lint.errors.length} error(s)`, { code: 1 });
      }
      return;
    }
    default:
      throw new ExitError(`unknown wikis metric-duplicates command: ${args[0]}`, { code: 2 });
  }
}

function skipEmptyMetricDuplicatesExport(out, io) {
  try {
    rmSync(out);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  io.stdout.write(`no metric duplicates found; no export generated: ${out}\n`);
}

function printMetricDuplicatesReport(report, io) {
  io.stdout.write(`metric files scanned: ${report.metricFilesScanned}\n`);
  io.stdout.write(`duplicate label groups: ${report.duplicateLabelGroups}\n`);
  io.stdout.write(`duplicate chinese name groups: ${report.duplicateChineseGroups}\n`);
  io.stdout.write(`duplicate code groups: ${report.duplicateCodeGroups}\n`);
  io.stdout.write(`duplicate name groups: ${report.duplicateNameGroups}\n`);
  io.stdout.write(`duplicate basename groups: ${report.duplicateBasenameGroups}\n`);
  io.stdout.write(`cross-system duplicate groups: ${report.crossSystemGroups}\n`);
}

function printMetricDuplicatesLint(result, io) {
  for (const issue of result.errors || []) io.stdout.write(`ERROR ${issue.code} ${issue.message}\n`);
  for (const issue of result.warnings || []) io.stdout.write(`WARN ${issue.code} ${issue.message}\n`);
  if (!(result.errors || []).length && !(result.warnings || []).length) io.stdout.write("metric-duplicates lint ok\n");
}

function printMetricDuplicatesImport(result, io) {
  io.stdout.write(`applied: ${result.applied}\n`);
  io.stdout.write(`groups scanned: ${result.groupsScanned}\n`);
  io.stdout.write(`files to update: ${result.filesToUpdate}\n`);
}

function splitCSV(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function writeFile(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function printAliasesLint(result, io) {
  for (const issue of result.errors || []) {
    io.stdout.write(`ERROR ${issue.code}`);
    printAliasesIssue(issue, io);
  }
  for (const issue of result.warnings || []) {
    io.stdout.write(`WARN ${issue.code}`);
    printAliasesIssue(issue, io);
  }
  if (!(result.errors || []).length && !(result.warnings || []).length) io.stdout.write("aliases lint ok\n");
}

function printAliasesIssue(issue, io) {
  if (issue.item) io.stdout.write(` item=${issue.item}`);
  if (issue.field) io.stdout.write(` field=${issue.field}`);
  if (issue.value) io.stdout.write(` value=${issue.value}`);
  io.stdout.write(` ${issue.message}\n`);
}

function printAliasesImport(result, io) {
  io.stdout.write(`applied: ${result.applied}\n`);
  io.stdout.write(`files scanned: ${result.filesScanned}\n`);
  io.stdout.write(`files to update: ${result.filesToUpdate}\n`);
  io.stdout.write(`aliases added: ${result.aliasesAdded}\n`);
  io.stdout.write(`negative_aliases added: ${result.negativeAliasesAdded}\n`);
  for (const change of result.changes || []) {
    io.stdout.write(`${change.path}\n`);
  }
}

function runBuildIndex(root, args, io) {
  const parsed = parseFlags(args, {
    "skip-checks": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  });
  if (parsed.rest.length) throw new ExitError("build-index does not accept positional arguments", { code: 2 });
  if (parsed.values["skip-checks"]) {
    io.stderr.write("warning: building wikis index with --skip-checks; only hard reliability blockers will be enforced\n");
  }
  let result;
  try {
    result = buildIndex(root, Boolean(parsed.values["skip-checks"]));
  } catch (error) {
    if (error instanceof CheckFailedError) throw new ExitError(error.message, { code: 1 });
    throw new ExitError(error.message || error, { code: 2 });
  }
  if (parsed.values.json) {
    printJSON(result, io.stdout);
    return;
  }
  io.stdout.write(
    `built ${result.path} docs=${result.docCount} recall=${result.recallCount} runtime=${result.runtimePath} runtimeDocs=${result.runtimeDocCount} checksSkipped=${result.checksSkipped}\n`,
  );
}

function runWikiSyncIndexMD(root, args, io) {
  const parsed = parseFlags(args, {
    json: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
  });
  if (parsed.rest.length) throw new ExitError("sync-index-md does not accept positional arguments", { code: 2 });
  const result = syncIndexMD(root, Boolean(parsed.values.check));
  if (parsed.values.json) {
    printJSON(result, io.stdout);
    return;
  }
  if (parsed.values.check) {
    if (!(result.outdated || []).length) {
      io.stdout.write(`sync-index-md ok scanned=${result.scanned}\n`);
      return;
    }
    io.stdout.write(`sync-index-md outdated: total=${result.outdated.length} scanned=${result.scanned}\n`);
    for (const file of result.outdated) io.stdout.write(`${file}\toutdated\n`);
    io.stdout.write("run: bin/data-harness-cli wikis sync-index-md\n");
    throw new ExitError(`sync-index-md check failed with ${result.outdated.length} outdated file(s)`, { code: 1, silent: true });
  }
  io.stdout.write(`sync-index-md updated scanned=${result.scanned} changed=${(result.changed || []).length} created=${(result.created || []).length}\n`);
  for (const file of result.changed || []) io.stdout.write(`${file}\tchanged\n`);
  for (const file of result.created || []) io.stdout.write(`${file}\tcreated\n`);
}

function checkJSONEnvelope(results) {
  return {
    ok: results.every((result) => result.totalErrors === 0),
    totalErrors: results.reduce((sum, result) => sum + result.totalErrors, 0),
    results,
  };
}

function printCheckResult(result, io) {
  if (result.totalErrors === 0) {
    io.stdout.write(`${result.check} ok\n`);
    return;
  }
  io.stdout.write(
    `${result.check} failed: total=${result.totalErrors} shown=${result.shownErrors} hidden=${result.hiddenErrors} truncated=${result.truncated}\n`,
  );
  for (const err of result.errors) {
    let line = `${err.path}\t${err.code}\t${err.message}`;
    if (err.target) line += `\ttarget=${err.target}`;
    if (err.value) line += `\tvalue=${err.value}`;
    if (err.other) line += `\tother=${err.other}`;
    io.stdout.write(`${line}\n`);
  }
}
