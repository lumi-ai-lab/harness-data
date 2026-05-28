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
	if plan.Mode != sessionstate.ModeSingle || plan.SelectedPlaybook != "playbooks/idx/business/s-sale-amt.md" || plan.SelectedTemplate != "templates/idx/business/s-sale-amt.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	got := contextPaths(response)
	want := []string{
		"wikis/spec/idx/business/index.md",
		"wikis/spec/idx/business/s-sale-amt.md",
		"wikis/playbooks/idx/business/index.md",
		"wikis/playbooks/idx/business/s-sale-amt.md",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("context paths:\n%s", strings.Join(got, "\n"))
	}
	for _, unwanted := range []string{
		"wikis/spec/index.md",
		"wikis/spec/idx/index.md",
		"wikis/playbooks/index.md",
		"wikis/playbooks/idx/index.md",
	} {
		if hasString(got, unwanted) {
			t.Fatalf("unexpected ancestor index %s in %#v", unwanted, got)
		}
	}
	if !strings.Contains(response.Instruction, "Harness mode: single") || strings.Contains(response.Instruction, "templates/idx/business/s-sale-amt.md\n") {
		t.Fatalf("unexpected instruction: %s", response.Instruction)
	}
}

func TestBuildWithWikisIndexComboMode(t *testing.T) {
	root := testContextWikiRoot(t)
	response, plan, err := BuildWithPlan(root, "销售额和客单价经营概览")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != sessionstate.ModeCombo || plan.SelectedPlaybook != "playbooks/idx/business/default-overview.md" {
		t.Fatalf("unexpected plan: %+v", plan)
	}
	if len(plan.CoveredSpecs) != 3 {
		t.Fatalf("covered specs = %+v", plan.CoveredSpecs)
	}
	got := contextPaths(response)
	for _, want := range []string{
		"wikis/playbooks/idx/business/index.md",
		"wikis/playbooks/idx/business/default-overview.md",
		"wikis/spec/idx/business/index.md",
		"wikis/spec/idx/business/c-inventory.md",
	} {
		if !hasString(got, want) {
			t.Fatalf("missing %s in %#v", want, got)
		}
	}
	for _, unwanted := range []string{
		"wikis/spec/idx/business/s-per-cust-amt.md",
		"wikis/spec/idx/business/s-sale-amt.md",
	} {
		if hasString(got, unwanted) {
			t.Fatalf("single metric covered spec should not be expanded in combo context: %s in %#v", unwanted, got)
		}
	}
	if hasString(got, "wikis/templates/idx/business/default-overview.md") {
		t.Fatalf("template should not be in context files: %#v", got)
	}
	for _, unwanted := range []string{
		"wikis/spec/index.md",
		"wikis/spec/idx/index.md",
		"wikis/playbooks/index.md",
		"wikis/playbooks/idx/index.md",
	} {
		if hasString(got, unwanted) {
			t.Fatalf("unexpected ancestor index %s in %#v", unwanted, got)
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
		"wikis/spec/idx/business/index.md",
		"wikis/spec/idx/business/s-bf19-member-repurchase-rate.md",
		"wikis/playbooks/idx/business/index.md",
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
		"wikis/spec/idx/business/s-member-repurchase-rate.md",
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
	writeContextFile(t, root, "wikis/playbooks/idx/business/s-sale-amt.md", "# 销售额取数\n")
	writeContextFile(t, root, "wikis/playbooks/idx/business/s-per-cust-amt.md", "# 客单价取数\n")
	writeContextFile(t, root, "wikis/playbooks/idx/business/s-member-repurchase-rate.md", "# 会员复购率取数\n")
	writeContextFile(t, root, "wikis/playbooks/idx/business/s-bf19-member-repurchase-rate.md", "# 19点前滚动7天会员复购率取数\n")
	writeContextFile(t, root, "wikis/playbooks/idx/business/default-overview.md", `---
aliases: ["经营概览"]
covers:
  - spec/idx/business/c-inventory.md
  - spec/idx/business/s-sale-amt.md
  - spec/idx/business/s-per-cust-amt.md
---
# 经营概览
`)
	writeContextFile(t, root, "wikis/templates/idx/business/s-sale-amt.md", "# 销售额模板\n")
	writeContextFile(t, root, "wikis/templates/idx/business/s-per-cust-amt.md", "# 客单价模板\n")
	writeContextFile(t, root, "wikis/templates/idx/business/s-member-repurchase-rate.md", "# 会员复购率模板\n")
	writeContextFile(t, root, "wikis/templates/idx/business/s-bf19-member-repurchase-rate.md", "# 19点前滚动7天会员复购率模板\n")
	writeContextFile(t, root, "wikis/templates/idx/business/default-overview.md", "# 经营概览模板\n")
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
