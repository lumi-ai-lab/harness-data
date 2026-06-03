package tests

import (
	"testing"

	"harness-data/cli/internal/frontmatter"
	"harness-data/cli/internal/harness"
	"harness-data/cli/internal/wikis"
)

func TestValidateCurrentDocumentsReportsMissingPlaybooks(t *testing.T) {
	results, err := wikis.RunAllChecks(root(t), wikis.CheckOptions{MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, result := range results {
		if result.Check != wikis.CheckLinks {
			continue
		}
		for _, err := range result.Errors {
			if err.Code == "missing_playbook" {
				found = true
				break
			}
		}
	}
	if !found {
		t.Fatalf("expected current wikis to report missing playbooks, got %+v", results)
	}
}

func TestValidateFindsMissingDuplicateInvalidAndBadPath(t *testing.T) {
	docs := []harness.Document{
		{ID: "dup", Kind: "spec", Domain: "member", Path: "a.md"},
		{ID: "dup", Kind: "bogus", Domain: "bad", Path: "b.md", Context: harness.ContextInfo{DefaultFiles: []string{"missing.md"}}},
		{Kind: "spec_index", Domain: "member", Path: "c.md", Children: []harness.Child{{Path: "also-missing.md"}}},
		{ID: "playbook-no-template", Kind: "playbook", Domain: "member", Path: "playbooks/cmr/member/no-template.md"},
		{ID: "playbook-bad-template", Kind: "playbook", Domain: "member", Path: "playbooks/cmr/member/bad-template.md", Template: "member-overview-report.md"},
		{ID: "playbook-index-template", Kind: "playbook_index", Domain: "member", Path: "playbooks/cmr/member/index-template.md", Template: "templates/member-overview-report.md"},
	}
	errs := frontmatter.ValidateDocuments(root(t), docs)
	if len(errs) < 8 {
		t.Fatalf("expected multiple validation errors, got %v", errs)
	}
}
