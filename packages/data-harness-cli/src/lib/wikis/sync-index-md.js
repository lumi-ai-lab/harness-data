import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { newPathResolver } from "../harness.js";
import { loadCorpus } from "./parse.js";
import { isStructuredPath, KIND_PLAYBOOK, KIND_SPEC, KIND_TEMPLATE, samePath, SPEC_TYPE_METRIC } from "./paths.js";

const GENERATED_START = "<!-- AUTO-GENERATED:START -->";
const GENERATED_END = "<!-- AUTO-GENERATED:END -->";

export function syncIndexMD(root, checkOnly = false) {
  const { corpus } = loadCorpus(root);
  const resolver = newPathResolver(root);
  const dirs = indexDirs(corpus.docs);
  const result = { checkOnly, scanned: dirs.length, changed: [], created: [], outdated: [] };
  for (const dir of dirs) {
    const block = renderIndexBlock(corpus, dir);
    const logical = path.posix.join(dir, "index.md");
    const physicalRel = resolver.resolveRel(logical);
    const full = path.join(root, physicalRel);
    let current;
    let exists = true;
    try {
      current = readFileSync(full);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      exists = false;
      current = Buffer.alloc(0);
    }
    const next = syncIndexContent(logical, current, block, exists);
    if (exists && Buffer.compare(current, next) === 0) continue;
    if (checkOnly) {
      result.outdated.push(logical);
      continue;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, next);
    if (exists) result.changed.push(logical);
    else result.created.push(logical);
  }
  return result;
}

