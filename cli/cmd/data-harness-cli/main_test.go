package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"harness-data/cli/internal/authz"
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

func TestAuthzValidateCatalogUsesRuntimeCatalogContract(t *testing.T) {
	raw := []byte(`{"version":1,"generatedFrom":"qdm-indicators-cli-v0.0.4-contract","indicators":{"saleAmt":{"supportedDimensions":["manageAreaId","categoryLevel1Id"],"dictionaryRefs":[]}}}`)
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "catalog.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	var output bytes.Buffer
	if err := runAuthzValidateCatalog([]string{"--path", path, "--sha256", hex.EncodeToString(digest[:])}, &output); err != nil {
		t.Fatal(err)
	}
	var result authzCatalogValidation
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Valid {
		t.Fatalf("unexpected validation result: %s", output.String())
	}
}

func TestAuthzValidateCatalogRejectsMalformedCatalogAndArguments(t *testing.T) {
	raw := []byte(`{"version":1,"version":1,"generatedFrom":"qdm-indicators-cli-v0.0.4-contract","indicators":{}}`)
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "catalog.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)

	for _, args := range [][]string{
		{"--path", path, "--sha256", hex.EncodeToString(digest[:])},
		{"--path", path},
	} {
		var output bytes.Buffer
		err := runAuthzValidateCatalog(args, &output)
		if err == nil {
			t.Fatalf("expected validation failure for %v", args)
		}
		var failure authzCommandFailure
		if decodeErr := json.Unmarshal(output.Bytes(), &failure); decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if failure.Error.Code != authz.CodeArtifactIntegrityFailed {
			t.Fatalf("unexpected error response: %s", output.String())
		}
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
