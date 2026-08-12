package agentauthz

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestHookAuthzOnPreservesToolInputFields(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

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
	expectedCommand := `unset HARNESS_AUTH_BLOB HARNESS_AUTH_BLOB_FILE HARNESS_AUTH_USER_ID LUMI_REQUESTER_CONTEXT_DIR; ` + ShellQuote(filepath.Join(root, "bin", "qdm-metric-cli")) + ` analysis execute --metric saleAmt --data-auth --auth-blob 'qdm1enc.testblob'`
	if updated["command"] != expectedCommand {
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

func TestHookSupportsWorkBuddyAndRewritesEveryGatedInvocation(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, "qdm1enc.runtime")
	t.Setenv(EnvAuthUserID, "env-user")
	command := `qdm-metric-cli auth describe --data-auth --auth-blob qdm1enc.model && qdm-metric-cli analysis execute --auth-json fake --metric saleAmt`

	ok, output, err := Run(root, "workbuddy", hookInput(command))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected WorkBuddy allow output: ok=%v output=%+v", ok, output.HookSpecificOutput)
	}
	rewritten := output.HookSpecificOutput.UpdatedInput["command"].(string)
	if strings.Count(rewritten, "--auth-blob 'qdm1enc.runtime'") != 2 || strings.Count(rewritten, "--data-auth") != 1 {
		t.Fatalf("expected both gated invocations to be rewritten: %s", rewritten)
	}
	for _, forbidden := range []string{"qdm1enc.model", "--auth-json"} {
		if strings.Contains(rewritten, forbidden) {
			t.Fatalf("model auth input survived rewrite: %s", rewritten)
		}
	}
}

func TestHookWorkBuddyAuthDescribeReturnsPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("rewritten WorkBuddy auth commands use POSIX shell syntax")
	}
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	metricCLI := filepath.Join(root, "bin", "qdm-metric-cli")
	script := `#!/bin/sh
[ -z "${HARNESS_AUTH_BLOB:-}" ] || exit 8
[ "$1" = "auth" ] || exit 9
[ "$2" = "describe" ] || exit 10
[ "$3" = "--auth-blob" ] || exit 11
[ "$4" = "qdm1enc.runtime" ] || exit 12
printf '{"user":"env-user","permissions":["sales:read"]}\n'
`
	if err := os.WriteFile(metricCLI, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvAuthBlob, "qdm1enc.runtime")
	t.Setenv(EnvAuthUserID, "env-user")

	ok, output, err := Run(root, "workbuddy", hookInput(`qdm-metric-cli auth describe`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected WorkBuddy auth describe allow output: ok=%v output=%+v", ok, output.HookSpecificOutput)
	}
	rewritten := output.HookSpecificOutput.UpdatedInput["command"].(string)
	result, err := exec.Command("/bin/sh", "-c", rewritten).Output()
	if err != nil {
		t.Fatalf("rewritten auth describe failed: %v", err)
	}
	var permissions struct {
		User        string   `json:"user"`
		Permissions []string `json:"permissions"`
	}
	if err := json.Unmarshal(result, &permissions); err != nil {
		t.Fatalf("invalid auth describe output %q: %v", result, err)
	}
	if permissions.User != "env-user" || len(permissions.Permissions) != 1 || permissions.Permissions[0] != "sales:read" {
		t.Fatalf("unexpected auth describe permissions: %+v", permissions)
	}
}

func TestHookDeniesWhenMetricCLIIsMissing(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	if err := os.Remove(filepath.Join(root, "bin", "qdm-metric-cli")); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvAuthBlob, testBlob)
	t.Setenv(EnvAuthUserID, "env-user")

	ok, output, err := Run(root, "workbuddy", hookInput(`qdm-metric-cli auth describe`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "deny" ||
		!strings.Contains(output.HookSpecificOutput.PermissionDecisionReason, "trusted qdm-metric-cli") {
		t.Fatalf("expected missing CLI denial: ok=%v output=%+v", ok, output.HookSpecificOutput)
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
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "qdm-metric-cli"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}
