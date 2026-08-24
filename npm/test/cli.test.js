import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import fs from "node:fs";
import https from "node:https";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { binaryName, isExecutable, platformKey } from "../src/lib/platform.js";
import { defaultWorkspaceDir, readWorkspaceState, userStatePath, writeState } from "../src/lib/paths.js";
import { packageVersion } from "../src/lib/package.js";
import { normalizeGitProtocol, protocolFromUrl } from "../src/lib/git-auth.js";
import { download, installToolsFromManifest, readManifest } from "../src/lib/manifest.js";
import { downloadReleaseAsset } from "../src/lib/github.js";
import { giteeReleaseRepo, resolveLatestRelease, resolveLatestReleaseAssets, resolveReleaseSource } from "../src/lib/release-source.js";
import { resolveLatestTool, toolAssetName } from "../src/lib/tool-release.js";
import { buildAndCheck, collectInstallAccess, installCommand, installRuntimeBundle, installWikis, resolveLatestHarnessRelease, validateLocalWikisSource } from "../src/commands/install.js";
import { collectInstallAuth } from "../src/lib/install-auth.js";
import { collectReleaseArchivePassword, RELEASE_ARCHIVE_PASSWORD } from "../src/lib/release-password.js";
import { createInstallSession } from "../src/lib/install-session.js";
import { isNonBlockingUpdateDoctorCheck, restoreAgentHooksIfMissing, toolInstallMode, updateWikis, wikisInstallMode } from "../src/commands/update.js";
import { collectDoctor } from "../src/commands/doctor.js";
import {
  AUTH_OFF_PASSWORD,
  agentChoices,
  assertCodexAuthPlatform,
  ensureLocalAuthBlob,
  hasAnyAgentHook,
  linkAgents,
  localPathToolNames,
  localTestAuthBlobRel,
  localTestAuthFixtureRel,
  localTestAuthUserId,
  patchCodexHooksForWindows,
  qdmCliBinaries,
  readAuthzFromHarnessConfig,
  resolveAuthzForWrite,
  writeAuthBlob,
  writeLocalConfig,
} from "../src/lib/config.js";
import { chooseAgent } from "../src/lib/prompt.js";
import { run } from "../src/lib/exec.js";
import {
  agentIncludesWorkBuddy,
  assertWorkBuddyAuthPlatform,
  codeBuddyMinimumVersion,
  detectCodeBuddyVersion,
  detectWorkBuddyPluginEnabled,
  detectWorkBuddyVersion,
  inspectWorkBuddyAuth,
  inspectWorkBuddyPlugin,
  versionAtLeast,
} from "../src/lib/workbuddy.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "harness-data.js");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function runConfirm(input, optionsSource = "{}") {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { confirm } from "./src/lib/prompt.js";
const result = await confirm("Q?", ${optionsSource});
console.log(result ? "true" : "false");`
  ], { cwd: root, input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function terminalTextWidth(value) {
  return [...value].reduce((width, character) => (
    width + (/^[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]$/u.test(character) ? 2 : 1)
  ), 0);
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
  assert.doesNotMatch(result.stdout, /\bauth\b.*CAS/);
  assert.match(result.stdout, /--auth-blob/);
  assert.match(result.stdout, /--auth-user-id/);
  assert.match(result.stdout, /--data-auth/);
  assert.match(result.stdout, /--no-auth/);
  assert.match(result.stdout, /--auth-off-password/);
  assert.match(result.stdout, /--release-source/);
  assert.doesNotMatch(result.stdout, /--release-password/);
  assert.match(result.stdout, /HARNESS_RELEASE_SOURCE/);
  assert.doesNotMatch(result.stdout, /HARNESS_RELEASE_PASSWORD/);
});

test("release source command-line value overrides the environment and rejects invalid values", () => {
  const previous = process.env.HARNESS_RELEASE_SOURCE;
  process.env.HARNESS_RELEASE_SOURCE = "github";
  try {
    assert.equal(resolveReleaseSource({}), "github");
    assert.equal(resolveReleaseSource({ releaseSource: "gitee" }), "gitee");
    assert.equal(resolveReleaseSource({ releaseSource: "AUTO" }), "auto");
    assert.throws(() => resolveReleaseSource({ releaseSource: "mirror" }), /expected auto, gitee, or github/);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_RELEASE_SOURCE;
    else process.env.HARNESS_RELEASE_SOURCE = previous;
  }
});

test("invalid --release-source fails before install work starts", () => {
  const result = spawnSync(process.execPath, [bin, "install", "--release-source", "mirror"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid release source/);
});

test("confirm defaults to yes on empty input", () => {
  assert.equal(runConfirm("\n"), "true");
});

test("confirm defaultNo returns false on empty input", () => {
  assert.equal(runConfirm("\n", "{ defaultNo: true }"), "false");
});

test("confirm rejects n and no input", () => {
  assert.equal(runConfirm("n\n"), "false");
  assert.equal(runConfirm("no\n"), "false");
});

test("confirm yes option returns true", () => {
  assert.equal(runConfirm("", "{ yes: true }"), "true");
});

test("command failures redact sensitive arguments", async () => {
  await assert.rejects(
    run(process.execPath, ["-e", "process.exit(1)", "secret-value"], { sensitiveArgs: [2] }),
    (error) => {
      assert.match(error.message, /\*\*\*\*\*\*/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    }
  );
});

test("install and update use the built-in Release ZIP password", async () => {
  const previous = process.env.HARNESS_RELEASE_PASSWORD;
  process.env.HARNESS_RELEASE_PASSWORD = "ignored-password";
  try {
    assert.equal(RELEASE_ARCHIVE_PASSWORD, "qdm-dev");
    assert.equal(await collectReleaseArchivePassword({ yes: true }), RELEASE_ARCHIVE_PASSWORD);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_RELEASE_PASSWORD;
    else process.env.HARNESS_RELEASE_PASSWORD = previous;
  }
});

test("loads package version", () => {
  assert.equal(packageVersion(), pkg.version);
});

test("resolves platform and state paths", () => {
  assert.match(platformKey(), /^(darwin-arm64|linux-amd64|windows-(?:amd64|arm64))$/);
  assert.throws(() => platformKey("darwin", "x64"), /unsupported platform: darwin-amd64/);
  assert.equal(defaultWorkspaceDir(), process.cwd());
  assert.match(userStatePath(), /harness-data-installer/);
});

test("workspace installer state is local-first and does not leak across runtimes", () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "harness-state-first-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "harness-state-second-"));
  fs.mkdirSync(path.join(first, ".harness"), { recursive: true });
  fs.writeFileSync(path.join(first, ".harness", "installer-state.json"), JSON.stringify({ agent: "workbuddy", runtimeTag: "v-local" }));

  assert.deepEqual(readWorkspaceState(first, {
    userState: { lastInstallDir: second, agent: "pi", runtimeTag: "v-global" },
  }), { agent: "workbuddy", runtimeTag: "v-local" });
  assert.deepEqual(readWorkspaceState(second, {
    userState: { lastInstallDir: first, agent: "pi", runtimeTag: "v-global" },
  }), {});
  assert.deepEqual(readWorkspaceState(second, {
    userState: { lastInstallDir: second, agent: "pi", runtimeTag: "v-global" },
  }), { lastInstallDir: second, agent: "pi", runtimeTag: "v-global" });
});

test("writeState preserves workspace state and upgrades it to schema version 4", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-state-write-"));
  fs.mkdirSync(path.join(workspace, ".harness"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".harness", "installer-state.json"), JSON.stringify({ agent: "workbuddy", runtimeTag: "v-local" }));

  const state = writeState(workspace, { packageVersion: "0.0.test" });
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.agent, "workbuddy");
  assert.equal(state.runtimeTag, "v-local");
  assert.equal(state.packageVersion, "0.0.test");
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
  assert.deepEqual([...byName.keys()], ["data-harness-cli", "qdm-metric-cli"]);
  assert.equal(byName.get("qdm-metric-cli").repo, "pengmide/qdm-metric-cli");
  assert.equal(byName.get("qdm-metric-cli").private, true);
  assert.equal(byName.has("qdm-cmr-cli"), false);
  assert.equal(byName.has("qdm-indicators-cli"), false);
  assert.equal(byName.has("qdm-sql-cli"), false);
  assert.equal(byName.has("cas-cli"), false);
});

test("qdm cli binary lists include metric cli only", () => {
  assert.deepEqual(qdmCliBinaries, [
    "data-harness-cli",
    "qdm-metric-cli",
  ]);
  assert.deepEqual(localPathToolNames, [
    "qdm-metric-cli",
  ]);
});

test("local wikis source requires root index", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-wikis-"));
  for (const dir of ["metrics", "reports", "dims", "rules"]) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  assert.throws(() => validateLocalWikisSource(workspace), /missing index\.md/);
  fs.writeFileSync(path.join(workspace, "index.md"), "# Wikis\n");
  assert.doesNotThrow(() => validateLocalWikisSource(workspace));
});

test("tool manifest is a latest-release install catalog", () => {
  const manifest = readManifest(path.join(root, "..", "bootstrap", "cli-manifest.json"));
  assert.equal(manifest.schemaVersion, 2);
  const tool = manifest.tools.find((item) => item.name === "data-harness-cli");
  assert.equal(toolAssetName(tool, "v1.2.3", "linux-amd64"), "data-harness-cli-v1.2.3-linux-amd64.zip");
  assert.equal(toolAssetName(tool, "v1.2.3", "darwin-arm64"), "data-harness-cli-v1.2.3-darwin-arm64.zip");
  assert.equal(toolAssetName(tool, "v1.2.3", "windows-amd64"), "data-harness-cli-v1.2.3-windows-amd64.zip");
  assert.equal(toolAssetName(tool, "v1.2.3", "windows-arm64"), "data-harness-cli-v1.2.3-windows-arm64.zip");
  for (const item of manifest.tools) {
    assert.equal(item.platforms["windows-arm64"]?.archive, "zip", `${item.name} missing Windows ARM64 asset`);
    assert.equal(item.platforms["linux-amd64"]?.archive, "zip", `${item.name} missing Linux ZIP asset`);
    assert.equal(item.platforms["darwin-arm64"]?.archive, "zip", `${item.name} missing Apple Silicon ZIP asset`);
    assert.equal(item.platforms["darwin-amd64"], undefined, `${item.name} must not publish Intel Mac assets`);
  }
  assert.equal(tool.version, undefined);
  assert.equal(tool.platforms["linux-amd64"].url, undefined);
});

test("latest tool resolution prefers ZIP assets and falls back to legacy tar.gz", async () => {
  const key = "linux-amd64";
  const tool = {
    name: "data-harness-cli",
    binary: "data-harness-cli",
    repo: "lumi-ai-lab/harness-data",
    platforms: { [key]: { archive: "tar.gz" } }
  };
  let assets = [
    { name: "data-harness-cli-v2.0.0-linux-amd64.tar.gz", browser_download_url: "https://fixtures.test/tool.tar.gz" },
    { name: "data-harness-cli-v2.0.0-linux-amd64.zip", browser_download_url: "https://fixtures.test/tool.zip" }
  ];
  const originalGet = https.get;
  try {
    https.get = (_url, _options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end(JSON.stringify({ tag_name: "v2.0.0", assets }));
      });
      return request;
    };

    const zip = await resolveLatestTool(tool, key, { githubToken: "fixture-token" });
    assert.deepEqual(zip.platforms[key], {
      url: "https://fixtures.test/tool.zip",
      name: "data-harness-cli-v2.0.0-linux-amd64.zip",
      releaseSource: "gitee",
      archive: "zip"
    });

    assets = [{ name: "data-harness-cli-v2.0.0-linux-amd64.tar.gz", browser_download_url: "https://fixtures.test/tool.tar.gz" }];
    const legacy = await resolveLatestTool(tool, key, { githubToken: "fixture-token" });
    assert.deepEqual(legacy.platforms[key], {
      url: "https://fixtures.test/tool.tar.gz",
      name: "data-harness-cli-v2.0.0-linux-amd64.tar.gz",
      releaseSource: "gitee",
      archive: "tar.gz"
    });
  } finally {
    https.get = originalGet;
  }
});

test("Gitee Release mirrors use exact assets for runtime and both CLI repositories", async () => {
  const key = "linux-amd64";
  const urls = [];
  const originalGet = https.get;
  try {
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      urls.push(String(url));
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        const text = String(url);
        if (text.includes("harness-metric-release")) {
          response.end(JSON.stringify({
            tag_name: "v-metric",
            assets: [
              { name: "Source code (zip)", browser_download_url: "https://gitee.test/source.zip" },
              { name: `qdm-metric-cli-v-metric-${key}.zip`, browser_download_url: "https://gitee.test/qdm.zip" }
            ]
          }));
          return;
        }
        response.end(JSON.stringify({
          tag_name: "v-runtime",
          assets: [
            { name: "Source code (zip)", browser_download_url: "https://gitee.test/source.zip" },
            { name: "harness-data-runtime-v-runtime.zip", browser_download_url: "https://gitee.test/runtime.zip" },
            { name: "harness-data-wikis-v-runtime.zip", browser_download_url: "https://gitee.test/wikis.zip" },
            { name: `data-harness-cli-v-runtime-${key}.zip`, browser_download_url: "https://gitee.test/data.zip" }
          ]
        }));
      });
      return request;
    };

    const runtime = await resolveLatestRelease("lumi-ai-lab/harness-data", (tag) => [
      `harness-data-runtime-${tag}.zip`
    ], { releaseSource: "gitee" });
    const harness = await resolveLatestHarnessRelease({ releaseSource: "gitee" });
    const data = await resolveLatestTool({
      name: "data-harness-cli",
      binary: "data-harness-cli",
      repo: "lumi-ai-lab/harness-data",
      platforms: { [key]: { archive: "zip" } }
    }, key, { releaseSource: "gitee" });
    const qdm = await resolveLatestTool({
      name: "qdm-metric-cli",
      binary: "qdm-metric-cli",
      repo: "pengmide/qdm-metric-cli",
      private: true,
      platforms: { [key]: { archive: "zip" } }
    }, key, { releaseSource: "gitee" });

    assert.equal(giteeReleaseRepo("lumi-ai-lab/harness-data"), "git_pengmd/harness-release");
    assert.equal(giteeReleaseRepo("pengmide/qdm-metric-cli"), "git_pengmd/harness-metric-release");
    assert.equal(runtime.source, "gitee");
    assert.equal(runtime.asset.name, "harness-data-runtime-v-runtime.zip");
    assert.equal(harness.assets.runtime.name, "harness-data-runtime-v-runtime.zip");
    assert.equal(harness.assets.wikis.name, "harness-data-wikis-v-runtime.zip");
    assert.equal(data.platforms[key].url, "https://gitee.test/data.zip");
    assert.equal(qdm.platforms[key].url, "https://gitee.test/qdm.zip");
    assert.equal(urls.every((url) => url.startsWith("https://gitee.com/api/v5/repos/")), true);
    assert.equal(urls.some((url) => url.includes("git_pengmd/harness-release")), true);
    assert.equal(urls.some((url) => url.includes("git_pengmd/harness-metric-release")), true);
  } finally {
    https.get = originalGet;
  }
});

test("auto Release source prefers Gitee and falls back to GitHub only when the attachment is missing", async () => {
  const target = "harness-data-runtime-v-auto.zip";
  const originalGet = https.get;
  const urls = [];
  let missingGiteeAsset = false;
  try {
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      urls.push(String(url));
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        if (String(url).startsWith("https://gitee.com/")) {
          response.end(JSON.stringify({
            tag_name: "v-auto",
            assets: missingGiteeAsset
              ? [{ name: "Source code (zip)", browser_download_url: "https://gitee.test/source.zip" }]
              : [{ name: target, browser_download_url: "https://gitee.test/runtime.zip" }]
          }));
          return;
        }
        response.end(JSON.stringify({
          tag_name: "v-auto",
          assets: [{ name: target, browser_download_url: "https://github.test/runtime.zip" }]
        }));
      });
      return request;
    };

    const gitee = await resolveLatestRelease("lumi-ai-lab/harness-data", [target], {
      releaseSource: "auto",
      githubToken: "fixture-token"
    });
    assert.equal(gitee.source, "gitee");
    assert.deepEqual(urls, ["https://gitee.com/api/v5/repos/git_pengmd/harness-release/releases/latest"]);

    missingGiteeAsset = true;
    urls.length = 0;
    const github = await resolveLatestRelease("lumi-ai-lab/harness-data", [target], {
      releaseSource: "auto",
      githubToken: "fixture-token"
    });
    assert.equal(github.source, "github");
    assert.deepEqual(urls, [
      "https://gitee.com/api/v5/repos/git_pengmd/harness-release/releases/latest",
      "https://api.github.com/repos/lumi-ai-lab/harness-data/releases/latest"
    ]);
  } finally {
    https.get = originalGet;
  }
});

test("auto Release source keeps runtime and Wikis on one complete provider release", async () => {
  const runtimeAsset = "harness-data-runtime-v-group.zip";
  const wikisAsset = "harness-data-wikis-v-group.zip";
  const urls = [];
  const originalGet = https.get;
  try {
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      urls.push(String(url));
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        if (String(url).startsWith("https://gitee.com/")) {
          response.end(JSON.stringify({
            tag_name: "v-group",
            assets: [{ name: runtimeAsset, browser_download_url: "https://gitee.test/runtime.zip" }]
          }));
          return;
        }
        response.end(JSON.stringify({
          tag_name: "v-group",
          assets: [
            { name: runtimeAsset, browser_download_url: "https://github.test/runtime.zip" },
            { name: wikisAsset, browser_download_url: "https://github.test/wikis.zip" }
          ]
        }));
      });
      return request;
    };

    const resolved = await resolveLatestReleaseAssets("lumi-ai-lab/harness-data", {
      runtime: [runtimeAsset],
      wikis: [wikisAsset]
    }, { releaseSource: "auto", githubToken: "fixture-token" });
    assert.equal(resolved.source, "github");
    assert.equal(resolved.assets.runtime.downloadUrl, "https://github.test/runtime.zip");
    assert.equal(resolved.assets.wikis.downloadUrl, "https://github.test/wikis.zip");
    assert.deepEqual(urls, [
      "https://gitee.com/api/v5/repos/git_pengmd/harness-release/releases/latest",
      "https://api.github.com/repos/lumi-ai-lab/harness-data/releases/latest"
    ]);
  } finally {
    https.get = originalGet;
  }
});

test("auto Release source falls back to GitHub when the Gitee API is unavailable", async () => {
  const target = "harness-data-runtime-v-api-fallback.zip";
  const originalGet = https.get;
  const urls = [];
  try {
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      urls.push(String(url));
      process.nextTick(() => {
        const response = new PassThrough();
        response.headers = {};
        if (String(url).startsWith("https://gitee.com/")) {
          response.statusCode = 404;
          callback(response);
          response.end("not found");
          return;
        }
        response.statusCode = 200;
        callback(response);
        response.end(JSON.stringify({
          tag_name: "v-api-fallback",
          assets: [{ name: target, browser_download_url: "https://github.test/runtime.zip" }]
        }));
      });
      return request;
    };

    const resolved = await resolveLatestRelease("lumi-ai-lab/harness-data", [target], {
      releaseSource: "auto",
      githubToken: "fixture-token"
    });
    assert.equal(resolved.source, "github");
    assert.deepEqual(urls, [
      "https://gitee.com/api/v5/repos/git_pengmd/harness-release/releases/latest",
      "https://api.github.com/repos/lumi-ai-lab/harness-data/releases/latest"
    ]);
  } finally {
    https.get = originalGet;
  }
});

test("forced Release sources never fall back to the other provider", async () => {
  const target = "harness-data-runtime-v-forced.zip";
  const originalGet = https.get;
  const urls = [];
  try {
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      urls.push(String(url));
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end(JSON.stringify({ tag_name: "v-forced", assets: [] }));
      });
      return request;
    };

    await assert.rejects(
      resolveLatestRelease("lumi-ai-lab/harness-data", [target], { releaseSource: "gitee" }),
      /Gitee Release lookup failed/
    );
    assert.deepEqual(urls, ["https://gitee.com/api/v5/repos/git_pengmd/harness-release/releases/latest"]);

    urls.length = 0;
    await assert.rejects(
      resolveLatestRelease("lumi-ai-lab/harness-data", [target], { releaseSource: "github", githubToken: "fixture-token" }),
      /GitHub Release lookup failed/
    );
    assert.deepEqual(urls, ["https://api.github.com/repos/lumi-ai-lab/harness-data/releases/latest"]);
  } finally {
    https.get = originalGet;
  }
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
          sha256: sha256(binary)
        }
      }
    }
  });

  assert.deepEqual(manifest.installedTools["data-harness-cli"], {
    version: "v9.9.9",
    asset: `data-harness-cli-v9.9.9-${key}.tar.gz`,
    sha256: sha256(binary)
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
    /ECONNREFUSED|connect|PROXY_TUNNEL|tunnel/
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
    /ECONNREFUSED|connect|PROXY_TUNNEL|tunnel/
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
    /ECONNREFUSED|connect|PROXY_TUNNEL|tunnel/
  );
});

test("install fails on archive extraction failure without accepting old binary", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const binDir = path.join(workspace, "bin");
  const archive = "not a real tar\n";
  const oldBinary = "#!/bin/sh\necho old\n";
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, binaryName("data-harness-cli")), oldBinary, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "tar"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dir)
        shift
        dir="$1"
        ;;
      --pattern)
        shift
        pattern="$1"
        ;;
    esac
    shift
  done
  printf '%s' '${archive.replaceAll("'", "'\\''")}' > "$dir/$pattern"
  exit 0
fi
exit 3
`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    await assert.rejects(
      installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
        log: false,
        manifestOverride: {
          schemaVersion: 2,
          tools: [{
            name: "data-harness-cli",
            binary: "data-harness-cli",
            repo: "lumi-ai-lab/harness-data",
            private: true,
            version: "v-new",
            platforms: {
              [key]: {
                url: `https://github.com/lumi-ai-lab/harness-data/releases/download/v-new/data-harness-cli-v-new-${key}.tar.gz`,
                sha256: sha256(archive)
              }
            }
          }]
        }
      }),
      /tar .* failed/
    );
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(fs.readFileSync(path.join(binDir, binaryName("data-harness-cli")), "utf8"), oldBinary);
});

