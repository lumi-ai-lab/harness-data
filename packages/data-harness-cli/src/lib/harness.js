import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { cleanRelPath, exists, fromSlash, isAbsolutePath, pathJoinClean, toSlash } from "./fs-utils.js";
import { ROOT_CONTEXT_ERROR_CODES, RootContextError, workspaceIdentity } from "./root-context.js";

export const CONFIG_REL = "config/harness-config.yaml";
export const PATHS_CONFIG_REL = "config/harness-paths.yaml";
export const CLI_SOURCE_REL = "packages/data-harness-cli/src/main.js";

const LOGICAL_PREFIXES = ["spec", "routing", "playbooks", "templates", "metrics", "reports", "dims", "rules"];

/**
 * @typedef {{
 *   knowledge: string,
 *   spec: string,
 *   routing: string,
 *   playbooks: string,
 *   templates: string,
 * }} PathsConfig
 *
 * @typedef {{
 *   mode: "on" | "off",
 *   blobFile: string,
 *   devUserId: string,
 *   allowLocalBlob: boolean | null,
 * }} AuthzConfig
 *
 * @typedef {{ qdmMetricCli: string }} CLIConfig
 *
 * @typedef {{ paths: PathsConfig, cli: CLIConfig, authz: AuthzConfig }} Config
 */

export function authzEnabled(authz) {
  return String(authz?.mode || "").trim().toLowerCase() === "on";
}

export function localBlobAllowed(authz) {
  if (authz?.allowLocalBlob == null) return true;
  return Boolean(authz.allowLocalBlob);
}

/**
 * Normalize the owner roots used by path-aware consumers. A legacy string
 * remains a single-root compatibility adapter; a structured Root Context keeps
 * resource/data/workspace/state/secret ownership explicit.
 */
export function normalizeResolverOwners(rootOrContext) {
  if (typeof rootOrContext === "string") {
    const root = String(rootOrContext);
    return {
      resourceRoot: root,
      dataRoot: root,
      workspaceRoot: root,
      stateRoot: path.join(root, ".harness", "state"),
      secretRoot: "",
      secretRef: null,
      configPath: path.join(root, CONFIG_REL),
      legacy: true,
    };
  }
  if (!rootOrContext || typeof rootOrContext !== "object" || Array.isArray(rootOrContext)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, "path owners must be a root string or Root Context object");
  }
  const resourceRoot = String(rootOrContext.resourceRoot || rootOrContext.pluginRoot || "").trim();
  if (!resourceRoot) throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.PLUGIN_ROOT_UNAVAILABLE, "resourceRoot/pluginRoot is required");
  const dataRoot = String(rootOrContext.dataRoot || "").trim();
  const workspaceRoot = String(rootOrContext.workspaceRoot || "").trim();
  const schemaVersion = Number(rootOrContext.schemaVersion || 1);
  const host = String(rootOrContext.host || "unknown").trim() || "unknown";
  const stateRoot = String(rootOrContext.stateRoot || "").trim() ||
    (dataRoot && workspaceRoot ? path.join(dataRoot, "state", "workspaces", workspaceIdentity({ workspaceRoot, host, schemaVersion })) : "");
  return {
    resourceRoot,
    dataRoot,
    workspaceRoot,
    stateRoot,
    secretRoot: String(rootOrContext.secretRoot || "").trim(),
    secretRef: rootOrContext.secretRef || null,
    configPath: String(rootOrContext.configPath || "").trim() || (dataRoot ? path.join(dataRoot, "config", "settings.json") : ""),
    legacy: false,
  };
}

/** Legacy-only upward scan. New plugin adapters must pass Root Context. */
export function findLegacyRoot(start = ".") {
  let dir = path.resolve(start);
  for (;;) {
    if (isRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      const err = new Error("cannot find harness root");
      err.code = "ENOENT";
      throw err;
    }
    dir = parent;
  }
}

// Backward-compatible export for old runtime hooks and migration tooling.
export function findRoot(start = ".") {
  return findLegacyRoot(start);
}

