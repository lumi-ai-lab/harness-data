package posttool

import (
	"encoding/json"
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
	if !strings.Contains(message, "QDM_DELIVERY_MODE=chat") || !strings.Contains(message, "Do not write the final result or intermediate analysis result to a file.") {
		t.Fatalf("missing final output contract: %q", message)
	}
	again, outcome, _, err := InjectTemplate(root, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != "template_injected" || again != message {
		t.Fatalf("repeat injection should return same body, outcome=%s body=%q", outcome, again)
	}
}

func TestRunClaudeHookInjectsTemplateAfterStageTemplate(t *testing.T) {
	root := testInjectRoot(t)
	sessionID := "needs-template"
	writeInjectState(t, root, sessionID, sessionstate.File{
		SessionID:        sessionID,
		Mode:             sessionstate.ModeSingle,
		SelectedPlaybook: "playbooks/idx/business/s-sale-amt.md",
		SelectedTemplate: "templates/idx/business/s-sale-amt.md",
		Reports:          map[string]*sessionstate.Report{},
	})
	payload := map[string]any{
		"session_id": sessionID,
		"tool_name":  "Bash",
		"tool_input": map[string]any{
			"command": `bin/data-harness-cli stage template`,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	ok, output, err := RunClaudeHook(root, body)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !strings.Contains(output.HookSpecificOutput.AdditionalContext, "销售额模板") {
		t.Fatalf("expected template hook output, ok=%v output=%q", ok, output.HookSpecificOutput.AdditionalContext)
	}
}

func TestRunClaudeHookInjectsTemplateAfterAuthorizedCodexStageTemplate(t *testing.T) {
	root := testInjectRoot(t)
	sessionID := "codex-authorized-template"
	writeInjectState(t, root, sessionID, sessionstate.File{
		SessionID:        sessionID,
		Mode:             sessionstate.ModeReport,
		SelectedPlaybook: "reports/商品中心经营数据/playbook.md",
		SelectedTemplate: "templates/idx/business/s-sale-amt.md",
		Reports:          map[string]*sessionstate.Report{},
	})
	body, err := json.Marshal(map[string]any{
		"session_id": sessionID,
		"tool_name":  "exec_command",
		"tool_input": map[string]any{
			"command": "unset QDM_CMR_CLI QDM_SQL_CLI QDM_CAS_CLI QDM_CAS_CONFIG_DIR && " +
				"export PATH='/workspace/bin':\"${PATH:-}\" && " +
				"export QDM_METRIC_CLI='/workspace/bin/qdm-metric-cli' && " +
				"export HARNESS_AUTHZ_BINDING_V1='<redacted>' && " +
				"eval 'bin/data-harness-cli stage template'",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, output, err := RunClaudeHook(root, body)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !strings.Contains(output.HookSpecificOutput.AdditionalContext, "销售额模板") {
		t.Fatalf("expected authorized Codex template hook output, ok=%v output=%q", ok, output.HookSpecificOutput.AdditionalContext)
	}
}

func TestRunClaudeHookAcceptsQwenShellTool(t *testing.T) {
	root := testInjectRoot(t)
	sessionID := "qwen-template"
	writeInjectState(t, root, sessionID, sessionstate.File{
		SessionID:        sessionID,
		Mode:             sessionstate.ModeSingle,
		SelectedPlaybook: "playbooks/idx/business/s-sale-amt.md",
		SelectedTemplate: "templates/idx/business/s-sale-amt.md",
		Reports:          map[string]*sessionstate.Report{},
	})
	body, err := json.Marshal(map[string]any{
		"session_id": sessionID,
		"tool_name":  "run_shell_command",
		"tool_input": map[string]any{
			"command": `bin/data-harness-cli stage template`,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, output, err := RunClaudeHook(root, body)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !strings.Contains(output.HookSpecificOutput.AdditionalContext, "销售额模板") {
		t.Fatalf("expected Qwen template hook output, ok=%v output=%q", ok, output.HookSpecificOutput.AdditionalContext)
	}
}

func TestRunClaudeHookDoesNotRequireTemplateInFreeMode(t *testing.T) {
	root := testInjectRoot(t)
	sessionID := "free-data"
	writeInjectState(t, root, sessionID, sessionstate.File{
		SessionID: sessionID,
		Mode:      sessionstate.ModeFree,
		Reports:   map[string]*sessionstate.Report{},
	})
	payload := map[string]any{
		"session_id": sessionID,
		"tool_name":  "Bash",
		"tool_input": map[string]any{
			"command": `qdm-cmr-cli report business indicators --indicator saleAmt --date 2026-05-28`,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	ok, output, err := RunClaudeHook(root, body)
	if err != nil {
		t.Fatal(err)
	}
	if ok || output.HookSpecificOutput.AdditionalContext != "" {
		t.Fatalf("free mode should not require template, ok=%v output=%q", ok, output.HookSpecificOutput.AdditionalContext)
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
		Mode:             sessionstate.ModeSingle,
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
