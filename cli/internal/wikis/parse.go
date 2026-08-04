package wikis

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"harness-data/cli/internal/harness"
)

var allowedFrontmatter = map[string]bool{
	"name":             true,
	"label":            true,
	"aliases":          true,
	"negative_aliases": true,
	"covers":           true,
	"intents":          true,
	"status":           true,
	"object_type":      true,
	"canonical_status": true,
	"canonical_group":  true,
	"canonical_target": true,
	"canonical_reason": true,
}

type LoadCorpusOptions struct {
	FailFastParse bool
	ParseCodes    map[string]bool
}

func LoadCorpus(root string) (Corpus, []CheckError, error) {
	return LoadCorpusWithOptions(root, LoadCorpusOptions{})
}

func LoadCorpusWithOptions(root string, opts LoadCorpusOptions) (Corpus, []CheckError, error) {
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return Corpus{}, nil, err
	}
	paths, err := collectCorpusMarkdown(resolver)
	if err != nil {
		return Corpus{}, nil, err
	}
	specSet := map[string]bool{}
	for _, p := range paths {
		if isSpecDocPath(p) {
			specSet[p] = true
		}
	}

	var docs []Document
	var errs []CheckError
	for _, logical := range paths {
		doc, parseErrs, err := ParseDocument(resolver, logical, specSet)
		if err != nil {
			return Corpus{}, nil, err
		}
		errs = append(errs, parseErrs...)
		docs = append(docs, doc)
		if opts.FailFastParse && hasSelectedParseErr(parseErrs, opts.ParseCodes) {
			break
		}
	}
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
	byPath := map[string]*Document{}
	for i := range docs {
		byPath[docs[i].Path] = &docs[i]
	}
	return Corpus{Root: root, Docs: docs, ByPath: byPath, SpecPaths: specSet}, errs, nil
}

func hasSelectedParseErr(errs []CheckError, codes map[string]bool) bool {
	if len(errs) == 0 {
		return false
	}
	if len(codes) == 0 {
		return true
	}
	for _, err := range errs {
		if codes[err.Code] {
			return true
		}
	}
	return false
}

func ParseDocument(resolver harness.PathResolver, logical string, specSet map[string]bool) (Document, []CheckError, error) {
	physicalRel := resolver.ResolveRel(logical)
	data, err := os.ReadFile(filepath.Join(resolver.Root, filepath.FromSlash(physicalRel)))
	if err != nil {
		return Document{}, nil, err
	}
	fm, fmErrs := parseFrontmatter(logical, data)
	title, h1Count := parseH1(data)
	doc := Document{
		ID:             strings.TrimSuffix(logical, ".md"),
		Path:           logical,
		PhysicalRel:    physicalRel,
		Kind:           inferKind(logical),
		Domain:         inferDomain(logical),
		Title:          title,
		IsIndex:        path.Base(logical) == "index.md",
		HasFrontmatter: fm.Present,
	}
	if doc.Kind == KindSpec && !doc.IsIndex {
		doc.SpecType = inferSpecType(logical)
	}
	if doc.Kind == KindPlaybook && !doc.IsIndex {
		specPath := SamePath(logical, "spec")
		templatePath := SamePath(logical, "templates")
		doc.Playbook.SpecPath = specPath
		doc.Playbook.TemplatePath = templatePath
		if specSet[specPath] && inferSpecType(specPath) == SpecTypeMetric {
			doc.Playbook.IsSingle = true
		}
	}
	if doc.Kind == KindTemplate && !doc.IsIndex {
		doc.Template.PlaybookPath = SamePath(logical, "playbooks")
		doc.Template.IsReport = true
	}
	if fm.Present {
		doc.Name, _ = fm.Fields["name"].(string)
		doc.Label, _ = fm.Fields["label"].(string)
		doc.Aliases, _ = fm.Fields["aliases"].([]string)
		doc.NegativeAliases, _ = fm.Fields["negative_aliases"].([]string)
		doc.Covers, _ = fm.Fields["covers"].([]string)
		doc.Playbook.Intents, _ = fm.Fields["intents"].(map[string]PlaybookIntent)
	}
	errs := fmErrs
	if h1Count == 0 {
		errs = append(errs, CheckError{Path: logical, Code: "missing_h1", Message: "missing H1 title"})
	} else if h1Count > 1 {
		errs = append(errs, CheckError{Path: logical, Code: "multiple_h1", Message: "multiple H1 titles"})
	}
	return doc, errs, nil
}

