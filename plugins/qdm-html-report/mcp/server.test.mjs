import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rowsSha256 } from "../../../packages/html-report-kernel/src/data/fetch-entry.mjs";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const repoRoot = resolve(new URL("../../../", import.meta.url).pathname);
const pluginSkillPath = join(repoRoot, "plugins", "qdm-html-report", "skills", "html-report", "SKILL.md");
const localSkillPath = join(repoRoot, ".codex", "skills", "html-report", "SKILL.md");

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

async function seedCachedCard(sessionDir, cardId, rows, columnLabels = {}) {
  const cardDir = join(sessionDir, "data", "cards", cardId);
  await mkdir(cardDir, { recursive: true });
  await Promise.all([
    writeFile(join(cardDir, "entry.json"), `${JSON.stringify(rows, null, 2)}\n`),
    writeFile(join(cardDir, "entry.meta.json"), `${JSON.stringify({
      rowCount: rows.length,
      rowsSha256: rowsSha256(rows),
    }, null, 2)}\n`),
    writeFile(join(cardDir, "entry.column-meta.json"), `${JSON.stringify(columnLabels, null, 2)}\n`),
  ]);
}

function testCard(id, title) {
  return {
    id,
    title,
    query: {
      request: {
        metrics: ["saleAmt"],
        statisticPolicy: "SUMMARY",
        time: { startDate: "2026-08-01", endDate: "2026-08-02" },
        dimensions: [],
        filters: {},
      },
      comparisons: [],
    },
  };
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

test("Codex html-report Skill exactly mirrors the plugin Skill", async () => {
  const [pluginSkill, localSkill] = await Promise.all([
    readFile(pluginSkillPath, "utf8"),
    readFile(localSkillPath, "utf8"),
  ]);
  assert.equal(localSkill, pluginSkill);
});

test("MCP returns visible progress for each cached Writer card", async (t) => {
  const binDir = await mkdtemp(join(tmpdir(), "mcp-qdm-cli-progress-"));
  t.after(async () => rm(binDir, { recursive: true, force: true }));
  const metricCli = await installFakeMetricCli(binDir);
  const { rpc, callTool } = startServer(t, {
    env: { ...process.env, QDM_METRIC_CLI: metricCli },
  });
  await rpc("initialize", {});

  const sessionId = `mcp-progress-${process.pid}-${Date.now()}`;
  const inventory = testCard("inventory-turnover", "库存周转");
  const stockout = testCard("stockout-rate", "缺货率");
  const sessionDir = await seedAConfigSession(t, sessionId, {
    status: "confirmed",
    title: "逐卡进度测试",
    cards: [inventory, stockout],
  });
  await seedCachedCard(sessionDir, inventory.id, [{ saleAmt: 100 }], { saleAmt: "销售额" });
  await seedCachedCard(sessionDir, stockout.id, [{ saleAmt: 80 }], { saleAmt: "销售额" });

  const firstCard = { number: 1, id: inventory.id, title: inventory.title };
  const secondCard = { number: 2, id: stockout.id, title: stockout.title };

  const first = await callTool("html_report_next", { sessionId });
  assert.equal(first.error, undefined);
  assert.equal(first.result.stage, "b2_writer");
  assert.equal(first.result.cardId, inventory.id);
  assert.equal(first.result.cardTitle, inventory.title);
  assert.deepEqual(first.result.progress, {
    total: 2,
    completed: 0,
    active: firstCard,
    next: firstCard,
  });

  const firstSubmitted = await callTool("html_report_submit_writer", {
    sessionId,
    cardId: inventory.id,
    paragraphs: ["库存周转表现稳定。"],
    pointers: [],
  });
  assert.equal(firstSubmitted.error, undefined);
  assert.deepEqual(firstSubmitted.result.progress, {
    total: 2,
    completed: 1,
    active: firstCard,
    next: secondCard,
  });

  const afterFirst = await callTool("html_report_status", { sessionId });
  assert.equal(afterFirst.error, undefined);
  assert.deepEqual(afterFirst.result.progress, {
    total: 2,
    completed: 1,
    active: firstCard,
    next: secondCard,
  });

  const second = await callTool("html_report_next", { sessionId });
  assert.equal(second.error, undefined);
  assert.equal(second.result.stage, "b2_writer");
  assert.equal(second.result.cardId, stockout.id);
  assert.equal(second.result.cardTitle, stockout.title);
  assert.deepEqual(second.result.progress, {
    total: 2,
    completed: 1,
    active: secondCard,
    next: secondCard,
  });

  const secondSubmitted = await callTool("html_report_submit_writer", {
    sessionId,
    cardId: stockout.id,
    paragraphs: ["缺货率表现稳定。"],
    pointers: [],
  });
  assert.equal(secondSubmitted.error, undefined);
  assert.deepEqual(secondSubmitted.result.progress, {
    total: 2,
    completed: 2,
    active: null,
    next: null,
  });

  const completed = await callTool("html_report_next", { sessionId });
  assert.equal(completed.error, undefined);
  assert.equal(completed.result.stage, "b2_main");
  assert.equal(completed.result.html, "awaiting_confirmation");
  assert.deepEqual(completed.result.progress, {
    total: 2,
    completed: 2,
    active: null,
    next: null,
  });
  const main = await readFile(join(sessionDir, "analysis", "main.md"), "utf8");
  assert.match(main, /## 库存周转/);
  assert.match(main, /## 缺货率/);
  assert.match(main, /库存周转表现稳定。/);
  assert.match(main, /缺货率表现稳定。/);

  const finalStatus = await callTool("html_report_status", { sessionId });
  assert.equal(finalStatus.error, undefined);
  assert.deepEqual(finalStatus.result.progress, {
    total: 2,
    completed: 2,
    active: null,
    next: null,
  });
});

test("MCP rejects invalid caption evidence without writing or completing the card", async (t) => {
  const binDir = await mkdtemp(join(tmpdir(), "mcp-qdm-cli-caption-reject-"));
  t.after(async () => rm(binDir, { recursive: true, force: true }));
  const metricCli = await installFakeMetricCli(binDir);
  const { rpc, callTool } = startServer(t, {
    env: { ...process.env, QDM_METRIC_CLI: metricCli },
  });
  await rpc("initialize", {});

  const sessionId = `mcp-caption-reject-${process.pid}-${Date.now()}`;
  const card = testCard("sales", "销售额");
  card.query.request.dimensions = ["bizDate"];
  const sessionDir = await seedAConfigSession(t, sessionId, {
    status: "confirmed",
    title: "Caption 严格校验测试",
    cards: [card],
  });
  await seedCachedCard(sessionDir, card.id, [{ bizDate: "2026-08-01", saleAmt: 100 }], {
    bizDate: "日",
    saleAmt: "销售额",
  });

  const fetched = await callTool("html_report_next", { sessionId });
  assert.equal(fetched.error, undefined);
  const validPointer = "/views/topN-saleAmt-bizDate/rows/0/metricValue";
  const captionPath = join(sessionDir, "data", "cards", card.id, "caption.md");
  const violationsPath = join(sessionDir, "data", "cards", card.id, "caption.md.violations.json");

  const rejectedNumber = await callTool("html_report_submit_writer", {
    sessionId,
    cardId: card.id,
    paragraphs: ["销售额 9999。"],
    pointers: [validPointer],
  });
  assert.match(rejectedNumber.error?.message || "", /caption rejected: number 9999/);

  const rejectedPointer = await callTool("html_report_submit_writer", {
    sessionId,
    cardId: card.id,
    paragraphs: ["销售额 100。"],
    pointers: ["/views/not-a-real-view"],
  });
  assert.match(rejectedPointer.error?.message || "", /does not resolve/);

  await assert.rejects(readFile(captionPath), (error) => error.code === "ENOENT");
  await assert.rejects(readFile(violationsPath), (error) => error.code === "ENOENT");
  const statusAfterRejects = await callTool("html_report_status", { sessionId });
  assert.equal(statusAfterRejects.error, undefined);
  assert.deepEqual(statusAfterRejects.result.progress, {
    total: 1,
    completed: 0,
    active: { number: 1, id: card.id, title: card.title },
    next: { number: 1, id: card.id, title: card.title },
  });
  assert.equal(statusAfterRejects.result.cards[0].captioned, false);

  const accepted = await callTool("html_report_submit_writer", {
    sessionId,
    cardId: card.id,
    paragraphs: ["2026-08-01 销售额 100。"],
    pointers: [validPointer],
  });
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result.accepted, true);
  assert.match(await readFile(captionPath, "utf8"), /销售额 100/);
});

test("MCP accepts more row-level pointers than evidence views after folding", async (t) => {
  const binDir = await mkdtemp(join(tmpdir(), "mcp-qdm-cli-caption-fold-"));
  t.after(async () => rm(binDir, { recursive: true, force: true }));
  const metricCli = await installFakeMetricCli(binDir);
  const { rpc, callTool } = startServer(t, {
    env: { ...process.env, QDM_METRIC_CLI: metricCli },
  });
  await rpc("initialize", {});

  const sessionId = `mcp-caption-fold-${process.pid}-${Date.now()}`;
  const card = testCard("sales", "销售额");
  card.query.request.dimensions = ["manageAreaId"];
  const sessionDir = await seedAConfigSession(t, sessionId, {
    status: "confirmed",
    title: "Caption view-fold 测试",
    cards: [card],
  });
  await seedCachedCard(sessionDir, card.id, [
    { manageAreaId: "香港区", saleAmt: 49845.44 },
    { manageAreaId: "澳门区", saleAmt: 28598.99 },
    { manageAreaId: "南京区", saleAmt: 14760.42 },
    { manageAreaId: "武汉区", saleAmt: 12182.68 },
  ], {
    manageAreaId: "管理区域",
    saleAmt: "销售额",
  });

  const fetched = await callTool("html_report_next", { sessionId });
  assert.equal(fetched.error, undefined);
  const views = fetched.result.evidence?.views || {};
  const viewIds = Object.keys(views);
  assert.ok(viewIds.length >= 2, `expected at least 2 views, got ${viewIds.join(",")}`);

  const pointers = [];
  for (const id of viewIds) {
    const rows = views[id]?.rows || [];
    for (let i = 0; i < rows.length; i++) {
      pointers.push(`/views/${id}/rows/${i}/metricValue`);
    }
  }
  assert.ok(pointers.length > viewIds.length);

  const accepted = await callTool("html_report_submit_writer", {
    sessionId,
    cardId: card.id,
    paragraphs: ["香港区销售额 49845.44。"],
    pointers,
  });
  assert.equal(accepted.error, undefined, accepted.error?.message);
  assert.equal(accepted.result.accepted, true);
  const captionPath = join(sessionDir, "data", "cards", card.id, "caption.md");
  assert.match(await readFile(captionPath, "utf8"), /49845.44/);
});

test("progress derives original titles for legacy title-free card state", async (t) => {
  const sessionId = `mcp-progress-legacy-${process.pid}-${Date.now()}`;
  const card = testCard("legacy-card", "原始卡片标题");
  const sessionDir = await seedAConfigSession(t, sessionId, {
    status: "confirmed",
    cards: [card],
  });
  await writeFile(join(sessionDir, "debug", "mcp-pipeline-state.json"), `${JSON.stringify({
    version: 1,
    sessionId,
    stage: "b2_writer",
    cards: [{ id: card.id, captioned: false }],
    currentIndex: 0,
    startedAt: "2026-08-25T00:00:00.000Z",
  }, null, 2)}\n`);

  const { rpc, callTool } = startServer(t);
  await rpc("initialize", {});
  const status = await callTool("html_report_status", { sessionId });
  assert.equal(status.error, undefined);
  assert.equal(Object.hasOwn(status.result.cards[0], "title"), false);
  assert.deepEqual(status.result.progress, {
    total: 1,
    completed: 0,
    active: { number: 1, id: card.id, title: card.title },
    next: { number: 1, id: card.id, title: card.title },
  });
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
