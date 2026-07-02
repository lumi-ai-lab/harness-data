package wikis

import (
	"bytes"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"harness-data/cli/internal/harness"
)

const (
	generatedStart = "<!-- AUTO-GENERATED:START -->"
	generatedEnd   = "<!-- AUTO-GENERATED:END -->"
)

type SyncIndexMDResult struct {
	CheckOnly bool     `json:"checkOnly"`
	Scanned   int      `json:"scanned"`
	Changed   []string `json:"changed,omitempty"`
	Created   []string `json:"created,omitempty"`
	Outdated  []string `json:"outdated,omitempty"`
}

func SyncIndexMD(root string, checkOnly bool) (SyncIndexMDResult, error) {
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return SyncIndexMDResult{}, err
	}
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return SyncIndexMDResult{}, err
	}
	dirs := indexDirs(corpus.Docs)
	result := SyncIndexMDResult{CheckOnly: checkOnly, Scanned: len(dirs)}
	for _, dir := range dirs {
		block := renderIndexBlock(corpus, dir)
		logical := path.Join(dir, "index.md")
		physicalRel := resolver.ResolveRel(logical)
		full := filepath.Join(root, filepath.FromSlash(physicalRel))
		current, readErr := os.ReadFile(full)
		exists := true
		if readErr != nil {
			if !os.IsNotExist(readErr) {
				return SyncIndexMDResult{}, readErr
			}
			exists = false
		}
		next := syncIndexContent(logical, current, block, exists)
		if exists && bytes.Equal(current, next) {
			continue
		}
		if checkOnly {
			result.Outdated = append(result.Outdated, logical)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return SyncIndexMDResult{}, err
		}
		if err := os.WriteFile(full, next, 0o644); err != nil {
			return SyncIndexMDResult{}, err
		}
		if exists {
			result.Changed = append(result.Changed, logical)
		} else {
			result.Created = append(result.Created, logical)
		}
	}
	return result, nil
}

