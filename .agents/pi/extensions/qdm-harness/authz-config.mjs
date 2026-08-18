import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { loadLumiHostAuth } from "./lumi-envelope.mjs";

/**
 * @typedef {{
 *   mode: "off" | "on",
 *   blobFile: string,
 *   devUserId: string,
 *   allowLocalBlob: boolean,
 *   metricCli: string,
 * }} AuthzConfig
 */

/**
 * @param {string} projectRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AuthzConfig}
 */
export function loadAuthzConfig(projectRoot, env = process.env) {
  const defaults = {
    mode: "off",
    blobFile: "",
    devUserId: "",
    allowLocalBlob: true,
    metricCli: "",
  };

  const configPath = join(projectRoot, "config", "harness-config.yaml");
  if (!existsSync(configPath)) {
    return applyEnvOverrides(defaults, env, projectRoot);
  }

  const raw = readFileSync(configPath, "utf8");
  const parsed = parseAuthzSection(raw);
  const metricCli = parseCliMetricPath(raw) || "";
  return applyEnvOverrides({ ...defaults, ...parsed, metricCli: metricCli || defaults.metricCli }, env, projectRoot);
}

/**
 * Resolve absolute path to qdm-metric-cli.
 * Priority: env QDM_METRIC_CLI > harness-config cli.qdm_metric_cli > bin/qdm-metric-cli
 *
 * @param {string} projectRoot
 * @param {AuthzConfig} [config]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveMetricCliPath(projectRoot, config, env = process.env) {
  const candidates = [
    trim(env.QDM_METRIC_CLI),
    config?.metricCli ? resolveProjectPath(projectRoot, config.metricCli) : "",
    join(projectRoot, "bin", "qdm-metric-cli"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] || join(projectRoot, "bin", "qdm-metric-cli");
}

/**
 * @param {string} raw
 * @returns {Partial<AuthzConfig>}
 */
