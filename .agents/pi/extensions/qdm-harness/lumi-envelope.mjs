import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lumi Host auth file envelope (producer contract).
 * filename = hex(sha256(utf8(rawSessionId))) + ".json"
 * Never readdir/glob the envelope dir (may be mode 0710).
 */

/**
 * @param {string} dir
 * @param {string} rawSessionId
 * @returns {string | null}
 */
export function lumiEnvelopePath(dir, rawSessionId) {
  if (!dir || !rawSessionId) return null;
  const hex = createHash("sha256").update(rawSessionId, "utf8").digest("hex");
  return join(dir, `${hex}.json`);
}

/**
 * Load Host auth from Lumi requester-context envelope.
 *
 * Soft failure (ok:false, soft:true): missing env/file/expired/version → continue fallback.
 * Hard failure (ok:false, soft:false): a located envelope belongs to another
 * session or contains invalid Host material → do not degrade to local identity.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   sessionId?: string | null,
 *   now?: number,
 * }} [options]
 * @returns {{
 *   ok: true, blob: string, userId: string, source: "lumi_envelope", path: string
 * } | {
 *   ok: false, soft: boolean, error: string
 * }}
 */
export function loadLumiHostAuth(options = {}) {
  const env = options.env ?? process.env;
  const sessionId = options.sessionId;
  const now = options.now ?? Date.now();

  const dir = typeof env.LUMI_REQUESTER_CONTEXT_DIR === "string"
    ? env.LUMI_REQUESTER_CONTEXT_DIR.trim()
    : "";
  if (!dir || !sessionId) {
    return {
      ok: false,
      soft: true,
      error: "lumi envelope unavailable (missing dir or sessionId)",
    };
  }

  const path = lumiEnvelopePath(dir, sessionId);
  if (!path || !existsSync(path)) {
    return { ok: false, soft: true, error: "lumi envelope file not found" };
  }

  let body;
  try {
    body = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, soft: true, error: "lumi envelope unreadable" };
  }

  if (body?.version !== 1) {
    return {
      ok: false,
      soft: true,
      error: `unsupported envelope version: ${body?.version}`,
    };
  }

  // Byte-exact match; do not trim/normalize session id before compare.
  if (body.sessionId !== sessionId) {
    return { ok: false, soft: false, error: "lumi envelope sessionId mismatch" };
  }

  if (body.expiresAt) {
    const expiresMs = Date.parse(body.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= now) {
      return { ok: false, soft: true, error: "lumi envelope expired" };
    }
  }

  const auth = typeof body._auth === "string" ? body._auth.trim() : "";
  const userId = typeof body._auth_user_id === "string" ? body._auth_user_id.trim() : "";

  // Structure valid (v1 + session + not expired) but Host material bad → hard fail.
  if (!auth.startsWith("qdm1enc.") || !userId) {
    return {
      ok: false,
      soft: false,
      error: "lumi envelope missing valid _auth/_auth_user_id",
    };
  }

  return {
    ok: true,
    blob: auth,
    userId,
    source: "lumi_envelope",
    path,
  };
}
