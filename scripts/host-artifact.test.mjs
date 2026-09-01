import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { buildHostArtifacts, selfTestHostArtifacts, verifyHostArtifacts } from "./host-artifact.mjs";
import { HOST_ARTIFACT_HOSTS, hostArtifactKind } from "./host-artifact-contract.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

test("host artifact matrix builds, verifies, and self-tests every supported host", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qdm-host-artifacts-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, "artifacts");

  const built = buildHostArtifacts({
    host: "all",
    outputDir,
    version: "0.0.54-test",
  });
  assert.deepEqual(built.map((item) => item.host), HOST_ARTIFACT_HOSTS);
  assert.equal(built.every((item) => item.verification.errors.length === 0), true);
  assert.equal(built.every((item) => item.selfTest?.host === item.host), true);

  const verified = verifyHostArtifacts({ host: "all", artifactRoot: outputDir });
  assert.equal(verified.length, HOST_ARTIFACT_HOSTS.length);
  const selfTested = selfTestHostArtifacts({ host: "all", artifactRoot: outputDir });
  assert.deepEqual(selfTested.map((item) => item.host), HOST_ARTIFACT_HOSTS);

  for (const host of HOST_ARTIFACT_HOSTS) {
    const report = verifyArtifact(path.join(outputDir, host), { kind: hostArtifactKind(host) });
    assert.deepEqual(report.errors, [], host);
    const wrapper = path.join(outputDir, host, "bin", "data-harness-cli");
    const help = spawnSync(process.execPath, [wrapper, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, `${host}: ${help.stderr || help.stdout}`);
    assert.match(help.stdout, /usage: data-harness-cli/);
  }

  const codexManifest = JSON.parse(await readFile(
    path.join(outputDir, "codex", "adapter", ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  assert.equal(codexManifest.version, "0.0.54-test");

  const claudeRoot = path.join(outputDir, "claude");
  const workspace = path.join(root, "claude-workspace");
  const dataRoot = path.join(root, "claude-data");
  const secretRoot = path.join(root, "claude-secrets");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(secretRoot, { recursive: true });
  const hook = spawnSync(process.execPath, [
    path.join(claudeRoot, "bin", "data-harness-cli"),
    "context",
    "--format",
    "claude-hook",
  ], {
    cwd: workspace,
    encoding: "utf8",
    input: JSON.stringify({ session_id: "claude-artifact", prompt: "普通编码问题", cwd: workspace }),
    env: {
      ...process.env,
      HARNESS_PLUGIN_ROOT: claudeRoot,
      HARNESS_DATA_ROOT: dataRoot,
      HARNESS_SECRET_ROOT: secretRoot,
      HARNESS_WORKSPACE_ROOT: workspace,
      CLAUDE_PROJECT_DIR: workspace,
      HARNESS_HOST: "claude",
    },
  });
  assert.equal(hook.status, 0, hook.stderr || hook.stdout);
  const hookJSON = JSON.parse(hook.stdout);
  assert.ok(hookJSON.hookSpecificOutput);
  assert.equal(hookJSON.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(hookJSON.hookSpecificOutput.additionalContext, /QDM_SETUP_REQUIRED/);
});
