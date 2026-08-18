package agentauthz

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
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

const AdapterEnvelopeSchemaVersion = 1

const (
	AdapterStatusDisabled = "disabled"
	AdapterStatusNoop     = "noop"
	AdapterStatusAllow    = "allow"
	AdapterStatusDeny     = "deny"
)

// AdapterEnvelope makes the Go authorization decision explicit for the
// WorkBuddy transport adapter.
type AdapterEnvelope struct {
	SchemaVersion int    `json:"schemaVersion"`
	Status        string `json:"status"`
	HookOutput    any    `json:"hookOutput"`
}

func ReadHookStdin() ([]byte, error) {
	return io.ReadAll(os.Stdin)
}

func Run(root string, agent string, input []byte) (bool, HookOutput, error) {
	cfg, err := harness.LoadConfig(root)
	if err != nil {
		return false, HookOutput{}, err
	}
	if !cfg.Authz.AuthzEnabled() {
		return false, HookOutput{}, nil
	}
	return runEnabled(cfg, root, agent, input, false)
}

// RunAdapterEnvelope evaluates a WorkBuddy authorization hook with Go as the
// sole source of configuration and business semantics.
func RunAdapterEnvelope(root string, agent string, input []byte) (AdapterEnvelope, error) {
	cfg, err := harness.LoadConfig(root)
	if err != nil {
		return AdapterEnvelope{}, err
	}
	if !cfg.Authz.AuthzEnabled() {
		return adapterEnvelope(AdapterStatusDisabled, map[string]any{}), nil
	}
	ok, output, err := runEnabled(cfg, root, agent, input, true)
	if err != nil {
		return AdapterEnvelope{}, err
	}
	if !ok {
		return adapterEnvelope(AdapterStatusNoop, map[string]any{}), nil
	}
	var status string
	switch output.HookSpecificOutput.PermissionDecision {
	case "allow":
		status = AdapterStatusAllow
	case "deny":
		status = AdapterStatusDeny
	default:
		return AdapterEnvelope{}, fmt.Errorf("unsupported authorization decision: %q", output.HookSpecificOutput.PermissionDecision)
	}
	return adapterEnvelope(status, output), nil
}

func adapterEnvelope(status string, output any) AdapterEnvelope {
	return AdapterEnvelope{SchemaVersion: AdapterEnvelopeSchemaVersion, Status: status, HookOutput: output}
}

