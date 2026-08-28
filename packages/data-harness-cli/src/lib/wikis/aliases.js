import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { newPathResolver } from "../harness.js";
import { normalizeChinese, search } from "../retrieval.js";
import { frontmatterAliasFields, loadCorpus, stripFrontmatterText } from "./parse.js";
import { isStructuredPath, KIND_PLAYBOOK, KIND_SPEC, SPEC_TYPE_METRIC } from "./paths.js";

export function buildAliasesReport(root) {
  const { corpus } = loadCorpus(root);
  const report = {
    specFiles: 0,
    specWithAliases: 0,
    specWithNegativeAliases: 0,
    playbookFiles: 0,
    playbookWithAliases: 0,
    playbookWithNegativeAliases: 0,
    duplicateLabels: 0,
    duplicateAliases: 0,
    placeholderShortDocs: 0,
  };
  const labels = new Map();
  const aliases = new Map();
  for (const doc of corpus.docs) {
    if (!isAliasTarget(doc)) continue;
    if (doc.kind === KIND_SPEC) {
      report.specFiles += 1;
      if (doc.label) labels.set(doc.label, (labels.get(doc.label) || 0) + 1);
      if ((doc.aliases || []).length) report.specWithAliases += 1;
      if ((doc.negativeAliases || []).length) report.specWithNegativeAliases += 1;
    }
    if (doc.kind === KIND_PLAYBOOK) {
      report.playbookFiles += 1;
      if ((doc.aliases || []).length) report.playbookWithAliases += 1;
      if ((doc.negativeAliases || []).length) report.playbookWithNegativeAliases += 1;
    }
    for (const alias of doc.aliases || []) aliases.set(alias, (aliases.get(alias) || 0) + 1);
    if (isPlaceholderShortDoc(root, doc.physicalRel)) report.placeholderShortDocs += 1;
  }
  report.duplicateLabels = duplicateValueCount(labels);
  report.duplicateAliases = duplicateValueCount(aliases);
  return report;
}

export function exportAliases(root, targets) {
  const { corpus } = loadCorpus(root);
  const resolver = newPathResolver(root);
  const targetSet = aliasTargetSet(targets);
  const itemsByKey = new Map();
  for (const doc of corpus.docs) {
    if (!isAliasTarget(doc) || !aliasTargetAllowed(targetSet, doc.kind)) continue;
    const fileKey = aliasFileKey(doc.path);
    let item = itemsByKey.get(fileKey);
    if (!item) {
      item = {
        id: fileKey.replace(/\.md$/, "").replaceAll("/", "."),
        domain: firstPathPart(doc.domain),
        group: restPathParts(doc.domain),
        file_key: fileKey,
        paths: { template: aliasTemplatePath(resolver, doc.path, fileKey) },
        notes: "",
      };
      itemsByKey.set(fileKey, item);
    }
    if (doc.kind === KIND_SPEC) {
      item.label = doc.label;
      item.code = doc.name;
      item.paths.spec = doc.physicalRel;
      item.spec = { aliases: doc.aliases || [], negative_aliases: doc.negativeAliases || [] };
    }
    if (doc.kind === KIND_PLAYBOOK) {
      item.paths.playbook = doc.physicalRel;
      item.playbook = { aliases: doc.aliases || [], negative_aliases: doc.negativeAliases || [] };
    }
  }
  const items = [...itemsByKey.keys()].sort().map((key) => itemsByKey.get(key));
  return { version: 1, root: commonWikiRoot(resolver), targets: [...targetSet].sort(), items };
}

export function exportAliasesLite(root, targets) {
  const { corpus } = loadCorpus(root);
  const targetSet = aliasTargetSet(targets);
  const specs = [];
  const playbooks = [];
  for (const doc of corpus.docs) {
    if (!isAliasTarget(doc) || !aliasTargetAllowed(targetSet, doc.kind)) continue;
    const item = {
      id: aliasFileKey(doc.path).replace(/\.md$/, "").replaceAll("/", "."),
      label: doc.label,
      aliases: doc.aliases || [],
      negative_aliases: doc.negativeAliases || [],
    };
    if (doc.kind === KIND_SPEC) {
      item.code = doc.name;
      specs.push(item);
    }
    if (doc.kind === KIND_PLAYBOOK) playbooks.push(item);
  }
  specs.sort((a, b) => (a.id < b.id ? -1 : 1));
  playbooks.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { version: 1, format: "lite", specs, playbooks };
}