func indexDirs(docs []Document) []string {
	dirs := map[string]bool{}
	for _, doc := range docs {
		if !isSyncIndexDocPath(doc.Path) {
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
	out := make([]string, 0, len(dirs))
	for dir := range dirs {
		if isSyncIndexDir(dir) {
			out = append(out, dir)
		}
	}
	sort.Strings(out)
	return out
}

func isSyncIndexDocPath(logical string) bool {
	return strings.HasPrefix(logical, "spec/") ||
		strings.HasPrefix(logical, "playbooks/") ||
		isStructuredPath(logical)
}

func isSyncIndexDir(dir string) bool {
	for _, root := range []string{"spec", "playbooks", "metrics", "reports", "dims", "rules"} {
		if dir == root || strings.HasPrefix(dir, root+"/") {
			return true
		}
	}
	return false
}

func isStructuredIndexDir(dir string) bool {
	for _, root := range []string{"metrics", "reports", "dims", "rules"} {
		if dir == root || strings.HasPrefix(dir, root+"/") {
			return true
		}
	}
	return false
}

func syncIndexContent(logical string, current []byte, block string, exists bool) []byte {
	if !exists {
		return []byte(defaultIndexContent(logical, block))
	}
	text := string(current)
	replacement := generatedStart + "\n\n" + block + "\n" + generatedEnd
	start := strings.Index(text, generatedStart)
	end := strings.Index(text, generatedEnd)
	if start >= 0 && end >= start {
		end += len(generatedEnd)
		next := text[:start] + replacement + text[end:]
		return []byte(ensureTrailingNewline(next))
	}
	prefix := strings.TrimRight(text, "\n")
	if prefix != "" {
		prefix += "\n\n"
	}
	return []byte(prefix + replacement + "\n")
}

func defaultIndexContent(logical, block string) string {
	return fmt.Sprintf("# %s\n\nTODO: 补充本层业务范围、阅读指引和边界规则。\n\n%s\n\n%s\n%s\n", defaultIndexTitle(logical), generatedStart, block, generatedEnd)
}

func defaultIndexTitle(logical string) string {
	dir := path.Dir(logical)
	root, domain, _ := strings.Cut(dir, "/")
	if domain == "" || domain == "." {
		switch root {
		case "spec":
			return "Spec Index"
		case "playbooks":
			return "Playbooks Index"
		case "metrics":
			return "Metrics Index"
		case "reports":
			return "Reports Index"
		case "dims":
			return "Dims Index"
		case "rules":
			return "Rules Index"
		default:
			return "Index"
		}
	}
	switch root {
	case "spec":
		return domain + " Spec Index"
	case "playbooks":
		return domain + " Playbook Index"
	case "metrics":
		return domain + " Metrics Index"
	case "reports":
		return domain + " Reports Index"
	case "dims":
		return domain + " Dims Index"
	case "rules":
		return domain + " Rules Index"
	default:
		return domain + " Index"
	}
}

func renderIndexBlock(c Corpus, dir string) string {
	var b strings.Builder
	if isStructuredIndexDir(dir) {
		return renderStructuredIndexBlock(c, dir)
	}
	kind := "spec"
	if strings.HasPrefix(dir, "playbooks") {
		kind = "playbooks"
	}
	fmt.Fprintf(&b, "## 自动索引\n\n来源：`%s`\n\n", dir)
	if kind == "spec" {
		renderSpecIndex(&b, c, dir)
	} else {
		renderPlaybookIndex(&b, c, dir)
	}
	return strings.TrimRight(b.String(), "\n")
}

func renderStructuredIndexBlock(c Corpus, dir string) string {
	var b strings.Builder
	specs, playbooks, templates := structuredDocsInDir(c.Docs, dir)
	children := childDirs(c.Docs, dir)
	fmt.Fprintf(&b, "## 自动索引\n\n来源：`%s`\n\n", dir)
	fmt.Fprintln(&b, "### 能力地图")
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "| 能力 | 代表条目 | 数量 |")
	fmt.Fprintln(&b, "| --- | --- | --- |")
	writeCapabilityRow(&b, "规格说明", representativeDocNames(specs), len(specs))
	writeCapabilityRow(&b, "取数手册", representativeDocNames(playbooks), len(playbooks))
	writeCapabilityRow(&b, "报告模板", representativeDocNames(templates), len(templates))
	writeCapabilityRow(&b, "下级目录", representativeDirs(children), len(children))
	fmt.Fprintln(&b)

	fmt.Fprintln(&b, "### 文档清单")
	fmt.Fprintln(&b)
	if len(specs) == 0 && len(playbooks) == 0 && len(templates) == 0 {
		fmt.Fprintln(&b, "暂无。")
		fmt.Fprintln(&b)
	} else {
		fmt.Fprintln(&b, "| 类型 | 文档 | 标题 |")
		fmt.Fprintln(&b, "| --- | --- | --- |")
		for _, doc := range append(append(specs, playbooks...), templates...) {
			fmt.Fprintf(&b, "| %s | `%s` | %s |\n", structuredDocType(doc), path.Base(doc.Path), tableCell(firstNonEmpty(doc.Label, doc.Title, "-")))
		}
		fmt.Fprintln(&b)
	}
	renderChildren(&b, children)
	return strings.TrimRight(b.String(), "\n")
}

func renderSpecIndex(b *strings.Builder, c Corpus, dir string) {
	metrics, concepts := specDocsInDir(c.Docs, dir)
	children := childDirs(c.Docs, dir)
	fmt.Fprintln(b, "### 能力地图")
	fmt.Fprintln(b)
	fmt.Fprintln(b, "| 能力 | 代表条目 | 数量 |")
	fmt.Fprintln(b, "| --- | --- | --- |")
	writeCapabilityRow(b, "指标定义", representativeDocNames(metrics), len(metrics))
	writeCapabilityRow(b, "规则与专题", representativeDocNames(concepts), len(concepts))
	writeCapabilityRow(b, "下级领域", representativeDirs(children), len(children))
	fmt.Fprintln(b)

	fmt.Fprintln(b, "### 指标清单")
	fmt.Fprintln(b)
	if len(metrics) == 0 {
		fmt.Fprintln(b, "暂无。")
		fmt.Fprintln(b)
	} else {
		fmt.Fprintln(b, "| 指标 | code/name | spec | playbook |")
		fmt.Fprintln(b, "| --- | --- | --- | --- |")
		for _, doc := range metrics {
			playbook := SamePath(doc.Path, "playbooks")
			fmt.Fprintf(b, "| %s | `%s` | `%s` | `%s` |\n", tableCell(firstNonEmpty(doc.Label, doc.Title, path.Base(doc.Path))), doc.Name, path.Base(doc.Path), playbook)
		}
		fmt.Fprintln(b)
	}

	fmt.Fprintln(b, "### 规则与专题")
	fmt.Fprintln(b)
	if len(concepts) == 0 {
		fmt.Fprintln(b, "暂无。")
		fmt.Fprintln(b)
	} else {
		fmt.Fprintln(b, "| 文档 | 标题 | 用途 |")
		fmt.Fprintln(b, "| --- | --- | --- |")
		for _, doc := range concepts {
			fmt.Fprintf(b, "| `%s` | %s | 规则或专题指引 |\n", path.Base(doc.Path), tableCell(firstNonEmpty(doc.Title, doc.Label, "-")))
		}
		fmt.Fprintln(b)
	}

	renderChildren(b, children)
}

func renderPlaybookIndex(b *strings.Builder, c Corpus, dir string) {
	singles, reports := playbookDocsInDir(c.Docs, dir)
	children := childDirs(c.Docs, dir)
	fmt.Fprintln(b, "### 能力地图")
	fmt.Fprintln(b)
	fmt.Fprintln(b, "| 能力 | 代表条目 | 数量 |")
	fmt.Fprintln(b, "| --- | --- | --- |")
	writeCapabilityRow(b, "单指标取数", representativeDocNames(singles), len(singles))
	writeCapabilityRow(b, "报告型取数", representativeDocNames(reports), len(reports))
	writeCapabilityRow(b, "下级领域", representativeDirs(children), len(children))
	fmt.Fprintln(b)

	fmt.Fprintln(b, "### 单指标 Playbooks")
	fmt.Fprintln(b)
	if len(singles) == 0 {
		fmt.Fprintln(b, "暂无。")
		fmt.Fprintln(b)
	} else {
		fmt.Fprintln(b, "| 指标 | playbook | spec |")
		fmt.Fprintln(b, "| --- | --- | --- |")
		for _, doc := range singles {
			specPath := doc.Playbook.SpecPath
			metric := metricName(c, specPath)
			fmt.Fprintf(b, "| %s | `%s` | `%s` |\n", tableCell(metric), path.Base(doc.Path), specPath)
		}
		fmt.Fprintln(b)
	}

	fmt.Fprintln(b, "### 报告型 Playbooks")
	fmt.Fprintln(b)
	if len(reports) == 0 {
		fmt.Fprintln(b, "暂无。")
		fmt.Fprintln(b)
	} else {
		fmt.Fprintln(b, "| 报告 | playbook | spec |")
		fmt.Fprintln(b, "| --- | --- | --- |")
		for _, doc := range reports {
			specPath := doc.Playbook.SpecPath
			report := metricName(c, specPath)
			fmt.Fprintf(b, "| %s | `%s` | `%s` |\n", tableCell(report), path.Base(doc.Path), specPath)
		}
		fmt.Fprintln(b)
	}

	renderChildren(b, children)
}

func renderChildren(b *strings.Builder, children []string) {
	fmt.Fprintln(b, "### 下级目录")
	fmt.Fprintln(b)
	if len(children) == 0 {
		fmt.Fprintln(b, "暂无。")
		return
	}
	fmt.Fprintln(b, "| 目录 | index |")
	fmt.Fprintln(b, "| --- | --- |")
	for _, child := range children {
		fmt.Fprintf(b, "| `%s/` | `%s/index.md` |\n", path.Base(child), child)
	}
}

func specDocsInDir(docs []Document, dir string) ([]Document, []Document) {
	var metrics, concepts []Document
	for _, doc := range docs {
		if doc.Kind != KindSpec || doc.IsIndex || path.Dir(doc.Path) != dir {
			continue
		}
		if doc.SpecType == SpecTypeMetric {
			metrics = append(metrics, doc)
		} else {
			concepts = append(concepts, doc)
		}
	}
	sortDocs(metrics)
	sortDocs(concepts)
	return metrics, concepts
}

func playbookDocsInDir(docs []Document, dir string) ([]Document, []Document) {
	var singles, reports []Document
	for _, doc := range docs {
		if doc.Kind != KindPlaybook || doc.IsIndex || path.Dir(doc.Path) != dir {
			continue
		}
		if doc.Playbook.IsSingle {
			singles = append(singles, doc)
		} else if strings.HasPrefix(path.Base(doc.Path), "r-") {
			reports = append(reports, doc)
		}
	}
	sortDocs(singles)
	sortDocs(reports)
	return singles, reports
}

func structuredDocsInDir(docs []Document, dir string) ([]Document, []Document, []Document) {
	var specs, playbooks, templates []Document
	for _, doc := range docs {
		if doc.IsIndex || path.Dir(doc.Path) != dir {
			continue
		}
		switch doc.Kind {
		case KindSpec:
			specs = append(specs, doc)
		case KindPlaybook:
			playbooks = append(playbooks, doc)
		case KindTemplate:
			templates = append(templates, doc)
		}
	}
	sortDocs(specs)
	sortDocs(playbooks)
	sortDocs(templates)
	return specs, playbooks, templates
}

func structuredDocType(doc Document) string {
	switch doc.Kind {
	case KindSpec:
		if doc.SpecType == SpecTypeMetric {
			return "指标规格"
		}
		return "规格说明"
	case KindPlaybook:
		return "取数手册"
	case KindTemplate:
		return "报告模板"
	default:
		return string(doc.Kind)
	}
}

func childDirs(docs []Document, dir string) []string {
	children := map[string]bool{}
	prefix := dir + "/"
	for _, doc := range docs {
		if !strings.HasPrefix(doc.Path, prefix) {
			continue
		}
		rest := strings.TrimPrefix(doc.Path, prefix)
		part, _, ok := strings.Cut(rest, "/")
		if !ok || part == "" {
			continue
		}
		children[path.Join(dir, part)] = true
	}
	out := make([]string, 0, len(children))
	for child := range children {
		out = append(out, child)
	}
	sort.Strings(out)
	return out
}

func representativeDocNames(docs []Document) string {
	if len(docs) == 0 {
		return "-"
	}
	limit := len(docs)
	if limit > 3 {
		limit = 3
	}
	names := make([]string, 0, limit)
	for _, doc := range docs[:limit] {
		names = append(names, "`"+path.Base(doc.Path)+"`")
	}
	if len(docs) > limit {
		names = append(names, "...")
	}
	return strings.Join(names, ", ")
}

func representativeDirs(dirs []string) string {
	if len(dirs) == 0 {
		return "-"
	}
	limit := len(dirs)
	if limit > 3 {
		limit = 3
	}
	names := make([]string, 0, limit)
	for _, dir := range dirs[:limit] {
		names = append(names, "`"+path.Base(dir)+"/`")
	}
	if len(dirs) > limit {
		names = append(names, "...")
	}
	return strings.Join(names, ", ")
}

func writeCapabilityRow(b *strings.Builder, capability, entries string, count int) {
	fmt.Fprintf(b, "| %s | %s | %d |\n", capability, entries, count)
}

func metricName(c Corpus, specPath string) string {
	if doc := c.ByPath[specPath]; doc != nil {
		return firstNonEmpty(doc.Label, doc.Title, path.Base(specPath))
	}
	return path.Base(specPath)
}

func sortDocs(docs []Document) {
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
}

func tableCell(value string) string {
	value = firstNonEmpty(value, "-")
	value = strings.ReplaceAll(value, "|", "\\|")
	value = strings.ReplaceAll(value, "\n", " ")
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func ensureTrailingNewline(text string) string {
	if strings.HasSuffix(text, "\n") {
		return text
	}
	return text + "\n"
}
