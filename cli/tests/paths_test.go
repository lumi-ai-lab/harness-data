package tests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	dhcontext "harness-data/cli/internal/context"
	"harness-data/cli/internal/harness"
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
	writeFile(t, root, "knowledge/spec/common/index.md", `---
id: common-index
kind: spec_index
domain: common
title: Common
match:
  - 通用
context:
  - spec/common/time-policy.md
---
`)
	writeFile(t, root, "knowledge/spec/common/time-policy.md", `---
id: time-policy
kind: spec
domain: common
title: Time
match:
  - 最近
---
`)
	writeFile(t, root, "knowledge/routing/member-overview.md", `---
id: routing-member-overview
kind: routing
domain: member
title: Member Routing
match:
  - 会员
---
`)
	writeFile(t, root, "knowledge/playbooks/cmr/member/index.md", `---
id: playbook-member-index
kind: playbook_index
domain: member
title: Member Playbooks
match:
  - 会员
children:
  - path: playbooks/cmr/member/default-overview.md
    keywords:
      - 会员
---
`)
	writeFile(t, root, "knowledge/playbooks/cmr/member/default-overview.md", `---
id: playbook-member-default-overview
kind: playbook
domain: member
title: Member Overview
tags:
  - template-report
match:
  - 会员
template: templates/cmr/member/member-overview-report.md
---
`)
	writeFile(t, root, "knowledge/templates/cmr/member/member-overview-report.md", "template\n")

	response, err := dhcontext.Build(root, "最近会员表现")
	if err != nil {
		t.Fatal(err)
	}
	joined := contextPathList(response.ContextFiles)
	for _, want := range []string{
		"knowledge/spec/common/index.md",
		"knowledge/spec/common/time-policy.md",
		"knowledge/routing/member-overview.md",
		"knowledge/playbooks/cmr/member/index.md",
		"knowledge/playbooks/cmr/member/default-overview.md",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %s in %s", want, joined)
		}
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
