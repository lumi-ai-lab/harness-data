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
		if seen[path] {
			return
		}
		seen[path] = true
		refs = append(refs, harness.FileRef{Path: path, Reason: reason})
	}

	add("spec/common/index.md", "default: common spec index")
	addIndexDefaults(indexes.Spec.Files, "spec/common/index.md", "default: common", add)

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
		addDomainRouting(indexes.Routing.Files, domain, add)
		addDomainPlaybooks(indexes.Playbook.Files, domain, question, add)
	}

	sort.SliceStable(refs, func(i, j int) bool {
		return fileRank(refs[i].Path) < fileRank(refs[j].Path)
	})

	return harness.ContextResponse{
		Question:     question,
		ContextFiles: refs,
		Instruction:  "Read all contextFiles before running data CLI. Do not read templates before inject-template succeeds. After data collection for the selected playbook is complete, run bin/data-harness-cli inject-template.",
		Constraints:  constraints,
	}, nil
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
	var candidates []sessionstate.PlaybookCandidate
	for _, ref := range response.ContextFiles {
		doc, ok := playbooks[ref.Path]
		if !ok {
			continue
		}
		candidates = append(candidates, sessionstate.PlaybookCandidate{
			Path:     doc.Path,
			Template: doc.Template,
			Reason:   ref.Reason,
		})
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

func addDomainRouting(docs []harness.Document, domain string, add func(string, string)) {
	for _, doc := range docs {
		if doc.Domain == domain && doc.Kind == "routing" {
			add(doc.Path, "domain routing: "+domain)
		}
	}
}

func addDomainPlaybooks(docs []harness.Document, domain, question string, add func(string, string)) {
	for _, doc := range docs {
		if doc.Domain != domain {
			continue
		}
		if doc.Kind == "playbook_index" {
			add(doc.Path, "default playbook index: "+domain)
			for _, child := range doc.Children {
				if kw := matchedKeyword(question, child.Keywords); kw != "" {
					add(child.Path, "playbook keyword: "+kw)
				}
			}
		}
		if doc.Kind == "playbook" && (matchedKeyword(question, doc.Match.Keywords) != "" || strings.HasSuffix(doc.Path, "/default-overview.md")) {
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

func matchedDomains(refs []harness.FileRef) []string {
	seen := map[string]bool{}
	var domains []string
	for _, ref := range refs {
		parts := strings.Split(ref.Path, "/")
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

func fileRank(path string) int {
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
		if kw != "" && strings.Contains(s, kw) {
			return kw
		}
	}
	return ""
}
