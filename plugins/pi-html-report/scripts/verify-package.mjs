#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyArtifact } from "../../../scripts/verify-artifact.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));
const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
const dist = resolveDist();
const errors = [];

function resolveDist() {
  const configured = String(process.env.PI_HTML_REPORT_OUTPUT_DIR || "").trim();
  if (!configured) return join(pluginRoot, "dist");
  if (!isAbsolute(configured)) throw new Error("PI_HTML_REPORT_OUTPUT_DIR must be an absolute path");
  const target = resolve(configured);
  const relativeToRepo = relative(repoRoot, target);
  const outsideRepo = /^\.\.(?:[\\/]|$)/.test(relativeToRepo) || isAbsolute(relativeToRepo);
  if (
    !relativeToRepo ||
    (!outsideRepo && [".agents", "packages", "plugins", "scripts", "npm", "config", "bootstrap", "wikis"].includes(relativeToRepo.split(/[\\/]/)[0]))
  ) {
    throw new Error(`PI_HTML_REPORT_OUTPUT_DIR must not replace a source directory: ${target}`);
  }
  return target;
}

function need(path, label) {
  if (!existsSync(path)) errors.push(`missing ${label}: ${path}`);
}

if (pkg.name !== "@lumi-ai-lab/pi-html-report") errors.push(`unexpected package name: ${pkg.name}`);
if (!pkg.pi?.extensions?.length) errors.push("package.json pi.extensions is empty");
if (!pkg.pi?.skills?.length) errors.push("package.json pi.skills is empty");
if (!pkg.pi?.subagents?.agents?.length && !pkg["pi-subagents"]?.agents?.length) {
  errors.push("package.json is missing pi.subagents.agents / pi-subagents.agents");
}

need(dist, "dist/");
need(join(dist, "extensions", "qdm-harness", "index.ts"), "qdm-harness extension");
need(join(dist, "extensions", "report-writer-fetch", "index.mjs"), "report-writer-fetch");
need(join(dist, "extensions", "report-researcher-guard", "index.mjs"), "report-researcher-guard");
need(join(dist, "extensions", "report-reviewer-guard", "index.mjs"), "report-reviewer-guard");
need(join(dist, "extensions", "report-designer-guard", "index.mjs"), "report-designer-guard");
need(join(dist, "skills", "html-report", "SKILL.md"), "html-report skill");
need(join(dist, "skills", "html-report-design", "SKILL.md"), "html-report-design skill");
need(join(dist, "vendor", "html-report-kernel", "src", "index.mjs"), "bundled kernel");
need(join(dist, "vendor", "harness-runtime-node", "src", "index.mjs"), "bundled runtime");
need(join(dist, "plugin-manifest.json"), "product plugin manifest");

for (const name of ["report-writer", "report-researcher", "report-reviewer", "report-designer"]) {
  const agentPath = join(dist, "agents", `${name}.md`);
  need(agentPath, `${name} agent`);
  if (existsSync(agentPath)) {
    const text = readFileSync(agentPath, "utf8");
    if (!text.includes("package: qdm-html-report")) errors.push(`${name} missing package: qdm-html-report`);
    if (text.includes(".agents/pi/")) errors.push(`${name} still references .agents/pi/`);
  }
}

errors.push(...verifyArtifact(dist, { kind: "pi" }).errors);

if (errors.length) {
  process.stderr.write(`${errors.map((line) => `error: ${line}`).join("\n")}\n`);
  process.exit(1);
}
console.log("pi-html-report package ok");
