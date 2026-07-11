import assert from "node:assert/strict";
import test from "node:test";

import {
  appendHarnessContext,
  ContextCache,
  HARNESS_CONTEXT_MARKER,
  latestUserMessage,
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
