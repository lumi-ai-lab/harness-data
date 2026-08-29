import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { newPathResolver } from "../harness.js";
import {
  isStructuredPath,
  KIND_PLAYBOOK,
  KIND_SPEC,
  KIND_TEMPLATE,
  samePath,
  SPEC_TYPE_CONCEPT,
  SPEC_TYPE_METRIC,
} from "./paths.js";

const ALLOWED_FRONTMATTER = new Set([
  "name",
  "label",
  "aliases",
  "negative_aliases",
  "covers",
  "intents",
  "canonical_status",
  "canonical_group",
  "canonical_target",
  "canonical_reason",
]);

export const KIND_SPEC_INDEX = "spec_index";
export const KIND_PLAYBOOK_INDEX = "playbook_index";
export const KIND_TEMPLATE_INDEX = "template_index";

export function loadCorpus(root) {
  return loadCorpusWithOptions(root, {});
}

export function loadCorpusWithOptions(root, opts = {}) {
  const resolver = newPathResolver(root);
  const paths = collectCorpusMarkdown(resolver);
  const specSet = {};
  for (const p of paths) {
    if (isSpecDocPath(p)) specSet[p] = true;
  }
  const docs = [];
  const errs = [];
  for (const logical of paths) {
    const parsed = parseDocument(resolver, logical, specSet);
    errs.push(...parsed.errs);
    docs.push(parsed.doc);
    if (opts.failFastParse && hasSelectedParseErr(parsed.errs, opts.parseCodes)) break;
  }
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = Object.fromEntries(docs.map((doc) => [doc.path, doc]));
  return { corpus: { root, docs, byPath, specPaths: specSet }, errs };
}

function hasSelectedParseErr(errs, codes) {
  if (!errs.length) return false;
  if (!codes) return true;
  return errs.some((err) => codes.has(err.code));
}

export function parseDocument(resolver, logical, specSet) {
  const physicalRel = resolver.resolveRel(logical);
  const data = readFileSync(path.join(resolver.root, physicalRel));
  const { fm, errs: fmErrs } = parseFrontmatter(logical, data.toString("utf8"));
  const { title, h1Count } = parseH1(data);
  const doc = {
    id: logical.replace(/\.md$/, ""),
    path: logical,
    physicalRel,
    kind: inferKind(logical),
    domain: inferDomain(logical),
    title,
    isIndex: path.posix.basename(logical) === "index.md",
    hasFrontmatter: fm.present,
    playbook: {},
    template: {},
  };
  if (doc.kind === KIND_SPEC && !doc.isIndex) doc.specType = inferSpecType(logical);
  if (doc.kind === KIND_PLAYBOOK && !doc.isIndex) {
    const specPath = samePath(logical, "spec");
    const templatePath = samePath(logical, "templates");
    doc.playbook.specPath = specPath;
    doc.playbook.templatePath = templatePath;
    if (specSet[specPath] && inferSpecType(specPath) === SPEC_TYPE_METRIC) doc.playbook.isSingle = true;
  }
  if (doc.kind === KIND_TEMPLATE && !doc.isIndex) {
    doc.template.playbookPath = samePath(logical, "playbooks");
    doc.template.isReport = true;
  }
  if (fm.present) {
    if (typeof fm.fields.name === "string") doc.name = fm.fields.name;
    if (typeof fm.fields.label === "string") doc.label = fm.fields.label;
    if (Array.isArray(fm.fields.aliases)) doc.aliases = fm.fields.aliases;
    if (Array.isArray(fm.fields.negative_aliases)) doc.negativeAliases = fm.fields.negative_aliases;
    if (Array.isArray(fm.fields.covers)) doc.covers = fm.fields.covers;
    if (fm.fields.intents) doc.playbook.intents = fm.fields.intents;
  }
  const errs = [...fmErrs];
  if (h1Count === 0) errs.push({ path: logical, code: "missing_h1", message: "missing H1 title" });
  else if (h1Count > 1) errs.push({ path: logical, code: "multiple_h1", message: "multiple H1 titles" });
  return { doc, errs };
}

function collectCorpusMarkdown(resolver) {
  const seen = new Set();
  const paths = [];
  const add = (logical) => {
    if (seen.has(logical)) return;
    seen.add(logical);
    paths.push(logical);
  };
  try {
    if (statSync(resolver.resolve("index.md")).isFile()) add("index.md");
  } catch {
    // missing
  }
  for (const prefix of ["spec", "playbooks", "templates", "metrics", "reports", "dims", "rules"]) {
    for (const logical of collectLogicalMarkdown(resolver, prefix)) add(logical);
  }
  paths.sort();
  return paths;
}

function collectLogicalMarkdown(resolver, prefix) {
  const base = resolver.knowledgePath(prefix);
  try {
    if (!statSync(base).isDirectory()) return [];
  } catch {
    return [];
  }
  const paths = [];
  walkMarkdown(base, resolver.root, resolver, paths);
  paths.sort();
  return paths;
}

