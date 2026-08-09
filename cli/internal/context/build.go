package context

import (
	"os"
	"path"
	"sort"
	"strings"

	"harness-data/cli/internal/harness"
	"harness-data/cli/internal/retrieval"
	"harness-data/cli/internal/sessionstate"
	"harness-data/cli/internal/wikis"
)

const multiSingleCandidateLimit = 20

var constraints = []string{
	"values_must_come_from_cli",
	"do_not_estimate_missing_values",
	"do_not_write_report_file_unless_requested",
	"do_not_read_or_use_templates_unless_selectedTemplate_is_set",
	"Metric queries use qdm-metric-cli only; when authz is on, Agent authz injects --data-auth/--auth-blob for analysis execute and --auth-blob for auth describe; to list current user scopes run auth describe; do not invent auth flags; do not call qdm-cmr-cli, qdm-indicators-cli, qdm-sql-cli, or cas-cli",
}

func Build(root, question string) (harness.ContextResponse, error) {
	response, _, err := BuildWithPlan(root, question)
	return response, err
}

type WikiPlan struct {
	Mode              string
	SelectedPlaybook  string
	SelectedTemplate  string
	SelectedPlaybooks []sessionstate.PlaybookCandidate
	Reason            string
	Candidates        []sessionstate.PlaybookCandidate
	TemplateSelection TemplateSelectionDiagnostic
}

type TemplateSelectionDiagnostic struct {
	Status     string                       `json:"status,omitempty"`
	Reason     string                       `json:"reason,omitempty"`
	Candidates []TemplateSelectionCandidate `json:"candidates,omitempty"`
}

type TemplateSelectionCandidate struct {
	Template       string   `json:"template"`
	Playbook       string   `json:"playbook"`
	Score          int      `json:"score"`
	Priority       int      `json:"priority,omitempty"`
	MatchedCovers  []string `json:"matchedCovers,omitempty"`
	MatchedIntents []string `json:"matchedIntents,omitempty"`
	Domain         string   `json:"domain,omitempty"`
	Type           string   `json:"type,omitempty"`
	ID             string   `json:"id,omitempty"`
}

func BuildWithPlan(root, question string) (harness.ContextResponse, WikiPlan, error) {
	index, err := wikis.LoadRuntimeIndex(root)
	if err != nil {
		return harness.ContextResponse{}, WikiPlan{}, err
	}
	return BuildWithRuntimeIndex(root, question, index)
}

func BuildWithRuntimeIndex(root, question string, index wikis.RuntimeIndex) (harness.ContextResponse, WikiPlan, error) {
	resolver, err := pathResolverForRuntimeIndex(root, index)
	if err != nil {
		return harness.ContextResponse{}, WikiPlan{}, err
	}
	response, plan := buildFromWikisRuntimeIndex(resolver, index, question)
	return response, plan, nil
}

func pathResolverForRuntimeIndex(root string, index wikis.RuntimeIndex) (harness.PathResolver, error) {
	if cfg, ok := pathsConfigFromIndex(index.Meta.Paths); ok {
		return harness.NewPathResolverWithPaths(root, cfg)
	}
	return harness.NewPathResolver(root)
}

func pathsConfigFromIndex(paths map[string]string) (harness.PathsConfig, bool) {
	if paths == nil {
		return harness.PathsConfig{}, false
	}
	cfg := harness.PathsConfig{
		Knowledge: strings.TrimSpace(paths["knowledge"]),
		Spec:      strings.TrimSpace(paths["spec"]),
		Routing:   strings.TrimSpace(paths["routing"]),
		Playbooks: strings.TrimSpace(paths["playbooks"]),
		Templates: strings.TrimSpace(paths["templates"]),
	}
	if cfg.Knowledge != "" && (cfg.Spec == "" || cfg.Playbooks == "" || cfg.Templates == "") {
		derived := harness.PathsConfig{
			Knowledge: cfg.Knowledge,
			Spec:      cfg.Knowledge + "/spec",
			Playbooks: cfg.Knowledge + "/playbooks",
			Templates: cfg.Knowledge + "/templates",
		}
		if cfg.Spec == "" {
			cfg.Spec = derived.Spec
		}
		if cfg.Playbooks == "" {
			cfg.Playbooks = derived.Playbooks
		}
		if cfg.Templates == "" {
			cfg.Templates = derived.Templates
		}
	}
	return cfg, cfg.Spec != "" && cfg.Playbooks != "" && cfg.Templates != ""
}

