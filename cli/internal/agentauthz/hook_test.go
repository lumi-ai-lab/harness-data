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
	"shell": "bash",
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

func TestWorkBuddyBashHookRewritesBackslashEscapedModelAuthFlags(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /trusted/bin/qdm-metric-cli

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, "qdm1enc.runtime")
	t.Setenv(EnvAuthUserID, "workbuddy-user")
	command := `./original/qdm-metric-cli.exe auth describe \--data-auth \--auth-blob 'qdm1enc.model-supplied' \--auth-json '{"fake":true}'`
	ok, output, err := Run(root, "workbuddy", hookInput(command))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected safe rewrite allow: ok=%v output=%+v", ok, output)
	}
	rewritten, _ := output.HookSpecificOutput.UpdatedInput["command"].(string)
	for _, forbidden := range []string{"./original/qdm-metric-cli.exe", "qdm1enc.model-supplied", `\--`, "--auth-json", "--data-auth"} {
		if strings.Contains(rewritten, forbidden) {
			t.Fatalf("rewritten command retained %q: %s", forbidden, rewritten)
		}
	}
	if strings.Count(rewritten, "--auth-blob") != 1 || !strings.Contains(rewritten, "--auth-blob 'qdm1enc.runtime'") {
		t.Fatalf("expected exactly one runtime blob: %s", rewritten)
	}
}

func TestWorkBuddyBashHookDeniesMalformedEscapedAuthFlag(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /trusted/bin/qdm-metric-cli

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, "qdm1enc.runtime")
	t.Setenv(EnvAuthUserID, "workbuddy-user")
	ok, output, err := Run(root, "workbuddy", hookInput(`./original/qdm-metric-cli.exe auth describe \--auth-blob`))
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "deny" ||
		!strings.Contains(output.HookSpecificOutput.PermissionDecisionReason, "QDM_AUTHZ_REWRITE_FAILED") {
		t.Fatalf("expected rewrite failure deny: ok=%v output=%+v", ok, output)
	}
	if output.HookSpecificOutput.UpdatedInput != nil {
		t.Fatalf("deny must not return updatedInput: %#v", output.HookSpecificOutput.UpdatedInput)
	}
}

