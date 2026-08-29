#!/usr/bin/env node
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { writePluginManifest } from "../../../scripts/build-plugin-manifest.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));
const dist = join(pluginRoot, "dist");
const piRoot = join(repoRoot, ".agents", "pi");
const pluginPackage = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));

const KERNEL_SHIMS = {
  "metric-query-contract.mjs": "html-report-kernel/src/query/metric-query-contract.mjs",
  "fetch-entry.mjs": "html-report-kernel/src/data/fetch-entry.mjs",
  "fetch-explore.mjs": "html-report-kernel/src/data/fetch-explore.mjs",
  "writer-return.mjs": "html-report-kernel/src/session/writer-return.mjs",
  "caption-dims.mjs": "html-report-kernel/src/evidence/caption-dims.mjs",
  "prepare-card-caption-evidence.mjs": "html-report-kernel/src/evidence/prepare-card-caption-evidence.mjs",
  "prepare-research-evidence.mjs": "html-report-kernel/src/evidence/prepare-research-evidence.mjs",
  "submit-card-caption.mjs": "html-report-kernel/src/captions/submit-card-caption.mjs",
  "assemble-report.mjs": "html-report-kernel/src/artifacts/assemble-report.mjs",
  "compose-main.mjs": "html-report-kernel/src/artifacts/compose-main.mjs",
  "export-main-html.mjs": "html-report-kernel/src/artifacts/export-main-html.mjs",
  "research-contract.mjs": "html-report-kernel/src/contracts/research-contract.mjs",
  "metric-cli-executor.mjs": "harness-runtime-node/src/metric-cli-executor.mjs",
  "metric-timeout.mjs": "harness-runtime-node/src/metric-timeout.mjs",
  "metric-retry.mjs": "harness-runtime-node/src/metric-retry.mjs",
  "open-metric-cli-ui.mjs": "harness-runtime-node/src/open-metric-cli-ui.mjs",
};

const CLI_SHIMS = new Set([
  "fetch-entry.mjs",
  "fetch-explore.mjs",
  "prepare-card-caption-evidence.mjs",
  "prepare-research-evidence.mjs",
  "assemble-report.mjs",
  "compose-main.mjs",
  "export-main-html.mjs",
  "open-metric-cli-ui.mjs",
]);

const AGENTS = [
  {
    file: "report-writer.md",
    extension: "report-writer-fetch/index.mjs",
  },
  {
    file: "report-researcher.md",
    extension: "report-researcher-guard/index.mjs",
  },
  {
    file: "report-reviewer.md",
    extension: "report-reviewer-guard/index.mjs",
  },
  {
    file: "report-designer.md",
    extension: "report-designer-guard/index.mjs",
  },
];

function copyDir(src, dest, { skip } = {}) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (skip && skip(name, src)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    if (statSync(from).isDirectory()) copyDir(from, to, { skip });
    else cpSync(from, to);
  }
}

function skipArtifactTestEntry(name) {
  return name === "test" || /\.(?:test|spec)\.(?:[cm]?[jt]s|ts)$/i.test(name);
}

