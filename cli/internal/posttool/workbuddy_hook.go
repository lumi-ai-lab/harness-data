package posttool

import (
	"encoding/json"
	"strings"

	"harness-data/cli/internal/harness"
)

const workBuddySessionPrefix = "workbuddy:"

type WorkBuddyOutput struct {
	Continue           bool               `json:"continue"`
	SystemMessage      string             `json:"systemMessage,omitempty"`
	HookSpecificOutput HookSpecificOutput `json:"hookSpecificOutput"`
}

// RunWorkBuddyHook consumes the canonical PostToolUse payload emitted by the
// WorkBuddy JavaScript adapter. Template staging/injection commands are
// stateful. Metric commands are no-ops because authorization is enforced by
// the WorkBuddy PreToolUse hook before the command executes.
func RunWorkBuddyHook(root string, input []byte) (bool, WorkBuddyOutput, error) {
	var payload Payload
	if err := json.Unmarshal(input, &payload); err != nil {
		return false, WorkBuddyOutput{}, nil
	}
	command := strings.TrimSpace(payload.ToolInput.Command)
	if payload.ToolName != "Bash" || command == "" {
		return false, WorkBuddyOutput{}, nil
	}
	templateCommand := isTemplateStageCommand(command) || isTemplateInjectionCommand(command)
	metricCommand := isQDMMetricCommand(command)
	if !templateCommand && !metricCommand {
		return false, WorkBuddyOutput{}, nil
	}
	if metricCommand && !templateCommand {
		return false, WorkBuddyOutput{}, nil
	}

	sessionID := strings.TrimSpace(payload.SessionID)
	if sessionID == "" {
		message := "QDM_HARNESS_BLOCKED: WorkBuddy did not provide a stable session_id for template injection. " +
			"Do not guess, read, or use any template; run context in a new WorkBuddy session first."
		return true, workBuddySafetyOutput(message), nil
	}

	if _, err := harness.LoadConfig(root); err != nil {
		message := "QDM_HARNESS_UNAVAILABLE: Harness configuration could not be loaded after the template tool call. " +
			"Do not guess, read, or use a template."
		return true, workBuddySafetyOutput(message), nil
	}

	ok, output, err := runTemplateHook(root, command, workBuddySessionPrefix+sessionID)
	if err != nil {
		return true, workBuddySafetyOutput(
			"QDM_HARNESS_UNAVAILABLE: The selected template could not be injected. " +
				"Do not read another template, guess its structure, or produce a final report.",
		), nil
	}
	if !ok {
		return false, WorkBuddyOutput{}, nil
	}
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
			HookEventName:     "PostToolUse",
			AdditionalContext: message,
		},
	}
}