export function lintAliasesFile(root, file) {
  return lintAliases(root, readAliasesFile(file));
}

export function checkAliasesQualityFile(root, file, opts) {
  return checkAliasesQuality(root, readAliasesFile(file), opts);
}

export function checkAliasesQuality(root, data, opts = {}) {
  if (!opts.minAliasRunes) opts.minAliasRunes = 3;
  if (!opts.maxAliasRunes) opts.maxAliasRunes = 40;
  const result = lintAliases(root, data);
  const add = makeAdd(result);
  data = resolveAliasesPaths(root, data, add);
  let baseItems;
  let comboPlaybookPaths;
  let metricSpecPaths;
  try {
    baseItems = baseRecallItems(root);
    comboPlaybookPaths = comboPlaybookPathSet(root);
    metricSpecPaths = metricSpecPathSet(root);
  } catch (error) {
    add("error", "corpus_load_failed", "", "", "", error.message);
    result.ok = false;
    return result;
  }
  for (const item of data.items || []) {
    checkAliasQualityForField(item, "spec.aliases", item.paths?.spec, item.label, item.code, item.spec, baseItems, opts, add);
    checkAliasQualityForField(item, "playbook.aliases", item.paths?.playbook, item.label, item.code, item.playbook, baseItems, opts, add);
    if (opts.requireAliases) {
      if (item.spec && !(item.spec.aliases || []).length) add("error", "aliases_required", item.id, "spec.aliases", "", "aliases must not be empty");
      if (item.playbook && !(item.playbook.aliases || []).length) add("error", "aliases_required", item.id, "playbook.aliases", "", "aliases must not be empty");
    }
    if (opts.minSpecAliases > 0 && item.spec && metricSpecPaths.has(aliasLogicalPath(item.paths?.spec)) && (item.spec.aliases || []).length < opts.minSpecAliases) {
      add("error", "not_enough_aliases", item.id, "spec.aliases", "", `spec aliases must have at least ${opts.minSpecAliases} entries`);
    }
    if (
      opts.minComboPlaybookAliases > 0 &&
      item.playbook &&
      (item.playbook.aliases || []).length < opts.minComboPlaybookAliases &&
      comboPlaybookPaths.has(aliasLogicalPath(item.paths?.playbook))
    ) {
      add("error", "not_enough_aliases", item.id, "playbook.aliases", "", `combo playbook aliases must have at least ${opts.minComboPlaybookAliases} entries`);
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}

export function importAliases(root, file, apply) {
  const aliasesFile = readAliasesFile(file);
  const lint = lintAliases(root, aliasesFile);
  const result = { applied: apply, lint, filesScanned: 0, filesToUpdate: 0, aliasesAdded: 0, negativeAliasesAdded: 0, changes: [] };
  if (lint.errors.length > 0) return result;
  const resolved = resolveAliasesPaths(root, aliasesFile, null);
  for (const item of resolved.items || []) {
    const targets = [
      { path: item.paths?.spec, fields: item.spec },
      { path: item.paths?.playbook, fields: item.playbook },
    ];
    for (const target of targets) {
      if (!target.path || !target.fields) continue;
      result.filesScanned += 1;
      const full = path.join(root, target.path);
      const data = readFileSync(full);
      const current = frontmatterAliasFields(data.toString("utf8"));
      const change = {
        path: target.path,
        aliasesAdded: setDiff(target.fields.aliases || [], current.aliases),
        aliasesRemoved: setDiff(current.aliases, target.fields.aliases || []),
        negativeAliasesAdded: setDiff(target.fields.negative_aliases || [], current.negativeAliases),
        negativeAliasesRemoved: setDiff(current.negativeAliases, target.fields.negative_aliases || []),
      };
      if (!hasChanges(change)) continue;
      result.filesToUpdate += 1;
      result.aliasesAdded += change.aliasesAdded.length;
      result.negativeAliasesAdded += change.negativeAliasesAdded.length;
      result.changes.push(change);
      if (apply) {
        writeFileSync(full, rewriteAliasFrontmatter(data, target.fields.aliases || [], target.fields.negative_aliases || []));
      }
    }
  }
  return result;
}

export function readAliasesFile(file) {
  const data = readFileSync(file);
  if (file.endsWith(".json")) {
    const probe = JSON.parse(data.toString("utf8"));
    if (probe.specs || probe.playbooks) return liteAliasesToAliasesFile(probe);
    return probe;
  }
  return parseAliasesYAML(data.toString("utf8"));
}

export function writeAliasesYAML(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, formatAliasesYAML(data));
}

export function writeAliasesLiteYAML(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, formatAliasesLiteYAML(data));
}

