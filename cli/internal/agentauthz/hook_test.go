package agentauthz

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"harness-data/cli/internal/authz"
)

func TestLocalRuntimeLeavesHooksUnchanged(t *testing.T) {
	root := t.TempDir()
	writeState(t, root, profileLocal, "claude")
	handled, value, err := Run(root, "claude", []byte(`{"hook_event_name":"UserPromptSubmit","session_id":"session-a"}`))
	if err != nil {
		t.Fatal(err)
	}
	if handled || value != nil {
		t.Fatalf("local hook must be a no-op: handled=%v value=%#v", handled, value)
	}
	handled, value, err = Run(root, "claude", nil)
	if err != nil || handled || value != nil {
		t.Fatalf("local empty hook must be a no-op: handled=%v value=%#v err=%v", handled, value, err)
	}
}

func TestLumiHookRejectsWrongAgentAndMissingSession(t *testing.T) {
	root := t.TempDir()
	writeState(t, root, profileLumiRequired, "codex")

	handled, value, err := Run(root, "claude", []byte(`{"hook_event_name":"UserPromptSubmit","session_id":"session-a"}`))
	if err != nil || !handled {
		t.Fatalf("unexpected result: handled=%v err=%v", handled, err)
	}
	assertDecision(t, value, "block")

	handled, value, err = Run(root, "codex", []byte(`{"hook_event_name":"UserPromptSubmit","session_id":""}`))
	if err != nil || !handled {
		t.Fatalf("unexpected result: handled=%v err=%v", handled, err)
	}
	assertDecision(t, value, "block")
}

func TestPreToolIgnoresNonBashAndDeniesMissingBinding(t *testing.T) {
	root := t.TempDir()
	writeState(t, root, profileLumiRequired, "qwen")

	handled, value, err := Run(root, "qwen", []byte(`{
	  "hook_event_name":"PreToolUse",
	  "session_id":"session-a",
	  "tool_name":"Read",
	  "tool_input":{"file_path":"README.md"}
	}`))
	if err != nil || handled || value != nil {
		t.Fatalf("non-Bash hook must be ignored: handled=%v value=%#v err=%v", handled, value, err)
	}

	handled, value, err = Run(root, "qwen", []byte(`{
	  "hook_event_name":"PreToolUse",
	  "session_id":"",
	  "tool_name":"run_shell_command",
	  "tool_input":{"command":"echo ok","timeout":1000}
	}`))
	if err != nil || !handled {
		t.Fatalf("unexpected result: handled=%v err=%v", handled, err)
	}
	data, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	if !strings.Contains(string(data), `"permissionDecision":"deny"`) {
		t.Fatalf("expected fail-closed PreToolUse output: %s", data)
	}
}

func TestAuthorizedCommandPinsFacadeAndPreservesOriginalCommand(t *testing.T) {
	root := "/runtime/with ' quote"
	command := "printf '%s\\n' \"$HARNESS_AUTHZ_BINDING_V1\""
	got := authorizedCommand(root, "binding-value", command)
	for _, expected := range []string{
		"unset QDM_CMR_CLI QDM_SQL_CLI QDM_CAS_CLI QDM_CAS_CONFIG_DIR",
		"export QDM_INDICATORS_CLI='/runtime/with '\\'' quote/bin/qdm-indicators-cli'",
		"export HARNESS_AUTHZ_BINDING_V1='binding-value'",
		"eval " + shellQuote(command),
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("authorized command missing %q:\n%s", expected, got)
		}
	}
}

