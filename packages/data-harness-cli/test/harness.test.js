import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CONFIG_REL, findRoot, loadConfig, newPathResolver, normalizeResolverOwners } from "../src/lib/harness.js";
import { safeSessionId } from "../src/lib/sessionstate.js";
import { isAgentHookFormat, rootStart } from "../src/main.js";

function writeConfig(body) {
  const root = mkdtempSync(path.join(tmpdir(), "harness-cfg-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, CONFIG_REL), body);
  return root;
}

test("loadConfig normalizes authz mode", () => {
  const cases = [
    ["no authz section", "paths:\n  knowledge: wikis\n", "off"],
    ["missing mode", "authz:\n  allow_local_blob: true\n", "off"],
    ["empty mode", "authz:\n  mode:\n", "off"],
    ["off", "authz:\n  mode: off\n", "off"],
    ["trimmed mixed case off", "authz:\n  mode: '  OfF  '\n", "off"],
    ["on", "authz:\n  mode: on\n", "on"],
    ["trimmed mixed case on", "authz:\n  mode: '  ON  '\n", "on"],
  ];
  for (const [, body, want] of cases) {
    const cfg = loadConfig(writeConfig(body));
    assert.equal(cfg.authz.mode, want);
  }
});

test("loadConfig rejects unknown authz mode", () => {
  assert.throws(() => loadConfig(writeConfig("authz:\n  mode: enabled\n")), /authz.mode must be on or off/);
});

test("loadConfig defaults to wikis root when wikis dirs exist", () => {
  const root = mkdtempSync(path.join(tmpdir(), "harness-wikis-"));
  for (const dir of ["wikis/spec", "wikis/playbooks", "wikis/templates"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  const cfg = loadConfig(root);
  assert.equal(cfg.paths.spec, "wikis/spec");
  assert.equal(cfg.paths.playbooks, "wikis/playbooks");
  assert.equal(cfg.paths.templates, "wikis/templates");
});

test("loadConfig reads metric CLI path and ignores legacy keys", () => {
  const root = writeConfig(`paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /opt/qdm-metric-cli
  qdm_sql_cli: /opt/qdm-sql-cli
  qdm_cas_cli: /opt/cas-cli
`);
  const cfg = loadConfig(root);
  assert.equal(cfg.cli.qdmMetricCli, "/opt/qdm-metric-cli");
  assert.equal(cfg.authz.mode, "off");
  assert.equal(cfg.authz.devUserId, "");
});

test("loadConfig reads authz section", () => {
  const root = writeConfig(`paths:
  knowledge: wikis

authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
  allow_local_blob: true
`);
  const cfg = loadConfig(root);
  assert.equal(cfg.authz.mode, "on");
  assert.equal(cfg.authz.blobFile, "config/dev-auth.blob");
  assert.equal(cfg.authz.devUserId, "local-test-user");
  assert.equal(cfg.authz.allowLocalBlob, true);
});

test("FindRoot uses harness config without legacy knowledge dirs", () => {
  const root = writeConfig("paths:\n  spec: wikis/spec\n  routing: wikis/routing\n  playbooks: wikis/playbooks\n  templates: wikis/templates\n");
  const child = path.join(root, "nested", "child");
  mkdirSync(child, { recursive: true });
  assert.equal(findRoot(child), root);
});

test("PathResolver maps logical knowledge paths", () => {
  const root = writeConfig("paths:\n  spec: wikis/spec\n  routing: wikis/routing\n  playbooks: wikis/playbooks\n  templates: wikis/templates\n");
  const resolver = newPathResolver(root);
  assert.equal(resolver.resolveRel("spec/common/index.md"), "wikis/spec/common/index.md");
  assert.equal(resolver.resolveRel(".harness/index/spec-index.json"), ".harness/index/spec-index.json");
});

test("PathResolver keeps legacy string roots and exposes explicit owner roots", () => {
  const root = writeConfig("paths:\n  spec: wikis/spec\n  routing: wikis/routing\n  playbooks: wikis/playbooks\n  templates: wikis/templates\n");
  const legacy = newPathResolver(root);
  assert.equal(legacy.root, root);
  assert.equal(legacy.resourceRoot, root);
  assert.equal(legacy.resolveOwned("state", "session.json"), path.join(root, ".harness", "state", "session.json"));

  const base = mkdtempSync(path.join(tmpdir(), "harness-owners-"));
  const owners = {
    pluginRoot: root,
    dataRoot: path.join(base, "data"),
    workspaceRoot: path.join(base, "workspace"),
    stateRoot: path.join(base, "data", "state"),
    secretRoot: path.join(base, "secrets"),
  };
  for (const dir of [owners.dataRoot, owners.workspaceRoot, owners.stateRoot, owners.secretRoot]) mkdirSync(dir, { recursive: true });
  const resolver = newPathResolver({ ...owners, schemaVersion: 1 });
  assert.equal(resolver.root, root);
  assert.equal(resolver.resolveOwned("data", "config/settings.json"), path.join(owners.dataRoot, "config", "settings.json"));
  assert.equal(resolver.resolveOwned("workspace", "analysis/main.md"), path.join(owners.workspaceRoot, "analysis", "main.md"));
  assert.throws(() => resolver.resolveOwned("workspace", "../outside.txt"), /escapes its root/);
  assert.deepEqual(normalizeResolverOwners(root).legacy, true);
});

test("safeSessionId preserves common IDs and hashes unsafe ones", () => {
  for (const id of ["550e8400-e29b-41d4-a716-446655440000", "session_01.example", "unknown"]) {
    assert.equal(safeSessionId(id), id);
  }
  const unsafe = safeSessionId("workbuddy:foo");
  const lookalike = safeSessionId("workbuddy_foo");
  assert.notEqual(unsafe, lookalike);
  assert.match(unsafe, /^sha256~[0-9a-f]{64}$/);
  assert.equal(safeSessionId("workbuddy:foo"), unsafe);
  assert.match(safeSessionId("CON"), /^sha256~/);
  assert.match(safeSessionId("com1.json"), /^sha256~/);
  const hashed = safeSessionId("a/b");
  assert.notEqual(safeSessionId(hashed), hashed);
});

test("rootStart preserves legacy hosts while preferring explicit host workspace roots", () => {
  assert.equal(rootStart({ HARNESS_WORKSPACE_ROOT: "/harness/project", CODEX_WORKSPACE_ROOT: "/codex/project" }), "/harness/project");
  assert.equal(rootStart({ CODEX_WORKSPACE_ROOT: "/codex/project", CODEBUDDY_PROJECT_DIR: "/workbuddy/project" }), "/codex/project");
  assert.equal(rootStart({ CODEBUDDY_PROJECT_DIR: "/workbuddy/project", CLAUDE_PROJECT_DIR: "/claude/project" }), "/workbuddy/project");
  assert.equal(rootStart({ CODEBUDDY_PROJECT_DIR: "", CLAUDE_PROJECT_DIR: "/claude/project" }), "/claude/project");
});

test("agent hook formats include workbuddy and not unknown", () => {
  for (const format of ["claude-hook", "codex-hook", "agent-hook", "workbuddy-hook"]) {
    assert.equal(isAgentHookFormat(format), true);
  }
  assert.equal(isAgentHookFormat("unknown-hook"), false);
});