func collectCorpusMarkdown(resolver harness.PathResolver) ([]string, error) {
	seen := map[string]bool{}
	var paths []string
	add := func(logical string) {
		if seen[logical] {
			return
		}
		seen[logical] = true
		paths = append(paths, logical)
	}
	if fileExists(resolver.Resolve("index.md")) {
		add("index.md")
	}
	for _, prefix := range []string{"spec", "playbooks", "templates", "metrics", "reports", "dims", "rules"} {
		found, err := collectLogicalMarkdown(resolver, prefix)
		if err != nil {
			return nil, err
		}
		for _, logical := range found {
			add(logical)
		}
	}
	sort.Strings(paths)
	return paths, nil
}

func collectLogicalMarkdown(resolver harness.PathResolver, prefix string) ([]string, error) {
	base := resolver.KnowledgePath(prefix)
	if _, err := os.Stat(base); os.IsNotExist(err) {
		return nil, nil
	}
	var paths []string
	err := filepath.WalkDir(base, func(file string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
			return nil
		}
		rel, err := filepath.Rel(resolver.Root, file)
		if err != nil {
			return err
		}
		paths = append(paths, resolver.LogicalRel(filepath.ToSlash(rel)))
		return nil
	})
	sort.Strings(paths)
	return paths, err
}

func inferKind(logical string) Kind {
	isIndex := path.Base(logical) == "index.md"
	switch {
	case logical == "index.md":
		return KindSpecIndex
	case isStructuredSpecPath(logical) && isIndex:
		return KindSpecIndex
	case isStructuredSpecPath(logical):
		return KindSpec
	case isStructuredPlaybookPath(logical):
		return KindPlaybook
	case isStructuredTemplatePath(logical):
		return KindTemplate
	case strings.HasPrefix(logical, "spec/") && isIndex:
		return KindSpecIndex
	case strings.HasPrefix(logical, "spec/"):
		return KindSpec
	case strings.HasPrefix(logical, "playbooks/") && isIndex:
		return KindPlaybookIndex
	case strings.HasPrefix(logical, "playbooks/"):
		return KindPlaybook
	case strings.HasPrefix(logical, "templates/") && isIndex:
		return KindTemplateIndex
	default:
		return KindTemplate
	}
}

func inferDomain(logical string) string {
	if logical == "index.md" {
		return ""
	}
	if isStructuredPath(logical) {
		parts := strings.Split(logical, "/")
		if len(parts) == 2 && parts[1] == "index.md" {
			return ""
		}
		if len(parts) >= 2 {
			return parts[1]
		}
		return ""
	}
	parts := strings.SplitN(logical, "/", 2)
	if len(parts) != 2 {
		return ""
	}
	rest := parts[1]
	if path.Base(rest) == "index.md" {
		domain := path.Dir(rest)
		if domain == "." {
			return ""
		}
		return domain
	}
	domain := path.Dir(rest)
	if domain == "." {
		return ""
	}
	return domain
}

func SamePath(logical, targetRoot string) string {
	if isStructuredPath(logical) {
		dir := path.Dir(logical)
		switch targetRoot {
		case "spec":
			return path.Join(dir, "spec.md")
		case "playbooks":
			return path.Join(dir, "playbook.md")
		case "templates":
			return path.Join(dir, "template.md")
		default:
			return logical
		}
	}
	parts := strings.SplitN(logical, "/", 2)
	if len(parts) != 2 {
		return logical
	}
	return targetRoot + "/" + parts[1]
}

func isSpecDocPath(logical string) bool {
	return inferKind(logical) == KindSpec && path.Base(logical) != "index.md"
}