function walkMarkdown(dir, root, resolver, paths) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    const info = statSync(file);
    if (info.isDirectory()) {
      walkMarkdown(file, root, resolver, paths);
      continue;
    }
    if (!name.endsWith(".md")) continue;
    const rel = path.relative(root, file);
    paths.push(resolver.logicalRel(rel.split(path.sep).join("/")));
  }
}

export function inferKind(logical) {
  const isIndex = path.posix.basename(logical) === "index.md";
  if (logical === "index.md") return KIND_SPEC_INDEX;
  if (isStructuredSpecPath(logical) && isIndex) return KIND_SPEC_INDEX;
  if (isStructuredSpecPath(logical)) return KIND_SPEC;
  if (isStructuredPlaybookPath(logical)) return KIND_PLAYBOOK;
  if (isStructuredTemplatePath(logical)) return KIND_TEMPLATE;
  if (logical.startsWith("spec/") && isIndex) return KIND_SPEC_INDEX;
  if (logical.startsWith("spec/")) return KIND_SPEC;
  if (logical.startsWith("playbooks/") && isIndex) return KIND_PLAYBOOK_INDEX;
  if (logical.startsWith("playbooks/")) return KIND_PLAYBOOK;
  if (logical.startsWith("templates/") && isIndex) return KIND_TEMPLATE_INDEX;
  return KIND_TEMPLATE;
}

function inferDomain(logical) {
  if (logical === "index.md") return "";
  if (isStructuredPath(logical)) {
    const parts = logical.split("/");
    if (parts.length === 2 && parts[1] === "index.md") return "";
    if (parts.length >= 2) return parts[1];
    return "";
  }
  const slash = logical.indexOf("/");
  if (slash < 0) return "";
  const rest = logical.slice(slash + 1);
  if (path.posix.basename(rest) === "index.md") {
    const domain = path.posix.dirname(rest);
    return domain === "." ? "" : domain;
  }
  const domain = path.posix.dirname(rest);
  return domain === "." ? "" : domain;
}

export function isSpecDocPath(logical) {
  return inferKind(logical) === KIND_SPEC && path.posix.basename(logical) !== "index.md";
}

export function inferSpecType(logical) {
  if (logical.startsWith("metrics/")) return SPEC_TYPE_METRIC;
  if (logical.startsWith("reports/") || logical.startsWith("dims/") || logical.startsWith("rules/")) return SPEC_TYPE_CONCEPT;
  const base = path.posix.basename(logical);
  if (base.startsWith("c-") || base.startsWith("r-")) return SPEC_TYPE_CONCEPT;
  return SPEC_TYPE_METRIC;
}

function isStructuredSpecPath(logical) {
  const base = path.posix.basename(logical);
  if (base === "spec.md") return isStructuredPath(logical);
  return base === "index.md" && isStructuredPath(logical);
}

function isStructuredPlaybookPath(logical) {
  return isStructuredPath(logical) && path.posix.basename(logical) === "playbook.md";
}

function isStructuredTemplatePath(logical) {
  return isStructuredPath(logical) && path.posix.basename(logical) === "template.md";
}

function parseH1(data) {
  const text = stripFrontmatter(data.toString("utf8"));
  let count = 0;
  let title = "";
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      count += 1;
      if (!title) title = trimmed.slice(2).trim();
    }
  }
  return { title, h1Count: count };
}