test("runtime bundle prioritizes encrypted ZIP and falls back to legacy tar.gz", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-runtime-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const password = "runtime-release-password";
  const urls = [];
  let assets = [
    { name: "harness-data-runtime-v-runtime.zip", url: "https://fixtures.test/runtime.zip" },
    { name: "harness-data-runtime-v-runtime.tar.gz", url: "https://fixtures.test/runtime.tar.gz" }
  ];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "unzip"), `#!/bin/sh
if [ "$1" != "-P" ] || [ "$2" != "${password}" ]; then
  echo "bad password: $2" >&2
  exit 9
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    dir="$1"
  fi
  shift
done
mkdir -p "$dir/agents" "$dir/bootstrap" "$dir/config"
printf 'zip agents\\n' > "$dir/agents/source.txt"
printf '{}' > "$dir/bootstrap/cli-manifest.json"
printf 'zip config\\n' > "$dir/config/harness-config.yaml.example"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "tar"), "#!/bin/sh\necho tar should not run >&2\nexit 9\n", { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      urls.push(String(url));
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        if (String(url).endsWith("/releases/latest")) {
          response.end(JSON.stringify({ tag_name: "v-runtime", assets }));
          return;
        }
        response.end("runtime archive fixture");
      });
      return request;
    };

    await installRuntimeBundle(workspace, {
      force: true,
      githubToken: "fixture-token",
      log: false,
      _releaseArchivePassword: password
    });
    assert.equal(fs.readFileSync(path.join(workspace, "agents", "source.txt"), "utf8"), "zip agents\n");
    assert.equal(urls.some((url) => url.endsWith("runtime.zip")), true);
    assert.equal(urls.some((url) => url.endsWith("runtime.tar.gz")), false);

    const legacyWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-runtime-legacy-"));
    assets = [{ name: "harness-data-runtime-v-runtime.tar.gz", url: "https://fixtures.test/runtime.tar.gz" }];
    urls.length = 0;
    fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
mkdir -p "$dir/agents" "$dir/bootstrap" "$dir/config"
printf 'tar agents\\n' > "$dir/agents/source.txt"
printf '{}' > "$dir/bootstrap/cli-manifest.json"
printf 'tar config\\n' > "$dir/config/harness-config.yaml.example"
`, { mode: 0o755 });
    await installRuntimeBundle(legacyWorkspace, { force: true, githubToken: "fixture-token", log: false });
    assert.equal(fs.readFileSync(path.join(legacyWorkspace, "agents", "source.txt"), "utf8"), "tar agents\n");
    assert.equal(urls.some((url) => url.endsWith("runtime.tar.gz")), true);
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("encrypted ZIP CLI install uses the release password and never requests .sha256", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const password = "release-password-for-test";
  const binary = "#!/bin/sh\necho encrypted\n";
  const urls = [];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "unzip"), `#!/bin/sh
if [ "$1" != "-P" ] || [ "$2" != "${password}" ]; then
  echo "wrong password: $2" >&2
  exit 9
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    dir="$1"
  fi
  shift
done
mkdir -p "$dir"
printf '%s' '${binary.replaceAll("'", "'\\''")}' > "$dir/${binaryName("data-harness-cli")}"
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      urls.push(String(url));
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end("encrypted zip fixture");
      });
      return request;
    };

    const manifest = await installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      log: false,
      _releaseArchivePassword: password,
      manifestOverride: {
        schemaVersion: 2,
        tools: [{
          name: "data-harness-cli",
          binary: "data-harness-cli",
          version: "v-encrypted",
          platforms: {
            [key]: { url: `https://fixtures.test/data-harness-cli-v-encrypted-${key}.zip`, archive: "zip" }
          }
        }]
      }
    });

    assert.equal(fs.readFileSync(path.join(workspace, "bin", binaryName("data-harness-cli")), "utf8"), binary);
    assert.deepEqual(manifest.installedTools["data-harness-cli"], {
      version: "v-encrypted",
      asset: `data-harness-cli-v-encrypted-${key}.zip`,
      sha256: sha256(binary)
    });
    const state = writeState(workspace, { tools: manifest.installedTools });
    assert.doesNotMatch(JSON.stringify(state), new RegExp(password));
    assert.doesNotMatch(
      fs.readFileSync(path.join(workspace, ".harness", "installer-state.json"), "utf8"),
      new RegExp(password)
    );
    assert.equal(urls.some((url) => url.endsWith(".sha256")), false);
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("encrypted ZIP password failures redact the password and roll back the previous binary", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const password = "release-password-must-not-leak";
  const binDir = path.join(workspace, "bin");
  const oldBinary = "#!/bin/sh\necho old\n";
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, binaryName("data-harness-cli")), oldBinary, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "unzip"), "#!/bin/sh\necho \"bad password: $2\" >&2\nexit 9\n", { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (_url, _options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end("encrypted zip fixture");
      });
      return request;
    };

    await assert.rejects(
      installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
        log: false,
        _releaseArchivePassword: password,
        manifestOverride: {
          schemaVersion: 2,
          tools: [{
            name: "data-harness-cli",
            binary: "data-harness-cli",
            version: "v-encrypted",
            platforms: {
              [key]: { url: `https://fixtures.test/data-harness-cli-v-encrypted-${key}.zip`, archive: "zip" }
            }
          }]
        }
      }),
      (error) => {
        assert.match(error.message, /unzip -P \*\*\*\*\*\*/);
        assert.doesNotMatch(error.message, new RegExp(password));
        return true;
      }
    );
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
  assert.equal(fs.readFileSync(path.join(binDir, binaryName("data-harness-cli")), "utf8"), oldBinary);
});

