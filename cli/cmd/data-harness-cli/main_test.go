package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindShowDocumentUsesWikisCorpusForStructuredLayout(t *testing.T) {
	root := t.TempDir()
	writeMainTestFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeMainTestFile(t, root, "wikis/metrics/销售额/spec.md", `---
name: sale_amt
label: 销售额
---
# 销售额
`)

	doc, ok, err := findShowDocument(root, "metrics/销售额/spec.md")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected structured metric spec to be found")
	}
	if doc.ID != "metrics/销售额/spec" || doc.Kind != "spec" || doc.Path != "metrics/销售额/spec.md" {
		t.Fatalf("unexpected show doc: %+v", doc)
	}

	doc, ok, err = findShowDocument(root, "wikis/metrics/销售额/spec.md")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || doc.Path != "metrics/销售额/spec.md" {
		t.Fatalf("expected wikis-prefixed path to resolve, got ok=%v doc=%+v", ok, doc)
	}
}

func writeMainTestFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
