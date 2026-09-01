import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../src/main.js";
import { runClaudeHook } from "../src/lib/context/hook.js";
import {
  ROOT_CONTEXT_ERROR_CODES,
  contextFromHookPayload,
  normalizeRootContext,
  parseRootContextArgs,
  resolveRootContext,
  workspaceIdentity,
} from "../src/lib/root-context.js";
import { load as loadState, safeSessionId, save as saveState, statePath } from "../src/lib/sessionstate.js";

const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/root-context-cases.json", import.meta.url), "utf8"));

function makeRoots() {
  const base = mkdtempSync(path.join(tmpdir(), "qdm-root-context-"));
  const roots = {
    base,
    pluginRoot: path.join(base, "plugin"),
    dataRoot: path.join(base, "data"),
    secretRoot: path.join(base, "secrets"),
    workspaceRoot: path.join(base, "workspace"),
  };
  for (const dir of Object.values(roots).filter((value) => value !== base)) mkdirSync(dir, { recursive: true });
  roots.configPath = path.join(roots.dataRoot, "config", "settings.json");
  roots.workspacePolicyPath = path.join(roots.pluginRoot, "config", "workspace-policy.json");
  roots.secretPath = path.join(roots.secretRoot, "profiles", "default", "auth.blob");
  mkdirSync(path.dirname(roots.configPath), { recursive: true });
  mkdirSync(path.dirname(roots.workspacePolicyPath), { recursive: true });
  mkdirSync(path.dirname(roots.secretPath), { recursive: true });
  writeFileSync(roots.configPath, "{}\n");
  writeFileSync(roots.workspacePolicyPath, `${JSON.stringify({
    schemaVersion: 1,
    mode: "allowlist",
    includeChildren: true,
    roots: [roots.workspaceRoot],
  })}\n`);
  writeFileSync(roots.secretPath, "qdm1enc.fixture\n", { mode: 0o600 });
  return roots;
}

function fixtureContext(roots) {
  return materialize(fixture.valid, {
    PLUGIN_ROOT: roots.pluginRoot,
    DATA_ROOT: roots.dataRoot,
    SECRET_ROOT: roots.secretRoot,
    WORKSPACE_ROOT: roots.workspaceRoot,
    CONFIG_PATH: roots.configPath,
    WORKSPACE_POLICY_PATH: roots.workspacePolicyPath,
    SECRET_PATH: roots.secretPath,
  });
}

function materialize(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => materialize(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, replacements)]));
  }
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z_]+)\}/g, (_, key) => replacements[key]);
}

function memoryIO(env = {}) {
  const chunks = [];
  return {
    io: {
      env,
      stdin: Buffer.alloc(0),
      stdout: { write(value) { chunks.push(String(value)); } },
      stderr: { write() {} },
    },
    output() { return chunks.join(""); },
  };
}

function extractTrustedContextFilePaths(additionalContext) {
  const match = String(additionalContext || "").match(/必须先读取以下 contextFiles[^\n]*：\n([\s\S]*?)\n\nInstruction:/);
  if (!match) return [];
  return [...match[1].matchAll(/^- `([^`]+)`/gm)].map((entry) => entry[1]);
}

function writeRuntimeResourceManifest(root, runtimeIndex) {
  const runtimeIndexPath = path.join(root, ".harness", "index", "wikis-runtime-index.json");
  const resourceVersion = String(runtimeIndex.meta.wikiContentVersion || runtimeIndex.meta.resourceVersion || "");
  const sha256 = createHash("sha256").update(readFileSync(runtimeIndexPath)).digest("hex");
  writeFileSync(path.join(root, "resource-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    resourceSchemaVersion: 1,
    resourceId: "qdm-harness-wiki",
    wikiContentVersion: resourceVersion,
    files: [{ path: ".harness/index/wikis-runtime-index.json", sha256, kind: "index" }],
  }, null, 2)}\n`);
}

