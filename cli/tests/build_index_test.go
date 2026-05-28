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
	root := validBuildIndexRoot(t)
	result, err := wikis.BuildIndex(root, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.DocCount == 0 || result.RecallCount == 0 || result.ChecksSkipped {
		t.Fatalf("unexpected build result: %+v", result)
	}
	index, err := wikis.LoadIndex(root)
	if err != nil {
		t.Fatal(err)
	}
	docs := map[string]wikis.Document{}
	for _, doc := range index.Docs {
		docs[doc.Path] = doc
	}
	if docs["spec/cmr/member/s-member-repurchase-no-difference-rate.md"].ID != "spec/cmr/member/s-member-repurchase-no-difference-rate" {
		t.Fatalf("member repurchase not indexed: %+v", docs["spec/cmr/member/s-member-repurchase-no-difference-rate.md"])
	}
	memberPlaybook := docs["playbooks/cmr/member/default-overview.md"]
	if !memberPlaybook.Playbook.IsCombo || memberPlaybook.Playbook.TemplatePath != "templates/cmr/member/default-overview.md" {
		t.Fatalf("member playbook = %+v", memberPlaybook)
	}
	if index.Meta.Version != 1 || index.Meta.ChecksSkipped {
		t.Fatalf("bad index meta: %+v", index.Meta)
	}
	runtime, err := wikis.LoadRuntimeIndex(root)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.DocsByPath["playbooks/cmr/member/default-overview.md"].Playbook.TemplatePath != "templates/cmr/member/default-overview.md" {
		t.Fatalf("member runtime playbook missing template: %+v", runtime.DocsByPath["playbooks/cmr/member/default-overview.md"])
	}
}

func validBuildIndexRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	testWriteFile(t, root, "config/harness-config.yaml", `paths:
  spec: wikis/spec
  playbooks: wikis/playbooks
  templates: wikis/templates
`)
	testWriteFile(t, root, "wikis/spec/index.md", "# Specs\n")
	testWriteFile(t, root, "wikis/spec/cmr/index.md", "# CMR\n")
	testWriteFile(t, root, "wikis/spec/cmr/member/index.md", "# Member\n")
	testWriteFile(t, root, "wikis/spec/cmr/member/s-member-repurchase-no-difference-rate.md", `---
name: member_repurchase_no_difference_rate
label: 会员复购率
aliases: ["会员复购情况"]
---
# 会员复购率
`)
	testWriteFile(t, root, "wikis/spec/cmr/member/report-contract.md", `---
name: member_report_contract
label: 会员报告契约
---
# 会员报告契约
`)
	testWriteFile(t, root, "wikis/playbooks/index.md", "# Playbooks\n")
	testWriteFile(t, root, "wikis/playbooks/cmr/index.md", "# CMR\n")
	testWriteFile(t, root, "wikis/playbooks/cmr/member/index.md", "# Member\n")
	testWriteFile(t, root, "wikis/playbooks/cmr/member/s-member-repurchase-no-difference-rate.md", "# 会员复购率 Playbook\n")
	testWriteFile(t, root, "wikis/playbooks/cmr/member/report-contract.md", "# 会员报告契约 Playbook\n")
	testWriteFile(t, root, "wikis/playbooks/cmr/member/default-overview.md", `---
aliases: ["会员概览"]
covers:
  - spec/cmr/member/report-contract.md
---
# 会员概览
`)
	testWriteFile(t, root, "wikis/templates/index.md", "# Templates\n")
	testWriteFile(t, root, "wikis/templates/cmr/index.md", "# CMR\n")
	testWriteFile(t, root, "wikis/templates/cmr/member/index.md", "# Member\n")
	testWriteFile(t, root, "wikis/templates/cmr/member/s-member-repurchase-no-difference-rate.md", "# 会员复购率 Template\n")
	testWriteFile(t, root, "wikis/templates/cmr/member/report-contract.md", "# 会员报告契约 Template\n")
	testWriteFile(t, root, "wikis/templates/cmr/member/default-overview.md", "# 会员概览 Template\n")
	return root
}

func testWriteFile(t *testing.T, root, rel, content string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
