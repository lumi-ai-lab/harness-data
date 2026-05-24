package index

import (
	"encoding/json"
	"os"
	"path/filepath"

	"harness-data/cli/internal/harness"
)

func Load(root string) (BuildResult, error) {
	spec, err := loadOne(root, "spec-index.json")
	if err != nil {
		return BuildResult{}, err
	}
	routing, err := loadOne(root, "routing-index.json")
	if err != nil {
		return BuildResult{}, err
	}
	playbook, err := loadOne(root, "playbook-index.json")
	if err != nil {
		return BuildResult{}, err
	}
	return BuildResult{Spec: spec, Routing: routing, Playbook: playbook}, nil
}

func loadOne(root, name string) (harness.IndexFile, error) {
	data, err := os.ReadFile(filepath.Join(root, ".harness", "index", name))
	if err != nil {
		return harness.IndexFile{}, err
	}
	var idx harness.IndexFile
	if err := json.Unmarshal(data, &idx); err != nil {
		return harness.IndexFile{}, err
	}
	return idx, nil
}
