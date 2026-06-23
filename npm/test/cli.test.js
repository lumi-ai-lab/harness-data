import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { binaryName, platformKey } from "../src/lib/platform.js";
import { defaultWorkspaceDir, userStatePath } from "../src/lib/paths.js";
import { packageVersion } from "../src/lib/package.js";
import { normalizeGitProtocol, protocolFromUrl } from "../src/lib/git-auth.js";
import { installToolsFromManifest, readManifest } from "../src/lib/manifest.js";
import { toolAssetName } from "../src/lib/tool-release.js";
import { buildAndCheck } from "../src/commands/install.js";
import { isNonBlockingUpdateDoctorCheck, updateWikis } from "../src/commands/update.js";
import { collectDoctor } from "../src/commands/doctor.js";
import { agentChoices, linkAgents, writeLocalConfig } from "../src/lib/config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "harness-data.js");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function reusableToolManifest(key) {
  return {
    schemaVersion: 2,
    tools: [{
      name: "data-harness-cli",
      binary: "data-harness-cli",
      repo: "lumi-ai-lab/harness-data",
      version: "v9.9.9",
      platforms: {
        [key]: {
          url: `https://127.0.0.1:1/data-harness-cli-v9.9.9-${key}.tar.gz`,
          sha256: ""
        }
      }
    }]
  };
}

test("prints help", () => {
  const result = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /harness-data <install\|update\|doctor\|version>/);
});

test("loads package version", () => {
  assert.equal(packageVersion(), pkg.version);
});

test("resolves platform and state paths", () => {
  assert.match(platformKey(), /^(darwin-arm64|darwin-amd64|linux-amd64|windows-amd64)$/);
  assert.equal(defaultWorkspaceDir(), process.cwd());
  assert.match(userStatePath(), /harness-data-installer/);
});

test("normalizes git protocol options", () => {
  assert.equal(normalizeGitProtocol(), "auto");
  assert.equal(normalizeGitProtocol("ssh"), "ssh");
  assert.equal(normalizeGitProtocol("https"), "https");
  assert.throws(() => normalizeGitProtocol("file"), /--git-protocol/);
});

test("detects git protocol from remote URLs", () => {
  assert.equal(protocolFromUrl("git@github.com:lumi-ai-lab/harness-data.git"), "ssh");
  assert.equal(protocolFromUrl("ssh://git@github.com/lumi-ai-lab/harness-data.git"), "ssh");
  assert.equal(protocolFromUrl("https://github.com/lumi-ai-lab/harness-data.git"), "https");
  assert.equal(protocolFromUrl("../harness-data-wikis"), "");
});

test("private qdm cli tools point at their own repositories", () => {
  const manifest = readManifest(path.join(root, "..", "bootstrap", "cli-manifest.json"));
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("qdm-cmr-cli").repo, "pengmide/qdm-cmr-cli");
  assert.equal(byName.get("qdm-indicators-cli").repo, "pengmide/qdm-indicators-cli");
  assert.equal(byName.get("cas-cli").repo, "pengmide/qdm-cas-cli");
  assert.equal(byName.get("qdm-cmr-cli").private, true);
  assert.equal(byName.get("qdm-indicators-cli").private, true);
  assert.equal(byName.get("cas-cli").private, true);
});

test("tool manifest is a latest-release install catalog", () => {
  const manifest = readManifest(path.join(root, "..", "bootstrap", "cli-manifest.json"));
  assert.equal(manifest.schemaVersion, 2);
  const tool = manifest.tools.find((item) => item.name === "data-harness-cli");
  assert.equal(toolAssetName(tool, "v1.2.3", "linux-amd64"), "data-harness-cli-v1.2.3-linux-amd64.tar.gz");
  assert.equal(toolAssetName(tool, "v1.2.3", "windows-amd64"), "data-harness-cli-v1.2.3-windows-amd64.zip");
  assert.equal(tool.version, undefined);
  assert.equal(tool.platforms["linux-amd64"].url, undefined);
});

test("install skips CLI download when installed binary matches latest state", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binary = "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(path.join(binDir, binaryName("data-harness-cli")), binary, { mode: 0o755 });

  const manifest = await installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
    log: false,
    manifestOverride: reusableToolManifest(key),
    state: {
      tools: {
        "data-harness-cli": {
          version: "v9.9.9",
          asset: `data-harness-cli-v9.9.9-${key}.tar.gz`,
          sha256: sha256(binary),
          assetSha256: "archive-sha"
        }
      }
    }
  });

  assert.deepEqual(manifest.installedTools["data-harness-cli"], {
    version: "v9.9.9",
    asset: `data-harness-cli-v9.9.9-${key}.tar.gz`,
    sha256: sha256(binary),
    assetSha256: "archive-sha"
  });
});