test("Gitee can install the private qdm CLI without a GitHub token", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-gitee-qdm-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const asset = `qdm-metric-cli-v-gitee-${key}.tar.gz`;
  const requests = [];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
printf '%s' '#!/bin/sh\\necho gitee-qdm\\n' > "$dir/${binaryName("qdm-metric-cli")}"
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, options, callback) => {
      requests.push({ url: String(url), authorization: options.headers?.Authorization });
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end("qdm archive");
      });
      return request;
    };

    const installed = await installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      githubToken: "must-not-be-used",
      log: false,
      manifestOverride: {
        schemaVersion: 2,
        tools: [{
          name: "qdm-metric-cli",
          binary: "qdm-metric-cli",
          private: true,
          version: "v-gitee",
          platforms: {
            [key]: {
              url: `https://gitee.com/git_pengmd/harness-metric-release/releases/download/v-gitee/${asset}`,
              name: asset,
              releaseSource: "gitee",
              archive: "tar.gz"
            }
          }
        }]
      }
    });

    assert.equal(installed.installedTools["qdm-metric-cli"].version, "v-gitee");
    assert.equal(fs.existsSync(path.join(workspace, "bin", binaryName("qdm-metric-cli"))), true);
    assert.deepEqual(requests, [{
      url: `https://gitee.com/git_pengmd/harness-metric-release/releases/download/v-gitee/${asset}`,
      authorization: undefined
    }]);
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("Gitee Release installs encrypted Wikis without GitHub access", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-gitee-wikis-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const password = "wikis-release-password";
  const requests = [];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "unzip"), [
    "#!/bin/sh",
    'if [ "$1" != "-P" ] || [ "$2" != "' + password + '" ]; then',
    "  exit 9",
    "fi",
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "-d" ]; then',
    "    shift",
    '    dir="$1"',
    "  fi",
    "  shift",
    "done",
    'mkdir -p "$dir/metrics" "$dir/reports" "$dir/dims" "$dir/rules"',
    'echo release-wikis > "$dir/index.md"'
  ].join("\n"), { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = fakeBin + ":" + (originalPath || "");
    https.get = (url, options, callback) => {
      requests.push({ url: String(url), authorization: options.headers?.Authorization });
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end("encrypted wikis archive");
      });
      return request;
    };

    const installed = await installWikis(workspace, {
      githubToken: "must-not-be-used",
      log: false,
      _releaseArchivePassword: password,
      _harnessRelease: {
        source: "gitee",
        tag: "v-wikis",
        assets: {
          wikis: {
            name: "harness-data-wikis-v-wikis.zip",
            downloadUrl: "https://gitee.test/harness-data-wikis-v-wikis.zip",
            releaseSource: "gitee"
          }
        }
      }
    });

    assert.equal(installed.mode, "release");
    assert.equal(installed.tag, "v-wikis");
    assert.equal(fs.readFileSync(path.join(workspace, "wikis", "index.md"), "utf8").trim(), "release-wikis");
    assert.deepEqual(requests, [{
      url: "https://gitee.test/harness-data-wikis-v-wikis.zip",
      authorization: undefined
    }]);
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("Wikis Release password failure keeps the previous Wikis directory", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-wikis-rollback-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const password = "wikis-password-must-not-leak";
  const wikis = path.join(workspace, "wikis");
  fs.mkdirSync(path.join(wikis, "metrics"), { recursive: true });
  fs.mkdirSync(path.join(wikis, "reports"), { recursive: true });
  fs.mkdirSync(path.join(wikis, "dims"), { recursive: true });
  fs.mkdirSync(path.join(wikis, "rules"), { recursive: true });
  fs.writeFileSync(path.join(wikis, "index.md"), "old-wikis\n");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "unzip"), ["#!/bin/sh", "exit 9"].join("\n"), { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = fakeBin + ":" + (originalPath || "");
    https.get = (_url, _options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end("encrypted wikis archive");
      });
      return request;
    };

    await assert.rejects(
      installWikis(workspace, {
        log: false,
        _releaseArchivePassword: password,
        _harnessRelease: {
          source: "gitee",
          tag: "v-wikis",
          assets: {
            wikis: {
              name: "harness-data-wikis-v-wikis.zip",
              downloadUrl: "https://gitee.test/harness-data-wikis-v-wikis.zip",
              releaseSource: "gitee"
            }
          }
        }
      }),
      (error) => {
        assert.match(error.message, /unzip -P \*\*\*\*\*\*/);
        assert.doesNotMatch(error.message, new RegExp(password));
        return true;
      }
    );
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
  assert.equal(fs.readFileSync(path.join(wikis, "index.md"), "utf8"), "old-wikis\n");
});

test("auto source does not switch away from Gitee after a ZIP extraction failure", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-gitee-runtime-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const password = "gitee-password";
  const calls = [];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "unzip"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, _options, callback) => {
      calls.push(String(url));
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        if (String(url).endsWith("/releases/latest")) {
          response.end(JSON.stringify({
            tag_name: "v-gitee",
            assets: [{
              name: "harness-data-runtime-v-gitee.zip",
              browser_download_url: "https://gitee.test/harness-data-runtime-v-gitee.zip"
            }]
          }));
          return;
        }
        response.end("runtime archive");
      });
      return request;
    };

    await assert.rejects(
      installRuntimeBundle(workspace, {
        force: true,
        releaseSource: "auto",
        githubToken: "fixture-token",
        log: false,
        _releaseArchivePassword: password
      }),
      /unzip -P \*\*\*\*\*\*/
    );
    assert.deepEqual(calls, [
      "https://gitee.com/api/v5/repos/git_pengmd/harness-release/releases/latest",
      "https://gitee.test/harness-data-runtime-v-gitee.zip"
    ]);
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("public GitHub asset falls back to anonymous download when token API fails", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const archive = "fake archive\n";
  const binary = "#!/bin/sh\necho new\n";
  const calls = [];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
printf '%s' '${binary.replaceAll("'", "'\\''")}' > "$dir/${binaryName("data-harness-cli")}"
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = fakeBin;
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      calls.push(String(url));
      process.nextTick(() => {
        const response = new PassThrough();
        response.headers = {};
        if (String(url).startsWith("https://api.github.com/")) {
          response.statusCode = 401;
          callback(response);
          response.end("bad credentials");
          return;
        }
        response.statusCode = 200;
        callback(response);
        response.end(archive);
      });
      return request;
    };

    const manifest = await installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      githubToken: "bad-token",
      log: false,
      manifestOverride: {
        schemaVersion: 2,
        tools: [{
          name: "data-harness-cli",
          binary: "data-harness-cli",
          repo: "lumi-ai-lab/harness-data",
          version: "v-new",
          platforms: {
            [key]: {
              url: `https://github.com/lumi-ai-lab/harness-data/releases/download/v-new/data-harness-cli-v-new-${key}.tar.gz`,
              sha256: sha256(archive)
            }
          }
        }]
      }
    });

    assert.equal(manifest.installedTools["data-harness-cli"].version, "v-new");
    assert.equal(fs.readFileSync(path.join(workspace, "bin", binaryName("data-harness-cli")), "utf8"), binary);
    assert.deepEqual(calls, [
      "https://api.github.com/repos/lumi-ai-lab/harness-data/releases/tags/v-new",
      `https://github.com/lumi-ai-lab/harness-data/releases/download/v-new/data-harness-cli-v-new-${key}.tar.gz`
    ]);
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("private GitHub asset uses gh token download progress", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const archive = "private archive\n";
  const binary = "#!/bin/sh\necho private\n";
  const assetFile = `fixture-private-cli-v0.0.1-${key}.tar.gz`;
  const writes = [];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  echo "gh-test-token"
  exit 0
fi
exit 9
`, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
printf '%s' '${binary.replaceAll("'", "'\\''")}' > "$dir/${binaryName("fixture-private-cli")}"
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = fakeBin;
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = String(url).includes("/releases/assets/1")
          ? { "content-length": String(Buffer.byteLength(archive)) }
          : {};
        callback(response);
        if (String(url).includes("/releases/tags/v0.0.1")) {
          response.end(JSON.stringify({
            assets: [{ name: assetFile, url: "https://api.github.com/repos/pengmide/fixture-private-cli/releases/assets/1" }]
          }));
          return;
        }
        response.end(archive);
      });
      return request;
    };

    const manifest = await installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      log: false,
      manifestOverride: {
        schemaVersion: 2,
        tools: [{
          name: "fixture-private-cli",
          binary: "fixture-private-cli",
          repo: "pengmide/fixture-private-cli",
          private: true,
          version: "v0.0.1",
          platforms: {
            [key]: {
              url: `https://github.com/pengmide/fixture-private-cli/releases/download/v0.0.1/${assetFile}`,
              sha256: sha256(archive)
            }
          }
        }]
      },
      progressWriter: { write: (chunk) => writes.push(String(chunk)) }
    });

    assert.equal(manifest.installedTools["fixture-private-cli"].version, "v0.0.1");
    assert.equal(fs.readFileSync(path.join(workspace, "bin", binaryName("fixture-private-cli")), "utf8"), binary);
    assert.match(writes.join(""), new RegExp(`下载完成 ${assetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(writes.join(""), new RegExp(`100% ${Buffer.byteLength(archive)} B/${Buffer.byteLength(archive)} B`));
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("private GitHub asset fallback via gh release download shows status", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const archive = "private archive via gh\n";
  const binary = "#!/bin/sh\necho private-gh\n";
  const assetFile = `fixture-private-cli-v0.0.1-${key}.tar.gz`;
  const writes = [];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  echo "gh-test-token"
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dir)
        shift
        dir="$1"
        ;;
      --pattern)
        shift
        pattern="$1"
        ;;
    esac
    shift
  done
  printf '%s' '${archive.replaceAll("'", "'\\''")}' > "$dir/$pattern"
  exit 0
fi
exit 9
`, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
printf '%s' '${binary.replaceAll("'", "'\\''")}' > "$dir/${binaryName("fixture-private-cli")}"
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = fakeBin;
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => request.emit("error", new Error("getaddrinfo ENOTFOUND api.github.com")));
      return request;
    };

    const manifest = await installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      log: false,
      manifestOverride: {
        schemaVersion: 2,
        tools: [{
          name: "fixture-private-cli",
          binary: "fixture-private-cli",
          repo: "pengmide/fixture-private-cli",
          private: true,
          version: "v0.0.1",
          platforms: {
            [key]: {
              url: `https://github.com/pengmide/fixture-private-cli/releases/download/v0.0.1/${assetFile}`,
              sha256: sha256(archive)
            }
          }
        }]
      },
      progressWriter: { write: (chunk) => writes.push(String(chunk)) }
    });

    assert.equal(manifest.installedTools["fixture-private-cli"].version, "v0.0.1");
    assert.equal(fs.readFileSync(path.join(workspace, "bin", binaryName("fixture-private-cli")), "utf8"), binary);
    assert.match(writes.join(""), /下载中 [-\\|/]/);
    assert.match(writes.join(""), new RegExp(`下载完成 ${assetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(writes.join(""), /\u001b\[1A/);
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("private GitHub asset failure reports gh release download detail", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const assetFile = `fixture-private-cli-v0.0.1-${key}.tar.gz`;
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  exit 1
fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  echo "asset not found" >&2
  exit 4
fi
exit 9
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = fakeBin;
    await assert.rejects(
      installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
        log: false,
        manifestOverride: {
          schemaVersion: 2,
          tools: [{
            name: "fixture-private-cli",
            binary: "fixture-private-cli",
            repo: "pengmide/fixture-private-cli",
            private: true,
            version: "v0.0.1",
            platforms: {
              [key]: {
                url: `https://github.com/pengmide/fixture-private-cli/releases/download/v0.0.1/${assetFile}`,
                sha256: ""
              }
            }
          }]
        }
      }),
      /gh release download failed: asset not found/
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("runtime bundle tar failure does not replace existing runtime files", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const archive = "bad runtime archive\n";
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const [file, content] of [
    ["agents/old.txt", "old agents\n"],
    ["bootstrap/cli-manifest.json", "{\"old\":true}\n"],
    ["config/qdm-cli-paths.env", "old config\n"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), content);
  }
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
mkdir -p "$dir/agents" "$dir/bootstrap"
printf 'new agents\\n' > "$dir/agents/new.txt"
printf '{"new":true}\\n' > "$dir/bootstrap/cli-manifest.json"
exit 7
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        if (String(url).endsWith("/releases/latest")) {
          response.end(JSON.stringify({
            tag_name: "v-runtime",
            assets: [{ name: "harness-data-runtime-v-runtime.tar.gz", url: "https://example.invalid/runtime.tar.gz" }]
          }));
          return;
        }
        response.end(archive);
      });
      return request;
    };

    await assert.rejects(
      installRuntimeBundle(workspace, { force: true, githubToken: "token", log: false }),
      /tar .* failed/
    );
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }

  assert.equal(fs.readFileSync(path.join(workspace, "agents", "old.txt"), "utf8"), "old agents\n");
  assert.equal(fs.existsSync(path.join(workspace, "agents", "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "utf8"), "{\"old\":true}\n");
  assert.equal(fs.readFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), "utf8"), "old config\n");
});

