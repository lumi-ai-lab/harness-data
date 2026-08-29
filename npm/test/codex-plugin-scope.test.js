import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyCodexPluginScope,
  DEFAULT_CODEX_PLUGIN_SELECTOR,
  ensureWorkspaceDirectory,
  projectCodexConfigPath,
  readTomlTableAssignments,
  resolveCodexPluginSelector,
  upsertTomlTable,
  userCodexConfigPath,
} from "../src/lib/codex-plugin-scope.js";

test("upsertTomlTable inserts and updates a quoted plugin table without clobbering neighbors", () => {
  const original = [
    "model = \"gpt-5.6\"",
    "",
    "[plugins.\"repo-scope-test@personal\"]",
    "enabled = false",
    "",
    "[features]",
    "hooks = true",
    "",
  ].join("\n");
  const inserted = upsertTomlTable(original, ["plugins", "harness-data@lumi-ai-lab"], { enabled: false });
  assert.match(inserted, /\[plugins\."harness-data@lumi-ai-lab"\]\nenabled = false\n/);
  assert.match(inserted, /\[plugins\."repo-scope-test@personal"\]\nenabled = false\n/);
  assert.match(inserted, /\[features\]\nhooks = true\n/);

  const updated = upsertTomlTable(inserted, ["plugins", "harness-data@lumi-ai-lab"], { enabled: true });
  assert.match(updated, /\[plugins\."harness-data@lumi-ai-lab"\]\nenabled = true\n/);
  assert.equal(readTomlTableAssignments(updated, ["plugins", "harness-data@lumi-ai-lab"]).enabled, true);
  assert.equal(readTomlTableAssignments(updated, ["plugins", "repo-scope-test@personal"]).enabled, false);
});

test("upsertTomlTable stops a table at the next array-of-tables header", () => {
  const original = [
    "[plugins.\"harness-data@lumi-ai-lab\"]",
    "enabled = true",
    "[[widgets]]",
    "name = \"keep\"",
    "",
  ].join("\n");
  const next = upsertTomlTable(original, ["plugins", "harness-data@lumi-ai-lab"], { enabled: false });
  assert.match(next, /enabled = false\n\[\[widgets\]\]/);
  assert.match(next, /name = "keep"/);
});

test("upsertTomlTable preserves other keys in an existing table", () => {
  const original = [
    "[plugins.\"harness-data@lumi-ai-lab\"]",
    "enabled = true",
    "keep = \"yes\"",
    "",
  ].join("\n");
  const next = upsertTomlTable(original, ["plugins", "harness-data@lumi-ai-lab"], { enabled: false });
  const table = readTomlTableAssignments(next, ["plugins", "harness-data@lumi-ai-lab"]);
  assert.equal(table.enabled, false);
  assert.equal(table.keep, "yes");
});

test("resolveCodexPluginSelector reads marketplace and name from the plugin cache path", () => {
  assert.equal(
    resolveCodexPluginSelector("/tmp/codex-home/plugins/cache/lumi-ai-lab/harness-data/0.0.54"),
    "harness-data@lumi-ai-lab",
  );
  assert.equal(resolveCodexPluginSelector("/tmp/plugin", { pluginSelector: "custom@local" }), "custom@local");
  assert.equal(resolveCodexPluginSelector(""), DEFAULT_CODEX_PLUGIN_SELECTOR);
});

test("ensureWorkspaceDirectory creates a missing project and rejects Codex home overlap", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qdm-plugin-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, "projects", "new-app");
  const pluginRoot = path.join(root, "plugin");
  const dataRoot = path.join(root, "data");
  const userHome = path.join(root, "home");
  const codexHome = path.join(userHome, ".codex");
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const created = ensureWorkspaceDirectory(missing, { pluginRoot, dataRoot, codexHome });
  assert.equal(created, fs.realpathSync.native(missing));
  assert.equal(fs.statSync(created).isDirectory(), true);

  assert.throws(
    () => ensureWorkspaceDirectory(userHome, { pluginRoot, dataRoot, codexHome }),
    /overwrite the user Codex config/,
  );
  assert.throws(
    () => ensureWorkspaceDirectory(pluginRoot, { pluginRoot, dataRoot, codexHome }),
    /overlaps Harness Data roots.*--workspace-allowlist/,
  );
});

test("applyCodexPluginScope default-disables the plugin and enables plus trusts listed projects", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qdm-plugin-scope-apply-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const stale = path.join(root, "stale");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(userCodexConfigPath(codexHome), [
    "model = \"gpt-5.6\"",
    "",
    "[plugins.\"browser@openai-bundled\"]",
    "enabled = true",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(stale, ".codex"), { recursive: true });
  fs.writeFileSync(projectCodexConfigPath(stale), "[plugins.\"harness-data@lumi-ai-lab\"]\nenabled = true\n");

  const result = applyCodexPluginScope({
    codexHome,
    selector: "harness-data@lumi-ai-lab",
    enableRoots: [projectA, projectB],
    disableRoots: [stale],
  });
  assert.equal(result.status, "written");
  const userText = fs.readFileSync(result.userConfigPath, "utf8");
  assert.equal(readTomlTableAssignments(userText, ["plugins", "harness-data@lumi-ai-lab"]).enabled, false);
  assert.equal(readTomlTableAssignments(userText, ["plugins", "browser@openai-bundled"]).enabled, true);
  assert.equal(readTomlTableAssignments(userText, ["projects", projectA]).trust_level, "trusted");
  assert.equal(readTomlTableAssignments(userText, ["projects", projectB]).trust_level, "trusted");
  assert.equal(readTomlTableAssignments(fs.readFileSync(projectCodexConfigPath(projectA), "utf8"), ["plugins", "harness-data@lumi-ai-lab"]).enabled, true);
  assert.equal(readTomlTableAssignments(fs.readFileSync(projectCodexConfigPath(projectB), "utf8"), ["plugins", "harness-data@lumi-ai-lab"]).enabled, true);
  assert.equal(readTomlTableAssignments(fs.readFileSync(projectCodexConfigPath(stale), "utf8"), ["plugins", "harness-data@lumi-ai-lab"]).enabled, false);
});
