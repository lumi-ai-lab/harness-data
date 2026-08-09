package agentauthz

import (
	"strings"
	"testing"
)

func TestMetricCommandDetectionMatchesExecutableForms(t *testing.T) {
	commands := []string{
		"qdm-metric-cli analysis execute --metric saleAmt",
		"./bin/qdm-metric-cli analysis execute --metric saleAmt",
		"$QDM_METRIC_CLI analysis execute --metric saleAmt",
		"${QDM_METRIC_CLI} auth describe",
		"FOO=bar /opt/qdm/bin/qdm-metric-cli auth describe",
		"source config/qdm-cli-paths.env && qdm-metric-cli analysis execute --metric saleAmt",
	}
	for _, command := range commands {
		if !IsMetricAuthzGatedCommand(command) {
			t.Fatalf("expected gated command match: %s", command)
		}
	}
}

func TestMetricCommandDetectionIgnoresQuotedTextAndHeredoc(t *testing.T) {
	commands := []string{
		`git commit -m "qdm-metric-cli analysis execute --metric saleAmt"`,
		`printf '%s\n' 'qdm-metric-cli auth describe'`,
		"cat <<'EOF'\nqdm-metric-cli analysis execute --metric saleAmt\nEOF\n",
	}
	for _, command := range commands {
		if IsMetricAuthzGatedCommand(command) {
			t.Fatalf("expected command to be ignored: %s", command)
		}
	}
}

func TestStripAuthFlagsRemovesModelSuppliedSecretsAndFixtureCats(t *testing.T) {
	command := `qdm-metric-cli analysis execute --auth-json '{"scope":"fake"}' --data-auth --auth-blob "$(cat config/dev-auth.blob)" --metric saleAmt`
	got := StripAuthFlags(command)
	for _, forbidden := range []string{"--auth-json", "--auth-blob", "--data-auth", "config/dev-auth.blob"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("expected %q to be stripped from %q", forbidden, got)
		}
	}
	if !strings.Contains(got, "--metric saleAmt") {
		t.Fatalf("expected non-auth args to remain: %s", got)
	}
}

func TestInjectDataAuthStripsAndReplacesBeforePipe(t *testing.T) {
	got := InjectDataAuth(
		`qdm-metric-cli analysis execute --auth-blob "$(cat config/dev-auth.blob)" --metric saleAmt | jq .`,
		"qdm1enc.runtime",
		"/abs/bin/qdm-metric-cli",
	)
	if !strings.HasPrefix(got, `'/abs/bin/qdm-metric-cli' analysis execute`) {
		t.Fatalf("expected metric cli path rewrite: %s", got)
	}
	if !strings.Contains(got, "--metric saleAmt --data-auth --auth-blob 'qdm1enc.runtime' | jq .") {
		t.Fatalf("expected runtime auth flags before pipe: %s", got)
	}
	if strings.Contains(got, "config/dev-auth.blob") {
		t.Fatalf("expected fixture cat to be stripped: %s", got)
	}
}

func TestInjectAuthDescribeAddsOnlyAuthBlob(t *testing.T) {
	got := InjectAuthDescribeBlob("qdm-metric-cli auth describe --auth-json fake", "qdm1enc.runtime", "")
	if strings.Contains(got, "--data-auth") {
		t.Fatalf("auth describe must not add --data-auth: %s", got)
	}
	if !strings.Contains(got, "auth describe --auth-blob 'qdm1enc.runtime'") {
		t.Fatalf("expected auth blob injection: %s", got)
	}
}

func TestMetricCommandDetectionMatchesDefaultExpansionSyntax(t *testing.T) {
	// ${QDM_METRIC_CLI:-default} Bash parameter expansion with default value.
	executeCases := []string{
		`${QDM_METRIC_CLI:-qdm-metric-cli} analysis execute --metric saleAmt`,
		`"${QDM_METRIC_CLI:-qdm-metric-cli}" analysis execute --metric saleAmt`,
	}
	for _, command := range executeCases {
		if !IsMetricAnalysisExecute(command) {
			t.Fatalf("expected analysis execute match for default-expansion: %s", command)
		}
		if !IsMetricAuthzGatedCommand(command) {
			t.Fatalf("expected gated match for default-expansion: %s", command)
		}
	}

	describeCases := []string{
		`${QDM_METRIC_CLI:-qdm-metric-cli} auth describe`,
		`"${QDM_METRIC_CLI:-qdm-metric-cli}" auth describe`,
		`"${QDM_METRIC_CLI:-/workspace/bin/qdm-metric-cli}" auth describe`,
	}
	for _, command := range describeCases {
		if !IsMetricAuthDescribe(command) {
			t.Fatalf("expected auth describe match for default-expansion: %s", command)
		}
		if !IsMetricAuthzGatedCommand(command) {
			t.Fatalf("expected gated match for default-expansion: %s", command)
		}
	}

	// Two-line assignment + variable reference (ensure no regression).
	multiLine := `QDM_METRIC_CLI="${QDM_METRIC_CLI:-qdm-metric-cli}"
"$QDM_METRIC_CLI" auth describe`
	if !IsMetricAuthDescribe(multiLine) {
		t.Fatalf("expected auth describe match for multi-line assignment: %q", multiLine)
	}
}
