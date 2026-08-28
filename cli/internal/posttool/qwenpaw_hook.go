package posttool

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"harness-data/cli/internal/sessionstate"
)

// QwenPawHookOutput is deliberately narrower than the Claude/WorkBuddy
// envelopes. It contains no command, authorization, identity, or upstream
// diagnostic data.
type QwenPawHookOutput struct {
	OK                bool   `json:"ok"`
	AdditionalContext string `json:"additional_context,omitempty"`
	Mode              string `json:"mode,omitempty"`
	SelectedTemplate  string `json:"selected_template,omitempty"`
	DiagnosticCode    string `json:"diagnostic_code,omitempty"`
}

type qwenPawHookPayload struct {
	SessionID       string                     `json:"session_id"`
	ToolName        string                     `json:"tool_name"`
	Status          string                     `json:"status"`
	SafeCommandArgs map[string]json.RawMessage `json:"safe_command_args"`
}

var qwenPawSessionID = regexp.MustCompile(`^qwenpaw:[0-9a-f]{64}$`)

// RunQwenPawHook consumes only the plugin-owned completion envelope. The
// plugin supplies a HMAC-derived session ID, not the raw QwenPaw session ID.
func RunQwenPawHook(root string, input []byte) (QwenPawHookOutput, error) {
	var payload qwenPawHookPayload
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return QwenPawHookOutput{}, fmt.Errorf("invalid qwenpaw-hook payload")
	}
	if !qwenPawSessionID.MatchString(strings.TrimSpace(payload.SessionID)) || payload.ToolName != "qdm_query" {
		return QwenPawHookOutput{}, fmt.Errorf("invalid qwenpaw-hook identity")
	}
	if payload.Status != "success" && payload.Status != "error" {
		return QwenPawHookOutput{}, fmt.Errorf("invalid qwenpaw-hook status")
	}
	if err := validateSafeCommandArgs(payload.SafeCommandArgs); err != nil {
		return QwenPawHookOutput{}, err
	}
	if payload.Status != "success" {
		return QwenPawHookOutput{OK: true, DiagnosticCode: "tool_failed"}, nil
	}

	state, err := sessionstate.Load(root, payload.SessionID)
	if err != nil {
		return QwenPawHookOutput{OK: false, DiagnosticCode: "session_state_unavailable"}, nil
	}
	if state.Mode == "" {
		return QwenPawHookOutput{OK: false, DiagnosticCode: "missing_session_state"}, nil
	}
	if state.Mode == sessionstate.ModeFree || state.SelectedTemplate == "" {
		return QwenPawHookOutput{OK: true, Mode: state.Mode, DiagnosticCode: "no_template_required"}, nil
	}
	if reportName, module := safeReportModule(payload.SafeCommandArgs); reportName != "" && module != "" {
		if err := recordQwenPawModule(&state, reportName, module); err != nil {
			return QwenPawHookOutput{OK: false, Mode: state.Mode, DiagnosticCode: "safe_args_invalid"}, nil
		}
		if err := sessionstate.Save(root, payload.SessionID, state); err != nil {
			return QwenPawHookOutput{OK: false, Mode: state.Mode, DiagnosticCode: "session_state_unavailable"}, nil
		}
	}
	message, outcome, templatePath, err := InjectTemplate(root, payload.SessionID)
	if err != nil {
		return QwenPawHookOutput{OK: false, Mode: state.Mode, DiagnosticCode: "template_injection_failed"}, nil
	}
	return QwenPawHookOutput{
		OK:                outcome == "template_injected",
		AdditionalContext: message,
		Mode:              state.Mode,
		SelectedTemplate:  templatePath,
		DiagnosticCode:    outcome,
	}, nil
}

func validateSafeCommandArgs(args map[string]json.RawMessage) error {
	for key, raw := range args {
		if key != "report_name" && key != "report_module" {
			return fmt.Errorf("unsupported qwenpaw safe command argument")
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || strings.TrimSpace(value) == "" || len(value) > 128 {
			return fmt.Errorf("invalid qwenpaw safe command argument")
		}
	}
	return nil
}

func safeReportModule(args map[string]json.RawMessage) (string, string) {
	var reportName, module string
	_ = json.Unmarshal(args["report_name"], &reportName)
	_ = json.Unmarshal(args["report_module"], &module)
	return strings.TrimSpace(reportName), strings.TrimSpace(module)
}

func recordQwenPawModule(state *sessionstate.File, reportName, module string) error {
	config, ok := reportConfigs[reportName]
	if !ok || !contains(config.RequiredModules, module) {
		return fmt.Errorf("unsupported report module")
	}
	report := getReportState(*state, reportName)
	addModule(report, module)
	return nil
}