test("install downloads CLI when installed binary sha does not match state", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, binaryName("data-harness-cli")), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  await assert.rejects(
    installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      log: false,
      manifestOverride: reusableToolManifest(key),
      state: {
        tools: {
          "data-harness-cli": {
            version: "v9.9.9",
            asset: `data-harness-cli-v9.9.9-${key}.tar.gz`,
            sha256: "not-the-binary-sha"
          }
        }
      }
    }),
    /ECONNREFUSED|connect/
  );
});

test("install downloads CLI when state is missing", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, binaryName("data-harness-cli")), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  await assert.rejects(
    installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      log: false,
      manifestOverride: reusableToolManifest(key)
    }),
    /ECONNREFUSED|connect/
  );
});

test("install force downloads CLI even when installed binary matches state", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binary = "#!/bin/sh\nexit 0\n";
  fs.writeFileSync(path.join(binDir, binaryName("data-harness-cli")), binary, { mode: 0o755 });

  await assert.rejects(
    installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      force: true,
      log: false,
      manifestOverride: reusableToolManifest(key),
      state: {
        tools: {
          "data-harness-cli": {
            version: "v9.9.9",
            asset: `data-harness-cli-v9.9.9-${key}.tar.gz`,
            sha256: sha256(binary)
          }
        }
      }
    }),
    /ECONNREFUSED|connect/
  );
});

test("local config exports workspace CAS config dir", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));

  writeLocalConfig(workspace, { overwrite: true });

  const env = fs.readFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), "utf8");
  const casDir = path.join(workspace, ".qdm-auth", "cas").replaceAll("\\", "/");
  assert.match(env, new RegExp(`export QDM_CAS_CONFIG_DIR="${casDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
});

test("agent choices include OpenClaw, Hermes, both, and all", () => {
  assert.deepEqual(agentChoices, ["claude", "codex", "pi", "openclaw", "hermes", "both", "all"]);
});

test("links selected agent templates", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  for (const name of ["claude", "codex", "pi", "openclaw", "hermes"]) {
    fs.mkdirSync(path.join(workspace, "agents", name), { recursive: true });
  }

  const openclaw = linkAgents(workspace, "openclaw");
  assert.deepEqual(openclaw, [["agents/openclaw", ".openclaw"]]);
  assert.equal(fs.realpathSync(path.join(workspace, ".openclaw")), fs.realpathSync(path.join(workspace, "agents", "openclaw")));

  const hermes = linkAgents(workspace, "hermes");
  assert.deepEqual(hermes, [["agents/hermes", ".hermes"]]);
  assert.equal(fs.realpathSync(path.join(workspace, ".hermes")), fs.realpathSync(path.join(workspace, "agents", "hermes")));

  const both = linkAgents(workspace, "both");
  assert.deepEqual(both, [["agents/claude", ".claude"], ["agents/codex", ".codex"]]);
  assert.equal(fs.realpathSync(path.join(workspace, ".claude")), fs.realpathSync(path.join(workspace, "agents", "claude")));
  assert.equal(fs.realpathSync(path.join(workspace, ".codex")), fs.realpathSync(path.join(workspace, "agents", "codex")));
  assert.equal(fs.existsSync(path.join(workspace, ".pi")), false);

  const all = linkAgents(workspace, "all");
  assert.deepEqual(all, [
    ["agents/claude", ".claude"],
    ["agents/codex", ".codex"],
    ["agents/pi", ".pi"],
    ["agents/openclaw", ".openclaw"],
    ["agents/hermes", ".hermes"],
  ]);
  assert.equal(fs.realpathSync(path.join(workspace, ".openclaw")), fs.realpathSync(path.join(workspace, "agents", "openclaw")));
  assert.equal(fs.realpathSync(path.join(workspace, ".hermes")), fs.realpathSync(path.join(workspace, "agents", "hermes")));
});

function createDoctorWorkspace(agent) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  for (const dir of [
    "agents/claude",
    "agents/codex",
    "agents/pi",
    "agents/openclaw",
    "agents/hermes",
    "bootstrap",
    "wikis/spec",
    "wikis/playbooks",
    "wikis/templates",
    "bin",
    ".qdm-auth/cas",
  ]) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }

  fs.writeFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "{}");
  fs.writeFileSync(path.join(workspace, ".qdm-auth", "cas", "credentials.enc"), "encrypted-test-credentials");
  for (const binary of ["data-harness-cli", "qdm-cmr-cli", "qdm-indicators-cli", "cas-cli"]) {
    fs.writeFileSync(path.join(workspace, "bin", binaryName(binary)), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  writeLocalConfig(workspace, { overwrite: true });
  linkAgents(workspace, agent);
  return workspace;
}

test("doctor accepts OpenClaw, Hermes, both, and all agent hooks", async () => {
  for (const agent of ["openclaw", "hermes", "both", "all"]) {
    const report = await collectDoctor(createDoctorWorkspace(agent));
    const agentChecks = report.checks.filter((check) => check.name.startsWith("Agent hook"));
    assert.ok(agentChecks.length > 0);
    assert.equal(agentChecks.every((check) => check.ok), true, agent);
  }
});

test("update doctor treats missing agent hooks as non-blocking only", async () => {
  assert.equal(isNonBlockingUpdateDoctorCheck({ name: "Agent hook" }), true);
  assert.equal(isNonBlockingUpdateDoctorCheck({ name: "Agent hook .openclaw" }), true);
  assert.equal(isNonBlockingUpdateDoctorCheck({ name: "CMR token" }), false);
  assert.equal(isNonBlockingUpdateDoctorCheck({ name: "bin/data-harness-cli" }), false);
});

test("skip wikis check passes skip checks to build-index", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const logPath = path.join(workspace, "calls.log");
  const cliPath = path.join(binDir, binaryName("data-harness-cli"));
  fs.writeFileSync(cliPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\n`, { mode: 0o755 });

  await buildAndCheck(workspace, { skipWikisCheck: true, yes: true });

  const calls = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.deepEqual(calls, [
    "wikis build-index --skip-checks"
  ]);
});

