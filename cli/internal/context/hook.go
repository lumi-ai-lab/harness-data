package context

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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

type promptPayload struct {
	SessionID string `json:"session_id"`
	Prompt    string `json:"prompt"`
}

type timeContext struct {
	CurrentDate string `json:"current_date"`
	Timezone    string `json:"timezone"`
	TimePolicy  string `json:"time_policy"`
	Prompt      string `json:"prompt"`
}

func RunClaudeHook(root string, input []byte) (bool, Output, error) {
	payload, ok := parsePromptPayload(input)
	if !ok || payload.Prompt == "" {
		return false, Output{}, nil
	}
	prompt := payload.Prompt
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return false, Output{}, err
	}
	tc := buildTimeContext(prompt, resolver)
	response, plan, err := BuildWithPlan(root, prompt)
	if err != nil {
		return false, Output{}, err
	}
	additionalContext, err := buildWikiAdditionalContext(tc, response, plan)
	if err != nil {
		return false, Output{}, err
	}
	sessionID := hookSessionID(payload)
	if err := writeWikiPlanState(root, sessionID, prompt, plan); err != nil {
		return false, Output{}, err
	}
	if os.Getenv("QDM_HARNESS_DIAG") == "1" {
		if err := recordDiagnostic(root, sessionID, prompt, additionalContext, tc, response); err != nil {
			return false, Output{}, err
		}
	}
	return true, Output{
		HookSpecificOutput: HookSpecificOutput{
			HookEventName:     "UserPromptSubmit",
			AdditionalContext: additionalContext,
		},
	}, nil
}

func buildWikiAdditionalContext(tc timeContext, response harness.ContextResponse, plan WikiPlan) (string, error) {
	timeJSON, err := json.Marshal(tc)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("# Data Harness Context\n\n")
	b.WriteString("时间解析 JSON：`")
	b.Write(timeJSON)
	b.WriteString("`\n\n")
	b.WriteString("Harness mode: ")
	b.WriteString(plan.Mode)
	b.WriteString("\n")
	if plan.SelectedPlaybook != "" {
		b.WriteString("selectedPlaybook: ")
		b.WriteString(plan.SelectedPlaybook)
		b.WriteString("\n")
	}
	if plan.SelectedTemplate != "" {
		b.WriteString("selectedTemplate: ")
		b.WriteString(plan.SelectedTemplate)
		b.WriteString("\n")
	}
	if plan.TemplateSelection.Status != "" {
		b.WriteString("templateSelection: ")
		b.WriteString(plan.TemplateSelection.Status)
		if plan.TemplateSelection.Reason != "" {
			b.WriteString(" (")
			b.WriteString(plan.TemplateSelection.Reason)
			b.WriteString(")")
		}
		b.WriteString("\n")
	}
	if len(plan.SelectedPlaybooks) > 0 {
		b.WriteString("selectedPlaybooks:\n")
		for _, playbook := range plan.SelectedPlaybooks {
			b.WriteString("- ")
			b.WriteString(playbook.Path)
			b.WriteString("\n")
		}
	}
	if plan.Mode == sessionstate.ModeFree {
		b.WriteString("reason: ")
		b.WriteString(plan.Reason)
		b.WriteString("\n")
	}
	b.WriteString("\n必须先读取以下 contextFiles：\n")
	for _, ref := range response.ContextFiles {
		b.WriteString("- ")
		b.WriteString(ref.Path)
		if ref.Reason != "" {
			b.WriteString(" (")
			b.WriteString(ref.Reason)
			b.WriteString(")")
		}
		b.WriteString("\n")
	}
	b.WriteString("\nInstruction: ")
	b.WriteString(response.Instruction)
	b.WriteString("\n\nConstraints:\n")
	for _, constraint := range response.Constraints {
		b.WriteString("- ")
		b.WriteString(constraint)
		b.WriteString("\n")
	}
	return b.String(), nil
}

func parsePromptPayload(input []byte) (promptPayload, bool) {
	var payload promptPayload
	if err := json.Unmarshal(input, &payload); err != nil {
		return promptPayload{}, false
	}
	return payload, true
}

func buildTimeContext(prompt string, resolver harness.PathResolver) timeContext {
	currentDate := os.Getenv("QDM_HARNESS_CURRENT_DATE")
	current, err := time.Parse("2006-01-02", currentDate)
	if err != nil {
		current = time.Now()
	}
	timezone := os.Getenv("QDM_HARNESS_TIMEZONE")
	if timezone == "" {
		timezone = os.Getenv("TZ")
	}
	if timezone == "" {
		timezone = "Asia/Shanghai"
	}
	timePolicy := "spec/common/time-policy.md"
	if info, err := os.Stat(resolver.Resolve("rules/QDM 时间口径/spec.md")); err == nil && !info.IsDir() {
		timePolicy = "rules/QDM 时间口径/spec.md"
	}
	return timeContext{
		CurrentDate: current.Format("2006-01-02"),
		Timezone:    timezone,
		TimePolicy:  fmt.Sprintf("Use %s to infer --date, --week, or --month. Do not use date ranges.", resolver.ResolveRel(timePolicy)),
		Prompt:      prompt,
	}
}

