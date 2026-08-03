package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"harness-data/cli/internal/authz"
)

func TestUsageListsAuthorizationCommands(t *testing.T) {
	usage := usageText()
	for _, command := range []string{"authz-bind", "authz-readiness", "authz-validate-catalog"} {
		if !strings.Contains(usage, command) {
			t.Fatalf("usage missing %s: %s", command, usage)
		}
	}
}

func TestRootIndependentAuthorizationCommandDispatch(t *testing.T) {
	var output bytes.Buffer
	handled, err := runRootIndependentAuthzCommand("authz-bind", nil, &output)
	if !handled {
		t.Fatal("authz-bind was not handled")
	}
	var exitErr exitCodeError
	if !asExitCodeError(err, &exitErr) || exitErr.Code != 1 || !exitErr.Silent {
		t.Fatalf("unexpected authz-bind error: %#v", err)
	}
	var failure authzCommandFailure
	if err := json.Unmarshal(output.Bytes(), &failure); err != nil {
		t.Fatalf("invalid authz-bind failure JSON %q: %v", output.String(), err)
	}
	if failure.Error.Code != authz.CodeBindingInvalid {
		t.Fatalf("authz-bind code = %q", failure.Error.Code)
	}

	handled, err = runRootIndependentAuthzCommand("wikis", nil, &output)
	if handled || err != nil {
		t.Fatalf("non-authz command handled=%v err=%v", handled, err)
	}
}

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