func TestPromptAndPreToolHooksUseFreshBinding(t *testing.T) {
	root := t.TempDir()
	writeState(t, root, profileLumiRequired, "claude")
	calls := 0
	binder := func(sessionID string) (authz.BindResult, string) {
		calls++
		if sessionID != "acp-session" {
			t.Fatalf("unexpected session ID %q", sessionID)
		}
		return authz.BindResult{
			BindingBase64URL: "binding-value",
			Summary: authz.Summary{
				Channel:           "wecom",
				BotID:             "bot-a",
				CanonicalUserID:   "user-a",
				ManageAreaIDs:     []string{"CN07"},
				CategoryLevel1IDs: []string{"12"},
			},
		}, ""
	}

	handled, promptValue, err := run(root, "claude", []byte(`{
	  "hook_event_name":"UserPromptSubmit",
	  "session_id":"acp-session"
	}`), binder)
	if err != nil || !handled {
		t.Fatalf("prompt result: handled=%v err=%v", handled, err)
	}
	promptJSON, _ := json.Marshal(promptValue)
	if !strings.Contains(string(promptJSON), "Authorized manageAreaIds: CN07") {
		t.Fatalf("prompt summary missing authorization: %s", promptJSON)
	}

	handled, toolValue, err := run(root, "claude", []byte(`{
	  "hook_event_name":"PreToolUse",
	  "session_id":"acp-session",
	  "tool_name":"Bash",
	  "tool_input":{"command":"echo ok","timeout":1000}
	}`), binder)
	if err != nil || !handled {
		t.Fatalf("tool result: handled=%v err=%v", handled, err)
	}
	toolJSON, _ := json.Marshal(toolValue)
	var decoded struct {
		HookSpecificOutput struct {
			PermissionDecision string         `json:"permissionDecision"`
			UpdatedInput       map[string]any `json:"updatedInput"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(toolJSON, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("unexpected tool output: %s", toolJSON)
	}
	if decoded.HookSpecificOutput.UpdatedInput["timeout"] != float64(1000) {
		t.Fatalf("updatedInput did not preserve timeout: %s", toolJSON)
	}
	updatedCommand, _ := decoded.HookSpecificOutput.UpdatedInput["command"].(string)
	if !strings.Contains(updatedCommand, "HARNESS_AUTHZ_BINDING_V1='binding-value'") ||
		!strings.HasSuffix(updatedCommand, "&& eval 'echo ok'") {
		t.Fatalf("updated command is invalid: %s", updatedCommand)
	}
	if calls != 2 {
		t.Fatalf("expected a fresh bind for prompt and tool, got %d calls", calls)
	}
}

func TestPreToolPreservesLargeJSONIntegersExactly(t *testing.T) {
	root := t.TempDir()
	writeState(t, root, profileLumiRequired, "codex")
	binder := func(string) (authz.BindResult, string) {
		return authz.BindResult{BindingBase64URL: "binding-value"}, ""
	}
	handled, value, err := run(root, "codex", []byte(`{
	  "hook_event_name":"PreToolUse",
	  "session_id":"session-a",
	  "tool_name":"Bash",
	  "tool_input":{"command":"echo ok","request_id":9007199254740993}
	}`), binder)
	if err != nil || !handled {
		t.Fatalf("unexpected result: handled=%v err=%v", handled, err)
	}
	result, ok := value.(output)
	if !ok || result.HookSpecificOutput == nil {
		t.Fatalf("unexpected output: %#v", value)
	}
	number, ok := result.HookSpecificOutput.UpdatedInput["request_id"].(json.Number)
	if !ok || number.String() != "9007199254740993" {
		t.Fatalf("large integer was not preserved: %#v", result.HookSpecificOutput.UpdatedInput["request_id"])
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"request_id":9007199254740993`) {
		t.Fatalf("marshaled integer changed: %s", data)
	}
}

func TestMissingOrIncompleteInstallerStateFailsClosed(t *testing.T) {
	for name, prepare := range map[string]func(*testing.T, string){
		"missing": func(*testing.T, string) {},
		"incomplete local": func(t *testing.T, root string) {
			writeRawState(t, root, `{"schemaVersion":3,"profile":"local-unrestricted","agent":"claude"}`)
		},
		"unknown field": func(t *testing.T, root string) {
			writeState(t, root, profileLocal, "claude")
			path := filepath.Join(root, ".harness", "installer-state.json")
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			writeRawState(t, root, strings.TrimSuffix(string(data), "}")+`,"unknown":true}`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			prepare(t, root)
			handled, value, err := Run(root, "claude", []byte(`{"hook_event_name":"UserPromptSubmit","session_id":"session-a"}`))
			if err != nil || !handled {
				t.Fatalf("unexpected result: handled=%v err=%v", handled, err)
			}
			assertDecision(t, value, "block")
		})
	}
}

func TestQwenUsesRuntimeShellToolID(t *testing.T) {
	if !isShellTool("qwen", "run_shell_command") {
		t.Fatal("Qwen runtime shell tool must be protected")
	}
	if isShellTool("claude", "run_shell_command") {
		t.Fatal("Claude must keep its native Bash matcher")
	}
}

func TestAuthorizedCommandDoesNotRunWhenEnvironmentSetupFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Agent hook templates use the runtime's POSIX shell contract")
	}
	marker := filepath.Join(t.TempDir(), "executed")
	script := "readonly QDM_INDICATORS_CLI; " + authorizedCommand(
		"/runtime",
		"binding-value",
		"printf executed > "+shellQuote(marker),
	)
	process := exec.Command("sh", "-c", script)
	process.Env = append(os.Environ(), "QDM_INDICATORS_CLI=/stale/facade")
	if output, err := process.CombinedOutput(); err == nil {
		t.Fatalf("expected environment setup failure, output=%s", output)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("original command ran after setup failure: %v", err)
	}
}