export function parseAuthzSection(raw) {
  /** @type {Partial<AuthzConfig>} */
  const out = {};
  let section = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const cut = trimmed.indexOf(":");
    if (cut < 0) continue;
    const key = trimmed.slice(0, cut).trim();
    let value = trimmed.slice(cut + 1).trim();
    const hash = value.indexOf("#");
    if (hash >= 0) value = value.slice(0, hash).trim();
    value = value.replace(/^["']|["']$/g, "");

    if (indent === 0) {
      section = value === "" ? key : "";
      continue;
    }
    if (section !== "authz") continue;
    switch (key) {
      case "mode":
        out.mode = value.toLowerCase() === "on" ? "on" : "off";
        break;
      case "blob_file":
        out.blobFile = value;
        break;
      case "dev_user_id":
        out.devUserId = value;
        break;
      case "allow_local_blob":
        out.allowLocalBlob = parseBool(value, true);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * @param {string} raw
 */
export function parseCliMetricPath(raw) {
  let section = "";
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const cut = trimmed.indexOf(":");
    if (cut < 0) continue;
    const key = trimmed.slice(0, cut).trim();
    let value = trimmed.slice(cut + 1).trim();
    const hash = value.indexOf("#");
    if (hash >= 0) value = value.slice(0, hash).trim();
    value = value.replace(/^["']|["']$/g, "");
    if (indent === 0) {
      section = value === "" ? key : "";
      continue;
    }
    if (section === "cli" && key === "qdm_metric_cli") return value;
  }
  return "";
}

/**
 * Resolve encrypted auth blob for the current turn.
 * Priority:
 *   1. host event _auth (future / direct Host)
 *   2. Lumi file envelope (production Host bypass; ignores allowLocalBlob)
 *   3–5. local env/file only when allowLocalBlob
 *
 * userId is retained only as Host/session metadata. The encrypted Blob is the
 * sole qdm authorization input.
 *
 * @param {{
 *   projectRoot: string,
 *   config: AuthzConfig,
 *   hostAuth?: string | null,
 *   hostUserId?: string | null,
 *   sessionId?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   now?: number,
 * }} options
 */
export function resolveAuthBlob(options) {
  const env = options.env ?? process.env;
  const config = options.config;
  const hostAuth = trim(options.hostAuth);
  const hostUserId = trim(options.hostUserId);

  if (hostAuth) {
    if (!isEncryptedBlob(hostAuth)) {
      return { ok: false, error: "host _auth must be an encrypted qdm1enc blob" };
    }
    return { ok: true, blob: hostAuth, userId: hostUserId || trim(config.devUserId), source: "host" };
  }

  // Host path #2: Lumi requester-context envelope (not gated by allowLocalBlob).
  const fromLumi = loadLumiHostAuth({
    env,
    sessionId: options.sessionId,
    now: options.now,
  });
  if (fromLumi.ok) {
    return {
      ok: true,
      blob: fromLumi.blob,
      userId: fromLumi.userId,
      source: fromLumi.source,
    };
  }
  // Hard fail: envelope structure valid but Host material invalid — do not degrade to local.
  if (fromLumi.soft === false) {
    return { ok: false, error: fromLumi.error };
  }

  if (!config.allowLocalBlob) {
    return {
      ok: false,
      error: "authz requires host _auth or Lumi envelope (local blob fallback disabled)",
    };
  }

  const envBlob = trim(env.HARNESS_AUTH_BLOB);
  if (envBlob) {
    if (!isEncryptedBlob(envBlob)) {
      return { ok: false, error: "HARNESS_AUTH_BLOB must be an encrypted qdm1enc blob" };
    }
    return { ok: true, blob: envBlob, userId: trim(env.HARNESS_AUTH_USER_ID) || trim(config.devUserId), source: "env" };
  }

  const envFile = trim(env.HARNESS_AUTH_BLOB_FILE);
  if (envFile) {
    const loaded = readBlobFile(envFile, options.projectRoot);
    if (!loaded.ok) return loaded;
    return { ok: true, blob: loaded.blob, userId: trim(env.HARNESS_AUTH_USER_ID) || trim(config.devUserId), source: "env_file" };
  }

  if (config.blobFile) {
    const loaded = readBlobFile(config.blobFile, options.projectRoot);
    if (!loaded.ok) return loaded;
    return { ok: true, blob: loaded.blob, userId: trim(config.devUserId), source: "file" };
  }

  return {
    ok: false,
    error:
      "authz mode is on but no encrypted blob is available (host _auth, Lumi envelope, HARNESS_AUTH_BLOB, or authz.blob_file)",
  };
}

export function isEncryptedBlob(value) {
  return typeof value === "string" && value.trim().startsWith("qdm1enc.");
}

/**
 * @param {string} pathValue
 * @param {string} projectRoot
 */
function readBlobFile(pathValue, projectRoot) {
  const absolute = isAbsolute(pathValue) ? pathValue : resolve(projectRoot, pathValue);
  try {
    const root = resolve(projectRoot);
    const insideProject = absolute === root || absolute.startsWith(`${root}${pathSeparator()}`);
    for (let current = absolute; ; current = resolve(current, "..")) {
      if (lstatSync(current).isSymbolicLink()) {
        return { ok: false, error: `auth blob file must not be a symlink: ${absolute}` };
      }
      const parent = resolve(current, "..");
      if (parent === current || (insideProject && current === root)) break;
    }
  } catch {
    return { ok: false, error: `auth blob file not found: ${absolute}` };
  }
  let fd;
  try {
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) return { ok: false, error: `auth blob file must be a regular file: ${absolute}` };
    if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
      return { ok: false, error: `auth blob file permissions must be 0600: ${absolute}` };
    }
    if (before.size > MAX_BLOB_BYTES) return { ok: false, error: `auth blob file exceeds maximum size: ${absolute}` };
    const chunks = [];
    let total = 0;
    while (total <= MAX_BLOB_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BLOB_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, total);
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs) {
      return { ok: false, error: `auth blob file changed while reading: ${absolute}` };
    }
    if (total > MAX_BLOB_BYTES) return { ok: false, error: `auth blob file exceeds maximum size: ${absolute}` };
    const blob = Buffer.concat(chunks).toString("utf8").trim();
    if (!blob) return { ok: false, error: `auth blob file is empty: ${absolute}` };
    if (!isEncryptedBlob(blob)) return { ok: false, error: `auth blob file must contain a qdm1enc blob: ${absolute}` };
    return { ok: true, blob };
  } catch {
    return { ok: false, error: `auth blob file unavailable: ${absolute}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function pathSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}

const MAX_BLOB_BYTES = 1 << 20;

/**
 * @param {AuthzConfig} config
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [projectRoot]
 */
function applyEnvOverrides(config, env, projectRoot = "") {
  const mode = trim(env.HARNESS_AUTHZ_MODE);
  if (mode === "on" || mode === "off") {
    config.mode = mode;
  }
  const metricFromEnv = trim(env.QDM_METRIC_CLI);
  if (metricFromEnv) {
    config.metricCli = metricFromEnv;
  } else if (config.metricCli && projectRoot && !isAbsolute(config.metricCli)) {
    config.metricCli = resolve(projectRoot, config.metricCli);
  }
  return config;
}

function resolveProjectPath(projectRoot, pathValue) {
  if (!pathValue) return "";
  return isAbsolute(pathValue) ? pathValue : resolve(projectRoot, pathValue);
}

function parseBool(value, fallback) {
  switch (String(value).toLowerCase()) {
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
      return fallback;
  }
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}
