import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { lumiEnvelopePath } from "../../../extensions/qdm-harness/lumi-envelope.mjs";
import {
  buildMetricExecuteArgs,
  redactMetricSecrets,
  runMetricQuery,
  runMetricQueryAsync,
} from "../scripts/metric-cli-executor.mjs";

const AUTH_BLOB =
  "qdm1enc.OmZXt8XYEbbEetFidYc7ZTqAqdfxWB_pehdpWR5Y7M8ZmSuLr4kGyztvO6q5Galf";

const QUERY = {
  metrics: ["netAmount"],
  statisticPolicy: "SUMMARY",
  time: { startDate: "2026-07-01", endDate: "2026-07-31" },
  dimensions: ["storeId"],
  filters: {},
  comparisons: ["YOY", "MOM"],
};

function createProject(t, authzYaml = "") {
  const root = mkdtempSync(join(tmpdir(), "qdm-metric-executor-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  const cli = join(root, "bin", "qdm-metric-cli");
  writeFileSync(cli, "#!/bin/sh\nexit 0\n");
  chmodSync(cli, 0o755);
  if (authzYaml) writeFileSync(join(root, "config", "harness-config.yaml"), authzYaml);
  return { root, cli };
}

test("Metric executor injects one auth pair, scrubs child env, and redacts process output", (t) => {
  const { root, cli } = createProject(t);
  let invocation;
  const environment = {
    QDM_METRIC_CLI: cli,
    HARNESS_AUTHZ_MODE: "on",
    HARNESS_AUTH_BLOB: AUTH_BLOB,
    HARNESS_AUTH_BLOB_FILE: "/should/not/reach/child",
    HARNESS_AUTH_USER_ID: "metric-user",
    LUMI_REQUESTER_CONTEXT_DIR: "/missing/lumi/context",
    QDM_INDICATORS_TOKEN: "legacy-token",
    QDM_INDICATORS_CLI: "/legacy/indicators",
    QDM_CAS_CLI: "/legacy/cas",
    KEEP_SENTINEL: "kept",
  };

  const result = runMetricQuery(QUERY, {
    projectRoot: root,
    sessionId: "session-1",
    timeoutMs: 1234,
    environment,
    spawn(file, args, options) {
      invocation = { file, args, options };
      return {
        status: 1,
        signal: null,
        error: new Error(`failed ${AUTH_BLOB}`),
        stdout: `stdout ${AUTH_BLOB}`,
        stderr: `denied ${AUTH_BLOB}.`,
      };
    },
  });

  assert.equal(invocation.file, realpathSync(cli));
  assert.equal(invocation.args.filter((arg) => arg === "--data-auth").length, 1);
  assert.equal(invocation.args.filter((arg) => arg === "--auth-blob").length, 1);
  const authIndex = invocation.args.indexOf("--auth-blob");
  assert.equal(invocation.args[authIndex - 1], "--data-auth");
  assert.equal(invocation.args[authIndex + 1], AUTH_BLOB);
  assert.equal(invocation.options.env.KEEP_SENTINEL, "kept");
  for (const key of [
    "HARNESS_AUTH_BLOB",
    "HARNESS_AUTH_BLOB_FILE",
    "HARNESS_AUTH_USER_ID",
    "LUMI_REQUESTER_CONTEXT_DIR",
    "QDM_INDICATORS_TOKEN",
    "QDM_INDICATORS_CLI",
    "QDM_CAS_CLI",
  ]) {
    assert.equal(invocation.options.env[key], undefined, `${key} must not reach qdm-metric-cli`);
  }
  assert.deepEqual(result.authz, { mode: "on", userId: "metric-user", source: "env" });
  for (const value of [result.error, result.stdout, result.stderr]) {
    assert.doesNotMatch(value, /qdm1enc\./);
    assert.match(value, /<redacted-auth-blob>/);
  }
});

test("Metric executor authz off never adds auth flags", (t) => {
  const { root, cli } = createProject(t);
  let args;
  const result = runMetricQuery(QUERY, {
    projectRoot: root,
    sessionId: "session-off",
    environment: { QDM_METRIC_CLI: cli, HARNESS_AUTHZ_MODE: "off" },
    spawn(_file, childArgs) {
      args = childArgs;
      return { status: 0, signal: null, stdout: "[]", stderr: "" };
    },
  });

  assert.equal(args.includes("--data-auth"), false);
  assert.equal(args.includes("--auth-blob"), false);
  assert.deepEqual(result.authz, { mode: "off" });
});

test("Metric executor fails closed on a mismatched Lumi session before spawn", (t) => {
  const { root, cli } = createProject(t, `authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-user
  allow_local_blob: true
`);
  writeFileSync(join(root, "config", "dev-auth.blob"), `${AUTH_BLOB}local\n`);
  const envelopeDir = join(root, "lumi");
  mkdirSync(envelopeDir);
  const requestedSession = "session-a";
  writeFileSync(
    lumiEnvelopePath(envelopeDir, requestedSession),
    JSON.stringify({
      version: 1,
      sessionId: "session-b",
      expiresAt: "2099-01-01T00:00:00Z",
      _auth: `${AUTH_BLOB}host`,
      _auth_user_id: "host-user",
    })
  );
  let spawnCount = 0;

  assert.throws(
    () => runMetricQuery(QUERY, {
      projectRoot: root,
      sessionId: requestedSession,
      environment: {
        QDM_METRIC_CLI: cli,
        LUMI_REQUESTER_CONTEXT_DIR: envelopeDir,
      },
      spawn() {
        spawnCount += 1;
        return { status: 0, signal: null, stdout: "[]", stderr: "" };
      },
    }),
    /METRIC_AUTH_CONTEXT_REQUIRED: lumi envelope sessionId mismatch/
  );
  assert.equal(spawnCount, 0);
});

test("Metric auth flags are only derived from the resolved auth context", () => {
  const off = buildMetricExecuteArgs(QUERY, { authContext: { mode: "off" } });
  assert.equal(off.includes("--data-auth"), false);
  assert.equal(off.includes("--auth-blob"), false);

  const on = buildMetricExecuteArgs(QUERY, {
    authContext: { mode: "on", blob: AUTH_BLOB },
  });
  assert.equal(on.filter((arg) => arg === "--data-auth").length, 1);
  assert.equal(on.filter((arg) => arg === "--auth-blob").length, 1);
  assert.equal(redactMetricSecrets(`before ${AUTH_BLOB}, after`), "before <redacted-auth-blob>, after");
});

test("Metric executor rejects a configured CLI symlink", (t) => {
  const { root, cli } = createProject(t);
  const link = join(root, "bin", "metric-link");
  symlinkSync(cli, link);
  assert.throws(
    () => runMetricQuery(QUERY, {
      projectRoot: root,
      sessionId: "session-link",
      environment: { QDM_METRIC_CLI: link, HARNESS_AUTHZ_MODE: "off" },
    }),
    /configured path must not be a symbolic link/
  );
});

test("runMetricQueryAsync returns the same shape as runMetricQuery", async (t) => {
  const { root, cli } = createProject(t);
  const envelope = JSON.stringify({
    meta: { metrics: [{ code: "netAmount", name: "净额" }] },
    data: [{ storeId: "s1", netAmount: 100 }],
  });
  writeFileSync(cli, `#!/bin/sh\necho '${envelope}'\n`);

  const result = await runMetricQueryAsync(QUERY, {
    projectRoot: root,
    sessionId: "session-async",
    timeoutMs: 5000,
    environment: { QDM_METRIC_CLI: cli, HARNESS_AUTHZ_MODE: "off" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.errorCode, "");
  assert.equal(result.error, "");
  assert.ok(result.stdout.includes("净额"));
  assert.equal(result.stderr, "");
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.authz, { mode: "off" });
  assert.ok(Number.isFinite(result.durationMs));
});

test("runMetricQueryAsync captures non-zero exit and stderr", async (t) => {
  const { root, cli } = createProject(t);
  writeFileSync(cli, "#!/bin/sh\necho 'error msg' 1>&2\nexit 1\n");

  const result = await runMetricQueryAsync(QUERY, {
    projectRoot: root,
    sessionId: "session-async-fail",
    timeoutMs: 5000,
    environment: { QDM_METRIC_CLI: cli, HARNESS_AUTHZ_MODE: "off" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /error msg/);
  assert.equal(result.timedOut, false);
});
