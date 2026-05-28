package context

import (
	"path"
	"sort"
	"strings"

	"harness-data/cli/internal/harness"
	idx "harness-data/cli/internal/index"
	"harness-data/cli/internal/retrieval"
	"harness-data/cli/internal/sessionstate"
	"harness-data/cli/internal/wikis"
)

var constraints = []string{
	"values_must_come_from_cli",
	"do_not_estimate_missing_values",
	"do_not_write_report_file_unless_requested",
	"do_not_read_template_before_inject_template",
}

func Build(root, question string) (harness.ContextResponse, error) {
	response, _, err := BuildWithPlan(root, question)
	return response, err
}

type WikiPlan struct {
	Mode             string
	SelectedPlaybook string
	SelectedTemplate string
	CoveredSpecs     []string
	Reason           string
	Candidates       []sessionstate.PlaybookCandidate
}

func BuildWithPlan(root, question string) (harness.ContextResponse, WikiPlan, error) {
	index, err := wikis.LoadRuntimeIndex(root)
	if err != nil {
		return harness.ContextResponse{}, WikiPlan{}, err
	}
	return BuildWithRuntimeIndex(root, question, index)
}

func BuildWithRuntimeIndex(root, question string, index wikis.RuntimeIndex) (harness.ContextResponse, WikiPlan, error) {
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return harness.ContextResponse{}, WikiPlan{}, err
	}
	response, plan := buildFromWikisRuntimeIndex(resolver, index, question)
	return response, plan, nil
}

