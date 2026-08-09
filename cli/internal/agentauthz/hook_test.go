package agentauthz

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHookAuthzOnPreservesToolInputFields(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /abs/bin/qdm-metric-cli

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, testBlob)
	t.Setenv(EnvAuthUserID, "env-user")
	input := []byte(`{
  "session_id": "session-1",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "qdm-metric-cli analysis execute --metric saleAmt",
    "timeout_ms": 10000,
    "large_number": 92233720368547758070,
    "unknown": "kept"
  }
}`)
	ok, output, err := Run(root, "codex", input)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	updated := output.HookSpecificOutput.UpdatedInput
	if updated["command"] != `unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR; '/abs/bin/qdm-metric-cli' analysis execute --metric saleAmt --data-auth --auth-blob 'qdm1enc.testblob'` {
		t.Fatalf("unexpected command: %v", updated["command"])
	}
	if updated["timeout_ms"] != json.Number("10000") {
		t.Fatalf("timeout_ms was not preserved as json.Number: %#v", updated["timeout_ms"])
	}
	if updated["large_number"] != json.Number("92233720368547758070") {
		t.Fatalf("large_number was not preserved as json.Number: %#v", updated["large_number"])
	}
	if updated["unknown"] != "kept" {
		t.Fatalf("unknown field not preserved: %#v", updated["unknown"])
	}
}

func TestHookAuthzOffPassesThroughWithoutMutation(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /abs/bin/qdm-metric-cli

authz:
  mode: off
`)
	t.Setenv(EnvAuthBlob, testBlob)
	t.Setenv(EnvAuthBlobFile, filepath.Join(t.TempDir(), "auth.blob"))
	t.Setenv(EnvAuthUserID, "env-user")

	for _, command := range []string{
		`qdm-metric-cli auth describe`,
		`qdm-metric-cli analysis execute --metric saleAmt`,
		`env | sort`,
	} {
		ok, output, err := Run(root, "codex", hookInput(command))
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			t.Fatalf("authz off must not emit hook output for %q: %+v", command, output)
		}
	}
}

func TestHookAuthzOnLocalBlobInjectsRuntimeBlobDirectly(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-user
  allow_local_blob: true
`)
	if err := os.WriteFile(filepath.Join(root, "config", "dev-auth.blob"), []byte(testBlob+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	ok, output, err := Run(root, "codex", hookInput(`qdm-metric-cli analysis execute --metric saleAmt`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected hook output")
	}
	command := output.HookSpecificOutput.UpdatedInput["command"].(string)
	if output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected allow: %+v", output.HookSpecificOutput)
	}
	if !strings.Contains(command, "--data-auth") || !strings.Contains(command, "--auth-blob '"+testBlob+"'") {
		t.Fatalf("expected direct runtime auth injection: %s", command)
	}
	if !strings.Contains(command, "analysis execute --metric saleAmt") {
		t.Fatalf("expected readable metric command: %s", command)
	}
}

func TestHookAuthzOnDirectInjectionScrubsAuthSourceEnvironment(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, testBlob)
	t.Setenv(EnvAuthUserID, "env-user")

	ok, output, err := Run(root, "codex", hookInput(`qdm-metric-cli auth describe`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected allow output: ok=%v output=%+v", ok, output.HookSpecificOutput)
	}
	command := output.HookSpecificOutput.UpdatedInput["command"].(string)
	if !strings.HasPrefix(command, "unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR; ") {
		t.Fatalf("expected auth source env scrub prefix: %s", command)
	}
	if !strings.Contains(command, "--auth-blob '"+testBlob+"'") {
		t.Fatalf("expected runtime blob injection: %s", command)
	}
}

func TestHookNonGatedBashScrubsAuthSourceEnvironment(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: false
`)
	t.Setenv(EnvAuthBlob, "qdm1enc.env")
	t.Setenv(EnvAuthBlobFile, filepath.Join(t.TempDir(), "auth.blob"))
	t.Setenv(EnvAuthUserID, "env-user")
	t.Setenv(EnvRequesterContextDir, "/tmp/lumi-context")

	ok, output, err := Run(root, "codex", hookInput(`env | sort`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected allow output: ok=%v output=%+v", ok, output.HookSpecificOutput)
	}
	command := output.HookSpecificOutput.UpdatedInput["command"].(string)
	for _, key := range AuthSourceEnvKeys {
		if !strings.Contains(command, key) {
			t.Fatalf("scrubbed command missing %s: %s", key, command)
		}
	}
	if strings.Contains(command, "qdm1enc.env") {
		t.Fatalf("scrubbed command leaked auth source value: %s", command)
	}
	if strings.Contains(command, "/tmp/lumi-context") {
		t.Fatalf("scrubbed command leaked LUMI_REQUESTER_CONTEXT_DIR value: %s", command)
	}
	if !strings.HasSuffix(command, `env | sort`) {
		t.Fatalf("scrubbed command should preserve original command: %s", command)
	}
}

func TestHookNonGatedBashNoopsWithoutAuthSourceEnvironment(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: false
`)

	ok, output, err := Run(root, "codex", hookInput(`pwd`))
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("expected no hook output without auth source env, got %+v", output)
	}
}

