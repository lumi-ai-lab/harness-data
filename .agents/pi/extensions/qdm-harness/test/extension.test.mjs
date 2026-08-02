import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeBindingBase64url } from "../authz-state.mjs";
import { contentText } from "../context-cache.mjs";
import { installQdmHarnessExtension } from "../index.ts";

function authzCandidate(options = {}) {
  const binding = {
    version: 1,
    sessionId: options.sessionId ?? "test-session",
    requestId: options.requestId ?? "request-a",
    envelopeSha256: options.digest ?? "a".repeat(64),
    expiresAt: options.expiresAt ?? "2099-07-30T01:30:00Z",
  };
  return {
    binding,
    bindingBase64url: encodeBindingBase64url(binding),
    contextFingerprint: options.contextFingerprint ?? "c".repeat(64),
    summary: options.summary ?? "Requester: wecom / bot-id / user-a",
  };
}

function createProject(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "qdm-pi-extension-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));

  mkdirSync(join(root, ".agents"), { recursive: true });
  mkdirSync(join(root, ".harness"), { recursive: true });
  mkdirSync(join(root, "wikis"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  if (options.profile !== null) {
    writeFileSync(
      join(root, ".harness", "installer-state.json"),
      JSON.stringify({
        schemaVersion: 3,
        profile: options.profile ?? "lumi-mvp-required",
        agent: "pi",
      }),
    );
  }

  const callsFile = join(root, "calls.jsonl");
  if (options.withCli !== false) {
    const cli = join(root, "bin", process.platform === "win32" ? "data-harness-cli.exe" : "data-harness-cli");
    const delayMs = options.delayMs ?? 0;
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args[0] || "";
const callsFile = ${JSON.stringify(callsFile)};
const record = (input = "") => fs.appendFileSync(callsFile, JSON.stringify({ command, args, input }) + "\\n");

if (command === "authz-bind") {
  const sessionIndex = args.indexOf("--session-id");
  const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "";
  const binding = {
    version: 1,
    sessionId,
    requestId: "request-from-cli",
    envelopeSha256: "a".repeat(64),
    expiresAt: "2099-07-30T01:30:00Z"
  };
  const canonical = JSON.stringify({
    envelopeSha256: binding.envelopeSha256,
    expiresAt: binding.expiresAt,
    requestId: binding.requestId,
    sessionId: binding.sessionId,
    version: binding.version
  });
  record();
  process.stdout.write(JSON.stringify({
    binding,
    bindingBase64url: Buffer.from(canonical).toString("base64url"),
    contextFingerprint: "c".repeat(64),
    issuedAt: "2099-07-30T01:00:00Z",
    summary: {
      channel: "wecom",
      botId: "bot-id",
      canonicalUserId: "cli-user",
      manageAreaIds: ["CN07", "CN08"],
      categoryLevel1Ids: ["12", "13"]
    }
  }));
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    record(input);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: command === "context" ? "UserPromptSubmit" : "PostToolUse",
          additionalContext: "# Data Harness Context\\n\\n- wikis/demo/playbook.md (selected playbook)"
        }
      }));
    }, ${delayMs});
  });
}
`;
    writeFileSync(cli, script);
    chmodSync(cli, 0o755);
  }

  return { callsFile, root };
}

function readCalls(callsFile) {
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakePiRuntime(executions) {
  return {
    VERSION: "0.81.1",
    createBashTool(cwd, options = {}) {
      return {
        name: "bash",
        label: "bash",
        description: "fake Pi bash",
        parameters: { type: "object" },
        async execute(toolCallId, params) {
          const base = {
            command: params.command,
            cwd,
            env: {
              BASE_ENV: "1",
              HARNESS_AUTHZ_BINDING_V1: "stale-parent-binding",
              QDM_INDICATORS_CLI: "/tmp/raw-qdm-indicators-cli",
              QDM_CMR_CLI: "/tmp/qdm-cmr-cli",
              QDM_SQL_CLI: "/tmp/qdm-sql-cli",
              QDM_CAS_CLI: "/tmp/cas-cli",
              QDM_CAS_CONFIG_DIR: "/tmp/cas-config",
            },
          };
          const spawn = options.spawnHook ? options.spawnHook(base) : base;
          executions.push({ params: structuredClone(params), spawn, toolCallId });
          if (params.command.includes("__FAIL__")) throw new Error("fake bash exit 7");
          return {
            content: [{ type: "text", text: `ran:${params.command}` }],
            details: { cwd: spawn.cwd },
          };
        },
      };
    },
  };
}

async function loadExtension(root, options = {}) {
  const handlers = new Map();
  const tools = new Map();
  const executions = [];
  const piRuntime = options.piRuntime ?? fakePiRuntime(executions);
  await installQdmHarnessExtension(
    {
      cwd: root,
      on(event, handler) {
        handlers.set(event, handler);
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    },
    {
      piRuntime,
      ...(options.bindAuthorization ? { bindAuthorization: options.bindAuthorization } : {}),
    },
  );
  return {
    bashTool: tools.get("bash"),
    executions,
    handlers,
    nextAssistantTimestamp: 10_000,
    tools,
  };
}

function createContext(root, id = "test-session") {
  const notifications = [];
  const statuses = [];
  return {
    ctx: {
      cwd: root,
      sessionManager: { getSessionId: () => id },
      ui: {
        notify: (message, type) => notifications.push([message, type]),
        setStatus: (key, value) => statuses.push([key, value]),
      },
    },
    notifications,
    statuses,
  };
}

function userMessages(text = "昨天销售额？", timestamp = 123) {
  const message = {
    role: "user",
    content: [{ type: "text", text }],
  };
  if (timestamp !== undefined) message.timestamp = timestamp;
  return [message];
}

function assistantMessage(timestamp, toolCalls = []) {
  return {
    role: "assistant",
    timestamp,
    content: toolCalls.map((toolCall) => ({
      type: "toolCall",
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      arguments: structuredClone(toolCall.input),
    })),
  };
}

function prebindToolCall(loaded, ctx, event, timestamp = loaded.nextAssistantTimestamp++) {
  // Pi 0.81.1 deliberately emits different objects for message_start and
  // message_end, while preserving the assistant timestamp across the stream.
  loaded.handlers.get("message_start")({ message: assistantMessage(timestamp) }, ctx);
  loaded.handlers.get("message_end")({ message: assistantMessage(timestamp, [event]) }, ctx);
}

async function executeCaptured(loaded, ctx, event) {
  prebindToolCall(loaded, ctx, event);
  loaded.handlers.get("tool_call")(event, ctx);
  return loaded.bashTool.execute(event.toolCallId, event.input, undefined, undefined, ctx);
}

test("context refreshes authz on every event while caching wiki context per user message", async (t) => {
  const { callsFile, root } = createProject(t, { delayMs: 160 });
  const loaded = await loadExtension(root);
  const { ctx, notifications, statuses } = createContext(root);

  assert.deepEqual([...loaded.handlers.keys()], [
    "session_start",
    "session_shutdown",
    "before_agent_start",
    "context",
    "message_start",
    "message_end",
    "tool_call",
    "tool_result",
    "tool_execution_end",
  ]);

  const before = loaded.handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
  assert.equal(typeof before?.then, "undefined");
  assert.match(before.systemPrompt, /^base\n\nQDM Harness context/);

  const messages = userMessages();
  const original = structuredClone(messages);
  const first = await loaded.handlers.get("context")({ messages }, ctx);
  assert.deepEqual(messages, original);
  assert.match(contentText(first.messages[0].content), /Requester: wecom \/ bot-id \/ cli-user/);
  assert.match(contentText(first.messages[0].content), /# Pi Path Guidance/);
  assert.doesNotMatch(contentText(first.messages[0].content), /a{64}/);
  assert.deepEqual(statuses, [
    ["qdm-harness", "QDM Harness: loading context…"],
    ["qdm-harness", undefined],
  ]);
  assert.deepEqual(notifications, []);

  const toolTurn = [
    ...messages,
    { role: "assistant", content: [{ type: "text", text: "tool call" }], timestamp: 124 },
  ];
  await loaded.handlers.get("context")({ messages: toolTurn }, ctx);
  let calls = readCalls(callsFile);
  assert.equal(calls.filter((call) => call.command === "authz-bind").length, 2);
  assert.equal(calls.filter((call) => call.command === "context").length, 1);
  assert.deepEqual(calls[0].args, ["authz-bind", "--session-id", "test-session"]);

  const event = { toolCallId: "tool-bound", toolName: "bash", input: { command: "env-check" } };
  await executeCaptured(loaded, ctx, event);
  assert.match(loaded.executions.at(-1).spawn.env.HARNESS_AUTHZ_BINDING_V1, /^[A-Za-z0-9_-]+$/);

  loaded.handlers.get("session_start")({}, ctx);
  await loaded.handlers.get("context")({ messages }, ctx);
  calls = readCalls(callsFile);
  assert.equal(calls.filter((call) => call.command === "authz-bind").length, 3);
  assert.equal(calls.filter((call) => call.command === "context").length, 2);
});

test("authorized Pi Bash pins the public Facade and removes forbidden inherited CLI variables", async (t) => {
  const { root } = createProject(t);
  const loaded = await loadExtension(root, {
    bindAuthorization: async () => authzCandidate(),
  });
  const { ctx } = createContext(root);
  await loaded.handlers.get("context")({ messages: userMessages() }, ctx);

  const event = { toolCallId: "tool-clean-env", toolName: "bash", input: { command: "env" } };
  await executeCaptured(loaded, ctx, event);
  const environment = loaded.executions.at(-1).spawn.env;
  assert.equal(environment.QDM_INDICATORS_CLI, join(root, "bin", "qdm-indicators-cli"));
  for (const name of ["QDM_CMR_CLI", "QDM_SQL_CLI", "QDM_CAS_CLI", "QDM_CAS_CONFIG_DIR"]) {
    assert.equal(Object.hasOwn(environment, name), false, name);
  }
  assert.match(environment.HARNESS_AUTHZ_BINDING_V1, /^[A-Za-z0-9_-]+$/);
  assert.equal(environment.BASE_ENV, "1");
});

test("local-unrestricted profile keeps Pi Bash unchanged and skips requester authorization", async (t) => {
  const { callsFile, root } = createProject(t, { profile: "local-unrestricted" });
  const loaded = await loadExtension(root, {
    piRuntime: {
      VERSION: "future-local-version",
      createBashTool() {
        throw new Error("local profile must not replace Bash");
      },
    },
    bindAuthorization: async () => {
      throw new Error("local profile must not call authz-bind");
    },
  });
  const { ctx, notifications } = createContext(root);

  assert.equal(loaded.tools.has("bash"), false);
  const result = await loaded.handlers.get("context")({ messages: userMessages() }, ctx);
  const text = contentText(result.messages[0].content);
  assert.doesNotMatch(text, /Request Authorization Unavailable|Authorized manageAreaIds/);
  assert.match(text, /# Pi Path Guidance/);
  assert.deepEqual(notifications, []);
  assert.deepEqual(
    readCalls(callsFile).map((call) => call.command),
    ["context"],
  );
});

test("missing authz binding clears a stale parent environment value and adds a safe guard", async (t) => {
  const { root } = createProject(t, { withCli: false });
  const loaded = await loadExtension(root);
  const { ctx, notifications } = createContext(root);

  const result = await loaded.handlers.get("context")({ messages: userMessages() }, ctx);
  const text = contentText(result.messages[0].content);
  assert.match(text, /# Request Authorization Unavailable/);
  assert.match(text, /# QDM Harness Unavailable/);
  assert.ok(notifications.some(([message]) => /authorization is unavailable/.test(message)));

  const event = { toolCallId: "tool-unbound", toolName: "bash", input: { command: "env-check" } };
  await executeCaptured(loaded, ctx, event);
  assert.equal(
    Object.hasOwn(loaded.executions.at(-1).spawn.env, "HARNESS_AUTHZ_BINDING_V1"),
    false,
  );
});

test("continuation replaces binding, new request replaces context, and same-request context change clears", async (t) => {
  const { callsFile, root } = createProject(t);
  const candidates = [
    authzCandidate({ summary: "Requester: first" }),
    authzCandidate({ summary: "Requester: idempotent" }),
    authzCandidate({ digest: "b".repeat(64), summary: "Requester: continuation" }),
    authzCandidate({
      requestId: "request-b",
      digest: "c".repeat(64),
      contextFingerprint: "d".repeat(64),
      summary: "Requester: next request",
    }),
    authzCandidate({
      requestId: "request-b",
      digest: "d".repeat(64),
      contextFingerprint: "e".repeat(64),
      summary: "Requester: must not appear",
    }),
  ];
  let bindCalls = 0;
  const loaded = await loadExtension(root, {
    bindAuthorization: async () => candidates[bindCalls++],
  });
  const { ctx } = createContext(root);
  const messages = userMessages("same prompt", undefined);
  const observedBindings = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const transformed = await loaded.handlers.get("context")({ messages: structuredClone(messages) }, ctx);
    const event = {
      toolCallId: `tool-${index}`,
      toolName: "bash",
      input: { command: `call-${index}` },
    };
    await executeCaptured(loaded, ctx, event);
    observedBindings.push(loaded.executions.at(-1).spawn.env.HARNESS_AUTHZ_BINDING_V1);
    if (index === candidates.length - 1) {
      assert.match(contentText(transformed.messages[0].content), /Authorization Unavailable/);
      assert.doesNotMatch(contentText(transformed.messages[0].content), /must not appear/);
    }
  }

  assert.equal(bindCalls, 5);
  assert.deepEqual(observedBindings, [
    candidates[0].bindingBase64url,
    candidates[1].bindingBase64url,
    candidates[2].bindingBase64url,
    candidates[3].bindingBase64url,
    undefined,
  ]);
  assert.equal(readCalls(callsFile).filter((call) => call.command === "context").length, 1);
});

test("same-session interleaving binds old and new tool calls to their assistant-start snapshots", async (t) => {
  const { root } = createProject(t);
  const oldCandidate = authzCandidate({
    requestId: "request-old",
    digest: "a".repeat(64),
    contextFingerprint: "c".repeat(64),
    summary: "Requester: old",
  });
  const newCandidate = authzCandidate({
    requestId: "request-new",
    digest: "b".repeat(64),
    contextFingerprint: "d".repeat(64),
    summary: "Requester: new",
  });
  const candidates = [oldCandidate, newCandidate];
  let bindCalls = 0;
  const loaded = await loadExtension(root, {
    bindAuthorization: async () => candidates[bindCalls++],
  });
  const { ctx } = createContext(root);

  await loaded.handlers.get("context")({ messages: userMessages("old request", 1) }, ctx);
  const oldTimestamp = 20_001;
  loaded.handlers.get("message_start")({ message: assistantMessage(oldTimestamp) }, ctx);

  await loaded.handlers.get("context")({ messages: userMessages("new request", 2) }, ctx);
  const newTimestamp = 20_002;
  loaded.handlers.get("message_start")({ message: assistantMessage(newTimestamp) }, ctx);

  const oldEvent = { toolCallId: "tool-old", toolName: "bash", input: { command: "old" } };
  const newEvent = { toolCallId: "tool-new", toolName: "bash", input: { command: "new" } };
  loaded.handlers.get("message_end")(
    { message: assistantMessage(oldTimestamp, [oldEvent]) },
    ctx,
  );
  loaded.handlers.get("message_end")(
    { message: assistantMessage(newTimestamp, [newEvent]) },
    ctx,
  );

  loaded.handlers.get("tool_call")(newEvent, ctx);
  await loaded.bashTool.execute(newEvent.toolCallId, newEvent.input, undefined, undefined, ctx);
  loaded.handlers.get("tool_call")(oldEvent, ctx);
  await loaded.bashTool.execute(oldEvent.toolCallId, oldEvent.input, undefined, undefined, ctx);

  const byId = new Map(loaded.executions.map((execution) => [execution.toolCallId, execution]));
  assert.equal(
    byId.get("tool-old").spawn.env.HARNESS_AUTHZ_BINDING_V1,
    oldCandidate.bindingBase64url,
  );
  assert.equal(
    byId.get("tool-new").spawn.env.HARNESS_AUTHZ_BINDING_V1,
    newCandidate.bindingBase64url,
  );

  const ambiguous = {
    toolCallId: "tool-ambiguous-message",
    toolName: "bash",
    input: { command: "ambiguous" },
  };
  const duplicatedTimestamp = 20_003;
  loaded.handlers.get("message_start")(
    { message: assistantMessage(duplicatedTimestamp) },
    ctx,
  );
  loaded.handlers.get("message_start")(
    { message: assistantMessage(duplicatedTimestamp) },
    ctx,
  );
  loaded.handlers.get("message_end")(
    { message: assistantMessage(duplicatedTimestamp, [ambiguous]) },
    ctx,
  );
  loaded.handlers.get("tool_call")(ambiguous, ctx);
  await loaded.bashTool.execute(
    ambiguous.toolCallId,
    ambiguous.input,
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    Object.hasOwn(loaded.executions.at(-1).spawn.env, "HARNESS_AUTHZ_BINDING_V1"),
    false,
  );

  const unfinalized = {
    toolCallId: "tool-without-message-end",
    toolName: "bash",
    input: { command: "unfinalized" },
  };
  loaded.handlers.get("tool_call")(unfinalized, ctx);
  await loaded.bashTool.execute(
    unfinalized.toolCallId,
    unfinalized.input,
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    Object.hasOwn(
      loaded.executions.at(-1).spawn.env,
      "HARNESS_AUTHZ_BINDING_V1",
    ),
    false,
  );
});

test("concurrent sessions capture independent bindings by toolCallId", async (t) => {
  const { root } = createProject(t);
  const resolvers = new Map();
  const loaded = await loadExtension(root, {
    bindAuthorization: ({ sessionId }) =>
      new Promise((resolve) => {
        resolvers.set(sessionId, resolve);
      }),
  });
  const first = createContext(root, "session-a");
  const second = createContext(root, "session-b");
  const firstPending = loaded.handlers.get("context")({ messages: userMessages("a") }, first.ctx);
  const secondPending = loaded.handlers.get("context")({ messages: userMessages("b") }, second.ctx);

  await new Promise((resolve) => setImmediate(resolve));
  const firstCandidate = authzCandidate({ sessionId: "session-a", summary: "Requester: a" });
  const secondCandidate = authzCandidate({
    sessionId: "session-b",
    requestId: "request-b",
    digest: "b".repeat(64),
    contextFingerprint: "d".repeat(64),
    summary: "Requester: b",
  });
  resolvers.get("session-b")(secondCandidate);
  resolvers.get("session-a")(firstCandidate);
  await Promise.all([firstPending, secondPending]);

  const firstEvent = { toolCallId: "tool-a", toolName: "bash", input: { command: "a" } };
  const secondEvent = { toolCallId: "tool-b", toolName: "bash", input: { command: "b" } };
  await Promise.all([
    executeCaptured(loaded, first.ctx, firstEvent),
    executeCaptured(loaded, second.ctx, secondEvent),
  ]);

  const byId = new Map(loaded.executions.map((execution) => [execution.toolCallId, execution]));
  assert.equal(byId.get("tool-a").spawn.env.HARNESS_AUTHZ_BINDING_V1, firstCandidate.bindingBase64url);
  assert.equal(byId.get("tool-b").spawn.env.HARNESS_AUTHZ_BINDING_V1, secondCandidate.bindingBase64url);
});

test("overlapping context refreshes in one session fail the older generation closed", async (t) => {
  const { root } = createProject(t);
  const resolvers = [];
  const loaded = await loadExtension(root, {
    bindAuthorization: () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  });
  const { ctx } = createContext(root, "session-a");

  const older = loaded.handlers.get("context")({ messages: userMessages("older", 1) }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 1);
  const newer = loaded.handlers.get("context")({ messages: userMessages("newer", 2) }, ctx);

  resolvers[0](authzCandidate({ requestId: "request-old", summary: "Requester: old" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 2);
  const newCandidate = authzCandidate({
    requestId: "request-new",
    digest: "b".repeat(64),
    contextFingerprint: "d".repeat(64),
    summary: "Requester: new",
  });
  resolvers[1](newCandidate);

  const [olderResult, newerResult] = await Promise.all([older, newer]);
  const olderText = contentText(olderResult.messages[0].content);
  const newerText = contentText(newerResult.messages[0].content);
  assert.match(olderText, /Request Authorization Unavailable/);
  assert.doesNotMatch(olderText, /Requester: new/);
  assert.match(newerText, /Requester: new/);

  const event = { toolCallId: "tool-new-generation", toolName: "bash", input: { command: "new" } };
  await executeCaptured(loaded, ctx, event);
  assert.equal(loaded.executions.at(-1).spawn.env.HARNESS_AUTHZ_BINDING_V1, newCandidate.bindingBase64url);
});

test("posttool uses Pi tool_result without mutating the Bash command", async (t) => {
  const { callsFile, root } = createProject(t);
  const bound = authzCandidate();
  const loaded = await loadExtension(root, { bindAuthorization: async () => bound });
  const { ctx } = createContext(root);
  await loaded.handlers.get("context")({ messages: userMessages() }, ctx);

  const event = {
    toolCallId: "tool-posttool",
    toolName: "Bash",
    input: { command: "./bin/data-harness-cli inject-template --template demo" },
  };
  const result = await executeCaptured(loaded, ctx, event);
  const execution = loaded.executions.at(-1);
  assert.equal(execution.spawn.command, event.input.command);
  assert.equal(execution.spawn.env.HARNESS_AUTHZ_BINDING_V1, bound.bindingBase64url);
  assert.equal(result.content[0].text, `ran:${event.input.command}`);
  const patch = await loaded.handlers.get("tool_result")({ ...event, ...result, isError: false }, ctx);
  assert.deepEqual(patch.content.slice(0, result.content.length), result.content);
  assert.match(patch.content.at(-1).text, /# Data Harness Context/);
  const posttoolCall = readCalls(callsFile).at(-1);
  assert.deepEqual(posttoolCall.args, ["posttool", "--format", "agent-hook"]);
  assert.equal(JSON.parse(posttoolCall.input).tool_input.command, event.input.command);

  const failure = { toolCallId: "tool-fail", toolName: "bash", input: { command: "__FAIL__" } };
  prebindToolCall(loaded, ctx, failure);
  loaded.handlers.get("tool_call")(failure, ctx);
  await assert.rejects(
    () => loaded.bashTool.execute(failure.toolCallId, failure.input, undefined, undefined, ctx),
    /fake bash exit 7/,
  );
});

test("tool execution end clears a capture when a later hook blocks execution", async (t) => {
  const { root } = createProject(t);
  const loaded = await loadExtension(root, { bindAuthorization: async () => authzCandidate() });
  const { ctx } = createContext(root);
  await loaded.handlers.get("context")({ messages: userMessages() }, ctx);

  const event = { toolCallId: "tool-blocked", toolName: "bash", input: { command: "env" } };
  prebindToolCall(loaded, ctx, event);
  loaded.handlers.get("tool_call")(event, ctx);
  loaded.handlers.get("tool_execution_end")({ toolCallId: event.toolCallId }, ctx);
  await loaded.bashTool.execute(event.toolCallId, event.input, undefined, undefined, ctx);

  assert.equal(
    Object.hasOwn(loaded.executions.at(-1).spawn.env, "HARNESS_AUTHZ_BINDING_V1"),
    false,
  );
});

test("session shutdown prevents an in-flight authz refresh from restoring binding", async (t) => {
  const { root } = createProject(t);
  let resolveBinding;
  const loaded = await loadExtension(root, {
    bindAuthorization: () =>
      new Promise((resolve) => {
        resolveBinding = resolve;
      }),
  });
  const { ctx } = createContext(root);
  const pending = loaded.handlers.get("context")({ messages: userMessages() }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  loaded.handlers.get("session_shutdown")({}, ctx);
  resolveBinding(authzCandidate());

  const transformed = await pending;
  assert.match(contentText(transformed.messages[0].content), /Authorization Unavailable/);
  const event = { toolCallId: "tool-after-shutdown", toolName: "bash", input: { command: "env" } };
  await executeCaptured(loaded, ctx, event);
  assert.equal(
    Object.hasOwn(loaded.executions.at(-1).spawn.env, "HARNESS_AUTHZ_BINDING_V1"),
    false,
  );
});
