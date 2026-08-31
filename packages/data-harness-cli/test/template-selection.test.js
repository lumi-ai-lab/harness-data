import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runWikis } from "../src/commands/wikis.js";
import { ExitError } from "../src/lib/exit.js";
import { buildIndex, loadRuntimeIndex, RESOURCE_MANIFEST_REL } from "../src/lib/wikis/index.js";
import {
  buildTemplateDoctor,
  isAllowedTemplateSelectionPath,
  loadTemplateSelectionPolicy,
  parseTemplateSelectionYAML,
  renderTemplateSelectionYAML,
  stableTemplateSelectionID,
  suggestTemplateSelection,
  validateTemplateSelectionPolicy,
} from "../src/lib/wikis/template-selection.js";

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function structuredRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "tpl-sel-"));
  writeFile(root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n");
  return root;
}

function writeReportObject(root, name) {
  writeFile(root, `wikis/reports/${name}/spec.md`, `# ${name}\n`);
  writeFile(root, `wikis/reports/${name}/playbook.md`, `# ${name}取数\n`);
  writeFile(root, `wikis/reports/${name}/template.md`, `# ${name}模板\n`);
}

function captureIO() {
  let stdout = "";
  return {
    io: {
      stdout: { write(chunk) { stdout += chunk; return true; } },
      stderr: { write() { return true; } },
    },
    stdout: () => stdout,
  };
}

test("validateTemplateSelectionPolicy matches posttool template paths", () => {
  const root = structuredRoot();
  writeReportObject(root, "经营综合分析报告");
  writeFile(root, "wikis/reports/经营综合分析报告/alt.md", "# 不可注入模板\n");

  const valid = {
    version: 1,
    templates: [
      {
        id: "business_report",
        playbook: "reports/经营综合分析报告/playbook.md",
        template: "reports/经营综合分析报告/template.md",
        type: "report",
        covers: ["reports/经营综合分析报告/spec.md"],
        intents: [],
        priority: 0,
      },
    ],
  };
  assert.deepEqual(validateTemplateSelectionPolicy(root, valid), []);

  const invalid = structuredClone(valid);
  invalid.templates[0].template = "reports/经营综合分析报告/alt.md";
  const errs = validateTemplateSelectionPolicy(root, invalid);
  assert.ok(errs.length > 0);
  assert.ok(errs.join("\n").includes("templates/... or reports/.../template.md"));
});

test("parseTemplateSelectionYAML reads scalars lists and rejects unknown keys", () => {
  const policy = parseTemplateSelectionYAML(`version: 1

templates:
  - id: business_report
    playbook: reports/经营综合分析报告/playbook.md
    template: reports/经营综合分析报告/template.md
    type: report
    domain: 经营综合分析报告
    covers:
      - reports/经营综合分析报告/spec.md
    intents: [report, diagnosis]
    priority: 80
`);
  assert.equal(policy.version, 1);
  assert.equal(policy.templates.length, 1);
  const rule = policy.templates[0];
  assert.equal(rule.id, "business_report");
  assert.equal(rule.playbook, "reports/经营综合分析报告/playbook.md");
  assert.equal(rule.template, "reports/经营综合分析报告/template.md");
  assert.equal(rule.type, "report");
  assert.equal(rule.domain, "经营综合分析报告");
  assert.deepEqual(rule.covers, ["reports/经营综合分析报告/spec.md"]);
  assert.deepEqual(rule.intents, ["report", "diagnosis"]);
  assert.equal(rule.priority, 80);

  assert.throws(() => parseTemplateSelectionYAML("version: 1\nfoo: 1\n"), /unsupported key: foo/);
  assert.throws(() => parseTemplateSelectionYAML("version:\n"), /version must be scalar/);
  assert.throws(() => parseTemplateSelectionYAML("version: 1\ntemplates: nope\n"), /templates must be a list/);
  assert.throws(
    () => parseTemplateSelectionYAML("version: 1\ntemplates:\n  - id: a\n    nope: 1\n"),
    /unsupported template field: nope/,
  );
});