func runEnabled(cfg harness.Config, root string, agent string, input []byte, strictInput bool) (bool, HookOutput, error) {
	payload, ok := parseHookPayload(input)
	if !ok {
		if !strictInput {
			return false, HookOutput{}, nil
		}
		return true, denyOutput("QDM_AUTHZ_INPUT_INVALID: WorkBuddy provided invalid PreToolUse JSON"), nil
	}
	toolName := strings.ToLower(strings.TrimSpace(payload.ToolName))
	if strings.EqualFold(strings.TrimSpace(agent), "workbuddy") && toolName != "" &&
		toolName != "bash" && toolName != "powershell" && toolName != "execute_command" {
		return false, HookOutput{}, nil
	}
	dialect, accepted := resolveDialect(agent, payload.ToolName, payload.ToolInput)
	if !accepted {
		return false, HookOutput{}, fmt.Errorf("unsupported authz agent: %s", agent)
	}
	if payload.HookEventName != "" && payload.HookEventName != "PreToolUse" {
		if !strictInput {
			return false, HookOutput{}, nil
		}
		return true, denyOutput("QDM_AUTHZ_INPUT_INVALID: WorkBuddy provided an invalid PreToolUse event"), nil
	}
	command, ok := payload.ToolInput["command"].(string)
	if !ok || strings.TrimSpace(command) == "" {
		if !strictInput {
			return false, HookOutput{}, nil
		}
		return true, denyOutput("QDM_AUTHZ_INPUT_INVALID: WorkBuddy provided an incomplete PreToolUse payload"), nil
	}
	if dialect == "" {
		if AuthSourceEnvPresent(nil) || looksLikeGatedMetricCommand(command) {
			return true, denyOutput("QDM_AUTHZ_DIALECT_UNSUPPORTED: the command executor cannot be authorized safely"), nil
		}
		return false, HookOutput{}, nil
	}

	if !isMetricAuthzGatedCommand(dialect, command) {
		if looksLikeGatedMetricCommand(command) {
			if strings.EqualFold(strings.TrimSpace(agent), "workbuddy") && dialect == ShellPowerShell {
				return true, denyOutput("QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED: Windows WorkBuddy PowerShell sandbox cannot return command output reliably; retry with the Bash tool"), nil
			}
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
	if strings.EqualFold(strings.TrimSpace(agent), "workbuddy") && dialect == ShellPowerShell {
		return true, denyOutput("QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED: Windows WorkBuddy PowerShell sandbox cannot return command output reliably; retry with the Bash tool"), nil
	}

	resolved, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: root,
		Config:      cfg.Authz,
	})
	if err != nil {
		return true, denyOutput(missingAuthReason(dialect, command, cfg.Authz, err)), nil
	}

	metricCliPath, err := ResolveMetricCLIPath(root, cfg)
	if err != nil {
		return true, denyOutput("QDM_AUTHZ_CLI_UNAVAILABLE: authz mode is on but no trusted qdm-metric-cli is available"), nil
	}
	rewritten, err := injectAuthForCommand(dialect, command, resolved.Blob, metricCliPath)
	if err != nil || strings.TrimSpace(rewritten) == "" || rewritten == command {
		return true, denyOutput("QDM_AUTHZ_REWRITE_FAILED: refusing to execute a QDM data command whose authorization could not be rewritten safely"), nil
	}
	if AuthSourceEnvPresent(nil) {
		rewritten = scrubAuthSourceEnvCommand(dialect, rewritten)
	}
	return true, allowOutput(replaceCommand(payload.ToolInput, rewritten), "Configured authorization is bound to this QDM data command"), nil
}

func resolveDialect(agent, toolName string, toolInput map[string]any) (ShellDialect, bool) {
	agent = strings.ToLower(strings.TrimSpace(agent))
	tool := strings.ToLower(strings.TrimSpace(toolName))
	if agent != "codex" && agent != "workbuddy" {
		return "", false
	}
	if agent == "codex" {
		command, _ := toolInput["command"].(string)
		dialect, supported := shellDialect(toolName, command)
		if !supported {
			return "", true
		}
		return dialect, true
	}
	if agent == "workbuddy" && tool != "bash" && tool != "powershell" && tool != "execute_command" {
		return "", true
	}
	if tool == "powershell" {
		return ShellPowerShell, true
	}
	for _, key := range []string{"shell", "shell_name", "executor"} {
		value, _ := toolInput[key].(string)
		value = strings.ToLower(strings.TrimSpace(value))
		switch {
		case strings.Contains(value, "powershell"), strings.Contains(value, "pwsh"):
			return ShellPowerShell, true
		case value == "bash", value == "sh", strings.Contains(value, "git-bash"):
			return ShellBash, true
		case value == "cmd", strings.Contains(value, "cmd.exe"):
			return "", true
		}
	}
	if tool == "bash" {
		return ShellBash, true
	}
	// execute_command is host-defined. Without an explicit executor hint it is
	// unsafe to infer PowerShell merely because the hook binary runs on Windows.
	return "", true
}

func isMetricAuthzGatedCommand(dialect ShellDialect, command string) bool {
	if dialect == ShellPowerShell {
		return IsPowerShellMetricAuthzGatedCommand(command)
	}
	return IsMetricAuthzGatedCommand(command)
}

