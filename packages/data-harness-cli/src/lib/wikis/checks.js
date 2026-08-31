import path from "node:path";

import { isSpecDocPath, loadCorpusWithOptions } from "./parse.js";
import { isReferenceSpecPath, KIND_PLAYBOOK, KIND_SPEC, KIND_TEMPLATE, samePath, SPEC_TYPE_METRIC } from "./paths.js";

export const CHECK_INDEX_MD = "check-index-md";
export const CHECK_TITLES = "check-titles";
export const CHECK_FRONTMATTER = "check-frontmatter";
export const CHECK_ALIASES = "check-aliases";
export const CHECK_COVERS = "check-covers";
export const CHECK_LINKS = "check-links";

export const ALL_CHECK_NAMES = [
  CHECK_INDEX_MD,
  CHECK_TITLES,
  CHECK_FRONTMATTER,
  CHECK_ALIASES,
  CHECK_COVERS,
  CHECK_LINKS,
];

export function runCheck(root, name, opts = {}) {
  const corpusOpts = {};
  if (opts.failFast) {
    if (name === CHECK_TITLES) {
      corpusOpts.failFastParse = true;
      corpusOpts.parseCodes = new Set(["missing_h1", "multiple_h1"]);
    } else if (name === CHECK_FRONTMATTER) {
      corpusOpts.failFastParse = true;
      corpusOpts.parseCodes = new Set([
        "unknown_frontmatter_field",
        "invalid_frontmatter_type",
        "invalid_covers_type",
        "invalid_intents_type",
      ]);
    }
  }
  const { corpus, errs: parseErrs } = loadCorpusWithOptions(root, corpusOpts);
  let errs = [];
  switch (name) {
    case CHECK_INDEX_MD:
      errs = checkIndexMD(corpus, opts);
      break;
    case CHECK_TITLES:
      errs = filterParseErrs(parseErrs, ["missing_h1", "multiple_h1"]);
      break;
    case CHECK_FRONTMATTER:
      errs = filterParseErrs(parseErrs, ["unknown_frontmatter_field", "invalid_frontmatter_type", "invalid_covers_type"]);
      if (!(opts.failFast && errs.length > 0)) {
        errs = [...errs, ...checkFrontmatter(corpus, opts)];
      }
      break;
    case CHECK_ALIASES:
      errs = checkAliases(corpus, opts);
      break;
    case CHECK_COVERS:
      errs = checkCovers(corpus, opts);
      break;
    case CHECK_LINKS:
      errs = checkLinks(corpus, opts);
      break;
    default:
      throw new Error(`unknown wikis check: ${name}`);
  }
  if (opts.failFast && errs.length > 1) errs = errs.slice(0, 1);
  for (const err of errs) err.check = name;
  return makeCheckResult(name, errs, opts);
}

export function runAllChecks(root, opts = {}) {
  const results = [];
  const rawOpts = { ...opts, maxErrors: Number.MAX_SAFE_INTEGER };
  for (const name of ALL_CHECK_NAMES) {
    const result = runCheck(root, name, rawOpts);
    results.push(result);
    if (opts.failFast && result.totalErrors > 0) break;
  }
  return trimCheckAllResults(results, opts);
}

export function makeCheckResult(name, errs, opts = {}) {
  let limit = opts.maxErrors || 0;
  if (limit <= 0) limit = 100;
  let shown = errs;
  if (shown.length > limit) shown = shown.slice(0, limit);
  return {
    check: name,
    ok: errs.length === 0,
    totalErrors: errs.length,
    shownErrors: shown.length,
    hiddenErrors: errs.length - shown.length,
    truncated: errs.length > shown.length,
    errors: shown,
  };
}

function trimCheckAllResults(results, opts = {}) {
  let remaining = opts.maxErrors || 0;
  if (remaining <= 0) remaining = 500;
  for (const result of results) {
    let errors = result.errors;
    if (errors.length > remaining) errors = errors.slice(0, remaining);
    remaining -= errors.length;
    if (remaining < 0) remaining = 0;
    result.errors = errors;
    result.shownErrors = errors.length;
    result.hiddenErrors = result.totalErrors - errors.length;
    result.truncated = result.hiddenErrors > 0;
  }
  return results;
}

