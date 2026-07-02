package wikis

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"harness-data/cli/internal/harness"
)

const (
	TemplateSelectionLogicalPath       = "reports/selection.yaml"
	LegacyTemplateSelectionLogicalPath = "templates/selection.yaml"
)

type TemplateDoctorResult struct {
	Status            string                  `json:"status"`
	SelectionPath     string                  `json:"selectionPath"`
	Rules             []TemplateSelectionRule `json:"rules,omitempty"`
	Errors            []string                `json:"errors,omitempty"`
	Warnings          []string                `json:"warnings,omitempty"`
	Suggestions       []TemplateSelectionRule `json:"suggestions,omitempty"`
	SuggestionPath    string                  `json:"suggestionPath,omitempty"`
	SuggestionWritten bool                    `json:"suggestionWritten"`
}

func LoadTemplateSelectionPolicy(root string) (TemplateSelectionPolicy, string, error) {
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return TemplateSelectionPolicy{}, "", err
	}
	selectionPath := resolver.Resolve(TemplateSelectionLogicalPath)
	data, err := os.ReadFile(selectionPath)
	if err != nil {
		if os.IsNotExist(err) {
			selectionPath = resolver.Resolve(LegacyTemplateSelectionLogicalPath)
			data, err = os.ReadFile(selectionPath)
			if err != nil {
				if os.IsNotExist(err) {
					return TemplateSelectionPolicy{Version: 1}, resolver.Resolve(TemplateSelectionLogicalPath), nil
				}
				return TemplateSelectionPolicy{}, selectionPath, err
			}
		} else {
			return TemplateSelectionPolicy{}, selectionPath, err
		}
	}
	policy, err := ParseTemplateSelectionYAML(data)
	if err != nil {
		return TemplateSelectionPolicy{}, selectionPath, err
	}
	if policy.Version == 0 {
		policy.Version = 1
	}
	return policy, selectionPath, nil
}

func ParseTemplateSelectionYAML(data []byte) (TemplateSelectionPolicy, error) {
	var policy TemplateSelectionPolicy
	var current *TemplateSelectionRule
	var arrayField string
	lines := strings.Split(string(data), "\n")
	for lineNo, raw := range lines {
		line := strings.TrimRight(raw, " \t\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if !strings.HasPrefix(line, " ") && strings.Contains(trimmed, ":") {
			key, value := splitYAMLKeyValue(trimmed)
			switch key {
			case "version":
				if value == "" {
					return TemplateSelectionPolicy{}, fmt.Errorf("selection.yaml:%d version must be scalar", lineNo+1)
				}
				version, err := strconv.Atoi(cleanYAMLScalar(value))
				if err != nil {
					return TemplateSelectionPolicy{}, fmt.Errorf("selection.yaml:%d invalid version", lineNo+1)
				}
				policy.Version = version
			case "templates":
				if value != "" {
					return TemplateSelectionPolicy{}, fmt.Errorf("selection.yaml:%d templates must be a list", lineNo+1)
				}
			default:
				return TemplateSelectionPolicy{}, fmt.Errorf("selection.yaml:%d unsupported key: %s", lineNo+1, key)
			}
			arrayField = ""
			continue
		}
		if strings.HasPrefix(trimmed, "- ") {
			content := strings.TrimSpace(strings.TrimPrefix(trimmed, "- "))
			if current != nil && arrayField != "" && !strings.Contains(content, ":") {
				appendTemplateSelectionArray(current, arrayField, cleanYAMLScalar(content))
				continue
			}
			policy.Templates = append(policy.Templates, TemplateSelectionRule{})
			current = &policy.Templates[len(policy.Templates)-1]
			arrayField = ""
			if content == "" {
				continue
			}
			key, value := splitYAMLKeyValue(content)
			if key == "" {
				return TemplateSelectionPolicy{}, fmt.Errorf("selection.yaml:%d invalid template item", lineNo+1)
			}
			if err := setTemplateSelectionScalar(current, key, value, lineNo+1); err != nil {
				return TemplateSelectionPolicy{}, err
			}
			continue
		}
		if current == nil {
			return TemplateSelectionPolicy{}, fmt.Errorf("selection.yaml:%d field outside template item", lineNo+1)
		}
		key, value := splitYAMLKeyValue(trimmed)
		if key == "" {
			return TemplateSelectionPolicy{}, fmt.Errorf("selection.yaml:%d invalid field", lineNo+1)
		}
		switch key {
		case "covers", "intents":
			if value == "" {
				arrayField = key
				continue
			}
			values := parseInlineYAMLArray(value)
			for _, item := range values {
				appendTemplateSelectionArray(current, key, item)
			}
			arrayField = ""
		default:
			if err := setTemplateSelectionScalar(current, key, value, lineNo+1); err != nil {
				return TemplateSelectionPolicy{}, err
			}
			arrayField = ""
		}
	}
	return policy, nil
}

