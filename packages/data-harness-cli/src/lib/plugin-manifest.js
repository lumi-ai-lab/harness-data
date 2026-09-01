import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT_CONTEXT_ERROR_CODES, RootContextError } from "./root-context.js";

export const PLUGIN_MANIFEST_REL = "plugin-manifest.json";
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
export const QDM_HARNESS_PRODUCT = "qdm-harness";
export const CORE_API_VERSION = "v1";
export const STATE_SCHEMA_VERSION = 1;

/**
 * Read and validate an optional cross-host plugin manifest. Runtime consumers
 * remain compatible with development roots that have not been packaged yet;
 * artifact verification is responsible for requiring this file in releases.
 */
export function loadPluginManifest(root, { required = false, resourceManifest = null } = {}) {
  const filePath = path.join(root, PLUGIN_MANIFEST_REL);
  if (!existsSync(filePath)) {
    if (required) throw resourceMismatch("plugin manifest is missing; reinstall or rebuild the plugin artifact");
    return null;
  }
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw resourceMismatch(`plugin manifest is invalid JSON: ${error?.message || error}`);
  }
  return validatePluginManifest(value, { resourceManifest });
}

/**
 * Validate product version binding without making a manifest mandatory for a
 * source checkout. When an embedded resource bundle is present, its declared
 * version must agree with the resource manifest being consumed.
 */
export function validatePluginManifestBinding(root, resourceManifest = null) {
  const manifest = loadPluginManifest(root, { resourceManifest });
  if (!manifest) return null;

  const hostVersion = discoverHostPluginVersion(root);
  if (hostVersion && hostVersion !== manifest.plugin.version) {
    throw resourceMismatch(
      `plugin version mismatch: host manifest=${hostVersion}, plugin manifest=${manifest.plugin.version}; reinstall the plugin artifact`,
    );
  }
  return manifest;
}

