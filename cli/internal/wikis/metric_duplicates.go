package wikis

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"harness-data/cli/internal/harness"
)

const (
	MetricDuplicateActionDeprecateDuplicates = "deprecate_duplicates"
	MetricDuplicateActionMergeLater          = "merge_later"
	MetricDuplicateActionManualReview        = "manual_review"
	MetricDuplicateActionIgnoreNotSameMetric = "ignore_not_same_metric"
)

type MetricDuplicatesReport struct {
	MetricFilesScanned      int                    `json:"metricFilesScanned"`
	DuplicateLabelGroups    int                    `json:"duplicateLabelGroups"`
	DuplicateChineseGroups  int                    `json:"duplicateChineseGroups"`
	DuplicateCodeGroups     int                    `json:"duplicateCodeGroups"`
	DuplicateNameGroups     int                    `json:"duplicateNameGroups"`
	DuplicateBasenameGroups int                    `json:"duplicateBasenameGroups"`
	CrossSystemGroups       int                    `json:"crossSystemGroups"`
	Groups                  []MetricDuplicateGroup `json:"groups,omitempty"`
}

type MetricDuplicatesFile struct {
	Version     int                    `json:"version"`
	Root        string                 `json:"root"`
	GeneratedBy string                 `json:"generated_by"`
	Groups      []MetricDuplicateGroup `json:"groups"`
}

type LiteMetricDuplicatesFile struct {
	Version    int                        `json:"version"`
	Format     string                     `json:"format"`
	Duplicates []LiteMetricDuplicateGroup `json:"duplicates"`
}

type LiteMetricDuplicateGroup struct {
	By        string   `json:"by"`
	Value     string   `json:"value"`
	Label     string   `json:"label,omitempty"`
	Severity  string   `json:"severity"`
	Files     []string `json:"files"`
	Canonical string   `json:"canonical"`
	Action    string   `json:"action"`
	Notes     string   `json:"notes"`
}

type MetricDuplicateGroup struct {
	ID        string                    `json:"id"`
	MatchType string                    `json:"match_type"`
	Label     string                    `json:"label,omitempty"`
	Value     string                    `json:"value,omitempty"`
	Severity  string                    `json:"severity"`
	Reason    string                    `json:"reason"`
	Files     []MetricDuplicateFileItem `json:"files"`
	Decision  MetricDuplicateDecision   `json:"decision"`
}

type MetricDuplicateFileItem struct {
	Path   string `json:"path"`
	Domain string `json:"domain"`
	Group  string `json:"group"`
	Name   string `json:"name"`
	Code   string `json:"code"`
	Label  string `json:"label"`
	Status string `json:"status"`
}

type MetricDuplicateDecision struct {
	Canonical string `json:"canonical"`
	Action    string `json:"action"`
	Notes     string `json:"notes"`
}

type MetricDuplicatesLintResult struct {
	OK       bool                        `json:"ok"`
	Errors   []MetricDuplicatesLintIssue `json:"errors"`
	Warnings []MetricDuplicatesLintIssue `json:"warnings"`
}

type MetricDuplicatesLintIssue struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Group   string `json:"group,omitempty"`
	Field   string `json:"field,omitempty"`
	Value   string `json:"value,omitempty"`
	Message string `json:"message"`
}

type MetricDuplicatesImportResult struct {
	Applied         bool                           `json:"applied"`
	GroupsScanned   int                            `json:"groupsScanned"`
	FilesToUpdate   int                            `json:"filesToUpdate"`
	CanonicalMarks  int                            `json:"canonicalMarks"`
	DeprecatedMarks int                            `json:"deprecatedMarks"`
	MergeLaterMarks int                            `json:"mergeLaterMarks"`
	Changes         []MetricDuplicatesImportChange `json:"changes"`
	Lint            MetricDuplicatesLintResult     `json:"lint"`
}

type MetricDuplicatesImportChange struct {
	Group  string            `json:"group"`
	Path   string            `json:"path"`
	Fields map[string]string `json:"fields"`
	Before map[string]string `json:"before,omitempty"`
}

type metricSpec struct {
	Path     string
	Domain   string
	Group    string
	Name     string
	Code     string
	Label    string
	Chinese  string
	Basename string
}

