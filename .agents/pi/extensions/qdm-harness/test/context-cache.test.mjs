import assert from "node:assert/strict";
import test from "node:test";

import {
  appendHarnessContext,
  ContextCache,
  HARNESS_CONTEXT_MARKER,
  latestUserMessage,
  replaceUserPrompt,
  upsertHarnessContext,
} from "../context-cache.mjs";

function userMessage(text, timestamp) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

test("latestUserMessage produces a stable key for the same message", () => {
  const messages = [
    userMessage("first", 100),
    { role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: 101 },
    userMessage("latest", 200),
  ];

  const first = latestUserMessage(messages);
  const second = latestUserMessage(structuredClone(messages));

  assert.deepEqual(second, first);
  assert.equal(first.prompt, "latest");
  assert.equal(first.index, 2);
});

test("latestUserMessage distinguishes equal text with different timestamps", () => {
  const first = latestUserMessage([userMessage("same prompt", 100)]);
  const second = latestUserMessage([userMessage("same prompt", 101)]);

  assert.notEqual(first.key, second.key);
});

test("latestUserMessage strips a WeCom quoted assistant reply from the intent prompt", () => {
  const assistantReply =
    "已解析主管姓名。以下是粤西区按主管拆分的结果。销售额按主管展示，并保留原日期和区域过滤条件。";
  const messages = [
    userMessage("@中台数据测试 看看各个主管的", 100),
    { role: "assistant", content: [{ type: "text", text: assistantReply }], timestamp: 101 },
    userMessage(`@中台数据测试 华东的呢\n${assistantReply.repeat(3)}`, 200),
  ];

  const latest = latestUserMessage(messages);

  assert.equal(latest.prompt, "@中台数据测试 华东的呢");
  assert.match(latest.rawPrompt, /粤西区按主管拆分/);
});

test("latestUserMessage preserves an unrelated multiline user prompt", () => {
  const messages = [
    userMessage("first", 100),
    {
      role: "assistant",
      content: [{ type: "text", text: "上一轮回答与这次补充内容完全无关。" }],
      timestamp: 101,
    },
    userMessage("@中台数据测试 查询销售额\n日期使用 2026-07-30，并按主管拆分。", 200),
  ];

  const latest = latestUserMessage(messages);

  assert.equal(latest.prompt, "@中台数据测试 查询销售额\n日期使用 2026-07-30，并按主管拆分。");
});

test("replaceUserPrompt removes quoted text while preserving non-text content", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "@中台数据测试 华东的呢\nquoted reply" },
        { type: "image", data: "unchanged" },
      ],
      timestamp: 200,
    },
  ];

  const replaced = replaceUserPrompt(messages, 0, "@中台数据测试 华东的呢");

  assert.equal(replaced[0].content[0].text, "@中台数据测试 华东的呢");
  assert.deepEqual(replaced[0].content[1], messages[0].content[1]);
  assert.match(messages[0].content[0].text, /quoted reply/);
});

test("ContextCache uses one in-flight loader per message key", async () => {
  const cache = new ContextCache();
  let calls = 0;
  let resolveLoader;
  const loader = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveLoader = resolve;
    });
  };

  const first = cache.getOrCreate("message", loader);
  const second = cache.getOrCreate("message", loader);
  assert.strictEqual(second, first);

  await Promise.resolve();
  assert.equal(calls, 1);
  resolveLoader("context");
  assert.equal(await first, "context");
  assert.equal(await second, "context");
});

test("ContextCache applies its LRU entry limit", async () => {
  const cache = new ContextCache(2);
  let bLoads = 0;

  await cache.getOrCreate("a", () => "a");
  await cache.getOrCreate("b", () => {
    bLoads += 1;
    return "b";
  });
  await cache.getOrCreate("a", () => "unused");
  await cache.getOrCreate("c", () => "c");

  assert.equal(cache.size, 2);
  await cache.getOrCreate("b", () => {
    bLoads += 1;
    return "b-again";
  });
  assert.equal(bLoads, 2);
  assert.equal(cache.size, 2);
});

test("appendHarnessContext changes only a copy of the target user message", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "before" }], timestamp: 1 },
    {
      role: "user",
      content: [
        { type: "text", text: "question" },
        { type: "image", data: "unchanged" },
      ],
      timestamp: 2,
    },
    { role: "assistant", content: [{ type: "text", text: "after" }], timestamp: 3 },
  ];
  const original = structuredClone(messages);

  const transformed = appendHarnessContext(messages, 1, "required context");

  assert.deepEqual(messages, original);
  assert.notStrictEqual(transformed, messages);
  assert.notStrictEqual(transformed[1], messages[1]);
  assert.deepEqual(
    transformed.map((message) => message.role),
    messages.map((message) => message.role),
  );
  assert.equal(transformed.length, messages.length);
  assert.match(transformed[1].content.at(-1).text, /required context/);
  assert.deepEqual(transformed[1].content[1], messages[1].content[1]);
});

test("appendHarnessContext never duplicates its marker", () => {
  const messages = [userMessage("question", 1)];
  const once = appendHarnessContext(messages, 0, "first context");
  const twice = appendHarnessContext(once, 0, "second context");

  assert.strictEqual(twice, once);
  const text = once[0].content.map((part) => part.text ?? "").join("\n");
  assert.equal(text.split(HARNESS_CONTEXT_MARKER).length - 1, 1);
  assert.doesNotMatch(text, /second context/);
});

test("upsertHarnessContext replaces a stale authorization summary without duplicating markers", () => {
  const messages = [userMessage("question", 1)];
  const once = upsertHarnessContext(messages, 0, "Requester: first");
  const twice = upsertHarnessContext(once, 0, "Requester: second");

  const text = twice[0].content.map((part) => part.text ?? "").join("\n");
  assert.equal(text.split(HARNESS_CONTEXT_MARKER).length - 1, 1);
  assert.doesNotMatch(text, /Requester: first/);
  assert.match(text, /Requester: second/);
});
