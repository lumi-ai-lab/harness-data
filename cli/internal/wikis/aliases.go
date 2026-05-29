package wikis

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"harness-data/cli/internal/harness"
	"harness-data/cli/internal/retrieval"
)

type AliasesReport struct {
	SpecFiles                   int `json:"specFiles"`
	SpecWithAliases             int `json:"specWithAliases"`
	SpecWithNegativeAliases     int `json:"specWithNegativeAliases"`
	PlaybookFiles               int `json:"playbookFiles"`
	PlaybookWithAliases         int `json:"playbookWithAliases"`
	PlaybookWithNegativeAliases int `json:"playbookWithNegativeAliases"`
	DuplicateLabels             int `json:"duplicateLabels"`
	DuplicateAliases            int `json:"duplicateAliases"`
	PlaceholderShortDocs        int `json:"placeholderShortDocs"`
}

type AliasesFile struct {
	Version int           `json:"version"`
	Format  string        `json:"format,omitempty"`
	Root    string        `json:"root,omitempty"`
	Targets []string      `json:"targets,omitempty"`
	Items   []AliasesItem `json:"items,omitempty"`
}

type LiteAliasesFile struct {
	Version   int               `json:"version"`
	Format    string            `json:"format"`
	Specs     []LiteAliasesItem `json:"specs"`
	Playbooks []LiteAliasesItem `json:"playbooks"`
}

type LiteAliasesItem struct {
	ID              string   `json:"id"`
	Label           string   `json:"label,omitempty"`
	Code            string   `json:"code,omitempty"`
	Aliases         []string `json:"aliases"`
	NegativeAliases []string `json:"negative_aliases"`
}

type AliasesItem struct {
	ID       string           `json:"id"`
	Label    string           `json:"label,omitempty"`
	Code     string           `json:"code,omitempty"`
	Domain   string           `json:"domain,omitempty"`
	Group    string           `json:"group,omitempty"`
	FileKey  string           `json:"file_key"`
	Paths    AliasesPaths     `json:"paths"`
	Spec     *AliasesFieldSet `json:"spec,omitempty"`
	Playbook *AliasesFieldSet `json:"playbook,omitempty"`
	Notes    string           `json:"notes,omitempty"`
}

type AliasesPaths struct {
	Spec     string `json:"spec,omitempty"`
	Playbook string `json:"playbook,omitempty"`
	Template string `json:"template,omitempty"`
}

type AliasesFieldSet struct {
	Aliases         []string `json:"aliases"`
	NegativeAliases []string `json:"negative_aliases"`
}

type AliasesLintResult struct {
	OK       bool               `json:"ok"`
	Errors   []AliasesLintIssue `json:"errors"`
	Warnings []AliasesLintIssue `json:"warnings"`
}

type AliasesLintIssue struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Item    string `json:"item,omitempty"`
	Field   string `json:"field,omitempty"`
	Value   string `json:"value,omitempty"`
	Message string `json:"message"`
}

type AliasesImportResult struct {
	Applied              bool                  `json:"applied"`
	FilesScanned         int                   `json:"filesScanned"`
	FilesToUpdate        int                   `json:"filesToUpdate"`
	AliasesAdded         int                   `json:"aliasesAdded"`
	NegativeAliasesAdded int                   `json:"negativeAliasesAdded"`
	Changes              []AliasesImportChange `json:"changes"`
	Lint                 AliasesLintResult     `json:"lint"`
}

type AliasesQualityOptions struct {
	MinAliasRunes           int
	MaxAliasRunes           int
	RequireAliases          bool
	MinSpecAliases          int
	MinComboPlaybookAliases int
}

type AliasesImportChange struct {
	Path                   string   `json:"path"`
	AliasesAdded           []string `json:"aliasesAdded,omitempty"`
	AliasesRemoved         []string `json:"aliasesRemoved,omitempty"`
	NegativeAliasesAdded   []string `json:"negativeAliasesAdded,omitempty"`
	NegativeAliasesRemoved []string `json:"negativeAliasesRemoved,omitempty"`
}

func BuildAliasesReport(root string) (AliasesReport, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return AliasesReport{}, err
	}
	var report AliasesReport
	labels := map[string]int{}
	aliases := map[string]int{}
	for _, doc := range corpus.Docs {
		if !isAliasTarget(doc) {
			continue
		}
		if doc.Kind == KindSpec {
			report.SpecFiles++
			if doc.Label != "" {
				labels[doc.Label]++
			}
			if len(doc.Aliases) > 0 {
				report.SpecWithAliases++
			}
			if len(doc.NegativeAliases) > 0 {
				report.SpecWithNegativeAliases++
			}
		}
		if doc.Kind == KindPlaybook {
			report.PlaybookFiles++
			if len(doc.Aliases) > 0 {
				report.PlaybookWithAliases++
			}
			if len(doc.NegativeAliases) > 0 {
				report.PlaybookWithNegativeAliases++
			}
		}
		for _, alias := range doc.Aliases {
			aliases[alias]++
		}
		if isPlaceholderShortDoc(root, doc.PhysicalRel) {
			report.PlaceholderShortDocs++
		}
	}
	report.DuplicateLabels = duplicateValueCount(labels)
	report.DuplicateAliases = duplicateValueCount(aliases)
	return report, nil
}

