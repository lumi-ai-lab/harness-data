package wikis

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"harness-data/cli/internal/harness"
)

const (
	IndexRel        = ".harness/index/wikis-index.json"
	RuntimeIndexRel = ".harness/index/wikis-runtime-index.json"
)

type CheckFailedError struct {
	Total int
}

func (e CheckFailedError) Error() string {
	return fmt.Sprintf("wikis check-all failed with %d error(s); index not updated", e.Total)
}

func BuildIndex(root string, skipChecks bool) (BuildIndexResult, error) {
	if !skipChecks {
		results, err := RunAllChecks(root, CheckOptions{MaxErrors: 500})
		if err != nil {
			return BuildIndexResult{}, err
		}
		if totalCheckErrors(results) > 0 {
			return BuildIndexResult{}, CheckFailedError{Total: totalCheckErrors(results)}
		}
	}

	if err := checkReliableBuildInputs(root); err != nil {
		return BuildIndexResult{}, err
	}
	corpus, _, err := LoadCorpus(root)
	if err != nil {
		return BuildIndexResult{}, err
	}
	cfg, err := harness.LoadPathsConfig(root)
	if err != nil {
		return BuildIndexResult{}, err
	}
	idx := Index{
		Meta: IndexMeta{
			Version:       1,
			GeneratedAt:   time.Now().UTC().Format(time.RFC3339),
			Root:          root,
			ChecksSkipped: skipChecks,
			Paths: map[string]string{
				"spec":      cfg.Spec,
				"playbooks": cfg.Playbooks,
				"templates": cfg.Templates,
				"routing":   cfg.Routing,
			},
		},
		Docs:   corpus.Docs,
		Recall: buildRecall(corpus.Docs),
	}
	runtime := buildRuntimeIndex(idx)
	if err := writeIndexAtomic(root, idx); err != nil {
		return BuildIndexResult{}, err
	}
	if err := writeRuntimeIndexAtomic(root, runtime); err != nil {
		return BuildIndexResult{}, err
	}
	return BuildIndexResult{
		Path:               IndexRel,
		RuntimePath:        RuntimeIndexRel,
		ChecksSkipped:      skipChecks,
		DocCount:           len(idx.Docs),
		RecallCount:        len(idx.Recall),
		RuntimeDocCount:    len(runtime.DocsByPath),
		RuntimeRecallCount: len(runtime.Recall),
	}, nil
}

func LoadIndex(root string) (Index, error) {
	data, err := os.ReadFile(filepath.Join(root, IndexRel))
	if err != nil {
		return Index{}, err
	}
	var idx Index
	if err := json.Unmarshal(data, &idx); err != nil {
		return Index{}, err
	}
	return idx, nil
}

func LoadRuntimeIndex(root string) (RuntimeIndex, error) {
	data, err := os.ReadFile(filepath.Join(root, RuntimeIndexRel))
	if err != nil {
		if os.IsNotExist(err) {
			idx, loadErr := LoadIndex(root)
			if loadErr != nil {
				return RuntimeIndex{}, loadErr
			}
			return buildRuntimeIndex(idx), nil
		}
		return RuntimeIndex{}, err
	}
	var idx RuntimeIndex
	if err := json.Unmarshal(data, &idx); err != nil {
		return RuntimeIndex{}, err
	}
	return idx, nil
}

func checkReliableBuildInputs(root string) error {
	for _, name := range []string{CheckFrontmatter, CheckAliases, CheckCovers} {
		result, err := RunCheck(root, name, CheckOptions{MaxErrors: int(^uint(0) >> 1)})
		if err != nil {
			return err
		}
		for _, checkErr := range result.Errors {
			switch checkErr.Code {
			case "invalid_frontmatter_type", "invalid_covers_type", "duplicate_recall_value", "missing_covers", "invalid_cover_path", "missing_cover_target":
				return fmt.Errorf("%s: %s: %s", checkErr.Path, checkErr.Code, checkErr.Message)
			}
		}
	}
	return nil
}

func buildRuntimeIndex(idx Index) RuntimeIndex {
	docsByPath := map[string]RuntimeDocument{}
	for _, doc := range idx.Docs {
		runtimeDoc := RuntimeDocument{
			Path:     doc.Path,
			Kind:     doc.Kind,
			Domain:   doc.Domain,
			SpecType: doc.SpecType,
			Covers:   doc.Covers,
		}
		if doc.Playbook != (PlaybookRef{}) {
			playbook := doc.Playbook
			runtimeDoc.Playbook = &playbook
		}
		docsByPath[doc.Path] = runtimeDoc
	}
	recall := make([]RuntimeRecallItem, 0, len(idx.Recall))
	for _, item := range idx.Recall {
		recall = append(recall, RuntimeRecallItem{
			Term:       item.Term,
			TargetPath: item.TargetPath,
		})
	}
	return RuntimeIndex{
		Meta:       idx.Meta,
		DocsByPath: docsByPath,
		Recall:     recall,
	}
}

func buildRecall(docs []Document) []RecallItem {
	var items []RecallItem
	for _, doc := range docs {
		for field, values := range recallValues(doc) {
			for _, value := range values {
				if value == "" {
					continue
				}
				items = append(items, RecallItem{
					Term:        value,
					TargetPath:  doc.Path,
					SourceField: field,
					Rule:        "strict_contains",
				})
			}
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Term != items[j].Term {
			return items[i].Term < items[j].Term
		}
		if items[i].TargetPath != items[j].TargetPath {
			return items[i].TargetPath < items[j].TargetPath
		}
		return items[i].SourceField < items[j].SourceField
	})
	return items
}

func writeIndexAtomic(root string, idx Index) error {
	return writeJSONAtomic(root, IndexRel, idx)
}

func writeRuntimeIndexAtomic(root string, idx RuntimeIndex) error {
	return writeJSONAtomic(root, RuntimeIndexRel, idx)
}

func writeJSONAtomic(root, rel string, value any) error {
	full := filepath.Join(root, filepath.FromSlash(rel))
	dir := filepath.Dir(full)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := filepath.Join(dir, fmt.Sprintf("%s.tmp.%d", filepath.Base(rel), os.Getpid()))
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, full); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func totalCheckErrors(results []CheckResult) int {
	total := 0
	for _, result := range results {
		total += result.TotalErrors
	}
	return total
}
