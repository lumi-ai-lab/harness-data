import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureResultUserQuestion,
  openMetricCliUi,
  parseUiListenUrl,
  persistAConfigQuestion,
  pidAlive,
  resolveWatchPid,
  stopMetricCliUi,
} from "../scripts/open-metric-cli-ui.mjs";
import { approvePipelineStage, finishPipelineStage, initPipeline, startPipelineStage } from "../scripts/stage-gate.mjs";

const script = fileURLToPath(new URL("../scripts/open-metric-cli-ui.mjs", import.meta.url));
const symlinkScript = fileURLToPath(
  new URL("../../../../../.pi/skills/html-report/scripts/open-metric-cli-ui.mjs", import.meta.url)
);

async function writeFakeMetricCli(dir) {
  const cliPath = join(dir, "fake-qdm-metric-cli");
  await writeFile(cliPath, `#!/usr/bin/env node
import http from "node:http";
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(\`qdm-metric-cli ui → http://127.0.0.1:\${port}\\n\`);
});
const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`);
  await chmod(cliPath, 0o755);
  return cliPath;
}

function spawnOwner() {
  return spawn("sleep", ["60"], { stdio: "ignore" });
}

test("parseUiListenUrl extracts the CLI listen address", () => {
  assert.equal(
    parseUiListenUrl("qdm-metric-cli ui → http://127.0.0.1:18080  (Ctrl+C to stop)\n"),
    "http://127.0.0.1:18080"
  );
});

test("openMetricCliUi persists the question and does not write recommendations.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "metric-cli-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opened = await openMetricCliUi({
    projectRoot: root,
    sessionId: "demo-session",
    userQuestion: "分析门店101001客流",
    spawnUi: false,
  });
  assert.equal(opened.preset, "metric-cli-ui");
  assert.equal(opened.serverUrl, null);
  const question = JSON.parse(await readFile(opened.questionPath, "utf8"));
  assert.equal(question.userQuestion, "分析门店101001客流");
  await assert.rejects(readFile(join(opened.sessionDir, "recommendations.json")));
});

test("CLI wrapper runs through the project .pi symlink for start and stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "metric-cli-ui-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const launched = spawnSync(process.execPath, [
    symlinkScript,
    "--session-id",
    "symlink-session",
    "--question",
    "验证软链接入口",
    "--detach",
    "--project-root",
    root,
    "--skip-spawn",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(launched.status, 0, launched.stderr || launched.stdout);
  const opened = JSON.parse(launched.stdout);
  assert.equal(opened.preset, "metric-cli-ui");
  assert.equal(opened.serverUrl, null);
  assert.equal(
    JSON.parse(await readFile(opened.questionPath, "utf8")).userQuestion,
    "验证软链接入口"
  );
  assert.equal(JSON.parse(await readFile(opened.markerPath, "utf8")).sessionId, "symlink-session");

  const stopped = spawnSync(process.execPath, [
    symlinkScript,
    "--stop",
    "--session-id",
    "symlink-session",
    "--project-root",
    root,
  ], { cwd: root, encoding: "utf8" });
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.equal(JSON.parse(stopped.stdout).stopped, false);
  await assert.rejects(readFile(opened.markerPath), (error) => error.code === "ENOENT");
});

test("A_CONFIG approve injects userQuestion from the stored skill prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "metric-cli-ui-approve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = join(root, ".harness", "state", "html-report", "demo-session");
  await persistAConfigQuestion({
    sessionDir: session,
    sessionId: "demo-session",
    userQuestion: "分析门店101001客流",
  });
  await initPipeline(session, { mode: "step" });
  await startPipelineStage(session, "A_CONFIG");
  await finishPipelineStage(session, "A_CONFIG");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(session, "result.json"), `${JSON.stringify({
    status: "confirmed",
    title: "草稿报告",
    cards: [{ id: "ui-card-1", query: { request: { metrics: ["saleAmt"] }, comparisons: [] } }],
  }, null, 2)}\n`);
  await approvePipelineStage(session, { phrase: "继续" });
  const result = JSON.parse(await readFile(join(session, "result.json"), "utf8"));
  assert.equal(result.userQuestion, "分析门店101001客流");
  const injected = await ensureResultUserQuestion(session);
  assert.equal(injected.changed, false);
});

