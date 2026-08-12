import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  PiRpcClient,
  PiRpcError,
  PiRpcResponseError,
  attachLfJsonlReader,
  serializeJsonlRecord,
} from "../scripts/pi-rpc-client.mjs";

class FakePiProcess extends EventEmitter {
  constructor({ exitOnEof = false, exitOnSignal } = {}) {
    super();
    this.pid = 4242;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
    this.commands = [];
    this.inputBuffer = "";
    this.exitOnSignal = exitOnSignal;
    this.stdin.on("data", (chunk) => {
      this.inputBuffer += chunk.toString();
      while (this.inputBuffer.includes("\n")) {
        const index = this.inputBuffer.indexOf("\n");
        const line = this.inputBuffer.slice(0, index);
        this.inputBuffer = this.inputBuffer.slice(index + 1);
        this.commands.push(JSON.parse(line));
      }
    });
    if (exitOnEof) this.stdin.once("finish", () => this.finish(0, null));
  }

  send(record, ending = "\n") {
    this.stdout.write(`${JSON.stringify(record)}${ending}`);
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.exitOnSignal?.(signal) === true) this.finish(null, signal);
    return true;
  }

  finish(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function makeClient(t, process, overrides = {}) {
  const spawns = [];
  const client = new PiRpcClient({
    cwd: "/repo",
    sessionId: "session-123",
    env: { HTML_REPORT_GATE_MODE: "step" },
    spawnProcess(command, args, options) {
      spawns.push({ command, args, options });
      return process;
    },
    ...overrides,
  });
  client.start();
  t.after(async () => {
    if (!client.started) return;
    process.exitOnSignal = () => true;
    await client.close({ eofTimeoutMs: 5, termTimeoutMs: 5, killTimeoutMs: 5 });
  });
  return { client, spawns };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("strict LF JSONL preserves U+2028/U+2029 and accepts CRLF trailing CR", () => {
  const stream = new PassThrough();
  const records = [];
  const errors = [];
  const detach = attachLfJsonlReader(stream, {
    onRecord: (record) => records.push(record),
    onError: (error) => errors.push(error),
  });
  const first = Buffer.from(serializeJsonlRecord({ text: "left\u2028middle\u2029right" }));
  const split = first.indexOf(Buffer.from("\u2028")) + 1;
  stream.write(first.subarray(0, split));
  stream.write(first.subarray(split));
  stream.write(`${JSON.stringify({ crlf: true })}\r\n`);
  assert.deepEqual(records, [{ text: "left\u2028middle\u2029right" }, { crlf: true }]);
  assert.deepEqual(errors, []);
  detach();
});

test("start owns RPC, approval, and exact session arguments", async (t) => {
  const process = new FakePiProcess({ exitOnEof: true });
  const { client, spawns } = makeClient(t, process, { args: ["--thinking", "high"] });
  assert.deepEqual(spawns[0].args, [
    "--mode", "rpc", "--approve", "--session-id", "session-123", "--thinking", "high",
  ]);
  assert.equal(spawns[0].command, "pi");
  assert.equal(spawns[0].options.cwd, "/repo");
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.env.HTML_REPORT_GATE_MODE, "step");
  assert.equal(client.processId, 4242);
  assert.throws(
    () => new PiRpcClient({ sessionId: "s", args: ["--mode", "text"] }),
    (error) => error instanceof PiRpcError && error.code === "RESERVED_PI_ARG"
  );
  await client.close({ eofTimeoutMs: 20, termTimeoutMs: 20, killTimeoutMs: 20 });
  assert.equal(client.processId, null);
});

test("request ids correlate concurrent out-of-order state and command responses", async (t) => {
  const process = new FakePiProcess({ exitOnEof: true });
  const { client } = makeClient(t, process);
  const state = client.getState({ id: "state-0" });
  const commands = client.getCommands({ id: "commands-0" });
  assert.deepEqual(process.commands.map(({ id, type }) => ({ id, type })), [
    { id: "state-0", type: "get_state" },
    { id: "commands-0", type: "get_commands" },
  ]);
  process.send({
    id: "commands-0", type: "response", command: "get_commands", success: true,
    data: { commands: [{ name: "skill:html-report", source: "skill" }] },
  });
  process.send({
    id: "state-0", type: "response", command: "get_state", success: true,
    data: { sessionId: "session-123", sessionFile: "/sessions/s.jsonl" },
  });
  assert.deepEqual(await commands, [{ name: "skill:html-report", source: "skill" }]);
  assert.deepEqual(await state, { sessionId: "session-123", sessionFile: "/sessions/s.jsonl" });
});

test("promptAndWait collects through agent_settled rather than agent_end", async (t) => {
  const process = new FakePiProcess({ exitOnEof: true });
  const { client } = makeClient(t, process);
  let completed = false;
  const run = client.promptAndWait("继续", {
    requestId: "continue-b2", requestTimeoutMs: 100, settledTimeoutMs: 100,
  });
  run.then(() => { completed = true; });
  assert.deepEqual(process.commands[0], { id: "continue-b2", type: "prompt", message: "继续" });
  process.send({ id: "continue-b2", type: "response", command: "prompt", success: true });
  process.send({ type: "agent_start" });
  process.send({ type: "agent_end", messages: [], willRetry: false });
  await tick();
  assert.equal(completed, false);
  process.send({ type: "agent_settled" });
  const result = await run;
  assert.deepEqual(result.events.map((event) => event.type), [
    "agent_start", "agent_end", "agent_settled",
  ]);
  assert.equal(completed, true);
  assert.equal(Number.isFinite(result.events[0].receivedAtMs), true);
  assert.match(result.events[0].receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(client.getEvents(), result.events);
  assert.deepEqual(client.getRecords().map((record) => record.type), [
    "response", "agent_start", "agent_end", "agent_settled",
  ]);
});

test("promptAndWait can complete on a deterministic custom Gate before prompt response", async (t) => {
  const process = new FakePiProcess({ exitOnEof: true });
  const { client } = makeClient(t, process);
  let completed = false;
  const run = client.promptAndWait("继续", {
    requestId: "continue-b0",
    requestTimeoutMs: 100,
    settledTimeoutMs: 100,
    completionDescription: "B0 html-report-gate message_end",
    completionPredicate: (event) => event?.type === "message_end" &&
      event?.message?.role === "custom" &&
      event.message.customType === "html-report-gate" &&
      event.message.details?.sessionId === "session-123" &&
      event.message.details?.stageId === "B0_PREFLIGHT",
  });
  run.then(() => { completed = true; });

  process.send({
    type: "message_end",
    message: {
      role: "custom",
      customType: "other-extension",
      details: { sessionId: "session-123", stageId: "B0_PREFLIGHT" },
    },
  });
  process.send({
    type: "message_end",
    message: {
      role: "custom",
      customType: "html-report-gate",
      details: { sessionId: "wrong-session", stageId: "B0_PREFLIGHT" },
    },
  });
  await tick();
  assert.equal(completed, false);

  const gate = {
    type: "message_end",
    message: {
      role: "custom",
      customType: "html-report-gate",
      details: { sessionId: "session-123", stageId: "B0_PREFLIGHT" },
    },
  };
  process.send(gate);
  await tick();
  assert.equal(completed, false, "the prompt response is still required after the early Gate event");
  process.send({ id: "continue-b0", type: "response", command: "prompt", success: true });

  const result = await run;
  assert.equal(result.events.at(-1).message.customType, "html-report-gate");
  assert.equal(result.events.some((event) => event.type === "agent_settled"), false);
  assert.equal(completed, true);
});

test("response failure, timeout, and stderr retain diagnostics", async (t) => {
  const process = new FakePiProcess({ exitOnEof: true });
  const { client } = makeClient(t, process, { requestTimeoutMs: 15 });
  process.stderr.write("provider unavailable\n");
  const rejected = client.prompt("hello", { id: "rejected" });
  process.send({
    id: "rejected", type: "response", command: "prompt", success: false,
    error: "streaming prompt rejected",
  });
  await assert.rejects(
    rejected,
    (error) => error instanceof PiRpcResponseError && /streaming prompt rejected/.test(error.message)
  );
  await assert.rejects(
    client.getState({ id: "timeout", timeoutMs: 10 }),
    (error) => error instanceof PiRpcError &&
      error.code === "REQUEST_TIMEOUT" && /provider unavailable/.test(error.message)
  );
  assert.equal(client.getStderr(), "provider unavailable\n");
});

test("abort and abort_retry use explicit correlated requests", async (t) => {
  const process = new FakePiProcess({ exitOnEof: true });
  const { client } = makeClient(t, process);
  const abort = client.abort({ id: "abort-1" });
  const retry = client.abortRetry({ id: "abort-retry-1" });
  assert.deepEqual(process.commands.slice(-2), [
    { id: "abort-1", type: "abort" },
    { id: "abort-retry-1", type: "abort_retry" },
  ]);
  process.send({ id: "abort-retry-1", type: "response", command: "abort_retry", success: true });
  process.send({ id: "abort-1", type: "response", command: "abort", success: true });
  assert.equal((await abort).success, true);
  assert.equal((await retry).success, true);
});

test("unexpected process exit rejects requests with captured stderr", async (t) => {
  const process = new FakePiProcess();
  const { client } = makeClient(t, process);
  const pending = client.getState({ id: "state-before-crash" });
  process.stderr.write("fatal startup error\n");
  process.finish(17, null);
  await assert.rejects(
    pending,
    (error) => error instanceof PiRpcError &&
      error.code === "PROCESS_EXIT" && /fatal startup error/.test(error.message)
  );
});

test("close sends EOF and needs no signal after clean disposal", async (t) => {
  const process = new FakePiProcess({ exitOnEof: true });
  const { client } = makeClient(t, process);
  const result = await client.close({ eofTimeoutMs: 20, termTimeoutMs: 20, killTimeoutMs: 20 });
  assert.equal(result.phase, "eof");
  assert.deepEqual(result.exit, { code: 0, signal: null });
  assert.deepEqual(process.kills, []);
  assert.equal(client.started, false);
});

test("close escalates EOF to SIGTERM and then SIGKILL", async (t) => {
  const process = new FakePiProcess({ exitOnSignal: (signal) => signal === "SIGKILL" });
  const { client } = makeClient(t, process);
  const result = await client.close({ eofTimeoutMs: 5, termTimeoutMs: 5, killTimeoutMs: 20 });
  assert.equal(result.phase, "sigkill");
  assert.deepEqual(process.kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(result.exit, { code: null, signal: "SIGKILL" });
});

test("malformed stdout fails pending work without a real model", async (t) => {
  const process = new FakePiProcess({ exitOnEof: true });
  const { client } = makeClient(t, process);
  const pending = client.getState({ id: "bad-json" });
  process.stdout.write("{not-json}\n");
  await assert.rejects(
    pending,
    (error) => error instanceof PiRpcError && error.code === "INVALID_JSONL"
  );
});