func buildFromWikisRuntimeIndex(resolver harness.PathResolver, index wikis.RuntimeIndex, question string) (harness.ContextResponse, WikiPlan) {
	byPath := index.DocsByPath
	var refs []harness.FileRef
	seen := map[string]bool{}
	add := func(logical, reason string) {
		if logical == "" {
			return
		}
		if !runtimeDocExists(resolver, byPath, logical) {
			return
		}
		physical := resolver.ResolveRel(logical)
		if seen[physical] {
			return
		}
		seen[physical] = true
		refs = append(refs, harness.FileRef{Path: physical, Reason: reason})
	}

	plan := WikiPlan{Mode: sessionstate.ModeFree, Reason: "no_recall_hit"}

	matches := RecallMatches(index, question, 0)
	hits := recallHitsFromMatches(index, matches)
	ordinarySpecs, conceptSpecs := classifyHits(hits)
	ordinarySpecs = collapseEquivalentMetricSpecs(ordinarySpecs)
	conceptSpecs = includeSpecificReportConcepts(byPath, question, conceptSpecs)
	sortRuntimeDocsByPath(ordinarySpecs)
	sortRuntimeDocsByPath(conceptSpecs)

	// Always inject Metric CLI usage docs when present in the knowledge tree.
	add("rules/qdm-metric-cli/spec.md", "default metric cli usage")

	addDefaultFreeFiles := func() {
		add("index.md", "default knowledge index")
		add("metrics/index.md", "default metrics index")
		add("reports/index.md", "default reports index")
		add("dims/index.md", "default dims index")
		add("rules/index.md", "default rules index")
	}
	selectedReport, hasSelectedReport := selectReportConcept(resolver, byPath, index.TemplateSelection, question, matches, conceptSpecs)
	addSelectedReport := func(selected selectedReportConcept) {
		plan = selected.Plan
		addNearestIndex(add, byPath, selected.Spec.Path, "report index")
		add(selected.Spec.Path, "matched report spec")
		add(selected.Playbook.Path, "selected report playbook")
	}
	switch {
	case hasSelectedReport && shouldPrioritizeReportConcept(question, selectedReport):
		addSelectedReport(selectedReport)
	case len(ordinarySpecs) == 1:
		spec := ordinarySpecs[0]
		if wikis.IsReferenceSpecPath(spec.Path) {
			plan.Reason = "reference_spec"
			addFreeSpecFiles(add, byPath, []wikis.RuntimeDocument{spec})
			break
		}
		playbookPath := wikis.SamePath(spec.Path, "playbooks")
		if runtimeDocExists(resolver, byPath, playbookPath) {
			plan = WikiPlan{Mode: sessionstate.ModeSingle, SelectedPlaybook: playbookPath}
			add(playbookPath, "selected playbook")
			break
		}
		plan.Reason = "single_spec_missing_playbook"
		addFreeSpecFiles(add, byPath, []wikis.RuntimeDocument{spec})
	case len(ordinarySpecs) > 1:
		if candidates, reason, ok := multiSingleCandidates(resolver, byPath, question, ordinarySpecs); ok {
			plan = WikiPlan{
				Mode:              sessionstate.ModeMulti,
				SelectedPlaybooks: candidates,
			}
			for _, candidate := range candidates {
				add(candidate.Path, "selected playbook")
			}
			break
		} else if reason == "multi_single_candidate_limit_exceeded" {
			plan.Reason = reason
			addDefaultFreeFiles()
			break
		}
		plan.Reason = "multi_metric_non_direct"
		addFreeSpecFiles(add, byPath, ordinarySpecs)
	case len(conceptSpecs) > 0:
		if hasSelectedReport {
			addSelectedReport(selectedReport)
			break
		}
		if len(conceptSpecs) == 1 && isReportSpecPath(conceptSpecs[0].Path) {
			spec := conceptSpecs[0]
			if !isReportIntentQuestion(question) && !hasExactRecallMatch(matches, spec.Path) {
				addDefaultFreeFiles()
				break
			}
			plan.Reason = "report_spec_missing_playbook"
			addNearestIndex(add, byPath, spec.Path, "spec index")
			add(spec.Path, "matched concept spec")
		} else {
			plan.Reason = "concept_only"
			for _, spec := range conceptSpecs {
				addNearestIndex(add, byPath, spec.Path, "spec index")
				add(spec.Path, "matched concept spec")
			}
		}
	default:
		addDefaultFreeFiles()
	}
	plan.Candidates = append(plan.Candidates, candidatesFromPlan(plan, byPath)...)
	response := harness.ContextResponse{
		Question:     question,
		ContextFiles: refs,
		Instruction:  instructionForPlan(plan),
		Constraints:  constraints,
	}
	return response, plan
}

