import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadAuthzConfig,
  parseAuthzSection,
  resolveAuthBlob,
} from "../authz-config.mjs";
import {
  applyAuthzToToolCall,
  injectAuthDescribeBlob,
  injectDataAuth,
  isMetricAnalysisExecute,
  isMetricAnalysisPreview,
  isMetricAnalysisTotal,
  isMetricAnalysisValidate,
  isMetricDimValues,
  isMetricTagList,
  isMetricAuthDescribe,
  isMetricAuthzGatedCommand,
  rewriteMetricCliInvocation,
  stripAuthFlags,
} from "../authz-inject.mjs";
import { AuthzStateStore } from "../authz-store.mjs";
import { loadLumiHostAuth, lumiEnvelopePath } from "../lumi-envelope.mjs";
import qdmHarnessExtension from "../index.ts";

const SAMPLE_BLOB =
  "qdm1enc.OmZXt8XYEbbEetFidYc7ZTqAqdfxWB_pehdpWR5Y7M8ZmSuLr4kGyztvO6q5Galf";

function createProject(t, { authzYaml } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qdm-pi-authz-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(join(root, ".agents"), { recursive: true });
  mkdirSync(join(root, "wikis"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  if (authzYaml) {
    writeFileSync(join(root, "config", "harness-config.yaml"), authzYaml);
  }
  return root;
}

test("parseAuthzSection reads mode blob_file and dev_user_id", () => {
  const parsed = parseAuthzSection(`
paths:
  knowledge: wikis
authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
  allow_local_blob: true
`);
  assert.equal(parsed.mode, "on");
  assert.equal(parsed.blobFile, "config/dev-auth.blob");
  assert.equal(parsed.devUserId, "local-test-user");
  assert.equal(parsed.allowLocalBlob, true);
});

test("resolveAuthBlob prefers host over file; file used when no env (test stage)", (t) => {
  const root = createProject(t, {
    authzYaml: `authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
`,
  });
  writeFileSync(join(root, "config", "dev-auth.blob"), `${SAMPLE_BLOB}\n`);

  const config = loadAuthzConfig(root, {});
  assert.equal(config.mode, "on");
  assert.equal(config.devUserId, "local-test-user");

  const fromFile = resolveAuthBlob({ projectRoot: root, config, env: {} });
  assert.equal(fromFile.ok, true);
  assert.equal(fromFile.source, "file");
  assert.equal(fromFile.userId, "local-test-user");
  assert.equal(fromFile.blob, SAMPLE_BLOB);

  const fromHost = resolveAuthBlob({
    projectRoot: root,
    config,
    hostAuth: `${SAMPLE_BLOB}host`,
    hostUserId: "zhangsan",
    env: {},
  });
  assert.equal(fromHost.ok, true);
  assert.equal(fromHost.source, "host");
  assert.equal(fromHost.userId, "zhangsan");
  assert.equal(fromHost.blob, `${SAMPLE_BLOB}host`);

  const fromEnv = resolveAuthBlob({
    projectRoot: root,
    config,
    env: { HARNESS_AUTH_BLOB: `${SAMPLE_BLOB}env`, HARNESS_AUTH_USER_ID: "lisi" },
  });
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.source, "env");
  assert.equal(fromEnv.userId, "lisi");
});

test("resolveAuthBlob fails when blob_file has no user id", (t) => {
  const root = createProject(t, {
    authzYaml: `authz:
  mode: on
  blob_file: config/dev-auth.blob
`,
  });
  writeFileSync(join(root, "config", "dev-auth.blob"), `${SAMPLE_BLOB}\n`);
  const config = loadAuthzConfig(root, {});
  assert.equal(config.devUserId, "");
  const resolved = resolveAuthBlob({ projectRoot: root, config, env: {} });
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /dev_user_id/i);
});

test("AuthzStateStore isolates same session by userId", () => {
  const store = new AuthzStateStore();
  store.bind("S1", "user-a", `${SAMPLE_BLOB}a`, "file");
  store.bind("S1", "zhangsan", `${SAMPLE_BLOB}b`, "host");

  assert.equal(store.getBlob("S1", "user-a"), `${SAMPLE_BLOB}a`);
  assert.equal(store.getBlob("S1", "zhangsan"), `${SAMPLE_BLOB}b`);
  assert.equal(store.getCurrentTurn("S1")?.userId, "zhangsan");
  assert.equal(store.getCurrentTurn("S1")?.blob, `${SAMPLE_BLOB}b`);
});

