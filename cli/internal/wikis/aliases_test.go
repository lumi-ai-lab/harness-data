package wikis

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAliasesExportLintAndImportDryRun(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/idx/business/s-sale-amt.md", `---
name: sale_amt
label: 销售额
aliases: ["销售金额"]
---
# 销售额
`)
	writeFile(t, root, "wikis/playbooks/idx/business/s-sale-amt.md", "# 销售额取数\n")
	writeFile(t, root, "wikis/templates/idx/business/s-sale-amt.md", "# 销售额模板\n")

	exported, err := ExportAliases(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(exported.Items) != 1 || exported.Items[0].Spec == nil || exported.Items[0].Playbook == nil {
		t.Fatalf("unexpected export: %+v", exported)
	}
	exported.Items[0].Spec.Aliases = []string{"销售情况", "销售表现"}
	exported.Items[0].Spec.NegativeAliases = []string{"预算销售额"}
	exported.Items[0].Playbook.Aliases = []string{"查销售额"}
	file := filepath.Join(root, "aliases.yaml")
	if err := WriteAliasesYAML(file, exported); err != nil {
		t.Fatal(err)
	}

	lint, err := LintAliasesFile(root, file)
	if err != nil {
		t.Fatal(err)
	}
	if !lint.OK {
		t.Fatalf("expected lint ok, got %+v", lint)
	}
	result, err := ImportAliases(root, file, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied || result.FilesToUpdate != 2 || result.AliasesAdded != 3 || result.NegativeAliasesAdded != 1 {
		t.Fatalf("unexpected dry run result: %+v", result)
	}
	content := readAliasTestFile(t, root, "wikis/spec/idx/business/s-sale-amt.md")
	if strings.Contains(content, "销售情况") || strings.Contains(content, "negative_aliases") {
		t.Fatalf("dry run should not update markdown:\n%s", content)
	}
}

func TestAliasesExportStructuredLayoutCombinesObjectPaths(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeFile(t, root, "wikis/metrics/销售额/spec.md", `---
name: sale_amt
label: 销售额
aliases: ["销售金额"]
---
# 销售额
`)
	writeFile(t, root, "wikis/metrics/销售额/playbook.md", "# 销售额取数\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/spec.md", "# 经营综合分析报告\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/playbook.md", "# 经营综合分析报告取数\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/template.md", "# 经营综合分析报告模板\n")

	exported, err := ExportAliases(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	metric := findAliasItem(exported.Items, "metrics.销售额")
	if metric == nil || metric.Spec == nil || metric.Playbook == nil {
		t.Fatalf("expected metric spec/playbook to share one item: %+v", exported.Items)
	}
	if metric.FileKey != "metrics/销售额" || metric.Paths.Spec != "wikis/metrics/销售额/spec.md" || metric.Paths.Playbook != "wikis/metrics/销售额/playbook.md" || metric.Paths.Template != "" {
		t.Fatalf("unexpected metric alias paths: %+v", metric)
	}
	report := findAliasItem(exported.Items, "reports.经营综合分析报告")
	if report == nil || report.Spec == nil || report.Playbook == nil {
		t.Fatalf("expected report spec/playbook to share one item: %+v", exported.Items)
	}
	if report.Paths.Template != "wikis/reports/经营综合分析报告/template.md" {
		t.Fatalf("unexpected report template path: %+v", report.Paths)
	}
	lint := LintAliases(root, exported)
	if !lint.OK {
		t.Fatalf("expected structured alias export to lint cleanly, got %+v", lint)
	}
}

func TestAliasesImportApplyUpdatesOnlyFrontmatter(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/idx/business/s-sale-amt.md", `---
name: sale_amt
label: 销售额
---
# 销售额

正文保留。
`)
	data := AliasesFile{Version: 1, Root: "wikis", Targets: []string{"spec"}, Items: []AliasesItem{{
		ID:      "idx.business.saleAmt",
		FileKey: "idx/business/s-sale-amt.md",
		Paths:   AliasesPaths{Spec: "wikis/spec/idx/business/s-sale-amt.md"},
		Spec:    &AliasesFieldSet{Aliases: []string{"销售情况"}, NegativeAliases: []string{"预算销售额"}},
	}}}
	file := filepath.Join(root, "aliases.yaml")
	if err := WriteAliasesYAML(file, data); err != nil {
		t.Fatal(err)
	}
	result, err := ImportAliases(root, file, true)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Applied || result.FilesToUpdate != 1 {
		t.Fatalf("unexpected apply result: %+v", result)
	}
	content := readAliasTestFile(t, root, "wikis/spec/idx/business/s-sale-amt.md")
	for _, want := range []string{"name: sale_amt", "label: 销售额", "aliases:", "negative_aliases:", "# 销售额", "正文保留。"} {
		if !strings.Contains(content, want) {
			t.Fatalf("updated content missing %q:\n%s", want, content)
		}
	}
}

func TestAliasesLintRejectsInvalidAndConflictingAliases(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/idx/business/s-sale-amt.md", "# 销售额\n")
	data := AliasesFile{Version: 1, Root: "wikis", Targets: []string{"spec"}, Items: []AliasesItem{{
		ID:      "idx.business.saleAmt",
		Label:   "销售额",
		FileKey: "idx/business/s-sale-amt.md",
		Paths:   AliasesPaths{Spec: "wikis/spec/idx/business/s-sale-amt.md"},
		Spec:    &AliasesFieldSet{Aliases: []string{"销售", "销售"}, NegativeAliases: []string{"销售", "预算销售额"}},
	}}}
	result := LintAliases(root, data)
	if len(result.Errors) == 0 || len(result.Warnings) == 0 {
		t.Fatalf("expected lint errors and warnings, got %+v", result)
	}

	bad := filepath.Join(root, "bad.yaml")
	if err := os.WriteFile(bad, []byte("version: 1\nitems:\n  - id: x\n    spec:\n      aliases: 销售情况\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadAliasesFile(bad); err == nil {
		t.Fatal("expected scalar aliases to be rejected")
	}
}

func findAliasItem(items []AliasesItem, id string) *AliasesItem {
	for i := range items {
		if items[i].ID == id {
			return &items[i]
		}
	}
	return nil
}

func readAliasTestFile(t *testing.T, root, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
