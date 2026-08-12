package agentauthz

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"harness-data/cli/internal/harness"
)

type HookOutput struct {
	HookSpecificOutput HookSpecificOutput `json:"hookSpecificOutput"`
}

type HookSpecificOutput struct {
	HookEventName            string         `json:"hookEventName"`
	PermissionDecision       string         `json:"permissionDecision"`
	PermissionDecisionReason string         `json:"permissionDecisionReason,omitempty"`
	UpdatedInput             map[string]any `json:"updatedInput,omitempty"`
}

type HookPayload struct {
	HookEventName string
	ToolName      string
	ToolInput     map[string]any
}

type CommandDialect string

const (
	DialectBash       CommandDialect = "bash"
	DialectPowerShell CommandDialect = "powershell"
)

func ReadHookStdin() ([]byte, error) {
	return io.ReadAll(os.Stdin)
}

func Run(root string, agent string, input []byte) (bool, HookOutput, error) {
	payload, ok := parseHookPayload(input)
	if !ok {
		return false, HookOutput{}, nil
	}
	dialect, accepted := resolveDialect(agent, payload.ToolName, payload.ToolInput)
	if !accepted {
		return false, HookOutput{}, fmt.Errorf("unsupported authz agent: %s", agent)
	}
	if payload.HookEventName != "" && payload.HookEventName != "PreToolUse" {
		return false, HookOutput{}, nil
	}
	command, ok := payload.ToolInput["command"].(string)
	if !ok || strings.TrimSpace(command) == "" {
		return false, HookOutput{}, nil
	}

	cfg, err := harness.LoadConfig(root)
	if err != nil {
		return false, HookOutput{}, err
	}
	if !cfg.Authz.AuthzEnabled() {
		return false, HookOutput{}, nil
	}
	if dialect == "" {
		if AuthSourceEnvPresent(nil) || looksLikeGatedMetricCommand(command) {
			return true, denyOutput("QDM_AUTHZ_DIALECT_UNSUPPORTED: the command executor cannot be authorized safely"), nil
		}
		return false, HookOutput{}, nil
	}

	if !isMetricAuthzGatedCommand(dialect, command) {
		if looksLikeGatedMetricCommand(command) {
			return true, denyOutput("QDM_AUTHZ_COMMAND_UNSUPPORTED: the QDM data command shape cannot be authorized safely"), nil
		}
		if AuthSourceEnvPresent(nil) {
			return true, allowOutput(replaceCommand(payload.ToolInput, scrubAuthSourceEnvCommand(dialect, command)), "Auth source environment scrubbed for non-gated shell command"), nil
		}
		return false, HookOutput{}, nil
	}
	if metricInvocationCount(dialect, command) != 1 {
		return true, denyOutput("QDM_AUTHZ_COMMAND_AMBIGUOUS: split multiple or ambiguous QDM data invocations into separate tool calls"), nil
	}
	if strings.EqualFold(strings.TrimSpace(agent), "workbuddy") && dialect == DialectPowerShell {
		return true, denyOutput("QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED: Windows WorkBuddy PowerShell sandbox cannot return command output reliably; retry with the Bash tool"), nil
	}

	resolved, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: root,
		Config:      cfg.Authz,
	})
	if err != nil {
		return true, denyOutput(missingAuthReason(dialect, command, cfg.Authz, err)), nil
	}

	metricCliPath := ResolveMetricCLIPath(root, cfg)
	rewritten := injectAuthForCommand(dialect, command, resolved.Blob, metricCliPath)
	if AuthSourceEnvPresent(nil) {
		rewritten = scrubAuthSourceEnvCommand(dialect, rewritten)
	}
	return true, allowOutput(replaceCommand(payload.ToolInput, rewritten), "Configured authorization is bound to this QDM data command"), nil
}

func resolveDialect(agent, toolName string, toolInput map[string]any) (CommandDialect, bool) {
	agent = strings.ToLower(strings.TrimSpace(agent))
	tool := strings.ToLower(strings.TrimSpace(toolName))
	if agent != "codex" && agent != "workbuddy" {
		return "", false
	}
	if agent == "codex" && tool != "bash" {
		return "", true
	}
	if agent == "workbuddy" && tool != "bash" && tool != "powershell" && tool != "execute_command" {
		return "", true
	}
	if tool == "powershell" {
		return DialectPowerShell, true
	}
	for _, key := range []string{"shell", "shell_name", "executor"} {
		value, _ := toolInput[key].(string)
		value = strings.ToLower(strings.TrimSpace(value))
		switch {
		case strings.Contains(value, "powershell"), strings.Contains(value, "pwsh"):
			return DialectPowerShell, true
		case value == "bash", value == "sh", strings.Contains(value, "git-bash"):
			return DialectBash, true
		case value == "cmd", strings.Contains(value, "cmd.exe"):
			return "", true
		}
	}
	if tool == "bash" {
		return DialectBash, true
	}
	// execute_command is host-defined. Without an explicit executor hint it is
	// unsafe to infer PowerShell merely because the hook binary runs on Windows.
	return "", true
}