func inferSpecType(logical string) SpecType {
	if strings.HasPrefix(logical, "metrics/") {
		return SpecTypeMetric
	}
	if strings.HasPrefix(logical, "reports/") || strings.HasPrefix(logical, "dims/") || strings.HasPrefix(logical, "rules/") {
		return SpecTypeConcept
	}
	base := path.Base(logical)
	if strings.HasPrefix(base, "c-") || strings.HasPrefix(base, "r-") {
		return SpecTypeConcept
	}
	return SpecTypeMetric
}

func isStructuredPath(logical string) bool {
	return strings.HasPrefix(logical, "metrics/") ||
		strings.HasPrefix(logical, "reports/") ||
		strings.HasPrefix(logical, "dims/") ||
		strings.HasPrefix(logical, "rules/")
}

func isStructuredSpecPath(logical string) bool {
	base := path.Base(logical)
	if base == "spec.md" {
		return isStructuredPath(logical)
	}
	return base == "index.md" && isStructuredPath(logical)
}

func isStructuredPlaybookPath(logical string) bool {
	return isStructuredPath(logical) && path.Base(logical) == "playbook.md"
}

func isStructuredTemplatePath(logical string) bool {
	return isStructuredPath(logical) && path.Base(logical) == "template.md"
}

func parseH1(data []byte) (string, int) {
	scanner := bufio.NewScanner(bytes.NewReader(stripFrontmatter(data)))
	count := 0
	title := ""
	inFence := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if strings.HasPrefix(line, "# ") {
			count++
			if title == "" {
				title = strings.TrimSpace(strings.TrimPrefix(line, "# "))
			}
		}
	}
	return title, count
}

func stripFrontmatter(data []byte) []byte {
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

func parseFrontmatter(logical string, data []byte) (Frontmatter, []CheckError) {
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return Frontmatter{Fields: map[string]any{}}, nil
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end == -1 {
		return Frontmatter{Present: true, Fields: map[string]any{}}, []CheckError{{Path: logical, Code: "invalid_frontmatter_type", Message: "unterminated frontmatter"}}
	}
	fm := Frontmatter{Present: true, Fields: map[string]any{}}
	var errs []CheckError
	for i := 1; i < end; i++ {
		raw := strings.TrimRight(lines[i], " \t")
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "- ") {
			continue
		}
		indent := len(raw) - len(strings.TrimLeft(raw, " "))
		if indent != 0 {
			continue
		}
		key, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			errs = append(errs, CheckError{Path: logical, Code: "invalid_frontmatter_type", Message: fmt.Sprintf("invalid frontmatter line: %s", trimmed)})
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !allowedFrontmatter[key] {
			errs = append(errs, CheckError{Path: logical, Code: "unknown_frontmatter_field", Message: "unknown frontmatter field", Target: key})
			continue
		}
		switch key {
		case "name", "label", "status", "object_type", "canonical_status", "canonical_group", "canonical_target", "canonical_reason":
			if value == "" || strings.HasPrefix(value, "[") {
				errs = append(errs, CheckError{Path: logical, Code: "invalid_frontmatter_type", Message: "frontmatter field must be a string", Target: key})
				continue
			}
			fm.Fields[key] = cleanScalar(value)
		case "aliases", "negative_aliases", "covers":
			values, ok := parseStringArray(lines, &i, end, value)
			if !ok {
				code := "invalid_frontmatter_type"
				if key == "covers" {
					code = "invalid_covers_type"
				}
				errs = append(errs, CheckError{Path: logical, Code: code, Message: "frontmatter field must be a string array", Target: key})
				continue
			}
			fm.Fields[key] = values
		case "intents":
			intents, ok := parsePlaybookIntents(lines, &i, end, value)
			if !ok {
				errs = append(errs, CheckError{Path: logical, Code: "invalid_frontmatter_type", Message: "frontmatter field must be an intents map", Target: key})
				continue
			}
			fm.Fields[key] = intents
		}
	}
	return fm, errs
}