func ExportAliases(root string, targets []string) (AliasesFile, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return AliasesFile{}, err
	}
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return AliasesFile{}, err
	}
	targetSet := aliasTargetSet(targets)
	itemsByKey := map[string]*AliasesItem{}
	for _, doc := range corpus.Docs {
		if !isAliasTarget(doc) || !aliasTargetAllowed(targetSet, doc.Kind) {
			continue
		}
		fileKey := aliasFileKey(doc.Path)
		item := itemsByKey[fileKey]
		if item == nil {
			item = &AliasesItem{
				ID:      strings.ReplaceAll(strings.TrimSuffix(fileKey, ".md"), "/", "."),
				Domain:  firstPathPart(doc.Domain),
				Group:   restPathParts(doc.Domain),
				FileKey: fileKey,
				Paths:   AliasesPaths{Template: resolver.ResolveRel("templates/" + fileKey)},
				Notes:   "",
			}
			itemsByKey[fileKey] = item
		}
		if doc.Kind == KindSpec {
			item.Label = doc.Label
			item.Code = doc.Name
			item.Paths.Spec = doc.PhysicalRel
			item.Spec = &AliasesFieldSet{Aliases: doc.Aliases, NegativeAliases: doc.NegativeAliases}
		}
		if doc.Kind == KindPlaybook {
			item.Paths.Playbook = doc.PhysicalRel
			item.Playbook = &AliasesFieldSet{Aliases: doc.Aliases, NegativeAliases: doc.NegativeAliases}
		}
	}
	keys := make([]string, 0, len(itemsByKey))
	for key := range itemsByKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	items := make([]AliasesItem, 0, len(keys))
	for _, key := range keys {
		items = append(items, *itemsByKey[key])
	}
	return AliasesFile{Version: 1, Root: commonWikiRoot(resolver), Targets: sortedTargets(targetSet), Items: items}, nil
}

func ExportAliasesLite(root string, targets []string) (LiteAliasesFile, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return LiteAliasesFile{}, err
	}
	targetSet := aliasTargetSet(targets)
	var specs []LiteAliasesItem
	var playbooks []LiteAliasesItem
	for _, doc := range corpus.Docs {
		if !isAliasTarget(doc) || !aliasTargetAllowed(targetSet, doc.Kind) {
			continue
		}
		item := LiteAliasesItem{
			ID:              strings.ReplaceAll(strings.TrimSuffix(aliasFileKey(doc.Path), ".md"), "/", "."),
			Label:           doc.Label,
			Aliases:         doc.Aliases,
			NegativeAliases: doc.NegativeAliases,
		}
		if doc.Kind == KindSpec {
			item.Code = doc.Name
			specs = append(specs, item)
		}
		if doc.Kind == KindPlaybook {
			playbooks = append(playbooks, item)
		}
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].ID < specs[j].ID })
	sort.Slice(playbooks, func(i, j int) bool { return playbooks[i].ID < playbooks[j].ID })
	return LiteAliasesFile{Version: 1, Format: "lite", Specs: specs, Playbooks: playbooks}, nil
}

func LintAliasesFile(root, file string) (AliasesLintResult, error) {
	aliasesFile, err := ReadAliasesFile(file)
	if err != nil {
		return AliasesLintResult{}, err
	}
	return LintAliases(root, aliasesFile), nil
}

func CheckAliasesQualityFile(root, file string, opts AliasesQualityOptions) (AliasesLintResult, error) {
	aliasesFile, err := ReadAliasesFile(file)
	if err != nil {
		return AliasesLintResult{}, err
	}
	return CheckAliasesQuality(root, aliasesFile, opts), nil
}

func CheckAliasesQuality(root string, data AliasesFile, opts AliasesQualityOptions) AliasesLintResult {
	if opts.MinAliasRunes == 0 {
		opts.MinAliasRunes = 3
	}
	if opts.MaxAliasRunes == 0 {
		opts.MaxAliasRunes = 40
	}
	result := LintAliases(root, data)
	add := func(level, code, item, field, value, message string) {
		issue := AliasesLintIssue{Level: level, Code: code, Item: item, Field: field, Value: value, Message: message}
		if level == "error" {
			result.Errors = append(result.Errors, issue)
		} else {
			result.Warnings = append(result.Warnings, issue)
		}
	}

	data = resolveAliasesPaths(root, data, add)
	baseItems, err := baseRecallItems(root)
	if err != nil {
		add("error", "corpus_load_failed", "", "", "", err.Error())
		result.OK = false
		return result
	}
	comboPlaybookPaths, err := comboPlaybookPathSet(root)
	if err != nil {
		add("error", "corpus_load_failed", "", "", "", err.Error())
		result.OK = false
		return result
	}
	metricSpecPaths, err := metricSpecPathSet(root)
	if err != nil {
		add("error", "corpus_load_failed", "", "", "", err.Error())
		result.OK = false
		return result
	}

	for _, item := range data.Items {
		checkAliasQualityForField(item, "spec.aliases", item.Paths.Spec, item.Label, item.Code, item.Spec, baseItems, opts, add)
		checkAliasQualityForField(item, "playbook.aliases", item.Paths.Playbook, item.Label, item.Code, item.Playbook, baseItems, opts, add)
		if opts.RequireAliases {
			if item.Spec != nil && len(item.Spec.Aliases) == 0 {
				add("error", "aliases_required", item.ID, "spec.aliases", "", "aliases must not be empty")
			}
			if item.Playbook != nil && len(item.Playbook.Aliases) == 0 {
				add("error", "aliases_required", item.ID, "playbook.aliases", "", "aliases must not be empty")
			}
		}
		if opts.MinSpecAliases > 0 && item.Spec != nil && metricSpecPaths[aliasLogicalPath(item.Paths.Spec)] && len(item.Spec.Aliases) < opts.MinSpecAliases {
			add("error", "not_enough_aliases", item.ID, "spec.aliases", "", fmt.Sprintf("spec aliases must have at least %d entries", opts.MinSpecAliases))
		}
		if opts.MinComboPlaybookAliases > 0 && item.Playbook != nil && len(item.Playbook.Aliases) < opts.MinComboPlaybookAliases && comboPlaybookPaths[aliasLogicalPath(item.Paths.Playbook)] {
			add("error", "not_enough_aliases", item.ID, "playbook.aliases", "", fmt.Sprintf("combo playbook aliases must have at least %d entries", opts.MinComboPlaybookAliases))
		}
	}
	result.OK = len(result.Errors) == 0
	return result
}

