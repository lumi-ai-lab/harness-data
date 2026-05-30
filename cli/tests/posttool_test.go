package tests

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	dhcontext "harness-data/cli/internal/context"
	"harness-data/cli/internal/posttool"
)

func TestPosttoolRecordsParallelBusinessModules(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-business-parallel"
	cleanupPosttoolState(t, root, sessionID)

	command := `
qdm-cmr-cli report business overview --date 2026-05-20 --ai &
qdm-cmr-cli report business indicators --date 2026-05-20 --ai &
qdm-cmr-cli report business tree --values --date 2026-05-20 &
qdm-cmr-cli report business area --date 2026-05-20 --ai &
qdm-cmr-cli report business category --date 2026-05-20 --ai &
qdm-cmr-cli report business trend --date 2026-05-20 --ai &
wait
`
	ok, _, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, command))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("module command should not inject context")
	}

	state := readPosttoolState(t, root, sessionID)
	report := state["reports"].(map[string]any)["business-overview"].(map[string]any)
	if got := stringSlice(report["recorded_modules"]); !sameStrings(got, []string{"overview", "indicators", "tree", "area", "category", "trend"}) {
		t.Fatalf("recorded_modules = %#v", got)
	}
}

func TestPosttoolBusinessSignalInjectsTemplateOnce(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-business-signal"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天经营情况")

	for _, module := range []string{"overview", "indicators", "tree", "area", "category", "trend"} {
		command := `qdm-cmr-cli report business ` + module + ` --date 2026-05-20`
		if module == "tree" {
			command = `qdm-cmr-cli report business tree --values --date 2026-05-20`
		}
		if ok, _, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, command)); err != nil {
			t.Fatal(err)
		} else if ok {
			t.Fatalf("module command should not inject context: %s", command)
		}
	}

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("missing business template in %s", context)
	}
	if strings.Contains(context, "QDM 报告生成阶段上下文") || strings.Contains(context, "## Template: templates/business-overview-report.md") {
		t.Fatalf("unexpected wrapper in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	report := state["reports"].(map[string]any)["business-overview"].(map[string]any)
	if state["selected_playbook"] != "playbooks/cmr/business/default-overview.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/cmr/business/default-overview.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
	if _, ok := report["spec_injected"]; ok {
		t.Fatalf("did not expect legacy spec_injected in %#v", report)
	}

	ok, output, err = posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !strings.Contains(output.HookSpecificOutput.AdditionalContext, "经营分析深度报告模板") {
		t.Fatalf("expected repeat injection of same template body, got ok=%v output=%#v", ok, output)
	}
}

func TestPosttoolBrandProductEffectivenessInjectsDrillTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-brand-product-effectiveness"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的品效情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "品效下钻分析报告模板") {
		t.Fatalf("missing brand product effectiveness template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/s-brand-product-effectiveness.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolCustPenetrationRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-cust-penetration-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的客数渗透率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "客数渗透率指标分析报告模板") {
		t.Fatalf("missing cust penetration rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/cust-penetration-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/cust-penetration-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolSaleAmtInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-sale-amt"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的销售额情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "销售额指标分析报告模板") {
		t.Fatalf("missing sale amt template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/sale-amt.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/sale-amt-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolBf19SaleRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-bf19-sale-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的19点前销售占比情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "19点前销售占比指标分析报告模板") {
		t.Fatalf("missing bf19 sale rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "销售额指标分析报告模板") {
		t.Fatalf("unexpected sale amt template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/bf19-sale-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolBf19SaleWeightInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-bf19-sale-weight"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的19点前销售重量情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "19点前销售重量指标分析报告模板") {
		t.Fatalf("missing bf19 sale weight template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "销售额指标分析报告模板") {
		t.Fatalf("unexpected sale amt template in %s", context)
	}
	if strings.Contains(context, "19点前销售占比指标分析报告模板") {
		t.Fatalf("unexpected bf19 sale rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-weight.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/bf19-sale-weight-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolSatisfiedRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-satisfied-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的订单满足率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "订单满足率指标分析报告模板") {
		t.Fatalf("missing satisfied rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "销售额指标分析报告模板") {
		t.Fatalf("unexpected sale amt template in %s", context)
	}
	if strings.Contains(context, "19点前销售占比指标分析报告模板") {
		t.Fatalf("unexpected bf19 sale rate template in %s", context)
	}
	if strings.Contains(context, "19点前销售重量指标分析报告模板") {
		t.Fatalf("unexpected bf19 sale weight template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/satisfied-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/satisfied-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolCustNumInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-cust-num"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的客数情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "客数指标分析报告模板") {
		t.Fatalf("missing cust num template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/cust-num.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/cust-num-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolBf19CustNumInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-bf19-cust-num"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的19点前客数情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "19点前客数指标分析报告模板") {
		t.Fatalf("missing bf19 cust num template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "# 客数指标分析报告模板") {
		t.Fatalf("unexpected cust num template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-cust-num.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/bf19-cust-num-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolBf19CategoryStoreCustRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-bf19-category-store-cust-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的19点前PI值情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "19点前PI值指标分析报告模板") {
		t.Fatalf("missing bf19 category store cust rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "# 19点前客数指标分析报告模板") {
		t.Fatalf("unexpected bf19 cust num template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-category-store-cust-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/bf19-category-store-cust-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolBf19MemberRepurchaseRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-bf19-member-repurchase-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的19点前复购率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "19点前复购率指标分析报告模板") {
		t.Fatalf("missing bf19 member repurchase rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "# 19点前客数指标分析报告模板") {
		t.Fatalf("unexpected bf19 cust num template in %s", context)
	}
	if strings.Contains(context, "# 19点前PI值指标分析报告模板") {
		t.Fatalf("unexpected bf19 category store cust rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-member-repurchase-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/bf19-member-repurchase-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolPerCustAmtInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-per-cust-amt"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的客单价情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "客单价指标分析报告模板") {
		t.Fatalf("missing per cust amt template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/per-cust-amt.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/per-cust-amt-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolBf19PerCustAmtInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-bf19-per-cust-amt"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的19点前客单价情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "19点前客单价指标分析报告模板") {
		t.Fatalf("missing bf19 per cust amt template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "# 客单价指标分析报告模板") {
		t.Fatalf("unexpected per cust amt template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-per-cust-amt.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/bf19-per-cust-amt-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolBf19AvgPieceNumInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-bf19-avg-piece-num"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的19点前单均件数情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "19点前单均件数指标分析报告模板") {
		t.Fatalf("missing bf19 avg piece num template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "# 19点前客单价指标分析报告模板") {
		t.Fatalf("unexpected bf19 per cust amt template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-avg-piece-num.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/bf19-avg-piece-num-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolBf19PerPieceAmtInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-bf19-per-piece-amt"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的19点前件单价情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "19点前件单价指标分析报告模板") {
		t.Fatalf("missing bf19 per piece amt template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "# 19点前客单价指标分析报告模板") {
		t.Fatalf("unexpected bf19 per cust amt template in %s", context)
	}
	if strings.Contains(context, "# 19点前单均件数指标分析报告模板") {
		t.Fatalf("unexpected bf19 avg piece num template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-per-piece-amt.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/bf19-per-piece-amt-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolFullLinkStoreProfitNotaxRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-full-link-store-profit-notax-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的全链路毛利率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "全链路毛利率指标分析报告模板") {
		t.Fatalf("missing full link profit rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/full-link-store-profit-notax-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolProfitRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-profit-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的门店毛利率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "门店毛利率指标分析报告模板") {
		t.Fatalf("missing profit rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "# 全链路毛利率指标分析报告模板") {
		t.Fatalf("unexpected full link profit rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/profit-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/profit-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolScmStoreProfitNotaxRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-scm-store-profit-notax-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的供应链毛利率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "供应链毛利率指标分析报告模板") {
		t.Fatalf("missing scm store profit notax rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "# 全链路毛利率指标分析报告模板") {
		t.Fatalf("unexpected full link profit rate template in %s", context)
	}
	if strings.Contains(context, "# 门店毛利率指标分析报告模板") {
		t.Fatalf("unexpected profit rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/scm-store-profit-notax-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/scm-store-profit-notax-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolFullLinkStoreProfitAmtNotaxInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-full-link-store-profit-amt-notax"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的全链路毛利额情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "全链路毛利额指标分析报告模板") {
		t.Fatalf("missing full link profit amount template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "全链路毛利率指标分析报告模板") {
		t.Fatalf("unexpected full link profit rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-amt-notax.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/full-link-store-profit-amt-notax-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolProfitAmtInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-profit-amt"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的门店毛利额情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "门店毛利额指标分析报告模板") {
		t.Fatalf("missing profit amount template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "全链路毛利额指标分析报告模板") {
		t.Fatalf("unexpected full link profit amount template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/profit-amt.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/profit-amt-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolScmStoreProfitAmtNotaxInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-scm-store-profit-amt-notax"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的供应链毛利额情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "供应链毛利额指标分析报告模板") {
		t.Fatalf("missing scm profit amount template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "全链路毛利额指标分析报告模板") {
		t.Fatalf("unexpected full link profit amount template in %s", context)
	}
	if strings.Contains(context, "门店毛利额指标分析报告模板") {
		t.Fatalf("unexpected profit amount template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/cust-penetration-rate/scm-store-profit-amt-notax.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/cust-penetration-rate/scm-store-profit-amt-notax-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolPrePriceProfitRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-pre-price-profit-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的定价毛利率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "定价毛利率指标分析报告模板") {
		t.Fatalf("missing pre price profit rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "品效分析报告模板") {
		t.Fatalf("unexpected brand product effectiveness template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/pre-price-profit-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolPreProfitRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-pre-profit-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的预期毛利率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "预期毛利率指标分析报告模板") {
		t.Fatalf("missing pre profit rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "定价毛利率指标分析报告模板") {
		t.Fatalf("unexpected pre price profit rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/pre-profit-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/pre-profit-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolScmPromotionTotalRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-scm-promotion-total-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的出库折让率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "出库折让率指标分析报告模板") {
		t.Fatalf("missing scm promotion total rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "预期毛利率指标分析报告模板") {
		t.Fatalf("unexpected pre profit rate template in %s", context)
	}
	if strings.Contains(context, "定价毛利率指标分析报告模板") {
		t.Fatalf("unexpected pre price profit rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/scm-promotion-total-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/scm-promotion-total-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolHourDiscountRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-hour-discount-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的时段折扣率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "时段折扣率指标分析报告模板") {
		t.Fatalf("missing hour discount rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "定价毛利率指标分析报告模板") {
		t.Fatalf("unexpected pre price profit rate template in %s", context)
	}
	if strings.Contains(context, "促销折扣率指标分析报告模板") {
		t.Fatalf("unexpected promotion discount rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/hour-discount-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/hour-discount-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolPromotionDiscountRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-promotion-discount-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的促销折扣率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "促销折扣率指标分析报告模板") {
		t.Fatalf("missing promotion discount rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "定价毛利率指标分析报告模板") {
		t.Fatalf("unexpected pre price profit rate template in %s", context)
	}
	if strings.Contains(context, "时段折扣率指标分析报告模板") {
		t.Fatalf("unexpected hour discount rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/promotion-discount-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/promotion-discount-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolOrderArticleRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-order-article-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的商品订购渗透率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "商品订购渗透率指标分析报告模板") {
		t.Fatalf("missing order article rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "品效分析报告模板") {
		t.Fatalf("unexpected brand product effectiveness template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/order-article-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/order-article-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolOrderStoresInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-order-stores"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的订购门店数情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "订购门店数指标分析报告模板") {
		t.Fatalf("missing order stores template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "商品订购渗透率指标分析报告模板") {
		t.Fatalf("unexpected order article rate template in %s", context)
	}
	if strings.Contains(context, "品效分析报告模板") {
		t.Fatalf("unexpected brand product effectiveness template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/order-stores.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/order-stores-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolStoreCanOrdersInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-store-can-orders"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的可订门店数情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "可订门店数指标分析报告模板") {
		t.Fatalf("missing store can orders template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "商品订购渗透率指标分析报告模板") {
		t.Fatalf("unexpected order article rate template in %s", context)
	}
	if strings.Contains(context, "订购门店数指标分析报告模板") {
		t.Fatalf("unexpected order stores template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/store-can-orders.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/store-can-orders-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolPriceIndexInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-price-index"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的售价价格指数(线上)情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "售价价格指数指标分析报告模板") {
		t.Fatalf("missing price index template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "品效分析报告模板") {
		t.Fatalf("unexpected brand product effectiveness template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/price-index.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/price-index-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolPurchasePriceIndexInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-purchase-price-index"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的采购价格指数情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "采购价格指数指标分析报告模板") {
		t.Fatalf("missing purchase price index template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "售价价格指数指标分析报告模板") {
		t.Fatalf("unexpected price index template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/purchase-price-index.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/purchase-price-index-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolLostRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-lost-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的损耗率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "损耗率指标分析报告模板") {
		t.Fatalf("missing lost rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "定价毛利率指标分析报告模板") {
		t.Fatalf("unexpected pre price profit rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/brand-product-effectiveness/lost-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/brand-product-effectiveness/lost-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolActiveVenderNumInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-active-vender-num"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的活跃供应商数情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "活跃供应商数指标分析报告模板") {
		t.Fatalf("missing active vender num template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/active-vender-num/active-vender-num.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/active-vender-num/active-vender-num-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolCentralInstockRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-central-instock-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的集采入库占比情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "集采入库占比指标分析报告模板") {
		t.Fatalf("missing central instock rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "活跃供应商数指标分析报告模板") {
		t.Fatalf("unexpected active vender num template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/active-vender-num/central-instock-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/active-vender-num/central-instock-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolThreeRateScoreInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-three-rate-score"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的三率综合得分情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "三率综合得分指标分析报告模板") {
		t.Fatalf("missing three rate score template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "活跃供应商数指标分析报告模板") {
		t.Fatalf("unexpected active vender num template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/active-vender-num/three-rate-score.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/active-vender-num/three-rate-score-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolVendorAccuracyRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-vendor-accuracy-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的准确率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "准确率指标分析报告模板") {
		t.Fatalf("missing vendor accuracy rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "三率综合得分指标分析报告模板") {
		t.Fatalf("unexpected three rate score template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/active-vender-num/vendor-accuracy-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/active-vender-num/vendor-accuracy-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolVendorIntimeRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-vendor-intime-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的准点率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "准点率指标分析报告模板") {
		t.Fatalf("missing vendor intime rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "三率综合得分指标分析报告模板") {
		t.Fatalf("unexpected three rate score template in %s", context)
	}
	if strings.Contains(context, "准确率指标分析报告模板") {
		t.Fatalf("unexpected vendor accuracy rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/active-vender-num/vendor-intime-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/active-vender-num/vendor-intime-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolVendorQualificationRateInjectsMetricTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	root := root(t)
	sessionID := "go-posttool-vendor-qualification-rate"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的合格率情况")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	if !strings.Contains(context, "合格率指标分析报告模板") {
		t.Fatalf("missing vendor qualification rate template in %s", context)
	}
	if strings.Contains(context, "经营分析深度报告模板") {
		t.Fatalf("unexpected business overview template in %s", context)
	}
	if strings.Contains(context, "三率综合得分指标分析报告模板") {
		t.Fatalf("unexpected three rate score template in %s", context)
	}
	if strings.Contains(context, "准确率指标分析报告模板") {
		t.Fatalf("unexpected vendor accuracy rate template in %s", context)
	}
	if strings.Contains(context, "准点率指标分析报告模板") {
		t.Fatalf("unexpected vendor intime rate template in %s", context)
	}

	state := readPosttoolState(t, root, sessionID)
	if state["selected_playbook"] != "wikis/playbooks/cmr/business/active-vender-num/vendor-qualification-rate.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business/active-vender-num/vendor-qualification-rate-report.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolFinancialSignalInjectsOnlyTemplate(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-financial"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的财务报表")

	for _, command := range []string{
		`qdm-cmr-cli report company indicators --week 2026-20 --ai`,
		`qdm-cmr-cli report company tree --values --week 2026-20`,
		`qdm-cmr-cli table --report company --week 2026-20 --indicator EBITDA --dim-type 管理区域 --ai`,
	} {
		ok, _, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, command))
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("module command should not inject context: %s", command)
		}
	}

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	for _, want := range []string{"财务核心指标深度报告模板", "## 一、报告概述"} {
		if !stringsContains(context, want) {
			t.Fatalf("missing %q in template context", want)
		}
	}
	for _, unexpected := range []string{"QDM 报告生成阶段上下文", "## Template: templates/financial-overview-report.md", "财务核心指标归属规范", "财务核心指标报告合同"} {
		if stringsContains(context, unexpected) {
			t.Fatalf("unexpected %q in template-only context", unexpected)
		}
	}

	state := readPosttoolState(t, root, sessionID)
	report := state["reports"].(map[string]any)["financial-overview"].(map[string]any)
	if got := stringSlice(report["recorded_modules"]); !sameStrings(got, []string{"indicators", "tree", "table"}) {
		t.Fatalf("recorded_modules = %#v", got)
	}
	if state["template_injected"] != true {
		t.Fatalf("expected root template_injected in %#v", state)
	}
}

func TestPosttoolReportsMissingModulesBeforeSignal(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-missing"
	cleanupPosttoolState(t, root, sessionID)

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected missing playbook output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	for _, want := range []string{"session state missing", "Do not guess a template"} {
		if !stringsContains(context, want) {
			t.Fatalf("missing %q in %s", want, context)
		}
	}
}

func TestPosttoolTemplateDiagnosticsRecordSelectedTemplate(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-diag-member"
	cleanupPosttoolState(t, root, sessionID)
	t.Setenv("QDM_HARNESS_DIAG", "1")
	writeContextState(t, root, sessionID, "查看昨天用户报表")

	ok, _, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected template output")
	}
	events := readDiagnosticEvents(t, root, sessionID)
	event := events[len(events)-1]
	if event["event"] != "inject_template" {
		t.Fatalf("event = %#v", event)
	}
	if event["selected_playbook"] != "playbooks/cmr/member/default-overview.md" {
		t.Fatalf("selected_playbook = %#v", event["selected_playbook"])
	}
	if event["template_path"] != "templates/cmr/member/default-overview.md" {
		t.Fatalf("template_path = %#v", event["template_path"])
	}
	for _, unexpected := range []string{"template_signal", "template_signal_arg", "spec_path"} {
		if _, ok := event[unexpected]; ok {
			t.Fatalf("unexpected %s in %#v", unexpected, event)
		}
	}
	if event["outcome"] != "template_injected" {
		t.Fatalf("outcome = %#v", event["outcome"])
	}
}

func TestPosttoolInjectTemplateUsesFreeAnalysisForAmbiguousPlaybooks(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-ambiguous"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "会员复购和门店净利润最近为什么下降？")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected free analysis output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	for _, want := range []string{"QDM_FREE_ANALYSIS", "free mode", "Do not run inject-template"} {
		if !stringsContains(context, want) {
			t.Fatalf("missing %q in %s", want, context)
		}
	}
	state := readPosttoolState(t, root, sessionID)
	if state["mode"] != "free" {
		t.Fatalf("mode = %#v", state["mode"])
	}
}

func TestPosttoolInjectTemplateRefusesMultiSingleTemplate(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-multi-single"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "销售额和客单价最近怎么样？")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected posttool output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	for _, want := range []string{"no selectedPlaybook", "Do not guess a template"} {
		if !stringsContains(context, want) {
			t.Fatalf("missing %q in %s", want, context)
		}
	}

	state := readPosttoolState(t, root, sessionID)
	if state["mode"] != "multi_single" {
		t.Fatalf("mode = %#v", state["mode"])
	}
	if state["selected_template"] != nil {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] == true {
		t.Fatalf("did not expect root template_injected in %#v", state)
	}
}

func TestPosttoolInjectTemplateReportsMissingTemplate(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-missing-template"
	cleanupPosttoolState(t, root, sessionID)
	state := map[string]any{
		"session_id":        sessionID,
		"mode":              "single",
		"selected_playbook": "playbooks/cmr/member/default-overview.md",
		"selected_template": "templates/missing-report.md",
	}
	writePosttoolState(t, root, sessionID, state)

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !stringsContains(output.HookSpecificOutput.AdditionalContext, "missing templates/missing-report.md") {
		t.Fatalf("expected missing template output, got ok=%v output=%#v", ok, output)
	}
}

func writeContextState(t *testing.T, root, sessionID, prompt string) {
	t.Helper()
	t.Setenv("CLAUDE_SESSION_ID", sessionID)
	data, err := json.Marshal(map[string]string{"prompt": prompt})
	if err != nil {
		t.Fatal(err)
	}
	ok, _, err := dhcontext.RunClaudeHook(root, data)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected context hook output")
	}
}

func writePosttoolState(t *testing.T, root, sessionID string, state map[string]any) {
	t.Helper()
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func bashPayload(t *testing.T, sessionID, command string) []byte {
	t.Helper()
	payload := map[string]any{
		"session_id": sessionID,
		"tool_name":  "Bash",
		"tool_input": map[string]any{"command": command},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func cleanupPosttoolState(t *testing.T, root, sessionID string) {
	t.Helper()
	paths := []string{
		filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json"),
		filepath.Join(root, ".claude", "hooks", "state", "diagnostics", sessionID+".jsonl"),
	}
	remove := func() {
		for _, path := range paths {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		}
	}
	remove()
	t.Cleanup(remove)
}

func readPosttoolState(t *testing.T, root, sessionID string) map[string]any {
	t.Helper()
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func readDiagnosticEvents(t *testing.T, root, sessionID string) []map[string]any {
	t.Helper()
	path := filepath.Join(root, ".claude", "hooks", "state", "diagnostics", sessionID+".jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	return events
}

func stringSlice(value any) []string {
	items, _ := value.([]any)
	var out []string
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func stringsContains(s, substr string) bool {
	return bytes.Contains([]byte(s), []byte(substr))
}
