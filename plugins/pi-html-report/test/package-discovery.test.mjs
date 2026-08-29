import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));

function run(script) {
  const result = spawnSync(process.execPath, [join(pluginRoot, "scripts", script)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("package.json declares PI extension, skill, and agent discovery", () => {
  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@lumi-ai-lab/pi-html-report");
  assert.deepEqual(pkg.pi.extensions, ["./dist/extensions/qdm-harness/index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./dist/skills"]);
  assert.deepEqual(pkg.pi.subagents.agents, ["./dist/agents"]);
  assert.deepEqual(pkg["pi-subagents"].agents, ["./dist/agents"]);
});

test("build produces a self-contained dist that verify-package accepts", () => {
  run("build-package.mjs");
  const verified = run("verify-package.mjs");
  assert.match(verified.stdout, /package ok/);

  const productManifest = JSON.parse(readFileSync(join(pluginRoot, "dist", "plugin-manifest.json"), "utf8"));
  assert.equal(productManifest.host, "pi");
  assert.equal(productManifest.plugin.version, "0.0.46");
  assert.equal(productManifest.core.packages.htmlReportKernel.version, "0.0.46");
  assert.equal(productManifest.resource.mode, "external");

  const writer = readFileSync(join(pluginRoot, "dist", "agents", "report-writer.md"), "utf8");
  assert.match(writer, /^package: qdm-html-report$/m);
  assert.match(writer, /subagentOnlyExtensions: \.\.\/extensions\/report-writer-fetch\/index\.mjs/);
  assert.equal(writer.includes(".agents/pi/"), false);

  const fetchShim = readFileSync(
    join(pluginRoot, "dist", "skills", "html-report", "scripts", "fetch-entry.mjs"),
    "utf8"
  );
  assert.match(fetchShim, /vendor\/html-report-kernel\/src\/data\/fetch-entry\.mjs/);
  assert.equal(fetchShim.includes(".agents/pi/"), false);
});