export function formatAliasesYAML(data) {
  let b = `version: ${data.version || 1}\n`;
  b += `root: ${quoteYAML(data.root || "")}\n`;
  b += "targets:\n";
  for (const target of data.targets || []) b += `  - ${quoteYAML(target)}\n`;
  b += "items:\n";
  for (const item of data.items || []) {
    b += `  - id: ${quoteYAML(item.id)}\n`;
    b += writeScalar(4, "label", item.label);
    b += writeScalar(4, "code", item.code);
    b += writeScalar(4, "domain", item.domain);
    b += writeScalar(4, "group", item.group);
    b += writeScalar(4, "file_key", item.file_key);
    b += "    paths:\n";
    b += writeScalar(6, "spec", item.paths?.spec);
    b += writeScalar(6, "playbook", item.paths?.playbook);
    b += writeScalar(6, "template", item.paths?.template);
    if (item.spec) {
      b += "    spec:\n";
      b += writeArray(6, "aliases", item.spec.aliases || []);
      b += writeArray(6, "negative_aliases", item.spec.negative_aliases || []);
    }
    if (item.playbook) {
      b += "    playbook:\n";
      b += writeArray(6, "aliases", item.playbook.aliases || []);
      b += writeArray(6, "negative_aliases", item.playbook.negative_aliases || []);
    }
    b += writeScalar(4, "notes", item.notes);
  }
  return b;
}

export function formatAliasesLiteYAML(data) {
  const version = data.version || 1;
  const format = data.format || "lite";
  let b = `version: ${version}\nformat: ${quoteYAML(format)}\n`;
  b += writeLiteSection("specs", data.specs || [], true);
  b += writeLiteSection("playbooks", data.playbooks || [], false);
  return b;
}

