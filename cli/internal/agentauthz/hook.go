package agentauthz

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

func ReadHookStdin() ([]byte, error) {
	return io.ReadAll(os.Stdin)
}

func Run(root string, agent string, input []byte) (bool, HookOutput, error) {
	if agent != "codex" {
		return false, HookOutput{}, fmt.Errorf("unsupported authz agent: %s", agent)
	}
	payload, ok := parseHookPayload(input)
	if !ok {
		return false, HookOutput{}, nil
	}
	if payload.HookEventName != "" && payload.HookEventName != "PreToolUse" {
		return false, HookOutput{}, nil
	}
	if !strings.EqualFold(payload.ToolName, "Bash") {
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

	if !IsMetricAuthzGatedCommand(command) {
		if AuthSourceEnvPresent(nil) {
			return true, allowOutput(replaceCommand(payload.ToolInput, ScrubAuthSourceEnvCommand(command)), "Auth source environment scrubbed for non-gated Bash command"), nil
		}
		return false, HookOutput{}, nil
	}

	metricCliPath := ResolveMetricCLIPath(root, cfg)
	resolved, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: root,
		Config:      cfg.Authz,
	})
	if err != nil {
		return true, denyOutput(missingAuthReason(command, cfg.Authz, err)), nil
	}

	rewritten := injectAuthForCommand(command, resolved.Blob, metricCliPath)
	if AuthSourceEnvPresent(nil) {
		rewritten = ScrubAuthSourceEnvCommand(rewritten)
	}
	return true, allowOutput(replaceCommand(payload.ToolInput, rewritten), "Current requester authorization is bound to this QDM data command"), nil
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

func missingAuthReason(command string, cfg harness.AuthzConfig, err error) string {
	if !cfg.LocalBlobAllowed() && CommandHasModelAuthFlags(command) {
		return "authz: no local blob available; refusing model-supplied --auth-blob under allow_local_blob=false"
	}
	message := err.Error()
	if IsMetricAuthDescribe(command) {
		return "authz mode is on but no encrypted auth blob is bound for this turn; cannot run qdm-metric-cli auth describe: " + message
	}
	return "authz mode is on but no encrypted auth blob is bound for this turn; cannot run qdm-metric-cli analysis execute: " + message
}

func injectAuthForCommand(command, blob, metricCliPath string) string {
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
	candidates = append(candidates, filepath.Join(root, "bin", "qdm-metric-cli"))
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return candidates[0]
}

func resolveProjectPath(root, value string) string {
	if filepath.IsAbs(value) {
		return value
	}
	return filepath.Join(root, filepath.FromSlash(value))
}
