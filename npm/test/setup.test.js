import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureMetricCli, ensureWikis, isCodexPluginLayout, resolveSetupWorkspaceRoots, setupRootContext } from "../src/commands/setup.js";
import { platformKey } from "../src/lib/platform.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-setup-test-"));
  const pluginRoot = path.join(root, "plugin");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(path.join(pluginRoot, "bootstrap"), { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "bootstrap", "cli-manifest.json"), JSON.stringify({
    schemaVersion: 2,
    tools: [{ name: "qdm-metric-cli", binary: "qdm-metric-cli", repo: "pengmide/qdm-metric-cli", platforms: { [platformKey()]: { archive: "zip" } } }],
  }));
  return { root, pluginRoot, dataRoot };
}

function context(f) {
  return {
    host: "codex",
    pluginRoot: f.pluginRoot,
    resourceRoot: f.pluginRoot,
    dataRoot: f.dataRoot,
  };
}

test("Codex Plugin setup keeps managed roots inside the Plugin", async (t) => {
  const f = fixture();
  const external = path.join(f.root, "external");
  fs.mkdirSync(external, { recursive: true });
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const base = {
    ...context(f),
    configPath: path.join(f.pluginRoot, "config", "settings.json"),
    secretRoot: path.join(f.pluginRoot, "secrets"),
    workspacePolicyPath: path.join(f.pluginRoot, "config", "workspace-policy.json"),
  };
  for (const [override, expected] of [
    [{ resourceRoot: external }, /resourceRoot/],
    [{ secretRoot: external }, /secretRoot/],
    [{ workspacePolicyPath: path.join(external, "workspace-policy.json") }, /workspacePolicyPath/],
    [{ configPath: path.join(external, "settings.json") }, /configPath/],
  ]) {
    await assert.rejects(
      setupRootContext({ ...base, ...override }, { noAuth: true, env: { ...process.env, CODEX_HOME: path.join(f.root, "codex-home") } }),
      expected,
    );
  }
  assert.equal(fs.existsSync(path.join(external, "auth.blob")), false);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "wikis")), false);
});

test("--channel-auth-only is rejected outside host=qwenpaw", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const base = {
    ...context(f),
    configPath: path.join(f.pluginRoot, "config", "settings.json"),
    secretRoot: path.join(f.pluginRoot, "secrets"),
    workspacePolicyPath: path.join(f.pluginRoot, "config", "workspace-policy.json"),
  };
  await assert.rejects(
    setupRootContext({ ...base }, { channelAuthOnly: true, env: { ...process.env, CODEX_HOME: path.join(f.root, "codex-home") } }),
    /--channel-auth-only is only supported for host=qwenpaw/,
  );
});

test("ensureMetricCli copies an explicit executable into the Plugin runtime", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const source = path.join(f.root, "source-qdm-metric-cli");
  fs.writeFileSync(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.chmodSync(source, 0o755);
  const result = await ensureMetricCli(context(f), { metricCliPath: source, env: {} });
  assert.equal(isCodexPluginLayout(context(f)), true);
  assert.equal(result.status, "ready");
  assert.equal(result.path, path.join(f.pluginRoot, "runtimes", platformKey(), "qdm-metric-cli"));
  assert.equal(fs.readFileSync(result.path, "utf8"), fs.readFileSync(source, "utf8"));
});

test("ensureMetricCli resolves the latest platform asset and installs only qdm-metric-cli", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls = [];
  const latest = {
    schemaVersion: 2,
    tools: [{
      name: "qdm-metric-cli",
      binary: "qdm-metric-cli",
      version: "v-latest",
      platforms: { [platformKey()]: { url: "https://gitee.test/qdm-metric-cli.zip", name: "qdm-metric-cli-v-latest.zip", archive: "zip" } },
    }],
  };
  const result = await ensureMetricCli(context(f), {
    env: {},
    releaseArchivePassword: "fixture-password",
    giteeToken: "gitee-token",
    _resolveLatestManifest: async (manifest, key, options) => {
      calls.push({ manifest, key, options });
      return latest;
    },
    _installToolsFromManifest: async (installRoot, manifestPath, options) => {
      calls.push({ installRoot, manifestPath, options });
      const bin = path.join(installRoot, "bin", "qdm-metric-cli");
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, "#!/bin/sh\necho latest\n", { mode: 0o755 });
      fs.chmodSync(bin, 0o755);
      return latest;
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.platform, platformKey());
  assert.equal(result.manifestSha256, crypto.createHash("sha256").update(JSON.stringify(latest)).digest("hex"));
  assert.equal(fs.existsSync(result.path), true);
  assert.equal(fs.existsSync(path.join(f.pluginRoot, "runtimes", platformKey(), "bin")), false);
  assert.equal(calls[0].key, platformKey());
  assert.equal(calls[0].options.giteeToken, "gitee-token");
  assert.equal(calls[1].options._releaseArchivePassword, "fixture-password");
});

