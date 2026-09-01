import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWithRuntimeIndex } from "../src/lib/context/build.js";
import { MODE_FREE, MODE_MULTI, MODE_SINGLE } from "../src/lib/sessionstate.js";

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeRoot(metricNames) {
  const root = mkdtempSync(path.join(tmpdir(), "harness-build-"));
  writeFile(root, "resources/wikis/rules/qdm-metric-cli/spec.md", "# metric cli\n");
  writeFile(root, "resources/wikis/rules/QDM 时间口径/spec.md", "# time policy\n");
  writeFile(root, "resources/wikis/rules/index.md", "# rules index\n");
  writeFile(root, "resources/wikis/metrics/index.md", "# metrics index\n");
  writeFile(root, "resources/wikis/reports/index.md", "# reports index\n");
  writeFile(root, "resources/wikis/dims/index.md", "# dims index\n");
  for (const name of metricNames) {
    writeFile(root, `resources/wikis/metrics/${name}/index.md`, `# ${name} index\n`);
    writeFile(root, `resources/wikis/metrics/${name}/spec.md`, `---\nname: ${name}\n---\n# ${name}\n`);
    writeFile(root, `resources/wikis/metrics/${name}/playbook.md`, `# ${name} playbook\n`);
  }
  return root;
}

function runtimeIndex(metricNames) {
  const docs = [];
  const recall = [];
  for (const name of metricNames) {
    const specPath = `metrics/${name}/spec.md`;
    docs.push({ path: specPath, kind: "spec", specType: "metric", domain: "" });
    docs.push({ path: `metrics/${name}/playbook.md`, kind: "playbook", domain: "" });
    recall.push({ term: name, targetPath: specPath });
  }
  return {
    meta: {
      paths: {
        knowledge: "resources/wikis",
        metrics: "resources/wikis/metrics",
        reports: "resources/wikis/reports",
        dims: "resources/wikis/dims",
        rules: "resources/wikis/rules",
      },
    },
    docsByPath: Object.fromEntries(docs.map((doc) => [doc.path, doc])),
    recall,
    templateSelection: [],
  };
}

function playbookPaths(plan) {
  return [...(plan.selectedPlaybooks || [])].map((candidate) => candidate.path).sort();
}

test("multi-metric enumeration hits MODE_MULTI", () => {
  const names = ["销售额", "来客数", "门店毛利率"];
  const root = makeRoot(names);
  const { plan } = buildWithRuntimeIndex(root, "8月31日华东区水果类的销售额、来客数、门店毛利率", runtimeIndex(names));
  assert.equal(plan.mode, MODE_MULTI);
  assert.deepEqual(playbookPaths(plan), [
    "metrics/来客数/playbook.md",
    "metrics/销售额/playbook.md",
    "metrics/门店毛利率/playbook.md",
  ]);
});

test("分析一下 + metric enumeration still hits MODE_MULTI", () => {
  const names = ["销售额", "来客数", "门店毛利率"];
  const root = makeRoot(names);
  const { plan } = buildWithRuntimeIndex(root, "分析一下8月31日华东区水果类的销售额、来客数、门店毛利率", runtimeIndex(names));
  assert.equal(plan.mode, MODE_MULTI);
});

test("attribution question stays out of MODE_MULTI", () => {
  const names = ["销售额", "来客数"];
  const root = makeRoot(names);
  const { plan } = buildWithRuntimeIndex(root, "分析一下销售额和来客数为什么都下降", runtimeIndex(names));
  assert.equal(plan.mode, MODE_FREE);
});

test("single metric stays MODE_SINGLE with 分析 prefix", () => {
  const names = ["销售额"];
  const root = makeRoot(names);
  const { plan } = buildWithRuntimeIndex(root, "分析一下昨天的销售额", runtimeIndex(names));
  assert.equal(plan.mode, MODE_SINGLE);
});

test("candidate flood falls back to exact-match MODE_MULTI", () => {
  const siblings = Array.from({ length: 24 }, (_, i) => `19点前来客数指标${String(i).padStart(2, "0")}`);
  const names = [...siblings, "销售额", "来客数", "门店毛利率", "门店毛利额"];
  const root = makeRoot(names);
  const { plan } = buildWithRuntimeIndex(
    root,
    "8月31日华东区水果类的总销售额、19点前来客数、门店毛利额、门店毛利率",
    runtimeIndex(names),
  );
  assert.equal(plan.mode, MODE_MULTI);
  assert.deepEqual(playbookPaths(plan), [
    "metrics/来客数/playbook.md",
    "metrics/销售额/playbook.md",
    "metrics/门店毛利率/playbook.md",
    "metrics/门店毛利额/playbook.md",
  ]);
});

test("candidate flood with zero exact matches degrades to MODE_FREE", () => {
  const siblings = Array.from({ length: 24 }, (_, i) => `19点前来客数指标${String(i).padStart(2, "0")}`);
  const root = makeRoot(siblings);
  const { plan } = buildWithRuntimeIndex(root, "19点前来客数怎么样", runtimeIndex(siblings));
  assert.equal(plan.mode, MODE_FREE);
});