func ImportAliases(root, file string, apply bool) (AliasesImportResult, error) {
	aliasesFile, err := ReadAliasesFile(file)
	if err != nil {
		return AliasesImportResult{}, err
	}
	lint := LintAliases(root, aliasesFile)
	result := AliasesImportResult{Applied: apply, Lint: lint}
	if len(lint.Errors) > 0 {
		return result, nil
	}
	aliasesFile = resolveAliasesPaths(root, aliasesFile, nil)
	for _, item := range aliasesFile.Items {
		targets := []struct {
			path   string
			fields *AliasesFieldSet
		}{
			{item.Paths.Spec, item.Spec},
			{item.Paths.Playbook, item.Playbook},
		}
		for _, target := range targets {
			if target.path == "" || target.fields == nil {
				continue
			}
			result.FilesScanned++
			full := filepath.Join(root, filepath.FromSlash(target.path))
			data, err := os.ReadFile(full)
			if err != nil {
				return result, err
			}
			currentAliases, currentNegative := frontmatterAliasFields(data)
			change := AliasesImportChange{
				Path:                   target.path,
				AliasesAdded:           setDiff(target.fields.Aliases, currentAliases),
				AliasesRemoved:         setDiff(currentAliases, target.fields.Aliases),
				NegativeAliasesAdded:   setDiff(target.fields.NegativeAliases, currentNegative),
				NegativeAliasesRemoved: setDiff(currentNegative, target.fields.NegativeAliases),
			}
			if !change.hasChanges() {
				continue
			}
			result.FilesToUpdate++
			result.AliasesAdded += len(change.AliasesAdded)
			result.NegativeAliasesAdded += len(change.NegativeAliasesAdded)
			result.Changes = append(result.Changes, change)
			if apply {
				updated := rewriteAliasFrontmatter(data, target.fields.Aliases, target.fields.NegativeAliases)
				if err := os.WriteFile(full, updated, 0o644); err != nil {
					return result, err
				}
			}
		}
	}
	return result, nil
}

func ReadAliasesFile(file string) (AliasesFile, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return AliasesFile{}, err
	}
	if strings.HasSuffix(file, ".json") {
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(data, &probe); err != nil {
			return AliasesFile{}, err
		}
		if _, ok := probe["specs"]; ok {
			var lite LiteAliasesFile
			if err := json.Unmarshal(data, &lite); err != nil {
				return AliasesFile{}, err
			}
			return liteAliasesToAliasesFile(lite), nil
		}
		if _, ok := probe["playbooks"]; ok {
			var lite LiteAliasesFile
			if err := json.Unmarshal(data, &lite); err != nil {
				return AliasesFile{}, err
			}
			return liteAliasesToAliasesFile(lite), nil
		}
		var out AliasesFile
		if err := json.Unmarshal(data, &out); err != nil {
			return AliasesFile{}, err
		}
		return out, nil
	}
	return parseAliasesYAML(data)
}

func WriteAliasesYAML(file string, data AliasesFile) error {
	out := FormatAliasesYAML(data)
	if dir := filepath.Dir(file); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(file, []byte(out), 0o644)
}

func WriteAliasesLiteYAML(file string, data LiteAliasesFile) error {
	out := FormatAliasesLiteYAML(data)
	if dir := filepath.Dir(file); dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(file, []byte(out), 0o644)
}

