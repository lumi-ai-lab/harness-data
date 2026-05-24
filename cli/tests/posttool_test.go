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
source config/qdm-cli-paths.env
"$QDM_CMR_CLI" report business overview --date 2026-05-20 --ai &
"$QDM_CMR_CLI" report business indicators --date 2026-05-20 --ai &
"$QDM_CMR_CLI" report business tree --values --date 2026-05-20 &
"$QDM_CMR_CLI" report business area --date 2026-05-20 --ai &
"$QDM_CMR_CLI" report business category --date 2026-05-20 --ai &
"$QDM_CMR_CLI" report business trend --date 2026-05-20 --ai &
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
		command := `"$QDM_CMR_CLI" report business ` + module + ` --date 2026-05-20`
		if module == "tree" {
			command = `"$QDM_CMR_CLI" report business tree --values --date 2026-05-20`
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
	if state["selected_playbook"] != "playbooks/business/default-overview.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business-overview-report.md" {
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
	if !ok || !strings.Contains(output.HookSpecificOutput.AdditionalContext, "already injected") {
		t.Fatalf("expected already injected output, got ok=%v output=%#v", ok, output)
	}
}

func TestPosttoolFinancialSignalInjectsOnlyTemplate(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-financial"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "查看昨天的财务报表")

	for _, command := range []string{
		`"$QDM_CMR_CLI" report company indicators --week 2026-20 --ai`,
		`"$QDM_CMR_CLI" report company tree --values --week 2026-20`,
		`"$QDM_CMR_CLI" table --report company --week 2026-20 --indicator EBITDA --dim-type 管理区域 --ai`,
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
	for _, want := range []string{"no selected playbook", "data-harness-cli inject-template"} {
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
	if event["selected_playbook"] != "playbooks/member/default-overview.md" {
		t.Fatalf("selected_playbook = %#v", event["selected_playbook"])
	}
	if event["template_path"] != "templates/member-overview-report.md" {
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

func TestPosttoolInjectTemplateReportsAmbiguousPlaybooks(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-ambiguous"
	cleanupPosttoolState(t, root, sessionID)
	writeContextState(t, root, sessionID, "会员复购和门店净利润最近为什么下降？")

	ok, output, err := posttool.RunClaudeHook(root, bashPayload(t, sessionID, "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected ambiguous output")
	}
	context := output.HookSpecificOutput.AdditionalContext
	for _, want := range []string{"ambiguous playbook candidates", "playbooks/member/default-overview.md", "playbooks/store/default-overview.md"} {
		if !stringsContains(context, want) {
			t.Fatalf("missing %q in %s", want, context)
		}
	}
}

func TestPosttoolInjectTemplateReportsMissingTemplate(t *testing.T) {
	root := root(t)
	sessionID := "go-posttool-missing-template"
	cleanupPosttoolState(t, root, sessionID)
	state := map[string]any{
		"session_id":        sessionID,
		"selected_playbook": "playbooks/member/default-overview.md",
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