func splitYAMLKeyValue(line string) (string, string) {
	parts := strings.SplitN(line, ":", 2)
	if len(parts) != 2 {
		return "", ""
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func setTemplateSelectionScalar(rule *TemplateSelectionRule, key, value string, lineNo int) error {
	value = cleanYAMLScalar(value)
	switch key {
	case "id":
		rule.ID = value
	case "playbook":
		rule.Playbook = value
	case "template":
		rule.Template = value
	case "type":
		rule.Type = value
	case "domain":
		rule.Domain = value
	case "priority":
		if value == "" {
			return fmt.Errorf("selection.yaml:%d priority must be numeric", lineNo)
		}
		priority, err := strconv.Atoi(value)
		if err != nil {
			return fmt.Errorf("selection.yaml:%d invalid priority", lineNo)
		}
		rule.Priority = priority
	default:
		return fmt.Errorf("selection.yaml:%d unsupported template field: %s", lineNo, key)
	}
	return nil
}

func appendTemplateSelectionArray(rule *TemplateSelectionRule, key, value string) {
	if value == "" {
		return
	}
	switch key {
	case "covers":
		rule.Covers = append(rule.Covers, value)
	case "intents":
		rule.Intents = append(rule.Intents, value)
	}
}

func ValidateTemplateSelectionPolicy(root string, policy TemplateSelectionPolicy) []string {
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return []string{"path config error: " + err.Error()}
	}
	var errs []string
	ids := map[string]bool{}
	for i, rule := range policy.Templates {
		prefix := fmt.Sprintf("templates[%d]", i)
		if rule.ID == "" {
			errs = append(errs, prefix+": id is required")
		} else if ids[rule.ID] {
			errs = append(errs, prefix+": duplicate id "+rule.ID)
		}
		ids[rule.ID] = true
		if rule.Playbook == "" || inferKind(rule.Playbook) != KindPlaybook {
			errs = append(errs, prefix+": playbook must reference a playbook logical path")
		} else if !fileExists(resolver.Resolve(rule.Playbook)) {
			errs = append(errs, prefix+": missing playbook "+rule.Playbook)
		}
		if rule.Template == "" || !isAllowedTemplateSelectionPath(rule.Template) {
			errs = append(errs, prefix+": template must use templates/... or reports/.../template.md")
		} else if !fileExists(resolver.Resolve(rule.Template)) {
			errs = append(errs, prefix+": missing template "+rule.Template)
		}
		if rule.Type != "report" && rule.Type != "composite" && rule.Type != "single" {
			errs = append(errs, prefix+": type must be report, composite, or single")
		}
		for _, cover := range rule.Covers {
			if !isSpecDocPath(cover) {
				errs = append(errs, prefix+": cover must reference a spec logical path: "+cover)
			} else if !fileExists(resolver.Resolve(cover)) {
				errs = append(errs, prefix+": missing cover "+cover)
			}
		}
		if (rule.Type == "report" || rule.Type == "composite") && len(rule.Covers) == 0 && len(rule.Intents) == 0 {
			errs = append(errs, prefix+": report/composite must define covers or intents")
		}
	}
	return errs
}

func BuildTemplateDoctor(root, out string) (TemplateDoctorResult, error) {
	policy, selectionPath, err := LoadTemplateSelectionPolicy(root)
	if err != nil {
		return TemplateDoctorResult{}, err
	}
	errs := ValidateTemplateSelectionPolicy(root, policy)
	suggestions, suggestErr := SuggestTemplateSelection(root, policy)
	if suggestErr != nil {
		errs = append(errs, suggestErr.Error())
	}
	result := TemplateDoctorResult{
		Status:        "PASS",
		SelectionPath: filepath.ToSlash(selectionPath),
		Rules:         policy.Templates,
		Errors:        errs,
		Suggestions:   suggestions,
	}
	if len(errs) > 0 {
		result.Status = "FAIL"
	} else if len(suggestions) > 0 {
		result.Status = "WARN"
		result.Warnings = append(result.Warnings, "selection.yaml is missing high-confidence report/composite templates")
	}
	if len(suggestions) > 0 {
		if out == "" {
			out = filepath.Join(root, "selection.suggested.yaml")
		}
		result.SuggestionPath = filepath.ToSlash(out)
		if err := os.WriteFile(out, []byte(RenderTemplateSelectionYAML(TemplateSelectionPolicy{Version: 1, Templates: suggestions})), 0o644); err != nil {
			return TemplateDoctorResult{}, err
		}
		result.SuggestionWritten = true
	}
	return result, nil
}

func SuggestTemplateSelection(root string, policy TemplateSelectionPolicy) ([]TemplateSelectionRule, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return nil, err
	}
	knownTemplates := map[string]bool{}
	for _, rule := range policy.Templates {
		knownTemplates[rule.Template] = true
	}
	var suggestions []TemplateSelectionRule
	for _, doc := range corpus.Docs {
		if doc.Kind != KindTemplate || doc.IsIndex || knownTemplates[doc.Path] {
			continue
		}
		base := pathBase(doc.Path)
		if !isAllowedTemplateSelectionPath(doc.Path) {
			continue
		}
		if strings.HasPrefix(doc.Path, "templates/") && !strings.HasPrefix(base, "r-") && !strings.HasPrefix(base, "c-") {
			continue
		}
		playbook := SamePath(doc.Path, "playbooks")
		spec := SamePath(doc.Path, "spec")
		if corpus.ByPath[playbook] == nil || corpus.ByPath[spec] == nil {
			continue
		}
		ruleType := "report"
		if strings.HasPrefix(base, "c-") {
			ruleType = "composite"
		}
		suggestions = append(suggestions, TemplateSelectionRule{
			ID:       stableTemplateSelectionID(doc.Path),
			Playbook: playbook,
			Template: doc.Path,
			Type:     ruleType,
			Domain:   doc.Domain,
			Covers:   []string{spec},
			Intents:  []string{"report", "diagnosis"},
			Priority: 100,
		})
	}
	sort.Slice(suggestions, func(i, j int) bool { return suggestions[i].ID < suggestions[j].ID })
	return suggestions, nil
}

