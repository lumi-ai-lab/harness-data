import assert from "node:assert/strict";
import test from "node:test";

import { runAsyncCommand } from "../async-cli.mjs";

test("runAsyncCommand sends stdin and captures stdout", async () => {
  const result = await runAsyncCommand(
    process.execPath,
    [
      "-e",
      "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(input.toUpperCase()));",
    ],
    { input: "hello harness", timeoutMs: 1_000 },
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "HELLO HARNESS");
  assert.equal(result.stderr, "");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test("runAsyncCommand preserves a non-zero exit code and stderr", async () => {
  const result = await runAsyncCommand(
    process.execPath,
    ["-e", "process.stderr.write('context failed'); process.exit(7);"],
    { timeoutMs: 1_000 },
  );

  assert.equal(result.code, 7);
  assert.equal(result.stderr, "context failed");
  assert.equal(result.error, undefined);
});

test("runAsyncCommand terminates a command after its timeout", async () => {
  const startedAt = Date.now();
  const result = await runAsyncCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000);"],
    { timeoutMs: 50 },
  );

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("runAsyncCommand enforces the combined output limit", async () => {
  const result = await runAsyncCommand(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(64 * 1024)); setInterval(() => {}, 1_000);"],
    { maxOutputBytes: 1_024, timeoutMs: 1_000 },
  );

  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1_024);
});
