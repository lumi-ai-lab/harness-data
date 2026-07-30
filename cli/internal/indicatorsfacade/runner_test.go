package indicatorsfacade

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "fake-real-cli" {
		runFakeRealCLI()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func runFakeRealCLI() {
	configDir := os.Getenv("QDM_INDICATORS_CONFIG_DIR")
	if os.Getenv("FAKE_REAL_CLI_DESCENDANT") == "1" {
		time.Sleep(750 * time.Millisecond)
		_ = os.WriteFile(filepath.Join(configDir, "fake-descendant-survived"), []byte("1"), 0o600)
		time.Sleep(3 * time.Second)
		return
	}
	if _, err := os.Stat(filepath.Join(configDir, "fake-descendant")); err == nil {
		child := exec.Command(os.Args[0])
		child.Env = append(os.Environ(), "FAKE_REAL_CLI_DESCENDANT=1")
		if child.Start() == nil {
			_ = os.WriteFile(filepath.Join(configDir, "fake-descendant-started"), []byte("1"), 0o600)
		}
		time.Sleep(3 * time.Second)
		return
	}
	if _, err := os.Stat(filepath.Join(configDir, "fake-sleep")); err == nil {
		time.Sleep(3 * time.Second)
	}
	if _, err := os.Stat(filepath.Join(configDir, "fake-overflow")); err == nil {
		_, _ = os.Stdout.Write(bytesOf('x', 1<<20))
		return
	}
	if _, err := os.Stat(filepath.Join(configDir, "fake-fail")); err == nil {
		_, _ = os.Stdout.WriteString("sensitive partial output")
		os.Exit(7)
	}
	if output, err := os.ReadFile(filepath.Join(configDir, "fake-output")); err == nil {
		_, _ = os.Stdout.Write(output)
		return
	}
	cwd, _ := os.Getwd()
	buffer := make([]byte, 1)
	_, stdinErr := os.Stdin.Read(buffer)
	payload := map[string]any{
		"argv": os.Args[1:], "env": os.Environ(), "cwd": cwd,
		"stdinEOF": errors.Is(stdinErr, io.EOF),
	}
	_ = json.NewEncoder(os.Stdout).Encode(payload)
}

func bytesOf(value byte, count int) []byte {
	result := make([]byte, count)
	for index := range result {
		result[index] = value
	}
	return result
}

type staticGuard struct {
	mu          sync.Mutex
	auth        AuthorizationContext
	initialErr  error
	revalidates int
	failAt      int
	failErr     error
}

type markerGuard struct {
	auth   AuthorizationContext
	marker string
	err    error
}

type failingAuditWriter struct{}

func (failingAuditWriter) Write([]byte) (int, error) { return 0, errors.New("audit unavailable") }

func (g *markerGuard) Initial(context.Context) (AuthorizationContext, error) { return g.auth, nil }

func (g *markerGuard) Revalidate(context.Context) error {
	if _, err := os.Stat(g.marker); err == nil {
		return g.err
	}
	return nil
}

func (g *staticGuard) Initial(context.Context) (AuthorizationContext, error) {
	return g.auth, g.initialErr
}

func (g *staticGuard) Revalidate(context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.revalidates++
	if g.failAt > 0 && g.revalidates >= g.failAt {
		return g.failErr
	}
	return nil
}

func (g *staticGuard) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.revalidates
}

type runnerFixture struct {
	config RunnerConfig
	deps   Dependencies
	guard  *staticGuard
}