test("RootContext v1 normalizes the shared fixture and derives a workspace state root", () => {
  const roots = makeRoots();
  const context = normalizeRootContext(fixtureContext(roots));
  assert.equal(context.schemaVersion, fixture.schemaVersion);
  assert.equal(context.pluginRoot, realpathSync(roots.pluginRoot));
  assert.equal(context.resourceRoot, realpathSync(roots.dataRoot));
  assert.equal(context.dataRoot, realpathSync(roots.dataRoot));
  assert.equal(context.workspaceRoot, realpathSync(roots.workspaceRoot));
  assert.equal(context.secretRef.path, realpathSync(roots.secretPath));
  assert.equal(context.stateRoot, path.join(context.dataRoot, "state", "workspaces", workspaceIdentity(context)));
  assert.deepEqual(context.capabilities, fixture.valid.capabilities);
});

test("RootContext canonicalizes symlinked roots and rejects overlapping primary roots", () => {
  const roots = makeRoots();
  const pluginLink = path.join(roots.base, "plugin-link");
  symlinkSync(roots.pluginRoot, pluginLink, "dir");
  const input = fixtureContext(roots);
  input.pluginRoot = pluginLink;
  assert.equal(normalizeRootContext(input).pluginRoot, realpathSync(roots.pluginRoot));

  input.pluginRoot = roots.pluginRoot;
  input.dataRoot = roots.pluginRoot;
  assert.throws(
    () => normalizeRootContext(input),
    (error) => error?.code === fixture.errorCodes.invalid && /overlap/.test(error.message),
  );
});

test("RootContext reports stable codes for missing plugin and workspace requirements", () => {
  const roots = makeRoots();
  const input = fixtureContext(roots);
  input.pluginRoot = path.join(roots.base, "missing-plugin");
  assert.throws(
    () => normalizeRootContext(input),
    (error) => error?.code === ROOT_CONTEXT_ERROR_CODES.PLUGIN_ROOT_UNAVAILABLE,
  );

  input.pluginRoot = roots.pluginRoot;
  delete input.workspaceRoot;
  assert.throws(
    () => normalizeRootContext(input, { requireWorkspace: true }),
    (error) => error?.code === ROOT_CONTEXT_ERROR_CODES.WORKSPACE_REQUIRED,
  );
});

test("RootContext precedence is explicit CLI values, then file, then environment", () => {
  const roots = makeRoots();
  const fromFile = fixtureContext(roots);
  const file = path.join(roots.base, "context.json");
  writeFileSync(file, `${JSON.stringify(fromFile)}\n`);
  const explicitDataRoot = path.join(roots.base, "explicit-data");
  mkdirSync(explicitDataRoot);
  const envDataRoot = path.join(roots.base, "env-data");
  const envPluginRoot = path.join(roots.base, "env-plugin");
  mkdirSync(envDataRoot);
  mkdirSync(envPluginRoot);

  const context = resolveRootContext({
    contextFile: file,
    explicit: { dataRoot: explicitDataRoot, sessionId: "explicit-session" },
    env: { HARNESS_PLUGIN_ROOT: envPluginRoot, HARNESS_DATA_ROOT: envDataRoot, HARNESS_HOST: "env" },
  });
  assert.equal(context.pluginRoot, realpathSync(roots.pluginRoot));
  assert.equal(context.dataRoot, realpathSync(explicitDataRoot));
  assert.equal(context.host, "codex");
  assert.equal(context.sessionId, "explicit-session");
});

test("global Root Context flags are removed from command args and support --context-file", () => {
  const parsed = parseRootContextArgs([
    "--context-file", "/tmp/context.json",
    "paths",
    "--session-id=override",
    "--json",
  ]);
  assert.equal(parsed.command, "paths");
  assert.equal(parsed.contextFile, "/tmp/context.json");
  assert.equal(parsed.fields.sessionId, "override");
  assert.deepEqual(parsed.commandArgs, ["--json"]);
});

