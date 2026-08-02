package agentauthz

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"harness-data/cli/internal/authz"
)

const (
	profileLumiRequired = "lumi-mvp-required"
	profileLocal        = "local-unrestricted"
	maxHookInputBytes   = 2 << 20
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

var supportedAgents = map[string]struct{}{
	"claude": {},
	"codex":  {},
	"qwen":   {},
}

var localAgents = map[string]struct{}{
	"claude":   {},
	"codex":    {},
	"qwen":     {},
	"pi":       {},
	"openclaw": {},
	"hermes":   {},
	"both":     {},
	"all":      {},
}

type installerState struct {
	LastInstallDir  string                     `json:"lastInstallDir"`
	UpdatedAt       string                     `json:"updatedAt"`
	SchemaVersion   int                        `json:"schemaVersion"`
	Profile         string                     `json:"profile"`
	Agent           string                     `json:"agent"`
	InstallMode     string                     `json:"installMode"`
	RuntimeTag      string                     `json:"runtimeTag"`
	LocalTools      map[string]json.RawMessage `json:"localTools"`
	Tools           map[string]json.RawMessage `json:"tools"`
	ManifestSHA256  string                     `json:"manifestSha256"`
	PackageVersion  string                     `json:"packageVersion"`
	ReleaseSet      json.RawMessage            `json:"releaseSet"`
	AuthzConfigPath string                     `json:"authzConfigPath"`
	LastCheckAt     string                     `json:"lastCheckAt,omitempty"`
}

type hookPayload struct {
	SessionID     string         `json:"session_id"`
	HookEventName string         `json:"hook_event_name"`
	ToolName      string         `json:"tool_name"`
	ToolInput     map[string]any `json:"tool_input"`
}

type output struct {
	Decision           string              `json:"decision,omitempty"`
	Reason             string              `json:"reason,omitempty"`
	HookSpecificOutput *hookSpecificOutput `json:"hookSpecificOutput,omitempty"`
}

type hookSpecificOutput struct {
	HookEventName            string         `json:"hookEventName"`
	AdditionalContext        string         `json:"additionalContext,omitempty"`
	PermissionDecision       string         `json:"permissionDecision,omitempty"`
	PermissionDecisionReason string         `json:"permissionDecisionReason,omitempty"`
	UpdatedInput             map[string]any `json:"updatedInput,omitempty"`
}

// Run handles the common Claude Code, Codex, and Qwen Code hook contract.
// Local-unrestricted runtimes are intentionally left unchanged.
func Run(root, agent string, input []byte) (bool, any, error) {
	return run(root, agent, input, bind)
}

func run(root, agent string, input []byte, binder func(string) (authz.BindResult, string)) (bool, any, error) {
	if _, ok := supportedAgents[agent]; !ok {
		return false, nil, fmt.Errorf("unsupported authorization hook agent: %s", agent)
	}
	state, enforcing, err := loadInstallerState(root)
	if err != nil {
		return true, promptDeny("authorization runtime state is invalid"), nil
	}
	if !enforcing {
		return false, nil, nil
	}
	if len(input) == 0 || len(input) > maxHookInputBytes {
		return true, promptDeny("authorization hook input is missing or too large"), nil
	}
	if state.Agent != agent {
		return true, promptDeny("authorization hook does not match the installed agent"), nil
	}

	var payload hookPayload
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return true, promptDeny("authorization hook payload is invalid"), nil
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return true, promptDeny("authorization hook payload is invalid"), nil
	}
	switch payload.HookEventName {
	case "UserPromptSubmit":
		return runPromptHook(payload, binder)
	case "PreToolUse":
		return runPreToolHook(root, agent, payload, binder)
	default:
		return true, promptDeny("authorization hook event is not supported"), nil
	}
}

