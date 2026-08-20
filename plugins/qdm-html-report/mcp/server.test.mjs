import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const repoRoot = resolve(new URL("../../../", import.meta.url).pathname);

async function installFakeMd2html(dir, { fail = false } = {}) {
  await mkdir(dir, { recursive: true });
  const bin = join(dir, "md2html");
  await writeFile(bin, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
if (!out || args[args.indexOf("--theme") + 1] !== "report" || args[args.indexOf("--renderer") + 1] !== "svg") {
  process.stderr.write("bad md2html args\\n");
  process.exit(2);
}
if (${fail ? "true" : "false"}) {
  process.stderr.write("md2html boom\\n");
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, "<html>ok</html>\\n");
`);
  await chmod(bin, 0o755);
  return bin;
}

function startServer(t, { env = process.env } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGKILL");
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && pending.has(message.id)) {
        const { resolve } = pending.get(message.id);
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  let nextId = 1;
  async function rpc(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return result;
  }
  async function callTool(name, args) {
    const message = await rpc("tools/call", { name, arguments: args });
    if (message.error) return { error: message.error };
    const text = message.result?.content?.[0]?.text || "";
    return { result: JSON.parse(text) };
  }
  return { rpc, callTool };
}

async function seedB2MainSession(t, sessionId, { main = "# 报告\n" } = {}) {
  const sessionDir = join(repoRoot, ".harness", "state", "html-report", sessionId);
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await mkdir(join(sessionDir, "analysis"), { recursive: true });
  await mkdir(join(sessionDir, "debug"), { recursive: true });
  await writeFile(join(sessionDir, "analysis", "main.md"), main);
  await writeFile(join(sessionDir, "debug", "mcp-pipeline-state.json"), `${JSON.stringify({
    version: 1,
    sessionId,
    stage: "b2_main",
    cards: [{ id: "south", captioned: true }],
    currentIndex: 0,
    mainPath: join(sessionDir, "analysis", "main.md"),
    startedAt: "2026-08-20T00:00:00.000Z",
  }, null, 2)}\n`);
  return sessionDir;
}

test("self-test sees five tools including generate_html and export-main-html", async () => {
  const child = spawn(process.execPath, [serverPath, "--self-test"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((resolveCode) => child.on("close", resolveCode));
  assert.equal(code, 0);
  assert.match(stdout, /passed/);
});

test("B2_MAIN does not auto-export; generate_html works after explicit call", async (t) => {
  const sessionId = `mcp-html-ok-${process.pid}-${Date.now()}`;
  const sessionDir = await seedB2MainSession(t, sessionId);
  const binDir = await mkdtemp(join(tmpdir(), "mcp-md2html-"));
  t.after(async () => rm(binDir, { recursive: true, force: true }));
  await installFakeMd2html(binDir);
  const { rpc, callTool } = startServer(t, {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ""}` },
  });
  await rpc("initialize", {});
  const listed = await rpc("tools/list", {});
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      "html_report_start",
      "html_report_next",
      "html_report_submit_writer",
      "html_report_generate_html",
      "html_report_status",
    ],
  );

  const next = await callTool("html_report_next", { sessionId });
  assert.equal(next.result.stage, "b2_main");
  assert.equal(next.result.html, "awaiting_confirmation");
  await assert.rejects(readFile(join(sessionDir, "analysis", "main.html")), (error) => error.code === "ENOENT");

  const statusBefore = await callTool("html_report_status", { sessionId });
  assert.equal(statusBefore.result.html.status, "awaiting_confirmation");

  const generated = await callTool("html_report_generate_html", { sessionId });
  assert.equal(generated.result.ok, true);
  assert.equal(generated.result.status, "generated");
  assert.equal(generated.result.htmlPath, join(sessionDir, "analysis", "main.html"));
  assert.match(await readFile(generated.result.htmlPath, "utf8"), /<html>ok<\/html>/);

  const again = await callTool("html_report_generate_html", { sessionId });
  assert.equal(again.result.status, "up_to_date");

  const statusAfter = await callTool("html_report_status", { sessionId });
  assert.equal(statusAfter.result.html.status, "generated");
  assert.equal(statusAfter.result.html.htmlPath, join(sessionDir, "analysis", "main.html"));
});

test("generate_html failure can be retried and rejects extra path arguments", async (t) => {
  const sessionId = `mcp-html-fail-${process.pid}-${Date.now()}`;
  const sessionDir = await seedB2MainSession(t, sessionId, { main: "# 保留\n" });
  const failDir = await mkdtemp(join(tmpdir(), "mcp-md2html-fail-"));
  const okDir = await mkdtemp(join(tmpdir(), "mcp-md2html-ok-"));
  t.after(async () => {
    await rm(failDir, { recursive: true, force: true });
    await rm(okDir, { recursive: true, force: true });
  });
  await installFakeMd2html(failDir, { fail: true });
  await installFakeMd2html(okDir);

  const failing = startServer(t, {
    env: { ...process.env, PATH: `${failDir}:${process.env.PATH || ""}` },
  });
  await failing.rpc("initialize", {});
  const failed = await failing.callTool("html_report_generate_html", { sessionId });
  assert.equal(failed.result.ok, false);
  assert.equal(await readFile(join(sessionDir, "analysis", "main.md"), "utf8"), "# 保留\n");
  await assert.rejects(readFile(join(sessionDir, "analysis", "main.html")), (error) => error.code === "ENOENT");

  const extra = await failing.callTool("html_report_generate_html", {
    sessionId,
    outputPath: "/tmp/evil.html",
    html: "<html></html>",
  });
  assert.match(extra.error?.message || "", /unexpected: outputPath, html/);

  const retrying = startServer(t, {
    env: { ...process.env, PATH: `${okDir}:${process.env.PATH || ""}` },
  });
  await retrying.rpc("initialize", {});
  const retried = await retrying.callTool("html_report_generate_html", { sessionId });
  assert.equal(retried.result.ok, true);
  assert.equal(retried.result.status, "generated");
});