function filterParseErrs(errs, codes) {
  const allowed = new Set(codes);
  return errs.filter((err) => allowed.has(err.code));
}

function checkIndexMD(c, opts) {
  const dirs = new Set();
  for (const doc of c.docs) {
    if (doc.path.startsWith("routing/")) continue;
    let dir = path.posix.dirname(doc.path);
    while (dir !== "." && dir !== "") {
      dirs.add(dir);
      const parent = path.posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const keys = [...dirs].sort();
  const errs = [];
  for (const dir of keys) {
    const indexPath = `${dir}/index.md`;
    if (!c.byPath[indexPath]) {
      errs.push({ path: dir, code: "missing_index_md", message: "directory is missing index.md", target: indexPath });
      if (opts.failFast) return errs;
    }
  }
  return errs;
}

function checkFrontmatter(c, opts) {
  const errs = [];
  const add = (err) => {
    errs.push(err);
    return opts.failFast;
  };
  for (const doc of c.docs) {
    if (doc.kind === KIND_SPEC && doc.specType === SPEC_TYPE_METRIC) {
      if (!doc.hasFrontmatter) {
        if (add({ path: doc.path, code: "missing_frontmatter", message: "metric spec must have frontmatter" })) return errs;
        continue;
      }
      if (!doc.name) {
        if (add({ path: doc.path, code: "missing_name", message: "metric spec must have name", target: "name" })) return errs;
      }
      if (!doc.label) {
        if (add({ path: doc.path, code: "missing_label", message: "metric spec must have label", target: "label" })) return errs;
      }
    } else if (doc.kind === KIND_PLAYBOOK && doc.playbook?.isCombo) {
      if (!doc.hasFrontmatter) {
        if (add({ path: doc.path, code: "missing_frontmatter", message: "combo playbook must have frontmatter" })) return errs;
        continue;
      }
      if (!doc.aliases) {
        if (add({ path: doc.path, code: "missing_required_field", message: "combo playbook must have aliases", target: "aliases" })) return errs;
      }
      if (!doc.covers) {
        if (add({ path: doc.path, code: "missing_covers", message: "combo playbook must have covers", target: "covers" })) return errs;
      }
    }
    const intents = doc.playbook?.intents;
    if (intents && Object.keys(intents).length > 0) {
      if (doc.kind !== KIND_PLAYBOOK || !doc.playbook?.isSingle) {
        if (add({ path: doc.path, code: "invalid_intents_target", message: "intents are only allowed on single metric playbooks", target: "intents" })) {
          return errs;
        }
      }
      for (const [intentName, intent] of Object.entries(intents)) {
        if (!String(intentName).trim()) {
          if (add({ path: doc.path, code: "invalid_intents_type", message: "intent name must not be empty", target: "intents" })) return errs;
        }
        if (!intent?.aliases?.length) {
          if (add({ path: doc.path, code: "invalid_intents_type", message: "intent aliases must not be empty", target: `intents.${intentName}.aliases` })) {
            return errs;
          }
        }
        const seen = new Set();
        for (const alias of intent.aliases || []) {
          if (!String(alias).trim()) {
            if (add({ path: doc.path, code: "invalid_intents_type", message: "intent alias must not be empty", target: `intents.${intentName}.aliases` })) {
              return errs;
            }
          }
          if (seen.has(alias)) {
            if (add({ path: doc.path, code: "duplicate_intent_alias", message: "duplicate intent alias in playbook intent", target: `intents.${intentName}.aliases`, value: alias })) {
              return errs;
            }
          }
          seen.add(alias);
        }
      }
    }
  }
  return errs;
}

function checkAliases(c, opts) {
  const errs = [];
  const add = (err) => {
    errs.push(err);
    return opts.failFast;
  };
  const global = new Map();
  for (const doc of c.docs) {
    if (doc.kind === KIND_SPEC && doc.specType === SPEC_TYPE_METRIC) {
      if (!doc.name) {
        if (add({ path: doc.path, code: "missing_name", message: "metric spec must have name", target: "name" })) return errs;
      }
      if (!doc.label) {
        if (add({ path: doc.path, code: "missing_label", message: "metric spec must have label", target: "label" })) return errs;
      }
    }
    if (doc.kind === KIND_PLAYBOOK && doc.playbook?.isSingle && (doc.aliases || []).length > 0) {
      if (add({ path: doc.path, code: "alias_not_allowed", message: "single metric playbook must not maintain aliases", target: "aliases" })) {
        return errs;
      }
    }
    if (doc.kind === KIND_PLAYBOOK && doc.playbook?.isCombo && (doc.aliases || []).length === 0) {
      if (add({ path: doc.path, code: "missing_required_field", message: "combo playbook must maintain aliases", target: "aliases" })) {
        return errs;
      }
    }
    const seen = new Set();
    for (const alias of doc.aliases || []) {
      if (seen.has(alias)) {
        if (add({ path: doc.path, code: "duplicate_alias", message: "duplicate alias in document", value: alias })) return errs;
      }
      seen.add(alias);
    }
    for (const recall of orderedRecallValues(doc)) {
      for (const value of recall.values) {
        if (!value) continue;
        const other = global.get(value);
        if (other) {
          if (add({ path: doc.path, code: "duplicate_recall_value", message: "duplicate recall value", target: recall.field, value, other: other.path })) {
            return errs;
          }
        } else {
          global.set(value, { path: doc.path, target: recall.field });
        }
      }
    }
  }
  return errs;
}

function orderedRecallValues(doc) {
  const out = [];
  if (doc.kind === KIND_SPEC) {
    if (doc.specType === SPEC_TYPE_METRIC || doc.name || doc.label || (doc.aliases || []).length > 0) {
      out.push({ field: "name", values: [doc.name || ""] });
      out.push({ field: "label", values: [doc.label || ""] });
      out.push({ field: "aliases", values: doc.aliases || [] });
    }
  }
  if (doc.kind === KIND_PLAYBOOK && doc.playbook?.isCombo) {
    out.push({ field: "aliases", values: doc.aliases || [] });
  }
  return out;
}

function checkCovers(c, opts) {
  const errs = [];
  const add = (err) => {
    errs.push(err);
    return opts.failFast;
  };
  for (const doc of c.docs) {
    if (doc.kind !== KIND_PLAYBOOK || !doc.playbook?.isCombo) continue;
    if (!doc.covers) {
      if (add({ path: doc.path, code: "missing_covers", message: "combo playbook must maintain covers", target: "covers" })) return errs;
      continue;
    }
    for (const cover of doc.covers) {
      if (!isSpecDocPath(cover) || !cover.endsWith(".md")) {
        if (add({ path: doc.path, code: "invalid_cover_path", message: "cover must reference a spec logical path", value: cover })) return errs;
        continue;
      }
      if (!c.specPaths[cover]) {
        if (add({ path: doc.path, code: "missing_cover_target", message: "cover target does not exist", value: cover })) return errs;
      }
    }
  }
  return errs;
}

function checkLinks(c, opts) {
  const errs = [];
  const add = (err) => {
    errs.push(err);
    return opts.failFast;
  };
  for (const doc of c.docs) {
    if (doc.kind === KIND_SPEC && doc.specType === SPEC_TYPE_METRIC) {
      if (isReferenceSpecPath(doc.path)) continue;
      const playbookPath = samePath(doc.path, "playbooks");
      if (!c.byPath[playbookPath]) {
        if (add({ path: doc.path, code: "missing_playbook", message: "metric spec is missing same-path playbook", target: playbookPath })) {
          return errs;
        }
      }
    } else if (doc.kind === KIND_TEMPLATE && !doc.isIndex) {
      if (!c.byPath[doc.template?.playbookPath]) {
        if (add({ path: doc.path, code: "orphan_template", message: "template is missing same-path playbook", target: doc.template?.playbookPath })) {
          return errs;
        }
      }
    }
  }
  return errs;
}


