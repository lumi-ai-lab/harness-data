package tests

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	dhcontext "harness-data/cli/internal/context"
	"harness-data/cli/internal/sessionstate"
)

func TestWorkBuddyContextUsesNamespacedSessionAndEnvelope(t *testing.T) {
	root := currentRootWithIndex(t)
	rawSessionID := "workbuddy-context-session"
	sessionID := "workbuddy:" + rawSessionID
	statePath := sessionstate.Path(root, sessionID)
	if err := os.Remove(statePath); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(statePath) })

	payload, err := json.Marshal(map[string]any{
		"session_id":      rawSessionID,
		"prompt":          "销售额最近怎么样？",
		"cwd":             root,
		"hook_event_name": "UserPromptSubmit",
		"unknown_field":   "ignored",
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, output, err := dhcontext.RunWorkBuddyHook(root, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !output.Continue {
		t.Fatalf("expected WorkBuddy output, ok=%v continue=%v", ok, output.Continue)
	}
	if output.HookSpecificOutput.HookEventName != "UserPromptSubmit" {
		t.Fatalf("event = %q", output.HookSpecificOutput.HookEventName)
	}
	if !strings.Contains(output.HookSpecificOutput.AdditionalContext, "# Data Harness Context") {
		t.Fatalf("missing Harness context: %s", output.HookSpecificOutput.AdditionalContext)
	}
	if _, err := os.Stat(statePath); err != nil {
		t.Fatalf("expected namespaced state %s: %v", statePath, err)
	}
	state, err := sessionstate.Load(root, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if state.SessionID != sessionID {
		t.Fatalf("session id = %q", state.SessionID)
	}
}

func TestWorkBuddyContextMissingSessionFailsSafelyWithoutState(t *testing.T) {
	root := t.TempDir()
	payload := []byte(`{"prompt":"销售额最近怎么样？"}`)
	ok, output, err := dhcontext.RunWorkBuddyHook(root, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || !output.Continue {
		t.Fatalf("expected safe WorkBuddy output, ok=%v continue=%v", ok, output.Continue)
	}
	if !strings.Contains(output.HookSpecificOutput.AdditionalContext, "stable session_id") ||
		!strings.Contains(output.HookSpecificOutput.AdditionalContext, "Do not run qdm-metric-cli") {
		t.Fatalf("unexpected safety context: %s", output.HookSpecificOutput.AdditionalContext)
	}
	if output.SystemMessage != output.HookSpecificOutput.AdditionalContext {
		t.Fatalf("safety message must also be host-visible: %+v", output)
	}
	if _, err := os.Stat(sessionstate.Dir(root)); !os.IsNotExist(err) {
		t.Fatalf("missing session must not create state, err=%v", err)
	}
}

func TestWorkBuddyContextReportsAuthzMode(t *testing.T) {
	sourceRoot := currentRootWithIndex(t)
	for _, mode := range []string{"on", "off"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			copyWorkBuddyTestTree(t, filepath.Join(sourceRoot, "wikis"), filepath.Join(root, "wikis"))
			copyWorkBuddyTestTree(t, filepath.Join(sourceRoot, ".harness", "index"), filepath.Join(root, ".harness", "index"))
			config := "paths:\n  knowledge: wikis\n\nauthz:\n  mode: " + mode + "\n"
			writeWorkBuddyTestFile(t, root, "config/harness-config.yaml", config)
			payload := []byte(`{"session_id":"authz-session","prompt":"销售额是多少？"}`)
			ok, output, err := dhcontext.RunWorkBuddyHook(root, payload)
			if err != nil {
				t.Fatal(err)
			}
			if !ok || !output.Continue {
				t.Fatalf("expected WorkBuddy context, ok=%v continue=%v", ok, output.Continue)
			}
			context := output.HookSpecificOutput.AdditionalContext
			if !strings.Contains(context, "# Data Harness Context") ||
				!strings.Contains(context, "authzMode: "+mode) || strings.Contains(context, "AUTHZ_UNSUPPORTED") {
				t.Fatalf("unexpected authz context: %s", context)
			}
			if _, err := os.Stat(sessionstate.Path(root, "workbuddy:authz-session")); err != nil {
				t.Fatalf("context must keep namespaced session state: %v", err)
			}
		})
	}
}

func copyWorkBuddyTestTree(t *testing.T, source, target string) {
	t.Helper()
	err := filepath.WalkDir(source, func(pathname string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, pathname)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, rel)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		data, err := os.ReadFile(pathname)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestGenericHarnessContextIsAgentNeutral(t *testing.T) {
	response, err := dhcontext.Build(currentRootWithIndex(t), "销售额最近怎么样？")
	if err != nil {
		t.Fatal(err)
	}
	text := response.Instruction + "\n" + strings.Join(response.Constraints, "\n")
	for _, unwanted := range []string{"PI hook", "Pi hook", "encrypted auth-blob", "auth describe"} {
		if strings.Contains(text, unwanted) {
			t.Fatalf("generic context contains host-specific auth guidance %q: %s", unwanted, text)
		}
	}
}

func writeWorkBuddyTestFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