test("update wikis fetch uses GitHub token for HTTPS remotes", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const wikisDir = path.join(workspace, "wikis");
  const authLog = path.join(workspace, "auth.log");
  fs.mkdirSync(path.join(wikisDir, ".git"), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "git"), `#!/bin/sh
if [ "$1" = "-C" ]; then
  shift
  shift
fi
case "$1 $2 $3" in
  "remote get-url origin")
    echo "https://github.com/lumi-ai-lab/harness-data-wikis.git"
    ;;
  "fetch origin ")
    if [ -z "$GIT_ASKPASS" ]; then
      echo "missing askpass" >&2
      exit 2
    fi
    user="$("$GIT_ASKPASS" "Username for 'https://github.com':")"
    pass="$("$GIT_ASKPASS" "Password for 'https://$user@github.com':")"
    printf '%s:%s\\n' "$user" "$pass" > "${authLog}"
    ;;
  "rev-parse HEAD ")
    echo "0123456789abcdef"
    ;;
  "rev-parse origin/HEAD ")
    echo "0123456789abcdef"
    ;;
  *)
    echo "unexpected git args: $*" >&2
    exit 3
    ;;
esac
`, { mode: 0o755 });

  await updateWikis(workspace, {
    githubToken: "secret-token",
    env: { PATH: `${fakeBin}:${process.env.PATH || ""}` }
  }, { installMode: "github-token" });

  assert.equal(fs.readFileSync(authLog, "utf8").trim(), "x-access-token:secret-token");
});

test("build index prints concise Chinese summary", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const cliPath = path.join(binDir, binaryName("data-harness-cli"));
  fs.writeFileSync(cliPath, `#!/bin/sh\necho 'built .harness/index/wikis-index.json docs=264 recall=1592 runtime=.harness/index/wikis-runtime-index.json runtimeDocs=264 checksSkipped=true'\n`, { mode: 0o755 });

  const lines = [];
  const originalLog = console.log;
  try {
    console.log = (message = "") => lines.push(String(message));
    await buildAndCheck(workspace, { yes: true });
  } finally {
    console.log = originalLog;
  }

  assert.match(lines.join("\n"), /执行：data-harness-cli wikis build-index --skip-checks/);
  assert.match(lines.join("\n"), /通过：docs=264, recall=1592, runtimeDocs=264/);
});