func FormatAliasesYAML(data AliasesFile) string {
	var b strings.Builder
	fmt.Fprintf(&b, "version: %d\n", data.Version)
	fmt.Fprintf(&b, "root: %s\n", quoteYAML(data.Root))
	b.WriteString("targets:\n")
	for _, target := range data.Targets {
		fmt.Fprintf(&b, "  - %s\n", quoteYAML(target))
	}
	b.WriteString("items:\n")
	for _, item := range data.Items {
		fmt.Fprintf(&b, "  - id: %s\n", quoteYAML(item.ID))
		writeScalar(&b, 4, "label", item.Label)
		writeScalar(&b, 4, "code", item.Code)
		writeScalar(&b, 4, "domain", item.Domain)
		writeScalar(&b, 4, "group", item.Group)
		writeScalar(&b, 4, "file_key", item.FileKey)
		b.WriteString("    paths:\n")
		writeScalar(&b, 6, "spec", item.Paths.Spec)
		writeScalar(&b, 6, "playbook", item.Paths.Playbook)
		writeScalar(&b, 6, "template", item.Paths.Template)
		if item.Spec != nil {
			b.WriteString("    spec:\n")
			writeArray(&b, 6, "aliases", item.Spec.Aliases)
			writeArray(&b, 6, "negative_aliases", item.Spec.NegativeAliases)
		}
		if item.Playbook != nil {
			b.WriteString("    playbook:\n")
			writeArray(&b, 6, "aliases", item.Playbook.Aliases)
			writeArray(&b, 6, "negative_aliases", item.Playbook.NegativeAliases)
		}
		writeScalar(&b, 4, "notes", item.Notes)
	}
	return b.String()
}

func FormatAliasesLiteYAML(data LiteAliasesFile) string {
	var b strings.Builder
	if data.Version == 0 {
		data.Version = 1
	}
	if data.Format == "" {
		data.Format = "lite"
	}
	fmt.Fprintf(&b, "version: %d\n", data.Version)
	fmt.Fprintf(&b, "format: %s\n", quoteYAML(data.Format))
	writeLiteSection(&b, "specs", data.Specs, true)
	writeLiteSection(&b, "playbooks", data.Playbooks, false)
	return b.String()
}

func LintAliases(root string, data AliasesFile) AliasesLintResult {
	var result AliasesLintResult
	add := func(level, code, item, field, value, message string) {
		issue := AliasesLintIssue{Level: level, Code: code, Item: item, Field: field, Value: value, Message: message}
		if level == "error" {
			result.Errors = append(result.Errors, issue)
		} else {
			result.Warnings = append(result.Warnings, issue)
		}
	}
	positiveOwners := map[string][]string{}
	labels := map[string][]AliasesItem{}
	aliasOwners := map[string][]string{}
	for _, item := range data.Items {
		if item.Label != "" {
			positiveOwners[item.Label] = append(positiveOwners[item.Label], item.ID)
			labels[item.Label] = append(labels[item.Label], item)
		}
		if item.Code != "" {
			positiveOwners[item.Code] = append(positiveOwners[item.Code], item.ID)
		}
		for _, fields := range []*AliasesFieldSet{item.Spec, item.Playbook} {
			if fields == nil {
				continue
			}
			for _, alias := range fields.Aliases {
				positiveOwners[alias] = append(positiveOwners[alias], item.ID)
				aliasOwners[alias] = append(aliasOwners[alias], item.ID)
			}
		}
	}
	data = resolveAliasesPaths(root, data, add)
	for _, item := range data.Items {
		checkAliasPath(root, item, item.Paths.Spec, "spec", add)
		checkAliasPath(root, item, item.Paths.Playbook, "playbook", add)
		for fieldName, fields := range map[string]*AliasesFieldSet{"spec": item.Spec, "playbook": item.Playbook} {
			if fields == nil {
				continue
			}
			checkAliasList(item.ID, fieldName+".aliases", fields.Aliases, add)
			checkAliasList(item.ID, fieldName+".negative_aliases", fields.NegativeAliases, add)
			for _, value := range intersectStrings(fields.Aliases, fields.NegativeAliases) {
				add("error", "alias_negative_conflict", item.ID, fieldName, value, "alias also appears in negative_aliases")
			}
			for _, alias := range fields.Aliases {
				if isGenericAlias(alias) {
					add("warning", "alias_too_generic", item.ID, fieldName+".aliases", alias, "alias is too generic")
				}
				if len([]rune(alias)) > 40 {
					add("warning", "alias_too_long", item.ID, fieldName+".aliases", alias, "alias is longer than 40 characters")
				}
			}
			for _, negative := range fields.NegativeAliases {
				owners := otherOwners(positiveOwners[negative], item.ID)
				if len(owners) == 0 {
					add("warning", "negative_alias_without_positive_owner", item.ID, fieldName+".negative_aliases", negative, "negative alias has no positive owner in aliases file")
				}
			}
		}
	}
	for alias, owners := range aliasOwners {
		if len(uniqueStrings(owners)) > 1 {
			add("warning", "alias_appears_in_multiple_items", "", "aliases", alias, "alias appears in multiple items")
		}
	}
	for label, items := range labels {
		if len(items) <= 1 {
			continue
		}
		domains := map[string]bool{}
		for _, item := range items {
			domains[item.Domain] = true
		}
		if len(domains) > 1 {
			add("warning", "label_conflict_across_domains", "", "label", label, "same label appears across domains")
		}
	}
	result.OK = len(result.Errors) == 0
	return result
}