func newRunnerFixture(t *testing.T) runnerFixture {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake executable copy test uses Unix executable semantics")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	configDir := filepath.Join(root, "credentials")
	workDir := filepath.Join(root, "private")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		t.Fatal(err)
	}
	fakePath := filepath.Join(workDir, "fake-real-cli")
	copyExecutable(t, os.Args[0], fakePath)
	fakeRaw, err := os.ReadFile(fakePath)
	if err != nil {
		t.Fatal(err)
	}
	fakeDigest := sha256.Sum256(fakeRaw)

	catalogRaw := []byte(`{"version":1,"generatedFrom":"qdm-indicators-cli-v0.0.4-contract","indicators":{"saleAmt":{"supportedDimensions":["manageAreaId","categoryLevel1Id","incDate"],"dictionaryRefs":[{"queryType":2,"id":"dict-sale","internalCode":"internal-sale","names":["销售额"]}]}}}`)
	catalogPath := filepath.Join(root, "catalog.json")
	if err := os.WriteFile(catalogPath, catalogRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	catalogDigest := sha256.Sum256(catalogRaw)
	guard := &staticGuard{auth: AuthorizationContext{
		SessionID: "session-1", RequestID: "request-1", BotID: "bot", CanonicalUserID: "user",
		PolicyRevision: "sha256:" + strings.Repeat("a", 64), EnvelopeSHA256: strings.Repeat("b", 64),
		ManageAreaIDs: []string{"CN08", "CN07"}, CategoryLevel1IDs: []string{"13", "12"},
	}}
	config := RunnerConfig{
		RealCLIPath: fakePath, RealCLIConfigDir: configDir, WorkingDirectory: workDir,
		CatalogPath: catalogPath, CatalogSHA256: hex.EncodeToString(catalogDigest[:]),
		ArtifactSHA256: hex.EncodeToString(fakeDigest[:]), Limits: testLimits(),
	}
	guard.auth.CatalogSHA256 = config.CatalogSHA256
	guard.auth.ArtifactSHA256 = config.ArtifactSHA256
	config.Limits.Timeout = 15 * time.Second
	verify := func(path, expected string, executable bool) error {
		info, err := os.Stat(path)
		if err != nil {
			return err
		}
		if executable && info.Mode().Perm()&0o111 == 0 {
			return errors.New("not executable")
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(raw)
		if hex.EncodeToString(digest[:]) != expected {
			return errors.New("digest mismatch")
		}
		return nil
	}
	return runnerFixture{
		config: config,
		guard:  guard,
		deps:   Dependencies{Guard: guard, VerifyFile: verify, Audit: io.Discard},
	}
}

func copyExecutable(t *testing.T, source, destination string) {
	t.Helper()
	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, raw, 0o700); err != nil {
		t.Fatal(err)
	}
}

func TestIsLowerSHA256(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "lowercase", value: strings.Repeat("0123456789abcdef", 4), want: true},
		{name: "uppercase", value: strings.Repeat("A", 64)},
		{name: "invalid hex", value: strings.Repeat("g", 64)},
		{name: "too short", value: strings.Repeat("a", 63)},
		{name: "prefixed", value: "sha256:" + strings.Repeat("a", 64)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isLowerSHA256(test.value); got != test.want {
				t.Fatalf("isLowerSHA256(%q) = %v, want %v", test.value, got, test.want)
			}
		})
	}
}

