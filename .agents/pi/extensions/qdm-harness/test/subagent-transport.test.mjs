import assert from "node:assert/strict";
import test from "node:test";

import {
  SubagentTransportManager,
  probeSubagentTransport,
} from "../orchestration/subagent-transport.ts";

const REQUEST = "prompt-template:subagent:request";
const STARTED = "prompt-template:subagent:started";
const UPDATE = "prompt-template:subagent:update";
const RESPONSE = "prompt-template:subagent:response";
const CANCEL = "prompt-template:subagent:cancel";
const SLASH_REQUEST = "subagent:slash:request";
const SLASH_STARTED = "subagent:slash:started";
const SLASH_RESPONSE = "subagent:slash:response";
const SLASH_CANCEL = "subagent:slash:cancel";

class EventBus {
  listeners = new Map();
  emitted = [];
  onEmit;

  constructor(onEmit) {
    this.onEmit = onEmit;
  }

  on(event, handler) {
    const handlers = this.listeners.get(event) || new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }

  emit(event, data) {
    this.emitted.push({ event, data: structuredClone(data) });
    for (const handler of [...(this.listeners.get(event) || [])]) handler(data);
    this.onEmit?.(event, data, this);
  }
}

function invocation(overrides = {}) {
  return {
    invocationId: "invocation-1",
    ownerRunId: "session-1:B2_WRITER:attempt-1",
    nodeId: "writer:card-1",
    sessionId: "session-1",
    stage: "B2_WRITER",
    attempt: "B2_WRITER:1:2026-08-18T00:00:00.000Z",
    agent: "report-writer",
    task: "write card-1",
    cwd: "/tmp/project",
    context: "fresh",
    resultSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    timeoutMs: 100,
    turnBudget: { maxTurns: 4, graceTurns: 1 },
    toolBudget: { hard: 3, block: "*" },
    ...overrides,
  };
}

for (const [name, response, expected] of [
  ["0.35.1 v1", { version: 1 }, "legacy-chain"],
  ["0.36-0.40 v2", { version: 2, identity: true }, "delegation-v2"],
  ["0.41+ canonical", { identity: true }, "delegation-canonical"],
]) {
  test(`capability probe classifies ${name} without starting a child`, async () => {
    let childStarts = 0;
    const bus = new EventBus((event, data, target) => {
      if (event === STARTED) childStarts += 1;
      if (event !== REQUEST) return;
      target.emit(RESPONSE, {
        ...response,
        requestId: data.requestId,
        ...(response.identity ? { ownerRunId: data.ownerRunId, nodeId: data.nodeId } : {}),
        status: "invalid_request",
        error: "missing agent",
      });
    });

    assert.equal(await probeSubagentTransport(bus, { probeTimeoutMs: 20 }), expected);
    assert.equal(childStarts, 0);
    assert.equal(bus.emitted.filter(({ event }) => event === CANCEL).length, 0);
  });
}

test("probe cancels and fails closed if malformed input unexpectedly starts", async () => {
  const bus = new EventBus((event, data, target) => {
    if (event === REQUEST) target.emit(STARTED, { version: 2, ...data });
  });

  await assert.rejects(
    probeSubagentTransport(bus, { probeTimeoutMs: 20 }),
    /unexpectedly STARTED/,
  );
  assert.deepEqual(bus.emitted.find(({ event }) => event === CANCEL).data.version, 2);
});

for (const [kind, requestEvent, startedEvent, updateEvent] of [
  ["delegation-canonical", REQUEST, STARTED, UPDATE],
  ["delegation-v2", REQUEST, STARTED, UPDATE],
  ["legacy-chain", SLASH_REQUEST, SLASH_STARTED, "subagent:slash:update"],
]) {
  test(`${kind} publishes STARTED progress before the first UPDATE`, async () => {
    const progress = [];
    const bus = new EventBus((event, data, target) => {
      if (event !== requestEvent || (kind !== "legacy-chain" && !("agent" in data))) return;
      const identity = kind === "legacy-chain"
        ? { requestId: data.requestId }
        : {
          ...(kind === "delegation-v2" ? { version: 2 } : {}),
          requestId: data.requestId,
          ownerRunId: data.ownerRunId,
          nodeId: data.nodeId,
        };
      target.emit(startedEvent, identity);
      target.emit(updateEvent, { ...identity, currentTool: "read", toolCount: 1 });
      if (kind === "legacy-chain") {
        target.emit(SLASH_RESPONSE, {
          requestId: data.requestId,
          isError: false,
          result: { details: { results: [{ exitCode: 0, structuredOutput: { ok: true } }] } },
        });
        return;
      }
      target.emit(RESPONSE, {
        ...identity,
        status: "completed",
        result: { kind: "structured", value: { ok: true } },
      });
    });
    const outcome = await new SubagentTransportManager(bus, { settlementGraceMs: 1 })
      .transport(kind)
      .invoke(invocation(), undefined, (value) => progress.push(value));
    assert.equal(outcome.status, "completed");
    assert.equal(progress[0].started, true);
    assert.equal(progress[0].currentTool, undefined);
    assert.equal(progress[1].currentTool, "read");
    assert.equal(progress[0].transport, kind);
  });
}

