import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  exportMainHtml,
  htmlExportSummary,
  mainHtmlPaths,
} from "../scripts/export-main-html.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/export-main-html.mjs", import.meta.url));

async function makeSession(t, name = "html-export") {
  const root = await mkdtemp(join(tmpdir(), `html-report-${name}-`));
  const session = join(root, ".harness", "state", "html-report", name);
  await mkdir(join(session, "analysis"), { recursive: true });
  await mkdir(join(session, "debug"), { recursive: true });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, session };
}

async function writeMain(session, body = "# 报告\n\n正文。\n") {
  const path = join(session, "analysis", "main.md");
  await writeFile(path, body);
  return path;
}

function fakeMd2htmlSource({
  fail = false,
  hangMs = 0,
  empty = false,
  writeCwdCopy = false,
} = {}) {
  return `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2);
const outIndex = args.indexOf("-o");
if (outIndex < 0 || !args[outIndex + 1]) {
  process.stderr.write("missing -o\\n");
  process.exit(2);
}
const themeIndex = args.indexOf("--theme");
const rendererIndex = args.indexOf("--renderer");
if (args[themeIndex + 1] !== "report" || args[rendererIndex + 1] !== "svg") {
  process.stderr.write("expected --theme report --renderer svg\\n");
  process.exit(2);
}
const output = args[outIndex + 1];
const logPath = process.env.MD2HTML_ARG_LOG;
if (logPath) writeFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }));
if (${Number(hangMs)} > 0) {
  const started = Date.now();
  while (Date.now() - started < ${Number(hangMs)}) {}
}
if (${fail ? "true" : "false"}) {
  process.stderr.write("md2html boom\\n");
  process.exit(1);
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, ${empty ? "''" : "'<!doctype html><html><body>ok</body></html>\\n'"});
if (${writeCwdCopy ? "true" : "false"}) {
  writeFileSync(join(process.cwd(), "main.html"), "cwd-leak");
}
`;
}

async function installFakeMd2html(dir, options = {}) {
  await mkdir(dir, { recursive: true });
  const bin = join(dir, "md2html");
  await writeFile(bin, fakeMd2htmlSource(options));
  await chmod(bin, 0o755);
  return bin;
}

function decoyEnv(binDir, extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: `${binDir}:${process.env.PATH || ""}`,
  };
}

