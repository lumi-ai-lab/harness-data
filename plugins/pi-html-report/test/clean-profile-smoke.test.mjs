import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));
const REQUIRED_ROLES = [
  "report-writer",
  "report-researcher",
  "report-reviewer",
  "report-designer",
];

function runNode(script, cwd = repoRoot) {
  const result = spawnSync(process.execPath, [join(pluginRoot, "scripts", script)], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function makeWorkdir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-html-report-smoke-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function extractPackage(tarball, dest) {
  mkdirSync(dest, { recursive: true });
  const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", dest], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr || unpacked.stdout);
  return join(dest, "package");
}

function agentNamesFromPackage(packageRoot) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const dirs = [
    ...((pkg["pi-subagents"] && pkg["pi-subagents"].agents) || []),
    ...(((pkg.pi && pkg.pi.subagents && pkg.pi.subagents.agents) || [])),
  ];
  const names = [];
  for (const rel of [...new Set(dirs)]) {
    const agentDir = join(packageRoot, rel);
    if (!existsSync(agentDir)) continue;
    for (const file of readdirSync(agentDir)) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(agentDir, file), "utf8");
      const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
      const pkgName = /^package:\s*(.+)$/m.exec(text)?.[1]?.trim();
      names.push({
        file,
        name,
        package: pkgName,
        runtimeName: pkgName && name ? `${pkgName}.${name}` : name,
        text,
      });
    }
  }
  return names;
}

function assertPackageResources(packageRoot) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@lumi-ai-lab/pi-html-report");
  assert.ok(Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.length > 0);
  assert.ok(Array.isArray(pkg.pi?.skills) && pkg.pi.skills.length > 0);
  assert.ok(Array.isArray(pkg.pi?.subagents?.agents) && pkg.pi.subagents.agents.length > 0);

  for (const rel of pkg.pi.extensions) {
    assert.equal(existsSync(join(packageRoot, rel)), true, `missing extension ${rel}`);
  }
  for (const rel of pkg.pi.skills) {
    assert.equal(existsSync(join(packageRoot, rel, "html-report", "SKILL.md")), true, `missing skill in ${rel}`);
  }

  const agents = agentNamesFromPackage(packageRoot);
  const runtimeNames = agents.map((agent) => agent.runtimeName);
  for (const role of REQUIRED_ROLES) {
    assert.equal(
      runtimeNames.includes(`harness-data.${role}`),
      true,
      `missing package agent harness-data.${role}: ${runtimeNames.join(",")}`
    );
  }
  for (const agent of agents) {
    assert.equal(agent.text.includes(".agents/pi/"), false, `${agent.file} still references .agents/pi`);
  }
}

test("npm pack extract is a self-contained PI plugin without repo .agents/pi", async (t) => {
  runNode("build-package.mjs");
  const work = makeWorkdir(t);
  const packed = spawnSync("npm", ["pack", "--pack-destination", work], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const tarball = readdirSync(work).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, packed.stdout);
  const packageRoot = extractPackage(join(work, tarball), join(work, "extracted"));
  assertPackageResources(packageRoot);
  assert.equal(existsSync(join(packageRoot, ".agents")), false);

  const kernel = await import(
    pathToFileURL(join(packageRoot, "dist/vendor/html-report-kernel/src/query/metric-query-contract.mjs")).href
  );
  assert.equal(typeof kernel.normalizeMetricQuery, "function");
});

test("clean PI profile can pi install the local plugin and list it", (t) => {
  const pi = spawnSync("which", ["pi"], { encoding: "utf8" });
  if (pi.status !== 0) {
    t.skip("pi CLI is not on PATH");
    return;
  }

  runNode("build-package.mjs");
  const work = makeWorkdir(t);
  const profile = join(work, "pi-home");
  const workspace = join(work, "workspace");
  mkdirSync(profile, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const installed = spawnSync("pi", ["install", pluginRoot, "-l", "--approve"], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: profile,
      HOME: work,
    },
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.match(installed.stdout + installed.stderr, /Installed/);

  const settingsPath = join(workspace, ".pi", "settings.json");
  assert.equal(existsSync(settingsPath), true, "project-local settings.json missing");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const sources = (settings.packages || []).map((entry) => typeof entry === "string" ? entry : entry.source);
  assert.ok(
    sources.some((source) => source === pluginRoot || source.endsWith("plugins/pi-html-report")),
    `settings packages=${JSON.stringify(sources)}`
  );

  const listed = spawnSync("pi", ["list", "--approve"], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: profile,
      HOME: work,
    },
  });
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  assert.match(listed.stdout, /pi-html-report/);

  const userSettings = join(profile, "settings.json");
  if (existsSync(userSettings)) {
    const user = JSON.parse(readFileSync(userSettings, "utf8"));
    const userSources = (user.packages || []).map((entry) => typeof entry === "string" ? entry : entry.source);
    assert.equal(
      userSources.some((source) => String(source).includes("pi-html-report")),
      false,
      "clean-profile install leaked into the isolated user settings"
    );
  }

  assertPackageResources(pluginRoot);
  assert.equal(existsSync(join(workspace, ".agents")), false);
});