func buildFromWikisRuntimeIndex(resolver harness.PathResolver, index wikis.RuntimeIndex, question string) (harness.ContextResponse, WikiPlan) {
	byPath := index.DocsByPath
	var refs []harness.FileRef
	seen := map[string]bool{}
	add := func(logical, reason string) {
		if logical == "" {
			return
		}
		if _, ok := byPath[logical]; !ok {
			return
		}
		physical := resolver.ResolveRel(logical)
		if seen[physical] {
			return
		}
		seen[physical] = true
		refs = append(refs, harness.FileRef{Path: physical, Reason: reason})
	}

	hits := recallHits(index, question)
	ordinarySpecs, conceptSpecs, directCombos := classifyHits(hits)
	ordinarySpecs = collapseEquivalentMetricSpecs(ordinarySpecs)
	sortRuntimeDocsByPath(ordinarySpecs)
	sortRuntimeDocsByPath(conceptSpecs)
	sortRuntimeDocsByPath(directCombos)

	plan := WikiPlan{Mode: sessionstate.ModeFree, Reason: "no_recall_hit"}
	switch {
	case len(directCombos) == 1:
		combo := directCombos[0]
		plan = WikiPlan{
			Mode:             sessionstate.ModeCombo,
			SelectedPlaybook: combo.Path,
			SelectedTemplate: playbookTemplatePath(combo),
			CoveredSpecs:     append([]string{}, combo.Covers...),
		}
		addComboFiles(add, byPath, combo)
	case len(directCombos) > 1:
		plan.Reason = "multiple_combo_alias_hits"
		for _, combo := range directCombos {
			addComboFiles(add, byPath, combo)
		}
	case len(ordinarySpecs) == 1:
		spec := ordinarySpecs[0]
		playbookPath := wikis.SamePath(spec.Path, "playbooks")
		templatePath := wikis.SamePath(spec.Path, "templates")
		if _, ok := byPath[playbookPath]; ok {
			if _, ok := byPath[templatePath]; ok {
				plan = WikiPlan{Mode: sessionstate.ModeSingle, SelectedPlaybook: playbookPath, SelectedTemplate: templatePath}
				addNearestIndex(add, byPath, spec.Path, "spec index")
				add(spec.Path, "matched spec")
				addNearestIndex(add, byPath, playbookPath, "playbook index")
				add(playbookPath, "selected playbook")
				break
			}
		}
		plan.Reason = "single_spec_missing_playbook_or_template"
		addFreeSpecFiles(add, byPath, []wikis.RuntimeDocument{spec})
	case len(ordinarySpecs) > 1:
		candidates := coveringCombos(allRuntimeDocs(index.DocsByPath), ordinarySpecs)
		if len(candidates) == 1 {
			combo := candidates[0]
			plan = WikiPlan{
				Mode:             sessionstate.ModeCombo,
				SelectedPlaybook: combo.Path,
				SelectedTemplate: playbookTemplatePath(combo),
				CoveredSpecs:     append([]string{}, combo.Covers...),
			}
			addComboFiles(add, byPath, combo)
		} else if len(candidates) > 1 {
			plan.Reason = "multiple_combo_candidates_tied"
			for _, combo := range candidates {
				addComboFiles(add, byPath, combo)
				plan.Candidates = append(plan.Candidates, candidateFromDoc(combo, "combo candidate"))
			}
		} else {
			plan.Reason = "no_combo_covers_all_specs"
			addFreeSpecFiles(add, byPath, ordinarySpecs)
		}
	case len(conceptSpecs) > 0:
		plan.Reason = "concept_only"
		for _, spec := range conceptSpecs {
			addNearestIndex(add, byPath, spec.Path, "spec index")
			add(spec.Path, "matched concept spec")
		}
	default:
		add("spec/index.md", "default free spec index")
		add("playbooks/index.md", "default free playbook index")
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

func recallHits(index wikis.RuntimeIndex, question string) []wikis.RuntimeDocument {
	byPath := index.DocsByPath
	matches := RecallMatches(index, question, 0)
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

func RecallMatches(index wikis.RuntimeIndex, question string, top int) []retrieval.Match {
	items := make([]retrieval.Item, 0, len(index.Recall))
	for _, item := range index.Recall {
		items = append(items, retrieval.Item{Term: item.Term, TargetPath: item.TargetPath})
	}
	return retrieval.Search(items, question, retrieval.Options{TopN: top})
}

func classifyHits(hits []wikis.RuntimeDocument) ([]wikis.RuntimeDocument, []wikis.RuntimeDocument, []wikis.RuntimeDocument) {
	var ordinarySpecs, conceptSpecs, directCombos []wikis.RuntimeDocument
	for _, doc := range hits {
		switch {
		case doc.Kind == wikis.KindSpec && doc.SpecType == wikis.SpecTypeMetric:
			ordinarySpecs = append(ordinarySpecs, doc)
		case doc.Kind == wikis.KindSpec && doc.SpecType == wikis.SpecTypeConcept:
			conceptSpecs = append(conceptSpecs, doc)
		case doc.Kind == wikis.KindPlaybook && playbookIsCombo(doc):
			directCombos = append(directCombos, doc)
		}
	}
	return ordinarySpecs, conceptSpecs, directCombos
}

func sortRuntimeDocsByPath(docs []wikis.RuntimeDocument) {
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
}

func collapseEquivalentMetricSpecs(specs []wikis.RuntimeDocument) []wikis.RuntimeDocument {
	byKey := map[string]wikis.RuntimeDocument{}
	for _, spec := range specs {
		key := path.Base(spec.Path)
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
		playbookPath := wikis.SamePath(spec.Path, "playbooks")
		if _, ok := byPath[playbookPath]; ok {
			addNearestIndex(add, byPath, playbookPath, "playbook index")
			add(playbookPath, "matched playbook")
		}
	}
}

func addComboFiles(add func(string, string), byPath map[string]wikis.RuntimeDocument, combo wikis.RuntimeDocument) {
	addNearestIndex(add, byPath, combo.Path, "combo playbook index")
	add(combo.Path, "selected combo playbook")
	covers := append([]string{}, combo.Covers...)
	sort.Strings(covers)
	for _, cover := range covers {
		if isSingleMetricSpecPath(cover) {
			continue
		}
		addNearestIndex(add, byPath, cover, "covered spec index")
		add(cover, "covered spec")
	}
}

func isSingleMetricSpecPath(logical string) bool {
	return strings.HasPrefix(logical, "spec/") && strings.HasPrefix(path.Base(logical), "s-")
}

func coveringCombos(docs []wikis.RuntimeDocument, specs []wikis.RuntimeDocument) []wikis.RuntimeDocument {
	required := map[string]bool{}
	commonDomain := ""
	for i, spec := range specs {
		required[spec.Path] = true
		if i == 0 {
			commonDomain = spec.Domain
		} else if commonDomain != spec.Domain {
			commonDomain = ""
		}
	}
	var candidates []wikis.RuntimeDocument
	for _, doc := range docs {
		if doc.Kind != wikis.KindPlaybook || !playbookIsCombo(doc) || playbookTemplatePath(doc) == "" {
			continue
		}
		covered := map[string]bool{}
		for _, cover := range doc.Covers {
			covered[cover] = true
		}
		ok := true
		for specPath := range required {
			if !covered[specPath] {
				ok = false
				break
			}
		}
		if ok {
			candidates = append(candidates, doc)
		}
	}
	if len(candidates) <= 1 {
		return candidates
	}
	minCovers := len(candidates[0].Covers)
	for _, candidate := range candidates[1:] {
		if len(candidate.Covers) < minCovers {
			minCovers = len(candidate.Covers)
		}
	}
	candidates = filterCombos(candidates, func(doc wikis.RuntimeDocument) bool { return len(doc.Covers) == minCovers })
	if len(candidates) <= 1 || commonDomain == "" {
		return candidates
	}
	domainMatches := filterCombos(candidates, func(doc wikis.RuntimeDocument) bool { return doc.Domain == commonDomain })
	if len(domainMatches) > 0 {
		candidates = domainMatches
	}
	sortRuntimeDocsByPath(candidates)
	return candidates
}

func filterCombos(docs []wikis.RuntimeDocument, keep func(wikis.RuntimeDocument) bool) []wikis.RuntimeDocument {
	var out []wikis.RuntimeDocument
	for _, doc := range docs {
		if keep(doc) {
			out = append(out, doc)
		}
	}
	return out
}

func candidatesFromPlan(plan WikiPlan, byPath map[string]wikis.RuntimeDocument) []sessionstate.PlaybookCandidate {
	if plan.SelectedPlaybook == "" {
		return nil
	}
	doc, ok := byPath[plan.SelectedPlaybook]
	if !ok {
		return nil
	}
	return []sessionstate.PlaybookCandidate{candidateFromDoc(doc, "selected")}
}

func candidateFromDoc(doc wikis.RuntimeDocument, reason string) sessionstate.PlaybookCandidate {
	return sessionstate.PlaybookCandidate{
		Path:     doc.Path,
		Template: playbookTemplatePath(doc),
		Domain:   doc.Domain,
		Reason:   reason,
	}
}

func playbookIsCombo(doc wikis.RuntimeDocument) bool {
	return doc.Playbook != nil && doc.Playbook.IsCombo
}

func playbookTemplatePath(doc wikis.RuntimeDocument) string {
	if doc.Playbook == nil {
		return ""
	}
	return doc.Playbook.TemplatePath
}

func allRuntimeDocs(byPath map[string]wikis.RuntimeDocument) []wikis.RuntimeDocument {
	docs := make([]wikis.RuntimeDocument, 0, len(byPath))
	for _, doc := range byPath {
		docs = append(docs, doc)
	}
	sortRuntimeDocsByPath(docs)
	return docs
}

func instructionForPlan(plan WikiPlan) string {
	common := "All modes: read all contextFiles before running data CLI. Numeric values must come from CLI; do not estimate, invent, or write report files unless the user asks."
	switch plan.Mode {
	case sessionstate.ModeSingle:
		return common + " Harness mode: single. selectedPlaybook=" + plan.SelectedPlaybook + " selectedTemplate=" + plan.SelectedTemplate + ". After selected playbook data collection, run bin/data-harness-cli inject-template. Do not read, open, guess, or use templates/ before inject-template."
	case sessionstate.ModeCombo:
		return common + " Harness mode: combo. selectedPlaybook=" + plan.SelectedPlaybook + " selectedTemplate=" + plan.SelectedTemplate + " coveredSpecs=" + strings.Join(plan.CoveredSpecs, ",") + ". Use the combo playbook for multi-metric data collection and analysis; do not separately apply multiple single-metric playbooks/templates. After data collection, run bin/data-harness-cli inject-template. Do not read, open, guess, or use templates/ before inject-template."
	default:
		return common + " Harness mode: free. reason=" + plan.Reason + ". Do not run bin/data-harness-cli inject-template. Do not read, open, guess, or use templates/. You may reference specs/playbooks, but must not apply any template."
	}
}

func legacyBuild(root, question string) (harness.ContextResponse, error) {
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return harness.ContextResponse{}, err
	}
	indexes, err := idx.Build(root)
	if err != nil {
		return harness.ContextResponse{}, err
	}
	var refs []harness.FileRef
	seen := map[string]bool{}
	add := func(path, reason string) {
		if path == "" {
			return
		}
		physical := resolver.ResolveRel(path)
		if seen[physical] {
			return
		}
		seen[physical] = true
		refs = append(refs, harness.FileRef{Path: physical, Reason: reason})
	}

	add("spec/common/index.md", "default: common spec index")
	addIndexDefaults(indexes.Spec.Files, resolver.ResolveRel("spec/common/index.md"), "default: common", add)

	allDocs := append(append([]harness.Document{}, indexes.Spec.Files...), indexes.Routing.Files...)
	allDocs = append(allDocs, indexes.Playbook.Files...)

	domains := recallDomains(question, allDocs)
	for _, doc := range allDocs {
		if doc.Domain != "common" && !domains[doc.Domain] {
			continue
		}
		if kw := matchedKeyword(question, doc.Match.Keywords); kw != "" {
			add(doc.Path, "keyword: "+kw)
			if isIndexKind(doc.Kind) {
				addDefaultFiles(doc, "default: "+domainOrKind(doc), add)
			}
		}
		for _, child := range doc.Children {
			if kw := matchedKeyword(question, child.Keywords); kw != "" {
				add(child.Path, "child keyword: "+kw)
				if isIndexKind(doc.Kind) {
					add(doc.Path, "parent index for: "+child.Path)
					addDefaultFiles(doc, "default: "+domainOrKind(doc), add)
				}
			}
		}
	}

	if hasAny(question, []string{"今天", "今日", "昨天", "昨日", "最近", "本周", "这周", "上周", "本月", "这个月", "上月", "日", "周", "月", "年", "202"}) {
		add("spec/common/time-policy.md", "time expression")
	}
	if hasAny(question, []string{"全国", "区域", "华东", "华南", "华北", "华中", "管理区域"}) {
		add("spec/common/area.md", "area expression")
	}

	for _, domain := range sortedDomains(domains) {
		addDomainRouting(resolver, indexes.Routing.Files, domain, question, add)
		addDomainPlaybooks(indexes.Playbook.Files, domain, question, add)
	}

	refs = filterLessSpecificKeywordRefs(refs, indexes)

	sort.SliceStable(refs, func(i, j int) bool {
		return fileRank(resolver, refs[i].Path) < fileRank(resolver, refs[j].Path)
	})

	return harness.ContextResponse{
		Question:     question,
		ContextFiles: refs,
		Instruction:  "Read all contextFiles before running data CLI. Do not read templates before inject-template succeeds. After data collection for the selected playbook is complete, run bin/data-harness-cli inject-template.",
		Constraints:  constraints,
	}, nil
}

func filterLessSpecificKeywordRefs(refs []harness.FileRef, indexes idx.BuildResult) []harness.FileRef {
	docsByPath := map[string]harness.Document{}
	for _, doc := range indexes.Spec.Files {
		docsByPath[doc.Path] = doc
	}
	for _, doc := range indexes.Routing.Files {
		docsByPath[doc.Path] = doc
	}
	for _, doc := range indexes.Playbook.Files {
		docsByPath[doc.Path] = doc
	}

	type groupKey struct {
		domain string
		kind   string
	}
	maxByGroup := map[groupKey]int{}
	var keywords []string
	for _, ref := range refs {
		doc, ok := docsByPath[ref.Path]
		if !ok || isIndexKind(doc.Kind) {
			continue
		}
		score := keywordReasonScore(ref.Reason)
		if score == 0 {
			continue
		}
		if kw := keywordFromReason(ref.Reason); kw != "" {
			keywords = append(keywords, kw)
		}
		key := groupKey{domain: doc.Domain, kind: doc.Kind}
		if score > maxByGroup[key] {
			maxByGroup[key] = score
		}
	}

	var out []harness.FileRef
	for _, ref := range refs {
		doc, ok := docsByPath[ref.Path]
		if !ok || isIndexKind(doc.Kind) {
			out = append(out, ref)
			continue
		}
		if isDomainOverview(doc.Path) {
			out = append(out, ref)
			continue
		}
		score := keywordReasonScore(ref.Reason)
		if score == 0 {
			out = append(out, ref)
			continue
		}
		if isCoveredKeyword(keywordFromReason(ref.Reason), keywords) {
			continue
		}
		key := groupKey{domain: doc.Domain, kind: doc.Kind}
		if maxByGroup[key] > score {
			continue
		}
		out = append(out, ref)
	}

	activeDomains := map[string]bool{}
	for _, ref := range out {
		doc, ok := docsByPath[ref.Path]
		if !ok || doc.Domain == "" || doc.Domain == "common" {
			continue
		}
		if keywordReasonScore(ref.Reason) > 0 {
			activeDomains[doc.Domain] = true
		}
	}
	if activeDomains["business"] && activeDomains["store"] && storeOnlyHasGenericDoorKeyword(out, docsByPath) {
		delete(activeDomains, "store")
	}

	var final []harness.FileRef
	for _, ref := range out {
		doc, ok := docsByPath[ref.Path]
		if !ok || doc.Domain == "" || doc.Domain == "common" || activeDomains[doc.Domain] {
			final = append(final, ref)
		}
	}
	return final
}

func storeOnlyHasGenericDoorKeyword(refs []harness.FileRef, docsByPath map[string]harness.Document) bool {
	hasStore := false
	for _, ref := range refs {
		doc, ok := docsByPath[ref.Path]
		if !ok || doc.Domain != "store" {
			continue
		}
		score := keywordReasonScore(ref.Reason)
		if score == 0 {
			continue
		}
		hasStore = true
		kw := keywordFromReason(ref.Reason)
		if kw != "门店" && kw != "门店管理" {
			return false
		}
	}
	return hasStore
}

func PlaybookCandidates(root string, response harness.ContextResponse) ([]sessionstate.PlaybookCandidate, error) {
	indexes, err := idx.Build(root)
	if err != nil {
		return nil, err
	}
	playbooks := map[string]harness.Document{}
	for _, doc := range indexes.Playbook.Files {
		if doc.Kind == "playbook" && doc.Template != "" {
			playbooks[doc.Path] = doc
		}
	}
	type candidateWithDomain struct {
		candidate sessionstate.PlaybookCandidate
		domain    string
		score     int
	}
	var scoped []candidateWithDomain
	for _, ref := range response.ContextFiles {
		doc, ok := playbooks[ref.Path]
		if !ok {
			continue
		}
		scoped = append(scoped, candidateWithDomain{
			candidate: sessionstate.PlaybookCandidate{
				Path:     doc.Path,
				Template: doc.Template,
				Domain:   doc.Domain,
				Reason:   ref.Reason,
			},
			domain: doc.Domain,
			score:  keywordReasonScore(ref.Reason),
		})
	}
	maxByDomain := map[string]int{}
	for _, item := range scoped {
		if item.score > maxByDomain[item.domain] {
			maxByDomain[item.domain] = item.score
		}
	}
	var candidates []sessionstate.PlaybookCandidate
	for _, item := range scoped {
		maxScore := maxByDomain[item.domain]
		if maxScore > 0 && item.score > 0 && item.score < maxScore {
			continue
		}
		candidates = append(candidates, item.candidate)
	}
	return candidates, nil
}

func recallDomains(question string, docs []harness.Document) map[string]bool {
	domains := map[string]bool{}
	for _, doc := range docs {
		if doc.Domain == "" || doc.Domain == "common" {
			continue
		}
		if isIndexKind(doc.Kind) || doc.Kind == "routing" {
			if matchedKeyword(question, doc.Match.Keywords) != "" {
				domains[doc.Domain] = true
				continue
			}
			for _, child := range doc.Children {
				if kw := matchedKeyword(question, child.Keywords); kw != "" && !isGenericDomainKeyword(kw) {
					domains[doc.Domain] = true
					break
				}
			}
		}
	}
	return domains
}

func isGenericDomainKeyword(keyword string) bool {
	switch keyword {
	case "区域", "品类", "趋势", "利润", "分类", "类目":
		return true
	default:
		return false
	}
}

func addIndexDefaults(docs []harness.Document, indexPath, reason string, add func(string, string)) {
	for _, doc := range docs {
		if doc.Path == indexPath {
			addDefaultFiles(doc, reason, add)
			return
		}
	}
}

func addDefaultFiles(doc harness.Document, reason string, add func(string, string)) {
	for _, path := range doc.Context.DefaultFiles {
		add(path, reason)
	}
}

func addDomainRouting(resolver harness.PathResolver, docs []harness.Document, domain, question string, add func(string, string)) {
	for _, doc := range docs {
		if doc.Domain == domain && doc.Kind == "routing" {
			if matchedKeyword(question, doc.Match.Keywords) != "" || isOverviewRouting(resolver, doc.Path, domain) {
				add(doc.Path, "domain routing: "+domain)
			}
		}
	}
}

func isOverviewRouting(resolver harness.PathResolver, path, domain string) bool {
	return resolver.LogicalRel(path) == "routing/"+domain+"-overview.md"
}

func addDomainPlaybooks(docs []harness.Document, domain, question string, add func(string, string)) {
	matchedChild := map[string]bool{}
	for _, doc := range docs {
		if doc.Domain != domain {
			continue
		}
		if doc.Kind == "playbook_index" {
			add(doc.Path, "default playbook index: "+domain)
			for _, child := range doc.Children {
				if kw := matchedKeyword(question, child.Keywords); kw != "" {
					add(child.Path, "playbook keyword: "+kw)
					matchedChild[child.Path] = true
				}
			}
		}
	}
	hasSpecificChild := false
	for path := range matchedChild {
		if !strings.HasSuffix(path, "/default-overview.md") {
			hasSpecificChild = true
			break
		}
	}
	for _, doc := range docs {
		if doc.Domain != domain {
			continue
		}
		if doc.Kind == "playbook" && (matchedKeyword(question, doc.Match.Keywords) != "" || strings.HasSuffix(doc.Path, "/default-overview.md")) {
			if hasSpecificChild && strings.HasSuffix(doc.Path, "/default-overview.md") && !matchedChild[doc.Path] {
				continue
			}
			add(doc.Path, "default playbook: "+domain)
		}
	}
}

func isIndexKind(kind string) bool {
	return strings.HasSuffix(kind, "_index")
}

func domainOrKind(doc harness.Document) string {
	if doc.Domain != "" {
		return doc.Domain
	}
	return doc.Kind
}

func matchedDomains(resolver harness.PathResolver, refs []harness.FileRef) []string {
	seen := map[string]bool{}
	var domains []string
	for _, ref := range refs {
		parts := strings.Split(resolver.LogicalRel(ref.Path), "/")
		if len(parts) < 3 {
			continue
		}
		domain := parts[1]
		if domain == "common" || seen[domain] {
			continue
		}
		seen[domain] = true
		domains = append(domains, domain)
	}
	sort.Strings(domains)
	return domains
}

func sortedDomains(domains map[string]bool) []string {
	var out []string
	for domain := range domains {
		out = append(out, domain)
	}
	sort.Strings(out)
	return out
}

func fileRank(resolver harness.PathResolver, path string) int {
	path = resolver.LogicalRel(path)
	switch {
	case path == "spec/common/index.md":
		return 0
	case strings.HasPrefix(path, "spec/common/"):
		return 10
	case strings.HasSuffix(path, "/index.md") && strings.HasPrefix(path, "spec/"):
		return 20
	case strings.HasPrefix(path, "spec/"):
		return 30
	case strings.HasPrefix(path, "routing/"):
		return 40
	case strings.HasPrefix(path, "playbooks/") && strings.HasSuffix(path, "/index.md"):
		return 50
	case strings.HasPrefix(path, "playbooks/"):
		return 60
	default:
		return 70
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

func matchedKeyword(s string, keywords []string) string {
	for _, kw := range keywords {
		if isShadowedByTimeSegmentMetric(s, kw) {
			continue
		}
		if kw != "" && strings.Contains(s, kw) {
			return kw
		}
	}
	return ""
}

func isShadowedByTimeSegmentMetric(s, keyword string) bool {
	if keyword == "" || strings.HasPrefix(keyword, "19点前") {
		return false
	}
	return strings.Contains(s, "19点前"+keyword)
}

func isDomainOverview(path string) bool {
	return strings.HasSuffix(path, "-overview.md") || strings.HasSuffix(path, "/default-overview.md")
}

func keywordReasonScore(reason string) int {
	keyword := keywordFromReason(reason)
	if keyword == "" {
		return 0
	}
	return len([]rune(keyword))
}

func keywordFromReason(reason string) string {
	for _, marker := range []string{"playbook keyword: ", "keyword: "} {
		if strings.Contains(reason, marker) {
			parts := strings.SplitN(reason, marker, 2)
			if len(parts) == 2 {
				return parts[1]
			}
		}
	}
	return ""
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
