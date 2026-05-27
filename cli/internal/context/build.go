package context

import (
	"sort"
	"strings"

	"harness-data/cli/internal/harness"
	idx "harness-data/cli/internal/index"
	"harness-data/cli/internal/sessionstate"
)

var constraints = []string{
	"values_must_come_from_cli",
	"do_not_estimate_missing_values",
	"do_not_write_report_file_unless_requested",
	"do_not_read_template_before_inject_template",
}

func Build(root, question string) (harness.ContextResponse, error) {
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
