package posttool

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type Output struct {
	HookSpecificOutput HookSpecificOutput `json:"hookSpecificOutput"`
}

type HookSpecificOutput struct {
	HookEventName     string `json:"hookEventName"`
	AdditionalContext string `json:"additionalContext"`
}

type Payload struct {
	SessionID string `json:"session_id"`
	ToolName  string `json:"tool_name"`
	ToolInput struct {
		Command string `json:"command"`
	} `json:"tool_input"`
}

type reportConfig struct {
	Report          string
	RequiredModules []string
	SpecPath        string
	TemplatePath    string
}

type stateFile struct {
	SessionID string                  `json:"session_id"`
	Reports   map[string]*reportState `json:"reports"`
}

type reportState struct {
	RecordedModules   []string `json:"recorded_modules"`
	SignalSeen        bool     `json:"signal_seen"`
	TemplateInjected  bool     `json:"template_injected"`
	LastSignalMissing []string `json:"last_signal_missing"`
	LastSignalCommand string   `json:"last_signal_command"`
}

var reportConfigs = map[string]reportConfig{
	"business-overview": {
		Report:          "business",
		RequiredModules: []string{"overview", "indicators", "tree", "area", "category", "trend"},
		SpecPath:        "spec/business/report-contract.md",
		TemplatePath:    "templates/business-overview-report.md",
	},
	"store-overview": {
		Report:          "store",
		RequiredModules: []string{"overview"},
		SpecPath:        "spec/store/report-contract.md",
		TemplatePath:    "templates/store-overview-report.md",
	},
	"member-overview": {
		Report:          "user",
		RequiredModules: []string{"overview"},
		SpecPath:        "spec/member/report-contract.md",
		TemplatePath:    "templates/member-overview-report.md",
	},
	"financial-overview": {
		Report:          "company",
		RequiredModules: []string{"indicators", "tree", "table"},
		SpecPath:        "spec/financial/report-contract.md",
		TemplatePath:    "templates/financial-overview-report.md",
	},
}

var reportOrder = []string{"business-overview", "store-overview", "member-overview", "financial-overview"}

func RunClaudeHook(root string, input []byte) (bool, Output, error) {
	var payload Payload
	if err := json.Unmarshal(input, &payload); err != nil {
		return false, Output{}, nil
	}
	if payload.ToolName != "Bash" || strings.TrimSpace(payload.ToolInput.Command) == "" {
		return false, Output{}, nil
	}
	sessionID := payload.SessionID
	if sessionID == "" {
		sessionID = os.Getenv("CLAUDE_SESSION_ID")
	}
	if sessionID == "" {
		sessionID = "unknown"
	}
	command := payload.ToolInput.Command
	state, err := loadState(root, sessionID)
	if err != nil {
		return false, Output{}, err
	}

	if recordCommandModules(state, command) {
		if err := saveState(root, sessionID, state); err != nil {
			return false, Output{}, err
		}
		return false, Output{}, nil
	}

	signalReport := extractSignalReport(command)
	if signalReport == "" {
		return false, Output{}, nil
	}
	config := reportConfigs[signalReport]
	reportState := getReportState(state, signalReport)
	normalized := normalizeCommand(command)
	reportState.SignalSeen = true
	reportState.LastSignalCommand = normalized
	missing := missingModules(reportState, config.RequiredModules)
	reportState.LastSignalMissing = missing

	if reportState.TemplateInjected {
		if err := saveState(root, sessionID, state); err != nil {
			return false, Output{}, err
		}
		recordSignalDiagnostic(root, sessionID, signalReport, reportState, missing, "already_injected")
		return true, buildOutput(fmt.Sprintf("%s signal already satisfied in this session; do not request template injection again.", signalReport)), nil
	}

	if len(missing) > 0 {
		if err := saveState(root, sessionID, state); err != nil {
			return false, Output{}, err
		}
		recordSignalDiagnostic(root, sessionID, signalReport, reportState, missing, "missing_modules")
		message := fmt.Sprintf(
			"QDM_BEFORE_REPORT_SIGNAL %s missing modules: %s. Continue querying the missing modules, then rerun python3 .claude/hooks/before-report-signal.py %s.",
			signalReport,
			strings.Join(missing, ", "),
			signalReport,
		)
		return true, buildOutput(message), nil
	}

	templatePath := filepath.Join(root, filepath.FromSlash(config.TemplatePath))
	template, err := os.ReadFile(templatePath)
	if err != nil {
		if saveErr := saveState(root, sessionID, state); saveErr != nil {
			return false, Output{}, saveErr
		}
		recordSignalDiagnostic(root, sessionID, signalReport, reportState, missing, "missing_template")
		return true, buildOutput(fmt.Sprintf("QDM_BEFORE_REPORT_SIGNAL %s missing %s.", signalReport, config.TemplatePath)), nil
	}

	reportState.TemplateInjected = true
	if err := saveState(root, sessionID, state); err != nil {
		return false, Output{}, err
	}
	recordSignalDiagnostic(root, sessionID, signalReport, reportState, missing, "template_injected")
	return true, buildOutput(string(template)), nil
}

