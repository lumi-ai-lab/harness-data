package tests

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	dhcontext "harness-data/cli/internal/context"
)

func TestMemberRepurchaseContext(t *testing.T) {
	response, err := dhcontext.Build(root(t), "华东区最近会员复购为什么下降？")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{"wikis/spec/cmr/member/index.md", "wikis/spec/cmr/member/s-member-repurchase-no-difference-rate.md", "wikis/playbooks/cmr/member/s-member-repurchase-no-difference-rate.md"} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	for _, ref := range response.ContextFiles {
		if !strings.HasPrefix(ref.Path, "wikis/spec/") && !strings.HasPrefix(ref.Path, "wikis/playbooks/") {
			t.Fatalf("unexpected context path %s", ref.Path)
		}
	}
}

func TestStoreProfitDoesNotReturnMemberSpec(t *testing.T) {
	response, err := dhcontext.Build(root(t), "门店净利润最近表现")
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range response.ContextFiles {
		if ref.Path == "wikis/spec/cmr/member/index.md" || ref.Path == "wikis/spec/cmr/member/s-member-repurchase-no-difference-rate.md" {
			t.Fatalf("unexpected member spec: %#v", response.ContextFiles)
		}
	}
}

func TestMemberCategoryUnsupported(t *testing.T) {
	response, err := dhcontext.Build(root(t), "全品类用户报表")
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range response.ContextFiles {
		if ref.Path == "wikis/spec/cmr/member/category-unsupported.md" {
			return
		}
	}
	t.Fatalf("missing category unsupported rule: %#v", response.ContextFiles)
}

func TestMultiDomainContextRecall(t *testing.T) {
	response, err := dhcontext.Build(root(t), "会员复购和门店净利润最近为什么下降？")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/member/s-member-repurchase-no-difference-rate.md",
		"wikis/spec/cmr/store-manager/s-net-profit.md",
		"wikis/playbooks/cmr/member/s-member-repurchase-no-difference-rate.md",
		"wikis/playbooks/cmr/store-manager/s-net-profit.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
}

func TestClaudeHookFormatOmitsQueryType(t *testing.T) {
	payload := bytes.NewBufferString(`{"prompt":"会员复购为什么下降？"}`)
	ok, output, err := dhcontext.RunClaudeHook(root(t), payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{"hookSpecificOutput", "UserPromptSubmit", "wikis/spec/cmr/member/s-member-repurchase-no-difference-rate.md"} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, text)
		}
	}
	for _, want := range []string{"data-harness-cli inject-template", "do_not_read_template_before_inject_template"} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, text)
		}
	}
	if bytes.Contains(data, []byte("query_type=")) {
		t.Fatalf("unexpected query_type in %s", text)
	}
}

func TestClaudeHookUsesPayloadSessionID(t *testing.T) {
	sessionID := "go-context-payload-session"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})
	t.Setenv("CLAUDE_SESSION_ID", "")

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"用户报表"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"session_id": "` + sessionID + `"`, `"selected_template": "templates/cmr/member/default-overview.md"`} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if !bytes.Contains(data, []byte(`"mode": "combo"`)) {
		t.Fatalf("missing combo mode in %s", string(data))
	}
}

func TestClaudeHookResetsStateForNewPrompt(t *testing.T) {
	sessionID := "go-context-reset-state"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{
  "session_id": "`+sessionID+`",
  "selected_playbook": "wikis/playbooks/cmr/member/default-overview.md",
  "selected_template": "templates/member-overview-report.md",
  "template_injected": true,
  "reports": {
    "member-overview": {
      "recorded_modules": ["overview"],
      "template_injected": true
	    }
	  }
	}
`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	prompt := "查看昨天经营情况"
	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"` + prompt + `"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	if state["prompt"] != prompt {
		t.Fatalf("prompt = %#v", state["prompt"])
	}
	if state["mode"] != "combo" {
		t.Fatalf("mode = %#v", state["mode"])
	}
	if state["started_at"] == "" {
		t.Fatalf("missing started_at in %s", string(data))
	}
	if state["selected_playbook"] != "playbooks/cmr/business/default-overview.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/cmr/business/default-overview.md" {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["template_injected"] != false {
		t.Fatalf("template_injected = %#v", state["template_injected"])
	}
	reports, ok := state["reports"].(map[string]any)
	if !ok || len(reports) != 0 {
		t.Fatalf("reports not reset: %#v", state["reports"])
	}
}

