package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadConfigNormalizesAuthzMode(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{name: "no authz section", body: "paths:\n  knowledge: wikis\n", want: "off"},
		{name: "missing mode", body: "authz:\n  allow_local_blob: true\n", want: "off"},
		{name: "empty mode", body: "authz:\n  mode:\n", want: "off"},
		{name: "off", body: "authz:\n  mode: off\n", want: "off"},
		{name: "trimmed mixed case off", body: "authz:\n  mode: '  OfF  '\n", want: "off"},
		{name: "on", body: "authz:\n  mode: on\n", want: "on"},
		{name: "trimmed mixed case on", body: "authz:\n  mode: '  ON  '\n", want: "on"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := writeConfig(t, tc.body)
			cfg, err := LoadConfig(root)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Authz.Mode != tc.want {
				t.Fatalf("authz mode = %q, want %q", cfg.Authz.Mode, tc.want)
			}
		})
	}
}

func TestLoadConfigRejectsUnknownAuthzMode(t *testing.T) {
	root := writeConfig(t, "authz:\n  mode: enabled\n")
	_, err := LoadConfig(root)
	if err == nil || !strings.Contains(err.Error(), "authz.mode must be on or off") {
		t.Fatalf("expected unknown authz mode error, got %v", err)
	}
}

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ConfigRel), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

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

func TestLoadConfigReadsMetricCLIPath(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte(`paths:
  knowledge: wikis

cli:
  qdm_metric_cli: /opt/qdm-metric-cli
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
	if cfg.CLI.QDMMetricCLI != "/opt/qdm-metric-cli" {
		t.Fatalf("unexpected metric cli path: %+v", cfg.CLI)
	}
	if cfg.Authz.Mode != "off" || cfg.Authz.DevUserID != "" {
		t.Fatalf("unexpected default authz (mode off, empty dev_user_id): %+v", cfg.Authz)
	}
}

func TestLoadConfigReadsAuthzSection(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte(`paths:
  knowledge: wikis

authz:
  mode: on
  blob_file: config/dev-auth.blob
  dev_user_id: local-test-user
  allow_local_blob: true
`)
	if err := os.WriteFile(filepath.Join(root, ConfigRel), body, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Authz.AuthzEnabled() {
		t.Fatalf("expected authz on: %+v", cfg.Authz)
	}
	if cfg.Authz.BlobFile != "config/dev-auth.blob" {
		t.Fatalf("unexpected blob_file: %+v", cfg.Authz)
	}
	if cfg.Authz.DevUserID != "local-test-user" {
		t.Fatalf("unexpected dev_user_id: %+v", cfg.Authz)
	}
	if !cfg.Authz.LocalBlobAllowed() {
		t.Fatalf("expected local blob allowed: %+v", cfg.Authz)
	}
}