export function marshalAliasesJSON(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function marshalAliasesLiteJSON(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function lintAliases(root, data) {
  const result = { ok: true, errors: [], warnings: [] };
  const add = makeAdd(result);
  const positiveOwners = new Map();
  const labels = new Map();
  const aliasOwners = new Map();
  for (const item of data.items || []) {
    if (item.label) {
      pushMap(positiveOwners, item.label, item.id);
      pushMap(labels, item.label, item);
    }
    if (item.code) pushMap(positiveOwners, item.code, item.id);
    for (const fields of [item.spec, item.playbook]) {
      if (!fields) continue;
      for (const alias of fields.aliases || []) {
        pushMap(positiveOwners, alias, item.id);
        pushMap(aliasOwners, alias, item.id);
      }
    }
  }
  data = resolveAliasesPaths(root, data, add);
  for (const item of data.items || []) {
    checkAliasPath(root, item, item.paths?.spec, "spec", add);
    checkAliasPath(root, item, item.paths?.playbook, "playbook", add);
    for (const [fieldName, fields] of [
      ["spec", item.spec],
      ["playbook", item.playbook],
    ]) {
      if (!fields) continue;
      checkAliasList(item.id, `${fieldName}.aliases`, fields.aliases || [], add);
      checkAliasList(item.id, `${fieldName}.negative_aliases`, fields.negative_aliases || [], add);
      for (const value of intersectStrings(fields.aliases || [], fields.negative_aliases || [])) {
        add("error", "alias_negative_conflict", item.id, fieldName, value, "alias also appears in negative_aliases");
      }
      for (const alias of fields.aliases || []) {
        if (isGenericAlias(alias)) add("warning", "alias_too_generic", item.id, `${fieldName}.aliases`, alias, "alias is too generic");
        if ([...alias].length > 40) add("warning", "alias_too_long", item.id, `${fieldName}.aliases`, alias, "alias is longer than 40 characters");
      }
      for (const negative of fields.negative_aliases || []) {
        const owners = otherOwners(positiveOwners.get(negative) || [], item.id);
        if (!owners.length) {
          add("warning", "negative_alias_without_positive_owner", item.id, `${fieldName}.negative_aliases`, negative, "negative alias has no positive owner in aliases file");
        }
      }
    }
  }
  for (const [alias, owners] of aliasOwners) {
    if (uniqueStrings(owners).length > 1) add("warning", "alias_appears_in_multiple_items", "", "aliases", alias, "alias appears in multiple items");
  }
  for (const [label, items] of labels) {
    if (items.length <= 1) continue;
    const domains = new Set(items.map((item) => item.domain));
    if (domains.size > 1) add("warning", "label_conflict_across_domains", "", "label", label, "same label appears across domains");
  }
  result.ok = result.errors.length === 0;
  return result;
}

function parseAliasesYAML(text) {
  const lines = text.split("\n");
  const out = { items: [], targets: [] };
  let item = null;
  let section = "";
  let subsection = "";
  let arrayTarget = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/[ \t]+$/, "");
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      arrayTarget = null;
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (kv.key === "version") out.version = Number.parseInt(kv.value, 10) || 0;
      else if (kv.key === "format") out.format = cleanYAMLScalar(kv.value);
      else if (kv.key === "root") out.root = cleanYAMLScalar(kv.value);
      else if (["targets", "items", "specs", "playbooks"].includes(kv.key)) section = kv.key;
      continue;
    }
    if (section === "targets" && indent === 2 && line.startsWith("- ")) {
      out.targets.push(cleanYAMLScalar(line.slice(2)));
      continue;
    }
    if (section === "specs" || section === "playbooks") {
      if (indent === 2 && line.startsWith("- ")) {
        item = {};
        out.items.push(item);
        out.format = "lite";
        subsection = section;
        arrayTarget = null;
        if (section === "specs") item.spec = { aliases: [], negative_aliases: [] };
        else item.playbook = { aliases: [], negative_aliases: [] };
        const rest = line.slice(2).trim();
        const kv = splitYAMLKV(rest);
        if (kv?.key === "id") item.id = cleanYAMLScalar(kv.value);
        continue;
      }
      if (!item) continue;
      const fields = section === "playbooks" ? item.playbook : item.spec;
      if (indent === 4) {
        const kv = splitYAMLKV(line);
        if (!kv) continue;
        arrayTarget = null;
        if (kv.key === "id") item.id = cleanYAMLScalar(kv.value);
        else if (kv.key === "label") item.label = cleanYAMLScalar(kv.value);
        else if (kv.key === "code") item.code = cleanYAMLScalar(kv.value);
        else if (kv.key === "aliases") {
          if (kv.value && !isInlineYAMLArray(kv.value)) throw new Error("aliases must be an array");
          fields.aliases = parseInlineYAMLArray(kv.value) || [];
          arrayTarget = { fields, key: "aliases" };
        } else if (kv.key === "negative_aliases") {
          if (kv.value && !isInlineYAMLArray(kv.value)) throw new Error("negative_aliases must be an array");
          fields.negative_aliases = parseInlineYAMLArray(kv.value) || [];
          arrayTarget = { fields, key: "negative_aliases" };
        }
        continue;
      }
      if (indent === 6 && arrayTarget && line.startsWith("- ")) {
        arrayTarget.fields[arrayTarget.key].push(cleanYAMLScalar(line.slice(2)));
      }
      continue;
    }
    if (section !== "items") continue;
    if (indent === 2 && line.startsWith("- ")) {
      item = { paths: {} };
      out.items.push(item);
      subsection = "";
      arrayTarget = null;
      const rest = line.slice(2).trim();
      const kv = splitYAMLKV(rest);
      if (kv?.key === "id") item.id = cleanYAMLScalar(kv.value);
      continue;
    }
    if (!item) continue;
    if (indent === 4) {
      arrayTarget = null;
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (kv.key === "label") item.label = cleanYAMLScalar(kv.value);
      else if (kv.key === "code") item.code = cleanYAMLScalar(kv.value);
      else if (kv.key === "domain") item.domain = cleanYAMLScalar(kv.value);
      else if (kv.key === "group") item.group = cleanYAMLScalar(kv.value);
      else if (kv.key === "file_key") item.file_key = cleanYAMLScalar(kv.value);
      else if (kv.key === "notes") item.notes = cleanYAMLScalar(kv.value);
      else if (kv.key === "paths" || kv.key === "spec" || kv.key === "playbook") {
        subsection = kv.key;
        if (kv.key === "spec" && !item.spec) item.spec = { aliases: [], negative_aliases: [] };
        if (kv.key === "playbook" && !item.playbook) item.playbook = { aliases: [], negative_aliases: [] };
        if (!item.paths) item.paths = {};
      }
      continue;
    }
    if (indent === 6) {
      const kv = splitYAMLKV(line);
      if (!kv) continue;
      if (subsection === "paths") {
        if (!item.paths) item.paths = {};
        if (kv.key === "spec") item.paths.spec = cleanYAMLScalar(kv.value);
        else if (kv.key === "playbook") item.paths.playbook = cleanYAMLScalar(kv.value);
        else if (kv.key === "template") item.paths.template = cleanYAMLScalar(kv.value);
        continue;
      }
      const fields = subsection === "playbook" ? item.playbook : item.spec;
      if (!fields) continue;
      if (kv.key === "aliases") {
        if (kv.value && !isInlineYAMLArray(kv.value)) throw new Error("aliases must be an array");
        fields.aliases = parseInlineYAMLArray(kv.value) || [];
        arrayTarget = { fields, key: "aliases" };
      } else if (kv.key === "negative_aliases") {
        if (kv.value && !isInlineYAMLArray(kv.value)) throw new Error("negative_aliases must be an array");
        fields.negative_aliases = parseInlineYAMLArray(kv.value) || [];
        arrayTarget = { fields, key: "negative_aliases" };
      }
      continue;
    }
    if (indent === 8 && arrayTarget && line.startsWith("- ")) {
      arrayTarget.fields[arrayTarget.key].push(cleanYAMLScalar(line.slice(2)));
    }
  }
  if (!out.version) out.version = 1;
  return out;
}

