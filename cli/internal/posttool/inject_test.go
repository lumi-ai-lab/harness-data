package posttool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"harness-data/cli/internal/sessionstate"
)

func TestInjectTemplateUsesSelectedTemplateAndStripsFrontmatter(t *testing.T) {
	root := testInjectRoot(t)
	sessionID := "inject-single"
	writeInjectState(t, root, sessionID, sessionstate.File{
		SessionID:        sessionID,
		Mode:             sessionstate.ModeSingle,
		SelectedPlaybook: "playbooks/idx/business/s-sale-amt.md",
		SelectedTemplate: "templates/idx/business/s-sale-amt.md",
		Reports:          map[string]*sessionstate.Report{},
	})
	message, outcome, templateRel, err := InjectTemplate(root, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != "template_injected" || templateRel != "templates/idx/business/s-sale-amt.md" {
		t.Fatalf("unexpected result: outcome=%s template=%s", outcome, templateRel)
	}
	if strings.Contains(message, "---") || !strings.Contains(message, "# 销售额模板") {
		t.Fatalf("unexpected template body: %q", message)
	}
	again, outcome, _, err := InjectTemplate(root, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != "template_injected" || again != message {
		t.Fatalf("repeat injection should return same body, outcome=%s body=%q", outcome, again)
	}
}

func TestInjectTemplateFreeAndMissingStateDoNotGuess(t *testing.T) {
	root := testInjectRoot(t)
	writeInjectState(t, root, "free", sessionstate.File{SessionID: "free", Mode: sessionstate.ModeFree, Reports: map[string]*sessionstate.Report{}})
	message, outcome, _, err := InjectTemplate(root, "free")
	if err != nil {
		t.Fatal(err)
	}
	if outcome != "free_mode_no_template" || !strings.Contains(message, "Do not run inject-template") {
		t.Fatalf("unexpected free response: outcome=%s message=%s", outcome, message)
	}

	message, outcome, _, err = InjectTemplate(root, "missing")
	if err != nil {
		t.Fatal(err)
	}
	if outcome != "missing_session_state" || !strings.Contains(message, "session state missing") {
		t.Fatalf("unexpected missing response: outcome=%s message=%s", outcome, message)
	}
}

func TestInjectTemplateSelectedTemplateMustExist(t *testing.T) {
	root := testInjectRoot(t)
	sessionID := "missing-template"
	writeInjectState(t, root, sessionID, sessionstate.File{
		SessionID:        sessionID,
		Mode:             sessionstate.ModeCombo,
		SelectedPlaybook: "playbooks/idx/business/default-overview.md",
		SelectedTemplate: "templates/idx/business/missing.md",
		Reports:          map[string]*sessionstate.Report{},
	})
	message, outcome, templateRel, err := InjectTemplate(root, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != "template_selection_error" || templateRel != "templates/idx/business/missing.md" || !strings.Contains(message, "missing templates/idx/business/missing.md") {
		t.Fatalf("unexpected missing template response: outcome=%s template=%s message=%s", outcome, templateRel, message)
	}
}

func testInjectRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeInjectFile(t, root, "config/harness-config.yaml", `paths:
  spec: wikis/spec
  routing: wikis/routing
  playbooks: wikis/playbooks
  templates: wikis/templates
`)
	writeInjectFile(t, root, "wikis/templates/idx/business/s-sale-amt.md", `---
name: ignored
---
# 销售额模板

正文
`)
	return root
}

func writeInjectState(t *testing.T, root, sessionID string, state sessionstate.File) {
	t.Helper()
	if err := sessionstate.Save(root, sessionID, state); err != nil {
		t.Fatal(err)
	}
}

func writeInjectFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
