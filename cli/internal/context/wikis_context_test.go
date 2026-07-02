package context

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"harness-data/cli/internal/harness"
	"harness-data/cli/internal/sessionstate"
	"harness-data/cli/internal/wikis"
)

func TestBuildWithWikisIndexSingleMode(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "看一下销售额")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeSingle || plan.SelectedPlaybook != "playbooks/idx/business/s-sale-amt.md" || plan.SelectedTemplate != "" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/playbooks/idx/business/s-sale-amt.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
	for _, unwanted := range []string{
		"wikis/spec/index.md",
		"wikis/spec/idx/index.md",
		"wikis/spec/idx/business/index.md",
		"wikis/spec/idx/business/s-sale-amt.md",
		"wikis/playbooks/index.md",
		"wikis/playbooks/idx/index.md",
		"wikis/playbooks/idx/business/index.md",
	} {
		if hasString(got, unwanted) {
			t.Fatalf("unexpected ancestor index %s in %#v", unwanted, got)
		}
	}
	if !strings.Contains(response.Instruction, "Harness mode: single") || !strings.Contains(response.Instruction, "Do not run bin/data-harness-cli inject-template") || strings.Contains(response.Instruction, "templates/idx/business/s-sale-amt.md") {
		t.Fatalf("unexpected instruction: %s", response.Instruction)
	}
}

func TestBuildWithWikisIndexUsesRuntimePathsWhenConfigMissing(t *testing.T) {
	root := testContextWikiRoot(t)
	if err := os.Remove(filepath.Join(root, "config/harness-config.yaml")); err != nil {
		t.Fatal(err)
	}

	response, plan, err := BuildWithPlan(root, "看一下销售额")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeSingle || plan.SelectedPlaybook != "playbooks/idx/business/s-sale-amt.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/playbooks/idx/business/s-sale-amt.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
}

func TestBuildWithWikisIndexMultiMetricAnalysisUsesFreeMode(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "销售额和客单价经营概览")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeFree || plan.SelectedPlaybook != "" || plan.SelectedTemplate != "" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if plan.Reason != "multi_metric_non_direct" {
		t.Fatalf("reason = %s", plan.Reason)
	}
	got := contextPaths(response)
	for _, want := range []string{
		"wikis/spec/idx/business/index.md",
		"wikis/spec/idx/business/s-per-cust-amt.md",
		"wikis/playbooks/idx/business/s-per-cust-amt.md",
		"wikis/spec/idx/business/s-sale-amt.md",
		"wikis/playbooks/idx/business/s-sale-amt.md",
	} {
		if !hasString(got, want) {
			t.Fatalf("missing %s in %#v", want, got)
		}
	}
	for _, unwanted := range []string{
		"wikis/playbooks/idx/business/default-overview.md",
		"wikis/templates/idx/business/default-overview.md",
	} {
		if hasString(got, unwanted) {
			t.Fatalf("unexpected report playbook context: %s in %#v", unwanted, got)
		}
	}
	if !strings.Contains(response.Instruction, "Harness mode: free") || strings.Contains(response.Instruction, "report-style") {
		t.Fatalf("unexpected instruction: %s", response.Instruction)
	}
}

func TestBuildWithWikisIndexMultiSingleMode(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "销售额和客单价是多少")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeMulti || plan.SelectedPlaybook != "" || plan.SelectedTemplate != "" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if len(plan.SelectedPlaybooks) != 2 {
		t.Fatalf("selected playbooks = %+v", plan.SelectedPlaybooks)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/playbooks/idx/business/s-per-cust-amt.md",
		"wikis/playbooks/idx/business/s-sale-amt.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
	for _, unwanted := range []string{
		"wikis/spec/idx/business/s-per-cust-amt.md",
		"wikis/spec/idx/business/s-sale-amt.md",
		"wikis/playbooks/idx/business/default-overview.md",
	} {
		if hasString(got, unwanted) {
			t.Fatalf("unexpected %s in %#v", unwanted, got)
		}
	}
	if !strings.Contains(response.Instruction, "Harness mode: multi_single") || !strings.Contains(response.Instruction, "Do not run bin/data-harness-cli inject-template") {
		t.Fatalf("unexpected instruction: %s", response.Instruction)
	}
}