func parseAliasesYAML(data []byte) (AliasesFile, error) {
	lines := strings.Split(string(data), "\n")
	var out AliasesFile
	var item *AliasesItem
	section := ""
	subsection := ""
	var arrayTarget *[]string
	for i := 0; i < len(lines); i++ {
		raw := strings.TrimRight(lines[i], " \t")
		if strings.TrimSpace(raw) == "" || strings.HasPrefix(strings.TrimSpace(raw), "#") {
			continue
		}
		indent := len(raw) - len(strings.TrimLeft(raw, " "))
		line := strings.TrimSpace(raw)
		if indent == 0 {
			arrayTarget = nil
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			switch key {
			case "version":
				fmt.Sscanf(value, "%d", &out.Version)
			case "format":
				out.Format = cleanYAMLScalar(value)
			case "root":
				out.Root = cleanYAMLScalar(value)
			case "targets", "items", "specs", "playbooks":
				section = key
			}
			continue
		}
		if section == "targets" && indent == 2 && strings.HasPrefix(line, "- ") {
			out.Targets = append(out.Targets, cleanYAMLScalar(strings.TrimPrefix(line, "- ")))
			continue
		}
		if section == "specs" || section == "playbooks" {
			if indent == 2 && strings.HasPrefix(line, "- ") {
				out.Items = append(out.Items, AliasesItem{})
				item = &out.Items[len(out.Items)-1]
				out.Format = "lite"
				subsection = section
				arrayTarget = nil
				if section == "specs" {
					item.Spec = &AliasesFieldSet{}
				} else {
					item.Playbook = &AliasesFieldSet{}
				}
				rest := strings.TrimSpace(strings.TrimPrefix(line, "- "))
				if key, value, ok := splitYAMLKV(rest); ok && key == "id" {
					item.ID = cleanYAMLScalar(value)
				}
				continue
			}
			if item == nil {
				continue
			}
			fields := item.Spec
			if section == "playbooks" {
				fields = item.Playbook
			}
			if indent == 4 {
				key, value, ok := splitYAMLKV(line)
				if !ok {
					continue
				}
				arrayTarget = nil
				switch key {
				case "id":
					item.ID = cleanYAMLScalar(value)
				case "label":
					item.Label = cleanYAMLScalar(value)
				case "code":
					item.Code = cleanYAMLScalar(value)
				case "aliases":
					if value != "" && !isInlineYAMLArray(value) {
						return AliasesFile{}, fmt.Errorf("aliases must be an array")
					}
					fields.Aliases = parseInlineYAMLArray(value)
					arrayTarget = &fields.Aliases
				case "negative_aliases":
					if value != "" && !isInlineYAMLArray(value) {
						return AliasesFile{}, fmt.Errorf("negative_aliases must be an array")
					}
					fields.NegativeAliases = parseInlineYAMLArray(value)
					arrayTarget = &fields.NegativeAliases
				}
				continue
			}
			if indent == 6 && arrayTarget != nil && strings.HasPrefix(line, "- ") {
				*arrayTarget = append(*arrayTarget, cleanYAMLScalar(strings.TrimPrefix(line, "- ")))
			}
			continue
		}
		if section != "items" {
			continue
		}
		if indent == 2 && strings.HasPrefix(line, "- ") {
			out.Items = append(out.Items, AliasesItem{})
			item = &out.Items[len(out.Items)-1]
			subsection = ""
			arrayTarget = nil
			rest := strings.TrimSpace(strings.TrimPrefix(line, "- "))
			if key, value, ok := splitYAMLKV(rest); ok && key == "id" {
				item.ID = cleanYAMLScalar(value)
			}
			continue
		}
		if item == nil {
			continue
		}
		if indent == 4 {
			arrayTarget = nil
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			switch key {
			case "label":
				item.Label = cleanYAMLScalar(value)
			case "code":
				item.Code = cleanYAMLScalar(value)
			case "domain":
				item.Domain = cleanYAMLScalar(value)
			case "group":
				item.Group = cleanYAMLScalar(value)
			case "file_key":
				item.FileKey = cleanYAMLScalar(value)
			case "notes":
				item.Notes = cleanYAMLScalar(value)
			case "paths", "spec", "playbook":
				subsection = key
				if key == "spec" && item.Spec == nil {
					item.Spec = &AliasesFieldSet{}
				}
				if key == "playbook" && item.Playbook == nil {
					item.Playbook = &AliasesFieldSet{}
				}
			}
			continue
		}
		if indent == 6 {
			key, value, ok := splitYAMLKV(line)
			if !ok {
				continue
			}
			if subsection == "paths" {
				switch key {
				case "spec":
					item.Paths.Spec = cleanYAMLScalar(value)
				case "playbook":
					item.Paths.Playbook = cleanYAMLScalar(value)
				case "template":
					item.Paths.Template = cleanYAMLScalar(value)
				}
				continue
			}
			fields := item.Spec
			if subsection == "playbook" {
				fields = item.Playbook
			}
			if fields == nil {
				continue
			}
			switch key {
			case "aliases":
				if value != "" && !isInlineYAMLArray(value) {
					return AliasesFile{}, fmt.Errorf("aliases must be an array")
				}
				fields.Aliases = parseInlineYAMLArray(value)
				arrayTarget = &fields.Aliases
			case "negative_aliases":
				if value != "" && !isInlineYAMLArray(value) {
					return AliasesFile{}, fmt.Errorf("negative_aliases must be an array")
				}
				fields.NegativeAliases = parseInlineYAMLArray(value)
				arrayTarget = &fields.NegativeAliases
			}
			continue
		}
		if indent == 8 && arrayTarget != nil && strings.HasPrefix(line, "- ") {
			*arrayTarget = append(*arrayTarget, cleanYAMLScalar(strings.TrimPrefix(line, "- ")))
		}
	}
	if out.Version == 0 {
		out.Version = 1
	}
	return out, nil
}

