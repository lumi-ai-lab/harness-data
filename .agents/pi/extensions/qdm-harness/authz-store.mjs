/**
 * In-process auth slot: key = sessionId::userId → encrypted blob.
 * Also tracks the current turn binding per sessionId so tool_call uses the
 * user that initiated this turn (safe when multiple users share a session).
 */
export class AuthzStateStore {
  constructor() {
    /** @type {Map<string, string>} */
    this.blobs = new Map();
    /** @type {Map<string, { userId: string, blob: string, source: string }>} */
    this.currentTurn = new Map();
  }

  /**
   * @param {string} sessionId
   * @param {string} userId
   */
  static slotKey(sessionId, userId) {
    return `${sessionId}::${userId}`;
  }

  /**
   * @param {string} sessionId
   * @param {string} userId
   * @param {string} blob
   * @param {string} [source]
   */
  bind(sessionId, userId, blob, source = "unknown") {
    const sid = String(sessionId || "unknown");
    const uid = String(userId || "").trim();
    const value = String(blob || "").trim();
    if (!uid) throw new Error("authz bind requires userId");
    if (!value) throw new Error("authz bind requires encrypted blob");
    this.blobs.set(AuthzStateStore.slotKey(sid, uid), value);
    this.currentTurn.set(sid, { userId: uid, blob: value, source });
  }

  /**
   * @param {string} sessionId
   * @returns {{ userId: string, blob: string, source: string } | null}
   */
  getCurrentTurn(sessionId) {
    return this.currentTurn.get(String(sessionId || "unknown")) ?? null;
  }

  /**
   * @param {string} sessionId
   * @param {string} userId
   */
  getBlob(sessionId, userId) {
    return this.blobs.get(AuthzStateStore.slotKey(sessionId, userId)) ?? null;
  }

  /**
   * @param {string} [sessionId]
   */
  clear(sessionId) {
    if (sessionId == null || sessionId === "") {
      this.blobs.clear();
      this.currentTurn.clear();
      return;
    }
    const sid = String(sessionId);
    this.currentTurn.delete(sid);
    const prefix = `${sid}::`;
    for (const key of this.blobs.keys()) {
      if (key.startsWith(prefix)) this.blobs.delete(key);
    }
  }
}
