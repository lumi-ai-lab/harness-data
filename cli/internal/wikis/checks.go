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
	corpusOpts := LoadCorpusOptions{}
	if opts.FailFast {
		switch name {
		case CheckTitles:
			corpusOpts.FailFastParse = true
			corpusOpts.ParseCodes = parseCodeSet("missing_h1", "multiple_h1")
		case CheckFrontmatter:
			corpusOpts.FailFastParse = true
			corpusOpts.ParseCodes = parseCodeSet("unknown_frontmatter_field", "invalid_frontmatter_type", "invalid_covers_type", "invalid_intents_type")
		}
	}
	corpus, parseErrs, err := LoadCorpusWithOptions(root, corpusOpts)
	if err != nil {
		return CheckResult{}, err
	}
	var errs []CheckError
	switch name {
	case CheckIndexMD:
		errs = checkIndexMD(corpus, opts)
	case CheckTitles:
		errs = filterParseErrs(parseErrs, "missing_h1", "multiple_h1")
	case CheckFrontmatter:
		errs = filterParseErrs(parseErrs, "unknown_frontmatter_field", "invalid_frontmatter_type", "invalid_covers_type")
		if !(opts.FailFast && len(errs) > 0) {
			errs = append(errs, checkFrontmatter(corpus, opts)...)
		}
	case CheckAliases:
		errs = checkAliases(corpus, opts)
	case CheckCovers:
		errs = checkCovers(corpus, opts)
	case CheckLinks:
		errs = checkLinks(corpus, opts)
	default:
		return CheckResult{}, fmt.Errorf("unknown wikis check: %s", name)
	}
	if opts.FailFast && len(errs) > 1 {
		errs = errs[:1]
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

func parseCodeSet(codes ...string) map[string]bool {
	allowed := map[string]bool{}
	for _, code := range codes {
		allowed[code] = true
	}
	return allowed
}

func checkIndexMD(c Corpus, opts CheckOptions) []CheckError {
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
			if opts.FailFast {
				return errs
			}
		}
	}
	return errs
}

func checkFrontmatter(c Corpus, opts CheckOptions) []CheckError {
	var errs []CheckError
	add := func(err CheckError) bool {
		errs = append(errs, err)
		return opts.FailFast
	}
	for _, doc := range c.Docs {
		switch {
		case doc.Kind == KindSpec && doc.SpecType == SpecTypeMetric:
			if !doc.HasFrontmatter {
				if add(CheckError{Path: doc.Path, Code: "missing_frontmatter", Message: "metric spec must have frontmatter"}) {
					return errs
				}
				continue
			}
			if doc.Name == "" {
				if add(CheckError{Path: doc.Path, Code: "missing_name", Message: "metric spec must have name", Target: "name"}) {
					return errs
				}
			}
			if doc.Label == "" {
				if add(CheckError{Path: doc.Path, Code: "missing_label", Message: "metric spec must have label", Target: "label"}) {
					return errs
				}
			}
		case doc.Kind == KindPlaybook && doc.Playbook.IsCombo:
			if !doc.HasFrontmatter {
				if add(CheckError{Path: doc.Path, Code: "missing_frontmatter", Message: "combo playbook must have frontmatter"}) {
					return errs
				}
				continue
			}
			if doc.Aliases == nil {
				if add(CheckError{Path: doc.Path, Code: "missing_required_field", Message: "combo playbook must have aliases", Target: "aliases"}) {
					return errs
				}
			}
			if doc.Covers == nil {
				if add(CheckError{Path: doc.Path, Code: "missing_covers", Message: "combo playbook must have covers", Target: "covers"}) {
					return errs
				}
			}
		}
		if len(doc.Playbook.Intents) > 0 {
			if doc.Kind != KindPlaybook || !doc.Playbook.IsSingle {
				if add(CheckError{Path: doc.Path, Code: "invalid_intents_target", Message: "intents are only allowed on single metric playbooks", Target: "intents"}) {
					return errs
				}
			}
			for intentName, intent := range doc.Playbook.Intents {
				if strings.TrimSpace(intentName) == "" {
					if add(CheckError{Path: doc.Path, Code: "invalid_intents_type", Message: "intent name must not be empty", Target: "intents"}) {
						return errs
					}
				}
				if len(intent.Aliases) == 0 {
					if add(CheckError{Path: doc.Path, Code: "invalid_intents_type", Message: "intent aliases must not be empty", Target: "intents." + intentName + ".aliases"}) {
						return errs
					}
				}
				seen := map[string]bool{}
				for _, alias := range intent.Aliases {
					if strings.TrimSpace(alias) == "" {
						if add(CheckError{Path: doc.Path, Code: "invalid_intents_type", Message: "intent alias must not be empty", Target: "intents." + intentName + ".aliases"}) {
							return errs
						}
					}
					if seen[alias] {
						if add(CheckError{Path: doc.Path, Code: "duplicate_intent_alias", Message: "duplicate intent alias in playbook intent", Target: "intents." + intentName + ".aliases", Value: alias}) {
							return errs
						}
					}
					seen[alias] = true
				}
			}
		}
	}
	return errs
}

