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
import { binaryName, platformKey } from "../src/lib/platform.js";
import { defaultWorkspaceDir, userStatePath } from "../src/lib/paths.js";
import { packageVersion } from "../src/lib/package.js";
import { normalizeGitProtocol, protocolFromUrl } from "../src/lib/git-auth.js";
import { download, installToolsFromManifest, readManifest } from "../src/lib/manifest.js";
import { toolAssetName } from "../src/lib/tool-release.js";
import { buildAndCheck, installRuntimeBundle } from "../src/commands/install.js";
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
  const assetFile = `qdm-cmr-cli-v0.0.1-${key}.tar.gz`;
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
printf '%s' '${binary.replaceAll("'", "'\\''")}' > "$dir/${binaryName("qdm-cmr-cli")}"
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
            assets: [{ name: assetFile, url: "https://api.github.com/repos/pengmide/qdm-cmr-cli/releases/assets/1" }]
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
          name: "qdm-cmr-cli",
          binary: "qdm-cmr-cli",
          repo: "pengmide/qdm-cmr-cli",
          private: true,
          version: "v0.0.1",
          platforms: {
            [key]: {
              url: `https://github.com/pengmide/qdm-cmr-cli/releases/download/v0.0.1/${assetFile}`,
              sha256: sha256(archive)
            }
          }
        }]
      },
      progressWriter: { write: (chunk) => writes.push(String(chunk)) }
    });

    assert.equal(manifest.installedTools["qdm-cmr-cli"].version, "v0.0.1");
    assert.equal(fs.readFileSync(path.join(workspace, "bin", binaryName("qdm-cmr-cli")), "utf8"), binary);
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
  const assetFile = `qdm-cmr-cli-v0.0.1-${key}.tar.gz`;
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
printf '%s' '${binary.replaceAll("'", "'\\''")}' > "$dir/${binaryName("qdm-cmr-cli")}"
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
          name: "qdm-cmr-cli",
          binary: "qdm-cmr-cli",
          repo: "pengmide/qdm-cmr-cli",
          private: true,
          version: "v0.0.1",
          platforms: {
            [key]: {
              url: `https://github.com/pengmide/qdm-cmr-cli/releases/download/v0.0.1/${assetFile}`,
              sha256: sha256(archive)
            }
          }
        }]
      },
      progressWriter: { write: (chunk) => writes.push(String(chunk)) }
    });

    assert.equal(manifest.installedTools["qdm-cmr-cli"].version, "v0.0.1");
    assert.equal(fs.readFileSync(path.join(workspace, "bin", binaryName("qdm-cmr-cli")), "utf8"), binary);
    assert.match(writes.join(""), new RegExp(`下载中 [-\\\\|/] ${assetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(writes.join(""), new RegExp(`下载完成 ${assetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    process.env.PATH = originalPath;
    https.get = originalGet;
  }
});

test("private GitHub asset failure reports gh release download detail", { skip: process.platform === "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-test-"));
  const key = platformKey();
  const fakeBin = path.join(workspace, "fake-bin");
  const assetFile = `qdm-cmr-cli-v0.0.1-${key}.tar.gz`;
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
            name: "qdm-cmr-cli",
            binary: "qdm-cmr-cli",
            repo: "pengmide/qdm-cmr-cli",
            private: true,
            version: "v0.0.1",
            platforms: {
              [key]: {
                url: `https://github.com/pengmide/qdm-cmr-cli/releases/download/v0.0.1/${assetFile}`,
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
  assert.match(writes.join(""), /下载中 asset\.bin \[/);
  assert.match(writes.join(""), /100% 10 B\/10 B/);
  assert.match(writes.join(""), /下载完成 asset\.bin/);
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