test("STARTED lifecycle persistence failure does not publish a running progress event", async () => {
  for (const [kind, requestEvent, startedEvent] of [
    ["delegation-canonical", REQUEST, STARTED],
    ["delegation-v2", REQUEST, STARTED],
    ["legacy-chain", SLASH_REQUEST, SLASH_STARTED],
  ]) {
    const progress = [];
    const bus = new EventBus((event, data, target) => {
      if (event !== requestEvent || (kind !== "legacy-chain" && !("agent" in data))) return;
      const identity = kind === "legacy-chain"
        ? { requestId: data.requestId }
        : {
          ...(kind === "delegation-v2" ? { version: 2 } : {}),
          requestId: data.requestId,
          ownerRunId: data.ownerRunId,
          nodeId: data.nodeId,
        };
      target.emit(startedEvent, identity);
    });
    const outcome = await new SubagentTransportManager(bus, {
      settlementGraceMs: 1,
      onLifecycle: ({ state }) => {
        if (state === "STARTED") throw new Error("cannot record start");
      },
    }).transport(kind).invoke(invocation(), undefined, (value) => progress.push(value));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.started, true);
    assert.equal(progress.length, 0, `${kind} must not publish running after a STARTED persist failure`);
  }
});

test("legacy adapter emits one strict chain step and normalizes structured output", async () => {
  const bus = new EventBus((event, data, target) => {
    if (event !== SLASH_REQUEST) return;
    assert.deepEqual(Object.keys(data).sort(), ["params", "requestId"]);
    assert.equal(data.params.chain.length, 1);
    assert.equal(data.params.chain[0].agent, "report-writer");
    assert.deepEqual(data.params.chain[0].outputSchema, invocation().resultSchema);
    assert.deepEqual(data.params.turnBudget, { maxTurns: 4, graceTurns: 1 });
    assert.deepEqual(data.params.chain[0].toolBudget, { hard: 3, block: "*" });
    target.emit(SLASH_STARTED, { requestId: data.requestId });
    target.emit(SLASH_RESPONSE, {
      requestId: data.requestId,
      isError: false,
      result: {
        content: [{ type: "text", text: "done" }],
        details: {
          results: [{ exitCode: 0, runId: "legacy-run", structuredOutput: { ok: true } }],
        },
      },
    });
  });
  const manager = new SubagentTransportManager(bus, { settlementGraceMs: 1 });
  const outcome = await manager.transport("legacy-chain").invoke(invocation());

  assert.deepEqual(outcome, {
    status: "completed",
    value: { ok: true },
    requestId: outcome.requestId,
    started: true,
    transport: "legacy-chain",
    runId: "legacy-run",
  });
});

for (const kind of ["delegation-v2", "delegation-canonical"]) {
  test(`${kind} adapter emits owned-leaf structured delegation and maps progress`, async () => {
    const progress = [];
    const bus = new EventBus((event, data, target) => {
      if (event !== REQUEST || !("agent" in data)) return;
      assert.equal(data.version, kind === "delegation-v2" ? 2 : undefined);
      assert.equal(data.ownerRunId, invocation().ownerRunId);
      assert.equal(data.nodeId, invocation().nodeId);
      assert.deepEqual(data.result, { kind: "structured", schema: invocation().resultSchema });
      const identity = {
        ...(kind === "delegation-v2" ? { version: 2 } : {}),
        requestId: data.requestId,
        ownerRunId: data.ownerRunId,
        nodeId: data.nodeId,
      };
      target.emit(STARTED, identity);
      target.emit(UPDATE, { ...identity, runId: "run-1", currentTool: "read", toolCount: 1 });
      target.emit(RESPONSE, {
        ...identity,
        status: "completed",
        runId: "run-1",
        result: { kind: "structured", value: { ok: true } },
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2, toolCalls: 1, durationMs: 5 },
      });
    });
    const manager = new SubagentTransportManager(bus, { settlementGraceMs: 1 });
    const outcome = await manager.transport(kind).invoke(invocation(), undefined, (value) => progress.push(value));

    assert.equal(outcome.status, "completed");
    assert.deepEqual(outcome.value, { ok: true });
    assert.equal(outcome.transport, kind);
    assert.equal(outcome.runId, "run-1");
    assert.equal(outcome.usage.toolCalls, 1);
    assert.deepEqual(progress.map(({ currentTool, toolCount, started, runId }) => ({ currentTool, toolCount, started, runId })), [
      { currentTool: undefined, toolCount: undefined, started: true, runId: undefined },
      { currentTool: "read", toolCount: 1, started: true, runId: "run-1" },
    ]);
  });
}

