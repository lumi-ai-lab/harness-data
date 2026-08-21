import { latestRelease } from "./github.js";
import { resolveLatestGiteeTool } from "./gitee-release.js";

function archiveSuffix(asset, key) {
  if (asset?.archive) return asset.archive;
  if (asset?.url?.endsWith(".zip")) return "zip";
  if (asset?.url?.endsWith(".tar.gz")) return "tar.gz";
  return key.startsWith("windows-") ? "zip" : "tar.gz";
}

export function toolAssetName(tool, tag, key) {
  const suffix = archiveSuffix(tool.platforms?.[key], key);
  return `${tool.binary}-${tag}-${key}.${suffix}`;
}

export function releaseAsset(release, name) {
  return (release.assets || []).find((asset) => asset.name === name);
}

export async function resolveLatestTool(tool, key, options = {}) {
  if (tool.release?.provider === "gitee") return resolveLatestGiteeTool(tool, key, options);
  const release = await latestRelease(tool.repo, options);
  const tag = release.tag_name;
  const name = toolAssetName(tool, tag, key);
  const asset = releaseAsset(release, name);
  if (!asset) {
    throw new Error(`${tool.name} latest release ${tag} missing ${key} asset in ${tool.repo}: ${name}`);
  }
  return {
    ...tool,
    version: tag,
    platforms: {
      [key]: {
        url: asset.browser_download_url || `https://github.com/${tool.repo}/releases/download/${tag}/${asset.name}`,
        sha256: ""
      }
    }
  };
}

export async function resolveLatestManifest(manifest, key, options = {}) {
  const only = options.tools ? new Set(options.tools) : null;
  const tools = [];
  for (const tool of manifest.tools || []) {
    if (only && !only.has(tool.name)) continue;
    tools.push(await resolveLatestTool(tool, key, options));
  }
  return { ...manifest, tools };
}