test("export writes sibling main.html via explicit -o regardless of cwd", async (t) => {
  const { root, session } = await makeSession(t, "sibling");
  await writeMain(session, "# 标题\n");
  const binDir = join(root, "bin");
  const logPath = join(root, "md2html-args.json");
  await installFakeMd2html(binDir);
  const decoyCwd = join(root, "decoy-cwd");
  await mkdir(decoyCwd);

  const previous = process.cwd();
  process.chdir(decoyCwd);
  t.after(() => process.chdir(previous));

  const output = await exportMainHtml(session, {
    env: decoyEnv(binDir, { MD2HTML_ARG_LOG: logPath }),
  });

  assert.equal(output.ok, true);
  assert.equal(output.status, "generated");
  assert.equal(output.htmlPath, join(session, "analysis", "main.html"));
  assert.equal(await readFile(output.htmlPath, "utf8"), "<!doctype html><html><body>ok</body></html>\n");
  assert.equal(output.bytes, (await readFile(output.htmlPath)).length);
  const meta = JSON.parse(await readFile(output.metaPath, "utf8"));
  assert.equal(meta.inputSha256, output.inputSha256);
  assert.equal(meta.outputSha256, output.outputSha256);
  assert.equal(meta.theme, "report");
  assert.equal(meta.renderer, "svg");
  const logged = JSON.parse(await readFile(logPath, "utf8"));
  const outputArg = logged.args[logged.args.indexOf("-o") + 1];
  assert.equal(logged.args.includes("-o"), true);
  assert.equal(outputArg.startsWith(join(session, "analysis") + "/"), true);
  assert.match(outputArg, /\.export-out\.html$/);
  assert.equal(logged.args.includes("--theme"), true);
  assert.equal(logged.args[logged.args.indexOf("--theme") + 1], "report");
  try {
    await readFile(join(decoyCwd, "main.html"));
    assert.fail("must not write main.html into cwd");
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
  try {
    await readFile(join(root, "main.html"));
    assert.fail("must not write main.html into workspace root");
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
});

test("CLI failure keeps the previous HTML and success receipt", async (t) => {
  const { root, session } = await makeSession(t, "keep-old");
  await writeMain(session, "# 旧稿\n");
  const binDir = join(root, "bin");
  await installFakeMd2html(binDir);
  const first = await exportMainHtml(session, { env: decoyEnv(binDir) });
  assert.equal(first.ok, true);
  const previousHtml = await readFile(first.htmlPath, "utf8");
  const previousMeta = await readFile(first.metaPath, "utf8");

  await writeMain(session, "# 新稿\n");
  const failDir = join(root, "fail-bin");
  await installFakeMd2html(failDir, { fail: true });
  const failed = await exportMainHtml(session, { env: decoyEnv(failDir) });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "failed");
  assert.equal(await readFile(first.htmlPath, "utf8"), previousHtml);
  assert.equal(await readFile(first.metaPath, "utf8"), previousMeta);
  assert.equal(await readFile(join(session, "analysis", "main.md"), "utf8"), "# 新稿\n");
  const ledger = JSON.parse(await readFile(join(session, "debug", "main-html-export.json"), "utf8"));
  assert.equal(ledger.ok, false);
  assert.match(ledger.error, /md2html/);
  assert.equal(ledger.attempt, 2);
});

test("timed-out md2html does not publish HTML", async (t) => {
  const { root, session } = await makeSession(t, "timeout");
  await writeMain(session);
  const binDir = join(root, "bin");
  await installFakeMd2html(binDir, { hangMs: 5_000 });
  const output = await exportMainHtml(session, {
    env: decoyEnv(binDir),
    timeoutMs: 80,
  });
  assert.equal(output.ok, false);
  assert.equal(output.timedOut, true);
  try {
    await readFile(join(session, "analysis", "main.html"));
    assert.fail("timed-out export must not publish main.html");
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
});

test("same main.md returns up_to_date without rewriting HTML", async (t) => {
  const { root, session } = await makeSession(t, "idempotent");
  await writeMain(session, "# 稳定\n");
  const binDir = join(root, "bin");
  const logPath = join(root, "second.json");
  await installFakeMd2html(binDir);
  const first = await exportMainHtml(session, { env: decoyEnv(binDir) });
  const second = await exportMainHtml(session, {
    env: decoyEnv(binDir, { MD2HTML_ARG_LOG: logPath }),
  });
  assert.equal(first.status, "generated");
  assert.equal(second.ok, true);
  assert.equal(second.status, "up_to_date");
  assert.equal(second.inputSha256, first.inputSha256);
  assert.equal(second.outputSha256, first.outputSha256);
  try {
    await readFile(logPath);
    assert.fail("up_to_date must not invoke md2html");
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }

  await writeMain(session, "# 已改\n");
  const third = await exportMainHtml(session, { env: decoyEnv(binDir) });
  assert.equal(third.status, "generated");
  assert.notEqual(third.inputSha256, first.inputSha256);
});

test("session lock rejects a concurrent export", async (t) => {
  const { session } = await makeSession(t, "lock");
  await writeMain(session);
  const paths = mainHtmlPaths(session);
  await mkdir(paths.lockDir);
  const output = await exportMainHtml(session, { lockWaitMs: 30 });
  assert.equal(output.ok, false);
  assert.match(output.error, /HTML export lock/);
});

test("symlinked main.md is rejected and does not publish HTML", async (t) => {
  const { root, session } = await makeSession(t, "symlink");
  const outside = join(root, "outside.md");
  await writeFile(outside, "# leaked\n");
  await symlink(outside, join(session, "analysis", "main.md"));
  const binDir = join(root, "bin");
  await installFakeMd2html(binDir);
  const output = await exportMainHtml(session, { env: decoyEnv(binDir) });
  assert.equal(output.ok, false);
  assert.match(output.error, /symbolic links/);
  try {
    await readFile(join(session, "analysis", "main.html"));
    assert.fail("symlink export must not publish HTML");
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
});

test("htmlExportSummary reflects generated and failed ledgers", async (t) => {
  const { root, session } = await makeSession(t, "summary");
  await writeMain(session);
  assert.equal((await htmlExportSummary(session)).status, "awaiting_confirmation");
  const binDir = join(root, "bin");
  await installFakeMd2html(binDir);
  await exportMainHtml(session, { env: decoyEnv(binDir) });
  const generated = await htmlExportSummary(session);
  assert.equal(generated.status, "generated");
  assert.equal(generated.htmlPath, join(session, "analysis", "main.html"));

  await writeMain(session, "# 下一版\n");
  const failDir = join(root, "fail-bin");
  await installFakeMd2html(failDir, { fail: true });
  await exportMainHtml(session, { env: decoyEnv(failDir) });
  const failed = await htmlExportSummary(session);
  assert.equal(failed.status, "failed");
  assert.equal(failed.htmlPath, join(session, "analysis", "main.html"));
});

test("CLI only accepts --session-dir and still uses explicit -o", async (t) => {
  const { root, session } = await makeSession(t, "cli");
  await writeMain(session);
  const binDir = join(root, "bin");
  const logPath = join(root, "cli-args.json");
  await installFakeMd2html(binDir);
  const usage = spawn(process.execPath, [scriptPath, "--output", "/tmp/x.html"], { encoding: "utf8" });
  const usageCode = await new Promise((resolveCode) => usage.on("close", resolveCode));
  assert.equal(usageCode, 2);

  const decoyCwd = join(root, "cli-cwd");
  await mkdir(decoyCwd);
  const child = spawn(process.execPath, [scriptPath, "--session-dir", session], {
    cwd: decoyCwd,
    env: decoyEnv(binDir, { MD2HTML_ARG_LOG: logPath }),
    encoding: "utf8",
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((resolveCode) => child.on("close", resolveCode));
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.htmlPath, join(session, "analysis", "main.html"));
  const logged = JSON.parse(await readFile(logPath, "utf8"));
  assert.equal(logged.args.includes("-o"), true);
  try {
    await readFile(join(decoyCwd, "main.html"));
    assert.fail("CLI must not write HTML into its cwd");
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
});
