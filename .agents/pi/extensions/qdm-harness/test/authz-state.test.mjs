import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthorizationStateStore,
  canonicalBindingJson,
  encodeBindingBase64url,
  parseAuthzBindOutput,
} from "../authz-state.mjs";

function candidate(options = {}) {
  const binding = {
    version: 1,
    sessionId: options.sessionId ?? "session-a",
    requestId: options.requestId ?? "request-a",
    envelopeSha256: options.digest ?? "a".repeat(64),
    expiresAt: options.expiresAt ?? "2099-07-30T01:30:00Z",
  };
  return {
    binding,
    bindingBase64url: encodeBindingBase64url(binding),
    contextFingerprint: options.contextFingerprint ?? "c".repeat(64),
    summary: options.summary ?? "Requester: wecom / bot / user-a",
  };
}

function wirePayload(options = {}) {
  const value = candidate(options);
  return {
    binding: value.binding,
    bindingBase64url: value.bindingBase64url,
    contextFingerprint: value.contextFingerprint,
    issuedAt: "2099-07-30T01:00:00Z",
    summary: {
      channel: "wecom",
      botId: "bot",
      canonicalUserId: "user-a",
      manageAreaIds: ["CN07", "CN08"],
      categoryLevel1Ids: ["12", "13"],
    },
  };
}

test("authz-bind parser verifies exact binding JCS/base64url", () => {
  const value = wirePayload();
  const parsed = parseAuthzBindOutput(JSON.stringify(value), "session-a", { nowMs: 0 });

  assert.deepEqual(parsed, {
    binding: value.binding,
    bindingBase64url: value.bindingBase64url,
    contextFingerprint: value.contextFingerprint,
    summary: [
      "Requester: wecom / bot / user-a",
      "Authorized manageAreaIds: CN07, CN08",
      "Authorized categoryLevel1Ids: 12, 13",
      "Data rule: use only qdm-indicators-cli; the Facade applies final authorization.",
    ].join("\n"),
  });
  assert.equal(
    canonicalBindingJson(value.binding),
    '{"envelopeSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":"2099-07-30T01:30:00Z","requestId":"request-a","sessionId":"session-a","version":1}',
  );

  const tampered = { ...value, bindingBase64url: `${value.bindingBase64url}x` };
  assert.throws(
    () => parseAuthzBindOutput(JSON.stringify(tampered), "session-a", { nowMs: 0 }),
    /does not match the canonical binding/,
  );
});

test("authz-bind parser preserves an opaque raw ACP session ID", () => {
  const sessionId = " session-a ";
  const parsed = parseAuthzBindOutput(JSON.stringify(wirePayload({ sessionId })), sessionId, {
    nowMs: 0,
  });
  assert.equal(parsed.binding.sessionId, sessionId);
  assert.match(
    Buffer.from(parsed.bindingBase64url, "base64url").toString("utf8"),
    /"sessionId":" session-a "/,
  );
});

test("authz-bind parser rejects session mismatch, expired bindings, and binding material in summary", () => {
  const value = wirePayload();
  assert.throws(
    () => parseAuthzBindOutput(JSON.stringify(value), "session-b", { nowMs: 0 }),
    /does not match the Pi session/,
  );
  assert.throws(
    () =>
      parseAuthzBindOutput(JSON.stringify(wirePayload({ expiresAt: "2000-01-01T00:00:00Z" })), "session-a"),
    /invalid or expired/,
  );
  assert.throws(
    () =>
      parseAuthzBindOutput(
        JSON.stringify({
          ...wirePayload(),
          summary: {
            ...wirePayload().summary,
            canonicalUserId: `digest-${"a".repeat(64)}`,
          },
        }),
        "session-a",
        { nowMs: 0 },
      ),
    /executable binding material/,
  );
});

