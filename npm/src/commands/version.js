import fs from "node:fs";
import path from "node:path";
import { findWorkspaceDir } from "../lib/paths.js";
import { currentCommit, submoduleCommit } from "../lib/git.js";
import { readManifest } from "../lib/manifest.js";
import { packageVersion } from "../lib/package.js";

export async function versionCommand(options = {}) {
  const workspace = findWorkspaceDir(options.dir);
  const manifestPath = path.join(workspace, "bootstrap", "cli-manifest.json");
  const result = {
    installer: packageVersion(),
    workspace,
    mainCommit: fs.existsSync(workspace) ? await currentCommit(workspace) : "",
    wikisCommit: fs.existsSync(workspace) ? await submoduleCommit(workspace) : "",
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
    console.log(`workspace ${result.workspace}`);
    if (result.mainCommit) console.log(`main ${result.mainCommit}`);
    if (result.wikisCommit) console.log(`wikis ${result.wikisCommit}`);
    for (const tool of result.tools) console.log(`${tool.name} ${tool.version}`);
  }
  return result;
}
