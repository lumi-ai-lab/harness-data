package index

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"harness-data/cli/internal/frontmatter"
	"harness-data/cli/internal/harness"
)

type BuildResult struct {
	Spec     harness.IndexFile `json:"spec"`
	Routing  harness.IndexFile `json:"routing"`
	Playbook harness.IndexFile `json:"playbook"`
}

func Build(root string) (BuildResult, error) {
	specDocs, err := scan(root, "spec")
	if err != nil {
		return BuildResult{}, err
	}
	routingDocs, err := scan(root, "routing")
	if err != nil {
		return BuildResult{}, err
	}
	playbookDocs, err := scan(root, "playbooks")
	if err != nil {
		return BuildResult{}, err
	}

	result := BuildResult{
		Spec:     makeIndex(root, specDocs),
		Routing:  makeIndex(root, routingDocs),
		Playbook: makeIndex(root, playbookDocs),
	}
	if err := writeIndex(root, "spec-index.json", result.Spec); err != nil {
		return BuildResult{}, err
	}
	if err := writeIndex(root, "routing-index.json", result.Routing); err != nil {
		return BuildResult{}, err
	}
	if err := writeIndex(root, "playbook-index.json", result.Playbook); err != nil {
		return BuildResult{}, err
	}
	return result, nil
}

func AllDocuments(root string) ([]harness.Document, error) {
	var all []harness.Document
	for _, dir := range []string{"spec", "routing", "playbooks"} {
		docs, err := scan(root, dir)
		if err != nil {
			return nil, err
		}
		all = append(all, docs...)
	}
	return all, nil
}

func scan(root, dir string) ([]harness.Document, error) {
	var docs []harness.Document
	base := filepath.Join(root, dir)
	err := filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		doc, err := frontmatter.ParseFile(root, filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		docs = append(docs, doc)
		return nil
	})
	sort.Slice(docs, func(i, j int) bool { return docs[i].Path < docs[j].Path })
	return docs, err
}

func makeIndex(root string, docs []harness.Document) harness.IndexFile {
	idx := harness.IndexFile{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Root:        root,
		Files:       docs,
		ByDomain:    map[string][]string{},
		ByKeyword:   map[string][]string{},
		ByID:        map[string]string{},
	}
	for _, doc := range docs {
		idx.ByID[doc.ID] = doc.Path
		idx.ByDomain[doc.Domain] = append(idx.ByDomain[doc.Domain], doc.Path)
		for _, keyword := range doc.Match.Keywords {
			idx.ByKeyword[keyword] = append(idx.ByKeyword[keyword], doc.Path)
		}
		for _, child := range doc.Children {
			for _, keyword := range child.Keywords {
				idx.ByKeyword[keyword] = append(idx.ByKeyword[keyword], child.Path)
			}
		}
	}
	return idx
}

func writeIndex(root, name string, idx harness.IndexFile) error {
	dir := filepath.Join(root, ".harness", "index")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(filepath.Join(dir, name), data, 0o644)
}