func buildOutput(message string) Output {
	return Output{
		HookSpecificOutput: HookSpecificOutput{
			HookEventName:     "PostToolUse",
			AdditionalContext: message,
		},
	}
}

func recordCommandModules(state stateFile, command string) bool {
	handled := false
	for _, reportName := range reportOrder {
		config := reportConfigs[reportName]
		modules := extractReportModules(command, reportName, config)
		if len(modules) == 0 {
			continue
		}
		reportState := getReportState(state, reportName)
		for _, module := range modules {
			if addModule(reportState, module) {
				handled = true
			}
		}
	}
	return handled
}

func extractReportModules(command, reportName string, config reportConfig) []string {
	normalized := normalizeCommand(command)
	lowered := strings.ToLower(normalized)
	if reportName == "financial-overview" {
		modules := extractStandardModules(lowered, config.Report, config.RequiredModules)
		if financialTableCommand(normalized, lowered) && !contains(modules, "table") {
			modules = append(modules, "table")
		}
		return modules
	}
	return extractStandardModules(lowered, config.Report, config.RequiredModules)
}

func extractStandardModules(lowered, report string, required []string) []string {
	pattern := regexp.MustCompile(`\breport\s+` + regexp.QuoteMeta(report) + `\s+(` + strings.Join(required, "|") + `)\b`)
	matches := pattern.FindAllStringSubmatchIndex(lowered, -1)
	var modules []string
	for i, match := range matches {
		module := lowered[match[2]:match[3]]
		segmentEnd := len(lowered)
		if i+1 < len(matches) {
			segmentEnd = matches[i+1][0]
		}
		segment := lowered[match[0]:segmentEnd]
		if module == "tree" && !strings.Contains(segment, "--values") {
			continue
		}
		if !contains(modules, module) {
			modules = append(modules, module)
		}
	}
	return modules
}

func financialTableCommand(normalized, lowered string) bool {
	hasReport := regexp.MustCompile(`\btable\b`).MatchString(lowered) && regexp.MustCompile(`--report\s+company\b`).MatchString(lowered)
	hasIndicator := regexp.MustCompile(`--indicator\s+(ebitda|ebitdacompanyprofit)\b`).MatchString(lowered)
	hasDim := regexp.MustCompile(`(?i)--dim-type\s+(管理区域|manageareaid)(\s|$)`).MatchString(normalized)
	return hasReport && hasIndicator && hasDim
}

func extractSignalReport(command string) string {
	normalized := normalizeCommand(command)
	for _, reportName := range reportOrder {
		if strings.Contains(normalized, "before-report-signal.py "+reportName) {
			return reportName
		}
	}
	return ""
}

func normalizeCommand(command string) string {
	return strings.Join(strings.Fields(command), " ")
}