test("isMetricAnalysisExecute and strip/inject auth flags", () => {
  assert.equal(
    isMetricAnalysisExecute("qdm-metric-cli analysis execute --metric saleAmt"),
    true,
  );
  assert.equal(
    isMetricAnalysisExecute(
      'source config/qdm-cli-paths.env && "$QDM_METRIC_CLI" analysis execute --metric x',
    ),
    true,
  );
  assert.equal(
    isMetricAnalysisExecute("./bin/qdm-metric-cli analysis execute --format json"),
    true,
  );
  // ${QDM_METRIC_CLI:-default} 语法覆盖
  assert.equal(
    isMetricAnalysisExecute("${QDM_METRIC_CLI:-qdm-metric-cli} analysis execute --metric x"),
    true,
  );
  assert.equal(
    isMetricAnalysisExecute('"${QDM_METRIC_CLI:-qdm-metric-cli}" analysis execute --metric x'),
    true,
  );
  assert.equal(isMetricAnalysisExecute("qdm-metric-cli metric list"), false);
  assert.equal(isMetricAnalysisExecute("echo hello"), false);
  assert.equal(isMetricAnalysisExecute("qdm-metric-cli auth describe"), false);

  // False positives: prose / commit messages / quoted docs must NOT match.
  assert.equal(
    isMetricAnalysisExecute(
      `git commit -m "support qdm-metric-cli analysis execute --data-auth --auth-blob '<加密blob>'"`,
    ),
    false,
  );
  assert.equal(
    isMetricAnalysisExecute(
      "git commit -m 'qdm-metric-cli analysis execute --data-auth --auth-blob qdm1enc.FAKE'",
    ),
    false,
  );
  assert.equal(
    isMetricAnalysisExecute('echo "qdm-metric-cli analysis execute --metric saleAmt"'),
    false,
  );
  assert.equal(
    isMetricAnalysisExecute(`git commit -m "$(cat <<'EOF'
support qdm-metric-cli analysis execute --data-auth --auth-blob <加密blob>
EOF
)"`),
    false,
  );

  const stripped = stripAuthFlags(
    "qdm-metric-cli analysis execute --data-auth --auth-blob 'qdm1enc.FAKE' --metric saleAmt",
  );
  assert.equal(stripped.includes("--data-auth"), false);
  assert.equal(stripped.includes("--auth-blob"), false);
  assert.match(stripped, /--metric saleAmt/);

  const metricPath = "/opt/bin/qdm-metric-cli";
  const injected = injectDataAuth(
    "qdm-metric-cli analysis execute --auth-blob 'qdm1enc.FAKE' --metric x",
    SAMPLE_BLOB,
    metricPath,
  );
  assert.match(injected, /--data-auth/);
  assert.match(injected, new RegExp(`--auth-blob '${SAMPLE_BLOB.replace(/\./g, "\\.")}'`));
  assert.doesNotMatch(injected, /qdm1enc\.FAKE/);
  assert.match(injected, /\/opt\/bin\/qdm-metric-cli/);

  const rewritten = rewriteMetricCliInvocation(
    'source config/qdm-cli-paths.env && "$QDM_METRIC_CLI" analysis execute --metric x',
    metricPath,
  );
  assert.match(rewritten, /\/opt\/bin\/qdm-metric-cli/);
  assert.doesNotMatch(rewritten, /\$QDM_METRIC_CLI/);

  // Flags must land on metric-cli argv, not after a pipe (common PI count pattern).
  const piped = injectDataAuth(
    'source config/qdm-cli-paths.env && "$QDM_METRIC_CLI" analysis execute --metric x --format json | python3 -c "print(1)"',
    SAMPLE_BLOB,
    metricPath,
  );
  assert.match(piped, /--data-auth --auth-blob/);
  assert.match(piped, /--auth-blob 'qdm1enc\.[^']+' \| python3/);
  assert.doesNotMatch(piped, /python3.*--data-auth/);
});

