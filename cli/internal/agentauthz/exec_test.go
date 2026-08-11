package agentauthz

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSanitizeExecArgsRemovesModelAuthorization(t *testing.T) {
	args, kind, err := sanitizeExecArgs([]string{
		"analysis", "execute", "--metric", "saleAmt", "--data-auth",
		"--auth-blob", "qdm1enc.model", "--auth-json={\"fake\":true}",
	})
	if err != nil {
		t.Fatal(err)
	}
	if kind != "analysis-execute" || strings.Join(args, " ") != "analysis execute --metric saleAmt" {
		t.Fatalf("unexpected sanitized args: kind=%s args=%q", kind, args)
	}
}

func TestBuildExecInvocationInjectsConfiguredAuthorizationInsideBroker(t *testing.T) {
	root := t.TempDir()
	metricCLI := filepath.Join(root, "real", "qdm-metric-cli-test")
	if err := os.MkdirAll(filepath.Dir(metricCLI), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metricCLI, []byte("test metric cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	config := "paths:\n  knowledge: wikis\n\ncli:\n  qdm_metric_cli: " + filepath.ToSlash(metricCLI) + "\n\nauthz:\n  mode: on\n  allow_local_blob: true\n"
	if err := os.WriteFile(filepath.Join(root, "config", "harness-config.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("QDM_METRIC_CLI", "")
	invocation, err := BuildExecInvocation(root, "workbuddy", []string{
		"analysis", "execute", "--metric", "saleAmt", "--auth-blob", "qdm1enc.model",
	}, map[string]string{
		EnvAuthBlob:   "qdm1enc.runtime",
		EnvAuthUserID: "configured-user",
	})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(filepath.FromSlash(invocation.Path)) != filepath.Clean(metricCLI) {
		t.Fatalf("unexpected metric cli path: %s", invocation.Path)
	}
	joined := strings.Join(invocation.Args, " ")
	if strings.Contains(joined, "qdm1enc.model") || !strings.Contains(joined, "--data-auth --auth-blob qdm1enc.runtime") {
		t.Fatalf("broker did not replace model authorization: %s", joined)
	}
}

func TestScrubAuthEnvironmentRemovesAuthorizationSources(t *testing.T) {
	got := scrubAuthEnvironment([]string{
		"PATH=/bin",
		"HARNESS_AUTH_BLOB=qdm1enc.secret",
		"HARNESS_AUTH_BLOB_FILE=/private/auth.blob",
		"HARNESS_AUTH_USER_ID=user",
		"LUMI_REQUESTER_CONTEXT_DIR=/private/context",
		"OTHER=value",
	})
	joined := strings.Join(got, "\n")
	for _, key := range AuthSourceEnvKeys {
		if strings.Contains(joined, key+"=") {
			t.Fatalf("authorization source %s leaked to qdm child: %s", key, joined)
		}
	}
	if !strings.Contains(joined, "PATH=/bin") || !strings.Contains(joined, "OTHER=value") {
		t.Fatalf("ordinary environment was not preserved: %s", joined)
	}
}
