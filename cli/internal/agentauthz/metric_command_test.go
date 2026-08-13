package agentauthz

import (
	"runtime"
	"strings"
	"testing"
)

func TestMetricCommandDetectionMatchesExecutableForms(t *testing.T) {
	commands := []string{
		"qdm-metric-cli analysis execute --metric saleAmt",
		"qdm-metric-cli.exe analysis execute --metric saleAmt",
		"./bin/qdm-metric-cli analysis execute --metric saleAmt",
		".\\bin\\qdm-metric-cli.exe analysis execute --metric saleAmt",
		"$QDM_METRIC_CLI analysis execute --metric saleAmt",
		"${QDM_METRIC_CLI} auth describe",
		"FOO=bar /opt/qdm/bin/qdm-metric-cli auth describe",
		`C:\\harness\\bin\\qdm-metric-cli.exe auth describe`,
		"source config/qdm-cli-paths.env && qdm-metric-cli analysis execute --metric saleAmt",
	}
	for _, command := range commands {
		if !IsMetricAuthzGatedCommand(command) {
			t.Fatalf("expected gated command match: %s", command)
		}
	}
}

func TestMetricCommandDetectionMatchesPowerShellQuotedPath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell command syntax")
	}

	commands := []string{
		`& 'E:\Harness Data\bin\qdm-metric-cli.exe' auth describe`,
		`& "E:\Harness Data\bin\qdm-metric-cli.exe" analysis execute --metric saleAmt`,
		`& '.\bin\qdm-metric-cli.exe' auth describe`,
	}
	for _, command := range commands {
		if !IsMetricAuthzGatedCommand(command) {
			t.Fatalf("expected PowerShell command to be gated: %s", command)
		}
	}
}

func TestInjectAuthDescribeSupportsPowerShellQuotedPath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell command syntax")
	}

	got := InjectAuthDescribeBlob(
		`& 'E:\Harness Data\bin\qdm-metric-cli.exe' auth describe`,
		"qdm1enc.runtime",
		`E:\Harness Data\bin\qdm-metric-cli.exe`,
	)
	if !strings.Contains(got, "auth describe --auth-blob 'qdm1enc.runtime'") {
		t.Fatalf("expected auth blob injection: %s", got)
	}
}

func TestMetricCommandDetectionMatchesCMDWrapper(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows CMD command syntax")
	}

	commands := []string{
		`cmd /c "E:\\Harness Data\\bin\\qdm-metric-cli.exe" auth describe`,
		`cmd.exe /C "E:\\Harness Data\\bin\\qdm-metric-cli.exe" analysis execute --metric saleAmt`,
	}
	for _, command := range commands {
		if !IsMetricAuthzGatedCommand(command) {
			t.Fatalf("expected CMD wrapper command to be gated: %s", command)
		}
	}
}

func TestRewriteGatedMetricCommandsPreservesCMDWrapper(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows CMD command syntax")
	}

	got, err := RewriteGatedMetricCommands(
		`cmd /c "E:\\old\\qdm-metric-cli.exe" auth describe`,
		"qdm1enc.runtime",
		`C:\\Harness Data\\bin\\qdm-metric-cli.exe`,
		ShellCMD,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, `cmd /c "C:\\Harness Data\\bin\\qdm-metric-cli.exe" auth describe`) {
		t.Fatalf("expected CMD wrapper and quoting to be preserved: %s", got)
	}
	if !strings.Contains(got, `--auth-blob "qdm1enc.runtime"`) {
		t.Fatalf("expected CMD auth blob injection: %s", got)
	}
}

func TestRewriteGatedMetricCommandsRendersCMDWrapperWithNestedQuotes(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows CMD command syntax")
	}
	got, err := RewriteGatedMetricCommands(
		`cmd /c "qdm-metric-cli auth describe"`,
		"qdm1enc.runtime",
		`C:\\Harness Data\\bin\\qdm-metric-cli.exe`,
		ShellCMD,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, `cmd /c ""C:\\Harness Data\\bin\\qdm-metric-cli.exe" auth describe`) ||
		!strings.HasSuffix(got, `--auth-blob "qdm1enc.runtime""`) {
		t.Fatalf("expected nested CMD wrapper quotes: %s", got)
	}
}

func TestRewriteGatedMetricCommandsRendersPowerShellInvocation(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows shell dialect")
	}
	got, err := RewriteGatedMetricCommands(
		`qdm-metric-cli.exe analysis execute --metric saleAmt`,
		"qdm1enc.runtime",
		`C:\Harness Data\bin\qdm-metric-cli.exe`,
		ShellPowerShell,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, `& 'C:\Harness Data\bin\qdm-metric-cli.exe' analysis execute`) {
		t.Fatalf("expected PowerShell invocation operator and quoting: %s", got)
	}
}

func TestRewriteGatedMetricCommandsRendersCMDInvocation(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows shell dialect")
	}
	got, err := RewriteGatedMetricCommands(
		`qdm-metric-cli.exe auth describe`,
		"qdm1enc.runtime",
		`C:\Harness Data\bin\qdm-metric-cli.exe`,
		ShellCMD,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, `"C:\Harness Data\bin\qdm-metric-cli.exe" auth describe`) {
		t.Fatalf("expected CMD quoting: %s", got)
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

func TestRewriteGatedMetricCommandsRewritesMixedInvocations(t *testing.T) {
	command := `qdm-metric-cli auth describe --data-auth --auth-blob old | jq .; qdm-metric-cli analysis execute --auth-json fake --metric saleAmt > result.json`
	got, err := RewriteGatedMetricCommands(command, "qdm1enc.runtime", "/abs/bin/qdm-metric-cli")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(got, `'/abs/bin/qdm-metric-cli'`) != 2 || strings.Count(got, "--auth-blob 'qdm1enc.runtime'") != 2 {
		t.Fatalf("expected both invocations rewritten: %s", got)
	}
	if strings.Count(got, "--data-auth") != 1 || strings.Contains(got, "--auth-json") || strings.Contains(got, "--auth-blob old") {
		t.Fatalf("unexpected auth flags after rewrite: %s", got)
	}
	if !strings.Contains(got, "--auth-blob 'qdm1enc.runtime' | jq") || !strings.Contains(got, "--auth-blob 'qdm1enc.runtime' > result.json") {
		t.Fatalf("auth flags must precede shell tails: %s", got)
	}
}