func BuildMetricDuplicatesReport(root string) (MetricDuplicatesReport, error) {
	groups, scanned, err := buildMetricDuplicateGroups(root)
	if err != nil {
		return MetricDuplicatesReport{}, err
	}
	report := MetricDuplicatesReport{MetricFilesScanned: scanned, Groups: groups}
	for _, group := range groups {
		switch group.MatchType {
		case "label":
			report.DuplicateLabelGroups++
		case "chinese_name":
			report.DuplicateChineseGroups++
		case "code":
			report.DuplicateCodeGroups++
		case "name":
			report.DuplicateNameGroups++
		case "basename":
			report.DuplicateBasenameGroups++
		}
		if metricDuplicateCrossSystem(group.Files) {
			report.CrossSystemGroups++
		}
	}
	return report, nil
}

func ExportMetricDuplicates(root, rootLabel string) (MetricDuplicatesFile, error) {
	groups, _, err := buildMetricDuplicateGroups(root)
	if err != nil {
		return MetricDuplicatesFile{}, err
	}
	if rootLabel == "" {
		resolver, err := harness.NewPathResolver(root)
		if err != nil {
			return MetricDuplicatesFile{}, err
		}
		rootLabel = commonWikiRoot(resolver)
	}
	return MetricDuplicatesFile{
		Version:     1,
		Root:        rootLabel,
		GeneratedBy: "data-harness-cli wikis metric-duplicates export",
		Groups:      groups,
	}, nil
}

func ExportMetricDuplicatesLite(root string) (LiteMetricDuplicatesFile, error) {
	groups, _, err := buildMetricDuplicateGroups(root)
	if err != nil {
		return LiteMetricDuplicatesFile{}, err
	}
	out := LiteMetricDuplicatesFile{Version: 1, Format: "lite"}
	for _, group := range groups {
		files := make([]string, 0, len(group.Files))
		for _, file := range group.Files {
			files = append(files, file.Path)
		}
		out.Duplicates = append(out.Duplicates, LiteMetricDuplicateGroup{
			By:        group.MatchType,
			Value:     group.Value,
			Label:     group.Label,
			Severity:  group.Severity,
			Files:     files,
			Canonical: group.Decision.Canonical,
			Action:    group.Decision.Action,
			Notes:     group.Decision.Notes,
		})
	}
	return out, nil
}

func LintMetricDuplicatesFile(root, file string) (MetricDuplicatesLintResult, error) {
	data, err := ReadMetricDuplicatesFile(root, file)
	if err != nil {
		return MetricDuplicatesLintResult{}, err
	}
	return LintMetricDuplicates(root, data), nil
}

func ImportMetricDuplicates(root, file string, apply bool) (MetricDuplicatesImportResult, error) {
	data, err := ReadMetricDuplicatesFile(root, file)
	if err != nil {
		return MetricDuplicatesImportResult{}, err
	}
	lint := LintMetricDuplicates(root, data)
	result := MetricDuplicatesImportResult{Applied: apply, GroupsScanned: len(data.Groups), Lint: lint}
	if len(lint.Errors) > 0 {
		return result, nil
	}
	planned := map[string]MetricDuplicatesImportChange{}
	for _, group := range data.Groups {
		canonical := strings.TrimSpace(group.Decision.Canonical)
		action := strings.TrimSpace(group.Decision.Action)
		if canonical == "" || action == "" || action == MetricDuplicateActionManualReview || action == MetricDuplicateActionIgnoreNotSameMetric {
			continue
		}
		for _, file := range group.Files {
			fields := map[string]string{}
			if file.Path == canonical {
				fields["canonical_status"] = "canonical"
				fields["canonical_group"] = group.ID
			} else {
				status := "deprecated"
				if action == MetricDuplicateActionMergeLater {
					status = "merge_later"
				}
				fields["canonical_status"] = status
				fields["canonical_target"] = canonical
				fields["canonical_reason"] = metricDuplicateReason(group)
			}
			full := filepath.Join(root, filepath.FromSlash(file.Path))
			raw, err := os.ReadFile(full)
			if err != nil {
				return result, err
			}
			before := canonicalFrontmatterFields(raw)
			if !canonicalFieldsChanged(before, fields) {
				continue
			}
			planned[file.Path] = MetricDuplicatesImportChange{Group: group.ID, Path: file.Path, Fields: fields, Before: before}
		}
	}
	paths := make([]string, 0, len(planned))
	for p := range planned {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		change := planned[p]
		result.Changes = append(result.Changes, change)
		result.FilesToUpdate++
		switch change.Fields["canonical_status"] {
		case "canonical":
			result.CanonicalMarks++
		case "deprecated":
			result.DeprecatedMarks++
		case "merge_later":
			result.MergeLaterMarks++
		}
		if apply {
			full := filepath.Join(root, filepath.FromSlash(p))
			raw, err := os.ReadFile(full)
			if err != nil {
				return result, err
			}
			if err := os.WriteFile(full, rewriteCanonicalFrontmatter(raw, change.Fields), 0o644); err != nil {
				return result, err
			}
		}
	}
	return result, nil
}