test("protected data command matching covers the frozen command set", () => {
  for (const [command, matcher] of [
    ["qdm-metric-cli analysis validate", isMetricAnalysisValidate],
    ["qdm-metric-cli analysis preview", isMetricAnalysisPreview],
    ["qdm-metric-cli analysis execute", isMetricAnalysisExecute],
    ["qdm-metric-cli analysis total", isMetricAnalysisTotal],
    ["qdm-metric-cli dim values", isMetricDimValues],
    ["qdm-metric-cli tag list", isMetricTagList],
    ["qdm-metric-cli auth describe", isMetricAuthDescribe],
  ]) {
    assert.equal(matcher(command), true, command);
  }
  const rewritten = injectDataAuth(
    "qdm-metric-cli analysis preview --auth-user-id model --auth-json fake --auth-blob model",
    SAMPLE_BLOB,
  );
  assert.match(rewritten, /--data-auth --auth-blob/);
  assert.match(rewritten, /auth-user-id model/);
  assert.doesNotMatch(rewritten, /auth-json|qdm1enc\.model/);
});

test("applyAuthzToToolCall gates every protected command", () => {
  for (const subcommand of [
    "analysis validate",
    "analysis preview",
    "analysis execute",
    "analysis total",
    "dim values",
    "tag list",
  ]) {
    const event = { toolName: "bash", input: { command: `qdm-metric-cli ${subcommand} --auth-user-id model` } };
    const result = applyAuthzToToolCall(event, { mode: "on", blob: SAMPLE_BLOB });
    assert.equal(result, undefined, subcommand);
    assert.match(event.input.command, /--data-auth --auth-blob/);
    assert.match(event.input.command, /auth-user-id model/);
  }

  const describe = { toolName: "bash", input: { command: "qdm-metric-cli auth describe --auth-user-id model" } };
  assert.equal(applyAuthzToToolCall(describe, { mode: "on", blob: SAMPLE_BLOB }), undefined);
  assert.match(describe.input.command, /--auth-blob/);
  assert.doesNotMatch(describe.input.command, /data-auth/);
  assert.match(describe.input.command, /auth-user-id model/);

  for (const subcommand of ["analysis validate", "analysis preview", "analysis execute", "analysis total", "dim values", "tag list"]) {
    const event = { toolName: "bash", input: { command: `qdm-metric-cli ${subcommand}` } };
    assert.equal(applyAuthzToToolCall(event, { mode: "on", blob: null })?.block, true, subcommand);
  }
});

test("isMetricAuthDescribe and injectAuthDescribeBlob", () => {
  assert.equal(isMetricAuthDescribe("qdm-metric-cli auth describe"), true);
  assert.equal(
    isMetricAuthDescribe(
      'source config/qdm-cli-paths.env && "$QDM_METRIC_CLI" auth describe --resolve-labels=false',
    ),
    true,
  );
  assert.equal(isMetricAuthDescribe("./bin/qdm-metric-cli auth describe"), true);
  // ${QDM_METRIC_CLI:-default} 语法覆盖
  assert.equal(
    isMetricAuthDescribe("${QDM_METRIC_CLI:-qdm-metric-cli} auth describe"),
    true,
  );
  assert.equal(
    isMetricAuthDescribe('"${QDM_METRIC_CLI:-qdm-metric-cli}" auth describe'),
    true,
  );
  assert.equal(
    isMetricAuthDescribe('"${QDM_METRIC_CLI:-/workspace/bin/qdm-metric-cli}" auth describe'),
    true,
  );
  // 两行赋值 + 变量引用（确保不回归）
  assert.equal(
    isMetricAuthDescribe(
      'QDM_METRIC_CLI="${QDM_METRIC_CLI:-qdm-metric-cli}"\n"$QDM_METRIC_CLI" auth describe',
    ),
    true,
  );
  assert.equal(isMetricAuthDescribe("qdm-metric-cli analysis execute --metric x"), false);
  assert.equal(isMetricAuthDescribe("qdm-metric-cli metric list"), false);
  assert.equal(
    isMetricAuthDescribe('echo "qdm-metric-cli auth describe --auth-blob x"'),
    false,
  );
  assert.equal(
    isMetricAuthDescribe(
      `git commit -m "support qdm-metric-cli auth describe --auth-blob '<加密blob>'"`,
    ),
    false,
  );

  assert.equal(isMetricAuthzGatedCommand("qdm-metric-cli auth describe"), true);
  assert.equal(isMetricAuthzGatedCommand("qdm-metric-cli analysis execute --metric x"), true);
  assert.equal(isMetricAuthzGatedCommand("qdm-metric-cli metric list"), false);

  const metricPath = "/opt/bin/qdm-metric-cli";
  const injected = injectAuthDescribeBlob(
    "qdm-metric-cli auth describe --auth-blob 'qdm1enc.FAKE' --resolve-labels=false",
    SAMPLE_BLOB,
    metricPath,
  );
  assert.doesNotMatch(injected, /--data-auth/);
  assert.match(injected, new RegExp(`--auth-blob '${SAMPLE_BLOB.replace(/\./g, "\\.")}'`));
  assert.doesNotMatch(injected, /qdm1enc\.FAKE/);
  assert.match(injected, /\/opt\/bin\/qdm-metric-cli/);
  assert.match(injected, /--resolve-labels=false/);

  const rewritten = rewriteMetricCliInvocation(
    'source config/qdm-cli-paths.env && "$QDM_METRIC_CLI" auth describe',
    metricPath,
  );
  assert.match(rewritten, /\/opt\/bin\/qdm-metric-cli/);
  assert.doesNotMatch(rewritten, /\$QDM_METRIC_CLI/);
});

