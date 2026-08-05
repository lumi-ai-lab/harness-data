import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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
 * Priority: host _auth > (if allowLocalBlob) env HARNESS_AUTH_BLOB > env file > config blob_file.
 *
 * userId must come from host _auth_user_id, HARNESS_AUTH_USER_ID, or explicit authz.dev_user_id.
 * There is no default principal.
 *
 * @param {{
 *   projectRoot: string,
 *   config: AuthzConfig,
 *   hostAuth?: string | null,
 *   hostUserId?: string | null,
 *   env?: NodeJS.ProcessEnv,
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
    const userId = hostUserId || trim(config.devUserId);
    if (!userId) {
      return {
        ok: false,
        error: "authz requires _auth_user_id (or authz.dev_user_id for local fallback only)",
      };
    }
    return { ok: true, blob: hostAuth, userId, source: "host" };
  }

  if (!config.allowLocalBlob) {
    return { ok: false, error: "authz requires host _auth (local blob fallback disabled)" };
  }

  const envBlob = trim(env.HARNESS_AUTH_BLOB);
  if (envBlob) {
    if (!isEncryptedBlob(envBlob)) {
      return { ok: false, error: "HARNESS_AUTH_BLOB must be an encrypted qdm1enc blob" };
    }
    const userId = trim(env.HARNESS_AUTH_USER_ID) || trim(config.devUserId);
    if (!userId) {
      return {
        ok: false,
        error: "authz local blob requires HARNESS_AUTH_USER_ID or authz.dev_user_id",
      };
    }
    return { ok: true, blob: envBlob, userId, source: "env" };
  }

  const envFile = trim(env.HARNESS_AUTH_BLOB_FILE);
  if (envFile) {
    const loaded = readBlobFile(envFile, options.projectRoot);
    if (!loaded.ok) return loaded;
    const userId = trim(env.HARNESS_AUTH_USER_ID) || trim(config.devUserId);
    if (!userId) {
      return {
        ok: false,
        error: "authz local blob requires HARNESS_AUTH_USER_ID or authz.dev_user_id",
      };
    }
    return { ok: true, blob: loaded.blob, userId, source: "env_file" };
  }

  if (config.blobFile) {
    const loaded = readBlobFile(config.blobFile, options.projectRoot);
    if (!loaded.ok) return loaded;
    const userId = trim(config.devUserId);
    if (!userId) {
      return {
        ok: false,
        error: "authz.blob_file requires authz.dev_user_id (no default principal)",
      };
    }
    return { ok: true, blob: loaded.blob, userId, source: "file" };
  }

  return {
    ok: false,
    error:
      "authz mode is on but no encrypted blob is available (host _auth, HARNESS_AUTH_BLOB, or authz.blob_file)",
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
  if (!existsSync(absolute)) {
    return { ok: false, error: `auth blob file not found: ${absolute}` };
  }
  const blob = readFileSync(absolute, "utf8").trim();
  if (!blob) {
    return { ok: false, error: `auth blob file is empty: ${absolute}` };
  }
  if (!isEncryptedBlob(blob)) {
    return { ok: false, error: `auth blob file must contain a qdm1enc blob: ${absolute}` };
  }
  return { ok: true, blob };
}

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