func isMetricAuthzGatedCommand(dialect CommandDialect, command string) bool {
	if dialect == DialectPowerShell {
		return IsPowerShellMetricAuthzGatedCommand(command)
	}
	return IsMetricAuthzGatedCommand(command)
}

func metricInvocationCount(dialect CommandDialect, command string) int {
	if dialect == DialectPowerShell {
		return PowerShellMetricInvocationCount(command)
	}
	return MetricInvocationCount(command)
}

func scrubAuthSourceEnvCommand(dialect CommandDialect, command string) string {
	if dialect == DialectPowerShell {
		return ScrubAuthSourceEnvPowerShellCommand(command)
	}
	return ScrubAuthSourceEnvCommand(command)
}

func parseHookPayload(input []byte) (HookPayload, bool) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	var raw map[string]any
	if err := decoder.Decode(&raw); err != nil {
		return HookPayload{}, false
	}
	toolInput, _ := raw["tool_input"].(map[string]any)
	return HookPayload{
		HookEventName: stringField(raw, "hook_event_name"),
		ToolName:      stringField(raw, "tool_name"),
		ToolInput:     toolInput,
	}, true
}

func stringField(raw map[string]any, key string) string {
	value, _ := raw[key].(string)
	return value
}

func allowOutput(updated map[string]any, reason string) HookOutput {
	return HookOutput{HookSpecificOutput: HookSpecificOutput{
		HookEventName:            "PreToolUse",
		PermissionDecision:       "allow",
		PermissionDecisionReason: reason,
		UpdatedInput:             updated,
	}}
}

func denyOutput(reason string) HookOutput {
	return HookOutput{HookSpecificOutput: HookSpecificOutput{
		HookEventName:            "PreToolUse",
		PermissionDecision:       "deny",
		PermissionDecisionReason: reason,
	}}
}

func replaceCommand(input map[string]any, command string) map[string]any {
	out := make(map[string]any, len(input)+1)
	for key, value := range input {
		out[key] = value
	}
	out["command"] = command
	return out
}

func missingAuthReason(dialect CommandDialect, command string, cfg harness.AuthzConfig, _ error) string {
	hasModelFlags := CommandHasModelAuthFlags(command)
	if dialect == DialectPowerShell {
		hasModelFlags = PowerShellCommandHasModelAuthFlags(command)
	}
	if !cfg.LocalBlobAllowed() && hasModelFlags {
		return "QDM_AUTHZ_SOURCE_MISSING: refusing model-supplied --auth-blob or related authorization flags while local authorization is disabled"
	}
	isDescribe := IsMetricAuthDescribe(command)
	if dialect == DialectPowerShell {
		isDescribe = IsPowerShellMetricAuthDescribe(command)
	}
	if isDescribe {
		return "QDM_AUTHZ_SOURCE_MISSING: authz mode is on but no encrypted auth blob is bound with an explicit user ID; cannot run qdm-metric-cli auth describe"
	}
	return "QDM_AUTHZ_SOURCE_MISSING: authz mode is on but no encrypted auth blob is bound with an explicit user ID; cannot run qdm-metric-cli analysis execute"
}

func injectAuthForCommand(dialect CommandDialect, command, blob, metricCliPath string) string {
	if dialect == DialectPowerShell {
		if IsPowerShellMetricAuthDescribe(command) {
			return InjectPowerShellAuthDescribeBlob(command, blob, metricCliPath)
		}
		return InjectPowerShellDataAuth(command, blob, metricCliPath)
	}
	if IsMetricAuthDescribe(command) {
		return InjectAuthDescribeBlob(command, blob, metricCliPath)
	}
	return InjectDataAuth(command, blob, metricCliPath)
}

func ResolveMetricCLIPath(root string, cfg harness.Config) string {
	candidates := []string{}
	if envPath := strings.TrimSpace(os.Getenv("QDM_METRIC_CLI")); envPath != "" {
		candidates = append(candidates, envPath)
	}
	if cfg.CLI.QDMMetricCLI != "" {
		candidates = append(candidates, resolveProjectPath(root, cfg.CLI.QDMMetricCLI))
	}
	if runtime.GOOS == "windows" {
		candidates = append(candidates, filepath.Join(root, "bin", "qdm-metric-cli.exe"))
	}
	candidates = append(candidates, filepath.Join(root, "bin", "qdm-metric-cli"))
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return candidates[0]
}

func resolveProjectPath(root, value string) string {
	if filepath.IsAbs(value) || strings.HasPrefix(value, "/") {
		return value
	}
	return filepath.Join(root, filepath.FromSlash(value))
}