function stripFrontmatter(text) {
  const lines = text.split("\n");
  if (!lines.length || lines[0].trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return text;
}

export function frontmatterAliasFields(text) {
  const { fm } = parseFrontmatter("", text);
  return {
    aliases: Array.isArray(fm.fields.aliases) ? fm.fields.aliases : [],
    negativeAliases: Array.isArray(fm.fields.negative_aliases) ? fm.fields.negative_aliases : [],
  };
}

export function stripFrontmatterText(text) {
  return stripFrontmatter(text);
}

function parseFrontmatter(logical, text) {
  const lines = text.split("\n");
  if (!lines.length || lines[0].trim() !== "---") return { fm: { present: false, fields: {} }, errs: [] };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return {
      fm: { present: true, fields: {} },
      errs: [{ path: logical, code: "invalid_frontmatter_type", message: "unterminated frontmatter" }],
    };
  }
  const fm = { present: true, fields: {} };
  const errs = [];
  for (let i = 1; i < end; i++) {
    const raw = lines[i].replace(/[ \t]+$/, "");
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("- ")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent !== 0) continue;
    const cut = trimmed.indexOf(":");
    if (cut < 0) {
      errs.push({ path: logical, code: "invalid_frontmatter_type", message: `invalid frontmatter line: ${trimmed}` });
      continue;
    }
    const key = trimmed.slice(0, cut).trim();
    const value = trimmed.slice(cut + 1).trim();
    if (!ALLOWED_FRONTMATTER.has(key)) {
      errs.push({ path: logical, code: "unknown_frontmatter_field", message: "unknown frontmatter field", target: key });
      continue;
    }
    const cursor = { i };
    if (["name", "label", "canonical_status", "canonical_group", "canonical_target", "canonical_reason"].includes(key)) {
      if (!value || value.startsWith("[")) {
        errs.push({ path: logical, code: "invalid_frontmatter_type", message: "frontmatter field must be a string", target: key });
        continue;
      }
      fm.fields[key] = cleanScalar(value);
    } else if (key === "aliases" || key === "negative_aliases" || key === "covers") {
      const values = parseStringArray(lines, cursor, end, value);
      if (!values) {
        errs.push({
          path: logical,
          code: key === "covers" ? "invalid_covers_type" : "invalid_frontmatter_type",
          message: "frontmatter field must be a string array",
          target: key,
        });
        continue;
      }
      fm.fields[key] = values;
      i = cursor.i;
    } else if (key === "intents") {
      const intents = parsePlaybookIntents(lines, cursor, end, value);
      if (!intents) {
        errs.push({ path: logical, code: "invalid_frontmatter_type", message: "frontmatter field must be an intents map", target: key });
        continue;
      }
      fm.fields[key] = intents;
      i = cursor.i;
    }
  }
  return { fm, errs };
}

function parsePlaybookIntents(lines, cursor, end, value) {
  if (value !== "") return null;
  const out = {};
  while (cursor.i + 1 < end) {
    const next = lines[cursor.i + 1];
    const trimmed = next.trim();
    if (!trimmed) {
      cursor.i += 1;
      continue;
    }
    const indent = next.length - next.trimStart().length;
    if (indent === 0) break;
    if (indent !== 2) return null;
    const cut = trimmed.indexOf(":");
    if (cut < 0 || !trimmed.slice(0, cut).trim() || trimmed.slice(cut + 1).trim() !== "") return null;
    const intentName = cleanScalar(trimmed.slice(0, cut));
    cursor.i += 1;
    const intent = { aliases: null };
    let sawField = false;
    while (cursor.i + 1 < end) {
      const fieldLine = lines[cursor.i + 1];
      const fieldTrimmed = fieldLine.trim();
      if (!fieldTrimmed) {
        cursor.i += 1;
        continue;
      }
      const fieldIndent = fieldLine.length - fieldLine.trimStart().length;
      if (fieldIndent <= 2) break;
      if (fieldIndent !== 4) return null;
      const fieldCut = fieldTrimmed.indexOf(":");
      if (fieldCut < 0) return null;
      const fieldKey = fieldTrimmed.slice(0, fieldCut).trim();
      const fieldValue = fieldTrimmed.slice(fieldCut + 1).trim();
      if (fieldKey !== "aliases") return null;
      const values = parseIndentedStringArray(lines, cursor, end, fieldValue, fieldIndent);
      if (!values) return null;
      intent.aliases = values;
      sawField = true;
    }
    if (!sawField || intent.aliases == null) return null;
    out[intentName] = intent;
  }
  return out;
}

function parseIndentedStringArray(lines, cursor, end, value, parentIndent) {
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) return null;
    const inner = value.slice(1, -1).trim();
    cursor.i += 1;
    if (!inner) return [];
    return inner.split(",").map((part) => cleanScalar(part));
  }
  if (value !== "") return null;
  cursor.i += 1;
  const out = [];
  while (cursor.i + 1 < end) {
    const next = lines[cursor.i + 1];
    const trimmed = next.trim();
    if (!trimmed) {
      cursor.i += 1;
      continue;
    }
    const indent = next.length - next.trimStart().length;
    if (indent <= parentIndent) break;
    if (!trimmed.startsWith("- ")) return null;
    out.push(cleanScalar(trimmed.slice(2)));
    cursor.i += 1;
  }
  return out;
}

function parseStringArray(lines, cursor, end, value) {
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) return null;
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => cleanScalar(part));
  }
  if (value !== "") return null;
  const out = [];
  while (cursor.i + 1 < end) {
    const next = lines[cursor.i + 1];
    const trimmed = next.trim();
    if (!trimmed) {
      cursor.i += 1;
      continue;
    }
    const indent = next.length - next.trimStart().length;
    if (indent === 0) break;
    if (!trimmed.startsWith("- ")) return null;
    out.push(cleanScalar(trimmed.slice(2)));
    cursor.i += 1;
  }
  return out;
}

function cleanScalar(s) {
  s = s.trim();
  const hash = s.indexOf(" #");
  if (hash >= 0) s = s.slice(0, hash).trim();
  return s.replace(/^["']|["']$/g, "");
}