func liteAliasesToAliasesFile(lite LiteAliasesFile) AliasesFile {
	out := AliasesFile{Version: lite.Version, Format: "lite"}
	if out.Version == 0 {
		out.Version = 1
	}
	for _, spec := range lite.Specs {
		out.Items = append(out.Items, AliasesItem{
			ID:    spec.ID,
			Label: spec.Label,
			Code:  spec.Code,
			Spec:  &AliasesFieldSet{Aliases: spec.Aliases, NegativeAliases: spec.NegativeAliases},
		})
	}
	for _, playbook := range lite.Playbooks {
		out.Items = append(out.Items, AliasesItem{
			ID:       playbook.ID,
			Label:    playbook.Label,
			Code:     playbook.Code,
			Playbook: &AliasesFieldSet{Aliases: playbook.Aliases, NegativeAliases: playbook.NegativeAliases},
		})
	}
	return out
}

func resolveAliasesPaths(root string, data AliasesFile, add func(string, string, string, string, string, string)) AliasesFile {
	needsResolve := data.Format == "lite"
	if !needsResolve {
		for _, item := range data.Items {
			if item.Spec != nil && item.Paths.Spec == "" {
				needsResolve = true
			}
			if item.Playbook != nil && item.Paths.Playbook == "" {
				needsResolve = true
			}
		}
	}
	if !needsResolve {
		return data
	}
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		if add != nil {
			add("error", "corpus_load_failed", "", "", "", err.Error())
		}
		return data
	}
	specs := map[string]Document{}
	playbooks := map[string]Document{}
	for _, doc := range corpus.Docs {
		if !isAliasTarget(doc) {
			continue
		}
		id := strings.ReplaceAll(strings.TrimSuffix(aliasFileKey(doc.Path), ".md"), "/", ".")
		if doc.Kind == KindSpec {
			specs[id] = doc
		}
		if doc.Kind == KindPlaybook {
			playbooks[id] = doc
		}
	}
	for i := range data.Items {
		item := &data.Items[i]
		if item.Spec != nil && item.Paths.Spec == "" {
			doc, ok := specs[item.ID]
			if !ok {
				if add != nil {
					add("error", "id_not_found", item.ID, "id", item.ID, "spec id not found in corpus")
				}
			} else {
				item.Paths.Spec = doc.PhysicalRel
				item.FileKey = aliasFileKey(doc.Path)
				if item.Label == "" {
					item.Label = doc.Label
				}
				if item.Code == "" {
					item.Code = doc.Name
				}
			}
		}
		if item.Playbook != nil && item.Paths.Playbook == "" {
			doc, ok := playbooks[item.ID]
			if !ok {
				if add != nil {
					add("error", "id_not_found", item.ID, "id", item.ID, "playbook id not found in corpus")
				}
			} else {
				item.Paths.Playbook = doc.PhysicalRel
				item.FileKey = aliasFileKey(doc.Path)
				if item.Label == "" {
					item.Label = doc.Label
				}
			}
		}
	}
	return data
}

func rewriteAliasFrontmatter(data []byte, aliases, negativeAliases []string) []byte {
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		var b strings.Builder
		b.WriteString("---\n")
		writeFrontmatterArray(&b, "aliases", aliases)
		writeFrontmatterArray(&b, "negative_aliases", negativeAliases)
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
		if key == "aliases" || key == "negative_aliases" {
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
	writeFrontmatterArray(&b, "aliases", aliases)
	writeFrontmatterArray(&b, "negative_aliases", negativeAliases)
	b.WriteString("---")
	if end+1 < len(lines) {
		b.WriteByte('\n')
		b.WriteString(strings.Join(lines[end+1:], "\n"))
	}
	return []byte(b.String())
}

func frontmatterAliasFields(data []byte) ([]string, []string) {
	fm, _ := parseFrontmatter("", data)
	aliases, _ := fm.Fields["aliases"].([]string)
	negative, _ := fm.Fields["negative_aliases"].([]string)
	return aliases, negative
}

func isAliasTarget(doc Document) bool {
	return !doc.IsIndex && (doc.Kind == KindSpec || doc.Kind == KindPlaybook)
}

func aliasFileKey(logical string) string {
	_, rest, ok := strings.Cut(logical, "/")
	if !ok {
		return logical
	}
	return rest
}

func aliasTargetSet(targets []string) map[string]bool {
	if len(targets) == 0 {
		targets = []string{"spec", "playbooks"}
	}
	out := map[string]bool{}
	for _, target := range targets {
		target = strings.TrimSpace(target)
		if target == "playbook" {
			target = "playbooks"
		}
		if target == "spec" || target == "playbooks" {
			out[target] = true
		}
	}
	return out
}

func aliasTargetAllowed(targets map[string]bool, kind Kind) bool {
	switch kind {
	case KindSpec:
		return targets["spec"]
	case KindPlaybook:
		return targets["playbooks"]
	default:
		return false
	}
}

func sortedTargets(targets map[string]bool) []string {
	out := make([]string, 0, len(targets))
	for target := range targets {
		out = append(out, target)
	}
	sort.Strings(out)
	return out
}

func commonWikiRoot(resolver harness.PathResolver) string {
	roots := []string{resolver.Paths.Spec, resolver.Paths.Playbooks}
	prefix := path.Dir(roots[0])
	for _, root := range roots[1:] {
		for prefix != "." && prefix != "" && !strings.HasPrefix(root, prefix+"/") {
			prefix = path.Dir(prefix)
		}
	}
	if prefix == "." || prefix == "" {
		return "."
	}
	return prefix
}

func isPlaceholderShortDoc(root, rel string) bool {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return false
	}
	body := strings.TrimSpace(string(stripFrontmatter(data)))
	lines := strings.Split(body, "\n")
	var text []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		text = append(text, line)
	}
	joined := strings.Join(text, "")
	return len([]rune(joined)) <= 20 || strings.Contains(joined, "待补充") || strings.Contains(strings.ToLower(joined), "todo")
}

