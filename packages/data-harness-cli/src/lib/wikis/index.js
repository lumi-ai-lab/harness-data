import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadPathsConfig, newPathResolverWithPaths, normalizeResolverOwners } from "../harness.js";
import { validatePluginManifestBinding } from "../plugin-manifest.js";
import { ROOT_CONTEXT_ERROR_CODES, RootContextError } from "../root-context.js";
import { runAllChecks, runCheck } from "./checks.js";
import { KIND_PLAYBOOK, KIND_SPEC, SPEC_TYPE_METRIC } from "./paths.js";
import { loadCorpus } from "./parse.js";
import { loadTemplateSelectionPolicy, validateTemplateSelectionPolicy } from "./template-selection.js";

export const INDEX_REL = ".harness/index/wikis-index.json";
export const RUNTIME_INDEX_REL = ".harness/index/wikis-runtime-index.json";
export const RESOURCE_MANIFEST_REL = "resource-manifest.json";
export const RESOURCE_MANIFEST_SCHEMA_VERSION = 1;

export function loadIndex(rootOrContext) {
  const resourceRoot = normalizeResolverOwners(rootOrContext).resourceRoot;
  const index = readJSON(path.join(resourceRoot, INDEX_REL), "wikis index");
  validateResourceManifest(rootOrContext, { index });
  return index;
}

export function loadRuntimeIndex(rootOrContext) {
  const resourceRoot = normalizeResolverOwners(rootOrContext).resourceRoot;
  try {
    const index = readJSON(path.join(resourceRoot, RUNTIME_INDEX_REL), "runtime wikis index");
    validateResourceManifest(rootOrContext, { index });
    return index;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return buildRuntimeIndex(loadIndex(rootOrContext));
    }
    throw error;
  }
}

/**
 * Validate a relocatable resource bundle before structured plugin consumers use
 * it. Legacy roots deliberately skip this check so an old install --dir
 * runtime can remain readable during the migration window.
 */
export function validateResourceManifest(rootOrContext, { index = null } = {}) {
  const owners = normalizeResolverOwners(rootOrContext);
  if (owners.legacy) return null;
  const resourceRoot = owners.resourceRoot;
  const manifest = readResourceManifest(resourceRoot);
  validateManifestShape(manifest);
  const seen = new Set();
  for (const item of manifest.files) {
    const relative = safeManifestPath(item?.path);
    if (seen.has(relative)) throw resourceMismatch(`resource manifest contains duplicate file: ${relative}`);
    seen.add(relative);
    const expected = String(item?.sha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw resourceMismatch(`resource manifest has invalid SHA-256 for ${relative}`);
    }
    const filePath = path.join(resourceRoot, ...relative.split("/"));
    let info;
    try {
      info = lstatSync(filePath);
    } catch {
      throw resourceMismatch(`resource file is missing: ${relative}; reinstall plugin resources`);
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw resourceMismatch(`resource file must be a regular file: ${relative}`);
    }
    const actual = fileSha256(filePath);
    if (actual !== expected) {
      throw resourceMismatch(`resource hash mismatch: ${relative}; reinstall plugin resources`);
    }
  }
  if (index) validateIndexVersion(index, manifest);
  validatePluginManifestBinding(resourceRoot, manifest);
  return manifest;
}

export function loadResourceManifest(rootOrContext) {
  const owners = normalizeResolverOwners(rootOrContext);
  if (owners.legacy) return null;
  const manifest = readResourceManifest(owners.resourceRoot);
  validateManifestShape(manifest);
  return manifest;
}

