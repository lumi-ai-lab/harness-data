import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectDoctor } from "../src/commands/doctor.js";
import {
  installCommand,
  installModeFor,
  installSandboxPlatformTools
} from "../src/commands/install.js";
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
  const local = profile !== lumiRequiredProfile;
  return {
    schemaVersion: installerStateSchemaVersion,
    profile,
    agent: profile === lumiRequiredProfile ? "pi" : "codex",
    installMode: local ? "local-path" : "github-token",
    runtimeTag: "v0.0.27",
    localTools: local ? {
      "qdm-metric-cli": { mode: "local-path", source: "/tmp/qdm-metric-cli" }
    } : {},
    tools: {
      "data-harness-cli": {
        destination: "/tmp/data-harness-cli",
        sha256: "a".repeat(64)
      }
    },
    manifestSha256: "b".repeat(64),
    packageVersion: "0.0.27",
    ...(local ? {} : {
      releaseSet: {
        version: "v0.0.27",
        publicMetricVersion: "v0.0.27",
        publicMetricSha256: "a".repeat(64),
        realMetricVersion: "v0.1.0",
        realMetricSha256: "b".repeat(64),
        catalogSha256: "c".repeat(64),
        authzSchemaVersion: 1,
        piVersion: "0.81.1",
        sha256: "d".repeat(64)
      },
      authzConfigPath: "/etc/harness-data/authz.json"
    }),
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

test("local-unrestricted requires a real qdm-metric-cli path", async () => {
  await assert.rejects(
    () => installCommand({
      profile: localUnrestrictedProfile,
      agent: "codex",
      yes: true
    }),
    /local-unrestricted installation requires --metric-cli-path/
  );
});

test("local Wikis keep local-path install mode when GitHub auth is available", () => {
  assert.equal(
    installModeFor(localUnrestrictedProfile, { wikisSource: "/tmp/wikis" }, true),
    "local-path"
  );
  assert.equal(
    installModeFor(localUnrestrictedProfile, {}, true),
    "github-token"
  );
  assert.equal(
    installModeFor(lumiRequiredProfile, { wikisSource: "/tmp/approved-wikis" }, true),
    "github-token"
  );
});

test("manifest publishes the Harness helper, authorized qdm-metric-cli, and private real CLI", () => {
  const manifest = readManifest(path.join(repository, "bootstrap", "cli-manifest.json"));
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]);
  assert.deepEqual(selectManifestProfile(manifest, localUnrestrictedProfile).tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli"]);
  assert.deepEqual(selectManifestProfile(manifest, lumiRequiredProfile).tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]);
  const metric = manifest.tools.find((tool) => tool.name === "qdm-metric-cli");
  assert.equal(metric.repo, "lumi-ai-lab/harness-data");
  assert.equal(metric.private, undefined);
  assert.deepEqual(Object.keys(metric.platforms).sort(), [
    "darwin-amd64",
    "darwin-arm64",
    "linux-amd64",
    "windows-amd64"
  ]);
});

test("runtime CLI sets contain only the Harness helper and qdm-metric-cli", () => {
  assert.deepEqual(qdmCliBinaries, ["data-harness-cli", "qdm-metric-cli"]);
  assert.deepEqual(localPathToolNames, []);
  assert.deepEqual(qdmCliBinariesForProfile(localUnrestrictedProfile), qdmCliBinaries);
  assert.deepEqual(qdmCliBinariesForProfile(lumiRequiredProfile), qdmCliBinaries);
  assert.deepEqual(localPathToolNamesForProfile(lumiRequiredProfile), []);
  assert.deepEqual(localPathToolNamesForProfile(lumiRequiredProfile, { metricCliPath: "/tmp/qdm-metric-cli" }), ["qdm-metric-cli"]);
});

test("writeLocalConfig emits only QDM_METRIC_CLI", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-config-"));
  writeLocalConfig(workspace, { profile: localUnrestrictedProfile });
  const env = fs.readFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), "utf8");
  const yaml = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.equal(env, `export QDM_METRIC_CLI="bin/${binaryName("qdm-metric-cli")}"\n`);
  assert.match(yaml, new RegExp(`qdm_metric_cli: bin/${binaryName("qdm-metric-cli")}`));
  assert.doesNotMatch(
    `${env}\n${yaml}`,
    /\bQDM_(?:CMR|INDICATORS|SQL|CAS)_CLI\b|^\s*qdm_(?:cmr|indicators|sql|cas)(?:_cli)?:/im
  );
});