function posixRel(fromDir, toFile) {
  const rel = relative(fromDir, toFile).split("\\").join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function writeShim(destFile, targetFile, { cli = false, bindCli = false } = {}) {
  const rel = posixRel(dirname(destFile), targetFile);
  const lines = ["#!/usr/bin/env node"];
  lines.push(`export * from "${rel}";`);
  if (bindCli) {
    lines.push(`import { bindCliScriptPath, runCli } from "${rel}";`);
    lines.push(`import { realpathSync } from "node:fs";`);
    lines.push(`import { fileURLToPath } from "node:url";`);
    lines.push(`const cliScriptPath = fileURLToPath(import.meta.url);`);
    lines.push(`bindCliScriptPath(cliScriptPath);`);
    lines.push(`if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(cliScriptPath)) {`);
    lines.push(`  runCli().catch((error) => {`);
    lines.push(`    process.stderr.write(\`\${error instanceof Error ? error.message : String(error)}\\n\`);`);
    lines.push(`    process.exit(1);`);
    lines.push(`  });`);
    lines.push(`}`);
  } else if (cli) {
    lines.push(`import { runCli } from "${rel}";`);
    lines.push(`import { fileURLToPath } from "node:url";`);
    lines.push(`if (process.argv[1] === fileURLToPath(import.meta.url)) {`);
    lines.push(`  await runCli();`);
    lines.push(`}`);
  }
  writeFileSync(destFile, `${lines.join("\n")}\n`);
}

function rewriteAgent(sourceText, destFile, extensionRel) {
  const rewritten = sourceText
    .replace(/^name: (\S+)/m, "name: $1\npackage: qdm-html-report")
    .replace(
      /^subagentOnlyExtensions: \S+/m,
      `subagentOnlyExtensions: ${extensionRel}`
    )
    .replace(/\.agents\/pi\//g, "");
  writeFileSync(destFile, rewritten);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

copyDir(join(repoRoot, "packages", "html-report-kernel"), join(dist, "vendor", "html-report-kernel"), { skip: skipArtifactTestEntry });
copyDir(join(repoRoot, "packages", "harness-runtime-node"), join(dist, "vendor", "harness-runtime-node"), { skip: skipArtifactTestEntry });

copyDir(join(piRoot, "extensions"), join(dist, "extensions"), {
  skip: skipArtifactTestEntry,
});
writeShim(
  join(dist, "extensions", "qdm-harness", "authz-config.mjs"),
  join(dist, "vendor", "harness-runtime-node", "src", "authz-config.mjs")
);
writeShim(
  join(dist, "extensions", "qdm-harness", "lumi-envelope.mjs"),
  join(dist, "vendor", "harness-runtime-node", "src", "lumi-envelope.mjs")
);

copyDir(join(piRoot, "skills", "html-report"), join(dist, "skills", "html-report"), {
  skip: skipArtifactTestEntry,
});
copyDir(join(piRoot, "skills", "html-report-design"), join(dist, "skills", "html-report-design"), { skip: skipArtifactTestEntry });

const scriptsDir = join(dist, "skills", "html-report", "scripts");
for (const [name, vendorRel] of Object.entries(KERNEL_SHIMS)) {
  writeShim(join(scriptsDir, name), join(dist, "vendor", vendorRel), {
    cli: CLI_SHIMS.has(name),
    bindCli: name === "open-metric-cli-ui.mjs",
  });
}

const editorContract = join(scriptsDir, "editor-plan-contract.mjs");
const sourceInventoryCache = join(
  dist,
  "vendor",
  "html-report-kernel",
  "src",
  "editor",
  "source-inventory-cache.mjs"
);
const editorContractSource = readFileSync(editorContract, "utf8");
const packagedEditorContract = editorContractSource.replace(
  /from ["'][^"']*source-inventory-cache\.mjs["']/,
  `from "${posixRel(dirname(editorContract), sourceInventoryCache)}"`
);
if (packagedEditorContract === editorContractSource) {
  throw new Error("editor-plan-contract.mjs must import source-inventory-cache.mjs from the kernel");
}
writeFileSync(
  editorContract,
  packagedEditorContract
);

mkdirSync(join(dist, "agents"), { recursive: true });
for (const agent of AGENTS) {
  const source = readFileSync(join(piRoot, "agents", agent.file), "utf8");
  const dest = join(dist, "agents", agent.file);
  const extensionPath = posixRel(join(dist, "agents"), join(dist, "extensions", agent.extension));
  rewriteAgent(
    source,
    dest,
    extensionPath
  );
}

writeFileSync(
  join(dist, "manifest.json"),
  `${JSON.stringify({
    name: "@lumi-ai-lab/pi-html-report",
    kernelApi: "v1",
    agents: AGENTS.map((agent) => agent.file.replace(/\.md$/, "")),
  }, null, 2)}\n`
);

writePluginManifest({
  artifactRoot: dist,
  host: "pi",
  pluginName: pluginPackage.name,
  pluginVersion: pluginPackage.version,
  resourceMode: "external",
});

console.log(`built ${relative(repoRoot, dist)}`);