test("runtime bundle replace failure restores previous runtime files", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const archive = "runtime archive\n";
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const [file, content] of [
    ["agents/old.txt", "old agents\n"],
    ["bootstrap/cli-manifest.json", "{\"old\":true}\n"],
    ["config/qdm-cli-paths.env", "old config\n"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), content);
  }
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
mkdir -p "$dir/agents" "$dir/bootstrap" "$dir/config"
printf 'new agents\\n' > "$dir/agents/new.txt"
printf '{"new":true}\\n' > "$dir/bootstrap/cli-manifest.json"
printf 'new config\\n' > "$dir/config/qdm-cli-paths.env"
exit 0
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  const originalRenameSync = fs.renameSync;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        if (String(url).endsWith("/releases/latest")) {
          response.end(JSON.stringify({
            tag_name: "v-runtime",
            assets: [{ name: "harness-data-runtime-v-runtime.tar.gz", url: "https://example.invalid/runtime.tar.gz" }]
          }));
          return;
        }
        response.end(archive);
      });
      return request;
    };
    fs.renameSync = (from, to) => {
      if (String(from).includes(".install-new-runtime-") && String(to).endsWith(`${path.sep}bootstrap`)) {
        throw new Error("simulated replace failure");
      }
      return originalRenameSync(from, to);
    };

    await assert.rejects(
      installRuntimeBundle(workspace, { force: true, githubToken: "token", log: false }),
      /simulated replace failure/
    );
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.readFileSync(path.join(workspace, "agents", "old.txt"), "utf8"), "old agents\n");
  assert.equal(fs.existsSync(path.join(workspace, "agents", "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "utf8"), "{\"old\":true}\n");
  assert.equal(fs.readFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), "utf8"), "old config\n");
});

test("runtime bundle update preserves local config while refreshing examples", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const archive = "runtime archive\n";
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const [file, content] of [
    ["agents/old.txt", "old agents\n"],
    ["bootstrap/cli-manifest.json", "{\"old\":true}\n"],
    ["config/harness-config.yaml", "old harness config\n"],
    ["config/qdm-cli-paths.env", "old cli paths\n"],
    ["config/qdm-cli-paths.env.example", "old example\n"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), content);
  }
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
mkdir -p "$dir/agents" "$dir/bootstrap" "$dir/config"
printf 'new agents\\n' > "$dir/agents/new.txt"
printf '{"new":true}\\n' > "$dir/bootstrap/cli-manifest.json"
printf 'new harness example\\n' > "$dir/config/harness-config.yaml.example"
printf 'new cli paths example\\n' > "$dir/config/qdm-cli-paths.env.example"
printf 'should not replace local cli paths\\n' > "$dir/config/qdm-cli-paths.env"
exit 0
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        if (String(url).endsWith("/releases/latest")) {
          response.end(JSON.stringify({
            tag_name: "v-runtime",
            assets: [{ name: "harness-data-runtime-v-runtime.tar.gz", url: "https://example.invalid/runtime.tar.gz" }]
          }));
          return;
        }
        response.end(archive);
      });
      return request;
    };

    await installRuntimeBundle(workspace, { force: true, githubToken: "token", log: false });
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }

  assert.equal(fs.existsSync(path.join(workspace, "agents", "old.txt")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "agents", "new.txt"), "utf8"), "new agents\n");
  assert.equal(fs.readFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "utf8"), "{\"new\":true}\n");
  assert.equal(fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8"), "old harness config\n");
  assert.equal(fs.readFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), "utf8"), "old cli paths\n");
  assert.equal(fs.readFileSync(path.join(workspace, "config", "harness-config.yaml.example"), "utf8"), "new harness example\n");
  assert.equal(fs.readFileSync(path.join(workspace, "config", "qdm-cli-paths.env.example"), "utf8"), "new cli paths example\n");
});

test("release asset download uses browser URL without token", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const target = path.join(workspace, "asset.tgz");
  const urls = [];
  const originalGet = https.get;
  try {
    https.get = (url, options, callback) => {
      urls.push(String(url));
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end("runtime");
      });
      return request;
    };

    await downloadReleaseAsset({
      url: "https://api.github.com/repos/lumi-ai-lab/harness-data/releases/assets/1",
      browser_download_url: "https://github.com/lumi-ai-lab/harness-data/releases/download/v1/asset.tgz"
    }, target, { log: false });
  } finally {
    https.get = originalGet;
  }

  assert.deepEqual(urls, ["https://github.com/lumi-ai-lab/harness-data/releases/download/v1/asset.tgz"]);
  assert.equal(fs.readFileSync(target, "utf8"), "runtime");
});

test("release asset download falls back to browser URL after token API failure", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const target = path.join(workspace, "asset.tgz");
  const urls = [];
  const originalGet = https.get;
  try {
    https.get = (url, options, callback) => {
      urls.push(String(url));
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.headers = {};
        if (String(url).includes("api.github.com")) {
          response.statusCode = 404;
          callback(response);
          response.end("not found");
          return;
        }
        response.statusCode = 200;
        callback(response);
        response.end("runtime");
      });
      return request;
    };

    await downloadReleaseAsset({
      url: "https://api.github.com/repos/lumi-ai-lab/harness-data/releases/assets/1",
      browser_download_url: "https://github.com/lumi-ai-lab/harness-data/releases/download/v1/asset.tgz"
    }, target, { githubToken: "bad-token", log: false });
  } finally {
    https.get = originalGet;
  }

  assert.deepEqual(urls, [
    "https://api.github.com/repos/lumi-ai-lab/harness-data/releases/assets/1",
    "https://github.com/lumi-ai-lab/harness-data/releases/download/v1/asset.tgz"
  ]);
  assert.equal(fs.readFileSync(target, "utf8"), "runtime");
});

test("download renders terminal progress when requested", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const target = path.join(workspace, "asset.bin");
  const chunks = ["12345", "67890"];
  const writes = [];
  const originalGet = https.get;
  try {
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { "content-length": "10" };
        callback(response);
        response.write(chunks[0]);
        response.end(chunks[1]);
      });
      return request;
    };

    await download("https://example.invalid/asset.bin", target, {}, {
      progressLabel: "asset.bin",
      progressWriter: { write: (chunk) => writes.push(String(chunk)) }
    });
  } finally {
    https.get = originalGet;
  }

  assert.equal(fs.readFileSync(target, "utf8"), chunks.join(""));
  assert.match(writes.join(""), /下载中 \[/);
  assert.match(writes.join(""), /100% 10 B\/10 B/);
  assert.match(writes.join(""), /下载完成 asset\.bin/);
  assert.doesNotMatch(writes.join(""), /\r/);
  assert.match(writes.join(""), /\u001b\[1G/);
  assert.doesNotMatch(writes.join(""), /\u001b\[1A/);
});

test("download progress uses a short live line in narrow terminals", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const target = path.join(workspace, "asset.bin");
  const writes = [];
  const columns = 72;
  const originalGet = https.get;
  try {
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { "content-length": String(2.6 * 1024 * 1024) };
        callback(response);
        response.end(Buffer.alloc(2.6 * 1024 * 1024));
      });
      return request;
    };

    await download("https://example.invalid/asset.bin", target, {}, {
      progressLabel: "qdm-metric-cli-v0.0.2-darwin-arm64-with-a-very-long-name.tar.gz",
      progressWriter: {
        columns,
        write: (chunk) => writes.push(String(chunk))
      }
    });
  } finally {
    https.get = originalGet;
  }

  const output = writes.join("");
  const liveLines = output
    .split("\u001b[1G")
    .map((line) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""))
    .filter((line) => line.startsWith("下载中"));
  assert.ok(liveLines.length >= 1);
  assert.ok(liveLines.every((line) => terminalTextWidth(line) < columns));
  assert.match(output, /下载完成 qdm-metric-cli-v0\.0\.2-darwin-arm64-with-a-very-long-name\.tar\.gz 100% 2\.6 MB\/2\.6 MB\n$/);
  assert.doesNotMatch(output, /\r/);
  assert.match(output, /\u001b\[1G/);
  assert.doesNotMatch(output, /\u001b\[1A/);
});

test("download progress live line remains short after terminal resize", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const target = path.join(workspace, "asset.bin");
  const writes = [];
  const writer = {
    columns: 100,
    write: (chunk) => writes.push(String(chunk))
  };
  const originalGet = https.get;
  try {
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { "content-length": "10" };
        callback(response);
        response.write("12345");
        setTimeout(() => {
          writer.columns = 32;
          response.end("67890");
        }, 100);
      });
      return request;
    };

    await download("https://example.invalid/asset.bin", target, {}, {
      progressLabel: "qdm-metric-cli-v0.0.2-darwin-arm64-with-a-very-long-name.tar.gz",
      progressWriter: writer
    });
  } finally {
    https.get = originalGet;
  }

  const output = writes.join("");
  const liveLines = output
    .split("\u001b[1G")
    .map((line) => line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ""))
    .filter((line) => line.startsWith("下载中"));

  assert.ok(liveLines.length >= 2);
  assert.ok(liveLines.every((line) => terminalTextWidth(line) < writer.columns));
  assert.match(output, /下载完成 qdm-metric-cli-v0\.0\.2-darwin-arm64-with-a-very-long-name\.tar\.gz 100% 10 B\/10 B\n$/);
  assert.doesNotMatch(output, /\r/);
  assert.match(output, /\u001b\[1G/);
  assert.doesNotMatch(output, /\u001b\[1A/);
});

test("download resumes redirect responses", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const target = path.join(workspace, "asset.bin");
  let redirectedResponseResumed = false;
  const originalGet = https.get;
  try {
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = String(url).includes("redirect") ? 302 : 200;
        response.headers = response.statusCode === 302 ? { location: "https://example.invalid/final" } : {};
        if (response.statusCode === 302) response.resume = () => {
          redirectedResponseResumed = true;
          return PassThrough.prototype.resume.call(response);
        };
        callback(response);
        response.end(response.statusCode === 302 ? "" : "ok");
      });
      return request;
    };

    await download("https://example.invalid/redirect", target);
  } finally {
    https.get = originalGet;
  }

  assert.equal(redirectedResponseResumed, true);
  assert.equal(fs.readFileSync(target, "utf8"), "ok");
});

test("expected sha256 download does not render progress", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const archive = "archive with external sha\n";
  const binary = "#!/bin/sh\necho sha\n";
  const writes = [];
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
printf '%s' '${binary.replaceAll("'", "'\\''")}' > "$dir/${binaryName("data-harness-cli")}"
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = fakeBin;
    https.get = (url, options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { "content-length": String(Buffer.byteLength(archive)) };
        callback(response);
        response.end(String(url).endsWith(".sha256") ? `${sha256(archive)}  asset\n` : archive);
      });
      return request;
    };

    await installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
      log: false,
      manifestOverride: {
        schemaVersion: 2,
        tools: [{
          name: "data-harness-cli",
          binary: "data-harness-cli",
          repo: "lumi-ai-lab/harness-data",
          version: "v-new",
          platforms: {
            [key]: {
              url: `https://127.0.0.1:1/data-harness-cli-v-new-${key}.tar.gz`,
              sha256: ""
            }
          }
        }]
      },
      progressWriter: { write: (chunk) => writes.push(String(chunk)) }
    });
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }

  assert.equal(writes.filter((line) => line.includes(".sha256")).length, 0);
});