func parsePlaybookIntents(lines []string, idx *int, end int, value string) (map[string]PlaybookIntent, bool) {
	if value != "" {
		return nil, false
	}
	out := map[string]PlaybookIntent{}
	for *idx+1 < end {
		next := lines[*idx+1]
		trimmed := strings.TrimSpace(next)
		if trimmed == "" {
			(*idx)++
			continue
		}
		indent := len(next) - len(strings.TrimLeft(next, " "))
		if indent == 0 {
			break
		}
		if indent != 2 {
			return nil, false
		}
		key, nestedValue, ok := strings.Cut(trimmed, ":")
		if !ok || strings.TrimSpace(key) == "" || strings.TrimSpace(nestedValue) != "" {
			return nil, false
		}
		intentName := cleanScalar(key)
		(*idx)++
		intent := PlaybookIntent{}
		sawField := false
		for *idx+1 < end {
			fieldLine := lines[*idx+1]
			fieldTrimmed := strings.TrimSpace(fieldLine)
			if fieldTrimmed == "" {
				(*idx)++
				continue
			}
			fieldIndent := len(fieldLine) - len(strings.TrimLeft(fieldLine, " "))
			if fieldIndent <= 2 {
				break
			}
			if fieldIndent != 4 {
				return nil, false
			}
			fieldKey, fieldValue, ok := strings.Cut(fieldTrimmed, ":")
			if !ok {
				return nil, false
			}
			fieldKey = strings.TrimSpace(fieldKey)
			fieldValue = strings.TrimSpace(fieldValue)
			if fieldKey != "aliases" {
				return nil, false
			}
			values, ok := parseIndentedStringArray(lines, idx, end, fieldValue, fieldIndent)
			if !ok {
				return nil, false
			}
			intent.Aliases = values
			sawField = true
		}
		if !sawField || intent.Aliases == nil {
			return nil, false
		}
		out[intentName] = intent
	}
	return out, true
}

func parseIndentedStringArray(lines []string, idx *int, end int, value string, parentIndent int) ([]string, bool) {
	if strings.HasPrefix(value, "[") {
		if !strings.HasSuffix(value, "]") {
			return nil, false
		}
		inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(value, "["), "]"))
		if inner == "" {
			(*idx)++
			return []string{}, true
		}
		parts := strings.Split(inner, ",")
		out := make([]string, 0, len(parts))
		for _, part := range parts {
			out = append(out, cleanScalar(part))
		}
		(*idx)++
		return out, true
	}
	if value != "" {
		return nil, false
	}
	(*idx)++
	var out []string
	for *idx+1 < end {
		next := lines[*idx+1]
		trimmed := strings.TrimSpace(next)
		if trimmed == "" {
			(*idx)++
			continue
		}
		indent := len(next) - len(strings.TrimLeft(next, " "))
		if indent <= parentIndent {
			break
		}
		if !strings.HasPrefix(trimmed, "- ") {
			return nil, false
		}
		out = append(out, cleanScalar(strings.TrimPrefix(trimmed, "- ")))
		(*idx)++
	}
	return out, true
}

func parseStringArray(lines []string, idx *int, end int, value string) ([]string, bool) {
	if strings.HasPrefix(value, "[") {
		if !strings.HasSuffix(value, "]") {
			return nil, false
		}
		inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(value, "["), "]"))
		if inner == "" {
			return []string{}, true
		}
		parts := strings.Split(inner, ",")
		out := make([]string, 0, len(parts))
		for _, part := range parts {
			out = append(out, cleanScalar(part))
		}
		return out, true
	}
	if value != "" {
		return nil, false
	}
	var out []string
	for *idx+1 < end {
		next := lines[*idx+1]
		trimmed := strings.TrimSpace(next)
		if trimmed == "" {
			(*idx)++
			continue
		}
		indent := len(next) - len(strings.TrimLeft(next, " "))
		if indent == 0 {
			break
		}
		if !strings.HasPrefix(trimmed, "- ") {
			return nil, false
		}
		out = append(out, cleanScalar(strings.TrimPrefix(trimmed, "- ")))
		(*idx)++
	}
	return out, true
}

func cleanScalar(s string) string {
	s = strings.TrimSpace(s)
	if hash := strings.Index(s, " #"); hash >= 0 {
		s = strings.TrimSpace(s[:hash])
	}
	return strings.Trim(s, `"'`)
}
