import { resolveLatestRelease } from "./release-source.js";

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
  const resolved = await resolveLatestRelease(tool.repo, (tag) => [
    `${tool.binary}-${tag}-${key}.zip`,
    toolAssetName(tool, tag, key),
    `${tool.binary}-${tag}-${key}.tar.gz`
  ], options);
  const { asset, tag } = resolved;
  return {
    ...tool,
    version: tag,
    platforms: {
      [key]: {
        url: asset.downloadUrl,
        name: asset.name,
        releaseSource: resolved.source,
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