func TestBuildWithWikisIndexMultiSingleModeDefaultsWithoutValueIntent(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "销售额和客单价")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeMulti || plan.SelectedPlaybook != "" || plan.SelectedTemplate != "" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/playbooks/idx/business/s-per-cust-amt.md",
		"wikis/playbooks/idx/business/s-sale-amt.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
	if !strings.Contains(response.Instruction, "default to current-value collection") {
		t.Fatalf("unexpected instruction: %s", response.Instruction)
	}
}

func TestBuildWithWikisIndexGenericAnalysisDoesNotUseMultiSingleMode(t *testing.T) {
	root := testContextWikiRoot(t)
	_, plan, err := BuildWithPlan(root, "销售额和客单价分析")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode == sessionstate.ModeMulti {
		t.Fatalf("generic analysis should not use multi_single: %+v", plan)
	}
}

func TestBuildWithWikisIndexReportMode(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "生成2026-05-28经营分析报告")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeReport || plan.SelectedPlaybook != "playbooks/idx/business/r-business-analysis-report.md" || plan.SelectedTemplate != "templates/idx/business/r-business-analysis-report.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/spec/idx/business/r-business-analysis-report.md",
		"wikis/playbooks/idx/business/r-business-analysis-report.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
	if hasString(got, "wikis/templates/idx/business/r-business-analysis-report.md") {
		t.Fatalf("template should not be injected during report data collection: %#v", got)
	}
	if !strings.Contains(response.Instruction, "Harness mode: report") ||
		!strings.Contains(response.Instruction, "selectedTemplate=templates/idx/business/r-business-analysis-report.md") ||
		!strings.Contains(response.Instruction, "After report playbook data collection and evidence preparation, run bin/data-harness-cli stage template") ||
		strings.Contains(response.Instruction, "Do not run bin/data-harness-cli inject-template") ||
		strings.Contains(response.Instruction, "Harness mode: combo") {
		t.Fatalf("unexpected instruction: %s", response.Instruction)
	}
}

func TestBuildWithWikisIndexExactReportAliasUsesReportMode(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "上个月门店经营情况效果")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeReport || plan.SelectedPlaybook != "playbooks/idx/business/r-business-analysis-report.md" || plan.SelectedTemplate != "templates/idx/business/r-business-analysis-report.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/spec/idx/business/r-business-analysis-report.md",
		"wikis/playbooks/idx/business/r-business-analysis-report.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
}

func TestBuildWithWikisIndexPrefersSpecificReportConcept(t *testing.T) {
	root := testBusinessReportRoutingWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "查看所有门店昨天的销售情况, 列表返回")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeReport || plan.SelectedPlaybook != "playbooks/indicators/business/r-profit-analysis-report.md" || plan.SelectedTemplate != "templates/indicators/business/r-profit-analysis-report.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/spec/indicators/business/r-profit-analysis-report.md",
		"wikis/playbooks/indicators/business/r-profit-analysis-report.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
}

func TestBuildWithWikisIndexBusinessReportRoutingBoundaries(t *testing.T) {
	root := testBusinessReportRoutingWikiRoot(t)
	cases := []struct {
		question string
		playbook string
		template string
	}{
		{
			question: "所有门店盈利情况",
			playbook: "playbooks/indicators/business/r-profit-analysis-report.md",
			template: "templates/indicators/business/r-profit-analysis-report.md",
		},
		{
			question: "大区销售情况",
			playbook: "playbooks/indicators/business/r-profit-analysis-report.md",
			template: "templates/indicators/business/r-profit-analysis-report.md",
		},
		{
			question: "督导盈利情况",
			playbook: "playbooks/indicators/business/r-profit-analysis-report.md",
			template: "templates/indicators/business/r-profit-analysis-report.md",
		},
		{
			question: "上个月的盈利战役的效果如何",
			playbook: "playbooks/indicators/business/r-profit-analysis-report.md",
			template: "templates/indicators/business/r-profit-analysis-report.md",
		},
		{
			question: "生成经营分析报告",
			playbook: "playbooks/cmr/business/r-business-analysis-report.md",
			template: "templates/cmr/business/r-business-analysis-report.md",
		},
		{
			question: "经营情况怎么样",
			playbook: "playbooks/cmr/business/r-business-analysis-report.md",
			template: "templates/cmr/business/r-business-analysis-report.md",
		},
	}
	for _, tc := range cases {
		_, plan, err := BuildWithPlan(root, tc.question)
		if err != nil {
			t.Fatal(err)
		}
		if plan.Mode != sessionstate.ModeReport || plan.SelectedPlaybook != tc.playbook || plan.SelectedTemplate != tc.template {
			t.Fatalf("%q unexpected plan: %+v", tc.question, plan)
		}
	}
}

