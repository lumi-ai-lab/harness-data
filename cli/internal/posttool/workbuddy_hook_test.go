package posttool

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"harness-data/cli/internal/sessionstate"
)

func TestRunWorkBuddyHookInjectsNamespacedTemplate(t *testing.T) {
	root := testInjectRoot(t)
	rawSessionID := "report-session"
	sessionID := workBuddySessionPrefix + rawSessionID
	writeInjectState(t, root, sessionID, sessionstate.File{
		SessionID:        sessionID,
		Mode:             sessionstate.ModeSingle,
		SelectedPlaybook: "playbooks/idx/business/s-sale-amt.md",
		SelectedTemplate: "templates/idx/business/s-sale-amt.md",
		Reports:          map[string]*sessionstate.Report{},
	})

	body := workBuddyPosttoolPayload(t, rawSessionID, "Bash", "bin/data-harness-cli stage template")
	ok, output, err := RunWorkBuddyHook(root, body)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !output.Continue {
		t.Fatalf("expected WorkBuddy template output, ok=%v continue=%v", ok, output.Continue)
	}
	if output.HookSpecificOutput.HookEventName != "PostToolUse" ||
		!strings.Contains(output.HookSpecificOutput.AdditionalContext, "销售额模板") {
		t.Fatalf("unexpected output: %+v", output)
	}
	state, err := sessionstate.Load(root, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if !state.TemplateInjected {
		t.Fatalf("expected namespaced state to be updated: %+v", state)
	}
}

func TestRunWorkBuddyHookSupportsWindowsTemplateCommand(t *testing.T) {
	root := testInjectRoot(t)
	rawSessionID := "windows-report-session"
	sessionID := workBuddySessionPrefix + rawSessionID
	writeInjectState(t, root, sessionID, sessionstate.File{
		SessionID:        sessionID,
		Mode:             sessionstate.ModeSingle,
		SelectedPlaybook: "playbooks/idx/business/s-sale-amt.md",
		SelectedTemplate: "templates/idx/business/s-sale-amt.md",
		Reports:          map[string]*sessionstate.Report{},
	})

	command := `& "C:\Harness Runtime\bin\DATA-HARNESS-CLI.EXE" inject-template`
	ok, output, err := RunWorkBuddyHook(root, workBuddyPosttoolPayload(t, rawSessionID, "Bash", command))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !strings.Contains(output.HookSpecificOutput.AdditionalContext, "销售额模板") {
		t.Fatalf("expected Windows command template output, ok=%v output=%+v", ok, output)
	}
}

func TestRunWorkBuddyHookMissingSessionFailsSafely(t *testing.T) {
	root := testInjectRoot(t)
	ok, output, err := RunWorkBuddyHook(root, workBuddyPosttoolPayload(t, "", "Bash", "bin/data-harness-cli inject-template"))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !output.Continue {
		t.Fatalf("expected safe WorkBuddy output, ok=%v continue=%v", ok, output.Continue)
	}
	if !strings.Contains(output.HookSpecificOutput.AdditionalContext, "stable session_id") ||
		!strings.Contains(output.HookSpecificOutput.AdditionalContext, "Do not guess") {
		t.Fatalf("unexpected safety output: %s", output.HookSpecificOutput.AdditionalContext)
	}
	if output.SystemMessage != output.HookSpecificOutput.AdditionalContext {
		t.Fatalf("safety message must also be host-visible: %+v", output)
	}
	if _, err := os.Stat(sessionstate.Path(root, workBuddySessionPrefix)); !os.IsNotExist(err) {
		t.Fatalf("missing session must not write WorkBuddy state, err=%v", err)
	}
}

func TestRunWorkBuddyHookIgnoresNonCanonicalToolsAndCommands(t *testing.T) {
	root := testInjectRoot(t)
	for _, payload := range [][]byte{
		workBuddyPosttoolPayload(t, "session", "execute_command", "bin/data-harness-cli inject-template"),
		workBuddyPosttoolPayload(t, "session", "Bash", "echo hello"),
		workBuddyPosttoolPayload(t, "session", "Bash", "echo bin/data-harness-cli inject-template"),
		workBuddyPosttoolPayload(t, "session", "Bash", `printf '%s' "bin/data-harness-cli stage template"`),
		workBuddyPosttoolPayload(t, "session", "Bash", "echo bin/qdm-metric-cli analysis execute"),
	} {
		ok, output, err := RunWorkBuddyHook(root, payload)
		if err != nil {
			t.Fatal(err)
		}
		if ok || output.HookSpecificOutput.AdditionalContext != "" {
			t.Fatalf("expected silent no-op, ok=%v output=%+v", ok, output)
		}
	}
}

func TestTemplateAndMetricCommandDetectionRespectsShellSyntax(t *testing.T) {
	for _, command := range []string{
		"bin/data-harness-cli inject-template",
		"cd /tmp\nbin/data-harness-cli stage template",
		"if true; then bin/data-harness-cli stage template; fi",
		"env QDM_MODE=test bin/data-harness-cli inject-template",
		`& "C:\Harness Runtime\bin\DATA-HARNESS-CLI.EXE" inject-template`,
	} {
		if !isTemplateInjectionCommand(command) && !isTemplateStageCommand(command) {
			t.Errorf("expected template command to be detected: %q", command)
		}
	}
	for _, command := range []string{
		`echo "audit && bin/data-harness-cli inject-template ignored"`,
		`printf '%s' "note; bin/data-harness-cli stage template"`,
	} {
		if isTemplateInjectionCommand(command) || isTemplateStageCommand(command) {
			t.Errorf("quoted template text must not be detected: %q", command)
		}
	}

	for _, command := range []string{
		`source config/qdm-cli-paths.env && "$QDM_METRIC_CLI" analysis execute`,
		`${QDM_METRIC_CLI:-bin/qdm-metric-cli} analysis execute`,
		`& "C:\QDM Runtime\QDM-METRIC-CLI.EXE" analysis execute`,
	} {
		if !isQDMMetricCommand(command) {
			t.Errorf("expected metric command to be detected: %q", command)
		}
	}
	if isQDMMetricCommand(`echo "audit && bin/qdm-metric-cli analysis execute"`) {
		t.Fatal("quoted metric command text must not be detected")
	}
}

func TestRunWorkBuddyHookMetricResultIsNoopWithoutSession(t *testing.T) {
	root := testInjectRoot(t)
	ok, output, err := RunWorkBuddyHook(root, workBuddyPosttoolPayload(t, "", "Bash", `"$QDM_METRIC_CLI" analysis execute`))
	if err != nil {
		t.Fatal(err)
	}
	if ok || output.HookSpecificOutput.AdditionalContext != "" {
		t.Fatalf("metric PostToolUse must be a silent no-op: ok=%v output=%+v", ok, output)
	}
}

func TestRunWorkBuddyHookMetricResultIsNoopWhenConfigIsInvalid(t *testing.T) {
	root := t.TempDir()
	writeInjectFile(t, root, "config/harness-config.yaml", "invalid: true\n")
	ok, output, err := RunWorkBuddyHook(root, workBuddyPosttoolPayload(t, "metric-config", "Bash", `"$QDM_METRIC_CLI" analysis execute`))
	if err != nil {
		t.Fatal(err)
	}
	if ok || output.HookSpecificOutput.AdditionalContext != "" {
		t.Fatalf("metric PostToolUse must not reload config: ok=%v output=%+v", ok, output)
	}
}

func TestRunWorkBuddyHookDoesNotRejectTemplateForAuthzOn(t *testing.T) {
	root := t.TempDir()
	writeInjectFile(t, root, "config/harness-config.yaml", `paths:
  knowledge: wikis

authz:
  mode: on
`)
	ok, output, err := RunWorkBuddyHook(root, workBuddyPosttoolPayload(t, "authz", "Bash", "bin/data-harness-cli stage template"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.HookSpecificOutput.AdditionalContext, "AUTHZ_UNSUPPORTED") || strings.Contains(output.SystemMessage, "AUTHZ_UNSUPPORTED") {
		t.Fatalf("template PostToolUse must not reject authz.mode=on: ok=%v output=%+v", ok, output)
	}
}

func TestRunWorkBuddyHookAuthzOnMetricResultIsNoop(t *testing.T) {
	root := t.TempDir()
	writeInjectFile(t, root, "config/harness-config.yaml", `paths:
  knowledge: wikis

authz:
  mode: on
`)
	command := `source config/qdm-cli-paths.env && "$QDM_METRIC_CLI" analysis execute --indicator saleAmt`
	ok, output, err := RunWorkBuddyHook(root, workBuddyPosttoolPayload(t, "authz-metric", "Bash", command))
	if err != nil {
		t.Fatal(err)
	}
	if ok || output.HookSpecificOutput.AdditionalContext != "" {
		t.Fatalf("authorized metric result must be a silent no-op: ok=%v output=%+v", ok, output)
	}
}

func TestRunWorkBuddyHookLeavesAuthzOffMetricCommandsUnchanged(t *testing.T) {
	root := testInjectRoot(t)
	ok, output, err := RunWorkBuddyHook(root, workBuddyPosttoolPayload(t, "metric", "Bash", "bin/qdm-metric-cli analysis execute"))
	if err != nil {
		t.Fatal(err)
	}
	if ok || output.HookSpecificOutput.AdditionalContext != "" {
		t.Fatalf("authz-off metric command should remain a silent no-op: ok=%v output=%+v", ok, output)
	}
}

func workBuddyPosttoolPayload(t *testing.T, sessionID, toolName, command string) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"session_id": sessionID,
		"tool_name":  toolName,
		"tool_input": map[string]any{"command": command},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}