func loadInstallerState(root string) (installerState, bool, error) {
	var state installerState
	statePath := filepath.Join(root, ".harness", "installer-state.json")
	data, err := os.ReadFile(statePath)
	if err != nil {
		return state, false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return state, false, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return state, false, fmt.Errorf("invalid installer state JSON")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return state, false, err
	}
	for _, name := range []string{
		"lastInstallDir", "updatedAt", "schemaVersion", "profile", "agent",
		"installMode", "runtimeTag", "localTools", "tools", "manifestSha256",
		"packageVersion", "releaseSet", "authzConfigPath",
	} {
		if _, ok := fields[name]; !ok {
			return state, false, fmt.Errorf("installer state is missing %s", name)
		}
	}
	if state.SchemaVersion != 3 || state.Agent == "" ||
		filepath.Clean(state.LastInstallDir) != filepath.Clean(root) ||
		(state.InstallMode != "github-token" && state.InstallMode != "local-path") ||
		state.LocalTools == nil || state.Tools == nil ||
		!sha256Pattern.MatchString(state.ManifestSHA256) ||
		strings.TrimSpace(state.PackageVersion) == "" {
		return state, false, fmt.Errorf("invalid installer state")
	}
	if updatedAt, err := time.Parse(time.RFC3339Nano, state.UpdatedAt); err != nil || updatedAt.IsZero() {
		return state, false, fmt.Errorf("invalid installer state timestamp")
	}
	switch state.Profile {
	case profileLocal:
		if _, ok := localAgents[state.Agent]; !ok ||
			!isExplicitJSONNull(state.ReleaseSet) ||
			state.AuthzConfigPath != "" {
			return state, false, fmt.Errorf("invalid local installer state")
		}
		return state, false, nil
	case profileLumiRequired:
		if _, ok := map[string]struct{}{"pi": {}, "claude": {}, "codex": {}, "qwen": {}}[state.Agent]; !ok {
			return state, true, fmt.Errorf("invalid Lumi installer agent")
		}
		if state.InstallMode != "github-token" ||
			strings.TrimSpace(state.RuntimeTag) == "" ||
			len(state.LocalTools) != 0 ||
			!isJSONObject(state.ReleaseSet) ||
			!hasExactLumiTools(state.Tools) ||
			filepath.Clean(state.AuthzConfigPath) != authz.DefaultConfigPath {
			return state, true, fmt.Errorf("invalid Lumi installer state")
		}
		return state, true, nil
	default:
		return state, false, fmt.Errorf("unknown installer profile")
	}
}

func runPromptHook(payload hookPayload, binder func(string) (authz.BindResult, string)) (bool, any, error) {
	result, code := binder(payload.SessionID)
	if code != "" {
		return true, promptDeny("Harness authorization failed: " + code), nil
	}
	return true, output{
		HookSpecificOutput: &hookSpecificOutput{
			HookEventName:     "UserPromptSubmit",
			AdditionalContext: formatSummary(result),
		},
	}, nil
}

func runPreToolHook(root, agent string, payload hookPayload, binder func(string) (authz.BindResult, string)) (bool, any, error) {
	if !isShellTool(agent, payload.ToolName) {
		return false, nil, nil
	}
	command, ok := payload.ToolInput["command"].(string)
	if !ok || strings.TrimSpace(command) == "" {
		return true, preToolDeny("shell command is missing"), nil
	}
	if reason := forbiddenShellCommand(command); reason != "" {
		return true, preToolDeny(reason), nil
	}
	result, code := binder(payload.SessionID)
	if code != "" {
		return true, preToolDeny("Harness authorization failed: " + code), nil
	}
	updated := cloneMap(payload.ToolInput)
	updated["command"] = authorizedCommand(root, result.BindingBase64URL, command)
	return true, output{
		HookSpecificOutput: &hookSpecificOutput{
			HookEventName:            "PreToolUse",
			PermissionDecision:       "allow",
			PermissionDecisionReason: "Current requester authorization is bound to this shell command",
			UpdatedInput:             updated,
		},
	}, nil
}

func forbiddenShellCommand(command string) string {
	normalized := strings.ToLower(command)
	normalized = strings.NewReplacer(
		"'", "",
		"\"", "",
		"\\", "",
	).Replace(normalized)
	if strings.Contains(normalized, "/opt/harness-data/private") ||
		strings.Contains(normalized, "qdm-metric-cli-real") {
		return "direct access to the private Metric runtime is forbidden"
	}
	for _, name := range []string{"qdm-cmr-cli", "qdm-sql-cli", "cas-cli"} {
		if containsShellWord(normalized, name) {
			return "legacy data CLI access is forbidden"
		}
	}
	return ""
}

