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
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write("supports agent-hook\\n");
  process.exit(0);
}
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

function createContext(root, options = {}) {
  const notifications = [];
  const statuses = [];
  const widgets = [];
  const ui = options.withoutUi
    ? undefined
    : {
        notify: (message, type) => notifications.push([message, type]),
        setStatus: (key, value) => statuses.push([key, value]),
        ...(options.withoutWidget ? {} : {
          setWidget: (key, value) => widgets.push([key, value]),
        }),
      };
  return {
    ctx: {
      cwd: root,
      sessionManager: { getSessionId: () => "test-session" },
      ...(ui ? { ui } : {}),
    },
    notifications,
    statuses,
    widgets,
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

test("extension registers the full lifecycle and avoids duplicate context injection in one turn", async (t) => {
  const { callsFile, root } = createProject(t, { delayMs: 10 });
  const handlers = loadExtension(root);
  const { ctx, notifications } = createContext(root);

  assert.deepEqual([...handlers.keys()], [
    "input",
    "before_agent_start",
    "context",
    "tool_call",
    "tool_result",
    "session_start",
    "agent_settled",
    "session_shutdown",
  ]);

  const pendingBefore = handlers.get("before_agent_start")({
    prompt: "昨天销售额？",
    systemPrompt: "base",
  }, ctx);
  assert.ok(pendingBefore instanceof Promise);
  const before = await pendingBefore;
  assert.match(before.systemPrompt, /^base\n\n# Pi Path Guidance/);
  assert.match(before.systemPrompt, /# Data Harness Context/);
  assert.equal(readFileSync(callsFile, "utf8").trim().split("\n").length, 1);

  const sameTurn = await handlers.get("context")({ messages: userMessages() }, ctx);
  assert.deepEqual(sameTurn.messages, userMessages());
  assert.equal(readFileSync(callsFile, "utf8").trim().split("\n").length, 1);

  const nextMessages = [{
    role: "user",
    content: [{ type: "text", text: "今天销售额？" }],
    timestamp: 124,
  }];
  const nextTurn = await handlers.get("context")({ messages: nextMessages }, ctx);
  assert.equal(nextTurn.messages.length, 2);
  assert.equal(nextTurn.messages.at(-1).role, "user");
  assert.match(nextTurn.messages.at(-1).content.at(-1).text, /# Pi Path Guidance/);
  assert.match(nextTurn.messages.at(-1).content.at(-1).text, /# Data Harness Context/);
  assert.equal(readFileSync(callsFile, "utf8").trim().split("\n").length, 2);
  assert.deepEqual(notifications, []);
});

test("extension reports a missing Harness CLI without mutating the user message", async (t) => {
  const { root } = createProject(t, { withCli: false });
  const handlers = loadExtension(root);
  const { ctx, notifications } = createContext(root);
  const messages = userMessages();

  const result = await handlers.get("context")({ messages }, ctx);

  assert.deepEqual(result.messages, messages);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][0], /QDM Harness context failed/);
  assert.equal(notifications[0][1], "warning");
});

test("session lifecycle ignores missing UI APIs and does not publish a progress widget", async (t) => {
  const { root } = createProject(t);
  const handlers = loadExtension(root);
  const { ctx, widgets, statuses } = createContext(root);

  assert.equal(handlers.get("session_start")({}, ctx), undefined);
  assert.equal(widgets.length, 0);
  assert.equal(statuses.filter(([key]) => key === "html-report-stage").length, 0);

  const { ctx: bare } = createContext(root, { withoutUi: true });
  assert.equal(handlers.get("session_start")({}, bare), undefined);
  assert.equal(handlers.get("session_shutdown")({}, bare), undefined);
  assert.equal(handlers.get("agent_settled")({}, bare), undefined);
});

test("ordinary harness context stays unchanged when progress UI APIs are absent", async (t) => {
  const { callsFile, root } = createProject(t);
  const handlers = loadExtension(root);
  const { ctx } = createContext(root, { withoutUi: true });
  const nextTurn = await handlers.get("context")({
    messages: [{
      role: "user",
      content: [{ type: "text", text: "今天销售额？" }],
      timestamp: 124,
    }],
  }, ctx);
  assert.equal(nextTurn.messages.length, 2);
  assert.equal(readFileSync(callsFile, "utf8").trim().split("\n").length, 1);
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
