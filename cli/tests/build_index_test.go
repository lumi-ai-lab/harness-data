package tests

import (
	"os"
	"path/filepath"
	"testing"

	idx "harness-data/cli/internal/index"
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
	result, err := idx.Build(root(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Spec.Files) == 0 || len(result.Routing.Files) == 0 || len(result.Playbook.Files) == 0 {
		t.Fatalf("expected spec/routing/playbook files, got spec=%d routing=%d playbook=%d", len(result.Spec.Files), len(result.Routing.Files), len(result.Playbook.Files))
	}
	if result.Spec.ByID["member-repurchase"] != "wikis/spec/cmr/member/repurchase.md" {
		t.Fatalf("member-repurchase not indexed: %#v", result.Spec.ByID["member-repurchase"])
	}
	if result.Routing.ByID["routing-member-overview"] != "wikis/routing/member-overview.md" {
		t.Fatalf("member routing not indexed")
	}
	if result.Playbook.ByID["playbook-member-default-overview"] != "wikis/playbooks/cmr/member/default-overview.md" {
		t.Fatalf("member playbook not indexed")
	}
	var memberTemplate string
	for _, doc := range result.Playbook.Files {
		if doc.ID == "playbook-member-default-overview" {
			memberTemplate = doc.Template
		}
	}
	if memberTemplate != "templates/cmr/member/member-overview-report.md" {
		t.Fatalf("member playbook template = %#v", memberTemplate)
	}
}
