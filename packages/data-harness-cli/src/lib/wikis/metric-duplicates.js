import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { newPathResolver } from "../harness.js";
import {
  cleanYAMLScalar,
  commonWikiRoot,
  firstPathPart,
  isIndentedYAMLLine,
  quoteYAML,
  restPathParts,
  splitYAMLKV,
  topLevelYAMLKey,
} from "./aliases.js";
import { loadCorpus, stripFrontmatterText } from "./parse.js";
import { KIND_SPEC, SPEC_TYPE_METRIC } from "./paths.js";

const ACTION_DEPRECATE = "deprecate_duplicates";
const ACTION_MERGE_LATER = "merge_later";
const ACTION_MANUAL = "manual_review";
const ACTION_IGNORE = "ignore_not_same_metric";

export function buildMetricDuplicatesReport(root) {
  const { groups, scanned } = buildMetricDuplicateGroups(root);
  const report = {
    metricFilesScanned: scanned,
    duplicateLabelGroups: 0,
    duplicateChineseGroups: 0,
    duplicateCodeGroups: 0,
    duplicateNameGroups: 0,
    duplicateBasenameGroups: 0,
    crossSystemGroups: 0,
    groups,
  };
  for (const group of groups) {
    if (group.match_type === "label") report.duplicateLabelGroups += 1;
    else if (group.match_type === "chinese_name") report.duplicateChineseGroups += 1;
    else if (group.match_type === "code") report.duplicateCodeGroups += 1;
    else if (group.match_type === "name") report.duplicateNameGroups += 1;
    else if (group.match_type === "basename") report.duplicateBasenameGroups += 1;
    if (metricDuplicateCrossSystem(group.files)) report.crossSystemGroups += 1;
  }
  return report;
}

export function exportMetricDuplicates(root, rootLabel) {
  const { groups } = buildMetricDuplicateGroups(root);
  if (!rootLabel) rootLabel = commonWikiRoot(newPathResolver(root));
  return {
    version: 1,
    root: rootLabel,
    generated_by: "data-harness-cli wikis metric-duplicates export",
    groups,
  };
}

export function exportMetricDuplicatesLite(root) {
  const { groups } = buildMetricDuplicateGroups(root);
  return {
    version: 1,
    format: "lite",
    duplicates: groups.map((group) => ({
      by: group.match_type,
      value: group.value,
      label: group.label,
      severity: group.severity,
      files: group.files.map((file) => file.path),
      canonical: group.decision.canonical,
      action: group.decision.action,
      notes: group.decision.notes,
    })),
  };
}

export function lintMetricDuplicatesFile(root, file) {
  return lintMetricDuplicates(root, readMetricDuplicatesFile(root, file));
}

export function importMetricDuplicates(root, file, apply) {
  const data = readMetricDuplicatesFile(root, file);
  const lint = lintMetricDuplicates(root, data);
  const result = {
    applied: apply,
    groupsScanned: (data.groups || []).length,
    lint,
    filesToUpdate: 0,
    canonicalMarks: 0,
    deprecatedMarks: 0,
    mergeLaterMarks: 0,
    changes: [],
  };
  if (lint.errors.length > 0) return result;
  const planned = new Map();
  for (const group of data.groups || []) {
    const canonical = String(group.decision?.canonical || "").trim();
    const action = String(group.decision?.action || "").trim();
    if (!canonical || !action || action === ACTION_MANUAL || action === ACTION_IGNORE) continue;
    for (const fileItem of group.files || []) {
      const fields = {};
      if (fileItem.path === canonical) {
        fields.canonical_status = "canonical";
        fields.canonical_group = group.id;
      } else {
        fields.canonical_status = action === ACTION_MERGE_LATER ? "merge_later" : "deprecated";
        fields.canonical_target = canonical;
        fields.canonical_reason = metricDuplicateReason(group);
      }
      const raw = readFileSync(path.join(root, fileItem.path));
      const before = canonicalFrontmatterFields(raw);
      if (!canonicalFieldsChanged(before, fields)) continue;
      planned.set(fileItem.path, { group: group.id, path: fileItem.path, fields, before });
    }
  }
  for (const p of [...planned.keys()].sort()) {
    const change = planned.get(p);
    result.changes.push(change);
    result.filesToUpdate += 1;
    if (change.fields.canonical_status === "canonical") result.canonicalMarks += 1;
    else if (change.fields.canonical_status === "deprecated") result.deprecatedMarks += 1;
    else if (change.fields.canonical_status === "merge_later") result.mergeLaterMarks += 1;
    if (apply) {
      const full = path.join(root, p);
      writeFileSync(full, rewriteCanonicalFrontmatter(readFileSync(full), change.fields));
    }
  }
  return result;
}