test("applyAuthzToToolCall refuses model-supplied blob when unbound and allowLocalBlob false", () => {
  const event = {
    toolName: "bash",
    input: {
      command:
        'qdm-metric-cli auth describe --auth-blob "$(cat config/dev-auth.blob)"',
    },
  };
  const result = applyAuthzToToolCall(event, {
    mode: "on",
    blob: null,
    allowLocalBlob: false,
  });
  assert.equal(result?.block, true);
  assert.match(result.reason, /refusing model-supplied/i);
  // Command must not be rewritten into a runnable form with fixture blob.
  assert.match(event.input.command, /cat config\/dev-auth\.blob/);
});

test("applyAuthzToToolCall injects auth describe without data-auth", () => {
  const blocked = {
    toolName: "bash",
    input: { command: "qdm-metric-cli auth describe" },
  };
  const blockResult = applyAuthzToToolCall(blocked, { mode: "on", blob: null });
  assert.equal(blockResult?.block, true);
  assert.match(blockResult.reason, /auth describe/i);

  const event = {
    toolName: "Bash",
    input: {
      command: "qdm-metric-cli auth describe --auth-blob 'qdm1enc.FAKE'",
    },
  };
  const ok = applyAuthzToToolCall(event, {
    mode: "on",
    blob: SAMPLE_BLOB,
    metricCliPath: "/opt/bin/qdm-metric-cli",
  });
  assert.equal(ok, undefined);
  assert.doesNotMatch(event.input.command, /--data-auth/);
  assert.match(event.input.command, new RegExp(SAMPLE_BLOB.replace(/\./g, "\\.")));
  assert.doesNotMatch(event.input.command, /qdm1enc\.FAKE/);
  assert.match(event.input.command, /\/opt\/bin\/qdm-metric-cli/);

  const offEvent = {
    toolName: "bash",
    input: { command: "qdm-metric-cli auth describe" },
  };
  assert.equal(applyAuthzToToolCall(offEvent, { mode: "off", blob: SAMPLE_BLOB }), undefined);
  assert.equal(offEvent.input.command, "qdm-metric-cli auth describe");
});

test("applyAuthzToToolCall does not rewrite git commit messages", () => {
  const original = `git commit -m "feat: qdm-metric-cli analysis execute --data-auth --auth-blob '<加密blob>'"`;
  const event = {
    toolName: "bash",
    input: { command: original },
  };
  const result = applyAuthzToToolCall(event, {
    mode: "on",
    blob: SAMPLE_BLOB,
    metricCliPath: "/opt/bin/qdm-metric-cli",
  });
  assert.equal(result, undefined);
  assert.equal(event.input.command, original);

  const offEvent = {
    toolName: "bash",
    input: { command: original },
  };
  applyAuthzToToolCall(offEvent, {
    mode: "off",
    blob: SAMPLE_BLOB,
    metricCliPath: "/opt/bin/qdm-metric-cli",
  });
  assert.equal(offEvent.input.command, original);
});

