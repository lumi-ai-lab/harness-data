import { latestRelease } from "./github.js";

function archiveSuffix(asset, key) {
  if (asset?.archive) return asset.archive;
  if (asset?.url?.endsWith(".zip")) return "zip";
  if (asset?.url?.endsWith(".tar.gz")) return "tar.gz";
  return "zip";
}

export function toolAssetName(tool, tag, key) {
  const suffix = archiveSuffix(tool.platforms?.[key], key);
  return `${tool.binary}-${tag}-${key}.${suffix}`;
}

export function releaseAsset(release, name) {
  return (release.assets || []).find((asset) => asset.name === name);
}

export async function resolveLatestTool(tool, key, options = {}) {
  const release = await latestRelease(tool.repo, options);
  const tag = release.tag_name;
  const names = [...new Set([
    `${tool.binary}-${tag}-${key}.zip`,
    toolAssetName(tool, tag, key),
    `${tool.binary}-${tag}-${key}.tar.gz`
  ])];
  const asset = names.map((name) => releaseAsset(release, name)).find(Boolean);
  if (!asset) {
    throw new Error(`${tool.name} latest release ${tag} missing ${key} asset in ${tool.repo}: ${names.join(", ")}`);
  }
  return {
    ...tool,
    version: tag,
    platforms: {
      [key]: {
        url: asset.browser_download_url || `https://github.com/${tool.repo}/releases/download/${tag}/${asset.name}`,
        archive: asset.name.endsWith(".zip") ? "zip" : "tar.gz"
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