export function isRoot(dir) {
  if (exists(path.join(dir, CONFIG_REL)) || exists(path.join(dir, PATHS_CONFIG_REL)) || exists(path.join(dir, ".harness"))) {
    return true;
  }
  if (exists(path.join(dir, CLI_SOURCE_REL))) return true;
  if (
    exists(path.join(dir, "metrics")) &&
    exists(path.join(dir, "reports")) &&
    exists(path.join(dir, "dims")) &&
    exists(path.join(dir, "rules"))
  ) {
    return true;
  }
  for (const name of ["spec", "routing", "playbooks"]) {
    try {
      if (!statSync(path.join(dir, name)).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function loadPathsConfig(rootOrContext) {
  return loadConfig(rootOrContext).paths;
}

export function loadConfig(rootOrContext) {
  const root = normalizeResolverOwners(rootOrContext).resourceRoot;
  let cfg = defaultConfig();
  const filePath = path.join(root, CONFIG_REL);
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return loadLegacyPathsConfig(root, defaultConfigForRoot(root));
    }
    throw error;
  }

  let section = "";
  for (const rawLine of raw.split(/\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const cut = line.indexOf(":");
    if (cut < 0) {
      throw new Error(`${CONFIG_REL}: unsupported line ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, cut).trim();
    const value = cleanPathValue(line.slice(cut + 1));
    if (indent === 0) {
      if (value !== "") {
        throw new Error(`${CONFIG_REL}: unsupported top-level value ${JSON.stringify(line)}`);
      }
      if (key === "paths" || key === "cli" || key === "authz") {
        section = key;
        continue;
      }
      throw new Error(`${CONFIG_REL}: unsupported section ${JSON.stringify(key)}`);
    }
    if (section === "paths") {
      switch (key) {
        case "knowledge":
          cfg.paths = pathsFromKnowledge(value);
          break;
        case "spec":
          cfg.paths.spec = value;
          break;
        case "routing":
          cfg.paths.routing = value;
          break;
        case "playbooks":
          cfg.paths.playbooks = value;
          break;
        case "templates":
          cfg.paths.templates = value;
          break;
        default:
          throw new Error(`${CONFIG_REL}: unsupported paths key ${JSON.stringify(key)}`);
      }
      continue;
    }
    if (section === "cli") {
      switch (key) {
        case "qdm_metric_cli":
          cfg.cli.qdmMetricCli = value;
          break;
        case "qdm_sql_cli":
        case "qdm_cas_cli":
        case "qdm_cmr_cli":
        case "qdm_indicators_cli":
          break;
        default:
          throw new Error(`${CONFIG_REL}: unsupported cli key ${JSON.stringify(key)}`);
      }
      continue;
    }
    if (section === "authz") {
      switch (key) {
        case "mode":
          cfg.authz.mode = value.toLowerCase();
          break;
        case "blob_file":
          cfg.authz.blobFile = value;
          break;
        case "dev_user_id":
          cfg.authz.devUserId = value;
          break;
        case "allow_local_blob":
          cfg.authz.allowLocalBlob = parseBoolConfig(value, `${CONFIG_REL}: authz.allow_local_blob`);
          break;
        default:
          throw new Error(`${CONFIG_REL}: unsupported authz key ${JSON.stringify(key)}`);
      }
      continue;
    }
    throw new Error(`${CONFIG_REL}: key ${JSON.stringify(key)} must be under a section`);
  }

  validatePathsConfig(CONFIG_REL, cfg.paths);
  normalizeAuthzConfig(cfg.authz, CONFIG_REL);
  return cfg;
}

function normalizeAuthzConfig(cfg, source) {
  const mode = String(cfg.mode || "").trim().toLowerCase();
  if (mode === "") {
    cfg.mode = "off";
  } else if (mode === "on" || mode === "off") {
    cfg.mode = mode;
  } else {
    throw new Error(`${source}: authz.mode must be on or off, got ${JSON.stringify(cfg.mode)}`);
  }
  cfg.devUserId = String(cfg.devUserId || "").trim();
}

function loadLegacyPathsConfig(root, cfg) {
  const filePath = path.join(root, PATHS_CONFIG_REL);
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return cfg;
    throw error;
  }
  let knowledge = ".";
  for (const rawLine of raw.split(/\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cut = line.indexOf(":");
    if (cut < 0 || line.slice(0, cut).trim() !== "knowledge") {
      throw new Error(`${PATHS_CONFIG_REL}: unsupported line ${JSON.stringify(line)}`);
    }
    knowledge = cleanPathValue(line.slice(cut + 1));
  }
  if (knowledge === "") {
    throw new Error(`${PATHS_CONFIG_REL}: knowledge must not be empty`);
  }
  cfg.paths = pathsFromKnowledge(knowledge);
  validatePathsConfig(PATHS_CONFIG_REL, cfg.paths);
  return cfg;
}

export function newPathResolver(rootOrContext) {
  const owners = normalizeResolverOwners(rootOrContext);
  return new PathResolver(owners, loadPathsConfig(rootOrContext));
}

export function newPathResolverWithPaths(rootOrContext, paths) {
  validatePathsConfig("runtime index", paths);
  return new PathResolver(normalizeResolverOwners(rootOrContext), paths);
}

export class PathResolver {
  /**
   * @param {string | ReturnType<typeof normalizeResolverOwners>} rootOrOwners
   * @param {PathsConfig} paths
   */
  constructor(rootOrOwners, paths) {
    this.owners = typeof rootOrOwners === "string" ? normalizeResolverOwners(rootOrOwners) : rootOrOwners;
    this.root = this.owners.resourceRoot;
    this.resourceRoot = this.owners.resourceRoot;
    this.dataRoot = this.owners.dataRoot;
    this.workspaceRoot = this.owners.workspaceRoot;
    this.stateRoot = this.owners.stateRoot;
    this.secretRoot = this.owners.secretRoot;
    this.secretRef = this.owners.secretRef;
    this.paths = paths;
  }

  resolve(rel) {
    return this.resolveOwned("resource", this.resolveRel(rel));
  }

  resolveOwned(owner, rel) {
    const base = this.ownerRoot(owner);
    const relative = cleanOwnerRel(rel);
    return path.join(base, fromSlash(relative));
  }

  resolveRel(rel) {
    rel = toSlash(path.normalize(fromSlash(String(rel || "").trim())));
    if (rel === "." || rel === "") return ".";
    if (rel === "index.md" && this.paths.knowledge) {
      const knowledge = cleanRelPath(this.paths.knowledge);
      if (knowledge !== "." && knowledge !== "") return `${knowledge}/index.md`;
    }
    if (isConfiguredPhysicalRel(rel, this.paths)) return rel;
    const split = splitLogicalRel(rel);
    if (!split) return rel;
    const base = pathForPrefix(this.paths, split.prefix);
    if (base === "." || base === "") return rel;
    if (!split.rest) return base;
    return `${base}/${split.rest}`;
  }

  knowledgePath(name) {
    return this.resolve(name);
  }

  logicalRel(rel) {
    rel = toSlash(path.normalize(fromSlash(String(rel || "").trim())));
    if (this.paths.knowledge && rel === pathJoinClean(this.paths.knowledge, "index.md")) {
      return "index.md";
    }
    for (const prefix of LOGICAL_PREFIXES) {
      const base = pathForPrefix(this.paths, prefix);
      if (base === "." || base === "") continue;
      if (rel === base) return prefix;
      if (rel.startsWith(`${base}/`)) return `${prefix}/${rel.slice(base.length + 1)}`;
    }
    return rel;
  }

  ownerRoot(owner) {
    switch (String(owner || "resource")) {
      case "resource":
      case "plugin":
        return this.resourceRoot;
      case "data":
        return requireOwnerRoot(this.dataRoot, "dataRoot");
      case "workspace":
        return requireOwnerRoot(this.workspaceRoot, "workspaceRoot", ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED);
      case "state":
        return requireOwnerRoot(this.stateRoot, "stateRoot");
      case "secret":
        return requireOwnerRoot(this.secretRoot, "secretRoot");
      default:
        throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `unsupported path owner: ${owner}`);
    }
  }
}

export function isKnowledgeLogicalRel(rel) {
  if (rel === "index.md") return true;
  for (const prefix of LOGICAL_PREFIXES) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function cleanPathValue(value) {
  value = String(value || "").trim();
  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash).trim();
  return value.replace(/^["']|["']$/g, "");
}

function defaultConfig() {
  return {
    paths: pathsFromKnowledge("."),
    cli: { qdmMetricCli: "" },
    authz: { mode: "off", blobFile: "", devUserId: "", allowLocalBlob: null },
  };
}

function parseBoolConfig(value, label) {
  switch (String(value).trim().toLowerCase()) {
    case "true":
    case "yes":
    case "1":
    case "on":
      return true;
    case "false":
    case "no":
    case "0":
    case "off":
      return false;
    default:
      throw new Error(`${label}: must be true or false, got ${JSON.stringify(value)}`);
  }
}

function defaultConfigForRoot(root) {
  const cfg = defaultConfig();
  if (
    exists(path.join(root, "wikis", "spec")) ||
    exists(path.join(root, "wikis", "playbooks")) ||
    exists(path.join(root, "wikis", "metrics")) ||
    exists(path.join(root, "wikis", "reports"))
  ) {
    cfg.paths = pathsFromKnowledge("wikis");
  }
  return cfg;
}

export function pathsFromKnowledge(knowledge) {
  knowledge = toSlash(path.normalize(fromSlash(String(knowledge || "").trim())));
  if (knowledge === "" || knowledge === ".") {
    return { knowledge: ".", spec: "spec", routing: "", playbooks: "playbooks", templates: "templates" };
  }
  return {
    knowledge,
    spec: `${knowledge}/spec`,
    routing: "",
    playbooks: `${knowledge}/playbooks`,
    templates: `${knowledge}/templates`,
  };
}

function validatePathsConfig(source, cfg) {
  if (cfg.knowledge && invalidRelPath(cfg.knowledge)) {
    throw new Error(`${source}: paths.knowledge must be a repository-relative path`);
  }
  for (const [name, rel] of [
    ["spec", cfg.spec],
    ["playbooks", cfg.playbooks],
    ["templates", cfg.templates],
  ]) {
    if (!rel) throw new Error(`${source}: paths.${name} must not be empty`);
    if (invalidRelPath(rel)) {
      throw new Error(`${source}: paths.${name} must be a repository-relative path`);
    }
  }
  if (cfg.routing && invalidRelPath(cfg.routing)) {
    throw new Error(`${source}: paths.routing must be a repository-relative path`);
  }
}

function splitLogicalRel(rel) {
  for (const prefix of LOGICAL_PREFIXES) {
    if (rel === prefix) return { prefix, rest: "" };
    if (rel.startsWith(`${prefix}/`)) return { prefix, rest: rel.slice(prefix.length + 1) };
  }
  return null;
}

function pathForPrefix(cfg, prefix) {
  switch (prefix) {
    case "spec":
      return cleanRelPath(cfg.spec);
    case "routing":
      return cleanRelPath(cfg.routing);
    case "playbooks":
      return cleanRelPath(cfg.playbooks);
    case "templates":
      return cleanRelPath(cfg.templates);
    case "metrics":
    case "reports":
    case "dims":
    case "rules":
      if (!String(cfg.knowledge || "").trim()) return "";
      return pathJoinClean(cfg.knowledge, prefix);
    default:
      return "";
  }
}

function isConfiguredPhysicalRel(rel, cfg) {
  for (const prefix of LOGICAL_PREFIXES) {
    const base = pathForPrefix(cfg, prefix);
    if (base !== "." && base !== "" && (rel === base || rel.startsWith(`${base}/`))) return true;
  }
  return false;
}

function invalidRelPath(rel) {
  rel = cleanRelPath(rel);
  return isAbsolutePath(rel) || rel === ".." || rel.startsWith("../") || rel.includes("/../");
}

function cleanOwnerRel(rel) {
  const value = String(rel || "").trim();
  if (!value || value === ".") return ".";
  if (isAbsolutePath(value)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, "owned path must be relative");
  }
  const normalized = toSlash(path.normalize(fromSlash(value)));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, "owned path escapes its root");
  }
  return normalized;
}

function requireOwnerRoot(value, name, code = ROOT_CONTEXT_ERROR_CODES.INVALID) {
  if (!value) throw new RootContextError(code, `${name} is unavailable`);
  return value;
}
