package context

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"harness-data/cli/internal/harness"
)

func TestLumiMVPProfileDisablesPromptTimeCredentialRefresh(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".harness"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".harness", "installer-state.json"), []byte(`{
  "schemaVersion": 3,
  "profile": "lumi-mvp-required",
  "agent": "pi"
}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !isLumiMVPRequiredRuntime(root) {
		t.Fatal("Lumi profile not detected from installer-state")
	}
	response := harness.ContextResponse{
		Instruction: "Before. If CMR, Indicators, or SQL token is expired, use Auth preflight first; refresh through config/qdm-cli-paths.env and $QDM_CAS_CLI only when CAS credentials are configured, using app rtp for SQL; do not start QR login. After.",
		Constraints: []string{"values_must_come_from_cli", constraints[len(constraints)-1]},
	}
	adapted := applyLumiMVPConstraints(response)
	if strings.Contains(adapted.Instruction, "QDM_CAS_CLI") || strings.Contains(strings.Join(adapted.Constraints, "\n"), "QDM_CAS_CLI") {
		t.Fatalf("authorized context retained CAS refresh guidance: %#v", adapted)
	}
	for _, required := range []string{"use only qdm-indicators-cli", "report CLI paths", "Never refresh"} {
		if !strings.Contains(adapted.Instruction, required) {
			t.Fatalf("authorized instruction missing %q: %s", required, adapted.Instruction)
		}
	}
	if notes := preflightAuth(root, WikiPlan{}); len(notes) != 0 {
		t.Fatalf("authorization profile ran token preflight: %v", notes)
	}
}