func TestRunUsesCanonicalArgvAndEmptyChildEnvironment(t *testing.T) {
	fixture := newRunnerFixture(t)
	t.Setenv("QDM_INDICATORS_TOKEN", "attacker-token")
	t.Setenv("HOME", "/attacker/home")
	t.Setenv("HTTPS_PROXY", "http://attacker.invalid")
	t.Setenv("LD_PRELOAD", "/attacker/library.so")
	args := []string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01",
		"--indicator", "saleAmt", "--filter", "manageAreaId=CN07",
	}
	result, err := Run(context.Background(), args, fixture.config, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	var captured struct {
		Argv     []string `json:"argv"`
		Env      []string `json:"env"`
		CWD      string   `json:"cwd"`
		StdinEOF bool     `json:"stdinEOF"`
	}
	if err := json.Unmarshal(result.Stdout, &captured); err != nil {
		t.Fatalf("fake output: %s: %v", result.Stdout, err)
	}
	capturedCWDInfo, capturedErr := os.Stat(captured.CWD)
	expectedCWDInfo, expectedErr := os.Stat(fixture.config.WorkingDirectory)
	if capturedErr != nil || expectedErr != nil || !os.SameFile(capturedCWDInfo, expectedCWDInfo) || !captured.StdinEOF {
		t.Fatalf("child boundary cwd=%q stdinEOF=%v", captured.CWD, captured.StdinEOF)
	}
	joinedEnv := strings.Join(captured.Env, "\n")
	for _, denied := range []string{"QDM_INDICATORS_TOKEN", "HOME=", "PROXY=", "LD_PRELOAD", "LUMI_WORKSPACE_PATH", BindingEnvironmentVariable} {
		if strings.Contains(joinedEnv, denied) {
			t.Fatalf("child inherited denied environment %q: %v", denied, captured.Env)
		}
	}
	for _, required := range []string{"LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TZ=UTC", "QDM_INDICATORS_CONFIG_DIR=" + fixture.config.RealCLIConfigDir} {
		if !containsExact(captured.Env, required) {
			t.Fatalf("child missing environment %q: %v", required, captured.Env)
		}
	}
	if countArgValue(captured.Argv, "--filter", "manageAreaId=CN07") != 1 ||
		countArgValue(captured.Argv, "--filter", "categoryLevel1Id=12,13") != 1 {
		t.Fatalf("protected filters were not rebuilt exactly once: %v", captured.Argv)
	}
	if !containsExact(captured.Argv, "--single-page") || countFlag(captured.Argv, "--page-size") != 1 || countFlag(captured.Argv, "--curr-page") != 1 {
		t.Fatalf("controlled pagination missing: %v", captured.Argv)
	}
	if fixture.guard.count() < 2 {
		t.Fatalf("guard was not revalidated before execution and release: %d", fixture.guard.count())
	}
}

func TestRunFinalRevalidationDiscardsCompletedOutput(t *testing.T) {
	fixture := newRunnerFixture(t)
	fixture.guard.failAt = 2
	fixture.guard.failErr = deny(CodeAuthzBindingMismatch, "binding replaced", nil)
	result, err := Run(context.Background(), []string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt",
	}, fixture.config, fixture.deps)
	assertCode(t, err, CodeAuthzBindingMismatch)
	if len(result.Stdout) != 0 {
		t.Fatalf("invalidated result leaked: %q", result.Stdout)
	}
}

func TestRunPollInvalidationKillsInFlightProcessAndDiscardsOutput(t *testing.T) {
	fixture := newRunnerFixture(t)
	if err := os.WriteFile(filepath.Join(fixture.config.RealCLIConfigDir, "fake-sleep"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.guard.failAt = 2
	fixture.guard.failErr = deny(CodeKillSwitchActive, "disabled", nil)
	started := time.Now()
	result, err := Run(context.Background(), []string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt",
	}, fixture.config, fixture.deps)
	assertCode(t, err, CodeKillSwitchActive)
	if time.Since(started) > time.Second {
		t.Fatalf("in-flight process was not killed promptly")
	}
	if len(result.Stdout) != 0 {
		t.Fatalf("killed process output leaked: %q", result.Stdout)
	}
}

func TestRunInvalidationKillsProcessGroupDescendants(t *testing.T) {
	fixture := newRunnerFixture(t)
	marker := filepath.Join(fixture.config.RealCLIConfigDir, "fake-descendant")
	if err := os.WriteFile(marker, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	guard := &markerGuard{
		auth:   fixture.guard.auth,
		marker: filepath.Join(fixture.config.RealCLIConfigDir, "fake-descendant-started"),
		err:    deny(CodeKillSwitchActive, "disabled", nil),
	}
	fixture.deps.Guard = guard
	started := time.Now()
	result, err := Run(context.Background(), []string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt",
	}, fixture.config, fixture.deps)
	assertCode(t, err, CodeKillSwitchActive)
	if time.Since(started) > 10*time.Second {
		t.Fatal("process group was not terminated promptly")
	}
	if len(result.Stdout) != 0 {
		t.Fatalf("killed process output leaked: %q", result.Stdout)
	}
	time.Sleep(time.Second)
	if _, err := os.Stat(filepath.Join(fixture.config.RealCLIConfigDir, "fake-descendant-survived")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("descendant survived process-group termination: %v", err)
	}
}

func TestRunOutputLimitAndNonzeroExitDiscardPartialData(t *testing.T) {
	for _, test := range []struct {
		name string
		file string
		code ErrorCode
	}{
		{"overflow", "fake-overflow", CodeExecutionLimitExceeded},
		{"failure", "fake-fail", CodeRealCLIExecutionFailed},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRunnerFixture(t)
			fixture.config.Limits.MaxOutputBytes = 1024
			if err := os.WriteFile(filepath.Join(fixture.config.RealCLIConfigDir, test.file), []byte("1"), 0o600); err != nil {
				t.Fatal(err)
			}
			result, err := Run(context.Background(), []string{
				"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt",
			}, fixture.config, fixture.deps)
			assertCode(t, err, test.code)
			if len(result.Stdout) != 0 {
				t.Fatalf("partial output leaked: %q", result.Stdout)
			}
		})
	}
}

