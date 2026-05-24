package tests

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
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
	for _, want := range []string{"spec/member/index.md", "spec/member/repurchase.md", "spec/member/report-contract.md", "routing/member-overview.md"} {
		if !got[want] {
			t.Fatalf("missing %s in %#v", want, response.ContextFiles)
		}
	}
}

func TestStoreProfitDoesNotReturnMemberSpec(t *testing.T) {
	response, err := dhcontext.Build(root(t), "门店净利润最近表现")
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range response.ContextFiles {
		if ref.Path == "spec/member/index.md" || ref.Path == "spec/member/repurchase.md" {
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
		if ref.Path == "spec/member/category-unsupported.md" {
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
		"spec/member/repurchase.md",
		"spec/store/profit-efficiency.md",
		"routing/member-overview.md",
		"routing/store-overview.md",
		"playbooks/member/default-overview.md",
		"playbooks/store/default-overview.md",
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
	for _, want := range []string{"hookSpecificOutput", "UserPromptSubmit", "spec/member/repurchase.md"} {
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
	for _, want := range []string{`"session_id": "` + sessionID + `"`, `"selected_template": "templates/member-overview-report.md"`} {
		if !bytes.Contains(data, []byte(want)) {
			t.Fatalf("missing %s in %s", want, string(data))
		}
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
  "selected_playbook": "playbooks/member/default-overview.md",
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
	if state["started_at"] == "" {
		t.Fatalf("missing started_at in %s", string(data))
	}
	if state["selected_playbook"] != "playbooks/business/default-overview.md" {
		t.Fatalf("selected_playbook = %#v", state["selected_playbook"])
	}
	if state["selected_template"] != "templates/business-overview-report.md" {
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
