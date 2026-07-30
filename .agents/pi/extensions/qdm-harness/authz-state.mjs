const BINDING_KEYS = ["envelopeSha256", "expiresAt", "requestId", "sessionId", "version"];
const AUTHZ_BIND_KEYS = ["binding", "bindingBase64url", "contextFingerprint", "issuedAt", "summary"];
const SUMMARY_KEYS = [
  "botId",
  "canonicalUserId",
  "categoryLevel1Ids",
  "channel",
  "manageAreaIds",
];
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 16 * 1024;

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertString(value, field, options = {}) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  if (options.maxLength && value.length > options.maxLength) {
    throw new Error(`${field} exceeds its length limit`);
  }
  return value;
}

function assertWellFormedUnicode(value, field) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${field} contains invalid Unicode`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${field} contains invalid Unicode`);
    }
  }
}

function assertWireText(value, field) {
  const text = assertString(value, field, { maxLength: 4096 });
  assertWellFormedUnicode(text, field);
  if (/\p{Cc}/u.test(text)) throw new Error(`${field} contains a control character`);
  return text;
}

function assertRawSessionId(value, field) {
  if (typeof value !== "string" || !value || value.length > 4096) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  assertWellFormedUnicode(value, field);
  if (value.includes("\0")) throw new Error(`${field} contains NUL`);
  return value;
}

function summaryIDs(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) {
    throw new Error(`${field} must be a non-empty bounded array`);
  }
  return value.map((entry, index) => assertWireText(entry, `${field}[${index}]`));
}

function formatSummary(value) {
  if (!hasExactKeys(value, SUMMARY_KEYS)) {
    throw new Error("authz-bind returned an unexpected summary shape");
  }
  const channel = assertWireText(value.channel, "summary.channel");
  const botId = assertWireText(value.botId, "summary.botId");
  const canonicalUserId = assertWireText(value.canonicalUserId, "summary.canonicalUserId");
  const manageAreaIds = summaryIDs(value.manageAreaIds, "summary.manageAreaIds");
  const categoryLevel1Ids = summaryIDs(value.categoryLevel1Ids, "summary.categoryLevel1Ids");
  const summary = [
    `Requester: ${channel} / ${botId} / ${canonicalUserId}`,
    `Authorized manageAreaIds: ${manageAreaIds.join(", ")}`,
    `Authorized categoryLevel1Ids: ${categoryLevel1Ids.join(", ")}`,
    "Data rule: use only qdm-indicators-cli; the Facade applies final authorization.",
  ].join("\n");
  if (summary.length > MAX_SUMMARY_LENGTH) throw new Error("summary exceeds its length limit");
  return summary;
}

export function canonicalBindingJson(binding) {
  return JSON.stringify({
    envelopeSha256: binding.envelopeSha256,
    expiresAt: binding.expiresAt,
    requestId: binding.requestId,
    sessionId: binding.sessionId,
    version: binding.version,
  });
}

export function encodeBindingBase64url(binding) {
  return Buffer.from(canonicalBindingJson(binding), "utf8").toString("base64url");
}

export function parseAuthzBindOutput(output, expectedSessionId, options = {}) {
  let payload;
  try {
    payload = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error("authz-bind returned invalid JSON");
  }

  if (!hasExactKeys(payload, AUTHZ_BIND_KEYS)) {
    throw new Error("authz-bind returned an unexpected object shape");
  }
  if (!hasExactKeys(payload.binding, BINDING_KEYS)) {
    throw new Error("authz-bind returned an unexpected binding shape");
  }

  const binding = payload.binding;
  if (binding.version !== 1) throw new Error("binding.version must be 1");

  const sessionId = assertRawSessionId(binding.sessionId, "binding.sessionId");
  const requestId = assertString(binding.requestId, "binding.requestId", { maxLength: 4096 });
  const envelopeSha256 = assertString(binding.envelopeSha256, "binding.envelopeSha256");
  const expiresAt = assertString(binding.expiresAt, "binding.expiresAt", { maxLength: 128 });
  for (const [field, value] of [
    ["binding.requestId", requestId],
    ["binding.expiresAt", expiresAt],
  ]) {
    assertWellFormedUnicode(value, field);
  }

  if (sessionId !== expectedSessionId) throw new Error("binding.sessionId does not match the Pi session");
  if (!/^[a-f0-9]{64}$/.test(envelopeSha256)) {
    throw new Error("binding.envelopeSha256 must be 64 lowercase hex characters");
  }

  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error("binding.expiresAt is invalid or expired");
  }

  const contextFingerprint = assertString(payload.contextFingerprint, "contextFingerprint", {
    maxLength: MAX_FINGERPRINT_LENGTH,
  });
  if (!/^[a-f0-9]{64}$/.test(contextFingerprint)) {
    throw new Error("contextFingerprint must be 64 lowercase hex characters");
  }

  const issuedAt = assertString(payload.issuedAt, "issuedAt", { maxLength: 128 });
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error("issuedAt is invalid");
  const summary = formatSummary(payload.summary);

  const bindingBase64url = assertString(payload.bindingBase64url, "bindingBase64url", {
    maxLength: 32 * 1024,
  });
  if (!/^[A-Za-z0-9_-]+$/.test(bindingBase64url)) {
    throw new Error("bindingBase64url is not unpadded base64url");
  }

  const normalizedBinding = {
    version: 1,
    sessionId,
    requestId,
    envelopeSha256,
    expiresAt,
  };
  const expectedBindingBase64url = encodeBindingBase64url(normalizedBinding);
  if (bindingBase64url !== expectedBindingBase64url) {
    throw new Error("bindingBase64url does not match the canonical binding");
  }

  if (summary.includes(bindingBase64url) || summary.includes(envelopeSha256)) {
    throw new Error("summary contains executable binding material");
  }

  return {
    binding: normalizedBinding,
    bindingBase64url,
    contextFingerprint,
    summary,
  };
}