func shouldPrioritizeReportConcept(question string, selected selectedReportConcept) bool {
	if selected.Exact || selected.OrgSpecific {
		return true
	}
	return isReportIntentQuestion(question) &&
		selected.Plan.TemplateSelection.Status == "selected" &&
		selected.Plan.TemplateSelection.Reason == "covers_all_specs"
}

func recallHits(index wikis.RuntimeIndex, question string) []wikis.RuntimeDocument {
	return recallHitsFromMatches(index, RecallMatches(index, question, 0))
}

func recallHitsFromMatches(index wikis.RuntimeIndex, matches []retrieval.Match) []wikis.RuntimeDocument {
	byPath := index.DocsByPath
	seen := map[string]bool{}
	var docs []wikis.RuntimeDocument
	for _, match := range matches {
		if seen[match.TargetPath] {
			continue
		}
		doc, ok := byPath[match.TargetPath]
		if !ok {
			continue
		}
		seen[match.TargetPath] = true
		docs = append(docs, doc)
	}
	return docs
}

func hasExactRecallMatch(matches []retrieval.Match, targetPath string) bool {
	for _, match := range matches {
		if match.TargetPath == targetPath && match.Exact {
			return true
		}
	}
	return false
}

func exactRecallMatchLen(matches []retrieval.Match, targetPath string) (bool, int) {
	exact := false
	maxLen := 0
	for _, match := range matches {
		if match.TargetPath != targetPath || !match.Exact {
			continue
		}
		exact = true
		if match.TermRuneLen > maxLen {
			maxLen = match.TermRuneLen
		}
	}
	return exact, maxLen
}

func RecallMatches(index wikis.RuntimeIndex, question string, top int) []retrieval.Match {
	items := make([]retrieval.Item, 0, len(index.Recall))
	for _, item := range index.Recall {
		items = append(items, retrieval.Item{Term: item.Term, TargetPath: item.TargetPath})
	}
	return retrieval.Search(items, question, retrieval.Options{TopN: top})
}

func classifyHits(hits []wikis.RuntimeDocument) ([]wikis.RuntimeDocument, []wikis.RuntimeDocument) {
	var ordinarySpecs, conceptSpecs []wikis.RuntimeDocument
	for _, doc := range hits {
		switch {
		case doc.Kind == wikis.KindSpec && doc.SpecType == wikis.SpecTypeMetric:
			ordinarySpecs = append(ordinarySpecs, doc)
		case doc.Kind == wikis.KindSpec && doc.SpecType == wikis.SpecTypeConcept:
			conceptSpecs = append(conceptSpecs, doc)
		}
	}
	return ordinarySpecs, conceptSpecs
}