export function validatePluginManifest(value, { resourceManifest = null } = {}) {
  const manifest = object(value, "plugin manifest");
  if (integer(manifest.schemaVersion, "plugin manifest.schemaVersion") !== PLUGIN_MANIFEST_SCHEMA_VERSION) {
    throw resourceMismatch(`unsupported plugin manifest schema: ${manifest.schemaVersion}`);
  }
  if (string(manifest.product, "plugin manifest.product") !== QDM_HARNESS_PRODUCT) {
    throw resourceMismatch(`unexpected plugin manifest product: ${manifest.product || "missing"}`);
  }
  string(manifest.host, "plugin manifest.host");

  const plugin = object(manifest.plugin, "plugin manifest.plugin");
  string(plugin.name, "plugin manifest.plugin.name");
  string(plugin.version, "plugin manifest.plugin.version");

  const core = object(manifest.core, "plugin manifest.core");
  if (string(core.apiVersion, "plugin manifest.core.apiVersion") !== CORE_API_VERSION) {
    throw resourceMismatch(`unsupported core API version: ${core.apiVersion || "missing"}`);
  }
  const packages = object(core.packages, "plugin manifest.core.packages");
  if (!Object.keys(packages).length) throw resourceMismatch("plugin manifest.core.packages must not be empty");
  for (const [key, entry] of Object.entries(packages)) {
    string(key, "plugin manifest.core.packages key");
    const item = object(entry, `plugin manifest.core.packages.${key}`);
    string(item.name, `plugin manifest.core.packages.${key}.name`);
    string(item.version, `plugin manifest.core.packages.${key}.version`);
  }

  const resource = object(manifest.resource, "plugin manifest.resource");
  const resourceMode = string(resource.mode, "plugin manifest.resource.mode");
  if (resourceMode !== "embedded" && resourceMode !== "external") {
    throw resourceMismatch(`unsupported plugin resource mode: ${resourceMode}`);
  }
  if (string(resource.resourceId, "plugin manifest.resource.resourceId") !== "qdm-harness-wiki") {
    throw resourceMismatch(`unexpected plugin resource id: ${resource.resourceId || "missing"}`);
  }
  if (integer(resource.schemaVersion, "plugin manifest.resource.schemaVersion") !== 1) {
    throw resourceMismatch(`unsupported plugin resource schema: ${resource.schemaVersion}`);
  }
  const contentVersion = optionalSha256(resource.contentVersion, "plugin manifest.resource.contentVersion");
  if (resourceMode === "embedded") {
    const resourcePath = safeRelativePath(resource.manifest, "plugin manifest.resource.manifest");
    if (!contentVersion) throw resourceMismatch("embedded plugin resource must declare contentVersion");
    if (resourceManifest) {
      if (resourcePath !== "resource-manifest.json") {
        throw resourceMismatch(`embedded plugin resource manifest must be ${PLUGIN_RESOURCE_MANIFEST_RELATIVE}`);
      }
      if (resourceManifest.resourceId !== resource.resourceId || resourceManifest.resourceSchemaVersion !== resource.schemaVersion) {
        throw resourceMismatch("plugin manifest resource identity does not match resource manifest");
      }
      if (resourceManifest.wikiContentVersion !== contentVersion) {
        throw resourceMismatch("plugin manifest resource version does not match resource manifest; reinstall plugin resources");
      }
    }
  } else if (resource.manifest) {
    safeRelativePath(resource.manifest, "plugin manifest.resource.manifest");
  }

  const metricCli = object(manifest.metricCli, "plugin manifest.metricCli");
  string(metricCli.binary, "plugin manifest.metricCli.binary");
  optionalString(metricCli.version, "plugin manifest.metricCli.version");

  const state = object(manifest.state, "plugin manifest.state");
  if (integer(state.schemaVersion, "plugin manifest.state.schemaVersion") !== STATE_SCHEMA_VERSION) {
    throw resourceMismatch(`unsupported state schema: ${state.schemaVersion}`);
  }

  const compatibility = object(manifest.compatibility, "plugin manifest.compatibility");
  string(compatibility.node, "plugin manifest.compatibility.node");
  if (string(compatibility.coreApi, "plugin manifest.compatibility.coreApi") !== CORE_API_VERSION) {
    throw resourceMismatch(`unsupported compatible core API: ${compatibility.coreApi || "missing"}`);
  }
  if (integer(compatibility.resourceSchema, "plugin manifest.compatibility.resourceSchema") !== 1) {
    throw resourceMismatch(`unsupported compatible resource schema: ${compatibility.resourceSchema}`);
  }
  if (integer(compatibility.stateSchema, "plugin manifest.compatibility.stateSchema") !== STATE_SCHEMA_VERSION) {
    throw resourceMismatch(`unsupported compatible state schema: ${compatibility.stateSchema}`);
  }
  return manifest;
}

export function safeRelativePath(value, label = "path") {
  const text = string(value, label).replaceAll("\\", "/");
  if (
    text.includes("\0") ||
    path.posix.isAbsolute(text) ||
    path.win32.isAbsolute(text) ||
    text === "." ||
    text === ".." ||
    text.startsWith("../") ||
    text.includes("/../")
  ) {
    throw resourceMismatch(`${label} must be a safe relative path`);
  }
  return text.replace(/^\.\//, "");
}

const PLUGIN_RESOURCE_MANIFEST_RELATIVE = "resource-manifest.json";

function discoverHostPluginVersion(root) {
  for (const relative of [
    ".codex-plugin/plugin.json",
    "agents/codex/.codex-plugin/plugin.json",
    "agents/workbuddy/.codebuddy-plugin/plugin.json",
    "plugin.json",
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(root, relative), "utf8"));
      if (parsed?.version) return String(parsed.version);
    } catch {
      // The host manifest is optional for cross-host artifacts.
    }
  }
  return "";
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw resourceMismatch(`${label} must be an object`);
  }
  return value;
}

function string(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw resourceMismatch(`${label} must be a non-empty string`);
  return text;
}

function optionalString(value, label) {
  if (value == null || value === "") return "";
  return string(value, label);
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw resourceMismatch(`${label} must be an integer`);
  return number;
}

function optionalSha256(value, label) {
  if (value == null || value === "") return "";
  const text = string(value, label);
  if (!/^[a-f0-9]{64}$/i.test(text)) throw resourceMismatch(`${label} must be a SHA-256 hex digest`);
  return text.toLowerCase();
}

function resourceMismatch(message) {
  return new RootContextError(ROOT_CONTEXT_ERROR_CODES.RESOURCE_MISMATCH, message);
}
