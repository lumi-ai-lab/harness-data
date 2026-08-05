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
  injectDataAuth,
  isMetricAnalysisExecute,
  rewriteMetricCliInvocation,
  stripAuthFlags,
} from "../authz-inject.mjs";
import { AuthzStateStore } from "../authz-store.mjs";
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
  assert.equal(isMetricAnalysisExecute("qdm-metric-cli metric list"), false);
  assert.equal(isMetricAnalysisExecute("echo hello"), false);

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