test("sandbox platform install dispatches host and Linux CLIs", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-platform-tools-"));
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-linux-tools-"));
  for (const name of qdmCliBinaries) {
    executable(path.join(workspace, "bin", binaryName(name)), `#!/bin/sh\necho host-${name}\n`);
    executable(path.join(sandboxDir, binaryName(name)), `#!/bin/sh\necho sandbox-${name}\n`);
  }

  const installed = installSandboxPlatformTools(
    workspace,
    localUnrestrictedProfile,
    {
      sandboxCliDir: sandboxDir,
      hostPlatformKey: "darwin-arm64",
      sandboxPlatform: "linux-arm64"
    }
  );

  assert.deepEqual(Object.keys(installed).sort(), [...qdmCliBinaries].sort());
  for (const name of qdmCliBinaries) {
    const dispatcher = fs.readFileSync(path.join(workspace, "bin", binaryName(name)), "utf8");
    assert.match(dispatcher, /Darwin:arm64/);
    assert.match(dispatcher, /Linux:aarch64/);
    assert.match(dispatcher, new RegExp(`platform-bin/\\$platform/${binaryName(name)}`));
    assert.match(
      fs.readFileSync(
        path.join(workspace, ".harness", "platform-bin", "darwin-arm64", binaryName(name)),
        "utf8"
      ),
      new RegExp(`host-${name}`)
    );
    assert.match(
      fs.readFileSync(
        path.join(workspace, ".harness", "platform-bin", "linux-arm64", binaryName(name)),
        "utf8"
      ),
      new RegExp(`sandbox-${name}`)
    );
  }
});

test("all supported Agents retain ordinary hook templates", () => {
  assert.deepEqual(agentChoices, ["claude", "codex", "qwen", "pi", "lumi", "openclaw", "hermes", "both", "all"]);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-agents-"));
  fs.cpSync(path.join(repository, ".agents"), path.join(workspace, "agents"), { recursive: true });
  const links = linkAgents(workspace, "all");
  assert.equal(links.length, 6);
  for (const name of ["claude", "codex", "qwen", "pi", "openclaw", "hermes"]) {
    assert.equal(fs.realpathSync(path.join(workspace, `.${name}`)), fs.realpathSync(path.join(workspace, "agents", name)));
  }
  const lumiWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lumi-agents-"));
  fs.cpSync(path.join(repository, ".agents"), path.join(lumiWorkspace, "agents"), { recursive: true });
  const lumiLinks = linkAgents(lumiWorkspace, "lumi");
  assert.equal(lumiLinks.length, 3);
  for (const name of ["pi", "claude", "codex"]) {
    assert.equal(fs.realpathSync(path.join(lumiWorkspace, `.${name}`)), fs.realpathSync(path.join(lumiWorkspace, "agents", name)));
  }
  for (const name of ["qwen", "openclaw", "hermes"]) {
    assert.equal(fs.existsSync(path.join(lumiWorkspace, `.${name}`)), false);
  }
  const hookText = JSON.stringify({
    claude: JSON.parse(fs.readFileSync(path.join(repository, ".agents/claude/settings.json"), "utf8")),
    codex: JSON.parse(fs.readFileSync(path.join(repository, ".agents/codex/hooks.json"), "utf8")),
    qwen: JSON.parse(fs.readFileSync(path.join(repository, ".agents/qwen/settings.json"), "utf8"))
  });
  assert.match(hookText, /authz-hook|PreToolUse|Binding requester authorization/);

  const instructionText = [
    ".agents/codex/AGENTS.md",
    ".agents/hermes/skills/qdm-harness/SKILL.md",
    ".agents/openclaw/AGENTS.md",
    ".agents/openclaw/skills/qdm-harness/SKILL.md",
    ".agents/pi/skills/qdm-harness/SKILL.md"
  ].map((file) => fs.readFileSync(path.join(repository, file), "utf8")).join("\n");
  assert.match(instructionText, /qdm-metric-cli --help/);
  assert.match(instructionText, /requester authorization is supplied automatically/);
  assert.doesNotMatch(instructionText, /CMR or Indicators token|credential flow|QR login|Credentials are deployment-owned/);
});