func checkAliases(c Corpus, opts CheckOptions) []CheckError {
	var errs []CheckError
	add := func(err CheckError) bool {
		errs = append(errs, err)
		return opts.FailFast
	}
	global := map[string]CheckError{}
	for _, doc := range c.Docs {
		if doc.Kind == KindSpec && doc.SpecType == SpecTypeMetric {
			if doc.Name == "" {
				if add(CheckError{Path: doc.Path, Code: "missing_name", Message: "metric spec must have name", Target: "name"}) {
					return errs
				}
			}
			if doc.Label == "" {
				if add(CheckError{Path: doc.Path, Code: "missing_label", Message: "metric spec must have label", Target: "label"}) {
					return errs
				}
			}
		}
		if doc.Kind == KindPlaybook && doc.Playbook.IsSingle && len(doc.Aliases) > 0 {
			if add(CheckError{Path: doc.Path, Code: "alias_not_allowed", Message: "single metric playbook must not maintain aliases", Target: "aliases"}) {
				return errs
			}
		}
		if doc.Kind == KindPlaybook && doc.Playbook.IsCombo && len(doc.Aliases) == 0 {
			if add(CheckError{Path: doc.Path, Code: "missing_required_field", Message: "combo playbook must maintain aliases", Target: "aliases"}) {
				return errs
			}
		}
		seen := map[string]bool{}
		for _, alias := range doc.Aliases {
			if seen[alias] {
				if add(CheckError{Path: doc.Path, Code: "duplicate_alias", Message: "duplicate alias in document", Value: alias}) {
					return errs
				}
			}
			seen[alias] = true
		}
		for _, recall := range orderedRecallValues(doc) {
			for _, value := range recall.Values {
				if value == "" {
					continue
				}
				if other, ok := global[value]; ok {
					if add(CheckError{Path: doc.Path, Code: "duplicate_recall_value", Message: "duplicate recall value", Target: recall.Field, Value: value, Other: other.Path}) {
						return errs
					}
				} else {
					global[value] = CheckError{Path: doc.Path, Target: recall.Field}
				}
			}
		}
	}
	return errs
}

type recallFieldValues struct {
	Field  string
	Values []string
}

func orderedRecallValues(doc Document) []recallFieldValues {
	var out []recallFieldValues
	if doc.Kind == KindSpec {
		if doc.SpecType == SpecTypeMetric || doc.Name != "" || doc.Label != "" || len(doc.Aliases) > 0 {
			out = append(out,
				recallFieldValues{Field: "name", Values: []string{doc.Name}},
				recallFieldValues{Field: "label", Values: []string{doc.Label}},
				recallFieldValues{Field: "aliases", Values: doc.Aliases},
			)
		}
	}
	if doc.Kind == KindPlaybook && doc.Playbook.IsCombo {
		out = append(out, recallFieldValues{Field: "aliases", Values: doc.Aliases})
	}
	return out
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

func checkCovers(c Corpus, opts CheckOptions) []CheckError {
	var errs []CheckError
	add := func(err CheckError) bool {
		errs = append(errs, err)
		return opts.FailFast
	}
	for _, doc := range c.Docs {
		if doc.Kind != KindPlaybook || !doc.Playbook.IsCombo {
			continue
		}
		if doc.Covers == nil {
			if add(CheckError{Path: doc.Path, Code: "missing_covers", Message: "combo playbook must maintain covers", Target: "covers"}) {
				return errs
			}
			continue
		}
		for _, cover := range doc.Covers {
			if !isSpecDocPath(cover) || !strings.HasSuffix(cover, ".md") {
				if add(CheckError{Path: doc.Path, Code: "invalid_cover_path", Message: "cover must reference a spec logical path", Value: cover}) {
					return errs
				}
				continue
			}
			if !c.SpecPaths[cover] {
				if add(CheckError{Path: doc.Path, Code: "missing_cover_target", Message: "cover target does not exist", Value: cover}) {
					return errs
				}
			}
		}
	}
	return errs
}

func checkLinks(c Corpus, opts CheckOptions) []CheckError {
	var errs []CheckError
	add := func(err CheckError) bool {
		errs = append(errs, err)
		return opts.FailFast
	}
	for _, doc := range c.Docs {
		switch {
		case doc.Kind == KindSpec && doc.SpecType == SpecTypeMetric:
			if IsReferenceSpecPath(doc.Path) {
				continue
			}
			playbookPath := SamePath(doc.Path, "playbooks")
			if c.ByPath[playbookPath] == nil {
				if add(CheckError{Path: doc.Path, Code: "missing_playbook", Message: "metric spec is missing same-path playbook", Target: playbookPath}) {
					return errs
				}
			}
		case doc.Kind == KindTemplate && !doc.IsIndex:
			if c.ByPath[doc.Template.PlaybookPath] == nil {
				if add(CheckError{Path: doc.Path, Code: "orphan_template", Message: "template is missing same-path playbook", Target: doc.Template.PlaybookPath}) {
					return errs
				}
			}
		}
	}
	return errs
}

func IsReferenceSpecPath(logical string) bool {
	if strings.HasPrefix(logical, "dims/") || strings.HasPrefix(logical, "rules/") {
		return path.Base(logical) == "spec.md"
	}
	if !strings.HasPrefix(logical, "spec/") {
		return false
	}
	rest := strings.TrimPrefix(logical, "spec/")
	if strings.HasPrefix(rest, "common/") {
		return true
	}
	return strings.HasPrefix(rest, "dim-")
}
