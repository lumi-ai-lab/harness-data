package tests

import (
	"os"
	"path/filepath"
	"testing"

	"harness-data/cli/internal/wikis"
)

func root(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(filepath.Join(wd, "..", ".."))
}

func TestBuildIndexScansFrontmatter(t *testing.T) {
	result, err := wikis.BuildIndex(root(t), false)
	if err != nil {
		t.Fatal(err)
	}
	if result.DocCount == 0 || result.RecallCount == 0 || result.ChecksSkipped {
		t.Fatalf("unexpected build result: %+v", result)
	}
	index, err := wikis.LoadIndex(root(t))
	if err != nil {
		t.Fatal(err)
	}
	docs := map[string]wikis.Document{}
	for _, doc := range index.Docs {
		docs[doc.Path] = doc
	}
	if docs["spec/cmr/member/repurchase.md"].ID != "spec/cmr/member/repurchase" {
		t.Fatalf("member repurchase not indexed: %+v", docs["spec/cmr/member/repurchase.md"])
	}
	memberPlaybook := docs["playbooks/cmr/member/default-overview.md"]
	if !memberPlaybook.Playbook.IsCombo || memberPlaybook.Playbook.TemplatePath != "templates/cmr/member/default-overview.md" {
		t.Fatalf("member playbook = %+v", memberPlaybook)
	}
	if index.Meta.Version != 1 || index.Meta.ChecksSkipped {
		t.Fatalf("bad index meta: %+v", index.Meta)
	}
	runtime, err := wikis.LoadRuntimeIndex(root(t))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.DocsByPath["playbooks/cmr/member/default-overview.md"].Playbook.TemplatePath != "templates/cmr/member/default-overview.md" {
		t.Fatalf("member runtime playbook missing template: %+v", runtime.DocsByPath["playbooks/cmr/member/default-overview.md"])
	}
}
