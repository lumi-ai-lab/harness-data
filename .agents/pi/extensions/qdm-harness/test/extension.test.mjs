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

import qdmHarnessExtension from "../index.ts";

function createProject(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "qdm-pi-extension-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));

  mkdirSync(join(root, ".agents"), { recursive: true });
  mkdirSync(join(root, "wikis"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });

  const callsFile = join(root, "calls.txt");
  if (options.withCli !== false) {
    const cli = join(root, "bin", "data-harness-cli");
    const delayMs = options.delayMs ?? 0;
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(callsFile)}, payload.prompt + "\\n");
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "# Data Harness Context\\n\\n- wikis/demo/playbook.md (selected playbook)"
      }
    }));
  }, ${delayMs});
});
`;
    writeFileSync(cli, script);
    chmodSync(cli, 0o755);
  }

  return { callsFile, root };
}

function loadExtension(root) {
  const handlers = new Map();
  qdmHarnessExtension({
    cwd: root,
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  return handlers;
}

function createContext(root) {
  const notifications = [];
  const statuses = [];
  return {
    ctx: {
      cwd: root,
      sessionManager: { getSessionId: () => "test-session" },
      ui: {
        notify: (message, type) => notifications.push([message, type]),
        setStatus: (key, value) => statuses.push([key, value]),
      },
    },
    notifications,
    statuses,
  };
}

function userMessages() {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "昨天销售额？" }],
      timestamp: 123,
    },
  ];
}

test("extension keeps pre-start synchronous and caches async context per user message", async (t) => {
  const { callsFile, root } = createProject(t, { delayMs: 160 });
  const handlers = loadExtension(root);
  const { ctx, notifications, statuses } = createContext(root);

  assert.deepEqual([...handlers.keys()], [
    "session_start",
    "session_shutdown",
    "before_agent_start",
    "context",
    "tool_call",
  ]);

  const before = handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
  assert.equal(typeof before?.then, "undefined");
  assert.match(before.systemPrompt, /^base\n\nQDM Harness context/);
  assert.equal(existsSync(callsFile), false);

  const messages = userMessages();
  const original = structuredClone(messages);
  const pending = handlers.get("context")({ messages }, ctx);
  assert.ok(pending instanceof Promise);
  const first = await pending;

  assert.deepEqual(messages, original);
  assert.equal(first.messages.length, messages.length);
  assert.deepEqual(
    first.messages.map((message) => message.role),
    messages.map((message) => message.role),
  );
  assert.match(first.messages[0].content.at(-1).text, /<qdm_harness_context>/);
  assert.match(first.messages[0].content.at(-1).text, /# Pi Path Guidance/);
  assert.deepEqual(statuses, [
    ["qdm-harness", "QDM Harness: loading context…"],
    ["qdm-harness", undefined],
  ]);
  assert.deepEqual(notifications, []);

  const toolTurn = [
    ...messages,
    { role: "assistant", content: [{ type: "text", text: "tool call" }], timestamp: 124 },
  ];
  const second = await handlers.get("context")({ messages: toolTurn }, ctx);
  assert.equal(second.messages.length, toolTurn.length);
  assert.equal(readFileSync(callsFile, "utf8").trim().split("\n").length, 1);

  handlers.get("session_start")({}, ctx);
  await handlers.get("context")({ messages }, ctx);
  assert.equal(readFileSync(callsFile, "utf8").trim().split("\n").length, 2);
});

test("extension injects a safe guard when the Harness CLI is missing", async (t) => {
  const { root } = createProject(t, { withCli: false });
  const handlers = loadExtension(root);
  const { ctx, notifications } = createContext(root);

  const result = await handlers.get("context")({ messages: userMessages() }, ctx);

  assert.match(result.messages[0].content.at(-1).text, /# QDM Harness Unavailable/);
  assert.match(result.messages[0].content.at(-1).text, /Do not run QDM data CLIs/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][0], /QDM Harness context failed: missing/);
  assert.equal(notifications[0][1], "warning");
});

test("extension preserves the posttool agent-hook command contract", (t) => {
  const { root } = createProject(t);
  const handlers = loadExtension(root);
  const { ctx } = createContext(root);
  const event = {
    toolName: "Bash",
    input: { command: "./bin/data-harness-cli inject-template --template demo" },
  };

  handlers.get("tool_call")(event, ctx);

  assert.match(event.input.command, /posttool --format agent-hook/);
  assert.doesNotMatch(event.input.command, /posttool --help/);
  assert.match(event.input.command, /extract-additional-context\.mjs/);
});
