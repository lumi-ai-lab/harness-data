package wikis

import (
	"strings"
	"testing"
)

func TestValidateTemplateSelectionPolicyMatchesPosttoolTemplatePaths(t *testing.T) {
	root := t.TempDir()
	writeFile(t, root, "config/harness-config.yaml", "paths:\n  knowledge: wikis\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/spec.md", "# 经营综合分析报告\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/playbook.md", "# 经营综合分析报告取数\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/template.md", "# 经营综合分析报告模板\n")
	writeFile(t, root, "wikis/reports/经营综合分析报告/alt.md", "# 不可注入模板\n")

	valid := TemplateSelectionPolicy{Version: 1, Templates: []TemplateSelectionRule{{
		ID:       "business_report",
		Playbook: "reports/经营综合分析报告/playbook.md",
		Template: "reports/经营综合分析报告/template.md",
		Type:     "report",
		Covers:   []string{"reports/经营综合分析报告/spec.md"},
	}}}
	if errs := ValidateTemplateSelectionPolicy(root, valid); len(errs) != 0 {
		t.Fatalf("expected valid report template path, got %+v", errs)
	}

	invalid := valid
	invalid.Templates[0].Template = "reports/经营综合分析报告/alt.md"
	errs := ValidateTemplateSelectionPolicy(root, invalid)
	if len(errs) == 0 {
		t.Fatal("expected alt.md template path to be rejected")
	}
	if !strings.Contains(strings.Join(errs, "\n"), "templates/... or reports/.../template.md") {
		t.Fatalf("expected posttool-compatible path error, got %+v", errs)
	}
}
