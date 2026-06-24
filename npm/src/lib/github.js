import fs from "node:fs";
import path from "node:path";
import { commandExists, run } from "./exec.js";
import { download } from "./manifest.js";

const userAgent = "harness-data-installer";

export function githubToken(options = {}) {
  return options.githubToken || process.env.GITHUB_TOKEN || "";
}

export async function hasGithubAuth(options = {}) {
  if (githubToken(options)) return true;
  if (!(await commandExists("gh"))) return false;
  const result = await run("gh", ["auth", "status"], { allowFailure: true });
  return result.code === 0;
}

export function githubHeaders(options = {}) {
  const headers = { "User-Agent": userAgent };
  const token = githubToken(options);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function githubJson(url, options = {}) {
  if (!githubToken(options) && await commandExists("gh")) {
    const apiPath = new URL(url).pathname.replace(/^\/repos\//, "repos/");
    const result = await run("gh", ["api", apiPath], { allowFailure: true });
    if (result.code === 0 && result.stdout.trim()) return JSON.parse(result.stdout);
  }
  const tmp = path.join(fs.mkdtempSync(path.join(process.cwd(), ".github-api-")), "response.json");
  try {
    await download(url, tmp, githubHeaders(options));
    return JSON.parse(fs.readFileSync(tmp, "utf8"));
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

export async function latestRelease(repo, options = {}) {
  return githubJson(`https://api.github.com/repos/${repo}/releases/latest`, options);
}

export function findReleaseAsset(release, name) {
  return (release.assets || []).find((asset) => asset.name === name);
}

export async function downloadReleaseAsset(asset, file, options = {}) {
  const headers = { ...githubHeaders(options), Accept: "application/octet-stream" };
  await download(asset.url, file, headers, {
    progressLabel: options.progressLabel,
    log: options.log,
    progress: options.progress,
    progressWriter: options.progressWriter
  });
}