test("applyAuthzToToolCall blocks without blob and injects with blob", () => {
  const blocked = {
    toolName: "bash",
    input: { command: "qdm-metric-cli analysis execute --metric saleAmt" },
  };
  const blockResult = applyAuthzToToolCall(blocked, { mode: "on", blob: null });
  assert.equal(blockResult?.block, true);

  const event = {
    toolName: "Bash",
    input: {
      command: "qdm-metric-cli analysis execute --auth-blob 'qdm1enc.FAKE' --metric saleAmt",
    },
  };
  const ok = applyAuthzToToolCall(event, { mode: "on", blob: SAMPLE_BLOB });
  assert.equal(ok, undefined);
  assert.match(event.input.command, /--data-auth/);
  assert.match(event.input.command, new RegExp(SAMPLE_BLOB.replace(/\./g, "\\.")));
  assert.doesNotMatch(event.input.command, /qdm1enc\.FAKE/);

  const offEvent = {
    toolName: "bash",
    input: { command: "qdm-metric-cli analysis execute --metric saleAmt" },
  };
  assert.equal(applyAuthzToToolCall(offEvent, { mode: "off", blob: SAMPLE_BLOB }), undefined);
  assert.equal(offEvent.input.command, "qdm-metric-cli analysis execute --metric saleAmt");
});

test("extension tool_call injects from local blob_file when authz on", (t) => {
  const root = createProject(t, {
    authzYaml: `paths:
  knowledge: wikis
authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
  allow_local_blob: true
`,
  });
  writeFileSync(join(root, "config", "dev-auth.blob"), `${SAMPLE_BLOB}\n`);
  const cli = join(root, "bin", "data-harness-cli");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "# ctx"
    }
  }));
});
`,
  );
  chmodSync(cli, 0o755);

  const handlers = new Map();
  qdmHarnessExtension({
    cwd: root,
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "sess-1" },
    ui: { notify() {}, setStatus() {} },
  };

  // Bind via context (reads local file; no env in test stage).
  return handlers
    .get("context")(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "销售额？" }], timestamp: 1 },
        ],
      },
      ctx,
    )
    .then(() => {
      const event = {
        toolName: "bash",
        input: {
          command: "qdm-metric-cli analysis execute --metric saleAmt --start-date 2026-07-01",
        },
      };
      const result = handlers.get("tool_call")(event, ctx);
      assert.equal(result, undefined);
      assert.match(event.input.command, /--data-auth/);
      assert.match(event.input.command, new RegExp(SAMPLE_BLOB.replace(/\./g, "\\.")));
    });
});

test("extension tool_call blocks analysis execute when authz on and unbound", (t) => {
  const root = createProject(t, {
    authzYaml: `authz:
  mode: on
  allow_local_blob: true