test("manager switches adapter once only for correlated pre-start invalid_request", async () => {
  let probeCount = 0;
  let businessCount = 0;
  const bus = new EventBus((event, data, target) => {
    if (event !== REQUEST) return;
    if (!("agent" in data)) {
      probeCount += 1;
      target.emit(RESPONSE, probeCount === 1
        ? { version: 2, requestId: data.requestId, ownerRunId: data.ownerRunId, nodeId: data.nodeId, status: "invalid_request" }
        : { requestId: data.requestId, ownerRunId: data.ownerRunId, nodeId: data.nodeId, status: "invalid_request" });
      return;
    }
    businessCount += 1;
    if (businessCount === 1) {
      target.emit(RESPONSE, {
        version: 2,
        requestId: data.requestId,
        status: "invalid_request",
        error: "protocol changed before start",
      });
      return;
    }
    const identity = { requestId: data.requestId, ownerRunId: data.ownerRunId, nodeId: data.nodeId };
    target.emit(STARTED, identity);
    target.emit(RESPONSE, { ...identity, status: "completed", result: { kind: "structured", value: { ok: true } } });
  });

  const outcome = await new SubagentTransportManager(bus, { probeTimeoutMs: 20, settlementGraceMs: 1 }).invoke(invocation());
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.transport, "delegation-canonical");
  assert.equal(probeCount, 2);
  assert.equal(businessCount, 2);
});

test("STARTED invalid_request never falls back or replays", async () => {
  let probeCount = 0;
  let businessCount = 0;
  const bus = new EventBus((event, data, target) => {
    if (event !== REQUEST) return;
    if (!("agent" in data)) {
      probeCount += 1;
      target.emit(RESPONSE, { version: 2, requestId: data.requestId, ownerRunId: data.ownerRunId, nodeId: data.nodeId, status: "invalid_request" });
      return;
    }
    businessCount += 1;
    const identity = { version: 2, requestId: data.requestId, ownerRunId: data.ownerRunId, nodeId: data.nodeId };
    target.emit(STARTED, identity);
    target.emit(RESPONSE, { ...identity, status: "invalid_request", error: "late protocol rejection" });
  });

  const outcome = await new SubagentTransportManager(bus, { probeTimeoutMs: 20, settlementGraceMs: 1 }).invoke(invocation());
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "invalid_request");
  assert.equal(outcome.started, true);
  assert.equal(probeCount, 1);
  assert.equal(businessCount, 1);
});

for (const [kind, requestEvent] of [
  ["delegation-canonical", REQUEST],
  ["legacy-chain", SLASH_REQUEST],
]) {
  test(`${kind} does not dispatch when EMITTED lifecycle persistence fails`, async () => {
    let businessCount = 0;
    const bus = new EventBus((event) => {
      if (event === requestEvent) businessCount += 1;
    });
    const outcome = await new SubagentTransportManager(bus, {
      settlementGraceMs: 1,
      onLifecycle: ({ state }) => {
        if (state === "EMITTED") throw new Error("disk unavailable");
      },
    }).transport(kind).invoke(invocation());

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.code, "transport_protocol_error");
    assert.equal(outcome.started, false);
    assert.match(outcome.message, /Cannot persist EMITTED.*disk unavailable/);
    assert.equal(businessCount, 0);
  });
}

