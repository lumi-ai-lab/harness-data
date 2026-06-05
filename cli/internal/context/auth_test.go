package context

import (
	"os"
	"path/filepath"
	"testing"

	"harness-data/cli/internal/harness"
)

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