test("local config exports metric cli path only", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));

  writeLocalConfig(workspace, { overwrite: true });

  const env = fs.readFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), "utf8");
  const harnessConfig = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.match(env, /export QDM_METRIC_CLI=".*qdm-metric-cli(?:\.exe)?"/);
  assert.doesNotMatch(env, /QDM_SQL_CLI|QDM_CAS_CLI|QDM_CAS_CONFIG_DIR|QDM_CMR_CLI|QDM_INDICATORS_CLI/);
  assert.match(harnessConfig, /qdm_metric_cli: .*qdm-metric-cli(?:\.exe)?/);
  assert.doesNotMatch(harnessConfig, /qdm_sql_cli|qdm_cas_cli|qdm_cmr_cli|qdm_indicators_cli/);
  assert.match(harnessConfig, /authz:\n  mode: off/);
  assert.match(harnessConfig, /allow_local_blob: true/);
});

test("local config dataAuth enables authz and local blob paths", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));

  const { authz } = writeLocalConfig(workspace, { overwrite: true, dataAuth: true });

  assert.equal(authz.mode, "on");
  assert.equal(authz.blobFile, localTestAuthBlobRel);
  assert.equal(authz.devUserId, localTestAuthUserId);
  assert.equal(authz.allowLocalBlob, true);
  const harnessConfig = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.match(harnessConfig, /mode: on/);
  assert.match(harnessConfig, /blob_file: config\/dev-auth\.blob/);
  assert.match(harnessConfig, new RegExp(`dev_user_id: ${localTestAuthUserId}`));
  assert.match(harnessConfig, /allow_local_blob: true/);
});

test("local config overwrite preserves existing authz when dataAuth omitted", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  writeLocalConfig(workspace, { overwrite: true, dataAuth: true });
  writeLocalConfig(workspace, { overwrite: true });

  const harnessConfig = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.match(harnessConfig, /mode: on/);
  assert.match(harnessConfig, /blob_file: config\/dev-auth\.blob/);
  assert.match(harnessConfig, new RegExp(`dev_user_id: ${localTestAuthUserId}`));
});

test("resolveAuthzForWrite migrates allow_local_blob:false to true when mode=on", () => {
  const migrated = resolveAuthzForWrite({}, {
    mode: "on",
    blobFile: "config/dev-auth.blob",
    devUserId: "local-test-user",
    allowLocalBlob: false,
  });
  assert.equal(migrated.mode, "on");
  assert.equal(migrated.allowLocalBlob, true);
  assert.equal(migrated.blobFile, "config/dev-auth.blob");
  assert.equal(migrated.devUserId, "local-test-user");
});

test("resolveAuthzForWrite preserves allow_local_blob:false when mode=off", () => {
  const preserved = resolveAuthzForWrite({}, {
    mode: "off",
    blobFile: "",
    devUserId: "",
    allowLocalBlob: false,
  });
  assert.equal(preserved.mode, "off");
  assert.equal(preserved.allowLocalBlob, false);
});

test("writeLocalConfig overwrites and migrates allow_local_blob:false to true", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
  // Simulate old production config with allow_local_blob: false
  fs.writeFileSync(
    path.join(workspace, "config", "harness-config.yaml"),
    "paths:\n  knowledge: wikis\n\ncli:\n  qdm_metric_cli: bin/qdm-metric-cli\n\nauthz:\n  mode: on\n  allow_local_blob: false\n",
  );
  writeLocalConfig(workspace, { overwrite: true });
  const harnessConfig = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.match(harnessConfig, /mode: on/);
  assert.match(harnessConfig, /allow_local_blob: true/);
});

test("doctor fails on authz mode=on with allow_local_blob=false", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  for (const dir of [
    "agents/codex",
    "bootstrap",
    "wikis/metrics",
    "wikis/reports",
    "wikis/dims",
    "wikis/rules",
    "bin",
    "config",
  ]) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "{}");
  fs.writeFileSync(path.join(workspace, "wikis", "index.md"), "# Wikis\n");
  for (const binary of qdmCliBinaries) {
    fs.writeFileSync(path.join(workspace, "bin", binaryName(binary)), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(workspace, "config", "harness-config.yaml"),
    "paths:\n  knowledge: wikis\n\ncli:\n  qdm_metric_cli: bin/qdm-metric-cli\n\nauthz:\n  mode: on\n  allow_local_blob: false\n",
  );
  fs.writeFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), `export QDM_METRIC_CLI="${path.join(workspace, "bin", "qdm-metric-cli")}"\n`);
  linkAgents(workspace, "codex");

  const report = await collectDoctor(workspace);
  const check = report.checks.find((c) => c.name === "authz allow_local_blob");
  assert.ok(check, "missing authz allow_local_blob check");
  assert.equal(check.ok, false);
  assert.match(check.detail, /Host\/Lumi fallback removed/);
});

test("doctor passes on authz mode=on with allow_local_blob=true", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  for (const dir of [
    "agents/codex",
    "bootstrap",
    "wikis/metrics",
    "wikis/reports",
    "wikis/dims",
    "wikis/rules",
    "bin",
    "config",
  ]) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "{}");
  fs.writeFileSync(path.join(workspace, "wikis", "index.md"), "# Wikis\n");
  for (const binary of qdmCliBinaries) {
    fs.writeFileSync(path.join(workspace, "bin", binaryName(binary)), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  writeLocalConfig(workspace, { overwrite: true, dataAuth: true });
  linkAgents(workspace, "codex");

  const report = await collectDoctor(workspace);
  const check = report.checks.find((c) => c.name === "authz allow_local_blob");
  assert.ok(check, "missing authz allow_local_blob check");
  assert.equal(check.ok, true);
});

test("ensureLocalAuthBlob copies fixture and keeps existing blob", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const fixtureDir = path.join(workspace, "config", "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixtureContent = "qdm1enc.fixture-test-blob\n";
  fs.writeFileSync(path.join(workspace, localTestAuthFixtureRel), fixtureContent);

  const first = ensureLocalAuthBlob(workspace);
  assert.equal(first.copied, true);
  assert.equal(fs.readFileSync(path.join(workspace, localTestAuthBlobRel), "utf8"), fixtureContent);

  fs.writeFileSync(path.join(workspace, localTestAuthBlobRel), "qdm1enc.user-custom\n");
  const second = ensureLocalAuthBlob(workspace);
  assert.equal(second.copied, false);
  assert.equal(fs.readFileSync(path.join(workspace, localTestAuthBlobRel), "utf8"), "qdm1enc.user-custom\n");
});

test("ensureLocalAuthBlob fails when fixture is missing", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  assert.throws(() => ensureLocalAuthBlob(workspace), /data-auth fixture missing/);
});

test("ensureLocalAuthBlob with force overwrites existing user blob", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const fixtureDir = path.join(workspace, "config", "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixtureContent = "qdm1enc.fixture-test-blob\n";
  fs.writeFileSync(path.join(workspace, localTestAuthFixtureRel), fixtureContent);

  // 先写入用户自定义 blob（模拟默认 install 的 writeAuthBlob）
  writeAuthBlob(workspace, "qdm1enc.userA-custom-blob");

  // 不带 force 时保留已有 blob
  const kept = ensureLocalAuthBlob(workspace);
  assert.equal(kept.copied, false);
  assert.equal(
    fs.readFileSync(path.join(workspace, localTestAuthBlobRel), "utf8").trim(),
    "qdm1enc.userA-custom-blob",
  );

  // 带 force 时强制覆盖为 fixture
  const forced = ensureLocalAuthBlob(workspace, { force: true });
  assert.equal(forced.copied, true);
  assert.equal(
    fs.readFileSync(path.join(workspace, localTestAuthBlobRel), "utf8"),
    fixtureContent,
  );
});

test("dataAuth install overwrites user-provided blob with fixture (regression)", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const fixtureDir = path.join(workspace, "config", "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixtureContent = "qdm1enc.fixture-test-blob\n";
  fs.writeFileSync(path.join(workspace, localTestAuthFixtureRel), fixtureContent);

  // 步骤1: 模拟默认 install —— 写入用户 A 的 blob + dev_user_id
  writeAuthBlob(workspace, "qdm1enc.userA-encrypted-blob");
  writeLocalConfig(workspace, { overwrite: true, authBlob: true, devUserId: "userA" });

  // 步骤2: 模拟 install --data-auth —— 切换配置为 local-test-user
  writeLocalConfig(workspace, { overwrite: true, dataAuth: true });

  // 步骤3: ensureLocalAuthBlob 必须强制覆盖（与 install.js 一致）
  const blob = ensureLocalAuthBlob(workspace, { force: true });
  assert.equal(blob.copied, true);
  assert.equal(
    fs.readFileSync(path.join(workspace, localTestAuthBlobRel), "utf8"),
    fixtureContent,
  );

  // 断言配置中 dev_user_id 为 local-test-user，与 fixture blob 一致
  const harnessConfig = fs.readFileSync(
    path.join(workspace, "config", "harness-config.yaml"),
    "utf8",
  );
  assert.match(harnessConfig, /mode: on/);
  assert.match(harnessConfig, new RegExp(`dev_user_id: ${localTestAuthUserId}`));
});

test("agent choices include OpenClaw, Hermes, WorkBuddy, both, and all", () => {
  assert.deepEqual(agentChoices, ["claude", "codex", "pi", "openclaw", "hermes", "workbuddy", "both", "all"]);
  assert.equal(agentIncludesWorkBuddy("workbuddy"), true);
  assert.equal(agentIncludesWorkBuddy("all"), false);
  assert.equal(agentIncludesWorkBuddy("both"), false);
});

test("WorkBuddy auth installer parameters support macOS and Windows", () => {
  assert.doesNotThrow(() => assertWorkBuddyAuthPlatform("workbuddy", true, "darwin"));
  assert.doesNotThrow(() => assertWorkBuddyAuthPlatform("workbuddy", true, "win32"));
  assert.throws(() => assertWorkBuddyAuthPlatform("workbuddy", true, "linux"), /supports macOS and Windows only/);
  assert.doesNotThrow(() => assertWorkBuddyAuthPlatform("workbuddy", false, "win32"));
  assert.doesNotThrow(() => assertWorkBuddyAuthPlatform("all", true, "win32"));
});

test("WorkBuddy plugin package matches npm version and native hook contract", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  copyWorkBuddyPlugin(workspace);
  const plugin = inspectWorkBuddyPlugin(workspace);
  assert.equal(plugin.prepared, true, plugin.errors.join("; "));
  assert.equal(plugin.version, packageVersion());
  assert.equal(plugin.marketplaceVersion, packageVersion());
  assert.equal(plugin.marketplaceName, "lumi-harness-data");
  assert.equal(plugin.marketplaceRoot, path.join(workspace, "agents"));
  assert.equal(versionAtLeast("5.3.5"), true);
  assert.equal(versionAtLeast("5.3.8"), true);
  assert.equal(versionAtLeast("v5.3.11", "5.3.11"), true);
  assert.equal(versionAtLeast("5.3.4"), false);
});

test("WorkBuddy enablement detection distinguishes package from enabled plugin", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-workbuddy-home-"));
  const settingsDir = path.join(home, ".workbuddy");
  fs.mkdirSync(settingsDir, { recursive: true });
  let status = detectWorkBuddyPluginEnabled({ homeDir: home });
  assert.equal(status.detected, false);
  assert.equal(status.enabled, false);

  fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
    enabledPlugins: { "qdm-harness@lumi-harness-data": true },
  }));
  status = detectWorkBuddyPluginEnabled({ homeDir: home });
  assert.equal(status.detected, true);
  assert.equal(status.configured, true);
  assert.equal(status.enabled, true);

  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-workbuddy-other-home-"));
  fs.mkdirSync(path.join(otherHome, ".workbuddy"), { recursive: true });
  fs.writeFileSync(path.join(otherHome, ".workbuddy", "settings.json"), JSON.stringify({
    enabledPlugins: { "qdm-harness@old-marketplace": true },
  }));
  const otherStatus = detectWorkBuddyPluginEnabled({ homeDir: otherHome });
  assert.equal(otherStatus.detected, true);
  assert.equal(otherStatus.configured, false);
  assert.equal(otherStatus.enabled, false);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-workbuddy-workspace-"));
  fs.mkdirSync(path.join(workspace, ".codebuddy"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".codebuddy", "settings.local.json"), JSON.stringify({
    enabledPlugins: { "qdm-harness@team-marketplace": false },
  }));
  status = detectWorkBuddyPluginEnabled({ homeDir: home, workspace });
  assert.equal(status.configured, true);
  assert.equal(status.enabled, true);
  assert.equal(status.explicitlyDisabled, false);
  assert.equal(status.settingsPath, path.join(settingsDir, "settings.json"));

  fs.writeFileSync(path.join(workspace, ".codebuddy", "settings.local.json"), JSON.stringify({
    enabledPlugins: { "qdm-harness@lumi-harness-data": false },
  }));
  status = detectWorkBuddyPluginEnabled({ homeDir: home, workspace });
  assert.equal(status.configured, true);
  assert.equal(status.enabled, false);
  assert.equal(status.explicitlyDisabled, true);
  assert.match(status.settingsPath, /settings\.local\.json$/);
});

