import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { newPathResolver } from "../harness.js";
import { isRegularFile, toSlash } from "../fs-utils.js";
import { cleanYAMLScalar, parseInlineYAMLArray, splitYAMLKV } from "./aliases.js";
import { inferKind, isSpecDocPath, loadCorpus } from "./parse.js";
import { KIND_PLAYBOOK, KIND_TEMPLATE, samePath } from "./paths.js";

export const TEMPLATE_SELECTION_LOGICAL_PATH = "reports/selection.yaml";
export const LEGACY_TEMPLATE_SELECTION_LOGICAL_PATH = "templates/selection.yaml";

export function loadTemplateSelectionPolicy(root) {
  const resolver = newPathResolver(root);
  let selectionPath = resolver.resolve(TEMPLATE_SELECTION_LOGICAL_PATH);
  let data;
  try {
    data = readFileSync(selectionPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      const wrap = new Error(error.message || String(error));
      wrap.cause = error;
      wrap.selectionPath = selectionPath;
      throw wrap;
    }
    selectionPath = resolver.resolve(LEGACY_TEMPLATE_SELECTION_LOGICAL_PATH);
    try {
      data = readFileSync(selectionPath);
    } catch (legacyError) {
      if (!legacyError || legacyError.code !== "ENOENT") {
        const wrap = new Error(legacyError.message || String(legacyError));
        wrap.cause = legacyError;
        wrap.selectionPath = selectionPath;
        throw wrap;
      }
      return {
        policy: { version: 1, templates: [] },
        selectionPath: resolver.resolve(TEMPLATE_SELECTION_LOGICAL_PATH),
      };
    }
  }
  const policy = parseTemplateSelectionYAML(data);
  if (policy.version === 0) policy.version = 1;
  return { policy, selectionPath };
}

export function parseTemplateSelectionYAML(data) {
  const policy = { version: 0, templates: [] };
  let current = null;
  let arrayField = "";
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].replace(/[ \t\r]+$/g, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!line.startsWith(" ") && trimmed.includes(":")) {
      const { key, value } = splitYAMLKeyValue(trimmed);
      switch (key) {
        case "version": {
          if (value === "") throw new Error(`selection.yaml:${lineNo} version must be scalar`);
          const version = parseYAMLInt(cleanYAMLScalar(value));
          if (version == null) throw new Error(`selection.yaml:${lineNo} invalid version`);
          policy.version = version;
          break;
        }
        case "templates":
          if (value !== "") throw new Error(`selection.yaml:${lineNo} templates must be a list`);
          break;
        default:
          throw new Error(`selection.yaml:${lineNo} unsupported key: ${key}`);
      }
      arrayField = "";
      continue;
    }
    if (trimmed.startsWith("- ")) {
      const content = trimmed.slice(2).trim();
      if (current && arrayField && !content.includes(":")) {
        appendTemplateSelectionArray(current, arrayField, cleanYAMLScalar(content));
        continue;
      }
      current = emptyTemplateSelectionRule();
      policy.templates.push(current);
      arrayField = "";
      if (content === "") continue;
      const { key, value } = splitYAMLKeyValue(content);
      if (!key) throw new Error(`selection.yaml:${lineNo} invalid template item`);
      setTemplateSelectionScalar(current, key, value, lineNo);
      continue;
    }
    if (!current) throw new Error(`selection.yaml:${lineNo} field outside template item`);
    const { key, value } = splitYAMLKeyValue(trimmed);
    if (!key) throw new Error(`selection.yaml:${lineNo} invalid field`);
    switch (key) {
      case "covers":
      case "intents":
        if (value === "") {
          arrayField = key;
          continue;
        }
        for (const item of parseInlineYAMLArray(value)) {
          appendTemplateSelectionArray(current, key, item);
        }
        arrayField = "";
        break;
      default:
        setTemplateSelectionScalar(current, key, value, lineNo);
        arrayField = "";
    }
  }
  return policy;
}

function splitYAMLKeyValue(line) {
  const kv = splitYAMLKV(line);
  if (!kv) return { key: "", value: "" };
  return kv;
}