func containsShellWord(command, word string) bool {
	for start := 0; start < len(command); {
		index := strings.Index(command[start:], word)
		if index < 0 {
			return false
		}
		index += start
		beforeOK := index == 0 || !isShellWordByte(command[index-1])
		after := index + len(word)
		afterOK := after == len(command) || !isShellWordByte(command[after])
		if beforeOK && afterOK {
			return true
		}
		start = index + 1
	}
	return false
}

func isShellWordByte(value byte) bool {
	return value == '_' || value == '-' || value == '.' ||
		value >= '0' && value <= '9' ||
		value >= 'a' && value <= 'z'
}

func isShellTool(agent, toolName string) bool {
	if agent == "qwen" {
		return toolName == "run_shell_command" || toolName == "Bash"
	}
	if agent == "codex" {
		return toolName == "Bash" || toolName == "exec_command"
	}
	return toolName == "Bash"
}

func bind(sessionID string) (authz.BindResult, string) {
	if sessionID == "" {
		return authz.BindResult{}, string(authz.CodeBindingInvalid)
	}
	config, err := authz.LoadConfig(authz.DefaultConfigPath)
	if err != nil {
		return authz.BindResult{}, stableCode(err)
	}
	result, err := authz.Bind(config, sessionID)
	if err != nil {
		return authz.BindResult{}, stableCode(err)
	}
	return result, ""
}

func stableCode(err error) string {
	if code := authz.ErrorCode(err); code != "" {
		return string(code)
	}
	return string(authz.CodeConfigInvalid)
}

func formatSummary(result authz.BindResult) string {
	return strings.Join([]string{
		fmt.Sprintf("Requester: %s / %s / %s", result.Summary.Channel, result.Summary.BotID, result.Summary.CanonicalUserID),
		"Authorized manageAreaIds: " + strings.Join(result.Summary.ManageAreaIDs, ", "),
		"Authorized categoryLevel1Ids: " + strings.Join(result.Summary.CategoryLevel1IDs, ", "),
		"Data rule: use only qdm-metric-cli; the public Metric CLI applies final authorization.",
	}, "\n")
}

func authorizedCommand(root, binding, command string) string {
	publicBinDir := filepath.Join(root, "bin")
	publicMetricCLI := filepath.Join(publicBinDir, executableName("qdm-metric-cli"))
	setup := strings.Join([]string{
		"unset QDM_CMR_CLI QDM_SQL_CLI QDM_CAS_CLI QDM_CAS_CONFIG_DIR",
		"export PATH=" + shellQuote(publicBinDir) + ":\"${PATH:-}\"",
		"export QDM_METRIC_CLI=" + shellQuote(publicMetricCLI),
		"export HARNESS_AUTHZ_BINDING_V1=" + shellQuote(binding),
	}, " && ")
	return setup + " && eval " + shellQuote(command)
}

func executableName(name string) string {
	if os.PathSeparator == '\\' {
		return name + ".exe"
	}
	return name
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func cloneMap(source map[string]any) map[string]any {
	result := make(map[string]any, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func isJSONNull(value json.RawMessage) bool {
	return len(value) == 0 || string(value) == "null"
}

func isExplicitJSONNull(value json.RawMessage) bool {
	return string(value) == "null"
}

func isJSONObject(value json.RawMessage) bool {
	var object map[string]json.RawMessage
	return json.Unmarshal(value, &object) == nil && object != nil
}

func hasExactLumiTools(tools map[string]json.RawMessage) bool {
	if len(tools) != 3 {
		return false
	}
	for _, name := range []string{
		"data-harness-cli",
		"qdm-metric-cli",
		"qdm-metric-cli-real",
	} {
		if _, ok := tools[name]; !ok {
			return false
		}
	}
	return true
}

func promptDeny(reason string) output {
	return output{Decision: "block", Reason: reason}
}

func preToolDeny(reason string) output {
	return output{
		HookSpecificOutput: &hookSpecificOutput{
			HookEventName:            "PreToolUse",
			PermissionDecision:       "deny",
			PermissionDecisionReason: reason,
		},
	}
}
