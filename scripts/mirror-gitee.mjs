#!/usr/bin/env node
// 镜像 GitHub Release 产物到 Gitee 仓库（含 wikis 独占打包）。
//
// 用法：
//   node scripts/mirror-gitee.mjs --init              一次性初始化空 Gitee 仓（建 README 于 master）
//   node scripts/mirror-gitee.mjs --tag vX.Y.Z       镜像单个 release tag（CI / 手动）
//   node scripts/mirror-gitee.mjs --all               回填所有 GitHub 有而 Gitee 无的版本
//   node scripts/mirror-gitee.mjs --metric-latest   更新 qdm-metric-cli 最新槽位（只保留一版）
//
// 环境变量：
//   GITEE_TOKEN   必填，Gitee 私人 access token（projects 读写权限）
//   GH_TOKEN      gh CLI 认证（CI 注入 GITHUB_TOKEN 即可，本地用 gh auth login）
//   GITEE_OWNER   默认 git_pengmd
//   GITEE_REPO    默认 harness-release
//   GITHUB_REPO   默认 lumi-ai-lab/harness-data
//   GITEE_BRANCH  默认 master（release 锚点分支）
//   METRIC_GITHUB_REPO 默认 pengmide/qdm-metric-cli
//   METRIC_GITEE_TAG  默认 qdm-metric-cli-latest
//
// 零第三方依赖：仅用 Node 内置模块 + gh CLI + tar。

import { execFile, execFileSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GITEE_TOKEN = process.env.GITEE_TOKEN;
const GITEE_OWNER = process.env.GITEE_OWNER || "git_pengmd";
const GITEE_REPO = process.env.GITEE_REPO || "harness-release";
const GITHUB_REPO = process.env.GITHUB_REPO || "lumi-ai-lab/harness-data";
const METRIC_GITHUB_REPO = process.env.METRIC_GITHUB_REPO || "pengmide/qdm-metric-cli";
const METRIC_GITEE_TAG = process.env.METRIC_GITEE_TAG || "qdm-metric-cli-latest";
const TARGET_BRANCH = process.env.GITEE_BRANCH || "master";
const GITEE_API = "https://gitee.com/api/v5";
const MIRROR_RELEASE_BODY = "Release 产物下载。";
const WIKIS_ENCRYPTION_MAGIC = Buffer.from("QDMWIK1\0");
// 安装器会使用相同的固定密钥解密；该机制用于避免公开直接浏览，并非访问控制。
const WIKIS_ENCRYPTION_KEY = Buffer.from("9mpI8QlIfrfsgnmWo127wHT2dTlTXXO4L934MOTFknU=", "base64");

if (!GITEE_TOKEN) {
  console.error("✗ GITEE_TOKEN 环境变量必填（Gitee 私人 access token）");
  process.exit(1);
}

function authHeaders(extra = {}) {
  return { Authorization: `token ${GITEE_TOKEN}`, ...extra };
}

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...opts });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

/** 取 GitHub release 元数据。 */
function getGitHubRelease(tag, repo = GITHUB_REPO) {
  return ghJson([
    "release",
    "view",
    ...(tag ? [tag] : []),
    "--repo",
    repo,
    "--json",
    "tagName,assets",
  ]);
}