func MarshalMetricDuplicatesJSON(data MetricDuplicatesFile) ([]byte, error) {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func MarshalMetricDuplicatesLiteJSON(data LiteMetricDuplicatesFile) ([]byte, error) {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func WriteMetricDuplicatesYAML(file string, data MetricDuplicatesFile) error {
	out := FormatMetricDuplicatesYAML(data)
	if dir := filepath.Dir(file); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(file, []byte(out), 0o644)
}

func WriteMetricDuplicatesLiteYAML(file string, data LiteMetricDuplicatesFile) error {
	out := FormatMetricDuplicatesLiteYAML(data)
	if dir := filepath.Dir(file); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(file, []byte(out), 0o644)
}

func FormatMetricDuplicatesYAML(data MetricDuplicatesFile) string {
	var b strings.Builder
	fmt.Fprintf(&b, "version: %d\n", data.Version)
	fmt.Fprintf(&b, "root: %s\n", quoteYAML(data.Root))
	fmt.Fprintf(&b, "generated_by: %s\n", quoteYAML(data.GeneratedBy))
	b.WriteString("groups:\n")
	for _, group := range data.Groups {
		fmt.Fprintf(&b, "  - id: %s\n", quoteYAML(group.ID))
		writeScalar(&b, 4, "match_type", group.MatchType)
		writeScalar(&b, 4, "label", group.Label)
		writeScalar(&b, 4, "value", group.Value)
		writeScalar(&b, 4, "severity", group.Severity)
		writeScalar(&b, 4, "reason", group.Reason)
		b.WriteString("    files:\n")
		for _, file := range group.Files {
			fmt.Fprintf(&b, "      - path: %s\n", quoteYAML(file.Path))
			writeScalar(&b, 8, "domain", file.Domain)
			writeScalar(&b, 8, "group", file.Group)
			writeScalar(&b, 8, "name", file.Name)
			writeScalar(&b, 8, "code", file.Code)
			writeScalar(&b, 8, "label", file.Label)
			writeScalar(&b, 8, "status", file.Status)
		}
		b.WriteString("    decision:\n")
		writeScalar(&b, 6, "canonical", group.Decision.Canonical)
		writeScalar(&b, 6, "action", group.Decision.Action)
		writeScalar(&b, 6, "notes", group.Decision.Notes)
	}
	return b.String()
}

func FormatMetricDuplicatesLiteYAML(data LiteMetricDuplicatesFile) string {
	var b strings.Builder
	fmt.Fprintf(&b, "version: %d\n", data.Version)
	writeScalar(&b, 0, "format", "lite")
	b.WriteString("duplicates:\n")
	for _, group := range data.Duplicates {
		fmt.Fprintf(&b, "  - by: %s\n", quoteYAML(group.By))
		writeScalar(&b, 4, "value", group.Value)
		writeScalar(&b, 4, "label", group.Label)
		writeScalar(&b, 4, "severity", group.Severity)
		b.WriteString("    files:\n")
		for _, file := range group.Files {
			fmt.Fprintf(&b, "      - %s\n", quoteYAML(file))
		}
		writeScalar(&b, 4, "canonical", group.Canonical)
		writeScalar(&b, 4, "action", group.Action)
		writeScalar(&b, 4, "notes", group.Notes)
	}
	return b.String()
}

func ReadMetricDuplicatesFile(root, file string) (MetricDuplicatesFile, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return MetricDuplicatesFile{}, err
	}
	if strings.HasSuffix(file, ".json") {
		var probe struct {
			Format     string          `json:"format"`
			Groups     json.RawMessage `json:"groups"`
			Duplicates json.RawMessage `json:"duplicates"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			return MetricDuplicatesFile{}, err
		}
		if probe.Format == "lite" || len(probe.Duplicates) > 0 {
			var lite LiteMetricDuplicatesFile
			if err := json.Unmarshal(data, &lite); err != nil {
				return MetricDuplicatesFile{}, err
			}
			return NormalizeMetricDuplicates(root, lite)
		}
		var out MetricDuplicatesFile
		if err := json.Unmarshal(data, &out); err != nil {
			return MetricDuplicatesFile{}, err
		}
		return out, nil
	}
	if metricDuplicatesYAMLIsLite(data) {
		lite, err := parseLiteMetricDuplicatesYAML(data)
		if err != nil {
			return MetricDuplicatesFile{}, err
		}
		return NormalizeMetricDuplicates(root, lite)
	}
	return parseMetricDuplicatesYAML(data)
}

func NormalizeMetricDuplicates(root string, data LiteMetricDuplicatesFile) (MetricDuplicatesFile, error) {
	specs, err := loadMetricSpecs(root)
	if err != nil {
		return MetricDuplicatesFile{}, err
	}
	specByPath := map[string]metricSpec{}
	for _, spec := range specs {
		specByPath[spec.Path] = spec
	}
	out := MetricDuplicatesFile{Version: data.Version}
	if out.Version == 0 {
		out.Version = 1
	}
	for _, lite := range data.Duplicates {
		group := MetricDuplicateGroup{
			ID:        metricDuplicateID(lite.By, lite.Value),
			MatchType: lite.By,
			Label:     lite.Label,
			Value:     lite.Value,
			Severity:  lite.Severity,
			Decision: MetricDuplicateDecision{
				Canonical: lite.Canonical,
				Action:    lite.Action,
				Notes:     lite.Notes,
			},
		}
		for _, filePath := range lite.Files {
			item := MetricDuplicateFileItem{Path: filePath, Status: "undecided"}
			if spec, ok := specByPath[filePath]; ok {
				item.Domain = spec.Domain
				item.Group = spec.Group
				item.Name = spec.Name
				item.Code = spec.Code
				item.Label = spec.Label
			}
			group.Files = append(group.Files, item)
		}
		if group.Label == "" {
			group.Label = duplicateGroupLabel(group.MatchType, group.Value)
		}
		if group.Severity == "" {
			if metricDuplicateCrossSystem(group.Files) {
				group.Severity = "error"
			} else {
				group.Severity = "warn"
			}
		}
		if metricDuplicateCrossSystem(group.Files) || group.Severity == "error" {
			group.Reason = "同一指标不应同时出现在 CMR 和 IDX"
		} else {
			group.Reason = "精确重复命中，需要人工确认唯一 canonical owner"
		}
		out.Groups = append(out.Groups, group)
	}
	return out, nil
}

func LintMetricDuplicates(root string, data MetricDuplicatesFile) MetricDuplicatesLintResult {
	var result MetricDuplicatesLintResult
	add := func(level, code, group, field, value, message string) {
		issue := MetricDuplicatesLintIssue{Level: level, Code: code, Group: group, Field: field, Value: value, Message: message}
		if level == "error" {
			result.Errors = append(result.Errors, issue)
		} else {
			result.Warnings = append(result.Warnings, issue)
		}
	}
	if data.Groups == nil {
		add("error", "missing_groups", "", "groups", "", "groups must be an array")
	}
	stateByPath := map[string]string{}
	for _, group := range data.Groups {
		if group.ID == "" {
			add("error", "missing_group_id", "", "id", "", "group must have id")
		}
		if group.MatchType == "" {
			add("error", "missing_match_type", group.ID, "match_type", "", "group must have match_type")
		}
		if len(group.Files) < 2 {
			add("error", "too_few_files", group.ID, "files", "", "group must contain at least 2 files")
		}
		fileSet := map[string]bool{}
		for _, file := range group.Files {
			if file.Path == "" {
				add("error", "missing_file_path", group.ID, "files.path", "", "file path must not be empty")
				continue
			}
			fileSet[file.Path] = true
			if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(file.Path))); err != nil {
				add("error", "file_not_found", group.ID, "files.path", file.Path, "file path does not exist")
			}
		}
		canonical := strings.TrimSpace(group.Decision.Canonical)
		action := strings.TrimSpace(group.Decision.Action)
		if canonical == "" {
			add("warning", "undecided_group", group.ID, "decision.canonical", "", "canonical is not decided")
		} else if !fileSet[canonical] {
			add("error", "canonical_not_in_group", group.ID, "decision.canonical", canonical, "canonical must be one of group files")
		}
		if action == "" {
			if canonical != "" {
				add("error", "missing_action", group.ID, "decision.action", "", "decision action is required when canonical is set")
			}
		} else if !allowedMetricDuplicateAction(action) {
			add("error", "invalid_action", group.ID, "decision.action", action, "unsupported decision action")
		}
		if action == MetricDuplicateActionIgnoreNotSameMetric && strings.TrimSpace(group.Decision.Notes) == "" {
			add("warning", "ignored_duplicate_missing_notes", group.ID, "decision.notes", "", "ignore_not_same_metric should explain why it is not the same metric")
		}
		if canonical != "" && action != "" && action != MetricDuplicateActionIgnoreNotSameMetric && action != MetricDuplicateActionManualReview {
			for _, file := range group.Files {
				state := "duplicate"
				if file.Path == canonical {
					state = "canonical"
					if file.Status == "deprecated" {
						add("error", "canonical_marked_deprecated", group.ID, "files.status", file.Path, "canonical file must not be marked deprecated")
					}
				}
				if prev, ok := stateByPath[file.Path]; ok && prev != state {
					add("error", "conflicting_file_decision", group.ID, "files.path", file.Path, "same file has conflicting canonical states across decisions")
				}
				stateByPath[file.Path] = state
			}
		}
	}
	result.OK = len(result.Errors) == 0
	return result
}

func buildMetricDuplicateGroups(root string) ([]MetricDuplicateGroup, int, error) {
	specs, err := loadMetricSpecs(root)
	if err != nil {
		return nil, 0, err
	}
	var groups []MetricDuplicateGroup
	addGroups := func(matchType string, values map[string][]metricSpec) {
		keys := make([]string, 0, len(values))
		for value, files := range values {
			if value != "" && len(files) > 1 {
				keys = append(keys, value)
			}
		}
		sort.Strings(keys)
		for _, value := range keys {
			files := metricDuplicateItems(values[value])
			group := MetricDuplicateGroup{
				ID:        metricDuplicateID(matchType, value),
				MatchType: matchType,
				Label:     duplicateGroupLabel(matchType, value),
				Value:     value,
				Files:     files,
				Decision:  MetricDuplicateDecision{},
			}
			if metricDuplicateCrossSystem(files) {
				group.Severity = "error"
				group.Reason = "同一指标不应同时出现在 CMR 和 IDX"
			} else {
				group.Severity = "warn"
				group.Reason = "精确重复命中，需要人工确认唯一 canonical owner"
			}
			groups = append(groups, group)
		}
	}
	byLabel := map[string][]metricSpec{}
	byChinese := map[string][]metricSpec{}
	byCode := map[string][]metricSpec{}
	byName := map[string][]metricSpec{}
	byBasename := map[string][]metricSpec{}
	for _, spec := range specs {
		byLabel[spec.Label] = append(byLabel[spec.Label], spec)
		byChinese[spec.Chinese] = append(byChinese[spec.Chinese], spec)
		byCode[spec.Code] = append(byCode[spec.Code], spec)
		byName[spec.Name] = append(byName[spec.Name], spec)
		byBasename[spec.Basename] = append(byBasename[spec.Basename], spec)
	}
	addGroups("label", byLabel)
	addGroups("chinese_name", byChinese)
	addGroups("code", byCode)
	addGroups("name", byName)
	addGroups("basename", byBasename)
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].Severity != groups[j].Severity {
			return groups[i].Severity < groups[j].Severity
		}
		if groups[i].MatchType != groups[j].MatchType {
			return groups[i].MatchType < groups[j].MatchType
		}
		return groups[i].ID < groups[j].ID
	})
	return groups, len(specs), nil
}

func loadMetricSpecs(root string) ([]metricSpec, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return nil, err
	}
	var specs []metricSpec
	for _, doc := range corpus.Docs {
		if doc.Kind != KindSpec || doc.IsIndex || doc.SpecType != SpecTypeMetric {
			continue
		}
		full := filepath.Join(root, filepath.FromSlash(doc.PhysicalRel))
		data, err := os.ReadFile(full)
		if err != nil {
			return nil, err
		}
		basic := parseMetricBasicInfo(data)
		specs = append(specs, metricSpec{
			Path:     doc.PhysicalRel,
			Domain:   firstPathPart(doc.Domain),
			Group:    restPathParts(doc.Domain),
			Name:     doc.Name,
			Code:     basic["指标英文 code"],
			Label:    doc.Label,
			Chinese:  basic["指标中文名"],
			Basename: path.Base(doc.Path),
		})
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Path < specs[j].Path })
	return specs, nil
}

func parseMetricBasicInfo(data []byte) map[string]string {
	out := map[string]string{}
	scanner := bufio.NewScanner(bytes.NewReader(stripFrontmatter(data)))
	inBasic := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "## ") {
			inBasic = line == "## 基本信息"
			continue
		}
		if !inBasic || !strings.HasPrefix(line, "|") {
			continue
		}
		cells := splitMarkdownTableRow(line)
		if len(cells) < 2 || cells[0] == "属性" || strings.HasPrefix(cells[0], ":") {
			continue
		}
		out[cells[0]] = cleanMetricTableValue(cells[1])
	}
	return out
}

func splitMarkdownTableRow(line string) []string {
	line = strings.Trim(line, "|")
	parts := strings.Split(line, "|")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, strings.TrimSpace(part))
	}
	return out
}

func cleanMetricTableValue(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, "`")
	value = strings.Trim(value, `"'`)
	return strings.TrimSpace(value)
}

func metricDuplicateItems(specs []metricSpec) []MetricDuplicateFileItem {
	items := make([]MetricDuplicateFileItem, 0, len(specs))
	for _, spec := range specs {
		items = append(items, MetricDuplicateFileItem{
			Path:   spec.Path,
			Domain: spec.Domain,
			Group:  spec.Group,
			Name:   spec.Name,
			Code:   spec.Code,
			Label:  spec.Label,
			Status: "undecided",
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Path < items[j].Path })
	return items
}

func metricDuplicateCrossSystem(files []MetricDuplicateFileItem) bool {
	domains := map[string]bool{}
	for _, file := range files {
		domains[file.Domain] = true
	}
	return domains["cmr"] && domains["idx"]
}

func duplicateGroupLabel(matchType, value string) string {
	if matchType == "label" || matchType == "chinese_name" {
		return value
	}
	return ""
}

func metricDuplicateID(matchType, value string) string {
	return "dup." + matchType + "." + sanitizeMetricDuplicateID(value)
}

func sanitizeMetricDuplicateID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "empty"
	}
	var b strings.Builder
	lastDot := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r > 127 {
			b.WriteRune(r)
			lastDot = false
			continue
		}
		if !lastDot {
			b.WriteByte('.')
			lastDot = true
		}
	}
	out := strings.Trim(b.String(), ".")
	if out == "" {
		return "value"
	}
	return out
}

func metricDuplicateReason(group MetricDuplicateGroup) string {
	value := group.Label
	if value == "" {
		value = group.Value
	}
	return fmt.Sprintf("duplicate %s: %s", group.MatchType, value)
}

func allowedMetricDuplicateAction(action string) bool {
	switch action {
	case MetricDuplicateActionDeprecateDuplicates, MetricDuplicateActionMergeLater, MetricDuplicateActionManualReview, MetricDuplicateActionIgnoreNotSameMetric:
		return true
	default:
		return false
	}
}

func parseMetricDuplicatesYAML(data []byte) (MetricDuplicatesFile, error) {
	lines := strings.Split(string(data), "\n")
	var out MetricDuplicatesFile
	var group *MetricDuplicateGroup
	var file *MetricDuplicateFileItem
	section := ""
	subsection := ""
	for _, raw := range lines {
		raw = strings.TrimRight(raw, " \t")
		if strings.TrimSpace(raw) == "" || strings.HasPrefix(strings.TrimSpace(raw), "#") {
			continue
		}
		indent := len(raw) - len(strings.TrimLeft(raw, " "))
		line := strings.TrimSpace(raw)
		if indent == 0 {
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			switch key {
			case "version":
				fmt.Sscanf(value, "%d", &out.Version)
			case "root":
				out.Root = cleanYAMLScalar(value)
			case "generated_by":
				out.GeneratedBy = cleanYAMLScalar(value)
			case "groups":
				section = "groups"
			}
			continue
		}
		if section != "groups" {
			continue
		}
		if indent == 2 && strings.HasPrefix(line, "- ") {
			out.Groups = append(out.Groups, MetricDuplicateGroup{})
			group = &out.Groups[len(out.Groups)-1]
			file = nil
			subsection = ""
			rest := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			if key, value, ok := splitYAMLKV(rest); ok && key == "id" {
				group.ID = cleanYAMLScalar(value)
			}
			continue
		}
		if group == nil {
			continue
		}
		if indent == 4 {
			file = nil
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			switch key {
			case "match_type":
				group.MatchType = cleanYAMLScalar(value)
			case "label":
				group.Label = cleanYAMLScalar(value)
			case "value":
				group.Value = cleanYAMLScalar(value)
			case "severity":
				group.Severity = cleanYAMLScalar(value)
			case "reason":
				group.Reason = cleanYAMLScalar(value)
			case "files", "decision":
				subsection = key
			}
			continue
		}
		if subsection == "files" && indent == 6 && strings.HasPrefix(line, "- ") {
			group.Files = append(group.Files, MetricDuplicateFileItem{})
			file = &group.Files[len(group.Files)-1]
			rest := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			if key, value, ok := splitYAMLKV(rest); ok && key == "path" {
				file.Path = cleanYAMLScalar(value)
			}
			continue
		}
		if subsection == "files" && indent == 8 && file != nil {
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			switch key {
			case "domain":
				file.Domain = cleanYAMLScalar(value)
			case "group":
				file.Group = cleanYAMLScalar(value)
			case "name":
				file.Name = cleanYAMLScalar(value)
			case "code":
				file.Code = cleanYAMLScalar(value)
			case "label":
				file.Label = cleanYAMLScalar(value)
			case "status":
				file.Status = cleanYAMLScalar(value)
			}
			continue
		}
		if subsection == "decision" && indent == 6 {
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			switch key {
			case "canonical":
				group.Decision.Canonical = cleanYAMLScalar(value)
			case "action":
				group.Decision.Action = cleanYAMLScalar(value)
			case "notes":
				group.Decision.Notes = cleanYAMLScalar(value)
			}
		}
	}
	if out.Version == 0 {
		out.Version = 1
	}
	return out, nil
}

func metricDuplicatesYAMLIsLite(data []byte) bool {
	lines := strings.Split(string(data), "\n")
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := splitYAMLKV(line)
		if !ok {
			continue
		}
		if key == "format" && cleanYAMLScalar(value) == "lite" {
			return true
		}
		if key == "duplicates" {
			return true
		}
		if key == "groups" {
			return false
		}
	}
	return false
}

