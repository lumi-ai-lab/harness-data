import assert from "node:assert/strict";
import test from "node:test";

import { LocalBridge } from "./local-bridge.mjs";

test("LocalBridge owns an explicit authenticated loopback lifecycle", async () => {
  const bridge = new LocalBridge({ handler: async (payload) => ({ ok: true, payload }) });
  const started = await bridge.start();
  assert.equal(started.state, "running");
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(bridge.status().token, undefined);

  const unauthenticated = await fetch(started.url, { method: "POST", body: "{}" });
  assert.equal(unauthenticated.status, 401);

  const authenticated = await fetch(started.url, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.connectionInfo().token}` },
    body: JSON.stringify({ request: "ping" }),
  });
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), { ok: true, payload: { request: "ping" } });

  const stopped = await bridge.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal((await bridge.stop()).state, "stopped");
});

test("LocalBridge rejects non-loopback bind addresses", () => {
  assert.throws(() => new LocalBridge({ host: "0.0.0.0", handler: () => ({}) }), /loopback/);
});