function liteAliasesToAliasesFile(lite) {
  const out = { version: lite.version || 1, format: "lite", items: [] };
  for (const spec of lite.specs || []) {
    out.items.push({
      id: spec.id,
      label: spec.label,
      code: spec.code,
      spec: { aliases: spec.aliases || [], negative_aliases: spec.negative_aliases || [] },
    });
  }
  for (const playbook of lite.playbooks || []) {
    out.items.push({
      id: playbook.id,
      label: playbook.label,
      code: playbook.code,
      playbook: { aliases: playbook.aliases || [], negative_aliases: playbook.negative_aliases || [] },
    });
  }
  return out;
}

function resolveAliasesPaths(root, data, add) {
  let needsResolve = data.format === "lite";
  if (!needsResolve) {
    for (const item of data.items || []) {
      if (item.spec && !item.paths?.spec) needsResolve = true;
      if (item.playbook && !item.paths?.playbook) needsResolve = true;
    }
  }
  if (!needsResolve) return data;
  let corpus;
  try {
    corpus = loadCorpus(root).corpus;
  } catch (error) {
    if (add) add("error", "corpus_load_failed", "", "", "", error.message);
    return data;
  }
  const specs = new Map();
  const playbooks = new Map();
  for (const doc of corpus.docs) {
    if (!isAliasTarget(doc)) continue;
    const id = aliasFileKey(doc.path).replace(/\.md$/, "").replaceAll("/", ".");
    if (doc.kind === KIND_SPEC) specs.set(id, doc);
    if (doc.kind === KIND_PLAYBOOK) playbooks.set(id, doc);
  }
  for (const item of data.items || []) {
    if (!item.paths) item.paths = {};
    if (item.spec && !item.paths.spec) {
      const doc = specs.get(item.id);
      if (!doc) {
        if (add) add("error", "id_not_found", item.id, "id", item.id, "spec id not found in corpus");
      } else {
        item.paths.spec = doc.physicalRel;
        item.file_key = aliasFileKey(doc.path);
        if (!item.label) item.label = doc.label;
        if (!item.code) item.code = doc.name;
      }
    }
    if (item.playbook && !item.paths.playbook) {
      const doc = playbooks.get(item.id);
      if (!doc) {
        if (add) add("error", "id_not_found", item.id, "id", item.id, "playbook id not found in corpus");
      } else {
        item.paths.playbook = doc.physicalRel;
        item.file_key = aliasFileKey(doc.path);
        if (!item.label) item.label = doc.label;
      }
    }
  }
  return data;
}

