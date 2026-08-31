import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT_CONTEXT_ERROR_CODES, RootContextError } from "./root-context.js";

export const DEFAULT_CODEX_PLUGIN_SELECTOR = "harness-data@lumi-ai-lab";

export function resolveCodexHome(env = process.env) {
  return path.resolve(String(env.CODEX_HOME || path.join(os.homedir(), ".codex")));
}

export function userCodexConfigPath(codexHome) {
  return path.join(path.resolve(codexHome), "config.toml");
}

export function projectCodexConfigPath(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), ".codex", "config.toml");
}

export function resolveCodexPluginSelector(pluginRoot, options = {}) {
  const explicit = String(options.pluginSelector || "").trim();
  if (explicit) return explicit;
  const resolved = path.resolve(String(pluginRoot || ""));
  const parts = resolved.split(path.sep).filter(Boolean);
  const cacheIdx = parts.lastIndexOf("cache");
  if (cacheIdx >= 0 && parts[cacheIdx + 1] && parts[cacheIdx + 2]) {
    return `${parts[cacheIdx + 2]}@${parts[cacheIdx + 1]}`;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resolved, ".codex-plugin", "plugin.json"), "utf8"));
    const name = String(manifest?.name || "").trim() || "harness-data";
    return `${name}@lumi-ai-lab`;
  } catch {
    return DEFAULT_CODEX_PLUGIN_SELECTOR;
  }
}

export function quoteTomlKey(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatTomlValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return quoteTomlKey(value);
}

export function formatTomlTableHeader(keys) {
  return `[${keys.map((key, index) => (index === 0 && isBareTomlKey(key) ? key : quoteTomlKey(key))).join(".")}]`;
}

export function parseTomlTableHeader(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) return null;
  const end = trimmed.indexOf("]");
  if (end < 1) return null;
  return parseDottedTomlKeys(trimmed.slice(1, end));
}

export function readTomlTableAssignments(text, keys) {
  const normalized = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.length ? normalized.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const range = findTableRange(lines, keys);
  if (!range) return null;
  const values = {};
  for (const line of lines.slice(range.start + 1, range.end)) {
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[2]] = parseTomlScalar(match[3]);
  }
  return values;
}

export function upsertTomlTable(text, keys, assignments) {
  const original = String(text || "");
  const normalized = original.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.length ? normalized.split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const range = findTableRange(lines, keys);
  if (!range) {
    const block = [formatTomlTableHeader(keys), ...assignmentLines(assignments)].join("\n");
    if (!normalized.trim()) return `${block}\n`;
    const prefix = hadTrailingNewline ? normalized : `${normalized}\n`;
    const withGap = prefix.endsWith("\n\n") || prefix === "\n" ? prefix : `${prefix}\n`;
    return `${withGap}${block}\n`;
  }
  const nextBody = upsertAssignmentLines(lines.slice(range.start + 1, range.end), assignments);
  const next = [...lines.slice(0, range.start + 1), ...nextBody, ...lines.slice(range.end)];
  let result = next.join("\n");
  if (hadTrailingNewline || original === "") result += "\n";
  return result;
}