func includeSpecificReportConcepts(byPath map[string]wikis.RuntimeDocument, question string, specs []wikis.RuntimeDocument) []wikis.RuntimeDocument {
	for _, profitAnalysisSpec := range profitAnalysisSpecPaths() {
		if !isOrganizationProfitSalesReportSpec(profitAnalysisSpec, question) {
			continue
		}
		if hasRuntimeDoc(specs, profitAnalysisSpec) {
			return specs
		}
		doc, ok := byPath[profitAnalysisSpec]
		if !ok || doc.Kind != wikis.KindSpec || doc.SpecType != wikis.SpecTypeConcept {
			continue
		}
		return append(specs, doc)
	}
	return specs
}

func hasRuntimeDoc(docs []wikis.RuntimeDocument, docPath string) bool {
	for _, doc := range docs {
		if doc.Path == docPath {
			return true
		}
	}
	return false
}

func sortRuntimeDocsByPath(docs []wikis.RuntimeDocument) {
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
}

func collapseEquivalentMetricSpecs(specs []wikis.RuntimeDocument) []wikis.RuntimeDocument {
	byKey := map[string]wikis.RuntimeDocument{}
	for _, spec := range specs {
		key := metricIdentityKey(spec.Path)
		if existing, ok := byKey[key]; ok && preferMetricSpec(existing, spec) {
			continue
		}
		byKey[key] = spec
	}
	out := make([]wikis.RuntimeDocument, 0, len(byKey))
	for _, spec := range byKey {
		out = append(out, spec)
	}
	sortRuntimeDocsByPath(out)
	return out
}

func metricIdentityKey(logical string) string {
	if strings.HasPrefix(logical, "metrics/") {
		return path.Dir(logical)
	}
	return path.Base(logical)
}

func preferMetricSpec(current, candidate wikis.RuntimeDocument) bool {
	if strings.HasPrefix(current.Domain, "cmr/") != strings.HasPrefix(candidate.Domain, "cmr/") {
		return strings.HasPrefix(current.Domain, "cmr/")
	}
	return current.Path < candidate.Path
}

func addNearestIndex(add func(string, string), byPath map[string]wikis.RuntimeDocument, docPath, reason string) {
	dir := path.Dir(docPath)
	if dir == "." {
		return
	}
	indexPath := path.Join(dir, "index.md")
	if indexPath == docPath {
		return
	}
	if _, ok := byPath[indexPath]; ok {
		add(indexPath, reason)
	}
}

func addFreeSpecFiles(add func(string, string), byPath map[string]wikis.RuntimeDocument, specs []wikis.RuntimeDocument) {
	for _, spec := range specs {
		addNearestIndex(add, byPath, spec.Path, "spec index")
		add(spec.Path, "matched spec")
		if wikis.IsReferenceSpecPath(spec.Path) {
			continue
		}
		playbookPath := wikis.SamePath(spec.Path, "playbooks")
		if _, ok := byPath[playbookPath]; ok {
			addNearestIndex(add, byPath, playbookPath, "playbook index")
			add(playbookPath, "matched playbook")
		}
	}
}

func runtimeDocExists(resolver harness.PathResolver, byPath map[string]wikis.RuntimeDocument, logical string) bool {
	if _, ok := byPath[logical]; !ok {
		return false
	}
	info, err := os.Stat(resolver.Resolve(logical))
	return err == nil && !info.IsDir()
}

func isReportSpecPath(logical string) bool {
	if strings.HasPrefix(logical, "reports/") {
		return path.Base(logical) == "spec.md"
	}
	return strings.HasPrefix(logical, "spec/") && strings.HasPrefix(path.Base(logical), "r-")
}

func isReportIntentQuestion(question string) bool {
	return hasAny(question, []string{
		"报告",
		"诊断",
		"经营分析",
		"综合分析",
		"整体分析",
		"经营大盘",
		"业务大盘",
		"生成经营",
	})
}

