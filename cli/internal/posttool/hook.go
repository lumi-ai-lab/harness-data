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

	"harness-data/cli/internal/harness"
	"harness-data/cli/internal/sessionstate"
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
}

var reportConfigs = map[string]reportConfig{
	"business-overview": {
		Report:          "business",
		RequiredModules: []string{"overview", "indicators", "tree", "area", "category", "trend"},
	},
	"store-overview": {
		Report:          "store",
		RequiredModules: []string{"overview"},
	},
	"member-overview": {
		Report:          "user",
		RequiredModules: []string{"overview"},
	},
	"financial-overview": {
		Report:          "company",
		RequiredModules: []string{"indicators", "tree", "table"},
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
	state, err := sessionstate.Load(root, sessionID)
	if err != nil {
		return false, Output{}, err
	}

	if recordCommandModules(state, command) {
		if err := sessionstate.Save(root, sessionID, state); err != nil {
			return false, Output{}, err
		}
		return false, Output{}, nil
	}

	if !isTemplateInjectionCommand(command) {
		return false, Output{}, nil
	}
	reportState := getReportState(state, "template")

	if state.Mode == sessionstate.ModeFreeAnalysis {
		if err := sessionstate.Save(root, sessionID, state); err != nil {
			return false, Output{}, err
		}
		recordTemplateDiagnostic(root, sessionID, state, reportState, "free_analysis_no_template", "")
		return true, buildOutput("QDM_FREE_ANALYSIS current session has no unique playbook/template. Do not run bin/data-harness-cli inject-template. Continue with CLI evidence and write a free analysis report without reading templates/."), nil
	}

	templateRel, validationMessage := selectedTemplatePath(root, state)
	if validationMessage != "" {
		if err := sessionstate.Save(root, sessionID, state); err != nil {
			return false, Output{}, err
		}
		recordTemplateDiagnostic(root, sessionID, state, reportState, "template_selection_error", templateRel)
		return true, buildOutput(validationMessage), nil
	}

	if state.TemplateInjected {
		if err := sessionstate.Save(root, sessionID, state); err != nil {
			return false, Output{}, err
		}
		recordTemplateDiagnostic(root, sessionID, state, reportState, "already_injected", templateRel)
		return true, buildOutput("QDM_INJECT_TEMPLATE already injected in this session; do not request template injection again."), nil
	}

	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return false, Output{}, err
	}
	templatePath := resolver.Resolve(templateRel)
	template, err := os.ReadFile(templatePath)
	if err != nil {
		if saveErr := sessionstate.Save(root, sessionID, state); saveErr != nil {
			return false, Output{}, saveErr
		}
		recordTemplateDiagnostic(root, sessionID, state, reportState, "missing_template", templateRel)
		return true, buildOutput(fmt.Sprintf("QDM_INJECT_TEMPLATE missing %s.", templateRel)), nil
	}

	state.TemplateInjected = true
	reportState.TemplateInjected = true
	if err := sessionstate.Save(root, sessionID, state); err != nil {
		return false, Output{}, err
	}
	recordTemplateDiagnostic(root, sessionID, state, reportState, "template_injected", templateRel)
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

func recordCommandModules(state sessionstate.File, command string) bool {
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

func isTemplateInjectionCommand(command string) bool {
	normalized := normalizeCommand(command)
	if !strings.Contains(normalized, "data-harness-cli") || !strings.Contains(normalized, "inject-template") {
		return false
	}
	return regexp.MustCompile(`(^|\s)["']?(\./)?(bin/)?data-harness-cli["']?\s+inject-template(\s|$)`).MatchString(normalized) ||
		regexp.MustCompile(`/data-harness-cli["']?\s+inject-template(\s|$)`).MatchString(normalized)
}

func selectedTemplatePath(root string, state sessionstate.File) (string, string) {
	if state.Mode == sessionstate.ModeCompositeReport {
		return compositeTemplatePath(root, state)
	}
	if state.SelectedPlaybook == "" {
		if len(state.PlaybookCandidates) > 1 {
			var items []string
			for _, candidate := range state.PlaybookCandidates {
				items = append(items, candidate.Path+" -> "+candidate.Template)
			}
			sort.Strings(items)
			return "", "QDM_INJECT_TEMPLATE ambiguous playbook candidates with templates: " + strings.Join(items, ", ") + ". Read contextFiles and user question, choose exactly one playbook, then rerun bin/data-harness-cli inject-template."
		}
		return "", "QDM_INJECT_TEMPLATE no selected playbook. First read contextFiles and determine one playbook, complete data collection, then run bin/data-harness-cli inject-template."
	}
	if state.SelectedTemplate == "" {
		return "", "QDM_INJECT_TEMPLATE selected playbook missing template frontmatter: " + state.SelectedPlaybook + "."
	}
	if !strings.HasPrefix(state.SelectedTemplate, "templates/") {
		return state.SelectedTemplate, "QDM_INJECT_TEMPLATE template must use logical path under templates/: " + state.SelectedTemplate + "."
	}
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return state.SelectedTemplate, "QDM_INJECT_TEMPLATE path config error: " + err.Error() + "."
	}
	info, err := os.Stat(resolver.Resolve(state.SelectedTemplate))
	if err != nil || info.IsDir() {
		return state.SelectedTemplate, "QDM_INJECT_TEMPLATE missing " + state.SelectedTemplate + "."
	}
	return state.SelectedTemplate, ""
}

func compositeTemplatePath(root string, state sessionstate.File) (string, string) {
	if len(state.SelectedPlaybooks) < 2 {
		return "", "QDM_INJECT_TEMPLATE composite_report requires at least two selected playbooks."
	}
	if state.SelectedTemplate == "" {
		return "", "QDM_INJECT_TEMPLATE composite_report missing selected composite template."
	}
	if !strings.HasPrefix(state.SelectedTemplate, "templates/") {
		return state.SelectedTemplate, "QDM_INJECT_TEMPLATE composite template must use logical path under templates/: " + state.SelectedTemplate + "."
	}
	for _, playbook := range state.SelectedPlaybooks {
		if playbook.Path == "" {
			return state.SelectedTemplate, "QDM_INJECT_TEMPLATE composite_report contains an empty selected playbook path."
		}
	}
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return state.SelectedTemplate, "QDM_INJECT_TEMPLATE path config error: " + err.Error() + "."
	}
	info, err := os.Stat(resolver.Resolve(state.SelectedTemplate))
	if err != nil || info.IsDir() {
		return state.SelectedTemplate, "QDM_INJECT_TEMPLATE missing " + state.SelectedTemplate + "."
	}
	return state.SelectedTemplate, ""
}