func RenderTemplateSelectionYAML(policy TemplateSelectionPolicy) string {
	var b strings.Builder
	version := policy.Version
	if version == 0 {
		version = 1
	}
	fmt.Fprintf(&b, "version: %d\n\n", version)
	b.WriteString("templates:\n")
	for _, rule := range policy.Templates {
		fmt.Fprintf(&b, "  - id: %s\n", rule.ID)
		fmt.Fprintf(&b, "    playbook: %s\n", rule.Playbook)
		fmt.Fprintf(&b, "    template: %s\n", rule.Template)
		fmt.Fprintf(&b, "    type: %s\n", rule.Type)
		if rule.Domain != "" {
			fmt.Fprintf(&b, "    domain: %s\n", rule.Domain)
		}
		writeSimpleYAMLArray(&b, "covers", rule.Covers)
		writeSimpleYAMLArray(&b, "intents", rule.Intents)
		fmt.Fprintf(&b, "    priority: %d\n", rule.Priority)
	}
	return b.String()
}

func writeSimpleYAMLArray(b *strings.Builder, key string, values []string) {
	if len(values) == 0 {
		return
	}
	fmt.Fprintf(b, "    %s:\n", key)
	for _, value := range values {
		fmt.Fprintf(b, "      - %s\n", value)
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func pathBase(logical string) string {
	parts := strings.Split(logical, "/")
	if len(parts) == 0 {
		return logical
	}
	return parts[len(parts)-1]
}

func stableTemplateSelectionID(templatePath string) string {
	id := strings.TrimSuffix(strings.TrimPrefix(templatePath, "templates/"), ".md")
	id = strings.TrimPrefix(id, "reports/")
	id = strings.ReplaceAll(id, "/", "_")
	id = strings.ReplaceAll(id, "-", "_")
	return id
}

func isReportTemplatePath(logical string) bool {
	return strings.HasPrefix(logical, "reports/") && pathBase(logical) == "template.md"
}

func isAllowedTemplateSelectionPath(logical string) bool {
	return strings.HasPrefix(logical, "templates/") || isReportTemplatePath(logical)
}