type selectedReportConcept struct {
	Plan             WikiPlan
	Spec             wikis.RuntimeDocument
	Playbook         wikis.RuntimeDocument
	OrgSpecific      bool
	Exact            bool
	ExactTermRuneLen int
	TemplateScore    int
	TemplatePriority int
}

func selectReportConcept(resolver harness.PathResolver, byPath map[string]wikis.RuntimeDocument, rules []wikis.TemplateSelectionRule, question string, matches []retrieval.Match, specs []wikis.RuntimeDocument) (selectedReportConcept, bool) {
	reportIntent := isReportIntentQuestion(question)
	var candidates []selectedReportConcept
	for _, spec := range specs {
		if !isReportSpecPath(spec.Path) {
			continue
		}
		exact, exactLen := exactRecallMatchLen(matches, spec.Path)
		orgSpecific := isOrganizationProfitSalesReportSpec(spec.Path, question)
		if !reportIntent && !exact && !orgSpecific {
			continue
		}
		playbookPath := wikis.SamePath(spec.Path, "playbooks")
		if !runtimeDocExists(resolver, byPath, playbookPath) {
			continue
		}
		playbook := byPath[playbookPath]
		selection := selectTemplate(rules, question, []wikis.RuntimeDocument{spec}, playbookPath)
		selectedTemplate := selectedTemplateFromDiagnostic(selection)
		if selectedTemplate == "" && selection.Status == "none" && selection.Reason == "no_selection_policy" {
			selectedTemplate = existingPlaybookTemplatePath(resolver, byPath, playbook)
		}
		templateScore, templatePriority := templateSelectionScore(selection)
		candidates = append(candidates, selectedReportConcept{
			Plan: WikiPlan{
				Mode:              sessionstate.ModeReport,
				SelectedPlaybook:  playbookPath,
				SelectedTemplate:  selectedTemplate,
				TemplateSelection: selection,
			},
			Spec:             spec,
			Playbook:         playbook,
			OrgSpecific:      orgSpecific,
			Exact:            exact,
			ExactTermRuneLen: exactLen,
			TemplateScore:    templateScore,
			TemplatePriority: templatePriority,
		})
	}
	if len(candidates) == 0 {
		return selectedReportConcept{}, false
	}
	if !reportIntent && !hasOrgSpecificReportCandidate(candidates) && reportSpecCount(specs) > 1 {
		return selectedReportConcept{}, false
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.OrgSpecific != b.OrgSpecific {
			return a.OrgSpecific
		}
		if a.Exact != b.Exact {
			return a.Exact
		}
		if a.ExactTermRuneLen != b.ExactTermRuneLen {
			return a.ExactTermRuneLen > b.ExactTermRuneLen
		}
		if a.TemplateScore != b.TemplateScore {
			return a.TemplateScore > b.TemplateScore
		}
		if a.TemplatePriority != b.TemplatePriority {
			return a.TemplatePriority > b.TemplatePriority
		}
		return a.Spec.Path < b.Spec.Path
	})
	return candidates[0], true
}

func hasOrgSpecificReportCandidate(candidates []selectedReportConcept) bool {
	for _, candidate := range candidates {
		if candidate.OrgSpecific {
			return true
		}
	}
	return false
}

func reportSpecCount(specs []wikis.RuntimeDocument) int {
	count := 0
	for _, spec := range specs {
		if isReportSpecPath(spec.Path) {
			count++
		}
	}
	return count
}

func isOrganizationProfitSalesReportSpec(specPath, question string) bool {
	if !isProfitAnalysisSpecPath(specPath) {
		return false
	}
	return hasAny(question, []string{"门店", "所有门店", "管理区域", "大区", "督导"}) &&
		hasAny(question, []string{"盈利情况", "销售情况"})
}

func isProfitAnalysisSpecPath(specPath string) bool {
	for _, candidate := range profitAnalysisSpecPaths() {
		if specPath == candidate {
			return true
		}
	}
	return false
}

