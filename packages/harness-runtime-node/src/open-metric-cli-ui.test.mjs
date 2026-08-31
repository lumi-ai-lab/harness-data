import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeRootContext } from "./root-context.mjs";
import {
  METRIC_CLI_UI_MARKER_RELATIVE_PATH,
  openMetricCliUi,
  sessionDirFor,
  stopMetricCliUi,
} from "./open-metric-cli-ui.mjs";

async function makeContext() {
  const base = await mkdtemp(join(tmpdir(), "qdm-ui-context-"));
  const pluginRoot = join(base, "plugin");
  const dataRoot = join(base, "data");
  const workspaceRoot = join(base, "workspace");
  await Promise.all([mkdir(pluginRoot), mkdir(dataRoot), mkdir(workspaceRoot)]);
  return {
    base,
    context: normalizeRootContext({ pluginRoot, dataRoot, workspaceRoot, host: "pi", sessionId: "ui-session" }),
  };
}

test("metric-cli UI stores session files in the explicit stateRoot", async () => {
  const { base, context } = await makeContext();
  try {
    const opened = await openMetricCliUi({ context, sessionId: "ui-session", spawnUi: false, open: false, env: {} });
    const marker = join(opened.sessionDir, ...METRIC_CLI_UI_MARKER_RELATIVE_PATH);
    assert.equal(opened.sessionDir, sessionDirFor(context.pluginRoot, "ui-session", context.stateRoot));
    assert.equal(marker.startsWith(context.stateRoot), true);
    assert.equal(marker.startsWith(context.pluginRoot), false);
    assert.equal(existsSync(marker), true);
    await stopMetricCliUi({ context, sessionId: "ui-session", env: {} });
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("metric-cli UI forwards the Plugin auth file through QDM_AUTH_BLOB", async () => {
  const base = await mkdtemp(join(tmpdir(), "qdm-ui-auth-context-"));
  const pluginRoot = join(base, "plugin");
  const dataRoot = join(base, "data");
  const workspaceRoot = join(base, "workspace");
  const configDir = join(pluginRoot, "config");
  const secretDir = join(pluginRoot, "secrets");
  const configPath = join(configDir, "settings.json");
  const legacyConfigPath = join(configDir, "harness-config.yaml");
  const secretPath = join(secretDir, "auth.blob");
  const cliPath = join(pluginRoot, "qdm-metric-cli");
  const logPath = join(base, "ui-env.json");
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(secretDir, { recursive: true }),
    mkdir(dataRoot),
    mkdir(workspaceRoot),
  ]);
  await writeFile(configPath, `${JSON.stringify({
    authz: { mode: "on", userId: "runtime-user" },
    metricCliPath: cliPath,
  })}\n`);
  await writeFile(legacyConfigPath, `cli:\n  qdm_metric_cli: ${cliPath}\nauthz:\n  mode: on\n  dev_user_id: runtime-user\n  allow_local_blob: false\n`);
  await writeFile(secretPath, "qdm1enc.runtime\n", { mode: 0o600 });
  await chmod(secretPath, 0o600);
  await writeFile(cliPath, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.TEST_UI_ENV_LOG, JSON.stringify({
  authBlob: process.env.QDM_AUTH_BLOB || "",
  args: process.argv.slice(2),
}));
process.stdout.write("qdm-metric-cli ui -> http://127.0.0.1:43123\\n");
setInterval(() => {}, 1000);
`);
  await chmod(cliPath, 0o755);
  const context = normalizeRootContext({
    pluginRoot,
    dataRoot,
    workspaceRoot,
    host: "codex",
    configPath,
    secretRoot: secretDir,
    secretRef: { kind: "file", path: secretPath },
  });
  try {
    const opened = await openMetricCliUi({
      context,
      sessionId: "auth-ui-session",
      open: false,
      detach: true,
      env: { PATH: process.env.PATH, TEST_UI_ENV_LOG: logPath },
    });
    try {
      const invocation = JSON.parse(await readFile(logPath, "utf8"));
      const expectedAuth = process.platform === "win32" ? "qdm1enc.runtime" : realpathSync(secretPath);
      assert.equal(invocation.authBlob, expectedAuth);
      assert.equal(invocation.args.includes("--auth-blob"), false);
    } finally {
      await stopMetricCliUi({ context, sessionId: "auth-ui-session", env: {} });
    }
    assert.equal(opened.serverUrl, "http://127.0.0.1:43123");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("metric-cli UI refuses structured contexts without workspace/state roots", async () => {
  const { base, context } = await makeContext();
  try {
    const noWorkspace = { ...context, workspaceRoot: "", stateRoot: "" };
    await assert.rejects(
      openMetricCliUi({ context: noWorkspace, sessionId: "ui-session", spawnUi: false, env: {} }),
      /QDM_WORKSPACE_REQUIRED/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