export function marshalMetricDuplicatesJSON(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function writeMetricDuplicatesYAML(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, formatMetricDuplicatesYAML(data));
}

export function writeMetricDuplicatesLiteYAML(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, formatMetricDuplicatesLiteYAML(data));
}

export function formatMetricDuplicatesYAML(data) {
  let b = `version: ${data.version || 1}\n`;
  b += `root: ${quoteYAML(data.root || "")}\n`;
  b += `generated_by: ${quoteYAML(data.generated_by || "")}\n`;
  b += "groups:\n";
  for (const group of data.groups || []) {
    b += `  - id: ${quoteYAML(group.id)}\n`;
    b += writeScalar(4, "match_type", group.match_type);
    b += writeScalar(4, "label", group.label);
    b += writeScalar(4, "value", group.value);
    b += writeScalar(4, "severity", group.severity);
    b += writeScalar(4, "reason", group.reason);
    b += "    files:\n";
    for (const file of group.files || []) {
      b += `      - path: ${quoteYAML(file.path)}\n`;
      b += writeScalar(8, "domain", file.domain);
      b += writeScalar(8, "group", file.group);
      b += writeScalar(8, "name", file.name);
      b += writeScalar(8, "code", file.code);
      b += writeScalar(8, "label", file.label);
      b += writeScalar(8, "status", file.status);
    }
    b += "    decision:\n";
    b += writeScalar(6, "canonical", group.decision?.canonical);
    b += writeScalar(6, "action", group.decision?.action);
    b += writeScalar(6, "notes", group.decision?.notes);
  }
  return b;
}

export function formatMetricDuplicatesLiteYAML(data) {
  let b = `version: ${data.version || 1}\n`;
  b += writeScalar(0, "format", "lite");
  b += "duplicates:\n";
  for (const group of data.duplicates || []) {
    b += `  - by: ${quoteYAML(group.by)}\n`;
    b += writeScalar(4, "value", group.value);
    b += writeScalar(4, "label", group.label);
    b += writeScalar(4, "severity", group.severity);
    b += "    files:\n";
    for (const file of group.files || []) b += `      - ${quoteYAML(file)}\n`;
    b += writeScalar(4, "canonical", group.canonical);
    b += writeScalar(4, "action", group.action);
    b += writeScalar(4, "notes", group.notes);
  }
  return b;
}

export function readMetricDuplicatesFile(root, file) {
  const data = readFileSync(file);
  const text = data.toString("utf8");
  if (file.endsWith(".json")) {
    const probe = JSON.parse(text);
    if (probe.format === "lite" || probe.duplicates) return normalizeMetricDuplicates(root, probe);
    return probe;
  }
  if (metricDuplicatesYAMLIsLite(text)) return normalizeMetricDuplicates(root, parseLiteMetricDuplicatesYAML(text));
  return parseMetricDuplicatesYAML(text);
}

function normalizeMetricDuplicates(root, data) {
  const specs = loadMetricSpecs(root);
  const specByPath = Object.fromEntries(specs.map((spec) => [spec.path, spec]));
  const out = { version: data.version || 1, groups: [] };
  for (const lite of data.duplicates || []) {
    const group = {
      id: metricDuplicateID(lite.by, lite.value),
      match_type: lite.by,
      label: lite.label,
      value: lite.value,
      severity: lite.severity,
      files: [],
      decision: { canonical: lite.canonical, action: lite.action, notes: lite.notes },
    };
    for (const filePath of lite.files || []) {
      const item = { path: filePath, status: "undecided" };
      const spec = specByPath[filePath];
      if (spec) {
        item.domain = spec.domain;
        item.group = spec.group;
        item.name = spec.name;
        item.code = spec.code;
        item.label = spec.label;
      }
      group.files.push(item);
    }
    if (!group.label) group.label = duplicateGroupLabel(group.match_type, group.value);
    if (!group.severity) group.severity = metricDuplicateCrossSystem(group.files) ? "error" : "warn";
    group.reason = metricDuplicateCrossSystem(group.files) || group.severity === "error"
      ? "同一指标不应同时出现在 CMR 和 Indicators"
      : "精确重复命中，需要人工确认唯一 canonical owner";
    out.groups.push(group);
  }
  return out;
}

