import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandExists } from "../src/lib/exec.js";

function withPath(pathEnv, fn) {
  const original = process.env.PATH;
  try {
    process.env.PATH = pathEnv;
    return fn();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

test("commandExists finds an executable in PATH", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-exec-"));
  fs.writeFileSync(path.join(dir, "fake-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await withPath(dir, async () => {
    assert.equal(await commandExists("fake-tool"), true);
  });
});

test("commandExists returns false when the command is not in PATH", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-exec-"));
  await withPath(dir, async () => {
    assert.equal(await commandExists("no-such-tool-xyz"), false);
  });
});

test("commandExists ignores files without the execute bit", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-exec-"));
  fs.writeFileSync(path.join(dir, "plain"), "not executable", { mode: 0o644 });
  await withPath(dir, async () => {
    assert.equal(await commandExists("plain"), false);
  });
});

test("commandExists does not treat directories as commands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-exec-"));
  fs.mkdirSync(path.join(dir, "adir"), { mode: 0o755 });
  await withPath(dir, async () => {
    assert.equal(await commandExists("adir"), false);
  });
  assert.equal(await commandExists(path.join(dir, "adir")), false);
});

test("commandExists accepts paths containing a separator", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-exec-"));
  const tool = path.join(dir, "tool");
  fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(await commandExists(tool), true);
  assert.equal(await commandExists(path.join(dir, "missing")), false);
});

test("commandExists does not emit the DEP0190 deprecation warning", async () => {
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    await commandExists("node");
    await commandExists("definitely-not-a-real-command-for-dep0190");
  } finally {
    process.off("warning", onWarning);
  }
  assert.equal(
    warnings.filter((warning) => warning.name === "DeprecationWarning" && warning.code === "DEP0190").length,
    0
  );
});
