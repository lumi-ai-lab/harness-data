package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAuthzHookAdapterEnvelopeFormatValidation(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "requires workbuddy", args: []string{"--agent", "codex", "--format", "adapter-envelope"}},
		{name: "rejects unknown format", args: []string{"--agent", "workbuddy", "--format", "unknown"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := runAuthzHook(t.TempDir(), tc.args)
			var exitErr exitCodeError
			if !errors.As(err, &exitErr) || exitErr.Code != 2 {
				t.Fatalf("expected exit code 2, got %v", err)
			}
		})
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

func TestAgentHookFormatsIncludeWorkBuddy(t *testing.T) {
	for _, format := range []string{"claude-hook", "codex-hook", "agent-hook", "workbuddy-hook"} {
		if !isAgentHookFormat(format) {
			t.Fatalf("expected supported format %q", format)
		}
	}
	if isAgentHookFormat("unknown-hook") {
		t.Fatal("unexpected support for unknown hook format")
	}
}

func TestRootStartPrefersCodeBuddyProjectDir(t *testing.T) {
	t.Setenv("CODEBUDDY_PROJECT_DIR", "/workbuddy/project")
	t.Setenv("CLAUDE_PROJECT_DIR", "/claude/project")
	if got := rootStart(); got != "/workbuddy/project" {
		t.Fatalf("rootStart = %q", got)
	}

	t.Setenv("CODEBUDDY_PROJECT_DIR", "")
	if got := rootStart(); got != "/claude/project" {
		t.Fatalf("Claude fallback rootStart = %q", got)
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