func parseLiteMetricDuplicatesYAML(data []byte) (LiteMetricDuplicatesFile, error) {
	lines := strings.Split(string(data), "\n")
	var out LiteMetricDuplicatesFile
	var group *LiteMetricDuplicateGroup
	section := ""
	subsection := ""
	for _, raw := range lines {
		raw = strings.TrimRight(raw, " \t")
		if strings.TrimSpace(raw) == "" || strings.HasPrefix(strings.TrimSpace(raw), "#") {
			continue
		}
		indent := len(raw) - len(strings.TrimLeft(raw, " "))
		line := strings.TrimSpace(raw)
		if indent == 0 {
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			switch key {
			case "version":
				fmt.Sscanf(value, "%d", &out.Version)
			case "format":
				out.Format = cleanYAMLScalar(value)
			case "duplicates":
				section = "duplicates"
			}
			continue
		}
		if section != "duplicates" {
			continue
		}
		if indent == 2 && strings.HasPrefix(line, "- ") {
			out.Duplicates = append(out.Duplicates, LiteMetricDuplicateGroup{})
			group = &out.Duplicates[len(out.Duplicates)-1]
			subsection = ""
			rest := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			if key, value, ok := splitYAMLKV(rest); ok {
				setLiteMetricDuplicateField(group, key, value)
			}
			continue
		}
		if group == nil {
			continue
		}
		if indent == 4 {
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			if key == "files" {
				subsection = "files"
				continue
			}
			subsection = ""
			setLiteMetricDuplicateField(group, key, value)
			continue
		}
		if subsection == "files" && indent == 6 && strings.HasPrefix(line, "- ") {
			value := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			if key, rawValue, ok := splitYAMLKV(value); ok && key == "path" {
				value = rawValue
			}
			group.Files = append(group.Files, cleanYAMLScalar(value))
		}
	}
	if out.Version == 0 {
		out.Version = 1
	}
	if out.Format == "" {
		out.Format = "lite"
	}
	return out, nil
}