func getReportState(state stateFile, reportName string) *reportState {
	if state.Reports == nil {
		state.Reports = map[string]*reportState{}
	}
	current := state.Reports[reportName]
	if current == nil {
		current = &reportState{}
		state.Reports[reportName] = current
	}
	if current.RecordedModules == nil {
		current.RecordedModules = []string{}
	}
	if current.LastSignalMissing == nil {
		current.LastSignalMissing = []string{}
	}
	return current
}

func addModule(state *reportState, module string) bool {
	if contains(state.RecordedModules, module) {
		return false
	}
	state.RecordedModules = append(state.RecordedModules, module)
	return true
}

func missingModules(state *reportState, required []string) []string {
	recorded := map[string]bool{}
	for _, module := range state.RecordedModules {
		recorded[module] = true
	}
	var missing []string
	for _, module := range required {
		if !recorded[module] {
			missing = append(missing, module)
		}
	}
	return missing
}

func loadState(root, sessionID string) (stateFile, error) {
	path := statePath(root, sessionID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return stateFile{SessionID: sessionID, Reports: map[string]*reportState{}}, nil
		}
		return stateFile{}, err
	}
	var state stateFile
	if err := json.Unmarshal(data, &state); err != nil {
		return stateFile{SessionID: sessionID, Reports: map[string]*reportState{}}, nil
	}
	if state.SessionID == "" {
		state.SessionID = sessionID
	}
	if state.Reports == nil {
		state.Reports = map[string]*reportState{}
	}
	return state, nil
}

func saveState(root, sessionID string, state stateFile) error {
	if state.SessionID == "" {
		state.SessionID = sessionID
	}
	dir := stateDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temp, err := os.CreateTemp(dir, ".tmp-*.json")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		_ = os.Remove(tempName)
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	return os.Rename(tempName, statePath(root, sessionID))
}

func stateDir(root string) string {
	return filepath.Join(root, ".claude", "hooks", "state", "business-report")
}

func statePath(root, sessionID string) string {
	return filepath.Join(stateDir(root), safeSessionID(sessionID)+".json")
}

func safeSessionID(sessionID string) string {
	re := regexp.MustCompile(`[^A-Za-z0-9_.-]+`)
	safe := re.ReplaceAllString(sessionID, "_")
	if safe == "" {
		return "unknown"
	}
	return safe
}

func recordSignalDiagnostic(root, sessionID, reportName string, state *reportState, missing []string, outcome string) {
	if os.Getenv("QDM_HARNESS_DIAG") != "1" {
		return
	}
	config := reportConfigs[reportName]
	event := map[string]any{
		"ts":                        time.Now().UTC().Format(time.RFC3339Nano),
		"session_id":                sessionID,
		"event":                     "before_report_signal",
		"report_name":               reportName,
		"report":                    config.Report,
		"spec_path":                 config.SpecPath,
		"spec_stats":                pathStats(filepath.Join(root, filepath.FromSlash(config.SpecPath))),
		"template_path":             config.TemplatePath,
		"template_stats":            pathStats(filepath.Join(root, filepath.FromSlash(config.TemplatePath))),
		"missing_modules":           missing,
		"template_already_injected": state.TemplateInjected,
		"signal_seen":               state.SignalSeen,
		"outcome":                   outcome,
	}
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	dir := filepath.Join(root, ".claude", "hooks", "state", "diagnostics")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	path := filepath.Join(dir, safeSessionID(sessionID)+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.Write(append(data, '\n'))
}

func pathStats(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{"path": path, "exists": false, "bytes": 0, "lines": 0}
	}
	return map[string]any{
		"path":   path,
		"exists": true,
		"bytes":  len(data),
		"lines":  countLines(data),
	}
}

func countLines(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	lines := bytes.Count(data, []byte{'\n'})
	if data[len(data)-1] != '\n' {
		lines++
	}
	return lines
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func ReadHookStdin() ([]byte, error) {
	return io.ReadAll(os.Stdin)
}

func ReportNames() []string {
	names := append([]string(nil), reportOrder...)
	sort.Strings(names)
	return names
}
