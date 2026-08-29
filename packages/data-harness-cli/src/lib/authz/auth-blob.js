import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { localBlobAllowed } from "../harness.js";
import {
  ENCRYPTED_BLOB_PREFIX,
  ENV_AUTH_BLOB,
  ENV_AUTH_BLOB_FILE,
  ENV_AUTH_USER_ID,
} from "./constants.js";
import { environMap } from "./env.js";

export const BLOB_SOURCE_ENV = "env";
export const BLOB_SOURCE_ENV_FILE = "env_file";
export const BLOB_SOURCE_FILE = "file";
export const BLOB_SOURCE_SECRET_REF_FILE = "secret_ref_file";

export function isEncryptedBlob(value) {
  return String(value || "").trim().startsWith(ENCRYPTED_BLOB_PREFIX);
}

/**
 * @param {{ projectRoot: string, config: import("../harness.js").AuthzConfig, env?: Record<string, string>, secretRef?: { kind: string, path?: string } | null }} opts
 */
export function resolveAuthBlob(opts) {
  const env = opts.env || environMap();
  if (opts.secretRef) {
    if (opts.secretRef.kind !== "file") {
      throw new Error(`secret reference kind is not supported by the local adapter: ${opts.secretRef.kind}`);
    }
    const file = readBlobFileAbsolute(opts.secretRef.path);
    const userId = localUserID(env, opts.config);
    if (!userId) {
      throw new Error("secretRef file requires HARNESS_AUTH_USER_ID or authz.dev_user_id");
    }
    return { blob: file.blob, sourcePath: file.path, userId, source: BLOB_SOURCE_SECRET_REF_FILE };
  }

  if (!localBlobAllowed(opts.config)) {
    throw new Error("authz mode is on but local blob fallback is disabled (allow_local_blob=false)");
  }

  const envBlob = String(env[ENV_AUTH_BLOB] || "").trim();
  if (envBlob) {
    if (!isEncryptedBlob(envBlob)) {
      throw new Error("HARNESS_AUTH_BLOB must be an encrypted qdm1enc blob");
    }
    const userId = localUserID(env, opts.config);
    if (!userId) {
      throw new Error("authz local blob requires HARNESS_AUTH_USER_ID or authz.dev_user_id");
    }
    return { blob: envBlob, userId, source: BLOB_SOURCE_ENV };
  }

  const envFile = String(env[ENV_AUTH_BLOB_FILE] || "").trim();
  if (envFile) {
    const file = readBlobFile(opts.projectRoot, envFile);
    const userId = localUserID(env, opts.config);
    if (!userId) {
      throw new Error("authz local blob requires HARNESS_AUTH_USER_ID or authz.dev_user_id");
    }
    return { blob: file.blob, sourcePath: file.path, userId, source: BLOB_SOURCE_ENV_FILE };
  }

  const configFile = String(opts.config?.blobFile || "").trim();
  if (configFile) {
    const file = readBlobFile(opts.projectRoot, configFile);
    const userId = String(opts.config?.devUserId || "").trim();
    if (!userId) {
      throw new Error("authz.blob_file requires authz.dev_user_id (no default principal)");
    }
    return { blob: file.blob, sourcePath: file.path, userId, source: BLOB_SOURCE_FILE };
  }

  throw new Error(
    "authz mode is on but no encrypted blob is available (HARNESS_AUTH_BLOB, HARNESS_AUTH_BLOB_FILE, or authz.blob_file)",
  );
}

function localUserID(env, cfg) {
  const fromEnv = String(env[ENV_AUTH_USER_ID] || "").trim();
  if (fromEnv) return fromEnv;
  return String(cfg?.devUserId || "").trim();
}

function readBlobFile(projectRoot, pathValue) {
  pathValue = String(pathValue || "").trim();
  if (!pathValue) throw new Error("auth blob file path is empty");
  const absolutePath = path.isAbsolute(pathValue) ? pathValue : path.join(projectRoot, pathValue);
  return readBlobFileAbsolute(absolutePath);
}

function readBlobFileAbsolute(absolute) {
  let info;
  try {
    info = lstatSync(absolute);
  } catch {
    throw new Error(`auth blob file not found: ${absolute}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`auth blob file must be a regular file: ${absolute}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
    throw new Error(`auth blob file permissions must be 0600: ${absolute}`);
  }
  const blob = readFileSync(absolute, "utf8").trim();
  if (!blob) throw new Error(`auth blob file is empty: ${absolute}`);
  if (!isEncryptedBlob(blob)) {
    throw new Error(`auth blob file must contain a qdm1enc blob: ${absolute}`);
  }
  return { blob, path: realpathSync(absolute) };
}