func shellDialect(toolName, command string) (ShellDialect, bool) {
	if runtime.GOOS != "windows" {
		return ShellBash, true
	}
	normalizedTool := strings.ToLower(strings.TrimSpace(toolName))
	if regexp.MustCompile(`(?i)^\s*cmd(?:\.exe)?\s+/(?:c|k)\b`).MatchString(command) {
		return ShellCMD, true
	}
	switch normalizedTool {
	case "bash", "git bash", "shell", "sh":
		return ShellBash, true
	case "powershell", "pwsh", "powershell.exe", "shell_command", "functions.shell_command":
		return ShellPowerShell, true
	case "cmd", "cmd.exe", "command prompt", "commandprompt":
		return ShellCMD, true
	default:
		return "", false
	}
}

func metricInvocationCount(dialect ShellDialect, command string) int {
	if dialect == ShellPowerShell {
		return PowerShellMetricInvocationCount(command)
	}
	return MetricInvocationCount(command)
}

func scrubAuthSourceEnvCommand(dialect ShellDialect, command string) string {
	if dialect == ShellPowerShell {
		return ScrubAuthSourceEnvPowerShellCommand(command)
	}
	if dialect == ShellCMD {
		parts := make([]string, 0, len(AuthSourceEnvKeys))
		for _, key := range AuthSourceEnvKeys {
			parts = append(parts, `set "`+key+`="`)
		}
		return strings.Join(parts, " && ") + " && " + command
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
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
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

func missingAuthReason(dialect ShellDialect, command string, cfg harness.AuthzConfig, sourceErr error) string {
	hasModelFlags := CommandHasModelAuthFlags(command)
	if dialect == ShellPowerShell {
		hasModelFlags = PowerShellCommandHasModelAuthFlags(command)
	}
	if !cfg.LocalBlobAllowed() && hasModelFlags {
		return "QDM_AUTHZ_SOURCE_MISSING: refusing model-supplied --auth-blob or related authorization flags while local authorization is disabled"
	}
	if sourceErr != nil {
		reason := sourceErr.Error()
		if strings.Contains(reason, "must be an encrypted qdm1enc blob") ||
			strings.Contains(reason, "must contain a qdm1enc blob") ||
			strings.Contains(reason, "auth blob file is empty") ||
			strings.Contains(reason, "auth blob file must be a regular file") {
			return "QDM_AUTHZ_SOURCE_INVALID: the configured authorization source is invalid"
		}
	}
	isDescribe := IsMetricAuthDescribe(command)
	if dialect == ShellPowerShell {
		isDescribe = IsPowerShellMetricAuthDescribe(command)
	}
	if isDescribe {
		return "QDM_AUTHZ_SOURCE_MISSING: authz mode is on but no encrypted auth blob is bound; cannot run qdm-metric-cli auth describe"
	}
	return "QDM_AUTHZ_SOURCE_MISSING: authz mode is on but no encrypted auth blob is bound; cannot run qdm-metric-cli data command"
}

func injectAuthForCommand(dialect ShellDialect, command, blob, metricCliPath string) (string, error) {
	return RewriteGatedMetricCommands(command, blob, metricCliPath, dialect)
}

func ResolveMetricCLIPath(root string, cfg harness.Config) (string, error) {
	candidates := []string{}
	if envPath := strings.TrimSpace(os.Getenv("QDM_METRIC_CLI")); envPath != "" {
		candidates = append(candidates, envPath)
	}
	if cfg.CLI.QDMMetricCLI != "" {
		candidates = append(candidates, resolveProjectPath(root, cfg.CLI.QDMMetricCLI))
	}
	metricName := "qdm-metric-cli"
	if filepath.Separator == '\\' {
		metricName += ".exe"
	}
	candidates = append(candidates, filepath.Join(root, "bin", metricName))
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if filepath.Separator != '\\' && info.Mode().Perm()&0o111 == 0 {
			continue
		}
		absolute, err := filepath.Abs(candidate)
		if err == nil {
			return filepath.Clean(absolute), nil
		}
		return filepath.Clean(candidate), nil
	}
	return "", fmt.Errorf("configured and runtime CLI paths are missing or not executable")
}

func resolveProjectPath(root, value string) string {
	if filepath.IsAbs(value) || strings.HasPrefix(value, "/") {
		return value
	}
	return filepath.Join(root, filepath.FromSlash(value))
}