func TestBuildWithWikisIndexExactReportAliasBeatsToolPathFuzzyMetrics(t *testing.T) {
	root := testBusinessReportRoutingWikiRoot(t)
	question := "复盘一下上个月的盈利战役, 注意, 我们需要一份HTML报告, 你可以命名用 /Users/pengmd/tmp/test-data/_cherry_md_html_test/bin/md2html这个工具, 他会帮我们将Markdown转成Html"
	response, plan, err := BuildWithPlan(root, question)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeReport || plan.SelectedPlaybook != "playbooks/indicators/business/r-profit-analysis-report.md" || plan.SelectedTemplate != "templates/indicators/business/r-profit-analysis-report.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/spec/indicators/business/r-profit-analysis-report.md",
		"wikis/playbooks/indicators/business/r-profit-analysis-report.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
	for _, unwanted := range []string{
		"wikis/spec/indicators/s-water-rent.md",
		"wikis/spec/cmr/financial/s-ebitda-company-profit.md",
		"wikis/spec/indicators/s-close-rate.md",
		"wikis/spec/indicators/s-per-cust-amt.md",
	} {
		if hasString(got, unwanted) {
			t.Fatalf("unexpected fuzzy metric context %s in %#v", unwanted, got)
		}
	}
}

func TestBuildWithWikisIndexCMRStoreManagerMultiSingleDefaultsToCurrentValue(t *testing.T) {
	root := testCMRStoreManagerWikiRoot(t)
	for _, question := range []string{
		"净增门店数, 存量门店数, 还有停业门店数呢?",
		"净增门店数, 存量门店数, 停业门店数",
	} {
		response, plan, err := BuildWithPlan(root, question)
		if err != nil {
			t.Fatal(err)
		}
		if plan.Mode != sessionstate.ModeMulti || plan.SelectedPlaybook != "" || plan.SelectedTemplate != "" {
			t.Fatalf("%q unexpected plan: %+v", question, plan)
		}
		got := contextPaths(response)
		want := []string{
			"wikis/playbooks/cmr/store-manager/s-increase-stores.md",
			"wikis/playbooks/cmr/store-manager/s-stock-stores.md",
			"wikis/playbooks/cmr/store-manager/s-stop-business-stores.md",
		}
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Fatalf("%q context paths:\n%s", question, strings.Join(got, "\n"))
		}
		for _, unwanted := range []string{
			"wikis/spec/cmr/store-manager/index.md",
			"wikis/spec/cmr/store-manager/s-increase-stores.md",
			"wikis/spec/cmr/store-manager/s-stock-stores.md",
			"wikis/spec/cmr/store-manager/s-stop-business-stores.md",
		} {
			if hasString(got, unwanted) {
				t.Fatalf("%q unexpected %s in %#v", question, unwanted, got)
			}
		}
	}
}

func TestBuildWithWikisIndexCMRStoreManagerNonDirectQuestionsDoNotUseMultiSingle(t *testing.T) {
	root := testCMRStoreManagerWikiRoot(t)
	for _, question := range []string{
		"净增门店数和存量门店数分析",
		"净增门店数和存量门店数为什么变化",
		"净增门店数和存量门店数有什么关系",
		"净增门店数、存量门店数、停业门店数做个报告",
	} {
		_, plan, err := BuildWithPlan(root, question)
		if err != nil {
			t.Fatal(err)
		}
		if plan.Mode == sessionstate.ModeMulti {
			t.Fatalf("%q should not use multi_single: %+v", question, plan)
		}
	}
}

func TestBuildWithWikisIndexPrefersLongerRecallTerm(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "19点前滚动7天会员复购率")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeSingle || plan.SelectedPlaybook != "playbooks/idx/business/s-bf19-member-repurchase-rate.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	for _, unwanted := range []string{
		"wikis/spec/idx/business/s-member-repurchase-rate.md",
		"wikis/playbooks/idx/business/s-member-repurchase-rate.md",
	} {
		if hasString(got, unwanted) {
			t.Fatalf("shorter recall term should be suppressed, got %s in %#v", unwanted, got)
		}
	}
	want := []string{
		"wikis/playbooks/idx/business/s-bf19-member-repurchase-rate.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
}

func TestBuildWithWikisIndexFuzzyMemberRepurchaseRate(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "会员复购为什么下降")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeSingle || plan.SelectedPlaybook != "playbooks/idx/business/s-member-repurchase-rate.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	for _, want := range []string{
		"wikis/playbooks/idx/business/s-member-repurchase-rate.md",
	} {
		if !hasString(got, want) {
			t.Fatalf("missing %s in %#v", want, got)
		}
	}
}