func recordDiagnostic(root, sessionID, prompt, context string, tc timeContext, response harness.ContextResponse) error {
	event := map[string]any{
		"ts":              time.Now().UTC().Format(time.RFC3339Nano),
		"session_id":      sessionID,
		"event":           "user_prompt_context",
		"matched_domains": diagnosticMatchedDomains(response.ContextFiles),
		"context_files":   contextFileDiagnostics(root, response.ContextFiles),
		"keyword_hits":    keywordHits(response.ContextFiles),
		"prompt_bytes":    len([]byte(prompt)),
		"context_bytes":   len([]byte(context)),
		"context_lines":   countLines(context),
		"time_context":    tc,
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	dir := sessionstate.DiagnosticsDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, sessionstate.SafeSessionID(sessionID)+".jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(data, '\n'))
	return err
}

func contextFileDiagnostics(root string, refs []harness.FileRef) []map[string]any {
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		resolver = harness.PathResolver{Root: root, Paths: harness.PathsConfig{Spec: "spec", Routing: "routing", Playbooks: "playbooks", Templates: "templates"}}
	}
	var out []map[string]any
	for _, ref := range refs {
		rel := ref.Path
		path := resolver.Resolve(rel)
		stats := pathStats(path)
		stats["relative_path"] = rel
		stats["reason"] = ref.Reason
		out = append(out, stats)
	}
	return out
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
		"lines":  countLinesBytes(data),
	}
}

func countLines(s string) int {
	if s == "" {
		return 0
	}
	return countLinesBytes([]byte(s))
}

func countLinesBytes(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	lines := bytes.Count(data, []byte{'\n'})
	if data[len(data)-1] != '\n' {
		lines++
	}
	return lines
}

func diagnosticMatchedDomains(refs []harness.FileRef) []string {
	seen := map[string]bool{}
	for _, ref := range refs {
		parts := strings.Split(ref.Path, "/")
		if len(parts) < 3 || parts[1] == "common" {
			continue
		}
		seen[parts[1]] = true
	}
	var domains []string
	for domain := range seen {
		domains = append(domains, domain)
	}
	sort.Strings(domains)
	return domains
}

func hookSessionID(payload promptPayload) string {
	if payload.SessionID != "" {
		return payload.SessionID
	}
	sessionID := os.Getenv("CLAUDE_SESSION_ID")
	if sessionID == "" {
		return "unknown"
	}
	return sessionID
}

func writeWikiPlanState(root, sessionID, prompt string, plan WikiPlan) error {
	state, err := sessionstate.Load(root, sessionID)
	if err != nil {
		return err
	}
	state.Mode = plan.Mode
	state.Prompt = prompt
	state.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	state.PlaybookCandidates = plan.Candidates
	state.SelectedPlaybook = ""
	state.SelectedTemplate = ""
	state.SelectedPlaybooks = nil
	state.Composite = nil
	state.Reason = ""
	state.TemplateInjected = false
	state.Reports = map[string]*sessionstate.Report{}
	switch plan.Mode {
	case sessionstate.ModeSingle:
		state.SelectedPlaybook = plan.SelectedPlaybook
		state.SelectedTemplate = plan.SelectedTemplate
	case sessionstate.ModeMulti:
		state.SelectedPlaybooks = append([]sessionstate.PlaybookCandidate{}, plan.SelectedPlaybooks...)
	case sessionstate.ModeReport:
		state.SelectedPlaybook = plan.SelectedPlaybook
		state.SelectedTemplate = plan.SelectedTemplate
	case sessionstate.ModeFree:
		state.Reason = plan.Reason
	}
	return sessionstate.Save(root, sessionID, state)
}

func keywordHits(refs []harness.FileRef) []map[string]string {
	var hits []map[string]string
	for _, ref := range refs {
		if !strings.Contains(ref.Reason, "keyword: ") {
			continue
		}
		parts := strings.SplitN(ref.Reason, "keyword: ", 2)
		if len(parts) != 2 || parts[1] == "" {
			continue
		}
		hits = append(hits, map[string]string{"path": ref.Path, "keyword": parts[1]})
	}
	return hits
}

func ReadHookStdin() ([]byte, error) {
	var buf bytes.Buffer
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		buf.Write(scanner.Bytes())
		buf.WriteByte('\n')
	}
	return buf.Bytes(), scanner.Err()
}