func TestWorkBuddyPowerShellHookDeniesGatedCommandBeforeResolvingAuthorization(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

cli:
  qdm_metric_cli: C:\Harness Runtime\bin\qdm-metric-cli.exe

authz:
  mode: on
  allow_local_blob: true
`)
	input, err := json.Marshal(map[string]any{
		"session_id":      "workbuddy-session",
		"hook_event_name": "PreToolUse",
		"tool_name":       "PowerShell",
		"tool_input": map[string]any{
			"command":    `& '.\bin\qdm-metric-cli.exe' analysis execute --metric saleAmt`,
			"timeout_ms": 10000,
			"unknown":    "kept",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "deny" {
		t.Fatalf("expected WorkBuddy PowerShell deny output: ok=%v output=%+v", ok, output)
	}
	if reason := output.HookSpecificOutput.PermissionDecisionReason; !strings.Contains(reason, "QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED") || !strings.Contains(reason, "Bash tool") {
		t.Fatalf("unexpected WorkBuddy PowerShell deny reason: %s", reason)
	}
	if output.HookSpecificOutput.UpdatedInput != nil {
		t.Fatalf("deny must not return updatedInput: %#v", output.HookSpecificOutput.UpdatedInput)
	}
}

func TestWorkBuddyPowerShellHookDeniesOutputCaptureAssignment(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	command := `$out = & '.\original\qdm-metric-cli.exe' auth describe 2>&1; $code = $LASTEXITCODE; Write-Output "=== STDOUT+STDERR ==="; $out | Out-String; Write-Output "=== EXIT CODE ==="; $code`
	input, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "PowerShell",
		"tool_input": map[string]any{
			"command":     command,
			"description": "capture qdm output",
		},
	})
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "deny" ||
		!strings.Contains(output.HookSpecificOutput.PermissionDecisionReason, "QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED") {
		t.Fatalf("expected unsupported WorkBuddy PowerShell host deny: ok=%v output=%+v", ok, output)
	}
	if output.HookSpecificOutput.UpdatedInput != nil {
		t.Fatalf("deny must not return updatedInput: %#v", output.HookSpecificOutput.UpdatedInput)
	}
}

func TestWorkBuddyExecuteCommandPowerShellExecutorDeniesGatedCommand(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	input, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "execute_command",
		"tool_input": map[string]any{
			"command":  `.\original\qdm-metric-cli.exe auth describe`,
			"executor": "pwsh.exe",
		},
	})
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "deny" ||
		!strings.Contains(output.HookSpecificOutput.PermissionDecisionReason, "QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED") {
		t.Fatalf("expected execute_command PowerShell host deny: ok=%v output=%+v", ok, output)
	}
	if output.HookSpecificOutput.UpdatedInput != nil {
		t.Fatalf("deny must not return updatedInput: %#v", output.HookSpecificOutput.UpdatedInput)
	}
}

func TestWorkBuddyBashHookRewritesRelativeSubdirectoryWithDirectAuthorization(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, testBlob)
	t.Setenv(EnvAuthUserID, "workbuddy-user")
	input, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "Bash",
		"tool_input": map[string]any{
			"command":     `./original/qdm-metric-cli.exe auth describe --auth-blob qdm1enc.model --resolve-labels=false`,
			"description": "describe effective authorization",
		},
	})
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" {
		t.Fatalf("expected WorkBuddy Bash allow output: ok=%v output=%+v", ok, output)
	}
	updated := output.HookSpecificOutput.UpdatedInput
	rewritten, _ := updated["command"].(string)
	if !strings.Contains(rewritten, "auth describe --resolve-labels=false --auth-blob '"+testBlob+"'") {
		t.Fatalf("relative-subdirectory invocation was not directly authorized: %s", rewritten)
	}
	for _, secret := range []string{"qdm1enc.model"} {
		if strings.Contains(rewritten, secret) {
			t.Fatalf("direct rewrite retained model authorization %q: %s", secret, rewritten)
		}
	}
	if updated["description"] != "describe effective authorization" {
		t.Fatalf("non-command tool input was not preserved: %#v", updated)
	}
}

func TestWorkBuddyPowerShellHookDeniesUnrecognizedGatedShapeDeterministically(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, testBlob)
	t.Setenv(EnvAuthUserID, "workbuddy-user")
	input, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "PowerShell",
		"tool_input": map[string]any{
			"command": `$out = (& '.\original\qdm-metric-cli.exe' auth describe)`,
		},
	})
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "deny" ||
		!strings.Contains(output.HookSpecificOutput.PermissionDecisionReason, "QDM_AUTHZ_COMMAND_UNSUPPORTED") {
		t.Fatalf("expected deterministic unsupported-command deny: ok=%v output=%+v", ok, output)
	}
}

func TestWorkBuddyPowerShellHookDeniesMultipleGatedInvocations(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, testBlob)
	t.Setenv(EnvAuthUserID, "workbuddy-user")
	input, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "PowerShell",
		"tool_input": map[string]any{
			"command": `qdm-metric-cli.exe auth describe; qdm-metric-cli.exe analysis execute --metric saleAmt`,
		},
	})
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || output.HookSpecificOutput.PermissionDecision != "deny" ||
		!strings.Contains(output.HookSpecificOutput.PermissionDecisionReason, "QDM_AUTHZ_COMMAND_AMBIGUOUS") {
		t.Fatalf("expected ambiguous multi-command deny: ok=%v output=%+v", ok, output)
	}
}

func TestWorkBuddyPowerShellNonGatedCommandScrubsAuthEnvironment(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	t.Setenv(EnvAuthBlob, testBlob)
	t.Setenv(EnvAuthUserID, "workbuddy-user")
	input, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "PowerShell",
		"tool_input":      map[string]any{"command": `Get-ChildItem Env:`},
	})
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	command, _ := output.HookSpecificOutput.UpdatedInput["command"].(string)
	if !ok || output.HookSpecificOutput.PermissionDecision != "allow" ||
		!strings.HasPrefix(command, "Remove-Item Env:HARNESS_AUTH_BLOB") || strings.Contains(command, testBlob) {
		t.Fatalf("expected sanitized PowerShell command: ok=%v output=%+v", ok, output)
	}
}

func TestWorkBuddyDenyReasonDoesNotLeakBlobPath(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  blob_file: private/secret-user-auth.blob
  dev_user_id: workbuddy-user
  allow_local_blob: true
`)
	input, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "PowerShell",
		"tool_input":      map[string]any{"command": `.\bin\qdm-metric-cli.exe auth describe`},
	})
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	reason := output.HookSpecificOutput.PermissionDecisionReason
	if !ok || output.HookSpecificOutput.PermissionDecision != "deny" ||
		strings.Contains(reason, "secret-user-auth.blob") || strings.Contains(reason, root) {
		t.Fatalf("deny reason leaked a path: ok=%v reason=%s", ok, reason)
	}
}

