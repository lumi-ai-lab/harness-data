package context

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"harness-data/cli/internal/harness"
	"harness-data/cli/internal/sessionstate"
)

func TestPreflightAuthAlwaysChecksCMRAndIndicators(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmrCLI := filepath.Join(binDir, "qdm-cmr-cli")
	indicatorsCLI := filepath.Join(binDir, "qdm-indicators-cli")
	writeValidTokenCLI(t, cmrCLI)
	writeValidTokenCLI(t, indicatorsCLI)
	writePreflightConfig(t, root, cmrCLI, indicatorsCLI, "")

	notes := preflightAuth(root, WikiPlan{
		SelectedPlaybook: "playbooks/unrelated/something.md",
		Candidates: []sessionstate.PlaybookCandidate{
			{Path: "playbooks/indicators/s-sale-amt.md"},
		},
	})

	want := []string{"cmr token valid", "indicators token valid"}
	if !reflect.DeepEqual(notes, want) {
		t.Fatalf("preflightAuth notes = %#v, want %#v", notes, want)
	}
}

func TestPreflightAuthChecksBothAppsInFreeMode(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmrCLI := filepath.Join(binDir, "qdm-cmr-cli")
	indicatorsCLI := filepath.Join(binDir, "qdm-indicators-cli")
	writeValidTokenCLI(t, cmrCLI)
	writeValidTokenCLI(t, indicatorsCLI)
	writePreflightConfig(t, root, cmrCLI, indicatorsCLI, "")

	notes := preflightAuth(root, WikiPlan{Mode: sessionstate.ModeFree})

	want := []string{"cmr token valid", "indicators token valid"}
	if !reflect.DeepEqual(notes, want) {
		t.Fatalf("preflightAuth notes = %#v, want %#v", notes, want)
	}
}

func TestPreflightAuthMissingCLIConfigDoesNotBlockOtherApp(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmrCLI := filepath.Join(binDir, "qdm-cmr-cli")
	writeValidTokenCLI(t, cmrCLI)
	writePreflightConfig(t, root, cmrCLI, "", "")

	notes := preflightAuth(root, WikiPlan{})

	want := []string{
		"cmr token valid",
		"indicators token preflight skipped: target CLI path is not configured",
	}
	if !reflect.DeepEqual(notes, want) {
		t.Fatalf("preflightAuth notes = %#v, want %#v", notes, want)
	}
}