export function ensureWorkspaceDirectory(value, { pluginRoot = "", dataRoot = "", codexHome = "" } = {}) {
  const resolved = path.resolve(String(value || ""));
  if (!path.isAbsolute(resolved)) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `workspace root must be an absolute path: ${value}`);
  }
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o755 });
  }
  let info;
  try {
    info = fs.lstatSync(resolved);
  } catch (error) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `workspace root is unavailable: ${resolved}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RootContextError(ROOT_CONTEXT_ERROR_CODES.INVALID, `workspace root must be a regular directory: ${resolved}`);
  }
  const canonical = fs.realpathSync.native(resolved);
  const pluginCanonical = existingCanonical(pluginRoot);
  const dataCanonical = existingCanonical(dataRoot);
  if (pluginCanonical && (isPathWithin(canonical, pluginCanonical) || isPathWithin(pluginCanonical, canonical))) {
    throw overlapError(canonical);
  }
  if (dataCanonical && (isPathWithin(canonical, dataCanonical) || isPathWithin(dataCanonical, canonical))) {
    throw overlapError(canonical);
  }
  if (codexHome) {
    const userConfig = canonicalPath(userCodexConfigPath(codexHome));
    const projectConfig = canonicalPath(projectCodexConfigPath(canonical));
    if (projectConfig === userConfig) {
      throw new RootContextError(
        ROOT_CONTEXT_ERROR_CODES.INVALID,
        `workspace root would overwrite the user Codex config (${userConfig}); choose a project directory instead of ${canonical}`,
      );
    }
  }
  return canonical;
}

export function applyCodexPluginScope({
  codexHome,
  selector,
  enableRoots = [],
  disableRoots = [],
} = {}) {
  const resolvedHome = path.resolve(String(codexHome || ""));
  const pluginSelector = String(selector || "").trim() || DEFAULT_CODEX_PLUGIN_SELECTOR;
  const userConfig = userCodexConfigPath(resolvedHome);
  const enabled = uniquePaths(enableRoots);
  const disabled = uniquePaths(disableRoots).filter((root) => !enabled.includes(root));
  const plan = [];

  plan.push({
    path: userConfig,
    createMode: 0o600,
    transform(text) {
      let next = upsertTomlTable(text, ["plugins", pluginSelector], { enabled: false });
      for (const root of enabled) {
        next = upsertTomlTable(next, ["projects", root], { trust_level: "trusted" });
      }
      return next;
    },
  });

  for (const root of enabled) {
    const projectConfig = projectCodexConfigPath(root);
    if (canonicalPath(projectConfig) === canonicalPath(userConfig)) {
      throw new RootContextError(
        ROOT_CONTEXT_ERROR_CODES.INVALID,
        `workspace root would overwrite the user Codex config: ${root}`,
      );
    }
    plan.push({
      path: projectConfig,
      createMode: 0o644,
      transform(text) {
        return upsertTomlTable(text, ["plugins", pluginSelector], { enabled: true });
      },
    });
  }

  for (const root of disabled) {
    if (!fs.existsSync(root)) continue;
    const projectConfig = projectCodexConfigPath(root);
    if (canonicalPath(projectConfig) === canonicalPath(userConfig)) continue;
    if (!fs.existsSync(projectConfig) && !fs.existsSync(path.dirname(projectConfig))) continue;
    plan.push({
      path: projectConfig,
      createMode: 0o644,
      transform(text) {
        return upsertTomlTable(text, ["plugins", pluginSelector], { enabled: false });
      },
    });
  }

  applyTextEdits(plan);
  return {
    status: "written",
    selector: pluginSelector,
    userConfigPath: userConfig,
    enabled,
    disabled,
  };
}

function overlapError(canonical) {
  return new RootContextError(
    ROOT_CONTEXT_ERROR_CODES.INVALID,
    `workspace root overlaps Harness Data roots: ${canonical}; pass --workspace-allowlist /path/to/your/project (not the plugin cache or dataRoot)`,
  );
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ""));
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(canonicalPath(parent), path.basename(resolved));
}

function existingCanonical(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return canonicalPath(text);
}

function uniquePaths(values) {
  return [...new Set((values || []).map((value) => path.resolve(String(value))).filter(Boolean))];
}

function isBareTomlKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value || ""));
}

function isPathWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function parseDottedTomlKeys(inner) {
  const keys = [];
  let i = 0;
  const text = String(inner || "");
  while (i < text.length) {
    while (text[i] === " " || text[i] === "\t") i += 1;
    if (i >= text.length) break;
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      i += 1;
      let value = "";
      while (i < text.length) {
        if (quote === '"' && text[i] === "\\") {
          i += 1;
          const escaped = text[i];
          if (escaped === "n") value += "\n";
          else if (escaped === "t") value += "\t";
          else value += escaped || "";
          i += 1;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      keys.push(value);
    } else {
      const start = i;
      while (i < text.length && text[i] !== ".") i += 1;
      keys.push(text.slice(start, i).trim());
    }
    while (text[i] === " " || text[i] === "\t") i += 1;
    if (text[i] === ".") {
      i += 1;
      continue;
    }
    break;
  }
  return keys;
}

function keysEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function findTableRange(lines, keys) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = String(lines[i] || "").trim();
    if (!trimmed.startsWith("[")) continue;
    const header = parseTomlTableHeader(lines[i]);
    if (start < 0) {
      if (header && keysEqual(header, keys)) start = i;
      continue;
    }
    return { start, end: i };
  }
  if (start < 0) return null;
  return { start, end: lines.length };
}

function assignmentLines(assignments) {
  return Object.entries(assignments).map(([key, value]) => `${key} = ${formatTomlValue(value)}`);
}

function upsertAssignmentLines(body, assignments) {
  const remaining = { ...assignments };
  const next = body.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (!match || !Object.hasOwn(remaining, match[2])) return line;
    const key = match[2];
    const replaced = `${match[1]}${key} = ${formatTomlValue(remaining[key])}`;
    delete remaining[key];
    return replaced;
  });
  const extras = assignmentLines(remaining);
  if (!extras.length) return next;
  let insertAt = next.length;
  while (insertAt > 0 && next[insertAt - 1].trim() === "") insertAt -= 1;
  next.splice(insertAt, 0, ...extras);
  return next;
}

function parseTomlScalar(raw) {
  const text = stripTomlComment(raw);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "inf" || text === "+inf") return Infinity;
  if (text === "-inf") return -Infinity;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    const quote = text[0];
    const inner = text.slice(1, -1);
    if (quote === "'") return inner;
    return inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return text;
}

function stripTomlComment(raw) {
  const text = String(raw || "");
  let inQuote = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuote) {
      if (char === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (char === quote) inQuote = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inQuote = true;
      quote = char;
      continue;
    }
    if (char === "#") return text.slice(0, i).trim();
  }
  return text.trim();
}

function applyTextEdits(plan) {
  const backups = [];
  try {
    for (const edit of plan) {
      const existed = fs.existsSync(edit.path);
      const original = existed ? fs.readFileSync(edit.path, "utf8") : null;
      const mode = existed ? fs.statSync(edit.path).mode & 0o777 : edit.createMode;
      const next = edit.transform(original || "");
      if (existed && next === original) {
        backups.push({ path: edit.path, original, existed, skip: true });
        continue;
      }
      writeTextAtomic(edit.path, next, mode);
      backups.push({ path: edit.path, original, existed, skip: false });
    }
  } catch (error) {
    for (const backup of backups.reverse()) {
      if (backup.skip) continue;
      if (!backup.existed) {
        fs.rmSync(backup.path, { force: true });
        continue;
      }
      writeTextAtomic(backup.path, backup.original, fs.existsSync(backup.path) ? fs.statSync(backup.path).mode & 0o777 : 0o600);
    }
    throw error;
  }
}

function writeTextAtomic(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, content, { encoding: "utf8", mode });
  if (process.platform !== "win32") fs.chmodSync(temp, mode);
  fs.renameSync(temp, filePath);
}
