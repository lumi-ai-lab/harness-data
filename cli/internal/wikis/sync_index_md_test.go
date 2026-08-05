package wikis

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncIndexMDCreatesAndChecksGeneratedBlocks(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/idx/business/s-sale-amt.md", `---
name: sale_amt
label: 销售额
---
# 销售额
`)
	writeFile(t, root, "wikis/playbooks/idx/business/s-sale-amt.md", "# 销售额取数\n")
	writeFile(t, root, "wikis/spec/idx/business/c-business-report.md", `---
name: business_report
label: 经营综合分析报告
---
# 经营综合分析报告
`)
	writeFile(t, root, "wikis/playbooks/idx/business/c-business-report.md", "# 经营综合分析报告取数\n")
	writeFile(t, root, "wikis/templates/idx/business/s-sale-amt.md", "# 销售额报告\n")

	result, err := SyncIndexMD(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Created) == 0 {
		t.Fatalf("expected index files to be created: %+v", result)
	}
	content := readFile(t, root, "wikis/spec/idx/business/index.md")
	for _, want := range []string{generatedStart, "## 自动索引", "| 销售额 | `sale_amt` | `s-sale-amt.md` | `playbooks/idx/business/s-sale-amt.md` |", "| `c-business-report.md` | 经营综合分析报告 | 规则或专题指引 |", generatedEnd} {
		if !strings.Contains(content, want) {
			t.Fatalf("generated spec index missing %q:\n%s", want, content)
		}
	}
	check, err := SyncIndexMD(root, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(check.Outdated) != 0 {
		t.Fatalf("expected generated indexes to be current: %+v", check)
	}
}

func TestSyncIndexMDPreservesManualContentAndReportsOutdated(t *testing.T) {
	root := testValidWikiRoot(t)
	if _, err := SyncIndexMD(root, false); err != nil {
		t.Fatal(err)
	}
	writeFile(t, root, "wikis/spec/idx/business-manager/index.md", "# Business\n\nManual guidance.\n\n"+generatedStart+"\n\nold\n"+generatedEnd+"\n")

	check, err := SyncIndexMD(root, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(check.Outdated) != 1 || check.Outdated[0] != "spec/idx/business-manager/index.md" {
		t.Fatalf("expected outdated business index: %+v", check)
	}
	content := readFile(t, root, "wikis/spec/idx/business-manager/index.md")
	if !strings.Contains(content, "old") {
		t.Fatalf("check mode should not write file:\n%s", content)
	}

	result, err := SyncIndexMD(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if !hasString(result.Changed, "spec/idx/business-manager/index.md") {
		t.Fatalf("expected business index to change: %+v", result)
	}
	updated := readFile(t, root, "wikis/spec/idx/business-manager/index.md")
	if !strings.Contains(updated, "Manual guidance.") || strings.Contains(updated, "\nold\n") {
		t.Fatalf("manual content should stay and generated block should be replaced:\n%s", updated)
	}
	if !strings.Contains(updated, "### 指标清单") || !strings.Contains(updated, "销售额") {
		t.Fatalf("expected generated metrics section:\n%s", updated)
	}
}

func TestSyncIndexMDSupportsStructuredLayout(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeFile(t, root, "wikis/metrics/销售额/spec.md", `---
name: sale_amt
label: 销售额
---
# 销售额
`)
	writeFile(t, root, "wikis/metrics/销售额/playbook.md", "# 销售额取数\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/spec.md", "# 经营综合分析报告\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/playbook.md", "# 经营综合分析报告取数\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/template.md", "# 经营综合分析报告模板\n")
	writeFile(t, root, "wikis/dims/门店/spec.md", "# 门店维度\n")
	writeFile(t, root, "wikis/rules/qdm-metric-cli/spec.md", "# QDM Metric CLI\n")

	result, err := SyncIndexMD(root, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"metrics/index.md",
		"metrics/销售额/index.md",
		"reports/index.md",
		"reports/经营综合分析报告/index.md",
		"dims/index.md",
		"dims/门店/index.md",
		"rules/index.md",
		"rules/qdm-metric-cli/index.md",
	} {
		if !hasString(result.Created, want) {
			t.Fatalf("expected %s to be created: %+v", want, result)
		}
	}
	if result.Scanned != len(result.Created) {
		t.Fatalf("expected all scanned structured indexes to be created: %+v", result)
	}
	content := readFile(t, root, "wikis/metrics/销售额/index.md")
	for _, want := range []string{"## 自动索引", "### 文档清单", "`spec.md`", "`playbook.md`"} {
		if !strings.Contains(content, want) {
			t.Fatalf("structured index missing %q:\n%s", want, content)
		}
	}
	check, err := SyncIndexMD(root, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(check.Outdated) != 0 {
		t.Fatalf("expected structured indexes to be current: %+v", check)
	}
}

func readFile(t *testing.T, root, rel string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func hasString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