func duplicateValueCount(values map[string]int) int {
	count := 0
	for _, n := range values {
		if n > 1 {
			count++
		}
	}
	return count
}

func writeScalar(b *strings.Builder, indent int, key, value string) {
	fmt.Fprintf(b, "%s%s: %s\n", strings.Repeat(" ", indent), key, quoteYAML(value))
}

func writeArray(b *strings.Builder, indent int, key string, values []string) {
	fmt.Fprintf(b, "%s%s:\n", strings.Repeat(" ", indent), key)
	for _, value := range values {
		fmt.Fprintf(b, "%s- %s\n", strings.Repeat(" ", indent+2), quoteYAML(value))
	}
}

func writeLiteSection(b *strings.Builder, name string, items []LiteAliasesItem, includeCode bool) {
	fmt.Fprintf(b, "%s:\n", name)
	for _, item := range items {
		fmt.Fprintf(b, "  - id: %s\n", quoteYAML(item.ID))
		writeScalar(b, 4, "label", item.Label)
		if includeCode {
			writeScalar(b, 4, "code", item.Code)
		}
		writeArrayLite(b, 4, "aliases", item.Aliases)
		writeArrayLite(b, 4, "negative_aliases", item.NegativeAliases)
	}
}

func writeArrayLite(b *strings.Builder, indent int, key string, values []string) {
	if len(values) == 0 {
		fmt.Fprintf(b, "%s%s: []\n", strings.Repeat(" ", indent), key)
		return
	}
	writeArray(b, indent, key, values)
}

func writeFrontmatterArray(b *strings.Builder, key string, values []string) {
	if len(values) == 0 {
		return
	}
	fmt.Fprintf(b, "%s:\n", key)
	for _, value := range values {
		fmt.Fprintf(b, "  - %s\n", quoteYAML(value))
	}
}

func quoteYAML(value string) string {
	if value == "" {
		return `""`
	}
	if strings.ContainsAny(value, ":#[]{}\",") || strings.HasPrefix(value, " ") || strings.HasSuffix(value, " ") {
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
	return value
}

func splitYAMLKV(line string) (string, string, bool) {
	key, value, ok := strings.Cut(line, ":")
	return strings.TrimSpace(key), strings.TrimSpace(value), ok
}

func cleanYAMLScalar(value string) string {
	value = strings.TrimSpace(value)
	if value == `""` || value == "''" {
		return ""
	}
	value = strings.Trim(value, `"'`)
	return value
}

func parseInlineYAMLArray(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	inner := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(value, "["), "]"))
	if inner == "" {
		return nil
	}
	parts := strings.Split(inner, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, cleanYAMLScalar(part))
	}
	return out
}

func isInlineYAMLArray(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]")
}

func checkAliasPath(root string, item AliasesItem, rel, field string, add func(string, string, string, string, string, string)) {
	if rel == "" {
		return
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
		add("error", "file_not_found", item.ID, "paths."+field, rel, "target file does not exist")
		return
	}
	if item.FileKey != "" {
		wantSuffix := field + "/" + item.FileKey
		if field == "playbook" {
			wantSuffix = "playbooks/" + item.FileKey
		}
		if !strings.HasSuffix(filepath.ToSlash(rel), wantSuffix) {
			add("warning", "path_file_key_mismatch", item.ID, "paths."+field, rel, "path does not match file_key")
		}
	}
}

func checkAliasList(item, field string, values []string, add func(string, string, string, string, string, string)) {
	seen := map[string]bool{}
	for _, value := range values {
		if seen[value] {
			add("error", "duplicate_alias_in_item", item, field, value, "duplicate alias in same item")
		}
		seen[value] = true
	}
}