test("WorkBuddy version detection reads the cross-platform product manifest", () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-app-"));
  const productDir = path.join(appRoot, "resources", "app.asar.unpacked", "cli");
  fs.mkdirSync(productDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, "product.json"), JSON.stringify({ genieVersion: "5.3.11" }));
  fs.writeFileSync(path.join(productDir, "package.json"), JSON.stringify({ publishConfig: { customPackage: { version: "2.115.0" } } }));
  assert.equal(detectWorkBuddyVersion({ workBuddyAppPath: appRoot }), "5.3.11");
  assert.equal(detectCodeBuddyVersion({ workBuddyAppPath: appRoot }), "2.115.0");
  assert.equal(codeBuddyMinimumVersion, "2.115.0");
});

test("WorkBuddy version detection accepts a macOS app.asar path", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-macos-app-"));
  const appRoot = path.join(parent, "WorkBuddy.app");
  const resources = path.join(appRoot, "Contents", "Resources");
  const productDir = path.join(resources, "app.asar.unpacked", "cli");
  fs.mkdirSync(productDir, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), "fixture asar");
  fs.writeFileSync(path.join(productDir, "product.json"), JSON.stringify({ genieVersion: "5.3.11" }));
  fs.writeFileSync(path.join(productDir, "package.json"), JSON.stringify({ publishConfig: { customPackage: { version: "2.115.0" } } }));

  const asarPath = path.join(resources, "app.asar");
  assert.equal(detectWorkBuddyVersion({ workBuddyAppPath: asarPath }), "5.3.11");
  assert.equal(detectCodeBuddyVersion({ workBuddyAppPath: asarPath }), "2.115.0");
});

test("WorkBuddy auth inspection accepts launchctl file source outside workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-workbuddy-runtime-"));
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-workbuddy-auth-"));
  const blobFile = path.join(authDir, "qdm-auth.blob");
  fs.writeFileSync(blobFile, "qdm1enc.runtime\n", { mode: 0o600 });
  const authz = { mode: "on", allowLocalBlob: true, blobFile: "", devUserId: "" };
  const inspected = inspectWorkBuddyAuth(workspace, authz, {
    env: {},
    platform: process.platform === "win32" ? "win32" : "darwin",
    launchctlEnv: {
      HARNESS_AUTH_BLOB_FILE: blobFile,
      HARNESS_AUTH_USER_ID: "admin-user",
    },
  });
  assert.equal(inspected.ok, true, inspected.detail);
  assert.match(inspected.detail, /launchctl file/);

  const insideFile = path.join(workspace, "auth.blob");
  fs.writeFileSync(insideFile, "qdm1enc.runtime\n", { mode: 0o600 });
  const inside = inspectWorkBuddyAuth(workspace, authz, {
    env: { HARNESS_AUTH_BLOB_FILE: insideFile, HARNESS_AUTH_USER_ID: "admin-user" },
    platform: process.platform === "win32" ? "win32" : "darwin",
  });
  assert.equal(inside.ok, false);
  assert.match(inside.detail, /outside the Harness workspace/);

  if (process.platform !== "win32") {
    fs.chmodSync(blobFile, 0o644);
    const insecure = inspectWorkBuddyAuth(workspace, authz, {
      env: { HARNESS_AUTH_BLOB_FILE: blobFile, HARNESS_AUTH_USER_ID: "admin-user" },
      platform: "darwin",
    });
    assert.equal(insecure.ok, false);
    assert.match(insecure.detail, /mode 0600/);
  }
});

test("codex agent template includes authz PreToolUse hook and guidance", () => {
  const hooksPath = path.join(root, "..", ".agents", "codex", "hooks.json");
  const hooksConfig = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const preToolUse = hooksConfig.hooks.PreToolUse;
  assert.ok(Array.isArray(preToolUse), "missing PreToolUse hooks");
  const authzHook = preToolUse.find((entry) => !entry.matcher || entry.matcher === "Bash");
  assert.ok(authzHook, "missing PreToolUse authz hook");
  const commands = authzHook.hooks.map((hook) => hook.command).join("\n");
  assert.match(commands, /authz-hook --agent codex/);
  assert.match(commands, /exit 2/);
  const instructions = fs.readFileSync(path.join(root, "..", ".agents", "codex", "AGENTS.md"), "utf8");
  assert.match(instructions, /PreToolUse.*authz hook injects authorization/);
});

test("writeAuthBlob writes user blob to config/dev-auth.blob", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  writeAuthBlob(workspace, "qdm1enc.test-blob-content");
  const target = path.join(workspace, "config", "dev-auth.blob");
  const blob = fs.readFileSync(target, "utf8").trim();
  assert.equal(blob, "qdm1enc.test-blob-content");
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test("resolveAuthzForWrite with authBlob=true sets mode on with devUserId", () => {
  const authz = resolveAuthzForWrite({ authBlob: true, devUserId: "my-user" });
  assert.equal(authz.mode, "on");
  assert.equal(authz.blobFile, localTestAuthBlobRel);
  assert.equal(authz.devUserId, "my-user");
  assert.equal(authz.allowLocalBlob, true);
});

test("resolveAuthzForWrite with noAuth=true sets mode off", () => {
  const authz = resolveAuthzForWrite({ noAuth: true });
  assert.equal(authz.mode, "off");
  assert.equal(authz.blobFile, "");
  assert.equal(authz.devUserId, "");
});

test("local config authBlob writes mode on with user-provided blob", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  writeAuthBlob(workspace, "qdm1enc.user-encrypted-blob");
  const { authz } = writeLocalConfig(workspace, { overwrite: true, authBlob: true, devUserId: "prod-user" });
  assert.equal(authz.mode, "on");
  assert.equal(authz.blobFile, localTestAuthBlobRel);
  assert.equal(authz.devUserId, "prod-user");
  const harnessConfig = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.match(harnessConfig, /mode: on/);
  assert.match(harnessConfig, /blob_file: config\/dev-auth\.blob/);
  assert.match(harnessConfig, /dev_user_id: prod-user/);
  assert.equal(
    fs.readFileSync(path.join(workspace, "config", "dev-auth.blob"), "utf8").trim(),
    "qdm1enc.user-encrypted-blob",
  );
});

test("local config noAuth sets mode off", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const { authz } = writeLocalConfig(workspace, { overwrite: true, noAuth: true });
  assert.equal(authz.mode, "off");
  assert.equal(authz.blobFile, "");
  assert.equal(authz.devUserId, "");
  const harnessConfig = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.match(harnessConfig, /mode: off/);
});

test("AUTH_OFF_PASSWORD is hardcoded to expected value", () => {
  assert.equal(AUTH_OFF_PASSWORD, "qdmzt@2026");
});

test("install --auth-blob + --auth-user-id writes mode on with user blob (regression for 0.0.44)", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  // 模拟预检通过后，installCommand 把 flag 写入本地配置
  const options = { authBlob: "qdm1enc.regression-blob", authUserId: "pengmingde01" };
  // 默认分支逻辑（与 install.js 一致：flag > env > prompt，此处直接用 flag）
  writeAuthBlob(workspace, options.authBlob);
  const { authz } = writeLocalConfig(workspace, { overwrite: true, authBlob: true, devUserId: options.authUserId });
  assert.equal(authz.mode, "on");
  assert.equal(authz.blobFile, localTestAuthBlobRel);
  assert.equal(authz.devUserId, "pengmingde01");
  const harnessConfig = fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8");
  assert.match(harnessConfig, /mode: on/);
  assert.match(harnessConfig, /blob_file: config\/dev-auth\.blob/);
  assert.match(harnessConfig, /dev_user_id: pengmingde01/);
  assert.equal(
    fs.readFileSync(path.join(workspace, "config", "dev-auth.blob"), "utf8").trim(),
    "qdm1enc.regression-blob",
  );
});

test("resolveAuthzForWrite with dataAuth=false sets mode off (WorkBuddy default)", () => {
  const authz = resolveAuthzForWrite({ dataAuth: false });
  assert.equal(authz.mode, "off");
  assert.equal(authz.blobFile, "");
});

test("Windows Codex hook patch rewrites all required hooks and is idempotent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const codexDir = path.join(workspace, "agents", "codex");
  const hooksDir = path.join(codexDir, "hooks");
  const hooksFile = path.join(codexDir, "hooks.json");
  const shimPath = path.join(hooksDir, "cli-shim.mjs").replaceAll("\\", "/");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "cli-shim.mjs"), "");
  fs.copyFileSync(path.join(root, "..", ".agents", "codex", "hooks.json"), hooksFile);

  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  try {
    patchCodexHooksForWindows(workspace);
    patchCodexHooksForWindows(workspace);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }

  const patched = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.equal(patched.hooks.UserPromptSubmit[0].hooks[0].command, `node "${shimPath}" context --format codex-hook`);
  assert.equal(patched.hooks.PreToolUse[0].hooks[0].command, `node "${shimPath}" authz-hook --agent codex`);
  assert.equal(patched.hooks.PostToolUse[0].hooks[0].command, `node "${shimPath}" posttool --format codex-hook`);
  assert.deepEqual(fs.readdirSync(codexDir).sort(), ["hooks", "hooks.json"]);
});

test("Windows Codex hook patch fails closed when a required hook cannot be rewritten", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const hooksDir = path.join(workspace, "agents", "codex", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, "cli-shim.mjs"), "");
  const hooksFile = path.join(workspace, "agents", "codex", "hooks.json");
  const original = JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ command: "echo unsupported" }] }],
      PreToolUse: [{ hooks: [{ command: "echo unsupported" }] }],
      PostToolUse: [{ hooks: [{ command: "echo unsupported" }] }],
    },
  });
  fs.writeFileSync(hooksFile, original);

  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  try {
    assert.throws(() => patchCodexHooksForWindows(workspace), /patch failed for UserPromptSubmit/);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  assert.equal(fs.readFileSync(hooksFile, "utf8"), original);
});

test("Windows keeps Codex default, allows explicit WorkBuddy, and supports both auth adapters", async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  try {
    assert.equal(await chooseAgent({ agent: "workbuddy" }), "workbuddy");
    assert.equal(await chooseAgent({ agent: " CODEX " }), "codex");
    assert.doesNotThrow(() => assertCodexAuthPlatform("codex", false, "win32"));
    assert.doesNotThrow(() => assertCodexAuthPlatform("codex", true, "win32"));
    assert.doesNotThrow(() => assertWorkBuddyAuthPlatform("workbuddy", true, "win32"));
    assert.doesNotThrow(() => assertCodexAuthPlatform("codex", true, "linux"));
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

test("Codex CLI shim preserves arguments and propagates the child exit code", () => {
  if (process.platform === "win32") return;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness shim space-"));
  const hooksDir = path.join(workspace, "agents", "codex", "hooks");
  const binDir = path.join(workspace, "bin");
  const argsFile = path.join(workspace, "args.json");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(root, "..", ".agents", "codex", "hooks", "cli-shim.mjs"), path.join(hooksDir, "cli-shim.mjs"));
  const fixture = path.join(binDir, process.platform === "win32" ? "data-harness-cli.exe" : "data-harness-cli");
  fs.writeFileSync(fixture, `#!${process.execPath}\nimport fs from "node:fs";\nfs.writeFileSync(process.env.HARNESS_SHIM_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\nprocess.exit(23);\n`, { mode: 0o755 });
  fs.chmodSync(fixture, 0o755);

  const result = spawnSync(process.execPath, [path.join(hooksDir, "cli-shim.mjs"), "context", "value with spaces"], {
    env: { ...process.env, HARNESS_SHIM_ARGS_FILE: argsFile },
    encoding: "utf8",
  });

  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, "utf8")), ["context", "value with spaces"]);
});