func TestHookNonGatedBashScrubsLegacyLumiContextDir(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: false
`)
	t.Setenv(EnvRequesterContextDir, "/tmp/lumi-context")

	ok, output, err := Run(root, "codex", hookInput(`cat /etc/hosts`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected allow output: ok=%v output=%+v", ok, output.HookSpecificOutput)
	}
	command := output.HookSpecificOutput.UpdatedInput["command"].(string)
	if !strings.Contains(command, "unset ") {
		t.Fatalf("expected unset prefix for legacy Lumi env: %s", command)
	}
	if !strings.Contains(command, EnvRequesterContextDir) {
		t.Fatalf("scrubbed command missing %s: %s", EnvRequesterContextDir, command)
	}
	if strings.Contains(command, "/tmp/lumi-context") {
		t.Fatalf("scrubbed command leaked LUMI_REQUESTER_CONTEXT_DIR value: %s", command)
	}
	if !strings.HasSuffix(command, `cat /etc/hosts`) {
		t.Fatalf("scrubbed command should preserve original command: %s", command)
	}
}

func TestHookLocalBlobDisabledDeniesModelSuppliedAuthFlags(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: false
`)
	commands := []string{
		`qdm-metric-cli auth describe --auth-blob "$(cat config/dev-auth.blob)"`,
		`qdm-metric-cli analysis execute --auth-blob "$(cat config/dev-auth.blob)" --metric saleAmt`,
	}
	for _, command := range commands {
		ok, output, err := Run(root, "codex", hookInput(command))
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("expected deny output for %s", command)
		}
		if output.HookSpecificOutput.PermissionDecision != "deny" {
			t.Fatalf("expected deny for %s: %+v", command, output.HookSpecificOutput)
		}
		if !strings.Contains(output.HookSpecificOutput.PermissionDecisionReason, "model-supplied --auth-blob") {
			t.Fatalf("unexpected deny reason: %s", output.HookSpecificOutput.PermissionDecisionReason)
		}
	}
}

func TestHookLocalBlobDisabledDeniesBareGatedCommand(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: false
`)
	commands := []string{
		`qdm-metric-cli analysis execute --metric saleAmt`,
		`qdm-metric-cli auth describe`,
	}
	for _, command := range commands {
		ok, output, err := Run(root, "codex", hookInput(command))
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Fatalf("expected deny output for %s", command)
		}
		if output.HookSpecificOutput.PermissionDecision != "deny" {
			t.Fatalf("expected deny for %s: %+v", command, output.HookSpecificOutput)
		}
		reason := output.HookSpecificOutput.PermissionDecisionReason
		if strings.Contains(reason, "model-supplied --auth-blob") {
			t.Fatalf("bare gated command should not trigger model-supplied deny reason: %s", reason)
		}
		if !strings.Contains(reason, "no encrypted auth blob is bound") {
			t.Fatalf("expected generic no-blob deny reason for %s: %s", command, reason)
		}
	}
}

func TestHookEnvBlobStripsModelAuthFlagsAndInjectsRuntimeBlob(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /abs/bin/qdm-metric-cli

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, "qdm1enc.runtime")
	t.Setenv(EnvAuthUserID, "env-user")

	modelBlob := "qdm1enc.model"
	ok, output, err := Run(root, "codex", hookInput(`qdm-metric-cli analysis execute --auth-json '{"fake":true}' --auth-blob '`+modelBlob+`' --metric saleAmt`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected allow output: ok=%v output=%+v", ok, output.HookSpecificOutput)
	}
	rewritten := output.HookSpecificOutput.UpdatedInput["command"].(string)
	if !strings.Contains(rewritten, "--auth-blob 'qdm1enc.runtime'") {
		t.Fatalf("expected runtime blob injection: %s", rewritten)
	}
	if strings.Contains(rewritten, modelBlob) || strings.Contains(rewritten, "--auth-json") {
		t.Fatalf("expected model auth flags stripped: %s", rewritten)
	}
}

func hookInput(command string) []byte {
	body, _ := json.Marshal(map[string]any{
		"session_id":      "session-1",
		"hook_event_name": "PreToolUse",
		"tool_name":       "Bash",
		"tool_input": map[string]any{
			"command": command,
		},
	})
	return body
}

func writeHarnessConfig(t *testing.T, body string) string {
	t.Helper()
	t.Setenv("QDM_METRIC_CLI", "")
	for _, key := range AuthSourceEnvKeys {
		t.Setenv(key, "")
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "harness-config.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}