func TestAuthorizedCommandPreservesShellExitAndSanitizesEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Agent hook templates use the runtime's POSIX shell contract")
	}
	command := `printf 'binding=%s\nfacade=%s\nforbidden=%s\n' "$HARNESS_AUTHZ_BINDING_V1" "$QDM_INDICATORS_CLI" "${QDM_CMR_CLI-unset}"; exit 7`
	process := exec.Command("sh", "-c", authorizedCommand("/runtime", "binding-value", command))
	process.Env = append(os.Environ(), "QDM_CMR_CLI=/private/bypass")
	output, err := process.CombinedOutput()
	if err == nil {
		t.Fatal("expected the original command exit code")
	}
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 7 {
		t.Fatalf("unexpected shell failure: %v output=%s", err, output)
	}
	got := string(output)
	for _, expected := range []string{
		"binding=binding-value",
		"facade=/runtime/bin/qdm-indicators-cli",
		"forbidden=unset",
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("shell output missing %q: %s", expected, got)
		}
	}
}

func writeState(t *testing.T, root, profile, agent string) {
	t.Helper()
	releaseSet := any(nil)
	authzConfigPath := ""
	runtimeTag := ""
	if profile == profileLumiRequired {
		releaseSet = map[string]any{"version": "test"}
		authzConfigPath = authz.DefaultConfigPath
		runtimeTag = "v1.0.0"
	}
	tools := map[string]any{}
	if profile == profileLumiRequired {
		tools = map[string]any{
			"data-harness-cli":        map[string]any{},
			"qdm-indicators-facade":   map[string]any{},
			"qdm-indicators-cli-real": map[string]any{},
		}
	}
	data, err := json.Marshal(map[string]any{
		"lastInstallDir":  root,
		"updatedAt":       "2026-07-30T00:00:00Z",
		"schemaVersion":   3,
		"profile":         profile,
		"agent":           agent,
		"installMode":     "github-token",
		"runtimeTag":      runtimeTag,
		"localTools":      map[string]any{},
		"tools":           tools,
		"manifestSha256":  strings.Repeat("a", 64),
		"packageVersion":  "1.0.0",
		"releaseSet":      releaseSet,
		"authzConfigPath": authzConfigPath,
	})
	if err != nil {
		t.Fatal(err)
	}
	writeRawState(t, root, string(data))
}

func writeRawState(t *testing.T, root, content string) {
	t.Helper()
	directory := filepath.Join(root, ".harness")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "installer-state.json"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertDecision(t *testing.T, value any, expected string) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Decision string `json:"decision"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Decision != expected {
		t.Fatalf("decision=%q output=%s", decoded.Decision, data)
	}
}