test("Windows executable checks use file existence instead of POSIX mode bits", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-win-exec-")), "tool.exe");
  fs.writeFileSync(file, "fixture", { mode: 0o600 });
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  try {
    assert.equal(isExecutable(file), true);
    assert.equal(binaryName("tool"), "tool.exe");
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
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

  const workbuddy = linkAgents(workspace, "workbuddy");
  assert.deepEqual(workbuddy, []);
  assert.equal(fs.existsSync(path.join(workspace, ".workbuddy")), false);

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

function copyWorkBuddyPlugin(workspace) {
  fs.mkdirSync(path.join(workspace, "agents"), { recursive: true });
  fs.cpSync(path.join(root, "..", ".agents", "workbuddy"), path.join(workspace, "agents", "workbuddy"), { recursive: true });
  fs.cpSync(path.join(root, "..", ".agents", ".codebuddy-plugin"), path.join(workspace, "agents", ".codebuddy-plugin"), { recursive: true });
}

function createAgentWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  for (const name of ["claude", "codex", "pi", "openclaw", "hermes"]) {
    fs.mkdirSync(path.join(workspace, "agents", name), { recursive: true });
  }
  return workspace;
}

function copyCodexHooks(workspace) {
  fs.cpSync(path.join(root, "..", ".agents", "codex"), path.join(workspace, "agents", "codex"), { recursive: true });
}

test("detects whether any agent hook exists", () => {
  const workspace = createAgentWorkspace();

  assert.equal(hasAnyAgentHook(workspace), false);

  linkAgents(workspace, "codex");

  assert.equal(hasAnyAgentHook(workspace), true);
});

test("update restore recreates agent hooks only when all are missing", async () => {
  const missingWorkspace = createAgentWorkspace();
  copyCodexHooks(missingWorkspace);

  const restored = await restoreAgentHooksIfMissing(missingWorkspace, { agent: "codex" });

  assert.deepEqual(restored, { agent: "codex", linkedAgents: [["agents/codex", ".codex"]] });
  assert.equal(fs.realpathSync(path.join(missingWorkspace, ".codex")), fs.realpathSync(path.join(missingWorkspace, "agents", "codex")));

  const existingWorkspace = createAgentWorkspace();
  copyCodexHooks(existingWorkspace);
  linkAgents(existingWorkspace, "codex");
  const before = fs.realpathSync(path.join(existingWorkspace, ".codex"));

  const skipped = await restoreAgentHooksIfMissing(existingWorkspace, { agent: "not-real" });

  assert.equal(skipped, null);
  assert.equal(fs.realpathSync(path.join(existingWorkspace, ".codex")), before);
  assert.equal(fs.existsSync(path.join(existingWorkspace, ".claude")), false);
});

test("Windows update re-patches freshly replaced Codex hooks when the junction already exists", async () => {
  const workspace = createAgentWorkspace();
  copyCodexHooks(workspace);
  linkAgents(workspace, "codex");
  const hooksFile = path.join(workspace, "agents", "codex", "hooks.json");
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  try {
    patchCodexHooksForWindows(workspace);
    fs.copyFileSync(path.join(root, "..", ".agents", "codex", "hooks.json"), hooksFile);
    const restored = await restoreAgentHooksIfMissing(workspace, { agent: "codex" });
    assert.equal(restored, null);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }

  const patched = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
    assert.match(patched.hooks[event][0].hooks[0].command, /cli-shim\.mjs/);
  }
});

test("doctor fails when Windows Codex shim is missing", async () => {
  if (process.platform !== "win32") return;
  const workspace = createDoctorWorkspace("codex");
  copyCodexHooks(workspace);
  linkAgents(workspace, "codex");
  patchCodexHooksForWindows(workspace);
  fs.rmSync(path.join(workspace, "agents", "codex", "hooks", "cli-shim.mjs"));
  const report = await collectDoctor(workspace, { agent: "codex" });
  const check = report.checks.find((item) => item.name === "Codex hooks");
  assert.equal(check?.ok, false);
  assert.match(check?.detail || "", /cli-shim\.mjs is missing/);
});

test("update recognizes a prepared WorkBuddy plugin without creating a symlink", async () => {
  const workspace = createAgentWorkspace();
  copyWorkBuddyPlugin(workspace);
  const restored = await restoreAgentHooksIfMissing(workspace, { agent: "workbuddy" });
  assert.equal(restored, null);
  assert.equal(fs.existsSync(path.join(workspace, ".workbuddy")), false);
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
    "wikis/metrics",
    "wikis/reports",
    "wikis/dims",
    "wikis/rules",
    "bin",
  ]) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }

  fs.writeFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "{}");
  fs.writeFileSync(path.join(workspace, "wikis", "index.md"), "# Wikis\n");
  for (const binary of qdmCliBinaries) {
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

test("doctor validates WorkBuddy package, version, and enablement separately", async () => {
  const workspace = createDoctorWorkspace("workbuddy");
  copyWorkBuddyPlugin(workspace);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-workbuddy-home-"));
  fs.mkdirSync(path.join(home, ".workbuddy"), { recursive: true });
  fs.writeFileSync(path.join(home, ".workbuddy", "settings.json"), JSON.stringify({
    enabledPlugins: { "qdm-harness@lumi-harness-data": true },
  }));

  const report = await collectDoctor(workspace, {
    agent: "workbuddy",
    workBuddyVersion: "5.3.11",
    codeBuddyVersion: "2.115.0",
    homeDir: home,
  });
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  assert.equal(byName.get("WorkBuddy plugin package")?.ok, true);
  assert.equal(byName.get("WorkBuddy version >= 5.3.5")?.ok, true);
  assert.match(byName.get("WorkBuddy plugin enablement")?.detail || "", /enabled/);
  assert.equal(byName.get("Agent hook")?.ok, true);

  const oldClient = await collectDoctor(workspace, { agent: "workbuddy", workBuddyVersion: "5.3.4", codeBuddyVersion: "2.115.0", homeDir: home });
  assert.equal(oldClient.checks.find((check) => check.name === "WorkBuddy version >= 5.3.5")?.ok, false);

  const unknownHome = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-workbuddy-unknown-home-"));
  const unknown = await collectDoctor(workspace, { agent: "workbuddy", workBuddyVersion: "5.3.11", codeBuddyVersion: "2.115.0", homeDir: unknownHome });
  const unknownEnablement = unknown.checks.find((check) => check.name === "WorkBuddy plugin enablement");
  assert.equal(unknownEnablement?.ok, true);
  assert.equal(unknownEnablement?.status, "warning");

  fs.writeFileSync(path.join(home, ".workbuddy", "settings.json"), JSON.stringify({
    enabledPlugins: { "qdm-harness@lumi-harness-data": false },
  }));
  const disabled = await collectDoctor(workspace, { agent: "workbuddy", workBuddyVersion: "5.3.11", codeBuddyVersion: "2.115.0", homeDir: home });
  assert.equal(disabled.checks.find((check) => check.name === "WorkBuddy plugin enablement")?.ok, false);

  if (process.platform === "win32") return;

  writeLocalConfig(workspace, { overwrite: true, dataAuth: true });
  fs.writeFileSync(path.join(workspace, localTestAuthBlobRel), "qdm1enc.local\n", { mode: 0o600 });
  const authzOn = await collectDoctor(workspace, {
    agent: "workbuddy",
    workBuddyVersion: "5.3.11",
    codeBuddyVersion: "2.115.0",
    homeDir: home,
    platform: "darwin",
    env: {},
  });
  assert.equal(authzOn.checks.find((check) => check.name === "WorkBuddy auth platform")?.ok, true);
  assert.equal(authzOn.checks.find((check) => check.name === "WorkBuddy auth source")?.ok, true);
  assert.equal(authzOn.checks.find((check) => check.name === "WorkBuddy auth version >= 5.3.11")?.ok, true);
  assert.equal(authzOn.checks.find((check) => check.name === "CodeBuddy CLI version >= 2.115.0")?.ok, true);

  const oldAuthClient = await collectDoctor(workspace, {
    agent: "workbuddy",
    workBuddyVersion: "5.3.10",
    codeBuddyVersion: "2.115.0",
    homeDir: home,
    platform: "darwin",
    env: {},
  });
  assert.equal(oldAuthClient.checks.find((check) => check.name === "WorkBuddy auth version >= 5.3.11")?.ok, false);
});

test("update doctor treats missing agent hooks as non-blocking only", async () => {
  assert.equal(isNonBlockingUpdateDoctorCheck({ name: "Agent hook" }), true);
  assert.equal(isNonBlockingUpdateDoctorCheck({ name: "Agent hook .openclaw" }), true);
  assert.equal(isNonBlockingUpdateDoctorCheck({ name: "bin/data-harness-cli" }), false);
  assert.equal(isNonBlockingUpdateDoctorCheck({ name: "config CLI paths" }), false);
});

test("tool update modes migrate legacy state while new state is independent of installMode", () => {
  assert.equal(toolInstallMode({ installMode: "local-path" }, "data-harness-cli"), "release");
  assert.equal(toolInstallMode({ installMode: "local-path" }, "qdm-metric-cli"), "local-path");
  assert.equal(wikisInstallMode({ installMode: "github-token" }), "github");
  assert.equal(wikisInstallMode({ installMode: "local-path" }), "local-path");
  assert.equal(wikisInstallMode({ wikisMode: "release" }), "release");
  assert.equal(toolInstallMode({
    installMode: "local-path",
    toolInstallModes: { "qdm-metric-cli": "release" }
  }, "qdm-metric-cli"), "release");
});

test("Wikis update migrates a legacy GitHub checkout to the versioned Release ZIP", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-wikis-update-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const password = "wikis-update-password";
  const wikis = path.join(workspace, "wikis");
  for (const dir of ["metrics", "reports", "dims", "rules"]) fs.mkdirSync(path.join(wikis, dir), { recursive: true });
  fs.writeFileSync(path.join(wikis, "index.md"), "old-wikis\n");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "unzip"), [
    "#!/bin/sh",
    'if [ "$1" != "-P" ] || [ "$2" != "' + password + '" ]; then exit 9; fi',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "-d" ]; then shift; dir="$1"; fi',
    "  shift",
    "done",
    'mkdir -p "$dir/metrics" "$dir/reports" "$dir/dims" "$dir/rules"',
    'echo release-update > "$dir/index.md"'
  ].join("\n"), { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = fakeBin + ":" + (originalPath || "");
    https.get = (_url, _options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.end("wikis release archive");
      });
      return request;
    };
    const release = {
      source: "gitee",
      tag: "v-wikis-new",
      assets: {
        wikis: {
          name: "harness-data-wikis-v-wikis-new.zip",
          downloadUrl: "https://gitee.test/harness-data-wikis-v-wikis-new.zip",
          releaseSource: "gitee"
        }
      }
    };
    const result = await updateWikis(workspace, {
      yes: true,
      log: false,
      _releaseArchivePassword: password
    }, { installMode: "github-token" }, release);

    assert.equal(result.mode, "release");
    assert.equal(result.tag, "v-wikis-new");
    assert.equal(fs.readFileSync(path.join(wikis, "index.md"), "utf8").trim(), "release-update");
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("skip wikis check passes skip checks to build-index", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const logPath = path.join(workspace, "calls.log");
  const cliPath = path.join(binDir, binaryName("data-harness-cli"));
  fs.writeFileSync(cliPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\n`, { mode: 0o755 });

  // buildAndCheck 会通过 console.log/console.warn 打印索引摘要；该测试作为
  // node --test 子进程运行时，向真实 stdout 写入会污染父子进程间的测试协议
  // 二进制流，导致 "Unable to deserialize cloned data" 反序列化错误，故静默日志。
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    await buildAndCheck(workspace, { skipWikisCheck: true, yes: true });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const calls = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.deepEqual(calls, [
    "wikis build-index --skip-checks"
  ]);
});

test("update wikis fetch uses GitHub token for HTTPS remotes", { skip: process.platform === "win32" }, async () => {
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
  "symbolic-ref --short refs/remotes/origin/HEAD")
    echo "origin/master"
    ;;
  "rev-parse origin/master ")
    echo "0123456789abcdef"
    ;;
  "status --porcelain ") ;;
  *)
    echo "unexpected git args: $*" >&2
    exit 3
    ;;
esac
`, { mode: 0o755 });

  await updateWikis(workspace, {
    githubToken: "secret-token",
    useGitWikis: true,
    env: { PATH: `${fakeBin}:${process.env.PATH || ""}` }
  }, { installMode: "github-token" });

  assert.equal(fs.readFileSync(authLog, "utf8").trim(), "x-access-token:secret-token");
});

test("update wikis switches a feature branch to the remote default branch", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const fakeBin = path.join(workspace, "fake-bin");
  const wikisDir = path.join(workspace, "wikis");
  const callsLog = path.join(workspace, "calls.log");
  fs.mkdirSync(path.join(wikisDir, ".git"), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> "${callsLog}"
if [ "$1" = "-C" ]; then
  shift
  shift
fi
case "$1 $2 $3" in
  "remote get-url origin") echo "https://github.com/lumi-ai-lab/harness-data-wikis.git" ;;
  "fetch origin ") ;;
  "rev-parse HEAD ")
    count=$(grep -c 'rev-parse HEAD' "${callsLog}")
    if [ "$count" -eq 1 ]; then echo "old-feature"; else echo "new-master"; fi
    ;;
  "symbolic-ref --short refs/remotes/origin/HEAD") echo "origin/master" ;;
  "rev-parse origin/master ") echo "new-master" ;;
  "status --porcelain ") echo " M metrics/example.md" ;;
  "reset --hard HEAD") ;;
  "clean -fd ") ;;
  "checkout -B master") ;;
  "reset --hard origin/master") ;;
  *) echo "unexpected git args: $*" >&2; exit 3 ;;
