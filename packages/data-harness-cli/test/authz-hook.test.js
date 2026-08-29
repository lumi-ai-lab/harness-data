import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runAuthzHook } from "../src/commands/authz-hook.js";
import { ENV_AUTH_BLOB, ENV_AUTH_BLOB_FILE, ENV_AUTH_USER_ID } from "../src/lib/authz/constants.js";
import { run, runAdapterEnvelope, toGoHookJSON } from "../src/lib/authz/hook.js";
import { shellQuote } from "../src/lib/authz/metric-command.js";
import { ExitError } from "../src/lib/exit.js";

const testBlob = "qdm1enc.testblob";

function writeHarnessConfig(body) {
  const root = mkdtempSync(path.join(tmpdir(), "authz-hook-"));
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "config"), { recursive: true });
  let metricName = "qdm-metric-cli";
  let content = "#!/bin/sh\nexit 0\n";
  if (process.platform === "win32") {
    metricName += ".exe";
    content = "fixture";
  }
  const metricPath = path.join(root, "bin", metricName);
  writeFileSync(metricPath, content, { mode: 0o755 });
  chmodSync(metricPath, 0o755);
  writeFileSync(path.join(root, "config", "harness-config.yaml"), body);
  return root;
}

function hookInput(command, extra = {}) {
  return JSON.stringify({
    session_id: "session-1",
    hook_event_name: "PreToolUse",
    tool_name: extra.tool_name || "Bash",
    tool_input: { command, ...extra.tool_input },
  });
}

function withAuthEnv(fn) {
  const prevBlob = process.env[ENV_AUTH_BLOB];
  const prevUser = process.env[ENV_AUTH_USER_ID];
  const prevCli = process.env.QDM_METRIC_CLI;
  process.env[ENV_AUTH_BLOB] = testBlob;
  process.env[ENV_AUTH_USER_ID] = "env-user";
  process.env.QDM_METRIC_CLI = "";
  try {
    return fn();
  } finally {
    if (prevBlob == null) delete process.env[ENV_AUTH_BLOB];
    else process.env[ENV_AUTH_BLOB] = prevBlob;
    if (prevUser == null) delete process.env[ENV_AUTH_USER_ID];
    else process.env[ENV_AUTH_USER_ID] = prevUser;
    if (prevCli == null) delete process.env.QDM_METRIC_CLI;
    else process.env.QDM_METRIC_CLI = prevCli;
  }
}

test("authz-hook adapter-envelope format validation", async () => {
  const root = writeHarnessConfig("paths:\n  knowledge: wikis\n");
  await assert.rejects(
    () => runAuthzHook(root, ["--agent", "codex", "--format", "adapter-envelope"], { stdin: "{}", stdout: { write() {} } }),
    (err) => err instanceof ExitError && err.code === 2,
  );
  await assert.rejects(
    () => runAuthzHook(root, ["--agent", "workbuddy", "--format", "unknown"], { stdin: "{}", stdout: { write() {} } }),
    (err) => err instanceof ExitError && err.code === 2,
  );
});

test("hook authz off passes through without mutation", () => {
  const root = writeHarnessConfig(`paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /abs/bin/qdm-metric-cli

authz:
  mode: off
`);
  withAuthEnv(() => {
    for (const command of [
      "qdm-metric-cli auth describe",
      "qdm-metric-cli analysis execute --metric saleAmt",
      "env | sort",
    ]) {
      const { ok } = run(root, "codex", hookInput(command));
      assert.equal(ok, false, command);
    }
  });
});

test("hook authz on injects runtime blob and scrubs env", () => {
  const root = writeHarnessConfig(`paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /abs/bin/qdm-metric-cli

authz:
  mode: on
  allow_local_blob: true
`);
  withAuthEnv(() => {
    const { ok, output } = run(root, "codex", hookInput("qdm-metric-cli analysis execute --metric saleAmt"));
    assert.equal(ok, true);
    const printed = toGoHookJSON(output);
    const command = printed.hookSpecificOutput.updatedInput.command;
    let metricName = "qdm-metric-cli";
    if (process.platform === "win32") metricName += ".exe";
    const expectedPrefix = `unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR; ${shellQuote(path.join(root, "bin", metricName))} analysis execute --metric saleAmt --data-auth --auth-blob 'qdm1enc.testblob'`;
    assert.equal(command, expectedPrefix);
  });
});

test("hook authz file source passes a canonical path, not the blob, on Unix", { skip: process.platform === "win32" }, () => {
  const root = writeHarnessConfig(`paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /abs/bin/qdm-metric-cli

authz:
  mode: on
  allow_local_blob: true
`);
  const blobPath = path.join(root, "config", "file-auth.blob");
  writeFileSync(blobPath, `${testBlob}\n`, { mode: 0o600 });
  chmodSync(blobPath, 0o600);
  const previous = {
    blob: process.env[ENV_AUTH_BLOB],
    file: process.env[ENV_AUTH_BLOB_FILE],
    user: process.env[ENV_AUTH_USER_ID],
  };
  delete process.env[ENV_AUTH_BLOB];
  process.env[ENV_AUTH_BLOB_FILE] = blobPath;
  process.env[ENV_AUTH_USER_ID] = "env-user";
  try {
    const { ok, output } = run(root, "codex", hookInput("qdm-metric-cli analysis execute --metric saleAmt"));
    assert.equal(ok, true);
    const command = toGoHookJSON(output).hookSpecificOutput.updatedInput.command;
    assert.equal(command.includes(testBlob), false);
    assert.equal(command.includes(path.resolve(blobPath)), true);
  } finally {
    if (previous.blob == null) delete process.env[ENV_AUTH_BLOB]; else process.env[ENV_AUTH_BLOB] = previous.blob;
    if (previous.file == null) delete process.env[ENV_AUTH_BLOB_FILE]; else process.env[ENV_AUTH_BLOB_FILE] = previous.file;
    if (previous.user == null) delete process.env[ENV_AUTH_USER_ID]; else process.env[ENV_AUTH_USER_ID] = previous.user;
  }
});

test("adapter envelope disabled without authz section", () => {
  const root = writeHarnessConfig("paths:\n  knowledge: wikis\n");
  const envelope = runAdapterEnvelope(root, "workbuddy", hookInput("qdm-metric-cli auth describe"));
  assert.equal(envelope.status, "disabled");
});

test("non-gated bash scrubs auth source environment", () => {
  const root = writeHarnessConfig(`paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`);
  withAuthEnv(() => {
    const { ok, output } = run(root, "codex", hookInput("env | sort"));
    assert.equal(ok, true);
    assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
    assert.match(output.hookSpecificOutput.updatedInput.command, /^unset HARNESS_AUTH_BLOB /);
    assert.match(output.hookSpecificOutput.updatedInput.command, /env \| sort$/);
  });
});

test("non-gated bash noops without auth source environment", () => {
  const root = writeHarnessConfig(`paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`);
  const prevBlob = process.env[ENV_AUTH_BLOB];
  const prevUser = process.env[ENV_AUTH_USER_ID];
  delete process.env[ENV_AUTH_BLOB];
  delete process.env[ENV_AUTH_USER_ID];
  try {
    const { ok } = run(root, "codex", hookInput("env | sort"));
    assert.equal(ok, false);
  } finally {
    if (prevBlob != null) process.env[ENV_AUTH_BLOB] = prevBlob;
    if (prevUser != null) process.env[ENV_AUTH_USER_ID] = prevUser;
  }
});