/** 通用 Gitee GET。 */
async function giteeGet(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${GITEE_API}${path}`;
  const res = await fetch(url, {
    headers: authHeaders(opts.headers),
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** Gitee 仓库信息。 */
async function giteeRepoInfo() {
  return giteeGet(`/repos/${GITEE_OWNER}/${GITEE_REPO}`);
}

/** 列出 Gitee 全部 release（分页取全）。 */
async function listGiteeReleases() {
  const releases = [];
  let page = 1;
  while (true) {
    const r = await giteeGet(
      `/repos/${GITEE_OWNER}/${GITEE_REPO}/releases?page=${page}&per_page=100`,
    );
    if (!r.ok) throw new Error(`列出 Gitee releases 失败: ${r.status} ${r.text}`);
    const arr = r.json || [];
    releases.push(...arr);
    if (arr.length < 100) break;
    page += 1;
    if (page > 20) break; // 2000 条上限保护
  }
  return releases;
}

/** 幂等获取或创建 Gitee release。 */
async function ensureGiteeRelease(tagName, name, body) {
  const releases = await listGiteeReleases();
  const existing = releases.find((r) => r.tag_name === tagName);
  if (existing) {
    return { id: existing.id, created: false, release: existing };
  }
  const res = await fetch(`${GITEE_API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      tag_name: tagName,
      name: name || tagName,
      body: body || "",
      target_commitish: TARGET_BRANCH,
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    throw new Error(`创建 Gitee release ${tagName} 失败: ${res.status} ${text}`);
  }
  return { id: json.id, created: true, release: json };
}

/** 取某 Gitee release 的现有附件名集合（用于查重）。 */
async function giteeReleaseAssets(releaseId) {
  const r = await giteeGet(
    `/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${releaseId}`,
  );
  if (!r.ok) throw new Error(`获取 Gitee release ${releaseId} 失败: ${r.status}`);
  const assets = r.json?.assets || [];
  return assets;
}

async function giteeReleaseAssetNames(releaseId) {
  return new Set((await giteeReleaseAssets(releaseId)).map((asset) => asset.name));
}

async function deleteAttachFile(releaseId, attachFileId, assetName) {
  const res = await fetch(
    `${GITEE_API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${releaseId}/attach_files/${attachFileId}`,
    { method: "DELETE", headers: authHeaders() },
  );
  const text = await res.text();
  if (!res.ok && res.status !== 204) {
    throw new Error(`删除 ${assetName || attachFileId} 失败: ${res.status} ${text}`);
  }
}

async function deleteGiteeRelease(releaseId, tagName) {
  const res = await fetch(
    `${GITEE_API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${releaseId}`,
    { method: "DELETE", headers: authHeaders() },
  );
  const text = await res.text();
  if (!res.ok && res.status !== 204) {
    throw new Error(`删除 Gitee Release ${tagName}: ${res.status} ${text}`);
  }
}

async function downloadGitHubAssets(repo, tag, assets) {
  const dir = mkdtempSync(join(tmpdir(), "gitee-gh-dl-"));
  const files = new Map();
  try {
    await Promise.all(assets.map(async (asset) => {
      const assetDir = mkdtempSync(join(dir, "asset-"));
      try {
        await execFileAsync("gh", [
          "release",
          "download",
          tag,
          "--repo",
          repo,
          "--pattern",
          asset.name,
          "--dir",
          assetDir,
        ], { encoding: "utf8" });
        const source = join(assetDir, asset.name);
        if (!existsSync(source)) throw new Error(`gh release download did not produce ${asset.name}`);
        files.set(asset.name, source);
      } catch (error) {
        const detail = error.stderr?.trim() || error.message;
        throw new Error(`下载 ${asset.name} 失败: ${detail}`);
      }
    }));
    return { dir, files };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** 下载 URL 到本地文件，返回 Buffer。 */
async function downloadToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 ${url} 失败: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf;
}

/** 通过 attach_files 上传一个附件到 Gitee release。 */
async function uploadAttachFile(releaseId, filePath, assetName) {
  const buf = readFileSync(filePath);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const blob = new Blob([buf], { type: "application/octet-stream" });
      const form = new FormData();
      form.append("name", assetName);
      form.append("file", blob, assetName);
      const res = await fetch(
        `${GITEE_API}/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/${releaseId}/attach_files`,
        { method: "POST", headers: authHeaders(), body: form, signal: controller.signal },
      );
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`  ! ${assetName} 上传第 ${attempt} 次失败，准备重试: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`上传 ${assetName} 失败: ${lastError?.message || "未知错误"}`);
}

/** 用 Contents API 初始化空 Gitee 仓（建 README 提交到 master）。 */
async function initRepo() {
  const info = await giteeRepoInfo();
  if (info.ok && info.json?.default_branch) {
    console.log(
      `✓ Gitee 仓已有提交（默认分支 ${info.json.default_branch}），跳过初始化`,
    );
    return;
  }
  const readme = [
    `# ${GITEE_REPO}`,
    "",
    "本仓库用于分发软件 Release 产物，供下载使用。",
    "",
    "每个 Release 包含：",
    "- `data-harness-cli` 多平台二进制及对应 `.sha256`",
    "- `harness-data-runtime` 运行时包及对应 `.sha256`",
    "- `harness-data-wikis` 加密包（Gitee 独占）及对应 `.sha256`",
    "- `qdm-metric-cli` 最新多平台二进制及对应 `.sha256`",
    "",
    "> 容器镜像（GHCR）与 npm 包不在本镜像范围。",
    "",
  ].join("\n");
  const content = Buffer.from(readme).toString("base64");
  const res = await fetch(
    `${GITEE_API}/repos/${GITEE_OWNER}/${GITEE_REPO}/contents/README.md`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        content,
        message: "chore: initialize mirror repo",
        branch: TARGET_BRANCH,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`初始化 Gitee 仓库失败: ${res.status} ${text}`);
  }
  console.log(`✓ 已在 Gitee 仓 ${TARGET_BRANCH} 分支创建 README.md`);
}