func setLiteMetricDuplicateField(group *LiteMetricDuplicateGroup, key, value string) {
	switch key {
	case "by":
		group.By = cleanYAMLScalar(value)
	case "value":
		group.Value = cleanYAMLScalar(value)
	case "label":
		group.Label = cleanYAMLScalar(value)
	case "severity":
		group.Severity = cleanYAMLScalar(value)
	case "canonical":
		group.Canonical = cleanYAMLScalar(value)
	case "action":
		group.Action = cleanYAMLScalar(value)
	case "notes":
		group.Notes = cleanYAMLScalar(value)
	}
}

func canonicalFrontmatterFields(data []byte) map[string]string {
	out := map[string]string{}
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return out
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	for i := 1; end >= 0 && i < end; i++ {
		key := topLevelYAMLKey(lines[i])
		if !isCanonicalFrontmatterKey(key) {
			continue
		}
		_, value, _ := splitYAMLKV(strings.TrimSpace(lines[i]))
		out[key] = cleanYAMLScalar(value)
	}
	return out
}

func canonicalFieldsChanged(before, after map[string]string) bool {
	for _, key := range []string{"canonical_status", "canonical_group", "canonical_target", "canonical_reason"} {
		if before[key] != after[key] {
			return true
		}
	}
	return false
}

