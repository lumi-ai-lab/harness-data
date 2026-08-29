import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
