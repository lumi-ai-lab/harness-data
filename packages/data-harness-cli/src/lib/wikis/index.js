import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadPathsConfig, newPathResolverWithPaths } from "../harness.js";
import { runAllChecks, runCheck } from "./checks.js";
import { KIND_PLAYBOOK, KIND_SPEC, SPEC_TYPE_METRIC } from "./paths.js";
import { loadCorpus } from "./parse.js";
import { loadTemplateSelectionPolicy, validateTemplateSelectionPolicy } from "./template-selection.js";

export const INDEX_REL = ".harness/index/wikis-index.json";
export const RUNTIME_INDEX_REL = ".harness/index/wikis-runtime-index.json";

export function loadIndex(root) {
  const data = readFileSync(path.join(root, INDEX_REL), "utf8");
  return JSON.parse(data);
}

export function loadRuntimeIndex(root) {
  try {
    const data = readFileSync(path.join(root, RUNTIME_INDEX_REL), "utf8");
    return JSON.parse(data);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return buildRuntimeIndex(loadIndex(root));
    }
    throw error;
  }
}

export function buildRuntimeIndex(idx) {
  const docsByPath = {};
  for (const doc of idx.docs || []) {
    const runtimeDoc = {
      path: doc.path,
      kind: doc.kind,
      domain: doc.domain,
      specType: doc.specType,
      covers: doc.covers,
    };
    if (hasPlaybookRef(doc.playbook)) {
      runtimeDoc.playbook = { ...doc.playbook };
      if (doc.playbook?.intents) runtimeDoc.playbook.intents = { ...doc.playbook.intents };
    }
    docsByPath[doc.path] = runtimeDoc;
  }
  const recall = (idx.recall || []).map((item) => ({ term: item.term, targetPath: item.targetPath }));
  return {
    meta: idx.meta,
    docsByPath,
    recall,
    templateSelection: idx.templateSelection || [],
  };
}

function hasPlaybookRef(playbook) {
  if (!playbook || typeof playbook !== "object") return false;
  return Boolean(
    playbook.isSingle ||
      playbook.isCombo ||
      playbook.specPath ||
      playbook.templatePath ||
      (playbook.intents && Object.keys(playbook.intents).length),
  );
}

export class CheckFailedError extends Error {
  constructor(total) {
    super(`wikis check-all failed with ${total} error(s); index not updated`);
    this.total = total;
    this.name = "CheckFailedError";
  }
}

export function buildIndex(root, skipChecks = false) {
  if (!skipChecks) {
    const results = runAllChecks(root, { maxErrors: 500 });
    const total = results.reduce((sum, result) => sum + result.totalErrors, 0);
    if (total > 0) throw new CheckFailedError(total);
  }
  const reliable = checkReliableBuildInputs(root);
  if (reliable) throw new Error(reliable);
  const { corpus } = loadCorpus(root);
  const { policy: templatePolicy } = loadTemplateSelectionPolicy(root);
  const policyErrs = validateTemplateSelectionPolicy(root, templatePolicy);
  if (policyErrs.length) {
    throw new Error(`template selection policy invalid: ${policyErrs.join("; ")}`);
  }
  const cfg = loadPathsConfig(root);
  const idx = {
    meta: {
      version: 1,
      generatedAt: new Date().toISOString(),
      root,
      checksSkipped: skipChecks,
      paths: indexPaths(root, cfg),
    },
    docs: corpus.docs,
    recall: buildRecall(corpus.docs),
  };
  const runtime = buildRuntimeIndex(idx);
  runtime.templateSelection = [...(templatePolicy.templates || [])];
  writeJSONAtomic(root, INDEX_REL, idx);
  writeJSONAtomic(root, RUNTIME_INDEX_REL, runtime);
  return {
    path: INDEX_REL,
    runtimePath: RUNTIME_INDEX_REL,
    checksSkipped: skipChecks,
    docCount: idx.docs.length,
    recallCount: idx.recall.length,
    runtimeDocCount: Object.keys(runtime.docsByPath).length,
    runtimeRecallCount: runtime.recall.length,
  };
}

function checkReliableBuildInputs(root) {
  for (const name of ["check-frontmatter", "check-aliases", "check-covers"]) {
    const result = runCheck(root, name, { maxErrors: Number.MAX_SAFE_INTEGER });
    for (const checkErr of result.errors) {
      switch (checkErr.code) {
        case "invalid_frontmatter_type":
        case "invalid_covers_type":
        case "invalid_intents_type":
        case "invalid_intents_target":
        case "duplicate_intent_alias":
        case "duplicate_recall_value":
          return `${checkErr.path}: ${checkErr.code}: ${checkErr.message}`;
        default:
          break;
      }
    }
  }
  return "";
}

function indexPaths(root, cfg) {
  if (hasStructuredLayout(root, cfg)) {
    const knowledge = cfg.knowledge || ".";
    return {
      knowledge,
      metrics: joinKnowledgePath(knowledge, "metrics"),
      reports: joinKnowledgePath(knowledge, "reports"),
      dims: joinKnowledgePath(knowledge, "dims"),
      rules: joinKnowledgePath(knowledge, "rules"),
    };
  }
  const paths = { spec: cfg.spec, playbooks: cfg.playbooks, templates: cfg.templates };
  if (cfg.routing) paths.routing = cfg.routing;
  return paths;
}

function hasStructuredLayout(root, cfg) {
  try {
    const resolver = newPathResolverWithPaths(root, cfg);
    for (const logical of ["metrics", "reports", "dims", "rules"]) {
      const info = statSyncSafe(resolver.resolve(logical));
      if (!info?.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function joinKnowledgePath(knowledge, name) {
  knowledge = String(knowledge || "").trim();
  if (!knowledge || knowledge === ".") return name;
  return `${knowledge.replace(/\/+$/, "")}/${name}`;
}

function buildRecall(docs) {
  const items = [];
  for (const doc of docs) {
    const values = recallValues(doc);
    for (const [field, list] of Object.entries(values)) {
      for (const value of list || []) {
        if (!value) continue;
        items.push({ term: value, targetPath: doc.path, sourceField: field, rule: "strict_contains" });
      }
    }
  }
  items.sort((a, b) => {
    if (a.term !== b.term) return a.term < b.term ? -1 : 1;
    if (a.targetPath !== b.targetPath) return a.targetPath < b.targetPath ? -1 : 1;
    return a.sourceField < b.sourceField ? -1 : a.sourceField > b.sourceField ? 1 : 0;
  });
  return items;
}

function recallValues(doc) {
  const out = {};
  if (doc.kind === KIND_SPEC) {
    if (doc.specType === SPEC_TYPE_METRIC || doc.name || doc.label || (doc.aliases && doc.aliases.length)) {
      out.name = [doc.name || ""];
      out.label = [doc.label || ""];
      out.aliases = doc.aliases || [];
    }
  }
  if (doc.kind === KIND_PLAYBOOK && doc.playbook?.isCombo) {
    out.aliases = doc.aliases || [];
  }
  return out;
}

function writeJSONAtomic(root, rel, value) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = path.join(path.dirname(full), `${path.basename(rel)}.tmp.${process.pid}`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, full);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
}

function statSyncSafe(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}