function indexDirs(docs) {
  const dirs = new Set();
  for (const doc of docs) {
    if (!isSyncIndexDocPath(doc.path)) continue;
    let dir = path.posix.dirname(doc.path);
    while (dir !== "." && dir !== "") {
      dirs.add(dir);
      const parent = path.posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return [...dirs].filter(isSyncIndexDir).sort();
}

function isSyncIndexDocPath(logical) {
  return logical.startsWith("spec/") || logical.startsWith("playbooks/") || isStructuredPath(logical);
}

function isSyncIndexDir(dir) {
  return ["spec", "playbooks", "metrics", "reports", "dims", "rules"].some((root) => dir === root || dir.startsWith(`${root}/`));
}

function isStructuredIndexDir(dir) {
  return ["metrics", "reports", "dims", "rules"].some((root) => dir === root || dir.startsWith(`${root}/`));
}

function syncIndexContent(logical, current, block, exists) {
  if (!exists) return Buffer.from(defaultIndexContent(logical, block));
  const text = current.toString("utf8");
  const replacement = `${GENERATED_START}\n\n${block}\n${GENERATED_END}`;
  const start = text.indexOf(GENERATED_START);
  const end = text.indexOf(GENERATED_END);
  if (start >= 0 && end >= start) {
    const next = text.slice(0, start) + replacement + text.slice(end + GENERATED_END.length);
    return Buffer.from(ensureTrailingNewline(next));
  }
  let prefix = text.replace(/\n+$/, "");
  if (prefix) prefix += "\n\n";
  return Buffer.from(`${prefix}${replacement}\n`);
}

function defaultIndexContent(logical, block) {
  return `# ${defaultIndexTitle(logical)}\n\nTODO: 补充本层业务范围、阅读指引和边界规则。\n\n${GENERATED_START}\n\n${block}\n${GENERATED_END}\n`;
}

function defaultIndexTitle(logical) {
  const dir = path.posix.dirname(logical);
  const slash = dir.indexOf("/");
  const root = slash < 0 ? dir : dir.slice(0, slash);
  const domain = slash < 0 ? "" : dir.slice(slash + 1);
  const labels = {
    spec: ["Spec Index", "Spec Index"],
    playbooks: ["Playbooks Index", "Playbook Index"],
    metrics: ["Metrics Index", "Metrics Index"],
    reports: ["Reports Index", "Reports Index"],
    dims: ["Dims Index", "Dims Index"],
    rules: ["Rules Index", "Rules Index"],
  };
  if (!domain || domain === ".") return labels[root]?.[0] || "Index";
  return `${domain} ${labels[root]?.[1] || "Index"}`;
}

function renderIndexBlock(c, dir) {
  if (isStructuredIndexDir(dir)) return renderStructuredIndexBlock(c, dir);
  const kind = dir.startsWith("playbooks") ? "playbooks" : "spec";
  let b = `## 自动索引\n\n来源：\`${dir}\`\n\n`;
  b += kind === "spec" ? renderSpecIndex(c, dir) : renderPlaybookIndex(c, dir);
  return b.replace(/\n+$/, "");
}

function renderStructuredIndexBlock(c, dir) {
  const { specs, playbooks, templates } = structuredDocsInDir(c.docs, dir);
  const children = childDirs(c.docs, dir);
  let b = `## 自动索引\n\n来源：\`${dir}\`\n\n`;
  b += "### 能力地图\n\n";
  b += "| 能力 | 代表条目 | 数量 |\n| --- | --- | --- |\n";
  b += writeCapabilityRow("规格说明", representativeDocNames(specs), specs.length);
  b += writeCapabilityRow("取数手册", representativeDocNames(playbooks), playbooks.length);
  b += writeCapabilityRow("报告模板", representativeDocNames(templates), templates.length);
  b += writeCapabilityRow("下级目录", representativeDirs(children), children.length);
  b += "\n### 文档清单\n\n";
  if (specs.length + playbooks.length + templates.length === 0) {
    b += "暂无。\n\n";
  } else {
    b += "| 类型 | 文档 | 标题 |\n| --- | --- | --- |\n";
    for (const doc of [...specs, ...playbooks, ...templates]) {
      b += `| ${structuredDocType(doc)} | \`${path.posix.basename(doc.path)}\` | ${tableCell(firstNonEmpty(doc.label, doc.title, "-"))} |\n`;
    }
    b += "\n";
  }
  b += renderChildren(children);
  return b.replace(/\n+$/, "");
}

function renderSpecIndex(c, dir) {
  const { metrics, concepts } = specDocsInDir(c.docs, dir);
  const children = childDirs(c.docs, dir);
  let b = "### 能力地图\n\n";
  b += "| 能力 | 代表条目 | 数量 |\n| --- | --- | --- |\n";
  b += writeCapabilityRow("指标定义", representativeDocNames(metrics), metrics.length);
  b += writeCapabilityRow("规则与专题", representativeDocNames(concepts), concepts.length);
  b += writeCapabilityRow("下级领域", representativeDirs(children), children.length);
  b += "\n### 指标清单\n\n";
  if (metrics.length === 0) b += "暂无。\n\n";
  else {
    b += "| 指标 | code/name | spec | playbook |\n| --- | --- | --- | --- |\n";
    for (const doc of metrics) {
      b += `| ${tableCell(firstNonEmpty(doc.label, doc.title, path.posix.basename(doc.path)))} | \`${doc.name || ""}\` | \`${path.posix.basename(doc.path)}\` | \`${samePath(doc.path, "playbooks")}\` |\n`;
    }
    b += "\n";
  }
  b += "### 规则与专题\n\n";
  if (concepts.length === 0) b += "暂无。\n\n";
  else {
    b += "| 文档 | 标题 | 用途 |\n| --- | --- | --- |\n";
    for (const doc of concepts) {
      b += `| \`${path.posix.basename(doc.path)}\` | ${tableCell(firstNonEmpty(doc.title, doc.label, "-"))} | 规则或专题指引 |\n`;
    }
    b += "\n";
  }
  b += renderChildren(children);
  return b;
}

function renderPlaybookIndex(c, dir) {
  const { singles, reports } = playbookDocsInDir(c.docs, dir);
  const children = childDirs(c.docs, dir);
  let b = "### 能力地图\n\n";
  b += "| 能力 | 代表条目 | 数量 |\n| --- | --- | --- |\n";
  b += writeCapabilityRow("单指标取数", representativeDocNames(singles), singles.length);
  b += writeCapabilityRow("报告型取数", representativeDocNames(reports), reports.length);
  b += writeCapabilityRow("下级领域", representativeDirs(children), children.length);
  b += "\n### 单指标 Playbooks\n\n";
  if (singles.length === 0) b += "暂无。\n\n";
  else {
    b += "| 指标 | playbook | spec |\n| --- | --- | --- |\n";
    for (const doc of singles) {
      const specPath = doc.playbook?.specPath || "";
      b += `| ${tableCell(metricName(c, specPath))} | \`${path.posix.basename(doc.path)}\` | \`${specPath}\` |\n`;
    }
    b += "\n";
  }
  b += "### 报告型 Playbooks\n\n";
  if (reports.length === 0) b += "暂无。\n\n";
  else {
    b += "| 报告 | playbook | spec |\n| --- | --- | --- |\n";
    for (const doc of reports) {
      const specPath = doc.playbook?.specPath || "";
      b += `| ${tableCell(metricName(c, specPath))} | \`${path.posix.basename(doc.path)}\` | \`${specPath}\` |\n`;
    }
    b += "\n";
  }
  b += renderChildren(children);
  return b;
}

function renderChildren(children) {
  let b = "### 下级目录\n\n";
  if (children.length === 0) return `${b}暂无。\n`;
  b += "| 目录 | index |\n| --- | --- |\n";
  for (const child of children) {
    b += `| \`${path.posix.basename(child)}/\` | \`${child}/index.md\` |\n`;
  }
  return b;
}

function specDocsInDir(docs, dir) {
  const metrics = [];
  const concepts = [];
  for (const doc of docs) {
    if (doc.kind !== KIND_SPEC || doc.isIndex || path.posix.dirname(doc.path) !== dir) continue;
    if (doc.specType === SPEC_TYPE_METRIC) metrics.push(doc);
    else concepts.push(doc);
  }
  sortDocs(metrics);
  sortDocs(concepts);
  return { metrics, concepts };
}

function playbookDocsInDir(docs, dir) {
  const singles = [];
  const reports = [];
  for (const doc of docs) {
    if (doc.kind !== KIND_PLAYBOOK || doc.isIndex || path.posix.dirname(doc.path) !== dir) continue;
    if (doc.playbook?.isSingle) singles.push(doc);
    else if (path.posix.basename(doc.path).startsWith("r-")) reports.push(doc);
  }
  sortDocs(singles);
  sortDocs(reports);
  return { singles, reports };
}

function structuredDocsInDir(docs, dir) {
  const specs = [];
  const playbooks = [];
  const templates = [];
  for (const doc of docs) {
    if (doc.isIndex || path.posix.dirname(doc.path) !== dir) continue;
    if (doc.kind === KIND_SPEC) specs.push(doc);
    else if (doc.kind === KIND_PLAYBOOK) playbooks.push(doc);
    else if (doc.kind === KIND_TEMPLATE) templates.push(doc);
  }
  sortDocs(specs);
  sortDocs(playbooks);
  sortDocs(templates);
  return { specs, playbooks, templates };
}

function structuredDocType(doc) {
  if (doc.kind === KIND_SPEC) return doc.specType === SPEC_TYPE_METRIC ? "指标规格" : "规格说明";
  if (doc.kind === KIND_PLAYBOOK) return "取数手册";
  if (doc.kind === KIND_TEMPLATE) return "报告模板";
  return doc.kind;
}

function childDirs(docs, dir) {
  const children = new Set();
  const prefix = `${dir}/`;
  for (const doc of docs) {
    if (!doc.path.startsWith(prefix)) continue;
    const rest = doc.path.slice(prefix.length);
    const part = rest.split("/")[0];
    if (!part || rest === part) continue;
    children.add(path.posix.join(dir, part));
  }
  return [...children].sort();
}

function representativeDocNames(docs) {
  if (!docs.length) return "-";
  const limit = Math.min(3, docs.length);
  const names = docs.slice(0, limit).map((doc) => `\`${path.posix.basename(doc.path)}\``);
  if (docs.length > limit) names.push("...");
  return names.join(", ");
}

function representativeDirs(dirs) {
  if (!dirs.length) return "-";
  const limit = Math.min(3, dirs.length);
  const names = dirs.slice(0, limit).map((dir) => `\`${path.posix.basename(dir)}/\``);
  if (dirs.length > limit) names.push("...");
  return names.join(", ");
}

function writeCapabilityRow(capability, entries, count) {
  return `| ${capability} | ${entries} | ${count} |\n`;
}

function metricName(c, specPath) {
  const doc = c.byPath[specPath];
  if (doc) return firstNonEmpty(doc.label, doc.title, path.posix.basename(specPath));
  return path.posix.basename(specPath);
}

function sortDocs(docs) {
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function tableCell(value) {
  value = firstNonEmpty(value, "-");
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}
