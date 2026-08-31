import fs from "node:fs";
import path from "node:path";
import { download } from "./manifest.js";
import { downloadReleaseAsset as downloadGithubReleaseAsset, githubJson } from "./github.js";

const userAgent = "harness-data-installer";
const sources = new Set(["auto", "gitee", "github"]);

export function giteeToken(options = {}) {
  return options.giteeToken || (options.env || process.env).GITEE_TOKEN || "";
}

export function giteeHeaders(options = {}) {
  const headers = { "User-Agent": userAgent };
  const token = giteeToken(options);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
const giteeMirrorRepos = Object.freeze({
  "lumi-ai-lab/harness-data": "git_pengmd/harness-release",
  "pengmide/qdm-metric-cli": "git_pengmd/harness-metric-release"
});

export function resolveReleaseSource(options = {}) {
  const hasOption = Object.prototype.hasOwnProperty.call(options, "releaseSource");
  const env = options.env || process.env;
  const raw = hasOption ? options.releaseSource : (env.HARNESS_RELEASE_SOURCE || "auto");
  const source = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!sources.has(source)) {
    throw new Error(`invalid release source ${JSON.stringify(raw)}; expected auto, gitee, or github`);
  }
  return source;
}

export function giteeReleaseRepo(repo) {
  const mirror = giteeMirrorRepos[repo];
  if (!mirror) throw new Error(`Gitee Release mirror is not configured for ${repo}`);
  return mirror;
}

function sourceLabel(source) {
  return source === "gitee" ? "Gitee" : "GitHub";
}

function releaseAsset(release, names) {
  return names.map((name) => (release.assets || []).find((asset) => asset.name === name)).find(Boolean);
}

function releaseAssetNames(buildNames, tag) {
  const value = typeof buildNames === "function" ? buildNames(tag) : buildNames;
  const names = [...new Set((Array.isArray(value) ? value : [value]).filter(Boolean))];
  if (!names.length) throw new Error("release asset name is required");
  return names;
}

async function giteeJson(url, options = {}) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".gitee-api-"));
  const file = path.join(dir, "response.json");
  try {
    await download(url, file, giteeHeaders(options));
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function latestReleaseFrom(source, repo, options) {
  if (source === "github") {
    return {
      repo,
      release: await githubJson(`https://api.github.com/repos/${repo}/releases/latest`, options)
    };
  }
  const mirrorRepo = giteeReleaseRepo(repo);
  return {
    repo: mirrorRepo,
    release: await giteeJson(`https://gitee.com/api/v5/repos/${mirrorRepo}/releases/latest`, options)
  };
}

function publicAssetUrl(source, repo, tag, asset) {
  if (asset.browser_download_url) return asset.browser_download_url;
  if (asset.download_url) return asset.download_url;
  const encodedName = asset.name.split("/").map(encodeURIComponent).join("/");
  return source === "gitee"
    ? `https://gitee.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodedName}`
    : `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodedName}`;
}

function missingAssetError(source, repo, tag, names) {
  return new Error(`${sourceLabel(source)} latest Release ${tag || "(missing tag)"} missing required asset in ${repo}: ${names.join(", ")}`);
}

export async function resolveLatestRelease(repo, buildAssetNames, options = {}) {
  const resolved = await resolveLatestReleaseAssets(repo, (tag) => ({
    asset: typeof buildAssetNames === "function" ? buildAssetNames(tag) : buildAssetNames
  }), options);
  return {
    ...resolved,
    asset: resolved.assets.asset
  };
}

function releaseAssetGroups(buildAssetNames, tag) {
  const value = typeof buildAssetNames === "function" ? buildAssetNames(tag) : buildAssetNames;
  if (!value || Array.isArray(value) || typeof value === "string") {
    return { asset: releaseAssetNames(value, tag) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, names]) => [
    key,
    releaseAssetNames(names, tag)
  ]));
}

function resolvedAssets(source, repo, tag, release, groups) {
  const assets = {};
  for (const [key, names] of Object.entries(groups)) {
    const asset = releaseAsset(release, names);
    if (!asset) throw missingAssetError(source, repo, tag, names);
    assets[key] = {
      ...asset,
      downloadUrl: publicAssetUrl(source, repo, tag, asset),
      releaseSource: source,
      releaseRepo: repo
    };
  }
  return assets;
}

export async function resolveLatestReleaseAssets(repo, buildAssetNames, options = {}) {
  const requestedSource = resolveReleaseSource(options);
  const candidates = requestedSource === "auto" ? ["gitee", "github"] : [requestedSource];
  const failures = [];

  for (const source of candidates) {
    try {
      const result = await latestReleaseFrom(source, repo, options);
      const tag = result.release.tag_name;
      const groups = releaseAssetGroups(buildAssetNames, tag);
      const allNames = Object.values(groups).flat();
      if (!tag) throw missingAssetError(source, result.repo, tag, allNames);
      return {
        source,
        repo: result.repo,
        release: result.release,
        tag,
        assets: resolvedAssets(source, result.repo, tag, result.release, groups)
      };
    } catch (error) {
      if (requestedSource !== "auto") {
        throw new Error(`${sourceLabel(source)} Release lookup failed for ${repo}: ${error.message}`);
      }
      failures.push(`${sourceLabel(source)}: ${error.message}`);
    }
  }

  throw new Error(`Release asset unavailable for ${repo}: ${failures.join("; ")}`);
}

export async function downloadReleaseAsset(asset, file, options = {}) {
  if (asset.releaseSource !== "gitee") {
    return downloadGithubReleaseAsset(asset, file, options);
  }
  const url = asset.downloadUrl || asset.browser_download_url || asset.download_url;
  if (!url) throw new Error(`Gitee Release asset has no download URL: ${asset.name || "unknown"}`);
  await download(url, file, giteeHeaders(options), {
    progressLabel: options.progressLabel,
    log: options.log,
    progress: options.progress,
    progressWriter: options.progressWriter
  });
}
