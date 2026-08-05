package wikis

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"harness-data/cli/internal/harness"
)

func TestParseDocumentDerivesWikiFields(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/idx/business-manager/s-sale-amt.md", `---
name: sale_amt
label: 销售额
aliases: ["销售额", "销售金额"]
---
# 销售额
`)
	writeFile(t, root, "wikis/playbooks/idx/business-manager/s-sale-amt.md", "# 销售额取数\n")
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		t.Fatal(err)
	}
	specSet := map[string]bool{"spec/idx/business-manager/s-sale-amt.md": true}
	spec, errs, err := ParseDocument(resolver, "spec/idx/business-manager/s-sale-amt.md", specSet)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 0 {
		t.Fatalf("unexpected parse errors: %+v", errs)
	}
	if spec.ID != "spec/idx/business-manager/s-sale-amt" || spec.Kind != KindSpec || spec.Domain != "idx/business-manager" || spec.Title != "销售额" {
		t.Fatalf("unexpected spec derivation: %+v", spec)
	}
	if spec.Name != "sale_amt" || spec.Label != "销售额" || len(spec.Aliases) != 2 || spec.SpecType != SpecTypeMetric {
		t.Fatalf("unexpected spec frontmatter: %+v", spec)
	}

	playbook, errs, err := ParseDocument(resolver, "playbooks/idx/business-manager/s-sale-amt.md", specSet)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 0 {
		t.Fatalf("unexpected playbook parse errors: %+v", errs)
	}
	if !playbook.Playbook.IsSingle {
		t.Fatalf("expected single playbook: %+v", playbook.Playbook)
	}
	if playbook.Playbook.TemplatePath != "templates/idx/business-manager/s-sale-amt.md" {
		t.Fatalf("unexpected template path: %s", playbook.Playbook.TemplatePath)
	}
}

func TestParseDocumentStructuredIndexDomains(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeFile(t, root, "wikis/metrics/index.md", "# Metrics\n")
	writeFile(t, root, "wikis/metrics/销售额/index.md", "# 销售额\n")
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		t.Fatal(err)
	}
	rootIndex, errs, err := ParseDocument(resolver, "metrics/index.md", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 0 {
		t.Fatalf("unexpected parse errors: %+v", errs)
	}
	if rootIndex.Domain != "" {
		t.Fatalf("expected top-level structured index to have empty domain, got %+v", rootIndex)
	}
	objectIndex, errs, err := ParseDocument(resolver, "metrics/销售额/index.md", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 0 {
		t.Fatalf("unexpected parse errors: %+v", errs)
	}
	if objectIndex.Domain != "销售额" {
		t.Fatalf("expected object index domain to be object name, got %+v", objectIndex)
	}
}

func TestParseDocumentParsesSinglePlaybookIntents(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/playbooks/idx/business-manager/s-sale-amt.md", `---
intents:
  current_value:
    aliases: ["值", "指标值"]
  trend:
    aliases:
      - 趋势
      - 走势
---
# 销售额取数
`)
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		t.Fatal(err)
	}
	specSet := map[string]bool{"spec/idx/business-manager/s-sale-amt.md": true}
	playbook, errs, err := ParseDocument(resolver, "playbooks/idx/business-manager/s-sale-amt.md", specSet)
	if err != nil {
		t.Fatal(err)
	}
	if len(errs) != 0 {
		t.Fatalf("unexpected parse errors: %+v", errs)
	}
	if !playbook.Playbook.IsSingle {
		t.Fatalf("expected single playbook: %+v", playbook.Playbook)
	}
	if got := playbook.Playbook.Intents["current_value"].Aliases; strings.Join(got, ",") != "值,指标值" {
		t.Fatalf("unexpected current_value aliases: %+v", got)
	}
	if got := playbook.Playbook.Intents["trend"].Aliases; strings.Join(got, ",") != "趋势,走势" {
		t.Fatalf("unexpected trend aliases: %+v", got)
	}
}

func TestParseDocumentReportsH1AndUnknownFrontmatter(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/idx/business-manager/s-sale-amt.md", `---
id: old-id
name: sale_amt
---
# One
# Two
`)
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		t.Fatal(err)
	}
	_, errs, err := ParseDocument(resolver, "spec/idx/business-manager/s-sale-amt.md", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !hasCode(errs, "unknown_frontmatter_field") || !hasCode(errs, "multiple_h1") {
		t.Fatalf("expected unknown field and multiple H1 errors, got %+v", errs)
	}
}

func TestParseDocumentAcceptsLatestWikiStatusFrontmatter(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeFile(t, root, "wikis/reports/门店分析报告/spec.md", `---
name: "storeManagerAnalysisReport"
label: "门店分析报告"
status: "partial_metric_native"
aliases:
  - 门店管理报告
---
# 门店分析报告
`)
	result, err := RunCheck(root, CheckFrontmatter, CheckOptions{MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if resultHasTarget(result, "unknown_frontmatter_field", "status") {
		t.Fatalf("status frontmatter should be accepted, got %+v", result.Errors)
	}
	if !result.OK {
		t.Fatalf("unexpected frontmatter errors: %+v", result.Errors)
	}
}

func TestParseDocumentAcceptsLatestWikiObjectTypeFrontmatter(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeFile(t, root, "wikis/reports/门店经营策略库/spec.md", `---
name: "storeOperationStrategyLibrarySpec"
label: "门店经营策略库规格"
object_type: "knowledge"
aliases:
  - 门店策略选择规则
---
# 门店经营策略库规格
`)
	result, err := RunCheck(root, CheckFrontmatter, CheckOptions{MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if resultHasTarget(result, "unknown_frontmatter_field", "object_type") {
		t.Fatalf("object_type frontmatter should be accepted, got %+v", result.Errors)
	}
	if !result.OK {
		t.Fatalf("unexpected frontmatter errors: %+v", result.Errors)
	}
}

func TestParseDocumentIgnoresH1MarkersInsideFencedCodeBlocks(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeFile(t, root, "wikis/reports/主推时令大单品/playbook.md", `---
name: "seasonalHeroProductPlaybook"
label: "主推时令大单品取数手册"
---
# 主推时令大单品取数手册

`+"```bash"+`
# 店日均指标组
"$QDM_METRIC_CLI" analysis execute \
  --start-date <weekStartDate> \
  --end-date <weekEndDate>

# 汇总指标组
"$QDM_METRIC_CLI" analysis execute \
  --start-date <weekStartDate> \
  --end-date <weekEndDate>
`+"```"+`
`)
	result, err := RunCheck(root, CheckTitles, CheckOptions{MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if resultHasCode(result, "multiple_h1") {
		t.Fatalf("code block comments should not count as H1 titles, got %+v", result.Errors)
	}
	if !result.OK {
		t.Fatalf("unexpected title errors: %+v", result.Errors)
	}
}

func TestParseDocumentStillRejectsMultipleRealH1Titles(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeFile(t, root, "wikis/reports/主推时令大单品/playbook.md", `# 主推时令大单品取数手册

# 第二个真实标题
`)
	result, err := RunCheck(root, CheckTitles, CheckOptions{MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if !resultHasCode(result, "multiple_h1") {
		t.Fatalf("real H1 duplicates should still be rejected, got %+v", result.Errors)
	}
}

func TestRunChecksFindsFrontmatterAliasesAndLinks(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/index.md", "# Specs\n")
	writeFile(t, root, "wikis/spec/idx/index.md", "# Idx\n")
	writeFile(t, root, "wikis/spec/idx/business-manager/index.md", "# Business\n")
	writeFile(t, root, "wikis/spec/idx/business-manager/s-sale-amt.md", `---
name: sale_amt
label: 销售额
aliases: ["销售额", "销售额"]
---
# 销售额
`)
	writeFile(t, root, "wikis/spec/idx/business-manager/s-profit-amt.md", `---
name: profit_amt
label: 毛利额
---
# 毛利额
`)
	writeFile(t, root, "wikis/playbooks/index.md", "# Playbooks\n")
	writeFile(t, root, "wikis/playbooks/idx/index.md", "# Idx\n")
	writeFile(t, root, "wikis/playbooks/idx/business-manager/index.md", "# Business\n")
	writeFile(t, root, "wikis/playbooks/idx/business-manager/s-sale-amt.md", `---
aliases: ["不允许"]
---
# 销售额取数
`)
	writeFile(t, root, "wikis/templates/index.md", "# Templates\n")
	writeFile(t, root, "wikis/templates/idx/index.md", "# Idx\n")
	writeFile(t, root, "wikis/templates/idx/business-manager/index.md", "# Business\n")

	aliases, err := RunCheck(root, CheckAliases, CheckOptions{MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if !resultHasCode(aliases, "duplicate_alias") || !resultHasCode(aliases, "alias_not_allowed") {
		t.Fatalf("expected alias errors, got %+v", aliases.Errors)
	}
	links, err := RunCheck(root, CheckLinks, CheckOptions{MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if !resultHasCode(links, "missing_playbook") || resultHasCode(links, "missing_template") {
		t.Fatalf("expected missing_playbook without missing_template, got %+v", links.Errors)
	}
}

func TestCheckLinksDoesNotRequirePlaybookForReferenceSpecs(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/common/time-policy.md", `---
name: common_time_policy
label: 时间规则
---
# 时间规则
`)
	writeFile(t, root, "wikis/spec/dim-area/manage-area.md", `---
name: dim_area_manage_area
label: 管理区域编码
---
# 管理区域编码
`)
	writeFile(t, root, "wikis/spec/idx/business-manager/s-sale-amt.md", `---
name: sale_amt
label: 销售额
---
# 销售额
`)

	links, err := RunCheck(root, CheckLinks, CheckOptions{MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if !resultHasCode(links, "missing_playbook") {
		t.Fatalf("expected report spec to still require playbook, got %+v", links.Errors)
	}
	for _, err := range links.Errors {
		if strings.HasPrefix(err.Path, "spec/common/") || strings.HasPrefix(err.Path, "spec/dim-") {
			t.Fatalf("reference spec should not require playbook, got %+v", err)
		}
	}
}

func TestBuildIndexWritesStableAtomicIndex(t *testing.T) {
	root := testValidWikiRoot(t)
	result, err := BuildIndex(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != IndexRel || result.RuntimePath != RuntimeIndexRel || result.DocCount == 0 || result.RuntimeDocCount != result.DocCount || result.RecallCount != 3 || result.RuntimeRecallCount != result.RecallCount || result.ChecksSkipped {
		t.Fatalf("unexpected build result: %+v", result)
	}
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(IndexRel)))
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if content == "" || content[len(content)-1] != '\n' {
		t.Fatalf("index should end with newline: %q", content)
	}
	if !strings.Contains(content, `"version": 1`) || !strings.Contains(content, `"rule": "strict_contains"`) || !strings.Contains(content, `"checksSkipped": false`) {
		t.Fatalf("index content missing expected fields:\n%s", content)
	}
	runtime, err := LoadRuntimeIndex(root)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.DocsByPath["spec/idx/business-manager/s-sale-amt.md"].Path == "" {
		t.Fatalf("runtime index missing sale amt doc: %+v", runtime.DocsByPath)
	}
	runtimeData, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(RuntimeIndexRel)))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(runtimeData), `"title"`) || strings.Contains(string(runtimeData), `"id"`) || strings.Contains(string(runtimeData), `"isIndex"`) {
		t.Fatalf("runtime index should not include full document fields:\n%s", string(runtimeData))
	}
}

func TestBuildIndexDoesNotReplaceExistingIndexWhenChecksFail(t *testing.T) {
	root := testWikiRoot(t)
	writeFile(t, root, IndexRel, "old\n")
	writeFile(t, root, RuntimeIndexRel, "old runtime\n")
	writeFile(t, root, "wikis/spec/idx/business-manager/s-sale-amt.md", `---
name: sale_amt
label: 销售额
---
# 销售额
`)
	if _, err := BuildIndex(root, false); err == nil {
		t.Fatal("expected build to fail before writing index")
	}
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(IndexRel)))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "old\n" {
		t.Fatalf("expected old index to remain, got %q", string(data))
	}
	runtimeData, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(RuntimeIndexRel)))
	if err != nil {
		t.Fatal(err)
	}
	if string(runtimeData) != "old runtime\n" {
		t.Fatalf("expected old runtime index to remain, got %q", string(runtimeData))
	}
}

func TestLoadRuntimeIndexFallsBackToFullIndex(t *testing.T) {
	root := testValidWikiRoot(t)
	if _, err := BuildIndex(root, false); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, filepath.FromSlash(RuntimeIndexRel))); err != nil {
		t.Fatal(err)
	}
	runtime, err := LoadRuntimeIndex(root)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.DocsByPath["spec/idx/business-manager/s-sale-amt.md"].Path == "" || len(runtime.Recall) != 3 {
		t.Fatalf("unexpected fallback runtime index: %+v", runtime)
	}
}

func TestBuildIndexSkipChecksStillRejectsDuplicateRecall(t *testing.T) {
	root := testValidWikiRoot(t)
	writeFile(t, root, "wikis/spec/idx/business-manager/s-profit-amt.md", `---
name: profit_amt
label: 利润额
aliases: ["销售金额"]
---
# 利润额
`)
	if _, err := BuildIndex(root, true); err == nil {
		t.Fatal("expected duplicate alias recall to block skip-checks build")
	}
}

func TestBuildIndexRejectsDuplicateLabelsAcrossDomains(t *testing.T) {
	root := testValidWikiRoot(t)
	writeFile(t, root, "wikis/spec/cmr/business/index.md", "# Business\n")
	writeFile(t, root, "wikis/spec/cmr/business/s-sale-amt.md", `---
name: cmr_sale_amt
label: 销售额
---
# 销售额
`)
	if _, err := BuildIndex(root, true); err == nil {
		t.Fatal("expected duplicate label recall to block skip-checks build")
	}
}

func testWikiRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFile(t, root, "config/harness-config.yaml", `paths:
  spec: wikis/spec
  playbooks: wikis/playbooks
  templates: wikis/templates
`)
	return root
}

func testValidWikiRoot(t *testing.T) string {
	t.Helper()
	root := testWikiRoot(t)
	writeFile(t, root, "wikis/spec/index.md", "# Specs\n")
	writeFile(t, root, "wikis/spec/idx/index.md", "# Idx\n")
	writeFile(t, root, "wikis/spec/idx/business-manager/index.md", "# Business\n")
	writeFile(t, root, "wikis/spec/idx/business-manager/s-sale-amt.md", `---
name: sale_amt
label: 销售额
aliases: ["销售金额"]
---
# 销售额
`)
	writeFile(t, root, "wikis/playbooks/index.md", "# Playbooks\n")
	writeFile(t, root, "wikis/playbooks/idx/index.md", "# Idx\n")
	writeFile(t, root, "wikis/playbooks/idx/business-manager/index.md", "# Business\n")
	writeFile(t, root, "wikis/playbooks/idx/business-manager/s-sale-amt.md", "# 销售额取数\n")
	writeFile(t, root, "wikis/templates/index.md", "# Templates\n")
	writeFile(t, root, "wikis/templates/idx/index.md", "# Idx\n")
	writeFile(t, root, "wikis/templates/idx/business-manager/index.md", "# Business\n")
	writeFile(t, root, "wikis/templates/idx/business-manager/s-sale-amt.md", "# 销售额报告\n")
	return root
}

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func hasCode(errs []CheckError, code string) bool {
	for _, err := range errs {
		if err.Code == code {
			return true
		}
	}
	return false
}

func resultHasCode(result CheckResult, code string) bool {
	return hasCode(result.Errors, code)
}

func resultHasTarget(result CheckResult, code, target string) bool {
	for _, err := range result.Errors {
		if err.Code == code && err.Target == target {
			return true
		}
	}
	return false
}