func TestClaudeHookAmbiguousPlaybooksUsesFreeAnalysisMode(t *testing.T) {
	sessionID := "go-context-free-analysis"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"2026年第10周粤西1区会员经营情况如何 @dm"}`)
	ok, output, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	for _, want := range []string{"Harness mode: free", "Do not run bin/data-harness-cli inject-template", "wikis/playbooks/cmr/business/default-overview.md", "wikis/playbooks/cmr/member/default-overview.md"} {
		if !bytes.Contains([]byte(context), []byte(want)) {
			t.Fatalf("missing %s in %s", want, context)
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	if state["mode"] != "free" {
		t.Fatalf("mode = %#v in %s", state["mode"], string(data))
	}
	if state["selected_playbook"] != nil {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != nil {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	if state["reason"] != "multiple_combo_alias_hits" {
		t.Fatalf("reason = %#v", state["reason"])
	}
}

func TestClaudeHookMultiMetricDefaultsToMultiSingleMode(t *testing.T) {
	sessionID := "go-context-multi-single-multi-metric"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"销售额和客单价最近怎么样？"}`)
	ok, output, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	for _, want := range []string{"Harness mode: multi_single", "selectedPlaybooks:", "playbooks/cmr/business/s-sale-amt.md", "playbooks/cmr/business/s-per-cust-amt.md"} {
		if !bytes.Contains([]byte(context), []byte(want)) {
			t.Fatalf("missing %s in %s", want, context)
		}
	}
	for _, unwanted := range []string{"selectedPlaybook: playbooks/cmr/business/default-overview.md", "templates/cmr/business/default-overview.md", "- wikis/spec/cmr/business/s-sale-amt.md", "- wikis/spec/cmr/business/s-per-cust-amt.md"} {
		if bytes.Contains([]byte(context), []byte(unwanted)) {
			t.Fatalf("unexpected combo/spec context: %s in %s", unwanted, context)
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	if state["mode"] != "multi_single" {
		t.Fatalf("mode = %#v in %s", state["mode"], string(data))
	}
	if state["selected_playbook"] != nil {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != nil {
		t.Fatalf("selected_template = %#v", state["selected_template"])
	}
	selected, ok := state["selected_playbooks"].([]any)
	if !ok || len(selected) != 2 {
		t.Fatalf("selected_playbooks = %#v", state["selected_playbooks"])
	}
}

func TestBusinessBrandProductEffectivenessContextSelectsDrillPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的品效情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/s-brand-product-effectiveness.md",
		"wikis/routing/business-brand-product-effectiveness.md",
		"wikis/playbooks/cmr/business/s-brand-product-effectiveness.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessOverviewStillSelectsDefaultPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天经营情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	if !got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("missing business default playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/s-brand-product-effectiveness.md"] {
		t.Fatalf("unexpected brand product playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/cust-penetration-rate.md"] {
		t.Fatalf("unexpected cust penetration playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessCustPenetrationRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的客数渗透率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/cust-penetration-rate.md",
		"wikis/routing/business-cust-penetration-rate-cust-penetration-rate.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/cust-penetration-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessSaleAmtContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的销售额情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/sale-amt.md",
		"wikis/routing/business-cust-penetration-rate-sale-amt.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/sale-amt.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessBf19SaleRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的19点前销售占比情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/bf19-sale-rate.md",
		"wikis/routing/business-cust-penetration-rate-bf19-sale-rate.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/sale-amt.md"] {
		t.Fatalf("unexpected sale amt playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessBf19SaleWeightContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的19点前销售重量情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/bf19-sale-weight.md",
		"wikis/routing/business-cust-penetration-rate-bf19-sale-weight.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-weight.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/sale-amt.md"] {
		t.Fatalf("unexpected sale amt playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-rate.md"] {
		t.Fatalf("unexpected bf19 sale rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessSatisfiedRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的订单满足率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/satisfied-rate.md",
		"wikis/routing/business-cust-penetration-rate-satisfied-rate.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/satisfied-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/sale-amt.md"] {
		t.Fatalf("unexpected sale amt playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-rate.md"] {
		t.Fatalf("unexpected bf19 sale rate playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-weight.md"] {
		t.Fatalf("unexpected bf19 sale weight playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessCustNumContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的客数情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/cust-num.md",
		"wikis/routing/business-cust-penetration-rate-cust-num.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/cust-num.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessBf19CustNumContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的19点前客数情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/bf19-cust-num.md",
		"wikis/routing/business-cust-penetration-rate-bf19-cust-num.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/bf19-cust-num.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/cust-num.md"] {
		t.Fatalf("unexpected cust num playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessBf19CategoryStoreCustRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的19点前PI值情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/bf19-category-store-cust-rate.md",
		"wikis/routing/business-cust-penetration-rate-bf19-category-store-cust-rate.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/bf19-category-store-cust-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-cust-num.md"] {
		t.Fatalf("unexpected bf19 cust num playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessBf19MemberRepurchaseRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的19点前复购率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/bf19-member-repurchase-rate.md",
		"wikis/routing/business-cust-penetration-rate-bf19-member-repurchase-rate.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/bf19-member-repurchase-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-cust-num.md"] {
		t.Fatalf("unexpected bf19 cust num playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-category-store-cust-rate.md"] {
		t.Fatalf("unexpected bf19 category store cust rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessPerCustAmtContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的客单价情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/per-cust-amt.md",
		"wikis/routing/business-cust-penetration-rate-per-cust-amt.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/per-cust-amt.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessBf19PerCustAmtContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的19点前客单价情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/bf19-per-cust-amt.md",
		"wikis/routing/business-cust-penetration-rate-bf19-per-cust-amt.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/bf19-per-cust-amt.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/per-cust-amt.md"] {
		t.Fatalf("unexpected per cust amt playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessBf19AvgPieceNumContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的19点前单均件数情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/bf19-avg-piece-num.md",
		"wikis/routing/business-cust-penetration-rate-bf19-avg-piece-num.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/bf19-avg-piece-num.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-per-cust-amt.md"] {
		t.Fatalf("unexpected bf19 per cust amt playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessBf19PerPieceAmtContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的19点前件单价情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/bf19-per-piece-amt.md",
		"wikis/routing/business-cust-penetration-rate-bf19-per-piece-amt.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/bf19-per-piece-amt.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-per-cust-amt.md"] {
		t.Fatalf("unexpected bf19 per cust amt playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/bf19-avg-piece-num.md"] {
		t.Fatalf("unexpected bf19 avg piece num playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessFullLinkStoreProfitNotaxRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的全链路毛利率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md",
		"wikis/routing/business-cust-penetration-rate-full-link-store-profit-notax-rate.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessProfitRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的门店毛利率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/profit-rate.md",
		"wikis/routing/business-cust-penetration-rate-profit-rate.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/profit-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md"] {
		t.Fatalf("unexpected full link profit rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessScmStoreProfitNotaxRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的供应链毛利率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/scm-store-profit-notax-rate.md",
		"wikis/routing/business-cust-penetration-rate-scm-store-profit-notax-rate.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/scm-store-profit-notax-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md"] {
		t.Fatalf("unexpected full link profit rate playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/profit-rate.md"] {
		t.Fatalf("unexpected profit rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessFullLinkStoreProfitAmtNotaxContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的全链路毛利额情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/full-link-store-profit-amt-notax.md",
		"wikis/routing/business-cust-penetration-rate-full-link-store-profit-amt-notax.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-amt-notax.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md"] {
		t.Fatalf("unexpected full link profit rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessProfitAmtContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的门店毛利额情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/profit-amt.md",
		"wikis/routing/business-cust-penetration-rate-profit-amt.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/profit-amt.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-amt-notax.md"] {
		t.Fatalf("unexpected full link profit amount playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessScmStoreProfitAmtNotaxContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的供应链毛利额情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/cust-penetration-rate/scm-store-profit-amt-notax.md",
		"wikis/routing/business-cust-penetration-rate-scm-store-profit-amt-notax.md",
		"wikis/playbooks/cmr/business/cust-penetration-rate/scm-store-profit-amt-notax.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-amt-notax.md"] {
		t.Fatalf("unexpected full link profit amount playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/cust-penetration-rate/profit-amt.md"] {
		t.Fatalf("unexpected profit amount playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessPrePriceProfitRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的定价毛利率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md",
		"wikis/routing/business-brand-product-effectiveness-pre-price-profit-rate.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/s-brand-product-effectiveness.md"] {
		t.Fatalf("unexpected brand product effectiveness root playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessPreProfitRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的预期毛利率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/pre-profit-rate.md",
		"wikis/routing/business-brand-product-effectiveness-pre-profit-rate.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/pre-profit-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md"] {
		t.Fatalf("unexpected pre price profit rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessScmPromotionTotalRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的出库折让率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/scm-promotion-total-rate.md",
		"wikis/routing/business-brand-product-effectiveness-scm-promotion-total-rate.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/scm-promotion-total-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/pre-profit-rate.md"] {
		t.Fatalf("unexpected pre profit rate playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md"] {
		t.Fatalf("unexpected pre price profit rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessHourDiscountRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的时段折扣率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/hour-discount-rate.md",
		"wikis/routing/business-brand-product-effectiveness-hour-discount-rate.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/hour-discount-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md"] {
		t.Fatalf("unexpected pre price profit rate playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/promotion-discount-rate.md"] {
		t.Fatalf("unexpected promotion discount rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessPromotionDiscountRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的促销折扣率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/promotion-discount-rate.md",
		"wikis/routing/business-brand-product-effectiveness-promotion-discount-rate.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/promotion-discount-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md"] {
		t.Fatalf("unexpected pre price profit rate playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/hour-discount-rate.md"] {
		t.Fatalf("unexpected hour discount rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessOrderArticleRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的商品订购渗透率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/order-article-rate.md",
		"wikis/routing/business-brand-product-effectiveness-order-article-rate.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/order-article-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/s-brand-product-effectiveness.md"] {
		t.Fatalf("unexpected brand product effectiveness root playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessOrderStoresContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的订购门店数情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/order-stores.md",
		"wikis/routing/business-brand-product-effectiveness-order-stores.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/order-stores.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/order-article-rate.md"] {
		t.Fatalf("unexpected order article rate playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/s-brand-product-effectiveness.md"] {
		t.Fatalf("unexpected brand product effectiveness root playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessStoreCanOrdersContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的可订门店数情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/store-can-orders.md",
		"wikis/routing/business-brand-product-effectiveness-store-can-orders.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/store-can-orders.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/order-article-rate.md"] {
		t.Fatalf("unexpected order article rate playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/order-stores.md"] {
		t.Fatalf("unexpected order stores playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessPriceIndexContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的售价价格指数(线上)情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/price-index.md",
		"wikis/routing/business-brand-product-effectiveness-price-index.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/price-index.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/s-brand-product-effectiveness.md"] {
		t.Fatalf("unexpected brand product effectiveness root playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessPurchasePriceIndexContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的采购价格指数情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/purchase-price-index.md",
		"wikis/routing/business-brand-product-effectiveness-purchase-price-index.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/purchase-price-index.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/price-index.md"] {
		t.Fatalf("unexpected price index playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessLostRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的损耗率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/brand-product-effectiveness/lost-rate.md",
		"wikis/routing/business-brand-product-effectiveness-lost-rate.md",
		"wikis/playbooks/cmr/business/brand-product-effectiveness/lost-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md"] {
		t.Fatalf("unexpected pre price profit rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessActiveVenderNumContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的活跃供应商数情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/active-vender-num/active-vender-num.md",
		"wikis/routing/business-active-vender-num-active-vender-num.md",
		"wikis/playbooks/cmr/business/active-vender-num/active-vender-num.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessCentralInstockRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的集采入库占比情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/active-vender-num/central-instock-rate.md",
		"wikis/routing/business-active-vender-num-central-instock-rate.md",
		"wikis/playbooks/cmr/business/active-vender-num/central-instock-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/active-vender-num/active-vender-num.md"] {
		t.Fatalf("unexpected active vender num root playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessThreeRateScoreContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的三率综合得分情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/active-vender-num/three-rate-score.md",
		"wikis/routing/business-active-vender-num-three-rate-score.md",
		"wikis/playbooks/cmr/business/active-vender-num/three-rate-score.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/active-vender-num/active-vender-num.md"] {
		t.Fatalf("unexpected active vender num root playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessVendorAccuracyRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的准确率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/active-vender-num/vendor-accuracy-rate.md",
		"wikis/routing/business-active-vender-num-vendor-accuracy-rate.md",
		"wikis/playbooks/cmr/business/active-vender-num/vendor-accuracy-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/active-vender-num/three-rate-score.md"] {
		t.Fatalf("unexpected three rate score playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessVendorIntimeRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的准点率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/active-vender-num/vendor-intime-rate.md",
		"wikis/routing/business-active-vender-num-vendor-intime-rate.md",
		"wikis/playbooks/cmr/business/active-vender-num/vendor-intime-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/active-vender-num/three-rate-score.md"] {
		t.Fatalf("unexpected three rate score playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/active-vender-num/vendor-accuracy-rate.md"] {
		t.Fatalf("unexpected vendor accuracy rate playbook in %#v", response.ContextFiles)
	}
}

func TestBusinessVendorQualificationRateContextSelectsMetricPlaybook(t *testing.T) {
	t.Skip("legacy business layout assertion; covered by wikis path resolver tests")
	response, err := dhcontext.Build(root(t), "查看昨天的合格率情况")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, ref := range response.ContextFiles {
		got[ref.Path] = true
	}
	for _, want := range []string{
		"wikis/spec/cmr/business/active-vender-num/vendor-qualification-rate.md",
		"wikis/routing/business-active-vender-num-vendor-qualification-rate.md",
		"wikis/playbooks/cmr/business/active-vender-num/vendor-qualification-rate.md",
	} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
	if got["wikis/playbooks/cmr/business/default-overview.md"] {
		t.Fatalf("unexpected default overview playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/active-vender-num/three-rate-score.md"] {
		t.Fatalf("unexpected three rate score playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/active-vender-num/vendor-accuracy-rate.md"] {
		t.Fatalf("unexpected vendor accuracy rate playbook in %#v", response.ContextFiles)
	}
	if got["wikis/playbooks/cmr/business/active-vender-num/vendor-intime-rate.md"] {
		t.Fatalf("unexpected vendor intime rate playbook in %#v", response.ContextFiles)
	}
}

func TestClaudeHookSelectsBrandProductEffectivenessTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-brand-product-effectiveness"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的品效情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/s-brand-product-effectiveness.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsCustPenetrationRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-cust-penetration-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的客数渗透率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/cust-penetration-rate.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/cust-penetration-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsSaleAmtTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-sale-amt"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的销售额情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/sale-amt.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/sale-amt-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsBf19SaleRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-bf19-sale-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的19点前销售占比情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-rate.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/bf19-sale-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/sale-amt.md`)) {
		t.Fatalf("unexpected sale amt playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsBf19SaleWeightTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-bf19-sale-weight"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的19点前销售重量情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-sale-weight.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/bf19-sale-weight-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/sale-amt.md`)) {
		t.Fatalf("unexpected sale amt playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-sale-rate.md`)) {
		t.Fatalf("unexpected bf19 sale rate playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsSatisfiedRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-satisfied-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的订单满足率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/satisfied-rate.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/satisfied-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/sale-amt.md`)) {
		t.Fatalf("unexpected sale amt playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-sale-rate.md`)) {
		t.Fatalf("unexpected bf19 sale rate playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-sale-weight.md`)) {
		t.Fatalf("unexpected bf19 sale weight playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsCustNumTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-cust-num"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的客数情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/cust-num.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/cust-num-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-cust-num.md`)) {
		t.Fatalf("unexpected bf19 cust num playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsBf19CustNumTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-bf19-cust-num"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的19点前客数情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-cust-num.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/bf19-cust-num-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/cust-num.md`)) {
		t.Fatalf("unexpected cust num playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsBf19CategoryStoreCustRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-bf19-category-store-cust-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的19点前PI值情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-category-store-cust-rate.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/bf19-category-store-cust-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-cust-num.md`)) {
		t.Fatalf("unexpected bf19 cust num playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsBf19MemberRepurchaseRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-bf19-member-repurchase-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的19点前复购率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-member-repurchase-rate.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/bf19-member-repurchase-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-cust-num.md`)) {
		t.Fatalf("unexpected bf19 cust num playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-category-store-cust-rate.md`)) {
		t.Fatalf("unexpected bf19 category store cust rate playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsPerCustAmtTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-per-cust-amt"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的客单价情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/per-cust-amt.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/per-cust-amt-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsBf19PerCustAmtTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-bf19-per-cust-amt"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的19点前客单价情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-per-cust-amt.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/bf19-per-cust-amt-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/per-cust-amt.md`)) {
		t.Fatalf("unexpected per cust amt playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsBf19AvgPieceNumTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-bf19-avg-piece-num"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的19点前单均件数情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-avg-piece-num.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/bf19-avg-piece-num-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-per-cust-amt.md`)) {
		t.Fatalf("unexpected bf19 per cust amt playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsBf19PerPieceAmtTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-bf19-per-piece-amt"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的19点前件单价情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/bf19-per-piece-amt.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/bf19-per-piece-amt-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-per-cust-amt.md`)) {
		t.Fatalf("unexpected bf19 per cust amt playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/bf19-avg-piece-num.md`)) {
		t.Fatalf("unexpected bf19 avg piece num playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsFullLinkStoreProfitNotaxRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-full-link-store-profit-notax-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的全链路毛利率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/full-link-store-profit-notax-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsProfitRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-profit-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的门店毛利率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/profit-rate.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/profit-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md`)) {
		t.Fatalf("unexpected full link profit rate playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsScmStoreProfitNotaxRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-scm-store-profit-notax-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的供应链毛利率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/scm-store-profit-notax-rate.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/scm-store-profit-notax-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md`)) {
		t.Fatalf("unexpected full link profit rate playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/profit-rate.md`)) {
		t.Fatalf("unexpected profit rate playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsFullLinkStoreProfitAmtNotaxTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-full-link-store-profit-amt-notax"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的全链路毛利额情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-amt-notax.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/full-link-store-profit-amt-notax-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-notax-rate.md`)) {
		t.Fatalf("unexpected full link profit rate candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsProfitAmtTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-profit-amt"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的门店毛利额情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/profit-amt.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/profit-amt-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-amt-notax.md`)) {
		t.Fatalf("unexpected full link profit amount candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsScmStoreProfitAmtNotaxTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-scm-store-profit-amt-notax"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的供应链毛利额情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/cust-penetration-rate/scm-store-profit-amt-notax.md"`,
		`"selected_template": "templates/business/cust-penetration-rate/scm-store-profit-amt-notax-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/full-link-store-profit-amt-notax.md`)) {
		t.Fatalf("unexpected full link profit amount candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/cust-penetration-rate/profit-amt.md`)) {
		t.Fatalf("unexpected profit amount candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsPrePriceProfitRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-pre-price-profit-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的定价毛利率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/pre-price-profit-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/s-brand-product-effectiveness.md`)) {
		t.Fatalf("unexpected brand product effectiveness root candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsPreProfitRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-pre-profit-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的预期毛利率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/pre-profit-rate.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/pre-profit-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md`)) {
		t.Fatalf("unexpected pre price profit rate candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsScmPromotionTotalRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-scm-promotion-total-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的出库折让率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/scm-promotion-total-rate.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/scm-promotion-total-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/pre-profit-rate.md`)) {
		t.Fatalf("unexpected pre profit rate candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md`)) {
		t.Fatalf("unexpected pre price profit rate candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsHourDiscountRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-hour-discount-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的时段折扣率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/hour-discount-rate.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/hour-discount-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md`)) {
		t.Fatalf("unexpected pre price profit rate candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/promotion-discount-rate.md`)) {
		t.Fatalf("unexpected promotion discount rate candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsPromotionDiscountRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-promotion-discount-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的促销折扣率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/promotion-discount-rate.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/promotion-discount-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md`)) {
		t.Fatalf("unexpected pre price profit rate candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/hour-discount-rate.md`)) {
		t.Fatalf("unexpected hour discount rate candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsOrderArticleRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-order-article-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的商品订购渗透率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/order-article-rate.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/order-article-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/s-brand-product-effectiveness.md`)) {
		t.Fatalf("unexpected brand product effectiveness root candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsOrderStoresTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-order-stores"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的订购门店数情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/order-stores.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/order-stores-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/order-article-rate.md`)) {
		t.Fatalf("unexpected order article rate candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/s-brand-product-effectiveness.md`)) {
		t.Fatalf("unexpected brand product effectiveness root candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsStoreCanOrdersTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-store-can-orders"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的可订门店数情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/store-can-orders.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/store-can-orders-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/order-article-rate.md`)) {
		t.Fatalf("unexpected order article rate candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/order-stores.md`)) {
		t.Fatalf("unexpected order stores candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsPriceIndexTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-price-index"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的售价价格指数(线上)情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/price-index.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/price-index-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/s-brand-product-effectiveness.md`)) {
		t.Fatalf("unexpected brand product effectiveness root candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsPurchasePriceIndexTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-purchase-price-index"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的采购价格指数情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/purchase-price-index.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/purchase-price-index-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/price-index.md`)) {
		t.Fatalf("unexpected price index playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsLostRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-lost-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的损耗率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/brand-product-effectiveness/lost-rate.md"`,
		`"selected_template": "templates/business/brand-product-effectiveness/lost-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/brand-product-effectiveness/pre-price-profit-rate.md`)) {
		t.Fatalf("unexpected pre price profit rate candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsActiveVenderNumTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-active-vender-num"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的活跃供应商数情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/active-vender-num/active-vender-num.md"`,
		`"selected_template": "templates/business/active-vender-num/active-vender-num-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsCentralInstockRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-central-instock-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的集采入库占比情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/active-vender-num/central-instock-rate.md"`,
		`"selected_template": "templates/business/active-vender-num/central-instock-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/active-vender-num/active-vender-num.md`)) {
		t.Fatalf("unexpected active vender num root candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsThreeRateScoreTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-three-rate-score"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的三率综合得分情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/active-vender-num/three-rate-score.md"`,
		`"selected_template": "templates/business/active-vender-num/three-rate-score-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/active-vender-num/active-vender-num.md`)) {
		t.Fatalf("unexpected active vender num root candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsVendorAccuracyRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-vendor-accuracy-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的准确率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/active-vender-num/vendor-accuracy-rate.md"`,
		`"selected_template": "templates/business/active-vender-num/vendor-accuracy-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/active-vender-num/three-rate-score.md`)) {
		t.Fatalf("unexpected three rate score playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsVendorIntimeRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-vendor-intime-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的准点率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/active-vender-num/vendor-intime-rate.md"`,
		`"selected_template": "templates/business/active-vender-num/vendor-intime-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/active-vender-num/three-rate-score.md`)) {
		t.Fatalf("unexpected three rate score playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/active-vender-num/vendor-accuracy-rate.md`)) {
		t.Fatalf("unexpected vendor accuracy rate playbook candidate in %s", string(data))
	}
}

func TestClaudeHookSelectsVendorQualificationRateTemplate(t *testing.T) {
	t.Skip("legacy template-per-metric assertion; covered by wikis path resolver tests")
	sessionID := "go-context-vendor-qualification-rate"
	root := root(t)
	path := filepath.Join(root, ".claude", "hooks", "state", "business-report", sessionID+".json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	})

	payload := bytes.NewBufferString(`{"session_id":"` + sessionID + `","prompt":"查看昨天的合格率情况"}`)
	ok, _, err := dhcontext.RunClaudeHook(root, payload.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"selected_playbook": "wikis/playbooks/cmr/business/active-vender-num/vendor-qualification-rate.md"`,
		`"selected_template": "templates/business/active-vender-num/vendor-qualification-rate-report.md"`,
	} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/default-overview.md`)) {
		t.Fatalf("unexpected default playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/active-vender-num/three-rate-score.md`)) {
		t.Fatalf("unexpected three rate score playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/active-vender-num/vendor-accuracy-rate.md`)) {
		t.Fatalf("unexpected vendor accuracy rate playbook candidate in %s", string(data))
	}
	if bytes.Contains(data, []byte(`playbooks/cmr/business/active-vender-num/vendor-intime-rate.md`)) {
		t.Fatalf("unexpected vendor intime rate playbook candidate in %s", string(data))
	}
}