function rewriteAliasFrontmatter(data, aliases, negativeAliases) {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  const lines = text.split("\n");
  if (!lines.length || lines[0].trim() !== "---") {
    let b = "---\n";
    b += writeFrontmatterArray("aliases", aliases);
    b += writeFrontmatterArray("negative_aliases", negativeAliases);
    b += `---\n\n${text}`;
    return Buffer.from(b);
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
    if (key === "aliases" || key === "negative_aliases") {
      while (i + 1 < end && isIndentedYAMLLine(lines[i + 1])) i += 1;
      continue;
    }
    kept.push(lines[i]);
  }
  let b = "---\n";
  for (const line of kept) b += `${line}\n`;
  b += writeFrontmatterArray("aliases", aliases);
  b += writeFrontmatterArray("negative_aliases", negativeAliases);
  b += "---";
  if (end + 1 < lines.length) b += `\n${lines.slice(end + 1).join("\n")}`;
  return Buffer.from(b);
}

function isAliasTarget(doc) {
  return !doc.isIndex && (doc.kind === KIND_SPEC || doc.kind === KIND_PLAYBOOK);
}

function aliasFileKey(logical) {
  if (isStructuredPath(logical)) {
    const base = path.posix.basename(logical);
    if (base === "spec.md" || base === "playbook.md" || base === "template.md") return path.posix.dirname(logical);
  }
  const slash = logical.indexOf("/");
  return slash < 0 ? logical : logical.slice(slash + 1);
}

function aliasTemplatePath(resolver, logical, fileKey) {
  if (isStructuredPath(logical)) {
    const template = path.posix.join(fileKey, "template.md");
    try {
      if (statSync(resolver.resolve(template)).isFile()) return resolver.resolveRel(template);
    } catch {
      return "";
    }
    return "";
  }
  return resolver.resolveRel(`templates/${fileKey}`);
}

function aliasTargetSet(targets) {
  if (!targets || !targets.length) targets = ["spec", "playbooks"];
  const out = new Set();
  for (let target of targets) {
    target = String(target || "").trim();
    if (target === "playbook") target = "playbooks";
    if (target === "spec" || target === "playbooks") out.add(target);
  }
  return out;
}

function aliasTargetAllowed(targets, kind) {
  if (kind === KIND_SPEC) return targets.has("spec");
  if (kind === KIND_PLAYBOOK) return targets.has("playbooks");
  return false;
}

export function commonWikiRoot(resolver) {
  const roots = [resolver.paths.spec, resolver.paths.playbooks];
  let prefix = path.posix.dirname(roots[0]);
  for (const root of roots.slice(1)) {
    while (prefix !== "." && prefix !== "" && !root.startsWith(`${prefix}/`)) {
      prefix = path.posix.dirname(prefix);
    }
  }
  return prefix === "." || prefix === "" ? "." : prefix;
}