test("resolveWatchPid prefers an explicit live pid then PI_AGENT_PID", () => {
  const owner = spawnOwner();
  try {
    const explicit = resolveWatchPid({
      env: { PI_AGENT_PID: String(process.pid) },
      explicitWatchPid: owner.pid,
    });
    assert.equal(explicit.pid, owner.pid);
    assert.equal(explicit.source, "explicit");

    const fromEnv = resolveWatchPid({
      env: { PI_AGENT_PID: String(owner.pid) },
      explicitWatchPid: 0,
    });
    assert.equal(fromEnv.pid, owner.pid);
    assert.equal(fromEnv.source, "env");
  } finally {
    owner.kill("SIGKILL");
  }
});

test("detached UI worker keeps serving after launcher exits and dies with watch-pid", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "metric-cli-ui-life-"));
  const fakeCli = await writeFakeMetricCli(root);
  const owner = spawnOwner();
  t.after(async () => {
    try {
      owner.kill("SIGKILL");
    } catch {
      // ignore
    }
    spawnSync(process.execPath, [
      script,
      "--stop",
      "--session-id",
      "life-session",
      "--project-root",
      root,
    ], { encoding: "utf8" });
    await rm(root, { recursive: true, force: true });
  });

  const launcher = spawn(
    process.execPath,
    [
      script,
      "--session-id",
      "life-session",
      "--project-root",
      root,
      "--detach",
      "--no-open",
      "--watch-pid",
      String(owner.pid),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        QDM_METRIC_CLI: fakeCli,
        HTML_REPORT_METRIC_CLI_UI_WATCH_MS: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const [chunk] = await once(launcher.stdout, "data");
  const opened = JSON.parse(chunk.toString());
  assert.equal(opened.preset, "metric-cli-ui");
  assert.match(opened.serverUrl, /^http:\/\/127\.0\.0\.1:\d+/);
  assert.equal(opened.watchPid, owner.pid);
  assert.ok(opened.pid > 1);
  assert.ok(opened.cliPid > 1);
  assert.notEqual(opened.pid, launcher.pid);

  const launcherExit = await Promise.race([
    once(launcher, "exit").then(([code]) => code),
    new Promise((_, reject) => setTimeout(() => reject(new Error("detach launcher did not exit")), 10000)),
  ]);
  assert.equal(launcherExit, 0);
  assert.equal((await fetch(opened.serverUrl)).status, 200);
  assert.equal(pidAlive(opened.pid), true);
  assert.equal(pidAlive(opened.cliPid), true);

  owner.kill("SIGTERM");
  const deadline = Date.now() + 8000;
  let workerDown = false;
  let cliDown = false;
  while (Date.now() < deadline) {
    workerDown = !pidAlive(opened.pid);
    cliDown = !pidAlive(opened.cliPid);
    if (workerDown && cliDown) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(workerDown, true, "worker should exit when watch-pid dies");
  assert.equal(cliDown, true, "qdm-metric-cli ui should exit when watch-pid dies");
});

test("stopMetricCliUi kills the detached worker and CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "metric-cli-ui-stop-"));
  const fakeCli = await writeFakeMetricCli(root);
  const owner = spawnOwner();
  t.after(async () => {
    try {
      owner.kill("SIGKILL");
    } catch {
      // ignore
    }
    await stopMetricCliUi({ projectRoot: root, sessionId: "stop-session" });
    await rm(root, { recursive: true, force: true });
  });

  const opened = await openMetricCliUi({
    projectRoot: root,
    sessionId: "stop-session",
    spawnUi: true,
    detach: true,
    open: false,
    watchPid: owner.pid,
    env: {
      ...process.env,
      QDM_METRIC_CLI: fakeCli,
      HTML_REPORT_METRIC_CLI_UI_WATCH_MS: "200",
    },
  });
  assert.equal((await fetch(opened.serverUrl)).status, 200);
  const stopped = await stopMetricCliUi({ projectRoot: root, sessionId: "stop-session" });
  assert.equal(stopped.stopped, true);
  assert.equal(pidAlive(opened.pid), false);
  assert.equal(pidAlive(opened.cliPid), false);
});
