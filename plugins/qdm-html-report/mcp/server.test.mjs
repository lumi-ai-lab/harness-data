import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

async function installFakeMetricCli(dir) {
  await mkdir(dir, { recursive: true });
  const bin = join(dir, "qdm-metric-cli");
  await writeFile(bin, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await chmod(bin, 0o755);
  return bin;
}

async function seedAConfigSession(t, sessionId, result) {
  const sessionDir = join(repoRoot, ".harness", "state", "html-report", sessionId);
  t.after(async () => rm(sessionDir, { recursive: true, force: true }));
  await mkdir(join(sessionDir, "debug"), { recursive: true });
  await writeFile(join(sessionDir, "debug", "mcp-pipeline-state.json"), `${JSON.stringify({
    version: 1,
    sessionId,
    stage: "a_config",
    cards: [],
    currentIndex: -1,
    startedAt: "2026-08-25T00:00:00.000Z",
  }, null, 2)}\n`);
  await writeFile(join(sessionDir, "debug", "metric-cli-ui.json"), `${JSON.stringify({
    version: 1,
    sessionId,
    url: "http://127.0.0.1:9876",
    pid: 0,
    cliPid: 0,
  }, null, 2)}\n`);
  await writeFile(join(sessionDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return sessionDir;
}

test("MCP loader and server do not import PI agent directories", async () => {
  const files = [
    serverPath,
    fileURLToPath(new URL("./kernel-loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./runtime-resolver.mjs", import.meta.url)),
  ];
  for (const path of files) {
    const src = await readFile(path, "utf8");
    assert.equal(src.includes("resolveAgentsPath"), false, path);
    assert.equal(src.includes("importScript("), false, path);
    assert.equal(src.includes("join(workspace, \".agents\""), false, path);
    assert.doesNotMatch(src, /from ["'][^"']*agents\/pi/);
  }
  const { resolveKernelPath, resolveRuntimePath, kernelSource } = await import(
    new URL("./kernel-loader.mjs", import.meta.url)
  );
  assert.match(resolveKernelPath("data/fetch-entry.mjs"), /html-report-kernel/);
  assert.match(resolveRuntimePath("authz-config.mjs"), /harness-runtime-node/);
  assert.equal(["dist", "packages"].includes(kernelSource()), true);
  assert.equal(resolveKernelPath("data/fetch-entry.mjs").includes("agents/pi"), false);
  assert.equal(resolveRuntimePath("authz-config.mjs").includes("agents/pi"), false);

  const researchEvidencePath = resolveKernelPath("evidence/prepare-research-evidence.mjs");
  const assembleReportPath = resolveKernelPath("artifacts/assemble-report.mjs");
  const [researchEvidence, assembleReport] = await Promise.all([
    readFile(researchEvidencePath, "utf8"),
    readFile(assembleReportPath, "utf8"),
  ]);
  assert.doesNotMatch(researchEvidence, /\.agents\/pi/);
  assert.doesNotMatch(assembleReport, /prepare-research-evidence\.mjs/);
  assert.match(assembleReport, /from ["']\.\.\/data\/fetch-entry\.mjs["']/);
});

test("packaged B2 and research evidence modules load without PI source directories", async () => {
  const { resolveKernelPath } = await import(new URL("./kernel-loader.mjs", import.meta.url));
  const [captionEvidence, researchEvidence] = await Promise.all([
    import(pathToFileURL(resolveKernelPath("evidence/prepare-card-caption-evidence.mjs")).href),
    import(pathToFileURL(resolveKernelPath("evidence/prepare-research-evidence.mjs")).href),
  ]);
  assert.equal(typeof captionEvidence.prepareCardCaptionEvidence, "function");
  assert.equal(typeof researchEvidence.prepareSourceFieldInventory, "function");
});

test("self-test sees six tools including close_ui and generate_html", async () => {
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
      "html_report_close_ui",
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

test("B0 pass closes the editor; B0 failure leaves it available for correction", async (t) => {
  const binDir = await mkdtemp(join(tmpdir(), "mcp-qdm-cli-"));
  t.after(async () => rm(binDir, { recursive: true, force: true }));
  const metricCli = await installFakeMetricCli(binDir);
  const { rpc, callTool } = startServer(t, {
    env: { ...process.env, QDM_METRIC_CLI: metricCli },
  });
  await rpc("initialize", {});

  const passedSessionId = `mcp-b0-pass-${process.pid}-${Date.now()}`;
  const passedSession = await seedAConfigSession(t, passedSessionId, {
    status: "confirmed",
    cards: [{ id: "card-1" }],
  });
  const passed = await callTool("html_report_next", { sessionId: passedSessionId });
  assert.match(passed.error?.message || "", /fetch failed for card card-1/);
  await assert.rejects(
    readFile(join(passedSession, "debug", "metric-cli-ui.json")),
    (error) => error.code === "ENOENT"
  );
  const passedStatus = await callTool("html_report_status", { sessionId: passedSessionId });
  assert.equal(passedStatus.result.stage, "b2_writer");
  assert.equal(passedStatus.result.ui.state, "closed");

  const failedSessionId = `mcp-b0-fail-${process.pid}-${Date.now()}`;
  const failedSession = await seedAConfigSession(t, failedSessionId, {
    status: "draft",
    cards: [{ id: "card-1" }],
  });
  const failed = await callTool("html_report_next", { sessionId: failedSessionId });
  assert.match(failed.error?.message || "", /result\.status must be "confirmed"/);
  await assert.doesNotReject(readFile(join(failedSession, "debug", "metric-cli-ui.json"), "utf8"));

  const closed = await callTool("html_report_close_ui", { sessionId: failedSessionId });
  assert.equal(closed.result.ui.state, "closed");
  await assert.rejects(
    readFile(join(failedSession, "debug", "metric-cli-ui.json")),
    (error) => error.code === "ENOENT"
  );
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