func rewriteCanonicalFrontmatter(data []byte, fields map[string]string) []byte {
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		var b strings.Builder
		b.WriteString("---\n")
		writeCanonicalFields(&b, fields)
		b.WriteString("---\n\n")
		b.Write(data)
		return []byte(b.String())
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end == -1 {
		return data
	}
	var kept []string
	for i := 1; i < end; i++ {
		key := topLevelYAMLKey(lines[i])
		if isCanonicalFrontmatterKey(key) {
			for i+1 < end && isIndentedYAMLLine(lines[i+1]) {
				i++
			}
			continue
		}
		kept = append(kept, lines[i])
	}
	var b strings.Builder
	b.WriteString("---\n")
	for _, line := range kept {
		b.WriteString(line)
		b.WriteByte('\n')
	}
	writeCanonicalFields(&b, fields)
	b.WriteString("---")
	if end+1 < len(lines) {
		b.WriteByte('\n')
		b.WriteString(strings.Join(lines[end+1:], "\n"))
	}
	return []byte(b.String())
}

func writeCanonicalFields(b *strings.Builder, fields map[string]string) {
	for _, key := range []string{"canonical_status", "canonical_group", "canonical_target", "canonical_reason"} {
		if value := fields[key]; value != "" {
			fmt.Fprintf(b, "%s: %s\n", key, quoteYAML(value))
		}
	}
}

func isCanonicalFrontmatterKey(key string) bool {
	switch key {
	case "canonical_status", "canonical_group", "canonical_target", "canonical_reason":
		return true
	default:
		return false
	}
}