function readResourceManifest(resourceRoot) {
  const filePath = path.join(resourceRoot, RESOURCE_MANIFEST_REL);
  if (!existsSync(filePath)) {
    throw resourceMismatch("resource manifest is missing; reinstall or update plugin resources");
  }
  return readJSON(filePath, "resource manifest");
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw resourceMismatch("resource manifest must be an object");
  }
  if (Number(manifest.schemaVersion) !== RESOURCE_MANIFEST_SCHEMA_VERSION) {
    throw resourceMismatch(`unsupported resource manifest schema: ${manifest.schemaVersion}`);
  }
  if (Number(manifest.resourceSchemaVersion) !== RESOURCE_MANIFEST_SCHEMA_VERSION) {
    throw resourceMismatch(`unsupported resource schema: ${manifest.resourceSchemaVersion}`);
  }
  if (manifest.resourceId !== "qdm-harness-wiki") {
    throw resourceMismatch(`unexpected resource id: ${manifest.resourceId || "missing"}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(manifest.wikiContentVersion || ""))) {
    throw resourceMismatch("resource manifest wikiContentVersion must be a SHA-256 hex digest");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw resourceMismatch("resource manifest files must be a non-empty array");
  }
}

function validateIndexVersion(index, manifest) {
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    throw resourceMismatch("resource index must be an object");
  }
  const meta = index.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw resourceMismatch("resource index meta is missing");
  }
  if (meta.resourceId !== manifest.resourceId) {
    throw resourceMismatch("resource index id does not match resource manifest");
  }
  if (Number(meta.resourceSchemaVersion) !== Number(manifest.resourceSchemaVersion)) {
    throw resourceMismatch("resource index schema does not match resource manifest");
  }
  const version = String(meta.wikiContentVersion || meta.resourceVersion || "").trim().toLowerCase();
  if (version !== String(manifest.wikiContentVersion).toLowerCase()) {
    throw resourceMismatch("resource index version does not match resource manifest; reinstall plugin resources");
  }
}

function safeManifestPath(value) {
  const relative = String(value || "").replaceAll("\\", "/");
  if (
    !relative ||
    relative.includes("\0") ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    relative.includes("/../")
  ) {
    throw resourceMismatch("resource manifest file path must be a safe relative path");
  }
  return relative.replace(/^\.\//, "");
}

function readJSON(filePath, label) {
  let data;
  try {
    data = readFileSync(filePath, "utf8");
  } catch (error) {
    throw error;
  }
  try {
    return JSON.parse(data);
  } catch (error) {
    throw resourceMismatch(`${label} is invalid JSON: ${error?.message || error}`);
  }
}

function resourceMismatch(message) {
  return new RootContextError(ROOT_CONTEXT_ERROR_CODES.RESOURCE_MISMATCH, message);
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

export function buildIndex(rootOrContext, skipChecks = false) {
  const root = normalizeResolverOwners(rootOrContext).resourceRoot;
  if (!skipChecks) {
    const results = runAllChecks(root, { maxErrors: 500 });
    const total = results.reduce((sum, result) => sum + result.totalErrors, 0);
    if (total > 0) throw new CheckFailedError(total);
  }
  const reliable = checkReliableBuildInputs(root);
  if (reliable) throw new Error(reliable);
  const { corpus } = loadCorpus(root);
  const { policy: templatePolicy, selectionPath } = loadTemplateSelectionPolicy(root);
  const policyErrs = validateTemplateSelectionPolicy(root, templatePolicy);
  if (policyErrs.length) {
    throw new Error(`template selection policy invalid: ${policyErrs.join("; ")}`);
  }
  const cfg = loadPathsConfig(root);
  const resourceFiles = collectResourceFiles(root, corpus, selectionPath);
  const wikiContentVersion = resourceContentVersion(resourceFiles);
  const idx = {
    meta: {
      version: 1,
      generatedAt: new Date().toISOString(),
      resourceId: "qdm-harness-wiki",
      resourceSchemaVersion: RESOURCE_MANIFEST_SCHEMA_VERSION,
      wikiContentVersion,
      resourceVersion: wikiContentVersion,
      // Kept as a relative compatibility marker; never persist the build
      // machine's absolute resource root in a relocatable index.
      root: ".",
      checksSkipped: skipChecks,
      paths: indexPaths(root, cfg),
    },
    docs: corpus.docs,
    recall: buildRecall(corpus.docs),
  };
  const runtime = buildRuntimeIndex(idx);
  runtime.templateSelection = [...(templatePolicy.templates || [])];
  writeJSONAtomic(rootOrContext, INDEX_REL, idx);
  writeJSONAtomic(rootOrContext, RUNTIME_INDEX_REL, runtime);
  writeJSONAtomic(rootOrContext, RESOURCE_MANIFEST_REL, buildResourceManifest(root, resourceFiles, wikiContentVersion, skipChecks));
  return {
    path: INDEX_REL,
    runtimePath: RUNTIME_INDEX_REL,
    resourceManifestPath: RESOURCE_MANIFEST_REL,
    resourceVersion: wikiContentVersion,
    checksSkipped: skipChecks,
    docCount: idx.docs.length,
    recallCount: idx.recall.length,
    runtimeDocCount: Object.keys(runtime.docsByPath).length,
    runtimeRecallCount: runtime.recall.length,
  };
}

function collectResourceFiles(root, corpus, selectionPath) {
  const paths = new Set();
  for (const doc of corpus.docs || []) {
    const relative = normalizeResourceRelative(doc.physicalRel);
    if (relative) paths.add(relative);
  }
  const selectionRelative = relativeFromRoot(root, selectionPath);
  if (selectionRelative && existsSync(path.join(root, selectionRelative))) paths.add(selectionRelative);
  return [...paths].sort().map((relative) => ({
    path: relative,
    sha256: fileSha256(path.join(root, relative)),
    kind: "wiki",
  }));
}

function buildResourceManifest(root, resourceFiles, wikiContentVersion, checksSkipped) {
  const indexFiles = [INDEX_REL, RUNTIME_INDEX_REL].map((relative) => ({
    path: relative,
    sha256: fileSha256(path.join(root, relative)),
    kind: "index",
  }));
  return {
    schemaVersion: RESOURCE_MANIFEST_SCHEMA_VERSION,
    resourceSchemaVersion: RESOURCE_MANIFEST_SCHEMA_VERSION,
    resourceId: "qdm-harness-wiki",
    wikiContentVersion,
    generatedAt: new Date().toISOString(),
    checksSkipped,
    files: [...resourceFiles, ...indexFiles].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function resourceContentVersion(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function relativeFromRoot(root, filePath) {
  if (!filePath) return "";
  return normalizeResourceRelative(path.relative(root, filePath));
}

function normalizeResourceRelative(value) {
  const relative = String(value || "").split(path.sep).join("/");
  if (!relative || relative === "." || path.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) return "";
  return relative;
}

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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

function writeJSONAtomic(rootOrContext, rel, value) {
  const resourceRoot = normalizeResolverOwners(rootOrContext).resourceRoot;
  const full = path.join(resourceRoot, rel);
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