func TestRunClaudeHookWritesFreeSessionState(t *testing.T) {
	root := testContextWikiRoot(t)
	sessionID := "ctx-free"
	payload := []byte(`{"session_id":"` + sessionID + `","prompt":"库存概念说明"}`)
	ok, output, err := RunClaudeHook(root, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	if !strings.Contains(output.HookSpecificOutput.AdditionalContext, "Harness mode: free") || !strings.Contains(output.HookSpecificOutput.AdditionalContext, "Do not run bin/data-harness-cli inject-template") {
		t.Fatalf("unexpected context: %s", output.HookSpecificOutput.AdditionalContext)
	}
	data, err := os.ReadFile(sessionstate.Path(root, sessionID))
	if err != nil {
		t.Fatal(err)
	}
	var state sessionstate.File
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	if state.Mode != sessionstate.ModeFree || state.Reason != "concept_only" || state.SelectedPlaybook != "" || state.SelectedTemplate != "" {
		t.Fatalf("unexpected state: %s", string(data))
	}
}

func TestBuildWithWikisIndexReferenceSpecDoesNotSelectPlaybook(t *testing.T) {
	root := t.TempDir()
	writeContextFile(t, root, "config/harness-config.yaml", `paths:
  spec: wikis/spec
  playbooks: wikis/playbooks
  templates: wikis/templates
`)
	for _, rel := range []string{
		"wikis/spec/index.md",
		"wikis/spec/dim-area/index.md",
		"wikis/playbooks/index.md",
		"wikis/playbooks/dim-area/index.md",
		"wikis/templates/index.md",
		"wikis/templates/dim-area/index.md",
	} {
		writeContextFile(t, root, rel, "# "+filepath.Base(filepath.Dir(rel))+"\n")
	}
	writeContextFile(t, root, "wikis/spec/dim-area/manage-area.md", `---
name: dim_area_manage_area
label: 管理区域编码
---
# 管理区域编码
`)
	writeContextFile(t, root, "wikis/playbooks/dim-area/manage-area.md", "# manage-area\n")
	writeContextFile(t, root, "wikis/templates/dim-area/manage-area.md", "# manage-area 模板\n")
	if _, err := wikis.BuildIndex(root, false); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "wikis/playbooks/dim-area/manage-area.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "wikis/templates/dim-area/manage-area.md")); err != nil {
		t.Fatal(err)
	}

	response, plan, err := BuildWithPlan(root, "管理区域编码")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeFree || plan.SelectedPlaybook != "" || plan.SelectedTemplate != "" || plan.Reason != "reference_spec" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/spec/dim-area/index.md",
		"wikis/spec/dim-area/manage-area.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
}

func testContextWikiRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeContextFile(t, root, "config/harness-config.yaml", `paths:
  spec: wikis/spec
  routing: wikis/routing
  playbooks: wikis/playbooks
  templates: wikis/templates
`)
	for _, rel := range []string{
		"wikis/spec/index.md",
		"wikis/spec/idx/index.md",
		"wikis/spec/idx/business/index.md",
		"wikis/playbooks/index.md",
		"wikis/playbooks/idx/index.md",
		"wikis/playbooks/idx/business/index.md",
		"wikis/templates/index.md",
		"wikis/templates/idx/index.md",
		"wikis/templates/idx/business/index.md",
	} {
		writeContextFile(t, root, rel, "# "+filepath.Base(filepath.Dir(rel))+"\n")
	}
	writeContextFile(t, root, "wikis/spec/idx/business/s-sale-amt.md", `---
name: sale_amt
label: 销售额
aliases: ["销售金额"]
---
# 销售额
`)
	writeContextFile(t, root, "wikis/spec/idx/business/s-per-cust-amt.md", `---
name: per_cust_amt
label: 客单价
---
# 客单价
`)
	writeContextFile(t, root, "wikis/spec/idx/business/s-member-repurchase-rate.md", `---
name: member_repurchase_rate
label: 会员复购率
---
# 会员复购率
`)
	writeContextFile(t, root, "wikis/spec/idx/business/s-bf19-member-repurchase-rate.md", `---
name: bf19_member_repurchase_rate
label: 19点前滚动7天会员复购率
---
# 19点前滚动7天会员复购率
`)
	writeContextFile(t, root, "wikis/spec/idx/business/c-inventory.md", `---
aliases: ["库存概念"]
---
# 库存概念
`)
	writeContextFile(t, root, "wikis/spec/idx/business/r-business-analysis-report.md", `---
name: businessAnalysisReport
label: 经营综合分析报告
aliases:
  - 经营分析报告
  - 经营综合报告
  - 经营综分析报告
  - 经营情况
  - 销售情况
  - 经营大盘
  - 业务情况
  - 业务大盘
---
# 经营综合分析报告
`)
	writeContextFile(t, root, "wikis/playbooks/idx/business/s-sale-amt.md", `---
intents:
  current_value:
    aliases: ["值", "指标值", "是多少", "多少"]
  trend:
    aliases:
      - 趋势
      - 走势
      - 趋势分析
---
# 销售额取数
`)
	writeContextFile(t, root, "wikis/playbooks/idx/business/s-per-cust-amt.md", `---
intents:
  current_value:
    aliases: ["值", "指标值", "是多少", "多少"]
---
# 客单价取数
`)
	writeContextFile(t, root, "wikis/playbooks/idx/business/s-member-repurchase-rate.md", "# 会员复购率取数\n")
	writeContextFile(t, root, "wikis/playbooks/idx/business/s-bf19-member-repurchase-rate.md", "# 19点前滚动7天会员复购率取数\n")
	writeContextFile(t, root, "wikis/playbooks/idx/business/r-business-analysis-report.md", `---
name: playbook_business_analysis_report
label: 经营综合分析报告取数手册
---
# 经营综合分析报告取数手册
`)
	writeContextFile(t, root, "wikis/templates/idx/business/r-business-analysis-report.md", "# 经营综合分析报告模板\n")
	writeContextFile(t, root, "wikis/templates/idx/business/s-sale-amt.md", "# 销售额模板\n")
	writeContextFile(t, root, "wikis/templates/idx/business/s-per-cust-amt.md", "# 客单价模板\n")
	writeContextFile(t, root, "wikis/templates/idx/business/s-member-repurchase-rate.md", "# 会员复购率模板\n")
	writeContextFile(t, root, "wikis/templates/idx/business/s-bf19-member-repurchase-rate.md", "# 19点前滚动7天会员复购率模板\n")
	if _, err := wikis.BuildIndex(root, false); err != nil {
		t.Fatal(err)
	}
	return root
}

func testCMRStoreManagerWikiRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeContextFile(t, root, "config/harness-config.yaml", `paths:
  spec: wikis/spec
  routing: wikis/routing
  playbooks: wikis/playbooks
  templates: wikis/templates
`)
	for _, rel := range []string{
		"wikis/spec/index.md",
		"wikis/spec/cmr/index.md",
		"wikis/spec/cmr/store-manager/index.md",
		"wikis/playbooks/index.md",
		"wikis/playbooks/cmr/index.md",
		"wikis/playbooks/cmr/store-manager/index.md",
		"wikis/templates/index.md",
		"wikis/templates/cmr/index.md",
		"wikis/templates/cmr/store-manager/index.md",
	} {
		writeContextFile(t, root, rel, "# "+filepath.Base(filepath.Dir(rel))+"\n")
	}
	writeContextFile(t, root, "wikis/spec/cmr/store-manager/s-increase-stores.md", `---
name: increaseStores
label: 净增门店数
---
# 净增门店数
`)
	writeContextFile(t, root, "wikis/spec/cmr/store-manager/s-stock-stores.md", `---
name: stockStores
label: 存量门店数
---
# 存量门店数
`)
	writeContextFile(t, root, "wikis/spec/cmr/store-manager/s-stop-business-stores.md", `---
name: stopBusinessStores
label: 停业门店数
---
# 停业门店数
`)
	for _, item := range []struct {
		path  string
		label string
	}{
		{"wikis/playbooks/cmr/store-manager/s-increase-stores.md", "净增门店数"},
		{"wikis/playbooks/cmr/store-manager/s-stock-stores.md", "存量门店数"},
		{"wikis/playbooks/cmr/store-manager/s-stop-business-stores.md", "停业门店数"},
	} {
		writeContextFile(t, root, item.path, `---
intents:
  current_value:
    aliases: ["值", "指标值", "是多少", "多少", "查看", "查询", "看一下"]
  trend:
    aliases: ["趋势", "走势", "趋势分析"]
  area_performance:
    aliases: ["区域表现", "区域排名", "区域对比"]
---
# `+item.label+`取数
`)
	}
	if _, err := wikis.BuildIndex(root, false); err != nil {
		t.Fatal(err)
	}
	return root
}

func testBusinessReportRoutingWikiRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeContextFile(t, root, "config/harness-config.yaml", `paths:
  spec: wikis/spec
  routing: wikis/routing
  playbooks: wikis/playbooks
  templates: wikis/templates
`)
	for _, rel := range []string{
		"wikis/spec/index.md",
		"wikis/spec/cmr/index.md",
		"wikis/spec/cmr/business/index.md",
		"wikis/spec/cmr/financial/index.md",
		"wikis/spec/indicators/index.md",
		"wikis/spec/indicators/business/index.md",
		"wikis/playbooks/index.md",
		"wikis/playbooks/cmr/index.md",
		"wikis/playbooks/cmr/business/index.md",
		"wikis/playbooks/cmr/financial/index.md",
		"wikis/playbooks/indicators/index.md",
		"wikis/playbooks/indicators/business/index.md",
		"wikis/templates/index.md",
		"wikis/templates/cmr/index.md",
		"wikis/templates/cmr/business/index.md",
		"wikis/templates/cmr/financial/index.md",
		"wikis/templates/indicators/index.md",
		"wikis/templates/indicators/business/index.md",
	} {
		writeContextFile(t, root, rel, "# "+filepath.Base(filepath.Dir(rel))+"\n")
	}
	writeContextFile(t, root, "wikis/spec/cmr/business/r-business-analysis-report.md", `---
name: businessAnalysisReport
label: 经营综合分析报告
aliases:
  - 经营分析报告
  - 生成经营分析
  - 经营情况
  - 销售情况
---
# 经营综合分析报告
`)
	writeContextFile(t, root, "wikis/spec/indicators/business/r-profit-analysis-report.md", `---
name: profit-analysis-report
label: 盈利情况分析报告
aliases:
  - 盈利情况分析
  - 盈利战
  - 门店盈利情况
  - 门店销售情况
  - 所有门店盈利情况
  - 所有门店销售情况
  - 管理区域盈利情况
  - 管理区域销售情况
  - 大区盈利情况
  - 大区销售情况
  - 督导盈利情况
  - 督导销售情况
---
# 盈利情况分析报告
`)
	for _, item := range []struct {
		specPath     string
		playbookPath string
		name         string
		label        string
	}{
		{
			specPath:     "wikis/spec/indicators/s-water-rent.md",
			playbookPath: "wikis/playbooks/indicators/s-water-rent.md",
			name:         "waterRent",
			label:        "水电房租",
		},
		{
			specPath:     "wikis/spec/cmr/financial/s-ebitda-company-profit.md",
			playbookPath: "wikis/playbooks/cmr/financial/s-ebitda-company-profit.md",
			name:         "EBITDA",
			label:        "息税折旧摊销前利润",
		},
		{
			specPath:     "wikis/spec/indicators/s-close-rate.md",
			playbookPath: "wikis/playbooks/indicators/s-close-rate.md",
			name:         "closeRate",
			label:        "闭店率",
		},
		{
			specPath:     "wikis/spec/indicators/s-per-cust-amt.md",
			playbookPath: "wikis/playbooks/indicators/s-per-cust-amt.md",
			name:         "perCustAmt",
			label:        "客单价",
		},
	} {
		writeContextFile(t, root, item.specPath, `---
name: `+item.name+`
label: `+item.label+`
---
# `+item.label+`
`)
		writeContextFile(t, root, item.playbookPath, "# "+item.label+"取数手册\n")
	}
	writeContextFile(t, root, "wikis/playbooks/cmr/business/r-business-analysis-report.md", "# 经营综合分析报告取数手册\n")
	writeContextFile(t, root, "wikis/playbooks/indicators/business/r-profit-analysis-report.md", "# 盈利情况分析报告取数手册\n")
	writeContextFile(t, root, "wikis/templates/cmr/business/r-business-analysis-report.md", "# 经营综合分析报告模板\n")
	writeContextFile(t, root, "wikis/templates/indicators/business/r-profit-analysis-report.md", "# 盈利情况分析报告模板\n")
	if _, err := wikis.BuildIndex(root, false); err != nil {
		t.Fatal(err)
	}
	return root
}

func writeContextFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func contextPaths(response harness.ContextResponse) []string {
	var paths []string
	for _, ref := range response.ContextFiles {
		paths = append(paths, ref.Path)
	}
	return paths
}

func hasString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