function emptyTemplateSelectionRule() {
  return {
    id: "",
    playbook: "",
    template: "",
    type: "",
    domain: "",
    covers: [],
    intents: [],
    priority: 0,
  };
}

function setTemplateSelectionScalar(rule, key, value, lineNo) {
  value = cleanYAMLScalar(value);
  switch (key) {
    case "id":
      rule.id = value;
      return;
    case "playbook":
      rule.playbook = value;
      return;
    case "template":
      rule.template = value;
      return;
    case "type":
      rule.type = value;
      return;
    case "domain":
      rule.domain = value;
      return;
    case "priority": {
      if (value === "") throw new Error(`selection.yaml:${lineNo} priority must be numeric`);
      const priority = parseYAMLInt(value);
      if (priority == null) throw new Error(`selection.yaml:${lineNo} invalid priority`);
      rule.priority = priority;
      return;
    }
    default:
      throw new Error(`selection.yaml:${lineNo} unsupported template field: ${key}`);
  }
}

function appendTemplateSelectionArray(rule, key, value) {
  if (!value) return;
  if (key === "covers") rule.covers.push(value);
  if (key === "intents") rule.intents.push(value);
}

function parseYAMLInt(value) {
  if (!/^[+-]?\d+$/.test(String(value))) return null;
  return Number.parseInt(value, 10);
}

export function validateTemplateSelectionPolicy(root, policy) {
  let resolver;
  try {
    resolver = newPathResolver(root);
  } catch (error) {
    return [`path config error: ${error.message || error}`];
  }
  const errs = [];
  const ids = new Set();
  (policy.templates || []).forEach((rule, i) => {
    const prefix = `templates[${i}]`;
    if (!rule.id) errs.push(`${prefix}: id is required`);
    else if (ids.has(rule.id)) errs.push(`${prefix}: duplicate id ${rule.id}`);
    ids.add(rule.id);
    if (!rule.playbook || inferKind(rule.playbook) !== KIND_PLAYBOOK) {
      errs.push(`${prefix}: playbook must reference a playbook logical path`);
    } else if (!fileExists(resolver.resolve(rule.playbook))) {
      errs.push(`${prefix}: missing playbook ${rule.playbook}`);
    }
    if (!rule.template || !isAllowedTemplateSelectionPath(rule.template)) {
      errs.push(`${prefix}: template must use templates/... or reports/.../template.md`);
    } else if (!fileExists(resolver.resolve(rule.template))) {
      errs.push(`${prefix}: missing template ${rule.template}`);
    }
    if (rule.type !== "report" && rule.type !== "composite" && rule.type !== "single") {
      errs.push(`${prefix}: type must be report, composite, or single`);
    }
    for (const cover of rule.covers || []) {
      if (!isSpecDocPath(cover)) {
        errs.push(`${prefix}: cover must reference a spec logical path: ${cover}`);
      } else if (!fileExists(resolver.resolve(cover))) {
        errs.push(`${prefix}: missing cover ${cover}`);
      }
    }
    if ((rule.type === "report" || rule.type === "composite") && !(rule.covers || []).length && !(rule.intents || []).length) {
      errs.push(`${prefix}: report/composite must define covers or intents`);
    }
  });
  return errs;
}

export function buildTemplateDoctor(root, out = "") {
  const { policy, selectionPath } = loadTemplateSelectionPolicy(root);
  const errors = validateTemplateSelectionPolicy(root, policy);
  let suggestions = [];
  try {
    suggestions = suggestTemplateSelection(root, policy);
  } catch (error) {
    errors.push(error.message || String(error));
  }
  const result = {
    status: "PASS",
    selectionPath: toSlash(selectionPath),
    rules: policy.templates,
    errors,
    warnings: [],
    suggestions,
    suggestionPath: "",
    suggestionWritten: false,
  };
  if (errors.length > 0) result.status = "FAIL";
  else if (suggestions.length > 0) {
    result.status = "WARN";
    result.warnings.push("selection.yaml is missing high-confidence report/composite templates");
  }
  if (suggestions.length > 0) {
    if (!out) out = path.join(root, "selection.suggested.yaml");
    result.suggestionPath = toSlash(out);
    writeFileSync(out, renderTemplateSelectionYAML({ version: 1, templates: suggestions }), { mode: 0o644 });
    result.suggestionWritten = true;
  }
  return result;
}