func profitAnalysisSpecPaths() []string {
	return []string{
		"reports/盈利情况分析报告/spec.md",
		"spec/indicators/business/r-profit-analysis-report.md",
	}
}

func templateSelectionScore(selection TemplateSelectionDiagnostic) (int, int) {
	if len(selection.Candidates) == 0 {
		return 0, 0
	}
	return selection.Candidates[0].Score, selection.Candidates[0].Priority
}

func multiSingleCandidates(resolver harness.PathResolver, byPath map[string]wikis.RuntimeDocument, question string, specs []wikis.RuntimeDocument) ([]sessionstate.PlaybookCandidate, string, bool) {
	if len(specs) < 2 || isNonDirectMultiSingleQuestion(question) {
		return nil, "", false
	}
	var candidates []sessionstate.PlaybookCandidate
	var playbooks []wikis.RuntimeDocument
	seen := map[string]bool{}
	for _, spec := range specs {
		if wikis.IsReferenceSpecPath(spec.Path) {
			return nil, "", false
		}
		playbookPath := wikis.SamePath(spec.Path, "playbooks")
		if !runtimeDocExists(resolver, byPath, playbookPath) {
			return nil, "", false
		}
		doc, ok := byPath[playbookPath]
		if !ok || seen[doc.Path] {
			continue
		}
		candidate := candidateFromDoc(doc, "selected")
		candidate.Template = ""
		candidates = append(candidates, candidate)
		playbooks = append(playbooks, doc)
		seen[doc.Path] = true
		if len(candidates) > multiSingleCandidateLimit {
			return nil, "multi_single_candidate_limit_exceeded", false
		}
	}
	if !playbooksSupportQuestionIntents(question, playbooks) {
		return nil, "", false
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Path < candidates[j].Path })
	return candidates, "", len(candidates) >= 2
}

func isNonDirectMultiSingleQuestion(question string) bool {
	return hasAny(question, []string{"为什么", "原因", "归因", "影响", "带动", "拖累", "波动", "下降", "上升", "下滑", "增长", "关系", "拆解", "分析", "概览", "报告"})
}

func playbooksSupportQuestionIntents(question string, playbooks []wikis.RuntimeDocument) bool {
	if len(playbooks) < 2 {
		return false
	}
	return !isNonDirectMultiSingleQuestion(question)
}

func playbookSupportsQuestionIntent(question string, playbook wikis.RuntimeDocument) bool {
	if playbook.Playbook == nil {
		return false
	}
	for _, intent := range playbook.Playbook.Intents {
		if hasAny(question, intent.Aliases) {
			return true
		}
	}
	return false
}

func isLegacyMultiSingleValueQuestion(question string) bool {
	if hasAny(question, []string{"分析", "拆解", "走势", "趋势"}) {
		return false
	}
	return hasAny(question, []string{"多少", "是多少", "值", "数值", "看一下", "查一下", "看看", "查询", "分别", "还有", "和", "与", "及", "以及", "都"})
}

func candidatesFromPlan(plan WikiPlan, byPath map[string]wikis.RuntimeDocument) []sessionstate.PlaybookCandidate {
	if plan.Mode == sessionstate.ModeMulti {
		return append([]sessionstate.PlaybookCandidate{}, plan.SelectedPlaybooks...)
	}
	if plan.SelectedPlaybook == "" {
		return nil
	}
	doc, ok := byPath[plan.SelectedPlaybook]
	if !ok {
		return nil
	}
	candidate := candidateFromDoc(doc, "selected")
	candidate.Template = plan.SelectedTemplate
	return []sessionstate.PlaybookCandidate{candidate}
}

func candidateFromDoc(doc wikis.RuntimeDocument, reason string) sessionstate.PlaybookCandidate {
	return sessionstate.PlaybookCandidate{
		Path:     doc.Path,
		Template: playbookTemplatePath(doc),
		Domain:   doc.Domain,
		Reason:   reason,
	}
}