func TestResolveDialectRequiresExplicitExecuteCommandExecutor(t *testing.T) {
	tests := []struct {
		name     string
		tool     string
		input    map[string]any
		want     CommandDialect
		accepted bool
	}{
		{name: "bash tool", tool: "Bash", input: map[string]any{}, want: DialectBash, accepted: true},
		{name: "powershell tool", tool: "PowerShell", input: map[string]any{}, want: DialectPowerShell, accepted: true},
		{name: "execute without hint", tool: "execute_command", input: map[string]any{}, want: "", accepted: true},
		{name: "execute powershell", tool: "execute_command", input: map[string]any{"executor": "pwsh.exe"}, want: DialectPowerShell, accepted: true},
		{name: "execute bash", tool: "execute_command", input: map[string]any{"shell_name": "git-bash"}, want: DialectBash, accepted: true},
		{name: "execute cmd", tool: "execute_command", input: map[string]any{"shell": "cmd.exe"}, want: "", accepted: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, accepted := resolveDialect("workbuddy", tt.tool, tt.input)
			if got != tt.want || accepted != tt.accepted {
				t.Fatalf("resolveDialect() = (%q, %v), want (%q, %v)", got, accepted, tt.want, tt.accepted)
			}
		})
	}
}

func TestWorkBuddyExecuteCommandWithoutExecutorFailsClosedForPotentialGatedCommands(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	commands := []string{
		`qdm-metric-cli.exe analysis execute --metric saleAmt`,
		`%QDM_METRIC_CLI% auth describe`,
		`$env:QDM_METRIC_CLI analysis execute --metric saleAmt`,
	}
	for _, command := range commands {
		input, _ := json.Marshal(map[string]any{
			"hook_event_name": "PreToolUse",
			"tool_name":       "execute_command",
			"tool_input":      map[string]any{"command": command},
		})
		ok, output, err := Run(root, "workbuddy", input)
		if err != nil {
			t.Fatal(err)
		}
		if !ok || output.HookSpecificOutput.PermissionDecision != "deny" ||
			!strings.Contains(output.HookSpecificOutput.PermissionDecisionReason, "QDM_AUTHZ_DIALECT_UNSUPPORTED") {
			t.Fatalf("expected unsupported dialect deny for %q: ok=%v output=%+v", command, ok, output)
		}
	}
}

func TestWorkBuddyExecuteCommandWithoutExecutorLeavesOrdinaryCommandAlone(t *testing.T) {
	root := writeHarnessConfig(t, `paths:
  knowledge: wikis

authz:
  mode: on
  allow_local_blob: true
`)
	input, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse",
		"tool_name":       "execute_command",
		"tool_input":      map[string]any{"command": "whoami"},
	})
	ok, output, err := Run(root, "workbuddy", input)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("ordinary command should be a no-op, got %+v", output)
	}
}

func hookInput(command string) []byte {
	body, _ := json.Marshal(map[string]any{
		"session_id":      "session-1",
		"hook_event_name": "PreToolUse",
		"tool_name":       "Bash",
		"tool_input": map[string]any{
			"command": command,
			"shell":   "bash",
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
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "harness-config.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}