export function lintMetricDuplicates(root, data) {
  const result = { ok: true, errors: [], warnings: [] };
  const add = (level, code, group, field, value, message) => {
    const issue = { level, code, message };
    if (group) issue.group = group;
    if (field) issue.field = field;
    if (value) issue.value = value;
    if (level === "error") result.errors.push(issue);
    else result.warnings.push(issue);
  };
  if (!data.groups) add("error", "missing_groups", "", "groups", "", "groups must be an array");
  const stateByPath = new Map();
  for (const group of data.groups || []) {
    if (!group.id) add("error", "missing_group_id", "", "id", "", "group must have id");
    if (!group.match_type) add("error", "missing_match_type", group.id, "match_type", "", "group must have match_type");
    if ((group.files || []).length < 2) add("error", "too_few_files", group.id, "files", "", "group must contain at least 2 files");
    const fileSet = new Set();
    for (const file of group.files || []) {
      if (!file.path) {
        add("error", "missing_file_path", group.id, "files.path", "", "file path must not be empty");
        continue;
      }
      fileSet.add(file.path);
      try {
        statSync(path.join(root, file.path));
      } catch {
        add("error", "file_not_found", group.id, "files.path", file.path, "file path does not exist");
      }
    }
    const canonical = String(group.decision?.canonical || "").trim();
    const action = String(group.decision?.action || "").trim();
    if (!canonical) add("warning", "undecided_group", group.id, "decision.canonical", "", "canonical is not decided");
    else if (!fileSet.has(canonical)) add("error", "canonical_not_in_group", group.id, "decision.canonical", canonical, "canonical must be one of group files");
    if (!action) {
      if (canonical) add("error", "missing_action", group.id, "decision.action", "", "decision action is required when canonical is set");
    } else if (!allowedMetricDuplicateAction(action)) {
      add("error", "invalid_action", group.id, "decision.action", action, "unsupported decision action");
    }
    if (action === ACTION_IGNORE && !String(group.decision?.notes || "").trim()) {
      add("warning", "ignored_duplicate_missing_notes", group.id, "decision.notes", "", "ignore_not_same_metric should explain why it is not the same metric");
    }
    if (canonical && action && action !== ACTION_IGNORE && action !== ACTION_MANUAL) {
      for (const file of group.files || []) {
        const state = file.path === canonical ? "canonical" : "duplicate";
        if (file.path === canonical && file.status === "deprecated") {
          add("error", "canonical_marked_deprecated", group.id, "files.status", file.path, "canonical file must not be marked deprecated");
        }
        const prev = stateByPath.get(file.path);
        if (prev && prev !== state) {
          add("error", "conflicting_file_decision", group.id, "files.path", file.path, "same file has conflicting canonical states across decisions");
        }
        stateByPath.set(file.path, state);
      }
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}

function buildMetricDuplicateGroups(root) {
  const specs = loadMetricSpecs(root);
  const groups = [];
  const addGroups = (matchType, values) => {
    const keys = [...values.keys()].filter((value) => value && values.get(value).length > 1).sort();
    for (const value of keys) {
      const files = metricDuplicateItems(values.get(value));
      const group = {
        id: metricDuplicateID(matchType, value),
        match_type: matchType,
        label: duplicateGroupLabel(matchType, value),
        value,
        files,
        decision: {},
      };
      if (metricDuplicateCrossSystem(files)) {
        group.severity = "error";
        group.reason = "同一指标不应同时出现在 CMR 和 Indicators";
      } else {
        group.severity = "warn";
        group.reason = "精确重复命中，需要人工确认唯一 canonical owner";
      }
      groups.push(group);
    }
  };
  const byLabel = new Map();
  const byChinese = new Map();
  const byCode = new Map();
  const byName = new Map();
  const byBasename = new Map();
  const push = (map, key, spec) => {
    const list = map.get(key) || [];
    list.push(spec);
    map.set(key, list);
  };
  for (const spec of specs) {
    push(byLabel, spec.label, spec);
    push(byChinese, spec.chinese, spec);
    push(byCode, spec.code, spec);
    push(byName, spec.name, spec);
    push(byBasename, spec.basename, spec);
  }
  addGroups("label", byLabel);
  addGroups("chinese_name", byChinese);
  addGroups("code", byCode);
  addGroups("name", byName);
  addGroups("basename", byBasename);
  groups.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity < b.severity ? -1 : 1;
    if (a.match_type !== b.match_type) return a.match_type < b.match_type ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return { groups, scanned: specs.length };
}

function loadMetricSpecs(root) {
  const { corpus } = loadCorpus(root);
  const specs = [];
  for (const doc of corpus.docs) {
    if (doc.kind !== KIND_SPEC || doc.isIndex || doc.specType !== SPEC_TYPE_METRIC) continue;
    const data = readFileSync(path.join(root, doc.physicalRel));
    const basic = parseMetricBasicInfo(data.toString("utf8"));
    specs.push({
      path: doc.physicalRel,
      domain: firstPathPart(doc.domain),
      group: restPathParts(doc.domain),
      name: doc.name,
      code: basic["指标英文 code"] || "",
      label: doc.label,
      chinese: basic["指标中文名"] || "",
      basename: path.posix.basename(doc.path),
    });
  }
  specs.sort((a, b) => (a.path < b.path ? -1 : 1));
  return specs;
}

function parseMetricBasicInfo(text) {
  const out = {};
  let inBasic = false;
  for (const raw of stripFrontmatterText(text).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      inBasic = line === "## 基本信息";
      continue;
    }
    if (!inBasic || !line.startsWith("|")) continue;
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 2 || cells[0] === "属性" || cells[0].startsWith(":")) continue;
    out[cells[0]] = cleanMetricTableValue(cells[1]);
  }
  return out;
}

