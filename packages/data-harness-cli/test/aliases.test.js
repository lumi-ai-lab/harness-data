import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  exportAliases,
  importAliases,
  lintAliases,
  writeAliasesYAML,
} from "../src/lib/wikis/aliases.js";

function testWikiRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "aliases-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(
    path.join(root, "config", "harness-config.yaml"),
    "paths:\n  spec: wikis/spec\n  playbooks: wikis/playbooks\n  templates: wikis/templates\n",
  );
  return root;
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

test("aliases export lint and import dry run", () => {
  const root = testWikiRoot();
  writeFile(
    root,
    "wikis/spec/idx/business/s-sale-amt.md",
    `---
name: sale_amt
label: 销售额
aliases: ["销售金额"]
---
# 销售额
`,
  );
  writeFile(root, "wikis/playbooks/idx/business/s-sale-amt.md", "# 销售额取数\n");
  writeFile(root, "wikis/templates/idx/business/s-sale-amt.md", "# 销售额模板\n");

  const exported = exportAliases(root, null);
  assert.equal(exported.items.length, 1);
  assert.ok(exported.items[0].spec);
  assert.ok(exported.items[0].playbook);
  exported.items[0].spec.aliases = ["销售情况", "销售表现"];
  exported.items[0].spec.negative_aliases = ["预算销售额"];
  exported.items[0].playbook.aliases = ["查销售额"];
  const file = path.join(root, "aliases.yaml");
  writeAliasesYAML(file, exported);
  const lint = lintAliases(root, exported);
  assert.equal(lint.ok, true, JSON.stringify(lint));
  const result = importAliases(root, file, false);
  assert.equal(result.applied, false);
  assert.equal(result.filesToUpdate, 2);
  assert.equal(result.aliasesAdded, 3);
  assert.equal(result.negativeAliasesAdded, 1);
  const content = readFileSync(path.join(root, "wikis/spec/idx/business/s-sale-amt.md"), "utf8");
  assert.equal(content.includes("销售情况"), false);
  assert.equal(content.includes("negative_aliases"), false);
});

test("aliases export structured layout combines object paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aliases-struct-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFile(root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n");
  writeFile(
    root,
    "wikis/metrics/销售额/spec.md",
    `---
name: sale_amt
label: 销售额
aliases: ["销售金额"]
---
# 销售额
`,
  );
  writeFile(root, "wikis/metrics/销售额/playbook.md", "# 销售额取数\n");
  writeFile(root, "wikis/reports/经营综合分析报告/spec.md", "# 经营综合分析报告\n");
  writeFile(root, "wikis/reports/经营综合分析报告/playbook.md", "# 经营综合分析报告取数\n");
  writeFile(root, "wikis/reports/经营综合分析报告/template.md", "# 经营综合分析报告模板\n");

  const exported = exportAliases(root, null);
  const metric = exported.items.find((item) => item.id === "metrics.销售额");
  assert.ok(metric?.spec && metric?.playbook);
  assert.equal(metric.file_key, "metrics/销售额");
  assert.equal(metric.paths.spec, "wikis/metrics/销售额/spec.md");
  assert.equal(metric.paths.playbook, "wikis/metrics/销售额/playbook.md");
  assert.equal(metric.paths.template || "", "");
  const report = exported.items.find((item) => item.id === "reports.经营综合分析报告");
  assert.ok(report?.spec && report?.playbook);
  assert.equal(report.paths.template, "wikis/reports/经营综合分析报告/template.md");
  assert.equal(lintAliases(root, exported).ok, true);
});