test("CLI paths emits normalized context and fails closed when structured context is incomplete", async () => {
  const roots = makeRoots();
  const file = path.join(roots.base, "context.json");
  writeFileSync(file, `${JSON.stringify(fixtureContext(roots))}\n`);
  const result = memoryIO();
  await run(["--context-file", file, "paths", "--session-id", "cli-session", "--json"], result.io);
  const output = JSON.parse(result.output());
  assert.equal(output.pluginRoot, realpathSync(roots.pluginRoot));
  assert.equal(output.sessionId, "cli-session");

  await assert.rejects(
    run(["paths", "--plugin-root", roots.pluginRoot], memoryIO().io),
    /QDM_DATA_ROOT_UNAVAILABLE: dataRoot is required/,
  );
});

test("structured session state is written below stateRoot, not pluginRoot or workspaceRoot", () => {
  const roots = makeRoots();
  const context = normalizeRootContext(fixtureContext(roots));
  saveState(context, "session-01", { reports: {} });
  const expected = statePath(context, "session-01");
  assert.equal(expected.startsWith(context.stateRoot), true);
  assert.equal(expected.startsWith(context.pluginRoot), false);
  assert.equal(expected.startsWith(context.workspaceRoot), false);
  const state = loadState(context, "session-01");
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.session_id, "session-01");
});

test("structured session state uses a lock and recovers stale locks", () => {
  const roots = makeRoots();
  const context = normalizeRootContext(fixtureContext(roots));
  const sessionId = "locked-session";
  const lockPath = path.join(path.dirname(statePath(context, sessionId)), `${safeSessionId(sessionId)}.lock`);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, "active\n");
  assert.throws(() => saveState(context, sessionId, { reports: {} }), (error) => error?.code === "QDM_STATE_LOCKED");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  saveState(context, sessionId, { reports: {} });
  assert.equal(existsSync(lockPath), false);
});

test("structured prompt hooks auto-inject project context and do not persist ordinary prompts", () => {
  const roots = makeRoots();
  mkdirSync(path.join(roots.dataRoot, ".harness", "index"), { recursive: true });
  const runtimeIndex = {
    meta: {
      resourceId: "qdm-harness-wiki",
      resourceSchemaVersion: 1,
      wikiContentVersion: createHash("sha256").update("auto-context-fixture").digest("hex"),
      resourceVersion: createHash("sha256").update("auto-context-fixture").digest("hex"),
      paths: { knowledge: ".", spec: "spec", playbooks: "playbooks", templates: "templates" },
    },
    docsByPath: {},
    recall: [],
    templateSelection: [],
  };
  writeFileSync(path.join(roots.dataRoot, ".harness", "index", "wikis-index.json"), `${JSON.stringify(runtimeIndex)}\n`);
  writeFileSync(path.join(roots.dataRoot, ".harness", "index", "wikis-runtime-index.json"), `${JSON.stringify(runtimeIndex)}\n`);
  writeRuntimeResourceManifest(roots.dataRoot, runtimeIndex);
  const context = normalizeRootContext(fixtureContext(roots));
  const previousMode = process.env.QDM_HARNESS_HOOK_MODE;
  try {
    delete process.env.QDM_HARNESS_HOOK_MODE;
    const ordinary = runClaudeHook(
      context.pluginRoot,
      JSON.stringify({ session_id: "auto-context-session", prompt: "请帮我写一个 JavaScript 函数" }),
      context,
    );
    assert.equal(ordinary.ok, true);
    assert.match(ordinary.output.hookSpecificOutput.additionalContext, /Harness mode: free/);
    assert.equal(existsSync(statePath(context, "auto-context-session")), false);

    process.env.QDM_HARNESS_HOOK_MODE = "on-demand";
    const optedOut = runClaudeHook(
      context.pluginRoot,
      JSON.stringify({ session_id: "on-demand-session", prompt: "请帮我写一个 JavaScript 函数" }),
      context,
    );
    assert.equal(optedOut.ok, false);
    assert.equal(existsSync(statePath(context, "on-demand-session")), false);
  } finally {
    if (previousMode == null) delete process.env.QDM_HARNESS_HOOK_MODE;
    else process.env.QDM_HARNESS_HOOK_MODE = previousMode;
  }
});