/** 构建并加密 wikis 独占包：返回加密包/sha 路径与文件名。 */
function buildEncryptedWikisBundle(tagName) {
  const dir = mkdtempSync(join(tmpdir(), "gitee-wikis-"));
  const tarName = `harness-data-wikis-${tagName}.tar.gz`;
  const tarPath = join(dir, tarName);
  const encryptedName = `${tarName}.enc`;
  const encryptedPath = join(dir, encryptedName);
  const shaName = `${encryptedName}.sha256`;
  const shaPath = join(dir, shaName);
  try {
    if (!existsSync(join(process.cwd(), "wikis"))) {
      throw new Error(
        "wikis submodule 未在仓库根检出（需 checkout 对应 tag 并启用 submodules: recursive）",
      );
    }
    // 以仓库根为基打包 wikis 目录，保留 wikis/ 前缀，但不携带子模块 Git 指针。
    execFileSync("tar", [
      "--exclude=wikis/.git",
      "-C",
      process.cwd(),
      "-czf",
      tarPath,
      "wikis",
    ]);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", WIKIS_ENCRYPTION_KEY, iv);
    const ciphertext = Buffer.concat([
      cipher.update(readFileSync(tarPath)),
      cipher.final(),
    ]);
    // 文件格式：8 字节 magic（QDMWIK1\0）+ 12 字节 IV + 16 字节认证标签 + 密文。
    writeFileSync(
      encryptedPath,
      Buffer.concat([
        WIKIS_ENCRYPTION_MAGIC,
        iv,
        cipher.getAuthTag(),
        ciphertext,
      ]),
    );
    rmSync(tarPath, { force: true });
    const h = createHash("sha256");
    h.update(readFileSync(encryptedPath));
    const sum = h.digest("hex");
    writeFileSync(shaPath, `${sum}  ${encryptedName}\n`);
    return { dir, encryptedPath, shaPath, encryptedName, shaName };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** 镜像单个 tag。 */
async function mirrorTag(tagName) {
  const gh = getGitHubRelease(tagName);
  // 确保 Gitee 仓已有提交
  const info = await giteeRepoInfo();
  if (!info.ok || !info.json?.default_branch) {
    await initRepo();
  }
  const rel = await ensureGiteeRelease(tagName, tagName, MIRROR_RELEASE_BODY);
  console.log(
    `${tagName}: Gitee release ${rel.id} ${rel.created ? "已创建" : "已存在"}`,
  );

  const existing = await giteeReleaseAssetNames(rel.id);
  const uploaded = [];
  const skipped = [];
  const failed = [];

  // 1) GitHub release 附件逐个镜像
  for (const a of gh.assets || []) {
    if (existing.has(a.name)) {
      skipped.push(a.name);
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), "gitee-dl-"));
    const dest = join(tmp, a.name);
    try {
      await downloadToFile(a.url, dest);
      await uploadAttachFile(rel.id, dest, a.name);
      existing.add(a.name);
      uploaded.push(a.name);
      console.log(`  ✓ ${a.name}`);
    } catch (e) {
      failed.push({ name: a.name, err: e.message });
      console.error(`  ✗ ${a.name}: ${e.message}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 2) wikis 独占加密包（仅 Gitee）
  let encryptedWikis;
  try {
    encryptedWikis = buildEncryptedWikisBundle(tagName);
  } catch (e) {
    console.error(`  ⚠ wikis 加密打包失败: ${e.message}（跳过独占附件）`);
  }
  if (encryptedWikis) {
    for (const [path, name] of [
      [encryptedWikis.encryptedPath, encryptedWikis.encryptedName],
      [encryptedWikis.shaPath, encryptedWikis.shaName],
    ]) {
      if (existing.has(name)) {
        skipped.push(name);
        continue;
      }
      try {
        await uploadAttachFile(rel.id, path, name);
        existing.add(name);
        uploaded.push(name);
        console.log(`  ✓ ${name}（Gitee 加密附件）`);
      } catch (e) {
        failed.push({ name, err: e.message });
        console.error(`  ✗ ${name}: ${e.message}`);
      }
    }
    rmSync(encryptedWikis.dir, { recursive: true, force: true });
  }

  console.log(
    `${tagName}: 上传 ${uploaded.length}，跳过 ${skipped.length}，失败 ${failed.length}`,
  );
  return { uploaded, skipped, failed };
}

/** 将私有 qdm-metric-cli 最新 Release 同步到固定 Gitee 槽位，只保留最新一套附件。 */
async function mirrorMetricLatest() {
  const ghRelease = getGitHubRelease("", METRIC_GITHUB_REPO);
  const sourceTag = ghRelease.tagName;
  if (!/^v\d+\.\d+\.\d+$/.test(sourceTag || "")) {
    throw new Error(`qdm-metric-cli latest tag must match vMAJOR.MINOR.PATCH: ${sourceTag || "missing"}`);
  }
  const prefix = `qdm-metric-cli-${sourceTag}-`;
  const assets = (ghRelease.assets || []).filter((asset) => asset.name.startsWith(prefix));
  if (!assets.length) throw new Error(`qdm-metric-cli ${sourceTag} has no mirrored assets`);
  const expectedNames = new Set(assets.map((asset) => asset.name));

  const info = await giteeRepoInfo();
  if (!info.ok || !info.json?.default_branch) await initRepo();
  const rel = await ensureGiteeRelease(METRIC_GITEE_TAG, "qdm-metric-cli latest", MIRROR_RELEASE_BODY);
  const existingAssets = await giteeReleaseAssets(rel.id);
  const existingNames = new Set(existingAssets.map((asset) => asset.name));
  const uploaded = [];
  const skipped = [];
  const failed = [];

  let downloads;
  try {
    downloads = await downloadGitHubAssets(METRIC_GITHUB_REPO, sourceTag, assets.filter((asset) => !existingNames.has(asset.name)));
  } catch (error) {
    return {
      sourceTag,
      uploaded,
      skipped: assets.filter((asset) => existingNames.has(asset.name)).map((asset) => asset.name),
      failed: [{ name: "download", err: error.message }],
      deleted: [],
      deletedReleases: [],
    };
  }

  try {
    for (const asset of assets) {
      if (existingNames.has(asset.name)) {
        skipped.push(asset.name);
        continue;
      }
      const file = downloads.files.get(asset.name);
      if (!file) throw new Error(`缺少已下载附件 ${asset.name}`);
      await uploadAttachFile(rel.id, file, asset.name);
      uploaded.push(asset.name);
      console.log(`  ✓ ${asset.name}`);
    }
  } catch (error) {
    failed.push({ name: "upload", err: error.message });
    console.error(`  ✗ 上传附件失败: ${error.message}`);
  } finally {
    rmSync(downloads.dir, { recursive: true, force: true });
  }

  if (failed.length) {
    console.error("  ⚠ 新版附件未全部上传，保留旧版附件，不执行清理");
    return { sourceTag, uploaded, skipped, failed, deleted: [], deletedReleases: [] };
  }

  const deleted = [];
  for (const asset of existingAssets) {
    // Gitee 会为固定 tag 自动生成 qdm-metric-cli-latest.zip/.tar.gz 源码归档，
    // 这些条目没有可删除的附件 ID；只清理由镜像脚本上传的版本化二进制附件。
    if (expectedNames.has(asset.name) || !asset.id || !/^qdm-metric-cli-v\d+\.\d+\.\d+-/.test(asset.name)) continue;
    try {
      await deleteAttachFile(rel.id, asset.id, asset.name);
      deleted.push(asset.name);
      console.log(`  ✓ 删除旧附件 ${asset.name}`);
    } catch (error) {
      failed.push({ name: asset.name, err: error.message });
      console.error(`  ✗ 删除旧附件 ${asset.name}: ${error.message}`);
    }
  }

  const deletedReleases = [];
  if (!failed.length) {
    const legacyReleases = (await listGiteeReleases()).filter((release) => (
      /^qdm-metric-cli-v\d+\.\d+\.\d+$/.test(release.tag_name || "") &&
      release.tag_name !== METRIC_GITEE_TAG
    ));
    for (const release of legacyReleases) {
      try {
        await deleteGiteeRelease(release.id, release.tag_name);
        deletedReleases.push(release.tag_name);
        console.log(`  ✓ 删除旧 Metric CLI Release ${release.tag_name}`);
      } catch (error) {
        failed.push({ name: release.tag_name, err: error.message });
        console.error(`  ✗ 删除旧 Metric CLI Release ${release.tag_name}: ${error.message}`);
      }
    }
  }

  console.log(`qdm-metric-cli ${sourceTag}: 上传 ${uploaded.length}，跳过 ${skipped.length}，删除附件 ${deleted.length}，删除 Release ${deletedReleases.length}，失败 ${failed.length}`);
  return { sourceTag, uploaded, skipped, deleted, deletedReleases, failed };
}

/** 回填所有版本。 */
async function mirrorAll() {
  const list = ghJson([
    "release",
    "list",
    "--repo",
    GITHUB_REPO,
    "--limit",
    "200",
    "--json",
    "tagName",
  ]);
  const tags = list.map((r) => r.tagName).filter(Boolean);
  // 按语义版本降序（新版本优先）
  tags.sort((a, b) => {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i += 1) {
      const d = (pb[i] || 0) - (pa[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  let totalFailed = 0;
  for (const t of tags) {
    console.log(`\n=== 镜像 ${t} ===`);
    try {
      const r = await mirrorTag(t);
      totalFailed += r.failed.length;
    } catch (e) {
      console.error(`镜像 ${t} 整体失败: ${e.message}`);
      totalFailed += 1;
    }
  }
  console.log(`\n回填完成，共 ${tags.length} 个版本，失败项 ${totalFailed}`);
  process.exit(totalFailed ? 1 : 0);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "--init") {
    await initRepo();
    return;
  }
  if (cmd === "--tag") {
    const tag = rest[0];
    if (!tag) {
      console.error("✗ --tag 需要一个版本号参数，如 --tag v0.0.48");
      process.exit(1);
    }
    const r = await mirrorTag(tag);
    process.exit(r.failed.length ? 1 : 0);
  }
  if (cmd === "--all") {
    await mirrorAll();
    return;
  }
  if (cmd === "--metric-latest") {
    const result = await mirrorMetricLatest();
    process.exit(result.failed.length ? 1 : 0);
  }
  console.error("用法: node scripts/mirror-gitee.mjs --init | --tag <tag> | --all | --metric-latest");
  process.exit(1);
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