function splitMarkdownTableRow(line) {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((part) => part.trim());
}

function cleanMetricTableValue(value) {
  return String(value || "").trim().replace(/^`+|`+$/g, "").replace(/^["']|["']$/g, "").trim();
}

function metricDuplicateItems(specs) {
  return [...specs]
    .map((spec) => ({
      path: spec.path,
      domain: spec.domain,
      group: spec.group,
      name: spec.name,
      code: spec.code,
      label: spec.label,
      status: "undecided",
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

function metricDuplicateCrossSystem(files) {
  const domains = new Set(files.map((file) => file.domain));
  return domains.has("cmr") && domains.has("indicators");
}

function duplicateGroupLabel(matchType, value) {
  return matchType === "label" || matchType === "chinese_name" ? value : "";
}

function metricDuplicateID(matchType, value) {
  return `dup.${matchType}.${sanitizeMetricDuplicateID(value)}`;
}

function sanitizeMetricDuplicateID(value) {
  value = String(value || "").trim();
  if (!value) return "empty";
  let out = "";
  let lastDot = false;
  for (const r of value) {
    const code = r.codePointAt(0);
    if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code > 127) {
      out += r;
      lastDot = false;
      continue;
    }
    if (!lastDot) {
      out += ".";
      lastDot = true;
    }
  }
  out = out.replace(/^\.+|\.+$/g, "");
  return out || "value";
}

function metricDuplicateReason(group) {
  return `duplicate ${group.match_type}: ${group.label || group.value}`;
}

function allowedMetricDuplicateAction(action) {
  return [ACTION_DEPRECATE, ACTION_MERGE_LATER, ACTION_MANUAL, ACTION_IGNORE].includes(action);
}

function parseMetricDuplicatesYAML(text) {
  const out = { groups: [] };
  let group = null;
  let file = null;
  let section = "";
  let subsection = "";
  for (let raw of text.split("\n")) {
    raw = raw.replace(/[ \t]+$/, "");
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (kv.key === "version") out.version = Number.parseInt(kv.value, 10) || 0;
      else if (kv.key === "root") out.root = cleanYAMLScalar(kv.value);
      else if (kv.key === "generated_by") out.generated_by = cleanYAMLScalar(kv.value);
      else if (kv.key === "groups") section = "groups";
      continue;
    }
    if (section !== "groups") continue;
    if (indent === 2 && line.startsWith("- ")) {
      group = { files: [], decision: {} };
      out.groups.push(group);
      file = null;
      subsection = "";
      const rest = line.slice(2).trim();
      const kv = splitYAMLKV(rest);
      if (kv?.key === "id") group.id = cleanYAMLScalar(kv.value);
      continue;
    }
    if (!group) continue;
    if (indent === 4) {
      file = null;
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (kv.key === "match_type") group.match_type = cleanYAMLScalar(kv.value);
      else if (kv.key === "label") group.label = cleanYAMLScalar(kv.value);
      else if (kv.key === "value") group.value = cleanYAMLScalar(kv.value);
      else if (kv.key === "severity") group.severity = cleanYAMLScalar(kv.value);
      else if (kv.key === "reason") group.reason = cleanYAMLScalar(kv.value);
      else if (kv.key === "files" || kv.key === "decision") subsection = kv.key;
      continue;
    }
    if (subsection === "files" && indent === 6 && line.startsWith("- ")) {
      file = {};
      group.files.push(file);
      const rest = line.slice(2).trim();
      const kv = splitYAMLKV(rest);
      if (kv?.key === "path") file.path = cleanYAMLScalar(kv.value);
      continue;
    }
    if (subsection === "files" && indent === 8 && file) {
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (["domain", "group", "name", "code", "label", "status"].includes(kv.key)) file[kv.key] = cleanYAMLScalar(kv.value);
      continue;
    }
    if (subsection === "decision" && indent === 6) {
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (["canonical", "action", "notes"].includes(kv.key)) group.decision[kv.key] = cleanYAMLScalar(kv.value);
    }
  }
  if (!out.version) out.version = 1;
  return out;
}

function metricDuplicatesYAMLIsLite(text) {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = splitYAMLKV(line);
    if (!kv) continue;
    if (kv.key === "format" && cleanYAMLScalar(kv.value) === "lite") return true;
    if (kv.key === "duplicates") return true;
    if (kv.key === "groups") return false;
  }
  return false;
}

function parseLiteMetricDuplicatesYAML(text) {
  const out = { duplicates: [] };
  let group = null;
  let section = "";
  let subsection = "";
  for (let raw of text.split("\n")) {
    raw = raw.replace(/[ \t]+$/, "");
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (kv.key === "version") out.version = Number.parseInt(kv.value, 10) || 0;
      else if (kv.key === "format") out.format = cleanYAMLScalar(kv.value);
      else if (kv.key === "duplicates") section = "duplicates";
      continue;
    }
    if (section !== "duplicates") continue;
    if (indent === 2 && line.startsWith("- ")) {
      group = { files: [] };
      out.duplicates.push(group);
      subsection = "";
      const rest = line.slice(2).trim();
      const kv = splitYAMLKV(rest);
      if (kv) setLiteMetricDuplicateField(group, kv.key, kv.value);
      continue;
    }
    if (!group) continue;
    if (indent === 4) {
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (kv.key === "files") {
        subsection = "files";
        continue;
      }
      subsection = "";
      setLiteMetricDuplicateField(group, kv.key, kv.value);
      continue;
    }
    if (subsection === "files" && indent === 6 && line.startsWith("- ")) {
      let value = line.slice(2).trim();
      const kv = splitYAMLKV(value);
      if (kv?.key === "path") value = kv.value;
      group.files.push(cleanYAMLScalar(value));
    }
  }
  if (!out.version) out.version = 1;
  if (!out.format) out.format = "lite";
  return out;
}

function setLiteMetricDuplicateField(group, key, value) {
  if (["by", "value", "label", "severity", "canonical", "action", "notes"].includes(key)) {
    group[key] = cleanYAMLScalar(value);
  }
}

function canonicalFrontmatterFields(data) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const lines = text.split("\n");
  const out = {};
  if (!lines.length || lines[0].trim() !== "---") return out;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  for (let i = 1; end >= 0 && i < end; i++) {
    const key = topLevelYAMLKey(lines[i]);
    if (!isCanonicalFrontmatterKey(key)) continue;
    const kv = splitYAMLKV(lines[i].trim());
    out[key] = cleanYAMLScalar(kv?.value || "");
  }
  return out;
}

function canonicalFieldsChanged(before, after) {
  return ["canonical_status", "canonical_group", "canonical_target", "canonical_reason"].some((key) => before[key] !== after[key]);
}

function rewriteCanonicalFrontmatter(data, fields) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const lines = text.split("\n");
  if (!lines.length || lines[0].trim() !== "---") {
    return Buffer.from(`---\n${writeCanonicalFields(fields)}---\n\n${text}`);
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return Buffer.from(text);
  const kept = [];
  for (let i = 1; i < end; i++) {
    const key = topLevelYAMLKey(lines[i]);
    if (isCanonicalFrontmatterKey(key)) {
      while (i + 1 < end && isIndentedYAMLLine(lines[i + 1])) i += 1;
      continue;
    }
    kept.push(lines[i]);
  }
  let b = "---\n";
  for (const line of kept) b += `${line}\n`;
  b += writeCanonicalFields(fields);
  b += "---";
  if (end + 1 < lines.length) b += `\n${lines.slice(end + 1).join("\n")}`;
  return Buffer.from(b);
}

function writeCanonicalFields(fields) {
  let b = "";
  for (const key of ["canonical_status", "canonical_group", "canonical_target", "canonical_reason"]) {
    if (fields[key]) b += `${key}: ${quoteYAML(fields[key])}\n`;
  }
  return b;
}

function isCanonicalFrontmatterKey(key) {
  return ["canonical_status", "canonical_group", "canonical_target", "canonical_reason"].includes(key);
}

function writeScalar(indent, key, value) {
  return `${" ".repeat(indent)}${key}: ${quoteYAML(value || "")}\n`;
}