test("authorization state distinguishes idempotence, continuation, new request, and context changes", () => {
  const store = new AuthorizationStateStore();
  const initial = candidate();
  assert.equal(store.apply("session-a", initial).transition, "initial");
  assert.equal(store.apply("session-a", structuredClone(initial)).transition, "idempotent");

  const continuation = candidate({ digest: "b".repeat(64), summary: "continuation" });
  assert.equal(store.apply("session-a", continuation).transition, "continuation");
  assert.equal(store.getSession("session-a").binding.envelopeSha256, "b".repeat(64));

  const nextRequest = candidate({
    requestId: "request-b",
    digest: "c".repeat(64),
    contextFingerprint: "d".repeat(64),
  });
  assert.equal(store.apply("session-a", nextRequest).transition, "new_request");

  const changedContext = candidate({
    requestId: "request-b",
    digest: "d".repeat(64),
    contextFingerprint: "e".repeat(64),
  });
  assert.deepEqual(store.apply("session-a", changedContext), {
    accepted: false,
    transition: "context_changed",
  });
  assert.equal(store.getSession("session-a"), undefined);

  store.dropSessionBinding("session-a");
  assert.deepEqual(store.apply("session-a", structuredClone(changedContext)), {
    accepted: false,
    transition: "context_changed",
  });
  assert.equal(store.getSession("session-a"), undefined);

  const recoveredOnNewRequest = candidate({
    requestId: "request-c",
    digest: "e".repeat(64),
    contextFingerprint: "f".repeat(64),
  });
  assert.equal(store.apply("session-a", recoveredOnNewRequest).transition, "new_request");
  assert.equal(store.getSession("session-a"), recoveredOnNewRequest);
});

test("tool-call bindings are one-shot and never reread the latest session binding", () => {
  const store = new AuthorizationStateStore();
  const first = candidate({ sessionId: "session-a", digest: "a".repeat(64) });
  store.apply("session-a", first);
  const firstSnapshot = store.snapshotSession("session-a");

  const second = candidate({
    sessionId: "session-a",
    requestId: "request-b",
    digest: "b".repeat(64),
    contextFingerprint: "d".repeat(64),
  });
  store.apply("session-a", second);
  const secondSnapshot = store.snapshotSession("session-a");

  assert.equal(Object.isFrozen(firstSnapshot), true);
  assert.equal(store.bindToolCall("tool-old", firstSnapshot), true);
  assert.equal(store.bindToolCall("tool-new", secondSnapshot), true);
  assert.equal(store.consumeToolCall("tool-old"), first.bindingBase64url);
  assert.equal(store.consumeToolCall("tool-new"), second.bindingBase64url);
  assert.equal(store.consumeToolCall("tool-old"), undefined);
  assert.equal(store.pendingToolCalls, 0);
});

test("tool-call ID conflicts and session reset fail closed without erasing finalized snapshots early", () => {
  const store = new AuthorizationStateStore();
  const first = candidate({ sessionId: "session-a", digest: "a".repeat(64) });
  const second = candidate({ sessionId: "session-b", digest: "b".repeat(64) });
  store.apply("session-a", first);
  store.apply("session-b", second);
  const firstSnapshot = store.snapshotSession("session-a");
  const secondSnapshot = store.snapshotSession("session-b");

  assert.equal(store.bindToolCall("shared-id", firstSnapshot), true);
  assert.equal(store.bindToolCall("shared-id", secondSnapshot), false);
  assert.equal(store.consumeToolCall("shared-id"), undefined);

  store.bindToolCall("survives-refresh-failure", firstSnapshot);
  store.dropSessionBinding("session-a");
  assert.equal(store.consumeToolCall("survives-refresh-failure"), first.bindingBase64url);

  store.bindToolCall("cleared-on-reset", firstSnapshot);
  store.clearSession("session-a");
  assert.equal(store.consumeToolCall("cleared-on-reset"), undefined);
  assert.equal(store.pendingToolCalls, 0);
});