`,
  });
  // No blob_file and no env → unbound.

  const handlers = new Map();
  qdmHarnessExtension({
    cwd: root,
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "sess-2" },
    ui: { notify() {}, setStatus() {} },
  };

  const event = {
    toolName: "bash",
    input: { command: "qdm-metric-cli analysis execute --metric saleAmt" },
  };
  const result = handlers.get("tool_call")(event, ctx);
  assert.equal(result?.block, true);
  assert.match(result.reason, /no encrypted auth blob/i);
});

// --- Lumi envelope (Host path scheme A) ---

const ENVELOPE_BLOB = `${SAMPLE_BLOB}envelope`;
const ENVELOPE_SESSION = "sess";
/** Lumi Go sha256("sess") lowercase hex — must stay in sync with producer. */
const ENVELOPE_SESS_HEX =
  "bd717b467075e051242456dd00511c90a39afc62b1da71a80714c0fb3986cb4d";

/**
 * @param {string} dir
 * @param {object} overrides
 */
function writeEnvelope(dir, overrides = {}) {
  const sessionId = overrides.sessionId ?? ENVELOPE_SESSION;
  const path =
    overrides.path ??
    lumiEnvelopePath(dir, sessionId) ??
    join(dir, `${ENVELOPE_SESS_HEX}.json`);
  const body = {
    version: 1,
    workspaceId: "ws",
    agentId: "agent",
    sessionId,
    issuedAt: "2026-08-05T12:00:00Z",
    expiresAt: "2099-08-05T12:30:00Z",
    _auth: ENVELOPE_BLOB,
    _auth_user_id: "pengmingde01",
    ...overrides.fields,
  };
  // Allow overriding top-level via fields; re-apply sessionId if fields overwrote path key only.
  if (overrides.fields?.sessionId !== undefined) {
    body.sessionId = overrides.fields.sessionId;
  }
  writeFileSync(path, `${JSON.stringify(body)}\n`);
  return path;
}

test("lumiEnvelopePath matches Lumi Go sha256 hex for sess", () => {
  const path = lumiEnvelopePath("/tmp/ctx", "sess");
  assert.equal(path, join("/tmp/ctx", `${ENVELOPE_SESS_HEX}.json`));
  assert.equal(lumiEnvelopePath("", "sess"), null);
  assert.equal(lumiEnvelopePath("/tmp", ""), null);
});

test("loadLumiHostAuth soft-fails without env or file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qdm-lumi-env-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));

  const noDir = loadLumiHostAuth({ env: {}, sessionId: "sess" });
  assert.equal(noDir.ok, false);
  assert.equal(noDir.soft, true);

  const noFile = loadLumiHostAuth({
    env: { LUMI_REQUESTER_CONTEXT_DIR: dir },
    sessionId: "sess",
  });
  assert.equal(noFile.ok, false);
  assert.equal(noFile.soft, true);
  assert.match(noFile.error, /not found/i);
});

test("loadLumiHostAuth accepts valid envelope; rejects mismatch/expired/bad blob", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qdm-lumi-env-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));

  writeEnvelope(dir);
  const ok = loadLumiHostAuth({
    env: { LUMI_REQUESTER_CONTEXT_DIR: dir },
    sessionId: ENVELOPE_SESSION,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.source, "lumi_envelope");
  assert.equal(ok.blob, ENVELOPE_BLOB);
  assert.equal(ok.userId, "pengmingde01");

  // sessionId mismatch (file is for "sess", query another id)
  const otherPath = lumiEnvelopePath(dir, "other-sess");
  writeFileSync(
    otherPath,
    JSON.stringify({
      version: 1,
      sessionId: "wrong-id",
      expiresAt: "2099-01-01T00:00:00Z",
      _auth: ENVELOPE_BLOB,
      _auth_user_id: "u1",
    }),
  );
  const mismatch = loadLumiHostAuth({
    env: { LUMI_REQUESTER_CONTEXT_DIR: dir },
    sessionId: "other-sess",
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.soft, true);
  assert.match(mismatch.error, /sessionId mismatch/i);

  writeEnvelope(dir, {
    sessionId: "expired-sess",
    fields: { expiresAt: "2020-01-01T00:00:00Z" },
  });
  const expired = loadLumiHostAuth({
    env: { LUMI_REQUESTER_CONTEXT_DIR: dir },
    sessionId: "expired-sess",
    now: Date.parse("2026-08-05T12:00:00Z"),
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.soft, true);
  assert.match(expired.error, /expired/i);

  writeEnvelope(dir, {
    sessionId: "bad-blob-sess",
    fields: { _auth: "plaintext-not-encrypted" },
  });
  const badBlob = loadLumiHostAuth({
    env: { LUMI_REQUESTER_CONTEXT_DIR: dir },
    sessionId: "bad-blob-sess",
  });
  assert.equal(badBlob.ok, false);
  assert.equal(badBlob.soft, false);
  assert.match(badBlob.error, /_auth/i);
});

test("resolveAuthBlob priority: host > envelope > env > file; allowLocalBlob gates local only", (t) => {
  const root = createProject(t, {
    authzYaml: `authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
  allow_local_blob: true