export function suggestTemplateSelection(root, policy) {
  const { corpus } = loadCorpus(root);
  const knownTemplates = new Set((policy.templates || []).map((rule) => rule.template).filter(Boolean));
  const suggestions = [];
  for (const doc of corpus.docs) {
    if (doc.kind !== KIND_TEMPLATE || doc.isIndex || knownTemplates.has(doc.path)) continue;
    const base = pathBase(doc.path);
    if (!isAllowedTemplateSelectionPath(doc.path)) continue;
    if (doc.path.startsWith("templates/") && !base.startsWith("r-") && !base.startsWith("c-")) continue;
    const playbook = samePath(doc.path, "playbooks");
    const spec = samePath(doc.path, "spec");
    if (!corpus.byPath[playbook] || !corpus.byPath[spec]) continue;
    let ruleType = "report";
    if (base.startsWith("c-")) ruleType = "composite";
    suggestions.push({
      id: stableTemplateSelectionID(doc.path),
      playbook,
      template: doc.path,
      type: ruleType,
      domain: doc.domain || "",
      covers: [spec],
      intents: ["report", "diagnosis"],
      priority: 100,
    });
  }
  suggestions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return suggestions;
}

export function renderTemplateSelectionYAML(policy) {
  const version = policy.version || 1;
  let out = `version: ${version}\n\ntemplates:\n`;
  for (const rule of policy.templates || []) {
    out += `  - id: ${rule.id}\n`;
    out += `    playbook: ${rule.playbook}\n`;
    out += `    template: ${rule.template}\n`;
    out += `    type: ${rule.type}\n`;
    if (rule.domain) out += `    domain: ${rule.domain}\n`;
    out += writeSimpleYAMLArray("covers", rule.covers);
    out += writeSimpleYAMLArray("intents", rule.intents);
    out += `    priority: ${rule.priority || 0}\n`;
  }
  return out;
}

function writeSimpleYAMLArray(key, values) {
  if (!values?.length) return "";
  let out = `    ${key}:\n`;
  for (const value of values) out += `      - ${value}\n`;
  return out;
}

export function templateDoctorJSON(result) {
  const out = {
    status: result.status,
    selectionPath: result.selectionPath,
    suggestionWritten: Boolean(result.suggestionWritten),
  };
  if (result.rules?.length) out.rules = result.rules.map(templateSelectionRuleJSON);
  if (result.errors?.length) out.errors = result.errors;
  if (result.warnings?.length) out.warnings = result.warnings;
  if (result.suggestions?.length) out.suggestions = result.suggestions.map(templateSelectionRuleJSON);
  if (result.suggestionPath) out.suggestionPath = result.suggestionPath;
  return out;
}

function templateSelectionRuleJSON(rule) {
  const out = {
    id: rule.id,
    playbook: rule.playbook,
    template: rule.template,
    type: rule.type,
  };
  if (rule.domain) out.domain = rule.domain;
  if (rule.covers?.length) out.covers = rule.covers;
  if (rule.intents?.length) out.intents = rule.intents;
  if (rule.priority) out.priority = rule.priority;
  return out;
}

function fileExists(filePath) {
  return isRegularFile(filePath);
}

function pathBase(logical) {
  const parts = String(logical || "").split("/");
  if (parts.length === 0) return logical;
  return parts[parts.length - 1];
}

export function stableTemplateSelectionID(templatePath) {
  let id = String(templatePath || "");
  if (id.startsWith("templates/")) id = id.slice("templates/".length);
  if (id.endsWith(".md")) id = id.slice(0, -".md".length);
  if (id.startsWith("reports/")) id = id.slice("reports/".length);
  return id.replaceAll("/", "_").replaceAll("-", "_");
}

export function isReportTemplatePath(logical) {
  return String(logical || "").startsWith("reports/") && pathBase(logical) === "template.md";
}

export function isAllowedTemplateSelectionPath(logical) {
  return String(logical || "").startsWith("templates/") || isReportTemplatePath(logical);
}