test("Codex structured prompt hooks materialize trusted resource paths", () => {
  const roots = makeRoots();
  mkdirSync(path.join(roots.dataRoot, "config"), { recursive: true });
  writeFileSync(path.join(roots.dataRoot, "config", "harness-config.yaml"), "paths:\n  knowledge: .\n");
  const trustedPlaybook = path.join(roots.dataRoot, "metrics", "销售额", "playbook.md");
  mkdirSync(path.dirname(trustedPlaybook), { recursive: true });
  writeFileSync(path.join(roots.dataRoot, "metrics", "销售额", "spec.md"), "# 销售额指标说明\n");
  writeFileSync(trustedPlaybook, "# 可信销售额取数手册\n");
  const workspaceShadow = path.join(roots.workspaceRoot, "metrics", "销售额", "playbook.md");
  mkdirSync(path.dirname(workspaceShadow), { recursive: true });
  writeFileSync(workspaceShadow, "# 工作区同名伪文件\n");
  mkdirSync(path.join(roots.dataRoot, ".harness", "index"), { recursive: true });
  const runtimeIndex = {
    meta: {
      resourceId: "qdm-harness-wiki",
      resourceSchemaVersion: 1,
      wikiContentVersion: createHash("sha256").update("codex-sales-playbook").digest("hex"),
      resourceVersion: createHash("sha256").update("codex-sales-playbook").digest("hex"),
      paths: { knowledge: ".", spec: "spec", playbooks: "playbooks", templates: "templates" },
    },
    docsByPath: {
      "metrics/销售额/spec.md": { path: "metrics/销售额/spec.md", kind: "spec", specType: "metric" },
      "metrics/销售额/playbook.md": { path: "metrics/销售额/playbook.md", kind: "playbook" },
    },
    recall: [{ term: "销售额", targetPath: "metrics/销售额/spec.md" }],
    templateSelection: [],
  };
  writeFileSync(path.join(roots.dataRoot, ".harness", "index", "wikis-index.json"), `${JSON.stringify(runtimeIndex)}\n`);
  writeFileSync(path.join(roots.dataRoot, ".harness", "index", "wikis-runtime-index.json"), `${JSON.stringify(runtimeIndex)}\n`);
  writeRuntimeResourceManifest(roots.dataRoot, runtimeIndex);
  const context = normalizeRootContext(fixtureContext(roots));
  const result = runClaudeHook(
    context.pluginRoot,
    JSON.stringify({ session_id: "codex-sales-session", cwd: roots.workspaceRoot, prompt: "查看昨天的销售额" }),
    context,
  );
  assert.equal(result.ok, true);
  assert.equal(existsSync(statePath(context, "codex-sales-session")), false);
  const hookOutput = result.output.hookSpecificOutput;
  assert.match(hookOutput.additionalContext, /Harness mode: single/);
  assert.match(hookOutput.additionalContext, /selectedPlaybook: metrics\/销售额\/playbook\.md/);
  assert.match(hookOutput.additionalContext, /不得按 workspaceRoot 解析/);
  assert.deepEqual(extractTrustedContextFilePaths(hookOutput.additionalContext), [realpathSync(trustedPlaybook)]);
  assert.equal(hookOutput.additionalContext.includes(realpathSync(workspaceShadow)), false);
  assert.equal(readFileSync(realpathSync(trustedPlaybook), "utf8"), "# 可信销售额取数手册\n");
  assert.ok(hookOutput.contextFiles.some((ref) => ref.path === "metrics/销售额/playbook.md"));
});

