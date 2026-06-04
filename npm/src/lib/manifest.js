import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { commandExists, run } from "./exec.js";
import { platformKey } from "./platform.js";
import { action, warn } from "./log.js";

export function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function manifestDigest(manifest) {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function download(url, file, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
        const current = new URL(url);
        const next = new URL(response.headers.location, url);
        const nextHeaders = current.hostname === next.hostname ? headers : {};
        download(response.headers.location, file, nextHeaders).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed ${response.statusCode}: ${url}`));
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const out = fs.createWriteStream(file);
      response.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
    });
    request.on("error", reject);
  });
}

function assetName(asset) {
  return path.basename(new URL(asset.url).pathname);
}

function githubAssetParts(asset) {
  const url = new URL(asset.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "github.com" || parts.length < 6 || parts[2] !== "releases" || parts[3] !== "download") return null;
  return {
    repo: `${parts[0]}/${parts[1]}`,
    tag: parts[4],
    name: parts.slice(5).join("/")
  };
}

async function ghAuthenticated() {
  if (!(await commandExists("gh"))) return false;
  const result = await run("gh", ["auth", "status"], { allowFailure: true });
  return result.code === 0;
}

async function downloadPrivateWithGh(asset, file) {
  const parts = githubAssetParts(asset);
  if (!parts || !(await ghAuthenticated())) return false;
  const dir = fs.mkdtempSync(path.join(path.dirname(file), "gh-download-"));
  try {
    const result = await run("gh", ["release", "download", parts.tag, "--repo", parts.repo, "--pattern", parts.name, "--dir", dir], { allowFailure: true });
    if (result.code !== 0) return false;
    const downloaded = path.join(dir, parts.name);
    if (!fs.existsSync(downloaded)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.renameSync(downloaded, file);
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function githubToken(options = {}) {
  return options.githubToken || process.env.GITHUB_TOKEN || "";
}

async function githubAssetApiUrl(asset, token) {
  const parts = githubAssetParts(asset);
  if (!parts) return "";
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".bootstrap-cache-gh-"));
  const tmp = path.join(dir, "release.json");
  try {
    await download(`https://api.github.com/repos/${parts.repo}/releases/tags/${parts.tag}`, tmp, {
      Authorization: `Bearer ${token}`,
      "User-Agent": "harness-data-installer"
    });
    const release = JSON.parse(fs.readFileSync(tmp, "utf8"));
    return (release.assets || []).find((item) => item.name === parts.name)?.url || "";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function downloadPrivateWithToken(asset, file, options = {}) {
  const token = githubToken(options);
  if (!token) return false;
  const apiUrl = await githubAssetApiUrl(asset, token);
  if (!apiUrl) return false;
  await download(apiUrl, file, {
    Authorization: `Bearer ${token}`,
    Accept: "application/octet-stream",
    "User-Agent": "harness-data-installer"
  });
  return true;
}

async function downloadAsset(tool, asset, file, options = {}) {
  if (!tool.private) {
    await download(asset.url, file);
    return;
  }
  if (await downloadPrivateWithGh(asset, file)) return;
  if (await downloadPrivateWithToken(asset, file, options)) return;
  throw new Error(`private GitHub Release asset requires gh auth login, GITHUB_TOKEN, or --github-token: ${assetName(asset)}`);
}

async function expectedSha256(tool, asset, options = {}) {
  if (asset.sha256) return asset.sha256;
  try {
    const tmp = path.join(fs.mkdtempSync(path.join(process.cwd(), ".bootstrap-cache-sha-")), "asset.sha256");
    await downloadAsset(tool, { ...asset, url: `${asset.url}.sha256` }, tmp, options);
    return fs.readFileSync(tmp, "utf8").trim().split(/\s+/)[0];
  } catch {
    return "";
  }
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function installToolsFromManifest(workspace, manifestPath, options = {}) {
  const manifest = options.manifestOverride || readManifest(manifestPath);
  const only = options.tools ? new Set(options.tools) : null;
  const key = platformKey();
  const cacheDir = path.join(workspace, ".bootstrap-cache");
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const installedTools = {};

  for (const tool of manifest.tools || []) {
    if (only && !only.has(tool.name)) continue;
    const asset = tool.platforms?.[key];
    if (!asset?.url) throw new Error(`manifest missing ${tool.name} asset for ${key}`);
    const archive = path.join(cacheDir, assetName(asset));
    if (options.log !== false) action(`下载 ${tool.name} ${tool.version} (${key})`);
    await downloadAsset(tool, asset, archive, options);
    const sha = await expectedSha256(tool, asset, options);
    const actualSha = fileSha256(archive);
    if (sha && actualSha !== sha) throw new Error(`${tool.name} sha256 mismatch`);
    if (!sha) warn(`${tool.name} 未提供 sha256，已继续安装`);
    if (archive.endsWith(".zip")) {
      await run("unzip", ["-o", archive, "-d", binDir]);
    } else {
      await run("tar", ["-xzf", archive, "-C", binDir]);
    }
    const binary = path.join(binDir, tool.binary);
    if (!fs.existsSync(binary)) throw new Error(`${tool.binary} was not extracted to bin/`);
    fs.chmodSync(binary, 0o755);
    installedTools[tool.name] = {
      version: tool.version || "",
      asset: assetName(asset),
      sha256: sha || actualSha
    };
  }
  Object.defineProperty(manifest, "installedTools", { value: installedTools, enumerable: false });
  return manifest;
}