func normalizeCommand(command string) string {
	return strings.Join(strings.Fields(command), " ")
}

func getReportState(state sessionstate.File, reportName string) *sessionstate.Report {
	if state.Reports == nil {
		state.Reports = map[string]*sessionstate.Report{}
	}
	if reportName == "" {
		reportName = "template"
	}
	current := state.Reports[reportName]
	if current == nil {
		current = &sessionstate.Report{}
		state.Reports[reportName] = current
	}
	if current.RecordedModules == nil {
		current.RecordedModules = []string{}
	}
	return current
}

func addModule(state *sessionstate.Report, module string) bool {
	if contains(state.RecordedModules, module) {
		return false
	}
	state.RecordedModules = append(state.RecordedModules, module)
	return true
}

func recordTemplateDiagnostic(root, sessionID string, session sessionstate.File, state *sessionstate.Report, outcome, templatePath string) {
	if os.Getenv("QDM_HARNESS_DIAG") != "1" {
		return
	}
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		resolver = harness.PathResolver{Root: root, Paths: harness.PathsConfig{Spec: "spec", Routing: "routing", Playbooks: "playbooks", Templates: "templates"}}
	}
	event := map[string]any{
		"ts":                        time.Now().UTC().Format(time.RFC3339Nano),
		"session_id":                sessionID,
		"event":                     "inject_template",
		"selected_playbook":         session.SelectedPlaybook,
		"selected_playbooks":        session.SelectedPlaybooks,
		"mode":                      session.Mode,
		"composite":                 session.Composite,
		"template_path":             templatePath,
		"template_stats":            pathStats(resolver.Resolve(templatePath)),
		"template_already_injected": state.TemplateInjected,
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
	path := filepath.Join(dir, sessionstate.SafeSessionID(sessionID)+".jsonl")
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
