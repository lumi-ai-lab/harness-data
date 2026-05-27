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
	if len(plan.CoveredSpecs) > 0 {
		b.WriteString("coveredSpecs:\n")
		for _, spec := range plan.CoveredSpecs {
			b.WriteString("- ")
			b.WriteString(spec)
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
	return timeContext{
		CurrentDate: current.Format("2006-01-02"),
		Timezone:    timezone,
		TimePolicy:  fmt.Sprintf("Use %s to infer --date, --week, or --month. Do not use date ranges.", resolver.ResolveRel("spec/common/time-policy.md")),
		Prompt:      prompt,
	}
}

type reportSelection struct {
	Mode              string
	SelectedPlaybooks []sessionstate.PlaybookCandidate
	SelectedTemplate  string
	Composite         *sessionstate.CompositeSelection
}

func buildAdditionalContext(tc timeContext, response harness.ContextResponse, selection reportSelection, candidates []sessionstate.PlaybookCandidate) (string, error) {
	timeJSON, err := json.Marshal(tc)
	if err != nil {
		return "", err
	}
	mode := selection.Mode
	var b strings.Builder
	b.WriteString("# Data Harness Context\n\n")
	b.WriteString("时间解析 JSON：`")
	b.Write(timeJSON)
	b.WriteString("`\n\n")
	b.WriteString("必须先读取以下 contextFiles：\n")
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
	b.WriteString("\n读取完 contextFiles 后，再判断取数路径并执行数据 CLI。\n")
	b.WriteString("\nHarness mode: ")
	b.WriteString(mode)
	b.WriteString("\n")
	switch mode {
	case sessionstate.ModeTemplateReport:
		if response.Instruction != "" {
			b.WriteString("\nInstruction: ")
			b.WriteString(response.Instruction)
			b.WriteString("\n")
		}
	case sessionstate.ModeCompositeReport:
		b.WriteString("\nInstruction: 当前问题命中多个同域指标，进入多指标组合报告模式。读取全部 contextFiles 后，按 selected playbooks 完成取数；取数完成后执行 `bin/data-harness-cli inject-template`，最终必须使用组合 template 输出一份综合报告，不得分别套用多个单指标 template。\n")
		b.WriteString("\nSelected playbooks:\n")
		for _, candidate := range selection.SelectedPlaybooks {
			b.WriteString("- ")
			b.WriteString(candidate.Path)
			if candidate.Template != "" {
				b.WriteString(" -> ")
				b.WriteString(candidate.Template)
			}
			if candidate.Reason != "" {
				b.WriteString(" (")
				b.WriteString(candidate.Reason)
				b.WriteString(")")
			}
			b.WriteString("\n")
		}
		if selection.SelectedTemplate != "" {
			b.WriteString("\nComposite template: ")
			b.WriteString(selection.SelectedTemplate)
			b.WriteString("\n")
		}
	default:
		b.WriteString("\nInstruction: 当前没有唯一可用的 playbook/template，进入自由分析模式。不要执行 `bin/data-harness-cli inject-template`，不要读取 templates/ 下的报告模板。读取 contextFiles 后，基于 CLI 证据自由组织分析报告；候选 playbook 只能作为取数参考，不能作为模板门禁。\n")
		if len(candidates) > 0 {
			b.WriteString("\nPlaybook candidates for reference only:\n")
			for _, candidate := range candidates {
				b.WriteString("- ")
				b.WriteString(candidate.Path)
				if candidate.Template != "" {
					b.WriteString(" -> ")
					b.WriteString(candidate.Template)
				}
				if candidate.Reason != "" {
					b.WriteString(" (")
					b.WriteString(candidate.Reason)
					b.WriteString(")")
				}
				b.WriteString("\n")
			}
		}
	}
	b.WriteString("\nConstraints:\n")
	for _, constraint := range response.Constraints {
		b.WriteString("- ")
		b.WriteString(constraint)
		b.WriteString("\n")
	}
	if mode == sessionstate.ModeTemplateReport || mode == sessionstate.ModeCompositeReport {
		b.WriteString("\n禁止在 inject-template 成功前读取 templates/ 下的报告模板。\n")
	} else {
		b.WriteString("\n自由分析模式下禁止读取 templates/ 下的报告模板，禁止等待 template 注入。\n")
	}
	return b.String(), nil
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
	dir := filepath.Join(root, ".claude", "hooks", "state", "diagnostics")
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

func writeSelectedPlaybookState(root, sessionID, prompt string, candidates []sessionstate.PlaybookCandidate, selection reportSelection) error {
	state, err := sessionstate.Load(root, sessionID)
	if err != nil {
		return err
	}
	state.Mode = selection.Mode
	state.Prompt = prompt
	state.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	state.PlaybookCandidates = candidates
	state.SelectedPlaybook = ""
	state.SelectedTemplate = ""
	state.SelectedPlaybooks = nil
	state.Composite = nil
	state.TemplateInjected = false
	state.Reports = map[string]*sessionstate.Report{}
	if selection.Mode == sessionstate.ModeTemplateReport && len(candidates) == 1 {
		state.SelectedPlaybook = candidates[0].Path
		state.SelectedTemplate = candidates[0].Template
	}
	if selection.Mode == sessionstate.ModeCompositeReport {
		state.SelectedPlaybooks = selection.SelectedPlaybooks
		state.SelectedTemplate = selection.SelectedTemplate
		state.Composite = selection.Composite
	}
	return sessionstate.Save(root, sessionID, state)
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
	state.CoveredSpecs = nil
	state.Reason = ""
	state.TemplateInjected = false
	state.Reports = map[string]*sessionstate.Report{}
	switch plan.Mode {
	case sessionstate.ModeSingle:
		state.SelectedPlaybook = plan.SelectedPlaybook
		state.SelectedTemplate = plan.SelectedTemplate
	case sessionstate.ModeCombo:
		state.SelectedPlaybook = plan.SelectedPlaybook
		state.SelectedTemplate = plan.SelectedTemplate
		state.CoveredSpecs = append([]string{}, plan.CoveredSpecs...)
	case sessionstate.ModeFree:
		state.Reason = plan.Reason
	}
	return sessionstate.Save(root, sessionID, state)
}

func selectReportMode(prompt string, candidates []sessionstate.PlaybookCandidate) reportSelection {
	if len(candidates) == 1 {
		return reportSelection{Mode: sessionstate.ModeTemplateReport}
	}
	if selected, composite := compositePlaybooks(prompt, candidates); len(selected) >= 2 {
		return reportSelection{
			Mode:              sessionstate.ModeCompositeReport,
			SelectedPlaybooks: selected,
			SelectedTemplate:  compositeTemplateForDomain(composite.Domain),
			Composite:         composite,
		}
	}
	return reportSelection{Mode: sessionstate.ModeFreeAnalysis}
}

func compositePlaybooks(prompt string, candidates []sessionstate.PlaybookCandidate) ([]sessionstate.PlaybookCandidate, *sessionstate.CompositeSelection) {
	if len(candidates) < 2 || !hasCompositeSignal(prompt) {
		return nil, nil
	}
	byFamily := map[string][]sessionstate.PlaybookCandidate{}
	domainByFamily := map[string]string{}
	for _, candidate := range candidates {
		if candidate.Domain == "" || candidate.Template == "" {
			continue
		}
		if strings.Contains(candidate.Path, "/default-overview.md") {
			continue
		}
		family := playbookFamily(candidate.Path)
		if family == "" {
			continue
		}
		key := candidate.Domain + "\x00" + family
		byFamily[key] = append(byFamily[key], candidate)
		domainByFamily[key] = candidate.Domain
	}
	var best []sessionstate.PlaybookCandidate
	bestKey := ""
	for key, items := range byFamily {
		items = uniqueCandidates(items)
		if len(items) > len(best) || (len(items) == len(best) && preferCompositeFamily(key, bestKey)) {
			best = items
			bestKey = key
		}
	}
	if len(best) < 2 {
		return nil, nil
	}
	sort.Slice(best, func(i, j int) bool { return best[i].Path < best[j].Path })
	composite := &sessionstate.CompositeSelection{
		Type:    compositeType(prompt),
		Domain:  domainByFamily[bestKey],
		Metrics: metricNames(best),
	}
	return best, composite
}

func playbookFamily(path string) string {
	parts := strings.Split(path, "/")
	for i, part := range parts {
		if part != "playbooks" || i+2 >= len(parts) {
			continue
		}
		return parts[i+1] + "/" + parts[i+2]
	}
	return ""
}

func preferCompositeFamily(candidate, current string) bool {
	if current == "" {
		return true
	}
	candidateFamily := strings.SplitN(candidate, "\x00", 2)
	currentFamily := strings.SplitN(current, "\x00", 2)
	if len(candidateFamily) == 2 && len(currentFamily) == 2 {
		if candidateFamily[1] == "cmr/business" && currentFamily[1] != "cmr/business" {
			return true
		}
		if candidateFamily[1] != currentFamily[1] {
			return candidateFamily[1] < currentFamily[1]
		}
	}
	return candidate < current
}

func hasCompositeSignal(prompt string) bool {
	return hasAny(prompt, []string{"和", "与", "及", "以及", "还有", "同时", "一起", "都", "共同", "关系", "是否因为", "是不是因为", "影响", "带动", "拖累", "为什么", "原因", "归因"})
}

func compositeType(prompt string) string {
	switch {
	case hasAny(prompt, []string{"关系", "是否因为", "是不是因为", "影响", "带动", "拖累"}):
		return "relation"
	case hasAny(prompt, []string{"为什么", "原因", "归因", "哪些区域", "哪些品类"}):
		return "attribution"
	default:
		return "overview"
	}
}

func compositeTemplateForDomain(domain string) string {
	switch domain {
	case "business":
		return "templates/cmr/business/multi-metric-report.md"
	default:
		return "templates/common/multi-metric-report.md"
	}
}

func uniqueCandidates(candidates []sessionstate.PlaybookCandidate) []sessionstate.PlaybookCandidate {
	seen := map[string]bool{}
	var out []sessionstate.PlaybookCandidate
	for _, candidate := range candidates {
		if seen[candidate.Path] {
			continue
		}
		seen[candidate.Path] = true
		out = append(out, candidate)
	}
	return out
}

func metricNames(candidates []sessionstate.PlaybookCandidate) []string {
	var metrics []string
	for _, candidate := range candidates {
		name := strings.TrimSuffix(filepath.Base(candidate.Path), ".md")
		if name != "" {
			metrics = append(metrics, name)
		}
	}
	return metrics
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
