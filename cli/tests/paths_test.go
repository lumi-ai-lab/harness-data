package tests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	dhcontext "harness-data/cli/internal/context"
	"harness-data/cli/internal/harness"
	"harness-data/cli/internal/wikis"
)

func TestFindRootUsesHarnessConfigWithoutLegacyKnowledgeDirs(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "harness-config.yaml"), []byte("paths:\n  spec: wikis/spec\n  routing: wikis/routing\n  playbooks: wikis/playbooks\n  templates: wikis/templates\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(root, "nested", "child")
	if err := os.MkdirAll(child, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := harness.FindRoot(child)
	if err != nil {
		t.Fatal(err)
	}
	if got != root {
		t.Fatalf("root = %s, want %s", got, root)
	}
}

func TestPathResolverMapsLogicalKnowledgePaths(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "harness-config.yaml"), []byte("paths:\n  spec: wikis/spec\n  routing: wikis/routing\n  playbooks: wikis/playbooks\n  templates: wikis/templates\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := resolver.ResolveRel("spec/common/index.md"); got != "wikis/spec/common/index.md" {
		t.Fatalf("ResolveRel = %s", got)
	}
	if got := resolver.ResolveRel(".harness/index/spec-index.json"); got != ".harness/index/spec-index.json" {
		t.Fatalf("ResolveRel harness path = %s", got)
	}
}

func TestContextUsesConfiguredKnowledgeDirectoryName(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  spec: knowledge/spec\n  routing: knowledge/routing\n  playbooks: knowledge/playbooks\n  templates: knowledge/templates\n")
	writeFile(t, root, "knowledge/spec/index.md", "# Specs\n")
	writeFile(t, root, "knowledge/spec/common/index.md", "# Common\n")
	writeFile(t, root, "knowledge/spec/common/time-policy.md", `---
name: "member_metric"
label: "会员"
---
# Time
`)
	writeFile(t, root, "knowledge/playbooks/index.md", "# Playbooks\n")
	writeFile(t, root, "knowledge/playbooks/common/index.md", "# Common Playbooks\n")
	writeFile(t, root, "knowledge/playbooks/common/time-policy.md", "# Member Playbook\n")
	writeFile(t, root, "knowledge/templates/index.md", "# Templates\n")
	writeFile(t, root, "knowledge/templates/common/index.md", "# Common Templates\n")
	writeFile(t, root, "knowledge/templates/common/time-policy.md", "# Template\n")
	if _, err := wikis.BuildIndex(root, false); err != nil {
		t.Fatal(err)
	}

	response, err := dhcontext.Build(root, "最近会员表现")
	if err != nil {
		t.Fatal(err)
	}
	joined := contextPathList(response.ContextFiles)
	for _, want := range []string{
		"knowledge/spec/common/index.md",
		"knowledge/spec/common/time-policy.md",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s in %s", want, joined)
		}
	}
	if strings.Contains(joined, "knowledge/playbooks/common/time-policy.md") {
		t.Fatalf("reference spec should not select playbook in %s", joined)
	}
	if strings.Contains(joined, "wikis/") {
		t.Fatalf("unexpected wikis path in %s", joined)
	}
}

func writeFile(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func contextPathList(refs []harness.FileRef) string {
	var paths []string
	for _, ref := range refs {
		paths = append(paths, ref.Path)
	}
	return strings.Join(paths, "\n")
}