test("structured prompt hooks run for an explicit skill and store only a prompt hash", () => {
  const roots = makeRoots();
  mkdirSync(path.join(roots.dataRoot, "config"), { recursive: true });
  writeFileSync(path.join(roots.dataRoot, "config", "harness-config.yaml"), "paths:\n  knowledge: .\n");
  mkdirSync(path.join(roots.dataRoot, ".harness", "index"), { recursive: true });
  const runtimeIndex = {
    meta: {
      resourceId: "qdm-harness-wiki",
      resourceSchemaVersion: 1,
      wikiContentVersion: createHash("sha256").update("root-context-fixture").digest("hex"),
      resourceVersion: createHash("sha256").update("root-context-fixture").digest("hex"),
      paths: { knowledge: ".", spec: "spec", playbooks: "playbooks", templates: "templates" },
    },
    docsByPath: {},
    recall: [],
    templateSelection: [],
  };
  writeFileSync(path.join(roots.dataRoot, ".harness", "index", "wikis-index.json"), `${JSON.stringify(runtimeIndex)}\n`);
  writeFileSync(path.join(roots.dataRoot, ".harness", "index", "wikis-runtime-index.json"), `${JSON.stringify(runtimeIndex)}\n`);
  writeRuntimeResourceManifest(roots.dataRoot, runtimeIndex);
  const context = normalizeRootContext(fixtureContext(roots));
  const result = runClaudeHook(
    context.pluginRoot,
    JSON.stringify({ session_id: "explicit-session", prompt: "<skill name=\"qdm-harness\">查询指标</skill>" }),
    context,
  );
  assert.equal(result.ok, true);
  const state = loadState(context, "explicit-session");
  assert.equal(Object.hasOwn(state, "prompt"), false);
  assert.match(state.prompt_sha256, /^[0-9a-f]{64}$/);
});

test("structured write-capable hooks fail closed without a workspace", () => {
  const roots = makeRoots();
  const input = fixtureContext(roots);
  delete input.workspaceRoot;
  input.capabilities = {
    canWriteWorkspace: false,
    canWriteData: true,
    hasStableSessionId: false,
    supportsSecretReference: true,
  };
  const context = normalizeRootContext(input);
  const result = runClaudeHook(
    context.pluginRoot,
    JSON.stringify({ session_id: "no-workspace-session", prompt: "<skill name=\"qdm-harness\">生成报告</skill>" }),
    context,
  );
  assert.equal(result.ok, true);
  assert.match(result.output.hookSpecificOutput.additionalContext, /QDM_WORKSPACE_REQUIRED/);
  assert.equal(context.stateRoot, "");
  assert.equal(existsSync(path.join(roots.dataRoot, "state")), false);
});

test("Codex hook envelopes hydrate workspace and session fields without using process.cwd", () => {
  const roots = makeRoots();
  const base = normalizeRootContext({
    schemaVersion: 1,
    host: "codex",
    pluginRoot: roots.pluginRoot,
    dataRoot: roots.dataRoot,
    secretRoot: roots.secretRoot,
    capabilities: {
      canWriteWorkspace: false,
      canWriteData: true,
      hasStableSessionId: false,
      supportsSecretReference: false,
    },
  });
  const context = contextFromHookPayload({ cwd: roots.workspaceRoot, session_id: "hook-session" }, {
    root: roots.pluginRoot,
    baseContext: base,
    env: {},
  });
  assert.equal(context.workspaceRoot, realpathSync(roots.workspaceRoot));
  assert.equal(context.sessionId, "hook-session");
  assert.equal(context.stateRoot.startsWith(base.dataRoot), true);
  assert.equal(context.capabilities.canWriteWorkspace, true);
  assert.equal(context.capabilities.hasStableSessionId, true);
});