test("loadTemplateSelectionPolicy prefers reports/selection.yaml then legacy templates path", () => {
  const root = structuredRoot();
  const missing = loadTemplateSelectionPolicy(root);
  assert.equal(missing.policy.version, 1);
  assert.equal(missing.policy.templates.length, 0);
  assert.ok(missing.selectionPath.endsWith(path.join("wikis", "reports", "selection.yaml")) || missing.selectionPath.endsWith("wikis/reports/selection.yaml"));

  writeFile(
    root,
    "wikis/templates/selection.yaml",
    "version: 1\ntemplates:\n  - id: legacy\n    playbook: playbooks/r-legacy.md\n    template: templates/r-legacy.md\n    type: report\n    covers:\n      - spec/r-legacy.md\n    priority: 1\n",
  );
  const legacy = loadTemplateSelectionPolicy(root);
  assert.equal(legacy.policy.templates[0].id, "legacy");

  writeFile(
    root,
    "wikis/reports/selection.yaml",
    "version: 1\ntemplates:\n  - id: current\n    playbook: reports/经营综合分析报告/playbook.md\n    template: reports/经营综合分析报告/template.md\n    type: report\n    covers:\n      - reports/经营综合分析报告/spec.md\n    priority: 2\n",
  );
  const current = loadTemplateSelectionPolicy(root);
  assert.equal(current.policy.templates[0].id, "current");
});

test("suggestTemplateSelection only keeps report and composite templates", () => {
  const root = structuredRoot();
  writeReportObject(root, "经营综合分析报告");
  writeFile(root, "wikis/reports/经营综合分析报告/alt.md", "# 不可注入模板\n");
  writeFile(root, "wikis/templates/r-profit.md", "# 盈利模板\n");
  writeFile(root, "wikis/playbooks/r-profit.md", "# 盈利取数\n");
  writeFile(root, "wikis/spec/r-profit.md", "# 盈利\n");
  writeFile(root, "wikis/templates/s-sale.md", "# 销售额模板\n");
  writeFile(root, "wikis/playbooks/s-sale.md", "# 销售额取数\n");
  writeFile(root, "wikis/spec/s-sale.md", "# 销售额\n");
  writeFile(root, "wikis/templates/c-combo.md", "# 组合模板\n");
  writeFile(root, "wikis/playbooks/c-combo.md", "# 组合取数\n");
  writeFile(root, "wikis/spec/c-combo.md", "# 组合\n");

  const suggestions = suggestTemplateSelection(root, { version: 1, templates: [] });
  const byID = Object.fromEntries(suggestions.map((rule) => [rule.id, rule]));
  assert.ok(byID["经营综合分析报告_template"]);
  assert.equal(byID["经营综合分析报告_template"].type, "report");
  assert.equal(byID["经营综合分析报告_template"].template, "reports/经营综合分析报告/template.md");
  assert.equal(byID["经营综合分析报告_template"].playbook, "reports/经营综合分析报告/playbook.md");
  assert.deepEqual(byID["经营综合分析报告_template"].covers, ["reports/经营综合分析报告/spec.md"]);
  assert.deepEqual(byID["经营综合分析报告_template"].intents, ["report", "diagnosis"]);
  assert.equal(byID["经营综合分析报告_template"].priority, 100);

  assert.ok(byID.r_profit);
  assert.equal(byID.r_profit.type, "report");
  assert.ok(byID.c_combo);
  assert.equal(byID.c_combo.type, "composite");
  assert.equal(byID.s_sale, undefined);
  assert.ok(!suggestions.some((rule) => rule.template.endsWith("/alt.md")));

  const known = suggestTemplateSelection(root, {
    version: 1,
    templates: [{ id: "existing", template: "reports/经营综合分析报告/template.md" }],
  });
  assert.ok(!known.some((rule) => rule.template === "reports/经营综合分析报告/template.md"));
});

test("buildTemplateDoctor writes suggestions and reports FAIL for invalid rules", () => {
  const root = structuredRoot();
  writeReportObject(root, "经营综合分析报告");
  writeFile(
    root,
    "wikis/reports/selection.yaml",
    `version: 1
templates:
  - id: broken
    playbook: reports/经营综合分析报告/playbook.md
    template: reports/经营综合分析报告/alt.md
    type: report
    covers:
      - reports/经营综合分析报告/spec.md
`,
  );

  const result = buildTemplateDoctor(root, "");
  assert.equal(result.status, "FAIL");
  assert.ok(result.errors.join("\n").includes("templates/... or reports/.../template.md"));
  assert.ok(result.suggestions.length > 0);
  assert.equal(result.suggestionWritten, true);
  const suggested = readFileSync(path.join(root, "selection.suggested.yaml"), "utf8");
  assert.equal(suggested, renderTemplateSelectionYAML({ version: 1, templates: result.suggestions }));
  assert.ok(suggested.includes("reports/经营综合分析报告/template.md"));
});

test("wikis templates doctor prints status and exits 1 on FAIL", async () => {
  const root = structuredRoot();
  writeReportObject(root, "经营综合分析报告");
  writeFile(
    root,
    "wikis/reports/selection.yaml",
    `version: 1
templates:
  - id: broken
    playbook: reports/经营综合分析报告/playbook.md
    template: reports/经营综合分析报告/alt.md
    type: report
    covers:
      - reports/经营综合分析报告/spec.md
`,
  );
  const cap = captureIO();
  await assert.rejects(
    () => runWikis(root, ["templates", "doctor"], cap.io),
    (error) => error instanceof ExitError && error.code === 1 && /templates doctor failed with /.test(error.message),
  );
  const out = cap.stdout();
  assert.match(out, /^templates doctor: FAIL\n/);
  assert.match(out, /^FAIL\t/m);
  assert.match(out, /^wrote /m);
});