`,
  });
  writeFileSync(join(root, "config", "dev-auth.blob"), `${SAMPLE_BLOB}\n`);

  const envelopeDir = mkdtempSync(join(tmpdir(), "qdm-lumi-prio-"));
  t.after(() => rmSync(envelopeDir, { force: true, recursive: true }));
  writeEnvelope(envelopeDir);

  const config = loadAuthzConfig(root, {});
  const envBase = {
    LUMI_REQUESTER_CONTEXT_DIR: envelopeDir,
    HARNESS_AUTH_BLOB: `${SAMPLE_BLOB}env`,
    HARNESS_AUTH_USER_ID: "lisi",
  };

  const fromHost = resolveAuthBlob({
    projectRoot: root,
    config,
    hostAuth: `${SAMPLE_BLOB}host`,
    hostUserId: "zhangsan",
    sessionId: ENVELOPE_SESSION,
    env: envBase,
  });
  assert.equal(fromHost.ok, true);
  assert.equal(fromHost.source, "host");
  assert.equal(fromHost.userId, "zhangsan");

  const fromEnvelope = resolveAuthBlob({
    projectRoot: root,
    config,
    sessionId: ENVELOPE_SESSION,
    env: envBase,
  });
  assert.equal(fromEnvelope.ok, true);
  assert.equal(fromEnvelope.source, "lumi_envelope");
  assert.equal(fromEnvelope.blob, ENVELOPE_BLOB);
  assert.equal(fromEnvelope.userId, "pengmingde01");

  const fromEnv = resolveAuthBlob({
    projectRoot: root,
    config,
    sessionId: "no-such-session",
    env: {
      HARNESS_AUTH_BLOB: `${SAMPLE_BLOB}env`,
      HARNESS_AUTH_USER_ID: "lisi",
      LUMI_REQUESTER_CONTEXT_DIR: envelopeDir,
    },
  });
  assert.equal(fromEnv.ok, true);
  assert.equal(fromEnv.source, "env");

  // allow_local_blob: false — envelope still works; pure file fails
  const lockedRoot = createProject(t, {
    authzYaml: `authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
  allow_local_blob: false
`,
  });
  writeFileSync(join(lockedRoot, "config", "dev-auth.blob"), `${SAMPLE_BLOB}\n`);
  const locked = loadAuthzConfig(lockedRoot, {});

  const envelopeOk = resolveAuthBlob({
    projectRoot: lockedRoot,
    config: locked,
    sessionId: ENVELOPE_SESSION,
    env: { LUMI_REQUESTER_CONTEXT_DIR: envelopeDir },
  });
  assert.equal(envelopeOk.ok, true);
  assert.equal(envelopeOk.source, "lumi_envelope");

  const fileBlocked = resolveAuthBlob({
    projectRoot: lockedRoot,
    config: locked,
    sessionId: null,
    env: {},
  });
  assert.equal(fileBlocked.ok, false);
  assert.match(fileBlocked.error, /local blob fallback disabled/i);

  const envBlocked = resolveAuthBlob({
    projectRoot: lockedRoot,
    config: locked,
    sessionId: null,
    env: { HARNESS_AUTH_BLOB: `${SAMPLE_BLOB}env`, HARNESS_AUTH_USER_ID: "lisi" },
  });
  assert.equal(envBlocked.ok, false);

  // Hard fail on bad envelope blob does not fall through to local file
  writeEnvelope(envelopeDir, {
    sessionId: "hard-fail-sess",
    fields: { _auth: "not-encrypted" },
  });
  const hardFail = resolveAuthBlob({
    projectRoot: root,
    config,
    sessionId: "hard-fail-sess",
    env: { LUMI_REQUESTER_CONTEXT_DIR: envelopeDir },
  });
  assert.equal(hardFail.ok, false);
  assert.match(hardFail.error, /_auth/i);
});

test("extension tool_call injects from Lumi envelope when allow_local_blob false", (t) => {
  const root = createProject(t, {
    authzYaml: `paths:
  knowledge: wikis
authz:
  mode: on
  allow_local_blob: false