esac
`, { mode: 0o755 });

  const result = await updateWikis(workspace, {
    githubToken: "secret-token",
    yes: true,
    useGitWikis: true,
    env: { PATH: `${fakeBin}:${process.env.PATH || ""}` }
  }, { installMode: "github-token" });

  assert.deepEqual(result, { commit: "new-master" });
  const calls = fs.readFileSync(callsLog, "utf8");
  assert.match(calls, /checkout -B master origin\/master/);
  assert.match(calls, /reset --hard origin\/master/);
  assert.match(calls, /clean -fd/);
  assert.doesNotMatch(calls, /pull --ff-only/);
});

test("update wikis discards local commits, tracked changes, and untracked files", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const remote = path.join(workspace, "remote.git");
  const seed = path.join(workspace, "seed");
  const wikisDir = path.join(workspace, "wikis");
  const git = (args, cwd = workspace) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };

  git(["init", "--bare", remote]);
  git(["clone", remote, seed]);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  fs.writeFileSync(path.join(seed, "index.md"), "remote-v1\n");
  git(["add", "index.md"], seed);
  git(["commit", "-m", "initial"], seed);
  git(["push", "origin", "HEAD:master"], seed);
  git(["symbolic-ref", "HEAD", "refs/heads/master"], remote);
  git(["clone", remote, wikisDir]);
  git(["config", "user.email", "test@example.com"], wikisDir);
  git(["config", "user.name", "Test"], wikisDir);

  fs.writeFileSync(path.join(wikisDir, "index.md"), "local-commit\n");
  git(["add", "index.md"], wikisDir);
  git(["commit", "-m", "local"], wikisDir);
  fs.writeFileSync(path.join(wikisDir, "index.md"), "local-dirty\n");
  fs.writeFileSync(path.join(wikisDir, "local-only.md"), "remove me\n");

  fs.writeFileSync(path.join(seed, "index.md"), "remote-v2\n");
  git(["add", "index.md"], seed);
  git(["commit", "-m", "remote update"], seed);
  git(["push", "origin", "HEAD:master"], seed);

  const result = await updateWikis(workspace, { githubToken: "secret-token", yes: true, useGitWikis: true }, { installMode: "github-token" });

  assert.equal(fs.readFileSync(path.join(wikisDir, "index.md"), "utf8").replace(/\r\n/g, "\n"), "remote-v2\n");
  assert.equal(fs.existsSync(path.join(wikisDir, "local-only.md")), false);
  assert.equal(git(["status", "--porcelain"], wikisDir), "");
  assert.equal(git(["rev-parse", "HEAD"], wikisDir), git(["rev-parse", "origin/master"], wikisDir));
  assert.deepEqual(result, { commit: git(["rev-parse", "HEAD"], wikisDir) });
});

test("build index prints concise Chinese summary", { skip: process.platform === "win32" }, async () => {
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

function harnessResidue(dir) {
  return ["agents", "bootstrap", "config", "bin", "wikis", ".harness"].filter((name) => (
    fs.existsSync(path.join(dir, name))
  ));
}

async function withCleanAuthEnv(fn) {
  const keys = ["HARNESS_AUTH_BLOB", "HARNESS_AUTH_USER_ID", "GITHUB_TOKEN"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("collectInstallAuth rejects missing blob and invalid prefix", async () => {
  await withCleanAuthEnv(async () => {
    await assert.rejects(collectInstallAuth({ yes: true }), /auth blob is required/);
    await assert.rejects(collectInstallAuth({ yes: true, authBlob: "plain-text", authUserId: "u" }), /must start with qdm1enc/);
    await assert.rejects(collectInstallAuth({ yes: true, authBlob: "qdm1enc.ok", authUserId: "  " }), /dev_user_id is required/);
    await assert.rejects(collectInstallAuth({ yes: true, noAuth: true, authOffPassword: "wrong" }), /关闭权限密码错误/);
    const auth = await collectInstallAuth({ yes: true, authBlob: "qdm1enc.ok", authUserId: "user-1" });
    assert.deepEqual(auth, { mode: "auth-blob", blobContent: "qdm1enc.ok", devUserId: "user-1" });
  });
});

test("install fails before writes when auth materials are missing", async () => {
  await withCleanAuthEnv(async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
    await assert.rejects(installCommand({ yes: true, dir: workspace, agent: "codex" }), /auth blob is required/);
    assert.deepEqual(harnessResidue(workspace), []);
  });
});

test("install fails before writes when auth blob prefix is invalid", async () => {
  await withCleanAuthEnv(async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
    await assert.rejects(
      installCommand({ yes: true, dir: workspace, agent: "codex", authBlob: "not-encrypted", authUserId: "user-1" }),
      /must start with qdm1enc/
    );
    assert.deepEqual(harnessResidue(workspace), []);
  });
});

test("install fails before writes when no-auth password is wrong", async () => {
  await withCleanAuthEnv(async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
    await assert.rejects(
      installCommand({ yes: true, dir: workspace, agent: "codex", noAuth: true, authOffPassword: "wrong" }),
      /关闭权限密码错误/
    );
    assert.deepEqual(harnessResidue(workspace), []);
  });
});

test("install access uses a Release Wikis bundle when GitHub auth and local Wikis are both absent", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const access = await collectInstallAccess({
    yes: true,
    githubAuth: false,
    releaseSource: "gitee"
  }, workspace);
  assert.equal(access.tokenMode, false);
  assert.equal(access.remoteTools, true);
  assert.equal(access.wikisSource, "");
});

test("collectInstallAccess accepts a local wikis source without GitHub", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const source = path.join(workspace, "harness-data-wikis");
  for (const dir of ["metrics", "reports", "dims", "rules"]) fs.mkdirSync(path.join(source, dir), { recursive: true });
  fs.writeFileSync(path.join(source, "index.md"), "# wikis\n");
  const access = await collectInstallAccess({ yes: true, githubAuth: false, releaseSource: "gitee" }, workspace);
  assert.equal(access.tokenMode, false);
  assert.equal(access.remoteTools, true);
  assert.equal(access.wikisSource, source);
});

test("install session rollback clears a fresh workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const session = createInstallSession(workspace);
  assert.equal(session.isReinstall, false);
  session.begin();
  fs.mkdirSync(path.join(workspace, "agents"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "agents", "x"), "new");
  fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "config", "dev-auth.blob"), "qdm1enc.x");
  fs.mkdirSync(path.join(workspace, ".harness"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".harness", "installer-state.json"), "{}");
  session.rollback();
  assert.deepEqual(harnessResidue(workspace), []);
});

test("install session rollback restores a reinstall workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  fs.mkdirSync(path.join(workspace, "agents"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "agents", "old"), "old");
  fs.mkdirSync(path.join(workspace, "bootstrap"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "bootstrap", "cli-manifest.json"), "{}");
  fs.mkdirSync(path.join(workspace, ".harness"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".harness", "installer-state.json"), "{\"ok\":true}\n");
  const session = createInstallSession(workspace);
  assert.equal(session.isReinstall, true);
  session.begin();
  fs.writeFileSync(path.join(workspace, "agents", "old"), "new");
  fs.mkdirSync(path.join(workspace, "bin"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "bin", "tool"), "tool");
  session.rollback();
  assert.equal(fs.readFileSync(path.join(workspace, "agents", "old"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(workspace, ".harness", "installer-state.json"), "utf8"), "{\"ok\":true}\n");
  assert.equal(fs.existsSync(path.join(workspace, "bin")), false);
});

test("install session rollback restores pre-existing roots on a first install", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  fs.mkdirSync(path.join(workspace, "bin"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "bin", "keep"), "old-bin");
  fs.mkdirSync(path.join(workspace, "wikis", "rules"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "wikis", "index.md"), "old-wikis");
  fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "config", "harness-config.yaml"), "old-config");
  fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".codex", "hooks.json"), "old-hook");
  const session = createInstallSession(workspace);
  assert.equal(session.isReinstall, false);
  session.begin();
  fs.writeFileSync(path.join(workspace, "bin", "keep"), "new-bin");
  fs.writeFileSync(path.join(workspace, "bin", "tool"), "new-tool");
  fs.rmSync(path.join(workspace, "wikis"), { recursive: true, force: true });
  fs.mkdirSync(path.join(workspace, "wikis"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "wikis", "index.md"), "new-wikis");
  fs.writeFileSync(path.join(workspace, "config", "harness-config.yaml"), "new-config");
  fs.writeFileSync(path.join(workspace, "config", "qdm-cli-paths.env"), "new-env");
  fs.writeFileSync(path.join(workspace, ".codex", "hooks.json"), "new-hook");
  fs.mkdirSync(path.join(workspace, "agents"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "agents", "x"), "new");
  fs.mkdirSync(path.join(workspace, ".harness"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".harness", "installer-state.json"), "{}");
  fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".claude", "settings.json"), "new");
  session.rollback();
  assert.equal(fs.readFileSync(path.join(workspace, "bin", "keep"), "utf8"), "old-bin");
  assert.equal(fs.existsSync(path.join(workspace, "bin", "tool")), false);
  assert.equal(fs.readFileSync(path.join(workspace, "wikis", "index.md"), "utf8"), "old-wikis");
  assert.equal(fs.existsSync(path.join(workspace, "wikis", "rules")), true);
  assert.equal(fs.readFileSync(path.join(workspace, "config", "harness-config.yaml"), "utf8"), "old-config");
  assert.equal(fs.existsSync(path.join(workspace, "config", "qdm-cli-paths.env")), false);
  assert.equal(fs.readFileSync(path.join(workspace, ".codex", "hooks.json"), "utf8"), "old-hook");
  assert.equal(fs.existsSync(path.join(workspace, "agents")), false);
  assert.equal(fs.existsSync(path.join(workspace, ".harness")), false);
  assert.equal(fs.existsSync(path.join(workspace, ".claude")), false);
});

test("installToolsFromManifest rolls back earlier tools when a later download fails", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
printf '%s' '#!/bin/sh\\necho first\\n' > "$dir/${binaryName("data-harness-cli")}"
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.headers = {};
        if (String(url).includes("second-tool") && !String(url).endsWith(".sha256")) {
          response.statusCode = 404;
          callback(response);
          response.end("missing");
          return;
        }
        if (String(url).endsWith(".sha256")) {
          response.statusCode = 404;
          callback(response);
          response.end("missing");
          return;
        }
        response.statusCode = 200;
        callback(response);
        response.end("archive");
      });
      return request;
    };

    await assert.rejects(
      installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
        log: false,
        manifestOverride: {
          schemaVersion: 2,
          tools: [
            {
              name: "data-harness-cli",
              binary: "data-harness-cli",
              version: "v1",
              platforms: {
                [key]: { url: "https://example.test/first.tar.gz" }
              }
            },
            {
              name: "qdm-metric-cli",
              binary: "qdm-metric-cli",
              version: "v1",
              platforms: {
                [key]: { url: "https://example.test/second-tool.tar.gz" }
              }
            }
          ]
        }
      }),
      /download failed 404/
    );
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
  assert.equal(fs.existsSync(path.join(workspace, "bin", binaryName("data-harness-cli"))), false);
});

test("installToolsFromManifest restores the previous binary when a later tool fails", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const binDir = path.join(workspace, "bin");
  const fakeBin = path.join(workspace, "fake-bin");
  const oldBinary = "#!/bin/sh\necho old\n";
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(binDir, binaryName("data-harness-cli")), oldBinary, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    shift
    dir="$1"
  fi
  shift
done
printf '%s' '#!/bin/sh\\necho new\\n' > "$dir/${binaryName("data-harness-cli")}"
`, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalGet = https.get;
  try {
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    https.get = (url, _options, callback) => {
      const request = new EventEmitter();
      process.nextTick(() => {
        const response = new PassThrough();
        response.headers = {};
        if (String(url).includes("second-tool") && !String(url).endsWith(".sha256")) {
          response.statusCode = 404;
          callback(response);
          response.end("missing");
          return;
        }
        if (String(url).endsWith(".sha256")) {
          response.statusCode = 404;
          callback(response);
          response.end("missing");
          return;
        }
        response.statusCode = 200;
        callback(response);
        response.end("archive");
      });
      return request;
    };

    await assert.rejects(
      installToolsFromManifest(workspace, path.join(workspace, "missing.json"), {
        log: false,
        manifestOverride: {
          schemaVersion: 2,
          tools: [
            {
              name: "data-harness-cli",
              binary: "data-harness-cli",
              version: "v1",
              platforms: {
                [key]: { url: "https://example.test/first.tar.gz" }
              }
            },
            {
              name: "qdm-metric-cli",
              binary: "qdm-metric-cli",
              version: "v1",
              platforms: {
                [key]: { url: "https://example.test/second-tool.tar.gz" }
              }
            }
          ]
        }
      }),
      /download failed 404/
    );
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
  assert.equal(fs.readFileSync(path.join(binDir, binaryName("data-harness-cli")), "utf8"), oldBinary);
});
