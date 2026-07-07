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
