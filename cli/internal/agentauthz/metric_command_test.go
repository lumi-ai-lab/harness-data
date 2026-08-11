package agentauthz

import (
	"strings"
	"testing"
)

func TestMetricCommandDetectionMatchesExecutableForms(t *testing.T) {
	commands := []string{
		"qdm-metric-cli analysis execute --metric saleAmt",
		"./bin/qdm-metric-cli analysis execute --metric saleAmt",
		"./original/qdm-metric-cli.exe auth describe --resolve-labels=false",
		"../fixtures/qdm-metric-cli analysis execute --metric saleAmt",
		"real/qdm-metric-cli.exe auth describe --resolve-labels=false",
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

func TestRewriteMetricCLIToBrokerReplacesRelativeSubdirectoryExecutableOnly(t *testing.T) {
	got := RewriteMetricCLIToBroker(
		`./real/qdm-metric-cli.exe analysis execute --auth-blob qdm1enc.model --metric saleAmt`,
		`D:\Harness Runtime\bin\data-harness-cli.exe`,
		"workbuddy",
	)
	if !strings.HasPrefix(got, `'D:\Harness Runtime\bin\data-harness-cli.exe' authz-exec --agent 'workbuddy' -- analysis execute`) {
		t.Fatalf("expected relative executable to be replaced by broker: %s", got)
	}
	if strings.Contains(got, "./real/qdm-metric-cli.exe") || strings.Contains(got, "qdm1enc.model") || strings.Contains(got, "--auth-blob") {
		t.Fatalf("rewrite retained original executable or authorization input: %s", got)
	}
}

func TestRelativeSubdirectoryDetectionRequiresExactMetricCLIBaseName(t *testing.T) {
	commands := []string{
		`./original/not-qdm-metric-cli.exe auth describe`,
		`./original/qdm-metric-cli-helper.exe auth describe`,
		`relative/qdm-metric-cli.exe.bak analysis execute --metric saleAmt`,
	}
	for _, command := range commands {
		if IsMetricAuthzGatedCommand(command) {
			t.Fatalf("non-exact executable basename must not be gated: %s", command)
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

func TestPowerShellMetricCommandDetectionMatchesExecutableForms(t *testing.T) {
	commands := []string{
		`qdm-metric-cli.exe analysis execute --metric saleAmt`,
		`.\bin\qdm-metric-cli.exe auth describe`,
		`& '.\bin\qdm-metric-cli.exe' analysis execute --metric saleAmt`,
		`& 'C:\Harness Runtime\bin\qdm-metric-cli.exe' auth describe`,
		`& $env:QDM_METRIC_CLI analysis execute --metric saleAmt`,
	}
	for _, command := range commands {
		if !IsPowerShellMetricAuthzGatedCommand(command) {
			t.Fatalf("expected PowerShell gated command match: %s", command)
		}
		if PowerShellMetricInvocationCount(command) != 1 {
			t.Fatalf("expected one PowerShell invocation: %s", command)
		}
	}
}

func TestPowerShellMetricCommandDetectionIgnoresTextCommentsAndHereStrings(t *testing.T) {
	commands := []string{
		`Write-Output "qdm-metric-cli.exe analysis execute --metric saleAmt"`,
		`# qdm-metric-cli.exe auth describe`,
		"@'\nqdm-metric-cli.exe analysis execute --metric saleAmt\n'@",
		"@\"\nqdm-metric-cli.exe auth describe\n\"@",
	}
	for _, command := range commands {
		if IsPowerShellMetricAuthzGatedCommand(command) {
			t.Fatalf("expected PowerShell text to be ignored: %s", command)
		}
	}
}

func TestInjectPowerShellDataAuthRewritesPathAndPreservesPipeline(t *testing.T) {
	got := InjectPowerShellDataAuth(
		`& '.\bin\qdm-metric-cli.exe' analysis execute --auth-blob 'qdm1enc.model' --metric saleAmt | ConvertTo-Json`,
		"qdm1enc.runtime",
		`C:\Harness Runtime\bin\qdm-metric-cli.exe`,
	)
	if !strings.HasPrefix(got, `& 'C:\Harness Runtime\bin\qdm-metric-cli.exe' analysis execute`) {
		t.Fatalf("expected PowerShell metric path rewrite: %s", got)
	}
	if !strings.Contains(got, `--metric saleAmt --data-auth --auth-blob 'qdm1enc.runtime' | ConvertTo-Json`) {
		t.Fatalf("expected PowerShell auth flags before pipeline: %s", got)
	}
	if strings.Contains(got, "qdm1enc.model") {
		t.Fatalf("expected model blob to be removed: %s", got)
	}
}

func TestPowerShellCaptureAssignmentIsRecognizedAndBrokered(t *testing.T) {
	command := `$out = & '.\original\qdm-metric-cli.exe' auth describe 2>&1; $code = $LASTEXITCODE; $out | Out-String`
	if !IsPowerShellMetricAuthDescribe(command) || PowerShellMetricInvocationCount(command) != 1 {
		t.Fatalf("expected one auth describe invocation in capture assignment: %s", command)
	}
	got := RewritePowerShellMetricCLIToBroker(command, `C:\Harness Runtime\bin\data-harness-cli.exe`, "workbuddy")
	if !strings.Contains(got, `$out = & 'C:\Harness Runtime\bin\data-harness-cli.exe' authz-exec --agent 'workbuddy' -- auth describe 2>&1`) {
		t.Fatalf("expected capture assignment broker rewrite: %s", got)
	}
	if strings.Contains(got, "qdm1enc.") || strings.Contains(got, "--auth-blob") {
		t.Fatalf("broker rewrite must not contain authorization material: %s", got)
	}
}

func TestPowerShellQuoteEscapesSingleQuotes(t *testing.T) {
	if got := PowerShellQuote(`C:\QDM's Runtime\qdm-metric-cli.exe`); got != `'C:\QDM''s Runtime\qdm-metric-cli.exe'` {
		t.Fatalf("unexpected PowerShell quote: %s", got)
	}
}

func TestStripPowerShellAuthFlagsPreservesQuotedPathsAndHereStrings(t *testing.T) {
	command := "& 'C:\\Harness  Runtime\\bin\\qdm-metric-cli.exe' analysis execute --auth-json '{\"fake\":true}' --data-auth --auth-blob 'qdm1enc.model' --metric saleAmt\n@'\n--auth-blob qdm1enc.documentation\n'@"
	got := StripPowerShellAuthFlags(command)
	if !strings.Contains(got, `'C:\Harness  Runtime\bin\qdm-metric-cli.exe'`) {
		t.Fatalf("quoted executable path was changed: %s", got)
	}
	if strings.Contains(got, "qdm1enc.model") || strings.Contains(got, `'{\"fake\":true}'`) {
		t.Fatalf("model authorization flags were not removed: %s", got)
	}
	if !strings.Contains(got, "--auth-blob qdm1enc.documentation") {
		t.Fatalf("PowerShell here-string content was changed: %s", got)
	}
}
