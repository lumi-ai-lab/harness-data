package wikis

import (
	"fmt"
	"math"
	"path"
	"sort"
	"strings"
)

const (
	CheckIndexMD     = "check-index-md"
	CheckTitles      = "check-titles"
	CheckFrontmatter = "check-frontmatter"
	CheckAliases     = "check-aliases"
	CheckCovers      = "check-covers"
	CheckLinks       = "check-links"
)

var AllCheckNames = []string{CheckIndexMD, CheckTitles, CheckFrontmatter, CheckAliases, CheckCovers, CheckLinks}

func RunCheck(root, name string, opts CheckOptions) (CheckResult, error) {
	corpus, parseErrs, err := LoadCorpus(root)
	if err != nil {
		return CheckResult{}, err
	}
	var errs []CheckError
	switch name {
	case CheckIndexMD:
		errs = checkIndexMD(corpus)
	case CheckTitles:
		errs = filterParseErrs(parseErrs, "missing_h1", "multiple_h1")
	case CheckFrontmatter:
		errs = append(filterParseErrs(parseErrs, "unknown_frontmatter_field", "invalid_frontmatter_type", "invalid_covers_type"), checkFrontmatter(corpus)...)
	case CheckAliases:
		errs = checkAliases(corpus)
	case CheckCovers:
		errs = checkCovers(corpus)
	case CheckLinks:
		errs = checkLinks(corpus)
	default:
		return CheckResult{}, fmt.Errorf("unknown wikis check: %s", name)
	}
	for i := range errs {
		errs[i].Check = name
	}
	return makeCheckResult(name, errs, opts), nil
}

func RunAllChecks(root string, opts CheckOptions) ([]CheckResult, error) {
	var results []CheckResult
	rawOpts := opts
	rawOpts.MaxErrors = math.MaxInt
	for _, name := range AllCheckNames {
		result, err := RunCheck(root, name, rawOpts)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
		if opts.FailFast && result.TotalErrors > 0 {
			break
		}
	}
	return trimCheckAllResults(results, opts), nil
}

func makeCheckResult(name string, errs []CheckError, opts CheckOptions) CheckResult {
	limit := opts.MaxErrors
	if limit <= 0 {
		limit = 100
	}
	shown := errs
	if len(shown) > limit {
		shown = shown[:limit]
	}
	if shown == nil {
		shown = []CheckError{}
	}
	return CheckResult{
		Check:        name,
		OK:           len(errs) == 0,
		TotalErrors:  len(errs),
		ShownErrors:  len(shown),
		HiddenErrors: len(errs) - len(shown),
		Truncated:    len(errs) > len(shown),
		Errors:       shown,
	}
}

func trimCheckAllResults(results []CheckResult, opts CheckOptions) []CheckResult {
	remaining := opts.MaxErrors
	if remaining <= 0 {
		remaining = 500
	}
	for i := range results {
		errors := results[i].Errors
		if len(errors) > remaining {
			errors = errors[:remaining]
		}
		if errors == nil {
			errors = []CheckError{}
		}
		remaining -= len(errors)
		if remaining < 0 {
			remaining = 0
		}
		results[i].Errors = errors
		results[i].ShownErrors = len(errors)
		results[i].HiddenErrors = results[i].TotalErrors - len(errors)
		results[i].Truncated = results[i].HiddenErrors > 0
	}
	return results
}

func filterParseErrs(errs []CheckError, codes ...string) []CheckError {
	allowed := map[string]bool{}
	for _, code := range codes {
		allowed[code] = true
	}
	var out []CheckError
	for _, err := range errs {
		if allowed[err.Code] {
			out = append(out, err)
		}
	}
	return out
}