func checkAliasQualityForField(item AliasesItem, field, targetPath, label, code string, fields *AliasesFieldSet, baseItems []retrieval.Item, opts AliasesQualityOptions, add func(string, string, string, string, string, string)) {
	if fields == nil {
		return
	}
	targetLogical := aliasLogicalPath(targetPath)
	for _, alias := range fields.Aliases {
		runeLen := len([]rune(alias))
		if runeLen < opts.MinAliasRunes {
			add("error", "alias_too_short", item.ID, field, alias, fmt.Sprintf("alias is shorter than %d characters", opts.MinAliasRunes))
		}
		if runeLen > opts.MaxAliasRunes {
			add("warning", "alias_too_long", item.ID, field, alias, fmt.Sprintf("alias is longer than %d characters", opts.MaxAliasRunes))
		}
		if containsBracket(alias) {
			add("error", "alias_contains_brackets", item.ID, field, alias, "alias must not contain brackets")
		}
		if normalizedEqual(alias, label) {
			add("error", "alias_equals_label", item.ID, field, alias, "alias duplicates the metric label")
		}
		if normalizedEqual(alias, code) {
			add("error", "alias_equals_code", item.ID, field, alias, "alias duplicates the metric code")
		}
		if targetLogical == "" {
			continue
		}
		for _, match := range retrieval.Search(baseItems, alias, retrieval.Options{TopN: 0}) {
			if match.TargetPath == targetLogical {
				add("error", "alias_redundant_with_base_recall", item.ID, field, alias, fmt.Sprintf("alias query already recalls target via label/name: %s", targetLogical))
				break
			}
			add("error", "alias_overlaps_base_recall", item.ID, field, alias, fmt.Sprintf("alias query already recalls via label/name: %s", match.TargetPath))
			break
		}
	}
}

func baseRecallItems(root string) ([]retrieval.Item, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return nil, err
	}
	var items []retrieval.Item
	for _, doc := range corpus.Docs {
		if doc.Kind != KindSpec {
			continue
		}
		for _, term := range []string{doc.Label, doc.Name} {
			if term == "" {
				continue
			}
			items = append(items, retrieval.Item{Term: term, TargetPath: doc.Path})
		}
	}
	return items, nil
}

func comboPlaybookPathSet(root string) (map[string]bool, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, doc := range corpus.Docs {
		if doc.Kind == KindPlaybook && doc.Playbook.IsCombo {
			out[doc.Path] = true
		}
	}
	return out, nil
}

func metricSpecPathSet(root string) (map[string]bool, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, doc := range corpus.Docs {
		if doc.Kind == KindSpec && doc.SpecType == SpecTypeMetric {
			out[doc.Path] = true
		}
	}
	return out, nil
}

func aliasLogicalPath(pathValue string) string {
	pathValue = filepath.ToSlash(strings.TrimSpace(pathValue))
	pathValue = strings.TrimPrefix(pathValue, "wikis/")
	return pathValue
}

func normalizedEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return retrieval.NormalizeChinese(a) == retrieval.NormalizeChinese(b)
}

func containsBracket(value string) bool {
	return strings.ContainsAny(value, "()（）[]【】{}")
}

func isGenericAlias(value string) bool {
	value = strings.TrimSpace(value)
	if len([]rune(value)) <= 2 {
		return true
	}
	switch value {
	case "情况", "分析", "指标", "表现", "问题", "查看", "查询":
		return true
	default:
		return false
	}
}

func intersectStrings(a, b []string) []string {
	set := map[string]bool{}
	for _, value := range a {
		set[value] = true
	}
	var out []string
	for _, value := range b {
		if set[value] {
			out = append(out, value)
		}
	}
	return uniqueStrings(out)
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func otherOwners(owners []string, self string) []string {
	var out []string
	for _, owner := range uniqueStrings(owners) {
		if owner != self {
			out = append(out, owner)
		}
	}
	return out
}

func setDiff(a, b []string) []string {
	inB := map[string]bool{}
	for _, value := range b {
		inB[value] = true
	}
	var out []string
	for _, value := range a {
		if !inB[value] {
			out = append(out, value)
		}
	}
	return out
}

func (c AliasesImportChange) hasChanges() bool {
	return len(c.AliasesAdded)+len(c.AliasesRemoved)+len(c.NegativeAliasesAdded)+len(c.NegativeAliasesRemoved) > 0
}

func firstPathPart(value string) string {
	parts := strings.Split(strings.Trim(value, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[0]
}

func restPathParts(value string) string {
	parts := strings.Split(strings.Trim(value, "/"), "/")
	if len(parts) <= 1 {
		return ""
	}
	return strings.Join(parts[1:], "/")
}

func topLevelYAMLKey(line string) string {
	if strings.TrimSpace(line) == "" || strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
		return ""
	}
	key, _, ok := strings.Cut(strings.TrimSpace(line), ":")
	if !ok {
		return ""
	}
	return strings.TrimSpace(key)
}

func isIndentedYAMLLine(line string) bool {
	return strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") || strings.TrimSpace(line) == ""
}

func MarshalAliasesJSON(data AliasesFile) ([]byte, error) {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func MarshalAliasesLiteJSON(data LiteAliasesFile) ([]byte, error) {
	out, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}
