package tests

import (
	"testing"

	"harness-data/cli/internal/frontmatter"
	"harness-data/cli/internal/harness"
	idx "harness-data/cli/internal/index"
)

func TestValidateCurrentDocuments(t *testing.T) {
	docs, err := idx.AllDocuments(root(t))
	if err != nil {
		t.Fatal(err)
	}
	if errs := frontmatter.ValidateDocuments(root(t), docs); len(errs) != 0 {
		t.Fatalf("expected valid documents, got %v", errs)
	}
}

func TestValidateFindsMissingDuplicateInvalidAndBadPath(t *testing.T) {
	docs := []harness.Document{
		{ID: "dup", Kind: "spec", Domain: "member", Path: "a.md"},
		{ID: "dup", Kind: "bogus", Domain: "bad", Path: "b.md", Context: harness.ContextInfo{DefaultFiles: []string{"missing.md"}}},
		{Kind: "spec_index", Domain: "member", Path: "c.md", Children: []harness.Child{{Path: "also-missing.md"}}},
	}
	errs := frontmatter.ValidateDocuments(root(t), docs)
	if len(errs) < 5 {
		t.Fatalf("expected multiple validation errors, got %v", errs)
	}
}
