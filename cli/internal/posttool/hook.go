package posttool

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path"
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

var reportOrder = []string{"store-overview", "member-overview", "financial-overview"}

func RunClaudeHook(root string, input []byte) (bool, Output, error) {
	var payload Payload
	if err := json.Unmarshal(input, &payload); err != nil {
		return false, Output{}, nil
	}
	if !isShellTool(payload.ToolName) || strings.TrimSpace(payload.ToolInput.Command) == "" {
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
	if !isTemplateStageCommand(command) && !isTemplateInjectionCommand(command) {
		return false, Output{}, nil
	}
	message, outcome, templateRel, err := InjectTemplate(root, sessionID)
	if err != nil {
		return false, Output{}, err
	}
	updated, _ := sessionstate.Load(root, sessionID)
	recordTemplateDiagnostic(root, sessionID, updated, getReportState(updated, "template"), outcome, templateRel)
	return true, buildOutput(message), nil
}

func isShellTool(toolName string) bool {
	return toolName == "Bash" || toolName == "exec_command"
}

func InjectTemplate(root, sessionID string) (message, outcome, templateRel string, err error) {
	state, err := sessionstate.Load(root, sessionID)
	if err != nil {
		return "", "", "", err
	}
	reportState := getReportState(state, "template")
	if state.Mode == "" {
		return "QDM_INJECT_TEMPLATE session state missing. Do not guess a template; run context first.", "missing_session_state", "", sessionstate.Save(root, sessionID, state)
	}
	if state.Mode == sessionstate.ModeFree {
		state.SelectedPlaybook = ""
		state.SelectedTemplate = ""
		state.SelectedPlaybooks = nil
		if err := sessionstate.Save(root, sessionID, state); err != nil {
			return "", "", "", err
		}
		return "QDM_FREE_ANALYSIS current session is free mode. Do not run inject-template; continue free analysis and do not read template files.", "free_mode_no_template", "", nil
	}
	templateRel, validationMessage := selectedTemplatePath(root, state)
	if validationMessage != "" {
		return validationMessage, "template_selection_error", templateRel, sessionstate.Save(root, sessionID, state)
	}
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return "", "", templateRel, err
	}
	template, err := os.ReadFile(resolver.Resolve(templateRel))
	if err != nil {
		return "QDM_INJECT_TEMPLATE missing " + templateRel + ". Wiki integrity error; do not read any other template.", "missing_template", templateRel, sessionstate.Save(root, sessionID, state)
	}
	state.TemplateInjected = true
	reportState.TemplateInjected = true
	if err := sessionstate.Save(root, sessionID, state); err != nil {
		return "", "", templateRel, err
	}
	return string(stripMarkdownFrontmatter(template)) + finalOutputContract(), "template_injected", templateRel, nil
}

func finalOutputContract() string {
	return "\n\nQDM_DELIVERY_MODE=chat\nQDM_FINAL_OUTPUT_CONTRACT:\n- Use the injected template to organize the final response in the current conversation.\n- Do not write the final result or intermediate analysis result to a file.\n- Only create an export file when the user explicitly asks to export, save, or generate a file.\n"
}

func buildOutput(message string) Output {
	return Output{
		HookSpecificOutput: HookSpecificOutput{
			HookEventName:     "PostToolUse",
			AdditionalContext: message,
		},
	}
}

func shouldRequireTemplateInjection(state sessionstate.File) bool {
	if state.Mode == sessionstate.ModeFree || state.Mode == "" {
		return false
	}
	if state.SelectedTemplate == "" || state.TemplateInjected {
		return false
	}
	return true
}

func templateInjectionRequiredMessage(state sessionstate.File) string {
	var b strings.Builder
	b.WriteString("QDM_TEMPLATE_REQUIRED: data collection command was recorded for a template-backed Harness plan. Do not answer, summarize, calculate a final report, or read template files yet. Run `bin/data-harness-cli inject-template` now. After the PostToolUse hook injects the selected template, use that injected template to produce the final answer.")
	if state.SelectedPlaybook != "" {
		b.WriteString(" selectedPlaybook=")
		b.WriteString(state.SelectedPlaybook)
	}
	if state.SelectedTemplate != "" {
		b.WriteString(" selectedTemplate=")
		b.WriteString(state.SelectedTemplate)
	}
	return b.String()
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
	return regexp.MustCompile(`(^|\s)["']?(\./)?(bin/)?data-harness-cli["']?\s+inject-template(\s|$|["'])`).MatchString(normalized) ||
		regexp.MustCompile(`/data-harness-cli["']?\s+inject-template(\s|$|["'])`).MatchString(normalized)
}

func isTemplateStageCommand(command string) bool {
	normalized := normalizeCommand(command)
	if !strings.Contains(normalized, "data-harness-cli") || !strings.Contains(normalized, "stage template") {
		return false
	}
	return regexp.MustCompile(`(^|\s)["']?(\./)?(bin/)?data-harness-cli["']?\s+stage\s+template(\s|$|["'])`).MatchString(normalized) ||
		regexp.MustCompile(`/data-harness-cli["']?\s+stage\s+template(\s|$|["'])`).MatchString(normalized)
}

func selectedTemplatePath(root string, state sessionstate.File) (string, string) {
	if state.SelectedPlaybook == "" {
		return "", "QDM_INJECT_TEMPLATE no selectedPlaybook in session state. Do not guess a template; continue without template injection."
	}
	if state.SelectedTemplate == "" {
		return "", "QDM_INJECT_TEMPLATE no selectedTemplate in session state. Do not guess a template; continue without template injection."
	}
	if !isAllowedTemplatePath(state.SelectedTemplate) {
		return state.SelectedTemplate, "QDM_INJECT_TEMPLATE template must be templates/... or reports/.../template.md: " + state.SelectedTemplate + "."
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

func isAllowedTemplatePath(logical string) bool {
	return strings.HasPrefix(logical, "templates/") ||
		(strings.HasPrefix(logical, "reports/") && path.Base(logical) == "template.md")
}

func stripMarkdownFrontmatter(data []byte) []byte {
	lines := bytes.Split(data, []byte("\n"))
	if len(lines) == 0 || strings.TrimSpace(string(lines[0])) != "---" {
		return data
	}
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(string(lines[i])) == "---" {
			return bytes.Join(lines[i+1:], []byte("\n"))
		}
	}
	return data
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
	dir := sessionstate.DiagnosticsDir(root)
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