function isPlaceholderShortDoc(root, rel) {
  let data;
  try {
    data = readFileSync(path.join(root, rel), "utf8");
  } catch {
    return false;
  }
  const body = stripFrontmatterText(data).trim();
  const text = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("");
  return [...text].length <= 20 || text.includes("待补充") || text.toLowerCase().includes("todo");
}

function duplicateValueCount(values) {
  let count = 0;
  for (const n of values.values()) if (n > 1) count += 1;
  return count;
}

function writeScalar(indent, key, value) {
  return `${" ".repeat(indent)}${key}: ${quoteYAML(value || "")}\n`;
}

function writeArray(indent, key, values) {
  let b = `${" ".repeat(indent)}${key}:\n`;
  for (const value of values) b += `${" ".repeat(indent + 2)}- ${quoteYAML(value)}\n`;
  return b;
}

function writeLiteSection(name, items, includeCode) {
  let b = `${name}:\n`;
  for (const item of items) {
    b += `  - id: ${quoteYAML(item.id)}\n`;
    b += writeScalar(4, "label", item.label);
    if (includeCode) b += writeScalar(4, "code", item.code);
    b += writeArrayLite(4, "aliases", item.aliases || []);
    b += writeArrayLite(4, "negative_aliases", item.negative_aliases || []);
  }
  return b;
}

function writeArrayLite(indent, key, values) {
  if (!values.length) return `${" ".repeat(indent)}${key}: []\n`;
  return writeArray(indent, key, values);
}

function writeFrontmatterArray(key, values) {
  if (!values.length) return "";
  let b = `${key}:\n`;
  for (const value of values) b += `  - ${quoteYAML(value)}\n`;
  return b;
}

