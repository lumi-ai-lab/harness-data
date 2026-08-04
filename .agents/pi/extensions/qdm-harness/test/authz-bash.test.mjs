import assert from "node:assert/strict";
import test from "node:test";

import {
  registerAuthzBashOverride,
  buildRejectedCommand,
  commandReferencesRealBinary,
} from "../authz-bash.mjs";

test("commandReferencesRealBinary detects direct real invocation", () => {
  assert.equal(
    commandReferencesRealBinary({
      command: "/workspace/bin/qdm-metric-cli-real analysis execute --metric x",
    }),
    true,
  );
  assert.equal(commandReferencesRealBinary({ command: "qdm-metric-cli-real --help" }), true);
  assert.equal(
    commandReferencesRealBinary({
      command: "source x && /workspace/bin/qdm-metric-cli-real analysis execute 2>&1",
    }),
    true,
  );
});

test("commandReferencesRealBinary does not flag the wrapper or unrelated commands", () => {
  assert.equal(
    commandReferencesRealBinary({
      command: "/workspace/bin/qdm-metric-cli analysis execute --metric x",
    }),
    false,
  );
  assert.equal(commandReferencesRealBinary({ command: "qdm-metric-cli --help" }), false);
  assert.equal(commandReferencesRealBinary({ command: "ls -la /workspace" }), false);
  assert.equal(commandReferencesRealBinary({}), false);
});

test("buildRejectedCommand fails closed and carries guidance", () => {
  const cmd = buildRejectedCommand("no-real-please");
  assert.match(cmd, /printf/);
  assert.match(cmd, /exit 9/);
  assert.match(cmd, /no-real-please/);
});

function harness() {
  const executed = [];
  const stateStore = {
    consumed: {},
    consumeToolCall(id) {
      return this.consumed[id] || "";
    },
    clearToolCall(id) {
      delete this.consumed[id];
    },
  };
  let registered = null;
  const pi = {
    registerTool(tool) {
      registered = tool;
    },
  };
  const createBashTool = () => ({
    async execute(toolCallId, params) {
      executed.push({ toolCallId, params });
      return { content: [{ type: "text", text: "ran" }] };
    },
  });
  registerAuthzBashOverride(pi, {
    createBashTool,
    stateStore,
    cwd: "/workspace",
    projectRoot: "/workspace",
  });
  return { tool: () => registered, executed, stateStore };
}

async function run(tool, command) {
  return tool.execute("call-1", { command }, null, () => {});
}

test("override blocks direct qdm-metric-cli-real and rewrites to a fail-closed reject", async () => {
  const { tool, executed } = harness();
  const original =
    "/workspace/bin/qdm-metric-cli-real analysis execute --metric saleAmt --filter manageAreaId=CN15";
  await run(tool(), original);
  assert.equal(executed.length, 1);
  const ran = executed[0].params.command;
  assert.notEqual(ran, original);
  assert.match(ran, /exit 9/);
  assert.match(ran, /禁止/);
  assert.doesNotMatch(ran, /qdm-metric-cli-real\s+analysis/);
});

test("override passes qdm-metric-cli wrapper invocations through unchanged", async () => {
  const { tool, executed } = harness();
  const original =
    "/workspace/bin/qdm-metric-cli analysis execute --metric saleAmt --filter manageAreaId=CN01";
  await run(tool(), original);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].params.command, original);
});

test("override passes unrelated bash commands through unchanged", async () => {
  const { tool, executed } = harness();
  const original = "ls -la /workspace && find . -name qdm-metric-cli";
  await run(tool(), original);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].params.command, original);
});

test("override blocks real binary referenced inside a chained command", async () => {
  const { tool, executed } = harness();
  const original =
    "source /workspace/config/qdm-cli-paths.env && /workspace/bin/qdm-metric-cli-real analysis execute --metric saleAmt 2>&1";
  await run(tool(), original);
  assert.equal(executed.length, 1);
  assert.match(executed[0].params.command, /exit 9/);
  assert.notEqual(executed[0].params.command, original);
});

test("override clears the tool-call binding state after rejecting", async () => {
  const { tool, stateStore } = harness();
  stateStore.consumed["call-1"] = "binding-blob";
  await run(tool(), "/workspace/bin/qdm-metric-cli-real analysis execute");
  assert.equal(
    "call-1" in stateStore.consumed,
    false,
    "binding state cleared after reject",
  );
});