`,
  });
  const envelopeDir = mkdtempSync(join(tmpdir(), "qdm-lumi-ext-"));
  t.after(() => rmSync(envelopeDir, { force: true, recursive: true }));
  writeEnvelope(envelopeDir, { sessionId: "sess-envelope" });

  const cli = join(root, "bin", "data-harness-cli");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "# ctx"
    }
  }));
});
`,
  );
  chmodSync(cli, 0o755);

  const prevDir = process.env.LUMI_REQUESTER_CONTEXT_DIR;
  process.env.LUMI_REQUESTER_CONTEXT_DIR = envelopeDir;
  t.after(() => {
    if (prevDir === undefined) delete process.env.LUMI_REQUESTER_CONTEXT_DIR;
    else process.env.LUMI_REQUESTER_CONTEXT_DIR = prevDir;
  });

  const handlers = new Map();
  qdmHarnessExtension({
    cwd: root,
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "sess-envelope" },
    ui: { notify() {}, setStatus() {} },
  };

  return handlers
    .get("context")(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "销售额？" }], timestamp: 1 },
        ],
        // no _auth on event — Host path is envelope only
      },
      ctx,
    )
    .then(() => {
      const event = {
        toolName: "bash",
        input: {
          command: "qdm-metric-cli analysis execute --metric saleAmt --start-date 2026-07-01",
        },
      };
      const result = handlers.get("tool_call")(event, ctx);
      assert.equal(result, undefined);
      assert.match(event.input.command, /--data-auth/);
      assert.match(event.input.command, new RegExp(ENVELOPE_BLOB.replace(/\./g, "\\.")));
    });
});

test("extension tool_call re-binds Lumi envelope without prior context event", (t) => {
  const root = createProject(t, {
    authzYaml: `authz:
  mode: on
  allow_local_blob: false
`,
  });
  const envelopeDir = mkdtempSync(join(tmpdir(), "qdm-lumi-rebind-"));
  t.after(() => rmSync(envelopeDir, { force: true, recursive: true }));
  writeEnvelope(envelopeDir, { sessionId: "sess-rebind" });

  const prevDir = process.env.LUMI_REQUESTER_CONTEXT_DIR;
  process.env.LUMI_REQUESTER_CONTEXT_DIR = envelopeDir;
  t.after(() => {
    if (prevDir === undefined) delete process.env.LUMI_REQUESTER_CONTEXT_DIR;
    else process.env.LUMI_REQUESTER_CONTEXT_DIR = prevDir;
  });

  const handlers = new Map();
  qdmHarnessExtension({
    cwd: root,
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "sess-rebind" },
    ui: { notify() {}, setStatus() {} },
  };

  // Skip context bind — only tool_call path should resolve envelope.
  const event = {
    toolName: "bash",
    input: {
      command:
        'qdm-metric-cli auth describe --auth-blob "$(cat config/dev-auth.blob)"',
    },
  };
  const result = handlers.get("tool_call")(event, ctx);
  assert.equal(result, undefined);
  assert.match(event.input.command, /--auth-blob/);
  assert.match(event.input.command, new RegExp(ENVELOPE_BLOB.replace(/\./g, "\\.")));
  assert.doesNotMatch(event.input.command, /dev-auth\.blob/);
  assert.doesNotMatch(event.input.command, /--data-auth/);
});

test("extension tool_call blocks model cat fixture when unbound and allow_local_blob false", (t) => {
  const root = createProject(t, {
    authzYaml: `authz:
  mode: on
  allow_local_blob: false
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
`,
  });
  // Fixture on disk must not be used when allow_local_blob is false.
  writeFileSync(join(root, "config", "dev-auth.blob"), `${SAMPLE_BLOB}\n`);

  const handlers = new Map();
  qdmHarnessExtension({
    cwd: root,
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "sess-no-host" },
    ui: { notify() {}, setStatus() {} },
  };

  const event = {
    toolName: "bash",
    input: {
      command:
        'qdm-metric-cli auth describe --auth-blob "$(cat config/dev-auth.blob)"',
    },
  };
  const result = handlers.get("tool_call")(event, ctx);
  assert.equal(result?.block, true);
  assert.match(result.reason, /host blob not bound|refusing/i);
  // Still the original command (blocked, not executed with fixture).
  assert.match(event.input.command, /dev-auth\.blob/);
});