func TestRunMetadataIsProjectedBeforeRelease(t *testing.T) {
	fixture := newRunnerFixture(t)
	if err := os.WriteFile(filepath.Join(fixture.config.RealCLIConfigDir, "fake-output"), []byte(`[
  {"dimFieldId":"CN07","dimFieldValue":"华东","secret":"x"},
  {"dimFieldId":"CN99","dimFieldValue":"越权","secret":"y"}
]`), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := Run(context.Background(), []string{"dim", "values", "--code", "manageAreaId"}, fixture.config, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(result.Stdout), "CN99") || strings.Contains(string(result.Stdout), "secret") {
		t.Fatalf("metadata was not projected: %s", result.Stdout)
	}
}

func TestRunAuditMarksProjectedOutputExpansionAsTruncated(t *testing.T) {
	fixture := newRunnerFixture(t)
	raw := []byte(`[{"dimFieldId":"CN07","dimFieldValue":"华东"}]`)
	fixture.config.Limits.MaxOutputBytes = int64(len(raw) + 1)
	if err := os.WriteFile(filepath.Join(fixture.config.RealCLIConfigDir, "fake-output"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var audit bytes.Buffer
	fixture.deps.Audit = &audit
	result, err := Run(context.Background(), []string{"dim", "values", "--code", "manageAreaId"}, fixture.config, fixture.deps)
	assertCode(t, err, CodeExecutionLimitExceeded)
	if len(result.Stdout) != 0 {
		t.Fatalf("expanded metadata output leaked: %q", result.Stdout)
	}
	record := decodeAuditRecord(t, audit.String())
	if !record.Truncated || record.TimedOut || record.ReturnedOutputBytes != 0 {
		t.Fatalf("projected output limit was not audited as truncation: %+v", record)
	}
}

func TestProcessCompletionDeadlineIsStrict(t *testing.T) {
	deadline := time.Unix(100, 0)
	if !finishedBeforeDeadline(deadline.Add(-time.Nanosecond), deadline) {
		t.Fatal("completion before deadline was rejected")
	}
	if finishedBeforeDeadline(deadline, deadline) || finishedBeforeDeadline(deadline.Add(time.Nanosecond), deadline) {
		t.Fatal("completion at or after deadline was accepted")
	}
}

func TestRunAuditIncludesAuthorizationAndExecutionOutcome(t *testing.T) {
	fixture := newRunnerFixture(t)
	fixture.guard.auth.WorkspaceID = "workspace-1"
	fixture.guard.auth.AgentID = "agent-1"
	var audit bytes.Buffer
	fixture.deps.Audit = &audit
	result, err := Run(context.Background(), []string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01",
		"--indicator", "saleAmt", "--filter", "manageAreaId=CN07",
	}, fixture.config, fixture.deps)
	if err != nil {
		t.Fatal(err)
	}
	record := decodeAuditRecord(t, audit.String())
	if record.Decision != "allow" || record.WorkspaceID != "workspace-1" || record.AgentID != "agent-1" {
		t.Fatalf("missing authorization identity fields: %+v", record)
	}
	if len(record.IndicatorCodes) != 1 || record.IndicatorCodes[0] != "saleAmt" ||
		record.RequestedAreaCount != 1 || record.RequestedCategoryCount != 0 ||
		record.EffectiveAreaCount != 1 || record.EffectiveCategoryCount != 2 {
		t.Fatalf("missing query scope summary: %+v", record)
	}
	if record.RealCLIExitCode == nil || *record.RealCLIExitCode != 0 || record.TimedOut || record.Truncated ||
		record.OutputBytes == 0 || record.ReturnedOutputBytes != len(result.Stdout) {
		t.Fatalf("missing real CLI outcome: %+v", record)
	}
}

func TestRunAuditMarksTimeoutTruncationAndExitCode(t *testing.T) {
	tests := []struct {
		name      string
		marker    string
		configure func(*runnerFixture)
		code      ErrorCode
		exitCode  int
		timedOut  bool
		truncated bool
	}{
		{name: "timeout", marker: "fake-sleep", configure: func(f *runnerFixture) {
			f.config.Limits.Timeout = 100 * time.Millisecond
		}, code: CodeExecutionLimitExceeded, exitCode: -1, timedOut: true},
		{name: "truncation", marker: "fake-overflow", configure: func(f *runnerFixture) {
			f.config.Limits.MaxOutputBytes = 1024
		}, code: CodeExecutionLimitExceeded, exitCode: -1, truncated: true},
		{name: "nonzero", marker: "fake-fail", configure: func(*runnerFixture) {}, code: CodeRealCLIExecutionFailed, exitCode: 7},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRunnerFixture(t)
			test.configure(&fixture)
			if err := os.WriteFile(filepath.Join(fixture.config.RealCLIConfigDir, test.marker), []byte("1"), 0o600); err != nil {
				t.Fatal(err)
			}
			var audit bytes.Buffer
			fixture.deps.Audit = &audit
			result, err := Run(context.Background(), []string{
				"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt",
			}, fixture.config, fixture.deps)
			assertCode(t, err, test.code)
			if len(result.Stdout) != 0 {
				t.Fatalf("failed invocation leaked output: %q", result.Stdout)
			}
			record := decodeAuditRecord(t, audit.String())
			if record.RealCLIExitCode == nil || *record.RealCLIExitCode != test.exitCode ||
				record.TimedOut != test.timedOut || record.Truncated != test.truncated || record.ReturnedOutputBytes != 0 {
				t.Fatalf("unexpected execution audit: %+v", record)
			}
		})
	}
}

