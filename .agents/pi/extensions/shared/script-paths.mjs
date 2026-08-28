import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packageResourceRootFromExtension(importMetaUrl) {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "../..");
}

export function htmlReportScriptsDir(importMetaUrl) {
  return join(packageResourceRootFromExtension(importMetaUrl), "skills", "html-report", "scripts");
}

export function logicalHtmlReportScript(fileName) {
  return `.agents/pi/skills/html-report/scripts/${fileName}`;
}

export function htmlReportScriptCandidates(importMetaUrl, fileName, projectRoot) {
  const logical = logicalHtmlReportScript(fileName);
  const packaged = join(htmlReportScriptsDir(importMetaUrl), fileName);
  const workspace = projectRoot ? join(projectRoot, logical) : "";
  return [...new Set([logical, packaged, workspace].filter(Boolean))];
}

export function matchesHtmlReportScript(token, candidates) {
  return candidates.includes(token);
}

function isHarnessRoot(dir) {
  return existsSync(join(dir, "config", "harness-config.yaml"))
    || existsSync(join(dir, "bin", "data-harness-cli"));
}

export function resolveProjectRoot(importMetaUrl, cwd = process.cwd()) {
  const fromLegacyLayout = resolve(dirname(fileURLToPath(importMetaUrl)), "../../../..");
  if (isHarnessRoot(fromLegacyLayout)) return fromLegacyLayout;
  let dir = resolve(cwd);
  for (let i = 0; i < 20; i++) {
    if (isHarnessRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fromLegacyLayout;
}