test("ensureMetricCli falls back to GitHub after a Gitee asset download failure", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const gitee = {
    schemaVersion: 2,
    tools: [{
      name: "qdm-metric-cli",
      binary: "qdm-metric-cli",
      version: "v-gitee",
      platforms: { [platformKey()]: { url: "https://gitee.test/qdm-metric-cli.zip", releaseSource: "gitee", archive: "zip" } },
    }],
  };
  const github = {
    schemaVersion: 2,
    tools: [{
      name: "qdm-metric-cli",
      binary: "qdm-metric-cli",
      version: "v-github",
      platforms: { [platformKey()]: { url: "https://github.com/pengmide/qdm-metric-cli/releases/download/v-github/qdm-metric-cli.zip", releaseSource: "github", archive: "zip" } },
    }],
  };
  const resolverSources = [];
  const installerTokens = [];
  let installAttempts = 0;
  const result = await ensureMetricCli(context(f), {
    env: {},
    releaseSource: "auto",
    noReleaseCredentialPrompt: true,
    releaseArchivePassword: "fixture-password",
    _resolveLatestManifest: async (_manifest, _key, options) => {
      resolverSources.push(options.releaseSource || "auto");
      if (options.releaseSource === "github") options.githubToken = "fallback-token";
      return options.releaseSource === "github" ? github : gitee;
    },
    _installToolsFromManifest: async (installRoot, _manifestPath, options) => {
      installerTokens.push(options.githubToken || "");
      installAttempts += 1;
      if (installAttempts === 1) throw new Error("download failed 403: https://gitee.test/qdm-metric-cli.zip");
      const bin = path.join(installRoot, "bin", "qdm-metric-cli");
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.chmodSync(bin, 0o755);
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.source, github.tools[0].platforms[platformKey()].url);
  assert.deepEqual(resolverSources, ["auto", "github"]);
  assert.deepEqual(installerTokens, ["", "fallback-token"]);
  assert.equal(installAttempts, 2);
});

function seedWikis(root) {
  for (const name of ["metrics", "reports", "dims", "rules"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, "index.md"), "# Wikis\n");
}

test("ensureWikis copies a local source into the Codex Plugin", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const source = path.join(f.root, "wikis-src");
  seedWikis(source);
  const result = await ensureWikis(context(f), { wikisSource: source });
  assert.equal(result.status, "synced");
  assert.equal(result.mode, "local");
  assert.equal(result.path, path.join(f.pluginRoot, "resources", "wikis"));
  assert.equal(fs.existsSync(path.join(result.path, "index.md")), true);
  assert.equal(fs.existsSync(path.join(f.dataRoot, "wikis")), false);
});

test("ensureWikis downloads the private Wikis ZIP into the Codex Plugin", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const calls = [];
  const result = await ensureWikis(context(f), {
    releaseArchivePassword: "fixture-password",
    _resolveLatestRelease: async (repo, buildNames) => {
      calls.push({ repo, names: buildNames("v0.0.54") });
      return { tag: "v0.0.54", asset: { name: "harness-data-wikis-v0.0.54.zip" } };
    },
    _downloadReleaseAsset: async (asset, file) => {
      calls.push({ download: asset.name, file });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "zip");
    },
    _extractArchive: async (_archive, dest) => {
      seedWikis(dest);
    },
  });
  assert.equal(result.status, "synced");
  assert.equal(result.mode, "release");
  assert.equal(result.tag, "v0.0.54");
  assert.equal(result.path, path.join(f.pluginRoot, "resources", "wikis"));
  assert.equal(fs.existsSync(path.join(result.path, "metrics")), true);
  assert.equal(calls[0].repo, "lumi-ai-lab/harness-data");
  assert.deepEqual(calls[0].names, ["harness-data-wikis-v0.0.54.zip"]);
});

test("setup rejects plugin-cache PWD and requires --workspace-allowlist", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const ctx = {
    ...context(f),
    configPath: path.join(f.pluginRoot, "config", "settings.json"),
    secretRoot: path.join(f.pluginRoot, "secrets"),
    workspacePolicyPath: path.join(f.pluginRoot, "config", "workspace-policy.json"),
  };
  const env = { ...process.env, PWD: f.pluginRoot, CODEX_HOME: path.join(f.root, "codex-home") };

  await assert.rejects(
    resolveSetupWorkspaceRoots(ctx, { yes: true, env }),
    /--workspace-allowlist \/path\/to\/your\/project/,
  );
  await assert.rejects(
    resolveSetupWorkspaceRoots(ctx, { workspaceAllowlist: f.pluginRoot, env }),
    /overlaps Harness Data roots/,
  );

  const project = path.join(f.root, "apps", "my-app");
  const prompted = await resolveSetupWorkspaceRoots(ctx, {
    env,
    interactivePrompt: true,
    _ask: async () => project,
  });
  assert.equal(prompted.roots[0], fs.realpathSync.native(project));
  assert.equal(prompted.reuseExisting, false);

  const explicit = await resolveSetupWorkspaceRoots(ctx, { workspaceAllowlist: project, env });
  assert.equal(explicit.roots[0], fs.realpathSync.native(project));

  await assert.rejects(
    setupRootContext(ctx, { noAuth: true, yes: true, env }),
    /--workspace-allowlist \/path\/to\/your\/project/,
  );
  assert.equal(fs.existsSync(path.join(f.pluginRoot, "runtimes")), false);

  fs.mkdirSync(path.dirname(ctx.workspacePolicyPath), { recursive: true });
  fs.writeFileSync(ctx.workspacePolicyPath, `${JSON.stringify({ schemaVersion: 1, roots: [project] }, null, 2)}\n`);
  const existing = await resolveSetupWorkspaceRoots(ctx, { yes: true, env });
  assert.deepEqual(existing.roots, [path.resolve(project)]);
  assert.equal(existing.reuseExisting, true);
});

test("ensureMetricCli fails without an explicit executable when downloading is disabled", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await assert.rejects(
    ensureMetricCli(context(f), { env: {}, downloadMetricCli: false }),
    /qdm-metric-cli is unavailable/,
  );
});