func checkIndexMD(c Corpus) []CheckError {
	dirs := map[string]bool{}
	for _, doc := range c.Docs {
		if strings.HasPrefix(doc.Path, "routing/") {
			continue
		}
		dir := path.Dir(doc.Path)
		for dir != "." && dir != "" {
			dirs[dir] = true
			parent := path.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	var keys []string
	for dir := range dirs {
		keys = append(keys, dir)
	}
	sort.Strings(keys)
	var errs []CheckError
	for _, dir := range keys {
		indexPath := dir + "/index.md"
		if c.ByPath[indexPath] == nil {
			errs = append(errs, CheckError{Path: dir, Code: "missing_index_md", Message: "directory is missing index.md", Target: indexPath})
		}
	}
	return errs
}

func checkFrontmatter(c Corpus) []CheckError {
	var errs []CheckError
	for _, doc := range c.Docs {
		switch {
		case doc.Kind == KindSpec && doc.SpecType == SpecTypeMetric:
			if !doc.HasFrontmatter {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_frontmatter", Message: "metric spec must have frontmatter"})
				continue
			}
			if doc.Name == "" {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_name", Message: "metric spec must have name", Target: "name"})
			}
			if doc.Label == "" {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_label", Message: "metric spec must have label", Target: "label"})
			}
		case doc.Kind == KindPlaybook && doc.Playbook.IsCombo:
			if !doc.HasFrontmatter {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_frontmatter", Message: "combo playbook must have frontmatter"})
				continue
			}
			if doc.Aliases == nil {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_required_field", Message: "combo playbook must have aliases", Target: "aliases"})
			}
			if doc.Covers == nil {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_covers", Message: "combo playbook must have covers", Target: "covers"})
			}
		}
	}
	return errs
}

func checkAliases(c Corpus) []CheckError {
	var errs []CheckError
	global := map[string]CheckError{}
	for _, doc := range c.Docs {
		if doc.Kind == KindSpec && doc.SpecType == SpecTypeMetric {
			if doc.Name == "" {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_name", Message: "metric spec must have name", Target: "name"})
			}
			if doc.Label == "" {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_label", Message: "metric spec must have label", Target: "label"})
			}
		}
		if doc.Kind == KindPlaybook && doc.Playbook.IsSingle && len(doc.Aliases) > 0 {
			errs = append(errs, CheckError{Path: doc.Path, Code: "alias_not_allowed", Message: "single metric playbook must not maintain aliases", Target: "aliases"})
		}
		if doc.Kind == KindPlaybook && doc.Playbook.IsCombo && len(doc.Aliases) == 0 {
			errs = append(errs, CheckError{Path: doc.Path, Code: "missing_required_field", Message: "combo playbook must maintain aliases", Target: "aliases"})
		}
		seen := map[string]bool{}
		for _, alias := range doc.Aliases {
			if seen[alias] {
				errs = append(errs, CheckError{Path: doc.Path, Code: "duplicate_alias", Message: "duplicate alias in document", Value: alias})
			}
			seen[alias] = true
		}
		for field, values := range recallValues(doc) {
			for _, value := range values {
				if value == "" {
					continue
				}
				if field == "name" || field == "label" {
					continue
				}
				if other, ok := global[value]; ok {
					errs = append(errs, CheckError{Path: doc.Path, Code: "duplicate_recall_value", Message: "duplicate recall value", Target: field, Value: value, Other: other.Path})
				} else {
					global[value] = CheckError{Path: doc.Path, Target: field}
				}
			}
		}
	}
	return errs
}

func recallValues(doc Document) map[string][]string {
	out := map[string][]string{}
	if doc.Kind == KindSpec {
		if doc.SpecType == SpecTypeMetric || doc.Name != "" || doc.Label != "" || len(doc.Aliases) > 0 {
			out["name"] = []string{doc.Name}
			out["label"] = []string{doc.Label}
			out["aliases"] = doc.Aliases
		}
	}
	if doc.Kind == KindPlaybook && doc.Playbook.IsCombo {
		out["aliases"] = doc.Aliases
	}
	return out
}

func checkCovers(c Corpus) []CheckError {
	var errs []CheckError
	for _, doc := range c.Docs {
		if doc.Kind != KindPlaybook || !doc.Playbook.IsCombo {
			continue
		}
		if doc.Covers == nil {
			errs = append(errs, CheckError{Path: doc.Path, Code: "missing_covers", Message: "combo playbook must maintain covers", Target: "covers"})
			continue
		}
		for _, cover := range doc.Covers {
			if !strings.HasPrefix(cover, "spec/") || !strings.HasSuffix(cover, ".md") {
				errs = append(errs, CheckError{Path: doc.Path, Code: "invalid_cover_path", Message: "cover must reference a spec logical path", Value: cover})
				continue
			}
			if !c.SpecPaths[cover] {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_cover_target", Message: "cover target does not exist", Value: cover})
			}
		}
	}
	return errs
}

func checkLinks(c Corpus) []CheckError {
	var errs []CheckError
	for _, doc := range c.Docs {
		switch {
		case doc.Kind == KindSpec && doc.SpecType == SpecTypeMetric:
			playbookPath := SamePath(doc.Path, "playbooks")
			if c.ByPath[playbookPath] == nil {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_playbook", Message: "metric spec is missing same-path playbook", Target: playbookPath})
			}
		case doc.Kind == KindPlaybook && !doc.IsIndex:
			if c.ByPath[doc.Playbook.TemplatePath] == nil {
				errs = append(errs, CheckError{Path: doc.Path, Code: "missing_template", Message: "playbook is missing same-path template", Target: doc.Playbook.TemplatePath})
			}
		case doc.Kind == KindTemplate && !doc.IsIndex:
			if c.ByPath[doc.Template.PlaybookPath] == nil {
				errs = append(errs, CheckError{Path: doc.Path, Code: "orphan_template", Message: "template is missing same-path playbook", Target: doc.Template.PlaybookPath})
			}
		}
	}
	return errs
}
