import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import readline from "node:readline";
import { commandExists, run } from "./exec.js";
import { binaryName, isExecutable, platformKey } from "./platform.js";
import { action, skip } from "./log.js";
import { releaseArchivePassword } from "./release-password.js";

export function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function manifestDigest(manifest) {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function shouldShowProgress(options = {}) {
  if (!options.progressLabel) return false;
  if (options.progressWriter) return true;
  if (options.log === false) return false;
  if (options.progress === true) return true;
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

function redrawStatusLine(writer, line = "") {
  readline.clearLine(writer, 0);
  readline.cursorTo(writer, 0);
  if (line) writer.write(line);
}

function downloadProgress(label, total, options = {}) {
  if (!shouldShowProgress(options)) return { tick() {}, done() {}, fail() {} };
  const writer = options.progressWriter || process.stdout;
  let downloaded = 0;
  let lastRenderAt = 0;
  let ended = false;
  const barWidth = 16;
  const render = () => {
    const now = Date.now();
    if (now - lastRenderAt < 80) return;
    lastRenderAt = now;
    const percent = total ? Math.min(100, Math.floor((downloaded / total) * 100)) : 0;
    const filled = total
      ? Math.min(barWidth, Math.floor((percent / 100) * barWidth))
      : Math.floor((downloaded / 1024) % barWidth);
    const bar = `${"=".repeat(filled)}${" ".repeat(barWidth - filled)}`;
    redrawStatusLine(writer, `下载中 [${bar}]${total ? ` ${percent}%` : ""}`);
  };
  render();
  return {
    tick(chunk) {
      if (ended) return;
      downloaded += chunk.length;
      render();
    },
    done() {
      if (ended) return;
      ended = true;
      if (total) downloaded = total;
      const size = total ? `${formatBytes(downloaded)}/${formatBytes(total)}` : formatBytes(downloaded);
      redrawStatusLine(writer, `下载完成 ${label} ${total ? "100% " : ""}${size}`);
      writer.write("\n");
    },
    fail() {
      if (ended) return;
      ended = true;
      redrawStatusLine(writer);
    }
  };
}

function ghDownloadStatus(label, options = {}) {
  const writer = options.progressWriter || process.stdout;
  const enabled = Boolean(options.progressWriter) || (options.log !== false && Boolean(process.stdout.isTTY) && !process.env.CI);
  if (!enabled) return { done() {}, fail() {} };
  const frames = ["-", "\\", "|", "/"];
  let index = 0;
  let ended = false;
  const render = () => redrawStatusLine(writer, `下载中 ${frames[index]}`);
  render();
  const timer = setInterval(() => {
    index = (index + 1) % frames.length;
    render();
  }, 120);
  return {
    done() {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      redrawStatusLine(writer, `下载完成 ${label}`);
      writer.write("\n");
    },
    fail() {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      redrawStatusLine(writer);
    }
  };
}

export function download(url, file, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
        const current = new URL(url);
        const next = new URL(response.headers.location, url);
        const nextHeaders = current.hostname === next.hostname ? headers : {};
        response.resume();
        download(response.headers.location, file, nextHeaders, options).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed ${response.statusCode}: ${url}`));
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const out = fs.createWriteStream(file);
      const total = Number(response.headers["content-length"]) || 0;
      const progress = downloadProgress(options.progressLabel, total, options);
      let settled = false;
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        progress.fail();
        reject(error);
      };
      response.on("data", (chunk) => progress.tick(chunk));
      response.on("error", rejectOnce);
      response.pipe(out);
      out.on("finish", () => out.close(() => {
        if (settled) return;
        settled = true;
        progress.done();
        resolve();
      }));
      out.on("error", rejectOnce);
    });
    request.on("error", reject);
  });
}

function assetName(asset) {
  return asset.name || path.basename(new URL(asset.url).pathname);
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

async function downloadPrivateWithTokenValue(asset, file, token, options = {}) {
  const apiUrl = await githubAssetApiUrl(asset, token);
  if (!apiUrl) return false;
  await download(apiUrl, file, {
    Authorization: `Bearer ${token}`,
    Accept: "application/octet-stream",
    "User-Agent": "harness-data-installer"
  }, {
    progressLabel: assetName(asset),
    log: options.log,
    progress: options.progress,
    progressWriter: options.progressWriter
  });
  return true;
}

async function downloadPrivateWithGh(asset, file, options = {}) {
  const parts = githubAssetParts(asset);
  if (!parts || !(await ghAuthenticated())) return false;
  const failures = options.failures || [];
  const tokenResult = await run("gh", ["auth", "token"], { allowFailure: true });
  const token = tokenResult.code === 0 ? tokenResult.stdout.trim() : "";
  if (token) {
    try {
      if (await downloadPrivateWithTokenValue(asset, file, token, options)) return true;
    } catch (error) {
      failures.push(error.message);
      // If Node cannot reach GitHub directly, keep the older gh download fallback available.
    }
  }
  const dir = fs.mkdtempSync(path.join(path.dirname(file), "gh-download-"));
  const status = ghDownloadStatus(assetName(asset), options);
  try {
    const result = await run("gh", ["release", "download", parts.tag, "--repo", parts.repo, "--pattern", parts.name, "--dir", dir], {
      allowFailure: true,
      stdio: "pipe"
    });
    if (result.code !== 0) {
      status.fail();
      const detail = result.stderr.trim() || result.stdout.trim();
      failures.push(`gh release download failed${detail ? `: ${detail}` : ""}`);
      return false;
    }
    const downloaded = path.join(dir, parts.name);
    if (!fs.existsSync(downloaded)) {
      status.fail();
      failures.push(`gh release download did not produce ${parts.name}`);
      return false;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.renameSync(downloaded, file);
    status.done();
    return true;
  } finally {
    status.fail();
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
  return downloadPrivateWithTokenValue(asset, file, token, options);
}

async function downloadAsset(tool, asset, file, options = {}) {
  if (asset.releaseSource === "gitee") {
    await download(asset.url, file, releaseAssetHeaders(asset, options), {
      progressLabel: assetName(asset),
      log: options.log,
      progress: options.progress,
      progressWriter: options.progressWriter
    });
    return;
  }
  if (!tool.private && !githubToken(options)) {
    await download(asset.url, file, {}, { progressLabel: assetName(asset), log: options.log, progress: options.progress, progressWriter: options.progressWriter });
    return;
  }

  if (!tool.private) {
    try {
      if (await downloadPrivateWithGh(asset, file, options)) return;
      if (await downloadPrivateWithToken(asset, file, options)) return;
    } catch {
      // Public assets must remain downloadable when an unrelated GitHub token is stale or invalid.
    }
    await download(asset.url, file, {}, { progressLabel: assetName(asset), log: options.log, progress: options.progress, progressWriter: options.progressWriter });
    return;
  }

  const failures = [];
  const privateOptions = { ...options, failures };
  if (await downloadPrivateWithGh(asset, file, privateOptions)) return;
  try {
    if (await downloadPrivateWithToken(asset, file, privateOptions)) return;
  } catch (error) {
    failures.push(error.message);
  }
  const detail = failures.filter(Boolean).join("; ");
  throw new Error(`private GitHub Release asset requires gh auth login, GITHUB_TOKEN, or --github-token: ${assetName(asset)}${detail ? ` (${detail})` : ""}`);
}

function releaseAssetHeaders(asset, options = {}) {
  const headers = { "User-Agent": "harness-data-installer" };
  if (asset?.releaseSource !== "gitee") return headers;
  const token = options.giteeToken || (options.env || process.env).GITEE_TOKEN || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function reusableInstalledTool(workspace, tool, asset, options = {}) {
  const current = tool.version ? optionsStateTool(options, tool.name) : null;
  if (!current?.version || current.version !== tool.version) return null;
  if (!current.sha256) return null;
  const binary = path.join(workspace, "bin", binaryName(tool.binary));
  if (!isExecutable(binary)) return null;
  const actualSha = fileSha256(binary);
  if (actualSha !== current.sha256) return null;
  return {
    version: current.version,
    asset: current.asset || assetName(asset),
    sha256: current.sha256
  };
}

function optionsStateTool(options, name) {
  return options?.state?.tools?.[name] || null;
}

async function extractArchiveBinary(workspace, cacheDir, archive, binDir, tool, options = {}) {
  const extractDir = fs.mkdtempSync(path.join(cacheDir, `${tool.name}-extract-`));
  try {
    if (archive.endsWith(".zip")) {
      const password = releaseArchivePassword(options);
      await run("unzip", ["-P", password, "-o", path.relative(workspace, archive), "-d", path.relative(workspace, extractDir)], {
        cwd: workspace,
        sensitiveArgs: [1]
      });
    } else {
      await run("tar", ["-xzf", path.relative(workspace, archive), "-C", path.relative(workspace, extractDir)], { cwd: workspace });
    }
    const extracted = path.join(extractDir, binaryName(tool.binary));
    if (!fs.existsSync(extracted)) throw new Error(`${tool.binary} was not extracted to archive root`);
    if (process.platform !== "win32") fs.chmodSync(extracted, 0o755);
    const binary = path.join(binDir, binaryName(tool.binary));
    fs.renameSync(extracted, binary);
    return binary;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function restoreToolBinaries(written, backups) {
  for (const binary of written.slice().reverse()) {
    const backup = backups.find((item) => item.binary === binary);
    if (backup && fs.existsSync(backup.file)) fs.copyFileSync(backup.file, binary);
    else fs.rmSync(binary, { force: true });
  }
  for (const item of backups) fs.rmSync(item.file, { force: true });
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
  const written = [];
  const backups = [];

  try {
    for (const tool of manifest.tools || []) {
      if (only && !only.has(tool.name)) continue;
      const asset = tool.platforms?.[key];
      if (!asset?.url) throw new Error(`manifest missing ${tool.name} asset for ${key}`);
      const reusable = !options.force ? reusableInstalledTool(workspace, tool, asset, options) : null;
      if (reusable) {
        if (options.log !== false) skip(`${tool.name} 已是最新 ${tool.version}`);
        installedTools[tool.name] = reusable;
        continue;
      }
      const binary = path.join(binDir, binaryName(tool.binary));
      if (fs.existsSync(binary) && !backups.some((item) => item.binary === binary)) {
        const file = `${binary}.install-bak`;
        fs.copyFileSync(binary, file);
        backups.push({ binary, file });
      }
      const archive = path.join(cacheDir, assetName(asset));
      if (options.log !== false) action(`下载 ${tool.name} ${tool.version} (${key})`);
      await downloadAsset(tool, asset, archive, options);
      await extractArchiveBinary(workspace, cacheDir, archive, binDir, tool, options);
      if (!written.includes(binary)) written.push(binary);
      const binarySha = fileSha256(binary);
      installedTools[tool.name] = {
        version: tool.version || "",
        asset: assetName(asset),
        sha256: binarySha
      };
    }
  } catch (error) {
    restoreToolBinaries(written, backups);
    throw error;
  }
  for (const item of backups) fs.rmSync(item.file, { force: true });
  Object.defineProperty(manifest, "installedTools", { value: installedTools, enumerable: false });
  return manifest;
}
