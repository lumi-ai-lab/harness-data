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
  installSandboxPlatformTools,
  installWikis,
  localUnrestrictedReleaseManifest,
  removeLegacyLocalTools,
  verifyPiRequesterInstalledReleaseSet
} from "../src/commands/install.js";
import { createApprovedWikisManifest } from "../src/lib/approved-wikis.js";
import {
  agentChoices,
  linkAgents,
  localPathToolNames,
  localPathToolNamesForProfile,
  migrateLegacyLocalAgentInstructions,
  qdmCliBinaries,
  qdmCliBinariesForProfile,
  removeUnselectedAgentLinks,
  writeLocalConfig
} from "../src/lib/config.js";
import { readManifest } from "../src/lib/manifest.js";
import {
  installerStateSchemaVersion,
  localUnrestrictedProfile,
  piRequesterReleaseSetDigest,
  piRequesterAuthorizedProfile,
  normalizeProfile,
  profileFromState,
  selectManifestProfile,
  validateProfileAgent
} from "../src/lib/profile.js";
import { binaryName, platformKey } from "../src/lib/platform.js";
import { installerStatePath, readInstallerState, writeState } from "../src/lib/paths.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "harness-data.js");
const repository = path.resolve(root, "..");

function executable(file, content = "#!/bin/sh\nexit 0\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function stateFixture(profile = localUnrestrictedProfile, overrides = {}) {
  const local = profile !== piRequesterAuthorizedProfile;
  const releaseSet = {
    key: "pi-requester-v1",
    platform: platformKey(),
    version: "v0.0.27",
    publicMetricVersion: "v0.0.27",
    publicMetricSha256: "a".repeat(64),
    realMetricVersion: "v0.1.0",
    realMetricSha256: "b".repeat(64),
    catalogSha256: "c".repeat(64),
    authzSchemaVersion: 1,
    piVersion: "0.83.0"
  };
  releaseSet.sha256 = piRequesterReleaseSetDigest(releaseSet);
  return {
    schemaVersion: installerStateSchemaVersion,
    profile,
    agent: profile === piRequesterAuthorizedProfile ? "pi" : "codex",
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
    ...(local ? {} : { releaseSet }),
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

test("local-unrestricted downloads the real Metric CLI unless a local path overrides it", () => {
  const source = readManifest(path.join(repository, "bootstrap", "cli-manifest.json"));
  const remote = localUnrestrictedReleaseManifest(source);
  const metric = remote.tools.find((tool) => tool.name === "qdm-metric-cli");
  assert.deepEqual(remote.tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli"]);
  assert.equal(metric.repo, "pengmide/qdm-metric-cli");
  assert.equal(metric.tracking, "latest");
  assert.equal(metric.requireAssetSha256, true);

  const local = localUnrestrictedReleaseManifest(source, { metricCliPath: "/tmp/qdm-metric-cli" });
  assert.deepEqual(local.tools.map((tool) => tool.name), ["data-harness-cli"]);
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
    installModeFor(piRequesterAuthorizedProfile, {}, true),
    "github-token"
  );
});

test("pi-requester-authorized rejects an external Wikis source", async () => {
  await assert.rejects(
    () => installCommand({
      profile: piRequesterAuthorizedProfile,
      agent: "pi",
      yes: true,
      wikisSource: "/tmp/external-approved-wikis"
    }),
    /does not accept --wikis-source/
  );
});

test("non-interactive installation without a profile defaults to local-unrestricted", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-default-profile-"));
  fs.mkdirSync(path.join(workspace, ".harness"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".harness", "installer-state.json"),
    JSON.stringify({ unexpected: true })
  );
  try {
    await assert.rejects(
      () => installCommand({ dir: workspace, yes: true }),
      /existing installer profile is ambiguous/
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("pi-requester-authorized installs Wikis from its runtime bundle", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "harness-approved-wikis-"));
  const source = path.join(runtime, "bootstrap", "approved-lumi-wikis");
  for (const directory of ["metrics", "reports", "dims", "rules"]) {
    fs.mkdirSync(path.join(source, directory), { recursive: true });
    fs.writeFileSync(path.join(source, directory, "approved.md"), `# ${directory}\n`);
  }
  fs.writeFileSync(path.join(source, "index.md"), "# Approved Wikis\n");
  const approvalManifest = path.join(runtime, "bootstrap", "approved-lumi-wikis-manifest.json");
  const approval = createApprovedWikisManifest(source, approvalManifest);
  const manifest = {
    schemaVersion: 3,
    profiles: {
      [piRequesterAuthorizedProfile]: {
        agent: "pi",
        tools: ["qdm-metric-cli"],
        approvedWikis: {
          source: "bootstrap/approved-lumi-wikis",
          manifest: "bootstrap/approved-lumi-wikis-manifest.json",
          manifestSha256: approval.manifestSha256
        }
      }
    }
  };

  try {
    const installed = await installWikis(runtime, piRequesterAuthorizedProfile, manifest);
    assert.equal(installed.source, source);
    assert.equal(fs.readFileSync(path.join(runtime, "wikis", "index.md"), "utf8"), "# Approved Wikis\n");
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

test("manifest publishes the Harness helper, authorized qdm-metric-cli, and private real CLI", () => {
  const manifest = readManifest(path.join(repository, "bootstrap", "cli-manifest.json"));
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]);
  assert.deepEqual(selectManifestProfile(manifest, localUnrestrictedProfile).tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli"]);
  assert.deepEqual(selectManifestProfile(manifest, piRequesterAuthorizedProfile).tools.map((tool) => tool.name), ["data-harness-cli", "qdm-metric-cli", "qdm-metric-cli-real"]);
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
  assert.deepEqual(qdmCliBinariesForProfile(piRequesterAuthorizedProfile), qdmCliBinaries);
  assert.deepEqual(localPathToolNamesForProfile(piRequesterAuthorizedProfile), []);
  assert.deepEqual(localPathToolNamesForProfile(piRequesterAuthorizedProfile, { metricCliPath: "/tmp/qdm-metric-cli" }), []);
});

test("legacy local Agent instructions and managed links are migrated safely", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-agent-migration-"));
  fs.cpSync(path.join(repository, ".agents"), path.join(workspace, "agents"), { recursive: true });
  const instructions = path.join(workspace, "agents", "codex", "legacy.md");
  fs.writeFileSync(
    instructions,
    "- If CMR or Indicators token is invalid, use the configured `cas-cli` credential flow; do not start QR login from an automated hook.\n"
  );
  assert.equal(migrateLegacyLocalAgentInstructions(workspace).includes("agents/codex/legacy.md"), true);
  assert.match(fs.readFileSync(instructions, "utf8"), /bin\/qdm-metric-cli/);
  assert.doesNotMatch(fs.readFileSync(instructions, "utf8"), /cas-cli|credential flow/);

  linkAgents(workspace, "all");
  assert.deepEqual(removeUnselectedAgentLinks(workspace, "codex").sort(), [".claude", ".hermes", ".openclaw", ".pi"]);
  assert.equal(fs.existsSync(path.join(workspace, ".codex")), true);
});

test("legacy local data CLIs are removed without touching Metric CLI", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-legacy-cli-"));
  for (const name of ["qdm-cmr-cli", "qdm-indicators-cli", "qdm-sql-cli", "cas-cli", "qdm-metric-cli"]) {
    executable(path.join(workspace, "bin", binaryName(name)));
  }
  assert.deepEqual(removeLegacyLocalTools(workspace), ["qdm-cmr-cli", "qdm-indicators-cli", "qdm-sql-cli", "cas-cli"]);
  assert.equal(fs.existsSync(path.join(workspace, "bin", binaryName("qdm-metric-cli"))), true);
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

test("non-Pi Agents retain their existing ordinary hook capabilities", () => {
  assert.deepEqual(agentChoices, ["claude", "codex", "pi", "openclaw", "hermes", "both", "all"]);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-agents-"));
  fs.cpSync(path.join(repository, ".agents"), path.join(workspace, "agents"), { recursive: true });
  const links = linkAgents(workspace, "all");
  assert.equal(links.length, 5);
  for (const name of ["claude", "codex", "pi", "openclaw", "hermes"]) {
    assert.equal(fs.realpathSync(path.join(workspace, `.${name}`)), fs.realpathSync(path.join(workspace, "agents", name)));
  }
  const hookText = JSON.stringify({
    claude: JSON.parse(fs.readFileSync(path.join(repository, ".agents/claude/settings.json"), "utf8")),
    codex: JSON.parse(fs.readFileSync(path.join(repository, ".agents/codex/hooks.json"), "utf8"))
  });
  assert.doesNotMatch(hookText, /authz-hook|Binding requester authorization|Authorizing Bash command/);

  const nonPiInstructionPaths = [
    ".agents/codex/AGENTS.md",
    ".agents/hermes/.hermes.md",
    ".agents/hermes/skills/qdm-harness/SKILL.md",
    ".agents/openclaw/AGENTS.md",
    ".agents/openclaw/skills/qdm-harness/SKILL.md"
  ];
  for (const file of nonPiInstructionPaths) {
    const instructionText = fs.readFileSync(path.join(repository, file), "utf8");
    assert.match(instructionText, /CMR or Indicators token is invalid/);
    assert.match(instructionText, /cas-cli.*credential flow/);
    assert.doesNotMatch(instructionText, /qdm-metric-cli|requester authorization/);
  }

  const piInstructionText = fs.readFileSync(
    path.join(repository, ".agents/pi/skills/qdm-harness/SKILL.md"),
    "utf8"
  );
  assert.match(piInstructionText, /qdm-metric-cli --help/);
  assert.match(piInstructionText, /requester authorization is supplied automatically by\s+the installed Pi extension/);
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
  const releaseWorkflow = fs.readFileSync(path.join(repository, ".github/workflows/release.yml"), "utf8");
  const candidateWorkflow = fs.readFileSync(
    path.join(repository, ".github/workflows/verify-release-candidate.yml"),
    "utf8"
  );
  const manifest = readManifest(path.join(repository, "bootstrap", "cli-manifest.json"));
  const realMetric = manifest.tools.find((tool) => tool.name === "qdm-metric-cli-real");
  assert.equal(realMetric.private, undefined);
  assert.equal(realMetric.requiresAuth, true);
  assert.equal(realMetric.destination, "bin/qdm-metric-cli-real");
  assert.equal(realMetric.tracking, "latest");
  assert.equal(realMetric.version, "");
  assert.equal(realMetric.platforms["linux-amd64"].url, "");
  assert.match(workflow, /github\.event_name == 'pull_request'/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /version="\$\{VERSION_TAG:-v0\.0\.\$\{GITHUB_RUN_ID\}\}"/);
  assert.match(workflow, /Resolve latest qdm-metric-cli release/);
  assert.match(workflow, /gh release view --repo "\$\{repo\}" --json tagName --jq \.tagName/);
  assert.match(workflow, /--pattern "\$\{asset\}\.sha256"/);
  assert.doesNotMatch(workflow, /--pattern "\$\{asset\}\.binary\.sha256"/);
  assert.match(workflow, /expected_archive_sha=.*awk/);
  assert.match(workflow, /archive checksum is invalid/);
  assert.match(workflow, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(workflow, /actual_archive_sha=.*sha256sum/);
  assert.match(workflow, /archive checksum mismatch/);
  assert.match(workflow, /> "\/tmp\/qdm-metric-release\/\$\{asset\}\.binary\.sha256"/);
  assert.match(workflow, /--qdm-metric-version "\$\{QDM_METRIC_VERSION\}"/);
  assert.match(workflow, /--qdm-metric-dist \/tmp\/qdm-metric-release/);
  assert.match(workflow, /harness-data-runtime-\$\{VERSION_TAG\}\.tar\.gz/);
  assert.match(workflow, /release-contract-smoke:/);
  assert.match(workflow, /name: Release contract smoke/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /Build secretless release fixtures/);
  assert.match(workflow, /QDM_METRIC_CONTRACT_ASSETS/);
  assert.doesNotMatch(workflow, /name: Exercise privileged install and broker authorization/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.RELEASE_GH_TOKEN \|\| github\.token \}\}/);
  assert.match(workflow, /--github-token "\$\{GH_TOKEN\}"/);
  assert.match(workflow, /--agent pi/);
  assert.doesNotMatch(workflow, /for agent in pi claude codex qwen/);
  assert.match(workflow, /qdm-metric-cli v0\.1\.0-contract/);
  assert.match(workflow, /if: inputs\.publish \|\| startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /inputs\.verify/);
  assert.doesNotMatch(releaseWorkflow, /console\.log\(`\$\{tool\.repo\}.*\.binary\.sha256/);
  assert.match(workflow, /authz|qdm-metric-cli-real/i);
  assert.doesNotMatch(workflow, /qdm-indicators|qdm-cmr|qdm-sql|cas-cli/i);
  assert.match(candidateWorkflow, /environment: release-candidate/);
  assert.match(candidateWorkflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(candidateWorkflow, /git rev-parse HEAD/);
  assert.match(candidateWorkflow, /uses: \.\/\.github\/workflows\/publish-cli-release\.yml/);
  assert.match(candidateWorkflow, /verify: true/);
  assert.match(candidateWorkflow, /publish: false/);

  const gitmodules = fs.readFileSync(path.join(repository, ".gitmodules"), "utf8");
  assert.match(gitmodules, /url\s*=\s*\.\.\/harness-data-wikis/);
  assert.doesNotMatch(gitmodules, /yaw0110/);
});

test("profile state accepts both profiles without auth release state", () => {
  assert.equal(normalizeProfile(""), localUnrestrictedProfile);
  assert.throws(() => normalizeProfile(["lumi", "mvp", "required"].join("-")), /profile must be/);
  assert.equal(profileFromState(stateFixture()), localUnrestrictedProfile);
  assert.equal(profileFromState(stateFixture(piRequesterAuthorizedProfile)), piRequesterAuthorizedProfile);
  assert.equal(profileFromState(stateFixture(piRequesterAuthorizedProfile, {
    releaseSet: {
      ...stateFixture(piRequesterAuthorizedProfile).releaseSet,
      realMetricVersion: "v0.1.1"
    }
  })), "");
  const wrongPlatformReleaseSet = {
    ...stateFixture(piRequesterAuthorizedProfile).releaseSet,
    platform: platformKey() === "linux-amd64" ? "darwin-arm64" : "linux-amd64"
  };
  wrongPlatformReleaseSet.sha256 = piRequesterReleaseSetDigest(wrongPlatformReleaseSet);
  assert.equal(profileFromState(stateFixture(piRequesterAuthorizedProfile, {
    releaseSet: wrongPlatformReleaseSet
  })), "");
  assert.equal(profileFromState(stateFixture(piRequesterAuthorizedProfile, {
    releaseSet: {
      ...stateFixture(piRequesterAuthorizedProfile).releaseSet,
      sha256: "d".repeat(64)
    }
  })), "");
  assert.equal(profileFromState(stateFixture(piRequesterAuthorizedProfile, { releaseSet: {} })), "");
  assert.equal(profileFromState(stateFixture(piRequesterAuthorizedProfile, { authzConfigPath: "/etc/authz.json" })), "");
  assert.doesNotThrow(() => validateProfileAgent(piRequesterAuthorizedProfile, "pi"));
  assert.throws(() => validateProfileAgent(piRequesterAuthorizedProfile, "qwen"), /requires --agent pi/);
  assert.throws(() => validateProfileAgent(piRequesterAuthorizedProfile, "codex"), /requires --agent pi/);
  assert.throws(() => validateProfileAgent(piRequesterAuthorizedProfile, "hermes"), /requires --agent/);
});

test("profile state accepts any semver real Metric CLI version", () => {
  // A legitimate semver (v0.2.0) with a matching digest must be accepted.
  const semverReleaseSet = {
    ...stateFixture(piRequesterAuthorizedProfile).releaseSet,
    realMetricVersion: "v0.2.0"
  };
  semverReleaseSet.sha256 = piRequesterReleaseSetDigest(semverReleaseSet);
  assert.equal(
    profileFromState(stateFixture(piRequesterAuthorizedProfile, { releaseSet: semverReleaseSet })),
    piRequesterAuthorizedProfile
  );
  // A non-semver real Metric CLI version is rejected even with a matching digest.
  for (const realMetricVersion of ["v0.1", "0.1.0", "latest", "v0.1.0-contract"]) {
    const invalidReleaseSet = {
      ...stateFixture(piRequesterAuthorizedProfile).releaseSet,
      realMetricVersion
    };
    invalidReleaseSet.sha256 = piRequesterReleaseSetDigest(invalidReleaseSet);
    assert.equal(
      profileFromState(stateFixture(piRequesterAuthorizedProfile, { releaseSet: invalidReleaseSet })),
      ""
    );
  }
});

test("Pi requester installation verifies both platform-specific Metric CLI digests", () => {
  const releaseSet = stateFixture(piRequesterAuthorizedProfile).releaseSet;
  const installedTools = {
    "qdm-metric-cli": {
      version: releaseSet.publicMetricVersion,
      sha256: releaseSet.publicMetricSha256
    },
    "qdm-metric-cli-real": {
      version: releaseSet.realMetricVersion,
      sha256: releaseSet.realMetricSha256
    }
  };
  assert.doesNotThrow(() => verifyPiRequesterInstalledReleaseSet(installedTools, releaseSet));
  assert.throws(() => verifyPiRequesterInstalledReleaseSet({
    ...installedTools,
    "qdm-metric-cli": {
      ...installedTools["qdm-metric-cli"],
      sha256: "d".repeat(64)
    }
  }, releaseSet), /do not match the release-set/);
  assert.throws(() => verifyPiRequesterInstalledReleaseSet({
    ...installedTools,
    "qdm-metric-cli-real": {
      ...installedTools["qdm-metric-cli-real"],
      sha256: "d".repeat(64)
    }
  }, releaseSet), /do not match the release-set/);
});

test("Pi requester installer state no longer carries deployment authorization paths", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pi-requester-state-"));
  const workspace = path.join(temporary, "runtime");
  const previousEnvironment = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA
  };
  process.env.HOME = path.join(temporary, "home");
  process.env.XDG_STATE_HOME = path.join(temporary, "state");
  process.env.LOCALAPPDATA = path.join(temporary, "local-app-data");

  try {
    const expected = stateFixture(piRequesterAuthorizedProfile);
    const written = writeState(workspace, expected);
    const state = readInstallerState(workspace);

    assert.deepEqual(state, written);
    assert.deepEqual(state.releaseSet, expected.releaseSet);
    assert.equal(state.authzConfigPath, undefined);
    assert.equal(profileFromState(state), piRequesterAuthorizedProfile);
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
  fs.mkdirSync(path.join(workspace, ".harness", "index"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".harness", "index", "wikis-index.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, ".harness", "index", "wikis-runtime-index.json"), "{}\n");
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

  executable(path.join(workspace, "bin", binaryName("qdm-metric-cli")), "#!/bin/sh\nexit 7\n");
  const failedMetricReport = await collectDoctor(workspace);
  assert.equal(failedMetricReport.checks.find((check) => check.name === "bin/qdm-metric-cli runnable").ok, false);
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
  fs.mkdirSync(path.join(workspace, ".harness", "index"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".harness", "index", "wikis-index.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, ".harness", "index", "wikis-runtime-index.json"), "{}\n");
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