test("wikis templates doctor json omits empty optional fields", async () => {
  const root = structuredRoot();
  const cap = captureIO();
  await runWikis(root, ["templates", "doctor", "--json"], cap.io);
  const payload = JSON.parse(cap.stdout());
  assert.equal(payload.status, "PASS");
  assert.equal(payload.suggestionWritten, false);
  assert.equal(payload.rules, undefined);
  assert.equal(payload.errors, undefined);
  assert.equal(payload.suggestions, undefined);
});

test("buildIndex copies validated template selection into the runtime index", () => {
  const root = structuredRoot();
  writeReportObject(root, "经营综合分析报告");
  writeFile(
    root,
    "wikis/reports/selection.yaml",
    `version: 1
templates:
  - id: business_report
    playbook: reports/经营综合分析报告/playbook.md
    template: reports/经营综合分析报告/template.md
    type: report
    covers:
      - reports/经营综合分析报告/spec.md
    intents:
      - report
    priority: 40
`,
  );
  buildIndex(root, true);
  const runtime = loadRuntimeIndex(root);
  const index = JSON.parse(readFileSync(path.join(root, ".harness", "index", "wikis-index.json"), "utf8"));
  assert.equal(index.meta.root, ".");
  assert.equal(index.meta.resourceId, "qdm-harness-wiki");
  assert.equal(path.isAbsolute(index.meta.root), false);
  assert.equal(runtime.templateSelection.length, 1);
  assert.equal(runtime.templateSelection[0].id, "business_report");
  assert.equal(runtime.templateSelection[0].template, "reports/经营综合分析报告/template.md");
});

test("buildIndex writes a relocatable resource manifest with verified content hashes", () => {
  const root = structuredRoot();
  writeReportObject(root, "经营综合分析报告");
  const first = buildIndex(root, true);
  const manifestPath = path.join(root, RESOURCE_MANIFEST_REL);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(first.resourceManifestPath, RESOURCE_MANIFEST_REL);
  assert.match(first.resourceVersion, /^[a-f0-9]{64}$/);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.resourceSchemaVersion, 1);
  assert.equal(manifest.resourceId, "qdm-harness-wiki");
  assert.equal(manifest.wikiContentVersion, first.resourceVersion);
  assert.equal(manifest.files.some((entry) => entry.path === ".harness/index/wikis-index.json" && entry.kind === "index"), true);
  assert.equal(manifest.files.some((entry) => entry.path === ".harness/index/wikis-runtime-index.json" && entry.kind === "index"), true);
  for (const entry of manifest.files) {
    assert.equal(path.isAbsolute(entry.path), false);
    assert.equal(entry.path.startsWith("../"), false);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    const actual = createHash("sha256").update(readFileSync(path.join(root, entry.path))).digest("hex");
    assert.equal(entry.sha256, actual, entry.path);
  }

  writeFile(root, "wikis/reports/经营综合分析报告/template.md", "# 更新后的报告模板\n");
  const second = buildIndex(root, true);
  assert.notEqual(second.resourceVersion, first.resourceVersion);
});

test("buildIndex rejects invalid template selection policy", () => {
  const root = structuredRoot();
  writeReportObject(root, "经营综合分析报告");
  writeFile(
    root,
    "wikis/reports/selection.yaml",
    `version: 1
templates:
  - id: broken
    playbook: reports/经营综合分析报告/playbook.md
    template: reports/经营综合分析报告/alt.md
    type: report
    covers:
      - reports/经营综合分析报告/spec.md
`,
  );
  assert.throws(() => buildIndex(root, true), /template selection policy invalid/);
});

test("stableTemplateSelectionID and allowed paths match Go helpers", () => {
  assert.equal(stableTemplateSelectionID("reports/经营综合分析报告/template.md"), "经营综合分析报告_template");
  assert.equal(stableTemplateSelectionID("templates/r-profit.md"), "r_profit");
  assert.equal(stableTemplateSelectionID("templates/idx/c-combo.md"), "idx_c_combo");
  assert.equal(isAllowedTemplateSelectionPath("reports/经营综合分析报告/template.md"), true);
  assert.equal(isAllowedTemplateSelectionPath("reports/经营综合分析报告/alt.md"), false);
  assert.equal(isAllowedTemplateSelectionPath("templates/r-profit.md"), true);
});