func existingPlaybookTemplatePath(resolver harness.PathResolver, byPath map[string]wikis.RuntimeDocument, doc wikis.RuntimeDocument) string {
	templatePath := playbookTemplatePath(doc)
	if templatePath == "" || !runtimeDocExists(resolver, byPath, templatePath) {
		return ""
	}
	return templatePath
}

func playbookTemplatePath(doc wikis.RuntimeDocument) string {
	if doc.Playbook == nil {
		return ""
	}
	return doc.Playbook.TemplatePath
}

func selectedTemplateFromDiagnostic(selection TemplateSelectionDiagnostic) string {
	if selection.Status != "selected" || len(selection.Candidates) == 0 {
		return ""
	}
	return selection.Candidates[0].Template
}

func selectTemplate(rules []wikis.TemplateSelectionRule, question string, specs []wikis.RuntimeDocument, playbookPath string) TemplateSelectionDiagnostic {
	if len(rules) == 0 {
		return TemplateSelectionDiagnostic{Status: "none", Reason: "no_selection_policy"}
	}
	specPaths := map[string]bool{}
	for _, spec := range specs {
		specPaths[spec.Path] = true
	}
	questionIntents := inferTemplateQuestionIntents(question)
	var candidates []TemplateSelectionCandidate
	for _, rule := range rules {
		if rule.Playbook != playbookPath {
			continue
		}
		candidate := scoreTemplateSelectionRule(rule, specPaths, questionIntents)
		if candidate.Score <= 0 {
			continue
		}
		candidates = append(candidates, candidate)
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Score != candidates[j].Score {
			return candidates[i].Score > candidates[j].Score
		}
		if candidates[i].Priority != candidates[j].Priority {
			return candidates[i].Priority > candidates[j].Priority
		}
		return candidates[i].Template < candidates[j].Template
	})
	if len(candidates) == 0 {
		return TemplateSelectionDiagnostic{Status: "none", Reason: "no_candidate"}
	}
	if len(candidates) > 1 && candidates[0].Score == candidates[1].Score && candidates[0].Priority == candidates[1].Priority {
		return TemplateSelectionDiagnostic{Status: "ambiguous", Reason: "top_candidates_tied", Candidates: candidates}
	}
	statusReason := "best_score"
	if coversAll(candidates[0].MatchedCovers, specPaths) {
		statusReason = "covers_all_specs"
	}
	return TemplateSelectionDiagnostic{Status: "selected", Reason: statusReason, Candidates: candidates}
}

func scoreTemplateSelectionRule(rule wikis.TemplateSelectionRule, specPaths map[string]bool, questionIntents map[string]bool) TemplateSelectionCandidate {
	candidate := TemplateSelectionCandidate{
		Template: rule.Template,
		Playbook: rule.Playbook,
		Priority: rule.Priority,
		Domain:   rule.Domain,
		Type:     rule.Type,
		ID:       rule.ID,
	}
	for _, cover := range rule.Covers {
		if specPaths[cover] {
			candidate.MatchedCovers = append(candidate.MatchedCovers, cover)
		}
	}
	for _, intent := range rule.Intents {
		if questionIntents[intent] {
			candidate.MatchedIntents = append(candidate.MatchedIntents, intent)
		}
	}
	if len(candidate.MatchedCovers) == 0 && len(candidate.MatchedIntents) == 0 {
		return candidate
	}
	candidate.Score = rule.Priority
	candidate.Score += len(candidate.MatchedCovers) * 100
	candidate.Score += len(candidate.MatchedIntents) * 20
	if coversAll(candidate.MatchedCovers, specPaths) {
		candidate.Score += 50
	}
	if rule.Type == "report" || rule.Type == "composite" {
		candidate.Score += 10
	}
	sort.Strings(candidate.MatchedCovers)
	sort.Strings(candidate.MatchedIntents)
	return candidate
}

