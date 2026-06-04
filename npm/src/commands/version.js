import fs from "node:fs";
import path from "node:path";
import { findWorkspaceDir, readUserState } from "../lib/paths.js";
import { readManifest } from "../lib/manifest.js";
import { packageVersion } from "../lib/package.js";

export async function versionCommand(options = {}) {
  const workspace = findWorkspaceDir(options.dir);
  const manifestPath = path.join(workspace, "bootstrap", "cli-manifest.json");
  const state = readUserState();
  const result = {
    installer: packageVersion(),
    runtime: workspace,
    runtimeTag: state.runtimeTag || "",
    installMode: state.installMode || "",
    tools: []
  };
  if (fs.existsSync(manifestPath)) {
    result.tools = (readManifest(manifestPath).tools || []).map((tool) => ({
      name: tool.name,
      binary: tool.binary,
      version: tool.version
    }));
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`installer ${result.installer}`);
    console.log(`runtime ${result.runtime}`);
    if (result.runtimeTag) console.log(`runtime bundle ${result.runtimeTag}`);
    if (result.installMode) console.log(`install mode ${result.installMode}`);
    for (const tool of result.tools) console.log(`${tool.name} ${tool.version}`);
  }
  return result;
}