test("linkAgents replaces a dangling hook after a runtime directory move", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-moved-agent-"));
  fs.cpSync(path.join(repository, ".agents"), path.join(workspace, "agents"), { recursive: true });
  const hook = path.join(workspace, ".pi");
  fs.symlinkSync(path.join(workspace, "old-location", "agents", "pi"), hook, "junction");

  assert.equal(fs.existsSync(hook), false);
  assert.equal(fs.lstatSync(hook).isSymbolicLink(), true);
  assert.doesNotThrow(() => linkAgents(workspace, "pi"));
  assert.equal(fs.realpathSync(hook), fs.realpathSync(path.join(workspace, "agents", "pi")));
  if (process.platform !== "win32") {
    assert.equal(fs.readlinkSync(hook), path.join("agents", "pi"));
  }
});

test("release workflow pins qdm-metric-cli and builds the runtime bundle", () => {
  const workflow = fs.readFileSync(path.join(repository, ".github/workflows/publish-cli-release.yml"), "utf8");
  assert.match(workflow, /repo="pengmide\/qdm-metric-cli"/);
  assert.match(workflow, /qdm-metric-cli-\$\{version\}-\$\{platform\}/);
  assert.match(workflow, /qdm-metric-dist \/tmp\/qdm-metric-release/);
  assert.match(workflow, /harness-data-runtime-\$\{VERSION_TAG\}\.tar\.gz/);
  assert.match(workflow, /Smoke test released installation/);
  assert.match(workflow, /authz|qdm-metric-cli-real/i);
  assert.doesNotMatch(workflow, /qdm-indicators|qdm-cmr|qdm-sql|cas-cli/i);

  const gitmodules = fs.readFileSync(path.join(repository, ".gitmodules"), "utf8");
  assert.match(gitmodules, /git@github\.com:lumi-ai-lab\/harness-data-wikis\.git/);
  assert.doesNotMatch(gitmodules, /yaw0110|url\s*=\s*\.\.\//);
});

test("profile state accepts both profiles without auth release state", () => {
  assert.equal(normalizeProfile(""), localUnrestrictedProfile);
  assert.equal(profileFromState(stateFixture()), localUnrestrictedProfile);
  assert.equal(profileFromState(stateFixture(lumiRequiredProfile)), lumiRequiredProfile);
  assert.equal(profileFromState(stateFixture(lumiRequiredProfile, { releaseSet: {} })), "");
  assert.equal(profileFromState(stateFixture(lumiRequiredProfile, { authzConfigPath: "/etc/authz.json" })), "");
  assert.doesNotThrow(() => validateProfileAgent(lumiRequiredProfile, "qwen"));
  assert.doesNotThrow(() => validateProfileAgent(lumiRequiredProfile, "lumi"));
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

test("doctor rejects an executable CLI that is killed during startup", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-doctor-killed-"));
  fs.mkdirSync(path.join(workspace, "bootstrap"), { recursive: true });
  fs.copyFileSync(path.join(repository, "bootstrap", "cli-manifest.json"), path.join(workspace, "bootstrap", "cli-manifest.json"));
  fs.cpSync(path.join(repository, ".agents"), path.join(workspace, "agents"), { recursive: true });
  for (const name of ["metrics", "reports", "dims", "rules"]) {
    fs.mkdirSync(path.join(workspace, "wikis", name), { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, "wikis", "index.md"), "# index\n");
  executable(path.join(workspace, "bin", binaryName("data-harness-cli")), "#!/bin/sh\nkill -9 $$\n");
  executable(path.join(workspace, "bin", binaryName("qdm-metric-cli")));
  writeLocalConfig(workspace, { profile: localUnrestrictedProfile });
  linkAgents(workspace, "codex");
  fs.mkdirSync(path.dirname(installerStatePath(workspace)), { recursive: true });
  fs.writeFileSync(installerStatePath(workspace), JSON.stringify(stateFixture()));

  const report = await collectDoctor(workspace);

  assert.equal(report.checks.find((check) => check.name === "bin/data-harness-cli").ok, true);
  assert.equal(report.checks.find((check) => check.name === "bin/data-harness-cli runnable").ok, false);
});