export class AuthorizationStateStore {
  constructor() {
    this.sessions = new Map();
    this.rejectedRequests = new Map();
    this.toolCalls = new Map();
  }

  apply(sessionId, candidate) {
    const rejectedRequestId = this.rejectedRequests.get(sessionId);
    if (rejectedRequestId === candidate.binding.requestId) {
      return { accepted: false, transition: "context_changed" };
    }
    if (rejectedRequestId !== undefined) this.rejectedRequests.delete(sessionId);

    const previous = this.sessions.get(sessionId);
    if (previous?.binding.requestId === candidate.binding.requestId) {
      if (previous.contextFingerprint !== candidate.contextFingerprint) {
        this.dropSessionBinding(sessionId);
        this.rejectedRequests.set(sessionId, candidate.binding.requestId);
        return { accepted: false, transition: "context_changed" };
      }

      const transition =
        previous.binding.envelopeSha256 === candidate.binding.envelopeSha256
          ? "idempotent"
          : "continuation";
      this.sessions.set(sessionId, candidate);
      return { accepted: true, transition, state: candidate };
    }

    this.sessions.set(sessionId, candidate);
    return {
      accepted: true,
      transition: previous || rejectedRequestId !== undefined ? "new_request" : "initial",
      state: candidate,
    };
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  snapshotSession(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return undefined;
    return Object.freeze({
      sessionId,
      bindingBase64url: this.sessions.get(sessionId)?.bindingBase64url,
    });
  }

  bindToolCall(toolCallId, snapshot) {
    if (typeof toolCallId !== "string" || !toolCallId) return false;
    if (!isObject(snapshot) || typeof snapshot.sessionId !== "string" || !snapshot.sessionId) {
      return false;
    }

    const bindingBase64url =
      typeof snapshot.bindingBase64url === "string" && snapshot.bindingBase64url
        ? snapshot.bindingBase64url
        : undefined;
    const existing = this.toolCalls.get(toolCallId);
    if (!existing) {
      this.toolCalls.set(toolCallId, {
        bindingBase64url,
        conflicted: false,
        sessionIds: new Set([snapshot.sessionId]),
      });
      return true;
    }

    const isSameSnapshot =
      !existing.conflicted &&
      existing.sessionIds.size === 1 &&
      existing.sessionIds.has(snapshot.sessionId) &&
      existing.bindingBase64url === bindingBase64url;
    if (isSameSnapshot) return true;

    // Tool-call IDs are expected to be globally unique. If Pi or another
    // extension reuses one for a different message/session, retain only a
    // conflict tombstone so neither invocation can inherit the other's scope.
    existing.conflicted = true;
    existing.bindingBase64url = undefined;
    existing.sessionIds.add(snapshot.sessionId);
    return false;
  }

  consumeToolCall(toolCallId) {
    const captured = this.toolCalls.get(toolCallId);
    this.toolCalls.delete(toolCallId);
    return captured && !captured.conflicted ? captured.bindingBase64url : undefined;
  }

  clearToolCall(toolCallId) {
    this.toolCalls.delete(toolCallId);
  }

  dropSessionBinding(sessionId) {
    this.sessions.delete(sessionId);
  }

  clearSession(sessionId) {
    this.dropSessionBinding(sessionId);
    this.rejectedRequests.delete(sessionId);
    for (const [toolCallId, captured] of this.toolCalls) {
      if (captured.sessionIds.has(sessionId)) this.toolCalls.delete(toolCallId);
    }
  }

  clearAll() {
    this.sessions.clear();
    this.rejectedRequests.clear();
    this.toolCalls.clear();
  }

  get pendingToolCalls() {
    return this.toolCalls.size;
  }
}