func TestRunFailsClosedWhenAuditCannotBeWritten(t *testing.T) {
	fixture := newRunnerFixture(t)
	fixture.deps.Audit = failingAuditWriter{}
	result, err := Run(context.Background(), []string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt",
	}, fixture.config, fixture.deps)
	assertCode(t, err, CodeAuthzConfigInvalid)
	if len(result.Stdout) != 0 {
		t.Fatalf("result was released without a durable audit record: %q", result.Stdout)
	}
}

func decodeAuditRecord(t *testing.T, output string) auditRecord {
	t.Helper()
	const prefix = "HARNESS_AUTHZ_AUDIT "
	line := strings.TrimSpace(output)
	if !strings.HasPrefix(line, prefix) {
		t.Fatalf("missing audit prefix: %q", output)
	}
	var record auditRecord
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, prefix)), &record); err != nil {
		t.Fatalf("invalid audit JSON: %v", err)
	}
	return record
}

func countArgValue(args []string, flag, value string) int {
	count := 0
	for index := 0; index+1 < len(args); index++ {
		if args[index] == flag && args[index+1] == value {
			count++
		}
	}
	return count
}

func countFlag(args []string, flag string) int {
	count := 0
	for _, arg := range args {
		if arg == flag {
			count++
		}
	}
	return count
}
