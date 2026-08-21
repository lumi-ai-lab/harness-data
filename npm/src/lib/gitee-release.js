const defaultApiBaseUrl = "https://gitee.com/api/v5";
const defaultDownloadBaseUrl = "https://gitee.com";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareVersions(left, right) {
  const parse = (value) => value.replace(/^v/, "").split(/[.+-]/).map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function releaseApiUrl(release, options = {}) {
  const base = (options.giteeApiBaseUrl || defaultApiBaseUrl).replace(/\/$/, "");
  return `${base}/repos/${encodeURIComponent(release.owner)}/${encodeURIComponent(release.repo)}/releases/tags/${encodeURIComponent(release.tag)}`;
}

function assetDownloadUrl(asset, release, options = {}) {
  if (asset.browser_download_url) return asset.browser_download_url;
  if (asset.download_url) return asset.download_url;
  if (asset.downloadUrl) return asset.downloadUrl;
  const base = (options.giteeDownloadBaseUrl || defaultDownloadBaseUrl).replace(/\/$/, "");
  return `${base}/${encodeURIComponent(release.owner)}/${encodeURIComponent(release.repo)}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(asset.name)}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { headers: { "User-Agent": "harness-data-installer" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Gitee Release request failed ${response.status}: ${url}${text ? ` (${text.slice(0, 200)})` : ""}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gitee Release returned invalid JSON: ${url}`);
  }
}

function archiveSuffix(asset, key) {
  if (asset?.archive) return asset.archive;
  return key.startsWith("windows-") ? "zip" : "tar.gz";
}

export function giteeReleaseAssetName(tool, version, key) {
  return `${tool.binary}-${version}-${key}.${archiveSuffix(tool.platforms?.[key], key)}`;
}

export async function resolveLatestGiteeTool(tool, key, options = {}) {
  const release = {
    owner: tool.release?.owner || "git_pengmd",
    repo: tool.release?.repo || "harness-release",
    tag: tool.release?.tag || `${tool.binary}-latest`,
  };
  const data = await fetchJson(releaseApiUrl(release, options), options);
  if (!data || data.draft) throw new Error(`${tool.name} Gitee latest release is unavailable`);
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const allCandidates = [];
  for (const [platform, platformAsset] of Object.entries(tool.platforms || {})) {
    const pattern = new RegExp(`^${escapeRegExp(tool.binary)}-(v\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)-${escapeRegExp(platform)}\\.${escapeRegExp(archiveSuffix(platformAsset, platform))}$`);
    for (const asset of assets) {
      const match = typeof asset?.name === "string" ? asset.name.match(pattern) : null;
      if (match) allCandidates.push({ platform, asset, version: match[1] });
    }
  }
  if (!allCandidates.length) {
    throw new Error(`${tool.name} Gitee release ${release.tag} missing ${key} asset`);
  }
  const versions = [...new Set(allCandidates.map((candidate) => candidate.version))].sort((left, right) => compareVersions(right, left));
  const version = versions[0];
  const selected = allCandidates.find((candidate) => candidate.platform === key && candidate.version === version);
  const platformNames = Object.keys(tool.platforms || {});
  if (!selected || platformNames.some((platform) => !allCandidates.some((candidate) => candidate.platform === platform && candidate.version === version))) {
    throw new Error(`${tool.name} Gitee latest slot contains mixed or incomplete platform versions`);
  }
  const shaAsset = assets.find((asset) => asset?.name === `${selected.asset.name}.sha256`);
  return {
    ...tool,
    version,
    release: {
      ...tool.release,
      provider: "gitee",
      owner: release.owner,
      repo: release.repo,
      tag: release.tag,
      releaseId: data.id || "",
      publishedAt: data.published_at || data.created_at || "",
      sourceUrl: data.html_url || "",
    },
    platforms: {
      [key]: {
        archive: archiveSuffix(tool.platforms?.[key], key),
        url: assetDownloadUrl(selected.asset, release, options),
        sha256: "",
        shaAsset: shaAsset ? assetDownloadUrl(shaAsset, release, options) : "",
      },
    },
  };
}
