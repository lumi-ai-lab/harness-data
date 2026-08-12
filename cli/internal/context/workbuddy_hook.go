package context

import (
	"strings"

	"harness-data/cli/internal/harness"
)

const workBuddySessionPrefix = "workbuddy:"

type WorkBuddyOutput struct {
	Continue           bool               `json:"continue"`
	SystemMessage      string             `json:"systemMessage,omitempty"`
	HookSpecificOutput HookSpecificOutput `json:"hookSpecificOutput"`
}

// RunWorkBuddyHook handles the canonical payload produced by the WorkBuddy
// JavaScript adapter. Unlike the legacy hook formats, it never falls back to a
// shared "unknown" session and converts host-specific failures into model-visible
// safety context.
func RunWorkBuddyHook(root string, input []byte) (bool, WorkBuddyOutput, error) {
	payload, ok := parsePromptPayload(input)
	if !ok || strings.TrimSpace(payload.Prompt) == "" {
		return false, WorkBuddyOutput{}, nil
	}

	sessionID := strings.TrimSpace(payload.SessionID)
	if sessionID == "" {
		return true, workBuddySafetyOutput(
			"QDM_HARNESS_BLOCKED: WorkBuddy did not provide a stable session_id. " +
				"Do not run qdm-metric-cli, do not estimate data, and do not run template commands in this turn. " +
				"Start a new WorkBuddy session or update WorkBuddy before retrying.",
		), nil
	}

	cfg, err := harness.LoadConfig(root)
	if err != nil {
		return true, workBuddySafetyOutput(
			"QDM_HARNESS_UNAVAILABLE: Harness configuration could not be loaded. " +
				"Do not run qdm-metric-cli or estimate data until the runtime configuration is repaired.",
		), nil
	}

	ok, output, err := runPromptHook(root, payload.Prompt, workBuddySessionPrefix+sessionID)
	if err != nil {
		return true, workBuddySafetyOutput(
			"QDM_HARNESS_UNAVAILABLE: Harness context could not be built. " +
				"Do not run qdm-metric-cli, estimate values, or guess playbooks/templates in this turn.",
		), nil
	}
	if !ok {
		return false, WorkBuddyOutput{}, nil
	}
	output.HookSpecificOutput.AdditionalContext = "authzMode: " + cfg.Authz.Mode + "\n\n" + output.HookSpecificOutput.AdditionalContext
	return true, WorkBuddyOutput{
		Continue:           true,
		HookSpecificOutput: output.HookSpecificOutput,
	}, nil
}

func workBuddySafetyOutput(message string) WorkBuddyOutput {
	return WorkBuddyOutput{
		Continue:      true,
		SystemMessage: message,
		HookSpecificOutput: HookSpecificOutput{
			HookEventName:     "UserPromptSubmit",
			AdditionalContext: message,
		},
	}
}