export function quoteYAML(value) {
  if (value === "") return `""`;
  if (/[:#\[\]{}",]/.test(value) || value.startsWith(" ") || value.endsWith(" ")) return JSON.stringify(value);
  return value;
}

export function splitYAMLKV(line) {
  const cut = line.indexOf(":");
  if (cut < 0) return null;
  return { key: line.slice(0, cut).trim(), value: line.slice(cut + 1).trim() };
}

export function cleanYAMLScalar(value) {
  value = String(value || "").trim();
  if (value === `""` || value === "''") return "";
  return value.replace(/^["']|["']$/g, "");
}

export function parseInlineYAMLArray(value) {
  value = String(value || "").trim();
  if (!value) return [];
  const inner = value.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return inner.split(",").map((part) => cleanYAMLScalar(part));
}

function isInlineYAMLArray(value) {
  value = String(value || "").trim();
  return value.startsWith("[") && value.endsWith("]");
}

function checkAliasPath(root, item, rel, field, add) {
  if (!rel) return;
  try {
    statSync(path.join(root, rel));
  } catch {
    add("error", "file_not_found", item.id, `paths.${field}`, rel, "target file does not exist");
    return;
  }
  if (!item.file_key) return;
  const logical = aliasLogicalPath(rel);
  if (isStructuredPath(logical)) {
    let want = path.posix.join(item.file_key, `${field}.md`);
    if (field === "playbook") want = path.posix.join(item.file_key, "playbook.md");
    if (field === "template") want = path.posix.join(item.file_key, "template.md");
    if (logical !== want) add("warning", "path_file_key_mismatch", item.id, `paths.${field}`, rel, "path does not match file_key");
    return;
  }
  let wantSuffix = `${field}/${item.file_key}`;
  if (field === "playbook") wantSuffix = `playbooks/${item.file_key}`;
  if (!rel.replaceAll("\\", "/").endsWith(wantSuffix)) {
    add("warning", "path_file_key_mismatch", item.id, `paths.${field}`, rel, "path does not match file_key");
  }
}

function checkAliasList(item, field, values, add) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) add("error", "duplicate_alias_in_item", item, field, value, "duplicate alias in same item");
    seen.add(value);
  }
}

function checkAliasQualityForField(item, field, targetPath, label, code, fields, baseItems, opts, add) {
  if (!fields) return;
  const targetLogical = aliasLogicalPath(targetPath);
  for (const alias of fields.aliases || []) {
    const runeLen = [...alias].length;
    if (runeLen < opts.minAliasRunes) add("error", "alias_too_short", item.id, field, alias, `alias is shorter than ${opts.minAliasRunes} characters`);
    if (runeLen > opts.maxAliasRunes) add("warning", "alias_too_long", item.id, field, alias, `alias is longer than ${opts.maxAliasRunes} characters`);
    if (containsBracket(alias)) add("error", "alias_contains_brackets", item.id, field, alias, "alias must not contain brackets");
    if (normalizedEqual(alias, label)) add("error", "alias_equals_label", item.id, field, alias, "alias duplicates the metric label");
    if (normalizedEqual(alias, code)) add("error", "alias_equals_code", item.id, field, alias, "alias duplicates the metric code");
    if (!targetLogical) continue;
    for (const match of search(baseItems, alias, { topN: 0 })) {
      if (match.targetPath === targetLogical) {
        add("error", "alias_redundant_with_base_recall", item.id, field, alias, `alias query already recalls target via label/name: ${targetLogical}`);
        break;
      }
      add("error", "alias_overlaps_base_recall", item.id, field, alias, `alias query already recalls via label/name: ${match.targetPath}`);
      break;
    }
  }
}

function baseRecallItems(root) {
  const { corpus } = loadCorpus(root);
  const items = [];
  for (const doc of corpus.docs) {
    if (doc.kind !== KIND_SPEC) continue;
    for (const term of [doc.label, doc.name]) {
      if (term) items.push({ term, targetPath: doc.path });
    }
  }
  return items;
}

function comboPlaybookPathSet(root) {
  const { corpus } = loadCorpus(root);
  return new Set(corpus.docs.filter((doc) => doc.kind === KIND_PLAYBOOK && doc.playbook?.isCombo).map((doc) => doc.path));
}

function metricSpecPathSet(root) {
  const { corpus } = loadCorpus(root);
  return new Set(corpus.docs.filter((doc) => doc.kind === KIND_SPEC && doc.specType === SPEC_TYPE_METRIC).map((doc) => doc.path));
}

function aliasLogicalPath(pathValue) {
  return String(pathValue || "").trim().replaceAll("\\", "/").replace(/^wikis\//, "");
}

function normalizedEqual(a, b) {
  if (!a || !b) return false;
  return normalizeChinese(a) === normalizeChinese(b);
}

function containsBracket(value) {
  return /[()（）[\]【】{}]/.test(value);
}

function isGenericAlias(value) {
  value = String(value || "").trim();
  if ([...value].length <= 2) return true;
  return ["情况", "分析", "指标", "表现", "问题", "查看", "查询"].includes(value);
}

function intersectStrings(a, b) {
  const set = new Set(a);
  return uniqueStrings(b.filter((value) => set.has(value)));
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function otherOwners(owners, self) {
  return uniqueStrings(owners).filter((owner) => owner !== self);
}

function setDiff(a, b) {
  const inB = new Set(b);
  return a.filter((value) => !inB.has(value));
}

function hasChanges(c) {
  return c.aliasesAdded.length + c.aliasesRemoved.length + c.negativeAliasesAdded.length + c.negativeAliasesRemoved.length > 0;
}

export function firstPathPart(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "").split("/")[0] || "";
}

export function restPathParts(value) {
  const parts = String(value || "").replace(/^\/+|\/+$/g, "").split("/");
  return parts.length <= 1 ? "" : parts.slice(1).join("/");
}

export function topLevelYAMLKey(line) {
  if (!line.trim() || line.startsWith(" ") || line.startsWith("\t")) return "";
  const kv = splitYAMLKV(line.trim());
  return kv ? kv.key : "";
}

export function isIndentedYAMLLine(line) {
  return line.startsWith(" ") || line.startsWith("\t") || !line.trim();
}

function makeAdd(result) {
  return (level, code, item, field, value, message) => {
    const issue = { level, code, message };
    if (item) issue.item = item;
    if (field) issue.field = field;
    if (value) issue.value = value;
    if (level === "error") result.errors.push(issue);
    else result.warnings.push(issue);
  };
}

function pushMap(map, key, value) {
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

void SPEC_TYPE_METRIC;