func TestPreflightAuthRefreshesOnlyInvalidApp(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	casDir := filepath.Join(root, ".qdm-auth", "cas")
	writeCasTestConfig(t, casDir)
	cmrCLI := filepath.Join(binDir, "qdm-cmr-cli")
	indicatorsCLI := filepath.Join(binDir, "qdm-indicators-cli")
	casCLI := filepath.Join(binDir, "cas-cli")
	indicatorTokenFile := filepath.Join(root, "indicator-token")
	casLog := filepath.Join(root, "cas.log")
	writeValidTokenCLI(t, cmrCLI)
	writeRefreshableTokenCLI(t, indicatorsCLI, indicatorTokenFile)
	writeExecutable(t, casCLI, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '"+casLog+"'\necho 'Bearer Token:'\necho 'indicators-token'\n")
	writePreflightConfig(t, root, cmrCLI, indicatorsCLI, casCLI)
	t.Setenv("QDM_CAS_CONFIG_DIR", "")
	t.Setenv("LUMI_WORKSPACE_PATH", "")

	notes := preflightAuth(root, WikiPlan{SelectedPlaybook: "playbooks/cmr/business/s-sale-amt.md"})

	want := []string{
		"cmr token valid",
		"indicators token refreshed through CAS credentials",
	}
	if !reflect.DeepEqual(notes, want) {
		t.Fatalf("preflightAuth notes = %#v, want %#v", notes, want)
	}
	gotCASLog, err := os.ReadFile(casLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotCASLog) != "token --timeout 40s --app indicators\n" {
		t.Fatalf("cas calls = %q", string(gotCASLog))
	}
	gotToken, err := os.ReadFile(indicatorTokenFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotToken) != "indicators-token\n" {
		t.Fatalf("indicator token = %q", string(gotToken))
	}
}

func TestCasConfigPathResolution(t *testing.T) {
	t.Run("env wins", func(t *testing.T) {
		root := t.TempDir()
		envDir := filepath.Join(t.TempDir(), "env-cas")
		rootDir := filepath.Join(root, ".qdm-auth", "cas")
		writeCasTestConfig(t, rootDir)
		t.Setenv("QDM_CAS_CONFIG_DIR", envDir)
		t.Setenv("LUMI_WORKSPACE_PATH", filepath.Join(t.TempDir(), "workspace"))

		got, err := casConfigPath(root)
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(envDir, "config.json")
		if got != want {
			t.Fatalf("casConfigPath = %s, want %s", got, want)
		}
	})

	t.Run("root used before home when file exists", func(t *testing.T) {
		root := t.TempDir()
		home := t.TempDir()
		rootDir := filepath.Join(root, ".qdm-auth", "cas")
		writeCasTestConfig(t, rootDir)
		writeCasTestConfig(t, filepath.Join(home, ".cas-cli"))
		t.Setenv("QDM_CAS_CONFIG_DIR", "")
		t.Setenv("LUMI_WORKSPACE_PATH", "")
		t.Setenv("HOME", home)

		got, err := casConfigPath(root)
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(rootDir, "config.json")
		if got != want {
			t.Fatalf("casConfigPath = %s, want %s", got, want)
		}
	})

	t.Run("home fallback", func(t *testing.T) {
		root := t.TempDir()
		home := t.TempDir()
		t.Setenv("QDM_CAS_CONFIG_DIR", "")
		t.Setenv("LUMI_WORKSPACE_PATH", "")
		t.Setenv("HOME", home)

		got, err := casConfigPath(root)
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(home, ".cas-cli", "config.json")
		if got != want {
			t.Fatalf("casConfigPath = %s, want %s", got, want)
		}
	})
}

func TestPreflightAppAuthRefreshPassesCASConfigDir(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	casDir := filepath.Join(root, ".qdm-auth", "cas")
	writeCasTestConfig(t, casDir)
	envLog := filepath.Join(root, "cas-env.log")
	tokenFile := filepath.Join(root, "target-token")
	casCLI := filepath.Join(binDir, "cas-cli")
	targetCLI := filepath.Join(binDir, "qdm-cmr-cli")
	writeExecutable(t, casCLI, "#!/bin/sh\nprintf '%s\\n' \"$QDM_CAS_CONFIG_DIR\" > '"+envLog+"'\necho 'Bearer Token:'\necho 'refreshed-token'\n")
	writeExecutable(t, targetCLI, "#!/bin/sh\nif [ \"$1\" = \"config\" ] && [ \"$2\" = \"check-token\" ]; then\n  [ -f '"+tokenFile+"' ] && echo true || echo false\n  exit 0\nfi\nif [ \"$1\" = \"config\" ] && [ \"$2\" = \"set-token\" ]; then\n  printf '%s\\n' \"$3\" > '"+tokenFile+"'\n  exit 0\nfi\nexit 2\n")
	t.Setenv("QDM_CAS_CONFIG_DIR", "")
	t.Setenv("LUMI_WORKSPACE_PATH", "")

	note := preflightAppAuth(root, harness.CLIConfig{QDMCmrCLI: targetCLI, QDMCasCLI: casCLI}, "cmr")

	if note != "cmr token refreshed through CAS credentials" {
		t.Fatalf("preflightAppAuth note = %q", note)
	}
	gotEnv, err := os.ReadFile(envLog)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotEnv) != casDir+"\n" {
		t.Fatalf("QDM_CAS_CONFIG_DIR = %q, want %q", string(gotEnv), casDir+"\n")
	}
	gotToken, err := os.ReadFile(tokenFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotToken) != "refreshed-token\n" {
		t.Fatalf("set token = %q", string(gotToken))
	}
}

func writeCasTestConfig(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"cas":{"username":"u","password":"p"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeExecutable(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

func writePreflightConfig(t *testing.T, root, cmrCLI, indicatorsCLI, casCLI string) {
	t.Helper()
	content := "paths:\n" +
		"  spec: wikis/spec\n" +
		"  routing: wikis/routing\n" +
		"  playbooks: wikis/playbooks\n" +
		"  templates: wikis/templates\n" +
		"cli:\n"
	if cmrCLI != "" {
		content += "  qdm_cmr_cli: " + cmrCLI + "\n"
	}
	if indicatorsCLI != "" {
		content += "  qdm_indicators_cli: " + indicatorsCLI + "\n"
	}
	if casCLI != "" {
		content += "  qdm_cas_cli: " + casCLI + "\n"
	}
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "harness-config.yaml"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeValidTokenCLI(t *testing.T, path string) {
	t.Helper()
	writeExecutable(t, path, "#!/bin/sh\nif [ \"$1\" = \"config\" ] && [ \"$2\" = \"check-token\" ]; then\n  echo true\n  exit 0\nfi\nexit 2\n")
}

func writeRefreshableTokenCLI(t *testing.T, path, tokenFile string) {
	t.Helper()
	writeExecutable(t, path, "#!/bin/sh\nif [ \"$1\" = \"config\" ] && [ \"$2\" = \"check-token\" ]; then\n  [ -f '"+tokenFile+"' ] && echo true || echo false\n  exit 0\nfi\nif [ \"$1\" = \"config\" ] && [ \"$2\" = \"set-token\" ]; then\n  printf '%s\\n' \"$3\" > '"+tokenFile+"'\n  exit 0\nfi\nexit 2\n")
}
