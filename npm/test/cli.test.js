import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectDoctor } from "../src/commands/doctor.js";
import {
  agentChoices,
  linkAgents,
  localPathToolNames,
  localPathToolNamesForProfile,
  qdmCliBinaries,
  qdmCliBinariesForProfile,
  writeLocalConfig
} from "../src/lib/config.js";
import { readManifest } from "../src/lib/manifest.js";
import {
  installerStateSchemaVersion,
  localUnrestrictedProfile,
  lumiRequiredProfile,
  normalizeProfile,
  profileFromState,
  selectManifestProfile,
  validateProfileAgent
} from "../src/lib/profile.js";
import { binaryName } from "../src/lib/platform.js";
import { installerStatePath } from "../src/lib/paths.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "harness-data.js");
const repository = path.resolve(root, "..");

function executable(file, content = "#!/bin/sh\nexit 0\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function stateFixture(profile = localUnrestrictedProfile, overrides = {}) {
  return {
    schemaVersion: installerStateSchemaVersion,
    profile,
    agent: profile === lumiRequiredProfile ? "pi" : "codex",
    installMode: "local-path",
    runtimeTag: "v0.0.27",
    localTools: {
      "qdm-metric-cli": { mode: "local-path", source: "/tmp/qdm-metric-cli" }
    },
    tools: {
      "data-harness-cli": {
        destination: "/tmp/data-harness-cli",
        sha256: "a".repeat(64)
      }
    },
    manifestSha256: "b".repeat(64),
    packageVersion: "0.0.27",
    ...overrides
  };
}

test("CLI help exposes qdm-metric-cli and removes auth", () => {
  const result = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--metric-cli-path/);
  assert.doesNotMatch(result.stdout, /\bauth\b/);
  assert.doesNotMatch(result.stdout, /cas-username|cas-password/);
});

test("manifest publishes only data-harness-cli", () => {
  const manifest = readManifest(path.join(repository, "bootstrap", "cli-manifest.json"));
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["data-harness-cli"]);
  assert.deepEqual(selectManifestProfile(manifest, localUnrestrictedProfile).tools.map((tool) => tool.name), ["data-harness-cli"]);
  assert.deepEqual(selectManifestProfile(manifest, lumiRequiredProfile).tools.map((tool) => tool.name), ["data-harness-cli"]);
});

test("runtime CLI sets contain only the Harness helper and qdm-metric-cli", () => {
  assert.deepEqual(qdmCliBinaries, ["data-harness-cli", "qdm-metric-cli"]);
  assert.deepEqual(localPathToolNames, ["qdm-metric-cli"]);
  assert.deepEqual(qdmCliBinariesForProfile(localUnrestrictedProfile), qdmCliBinaries);
  assert.deepEqual(qdmCliBinariesForProfile(lumiRequiredProfile), qdmCliBinaries);
  assert.deepEqual(localPathToolNamesForProfile(lumiRequiredProfile), ["qdm-metric-cli"]);
});

test("writeLocalConfig emits only QDM_METRIC_CLI", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-config-"));
  writeLocalConfig(workspace, { profile: localUnrestrictedProfile });
  const env = fs.readFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), "utf8");
  const yaml = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.match(env, /^export QDM_METRIC_CLI=".*qdm-metric-cli"\n$/);
  assert.match(yaml, /qdm_metric_cli: .*qdm-metric-cli/);
  assert.doesNotMatch(`${env}\n${yaml}`, /CMR|INDICATORS|SQL|CAS|qdm_(cmr|indicators|sql|cas)/i);
});

test("all supported Agents retain ordinary hook templates", () => {
  assert.deepEqual(agentChoices, ["claude", "codex", "qwen", "pi", "openclaw", "hermes", "both", "all"]);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-agents-"));
  fs.cpSync(path.join(repository, ".agents"), path.join(workspace, "agents"), { recursive: true });
  const links = linkAgents(workspace, "all");
  assert.equal(links.length, 6);
  for (const name of ["claude", "codex", "qwen", "pi", "openclaw", "hermes"]) {
    assert.equal(fs.realpathSync(path.join(workspace, `.${name}`)), fs.realpathSync(path.join(workspace, "agents", name)));
  }
  const hookText = JSON.stringify({
    claude: JSON.parse(fs.readFileSync(path.join(repository, ".agents/claude/settings.json"), "utf8")),
    codex: JSON.parse(fs.readFileSync(path.join(repository, ".agents/codex/hooks.json"), "utf8")),
    qwen: JSON.parse(fs.readFileSync(path.join(repository, ".agents/qwen/settings.json"), "utf8"))
  });
  assert.doesNotMatch(hookText, /authz-hook|PreToolUse|Binding requester authorization/);
});

test("profile state accepts both profiles without auth release state", () => {
  assert.equal(normalizeProfile(""), localUnrestrictedProfile);
  assert.equal(profileFromState(stateFixture()), localUnrestrictedProfile);
  assert.equal(profileFromState(stateFixture(lumiRequiredProfile)), lumiRequiredProfile);
  assert.equal(profileFromState(stateFixture(lumiRequiredProfile, { releaseSet: {} })), "");
  assert.equal(profileFromState(stateFixture(lumiRequiredProfile, { authzConfigPath: "/etc/authz.json" })), "");
  assert.doesNotThrow(() => validateProfileAgent(lumiRequiredProfile, "qwen"));
  assert.throws(() => validateProfileAgent(lumiRequiredProfile, "hermes"), /requires --agent/);
});

test("doctor validates the two-CLI runtime and rejects legacy artifacts", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-"));
  fs.mkdirSync(path.join(workspace, "bootstrap"), { recursive: true });
  fs.copyFileSync(path.join(repository, "bootstrap", "cli-manifest.json"), path.join(workspace, "bootstrap", "cli-manifest.json"));
  fs.cpSync(path.join(repository, ".agents"), path.join(workspace, "agents"), { recursive: true });
  for (const name of ["metrics", "reports", "dims", "rules"]) {
    fs.mkdirSync(path.join(workspace, "wikis", name), { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, "wikis", "index.md"), "# index\n");
  executable(path.join(workspace, "bin", binaryName("data-harness-cli")));
  executable(path.join(workspace, "bin", binaryName("qdm-metric-cli")));
  writeLocalConfig(workspace, { profile: localUnrestrictedProfile });
  linkAgents(workspace, "codex");
  const state = stateFixture(localUnrestrictedProfile, {
    tools: {
      "data-harness-cli": {
        destination: path.join(workspace, "bin", binaryName("data-harness-cli")),
        sha256: "a".repeat(64)
      }
    }
  });
  fs.mkdirSync(path.dirname(installerStatePath(workspace)), { recursive: true });
  fs.writeFileSync(installerStatePath(workspace), JSON.stringify(state));

  const report = await collectDoctor(workspace);
  assert.equal(report.checks.filter((check) => !check.ok).length, 0);

  executable(path.join(workspace, "bin", binaryName("qdm-sql-cli")));
  const legacyReport = await collectDoctor(workspace);
  assert.equal(legacyReport.checks.find((check) => check.name === "bin/qdm-sql-cli absent").ok, false);
});