for (const [kind, requestEvent, startedEvent, cancelEvent] of [
  ["delegation-canonical", REQUEST, STARTED, CANCEL],
  ["legacy-chain", SLASH_REQUEST, SLASH_STARTED, SLASH_CANCEL],
]) {
  test(`${kind} cancels once and never replays when STARTED lifecycle persistence fails`, async () => {
    let businessCount = 0;
    const bus = new EventBus((event, data, target) => {
      if (event !== requestEvent) return;
      businessCount += 1;
      const identity = kind === "legacy-chain"
        ? { requestId: data.requestId }
        : { requestId: data.requestId, ownerRunId: data.ownerRunId, nodeId: data.nodeId };
      target.emit(startedEvent, identity);
      if (kind === "legacy-chain") {
        target.emit(SLASH_RESPONSE, {
          requestId: data.requestId,
          isError: false,
          result: { details: { results: [{ exitCode: 0, structuredOutput: { ok: true } }] } },
        });
      } else {
        target.emit(RESPONSE, {
          ...identity,
          status: "completed",
          result: { kind: "structured", value: { ok: true } },
        });
      }
    });
    const outcome = await new SubagentTransportManager(bus, {
      settlementGraceMs: 1,
      onLifecycle: ({ state }) => {
        if (state === "STARTED") throw new Error("cannot record start");
      },
    }).transport(kind).invoke(invocation());

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.code, "transport_protocol_error");
    assert.equal(outcome.started, true);
    assert.match(outcome.message, /Cannot persist STARTED.*cannot record start/);
    assert.equal(businessCount, 1);
    assert.equal(bus.emitted.filter(({ event }) => event === cancelEvent).length, 1);
  });
}

test("terminal lifecycle persistence failure suppresses pre-start adapter replay", async () => {
  let probeCount = 0;
  let businessCount = 0;
  const bus = new EventBus((event, data, target) => {
    if (event !== REQUEST) return;
    if (!("agent" in data)) {
      probeCount += 1;
      target.emit(RESPONSE, {
        version: 2,
        requestId: data.requestId,
        ownerRunId: data.ownerRunId,
        nodeId: data.nodeId,
        status: "invalid_request",
      });
      return;
    }
    businessCount += 1;
    target.emit(RESPONSE, {
      version: 2,
      requestId: data.requestId,
      status: "invalid_request",
      error: "protocol changed before start",
    });
  });
  const outcome = await new SubagentTransportManager(bus, {
    probeTimeoutMs: 20,
    settlementGraceMs: 1,
    onLifecycle: ({ state }) => {
      if (state === "TERMINAL") throw new Error("cannot record terminal");
    },
  }).invoke(invocation());

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "transport_protocol_error");
  assert.equal(outcome.started, false);
  assert.match(outcome.message, /Cannot persist terminal.*cannot record terminal/);
  assert.equal(probeCount, 1);
  assert.equal(businessCount, 1);
});

test("timeout cancels once and ignores a late terminal response", async () => {
  let identity;
  const lifecycle = [];
  const bus = new EventBus((event, data, target) => {
    if (event !== REQUEST || !("agent" in data)) return;
    identity = { requestId: data.requestId, ownerRunId: data.ownerRunId, nodeId: data.nodeId };
    target.emit(STARTED, identity);
  });
  const manager = new SubagentTransportManager(bus, {
    settlementGraceMs: 1,
    onLifecycle: (event) => lifecycle.push(event),
  });
  const outcome = await manager.transport("delegation-canonical").invoke(invocation({ timeoutMs: 5 }));

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "transport_timeout");
  assert.equal(outcome.started, true);
  assert.equal(bus.emitted.filter(({ event }) => event === CANCEL).length, 1);
  bus.emit(RESPONSE, { ...identity, status: "completed", result: { kind: "structured", value: { ok: true } } });
  assert.equal(lifecycle.filter(({ state }) => state === "TERMINAL").length, 1);
});

test("abort preserves no-replay and sends the matching cancel identity", async () => {
  const controller = new AbortController();
  const bus = new EventBus((event, data, target) => {
    if (event !== REQUEST || !("agent" in data)) return;
    target.emit(STARTED, { version: 2, requestId: data.requestId, ownerRunId: data.ownerRunId, nodeId: data.nodeId });
    controller.abort();
  });
  const outcome = await new SubagentTransportManager(bus, { settlementGraceMs: 1 })
    .transport("delegation-v2")
    .invoke(invocation(), controller.signal);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.code, "cancelled");
  assert.equal(outcome.started, true);
  const cancel = bus.emitted.find(({ event }) => event === CANCEL).data;
  assert.deepEqual(cancel, {
    version: 2,
    requestId: outcome.requestId,
    ownerRunId: invocation().ownerRunId,
    nodeId: invocation().nodeId,
  });
  assert.equal(bus.emitted.filter(({ event, data }) => event === REQUEST && "agent" in data).length, 1);
  assert.equal(bus.emitted.filter(({ event }) => event === SLASH_CANCEL).length, 0);
});
