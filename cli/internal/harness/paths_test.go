package harness

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigDefaultsToWikisRoot(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"wikis/spec", "wikis/playbooks", "wikis/templates"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	cfg, err := LoadConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Paths.Spec != "wikis/spec" || cfg.Paths.Playbooks != "wikis/playbooks" || cfg.Paths.Templates != "wikis/templates" {
		t.Fatalf("unexpected default paths: %+v", cfg.Paths)
	}
}

func TestLoadConfigReadsSQLCLIPath(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte(`paths:
  knowledge: wikis

cli:
  qdm_cmr_cli: /opt/qdm-cmr-cli
  qdm_indicators_cli: /opt/qdm-indicators-cli
  qdm_sql_cli: /opt/qdm-sql-cli
  qdm_cas_cli: /opt/cas-cli
`)
	if err := os.WriteFile(filepath.Join(root, ConfigRel), body, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CLI.QDMSQLCLI != "/opt/qdm-sql-cli" {
		t.Fatalf("unexpected sql cli path: %+v", cfg.CLI)
	}
}

func TestFindRootFromFallsBackToExecutableDirectory(t *testing.T) {
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, ConfigRel), []byte("paths:\n  knowledge: wikis\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(workspace, "bin", "data-harness-cli.exe")
	if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
		t.Fatal(err)
	}

	root, err := FindRootFrom(filepath.Join(t.TempDir(), "outside"), filepath.Dir(executable))
	if err != nil {
		t.Fatal(err)
	}
	if root != workspace {
		t.Fatalf("expected %s, got %s", workspace, root)
	}
}

func TestFindRootFromDoesNotSelectUnrelatedHarnessStateDirectory(t *testing.T) {
	unrelated := t.TempDir()
	if err := os.MkdirAll(filepath.Join(unrelated, ".harness"), 0o755); err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Join(workspace, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, ConfigRel), []byte("paths:\n  knowledge: wikis\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	root, err := FindRootFrom(unrelated, filepath.Join(workspace, "bin"))
	if err != nil {
		t.Fatal(err)
	}
	if root != workspace {
		t.Fatalf("expected %s, got %s", workspace, root)
	}
}