func coversAll(covers []string, specPaths map[string]bool) bool {
	if len(specPaths) == 0 {
		return false
	}
	covered := map[string]bool{}
	for _, cover := range covers {
		covered[cover] = true
	}
	for spec := range specPaths {
		if !covered[spec] {
			return false
		}
	}
	return true
}

func inferTemplateQuestionIntents(question string) map[string]bool {
	intents := map[string]bool{}
	if isReportIntentQuestion(question) {
		intents["report"] = true
	}
	if hasAny(question, []string{"诊断", "原因", "归因", "分析", "为什么"}) {
		intents["diagnosis"] = true
	}
	if hasAny(question, []string{"趋势", "走势", "变化"}) {
		intents["trend"] = true
	}
	if hasAny(question, []string{"多少", "是多少", "当前", "现在", "查一下", "看一下"}) {
		intents["current_value"] = true
	}
	return intents
}

func instructionForPlan(plan WikiPlan) string {
	common := "All modes: read all contextFiles before running data CLI. Numeric values must come from CLI; do not estimate or invent. Deliver Harness analysis results, query results, reports, summaries, and diagnostic conclusions directly in the conversation by default. Do not write final results or intermediate analysis results to files unless the user explicitly asks to export, save, or generate a file. Metric CLI uses encrypted auth-blob via Agent authz hook/wrapper. When the user asks about their data permissions or scopes, run qdm-metric-cli auth describe."
	switch plan.Mode {
	case sessionstate.ModeSingle:
		return common + " Harness mode: single. selectedPlaybook=" + plan.SelectedPlaybook + ". In single mode, only run data CLI commands explicitly described by selectedPlaybook. If the primary indicator command returns empty items or null values, do not switch to a broader report command unless selectedPlaybook explicitly says so; report the missing CLI evidence instead. Do not derive the primary metric by summing or transforming breakdown rows unless selectedPlaybook explicitly instructs it. After selected playbook data collection, answer the metric value directly with the CLI evidence. Do not run bin/data-harness-cli inject-template, and do not read, open, guess, or use template files."
	case sessionstate.ModeMulti:
		return common + " Harness mode: multi_single. Read every selected playbook in contextFiles. Apply the same user-specified filters to each metric unless a playbook says otherwise. For each metric, default to current-value collection unless the question explicitly asks for a supported non-default entry such as trend or area performance. Answer with those per-metric results and shared口径. Do not run bin/data-harness-cli inject-template, do not use template files, and do not turn this into a report-style analysis."
	case sessionstate.ModeReport:
		templateInstruction := "After report playbook data collection and evidence preparation, run bin/data-harness-cli stage template. Do not read, open, guess, or use template files before stage template. Only after the PostToolUse hook injects selectedTemplate may you generate the final report body."
		if plan.SelectedTemplate == "" {
			templateInstruction = "No selectedTemplate is available; after report playbook data collection, answer directly with CLI evidence and do not read, open, guess, or use template files."
		}
		return common + " Harness mode: report. selectedPlaybook=" + plan.SelectedPlaybook + " selectedTemplate=" + plan.SelectedTemplate + ". Read the report index when present, the matched report spec, and the selected report playbook in contextFiles. Use the report index as the Agent knowledge directory, the report playbook for data collection and JSON handling, and the report spec for business reasoning. Do not run single-metric playbooks unless the selected report playbook explicitly asks for a drilldown. " + templateInstruction
	default:
		return common + " Harness mode: free. reason=" + plan.Reason + ". Do not run bin/data-harness-cli inject-template. Do not read, open, guess, or use template files. You may reference specs/playbooks, but must not apply any template."
	}
}

func hasAny(s string, keywords []string) bool {
	for _, kw := range keywords {
		if kw != "" && strings.Contains(s, kw) {
			return true
		}
	}
	return false
}

func isCoveredKeyword(keyword string, keywords []string) bool {
	if keyword == "" {
		return false
	}
	for _, other := range keywords {
		if other != keyword && strings.Contains(other, keyword) {
			return true
		}
	}
	return false
}
