package agentauthz

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"harness-data/cli/internal/harness"
)

// ExecInvocation is the trusted child process assembled by authz-exec. The
// encrypted blob is kept inside the broker process and never returned through
// WorkBuddy updatedInput.
type ExecInvocation struct {
	Path string
	Args []string
}

func BuildExecInvocation(root, agent string, args []string, env map[string]string) (ExecInvocation, error) {
	if strings.ToLower(strings.TrimSpace(agent)) != "workbuddy" {
		return ExecInvocation{}, fmt.Errorf("authz-exec only accepts --agent workbuddy")
	}
	cleaned, kind, err := sanitizeExecArgs(args)
	if err != nil {
		return ExecInvocation{}, err
	}
	cfg, err := harness.LoadConfig(root)
	if err != nil {
		return ExecInvocation{}, err
	}
	if !cfg.Authz.AuthzEnabled() {
		return ExecInvocation{}, fmt.Errorf("QDM_AUTHZ_DISABLED: authz-exec requires authz.mode=on")
	}
	resolved, err := ResolveAuthBlob(ResolveOptions{ProjectRoot: root, Config: cfg.Authz, Env: env})
	if err != nil {
		return ExecInvocation{}, fmt.Errorf("QDM_AUTHZ_SOURCE_MISSING: no valid configured authorization is available")
	}
	metricCLI := ResolveMetricCLIPath(root, cfg)
	if strings.TrimSpace(metricCLI) == "" {
		return ExecInvocation{}, fmt.Errorf("QDM_AUTHZ_METRIC_CLI_MISSING: qdm-metric-cli is not configured")
	}
	if _, err := os.Stat(metricCLI); err != nil {
		return ExecInvocation{}, fmt.Errorf("QDM_AUTHZ_METRIC_CLI_MISSING: configured qdm-metric-cli is unavailable")
	}
	if kind == "analysis-execute" {
		cleaned = append(cleaned, "--data-auth", "--auth-blob", resolved.Blob)
	} else {
		cleaned = append(cleaned, "--auth-blob", resolved.Blob)
	}
	return ExecInvocation{Path: metricCLI, Args: cleaned}, nil
}

// RunExec executes qdm-metric-cli as a trusted broker. stdout/stderr are
// forwarded byte-for-byte; the caller controls the WorkBuddy compatibility
// wrapper that makes those streams visible to the host tool result.
func RunExec(root, agent string, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	invocation, err := BuildExecInvocation(root, agent, args, nil)
	if err != nil {
		return 2, err
	}
	cmd := exec.Command(invocation.Path, invocation.Args...)
	cmd.Dir = root
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = scrubAuthEnvironment(os.Environ())
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if ok := errors.As(err, &exitErr); ok {
			return exitErr.ExitCode(), nil
		}
		return 1, fmt.Errorf("QDM_AUTHZ_EXEC_FAILED: unable to start qdm-metric-cli")
	}
	return 0, nil
}

func sanitizeExecArgs(args []string) ([]string, string, error) {
	if len(args) < 2 {
		return nil, "", fmt.Errorf("authz-exec requires qdm-metric-cli auth describe or analysis execute arguments")
	}
	kind := ""
	if strings.EqualFold(args[0], "auth") && strings.EqualFold(args[1], "describe") {
		kind = "auth-describe"
	}
	if strings.EqualFold(args[0], "analysis") && strings.EqualFold(args[1], "execute") {
		kind = "analysis-execute"
	}
	if kind == "" {
		return nil, "", fmt.Errorf("authz-exec only permits qdm-metric-cli auth describe or analysis execute")
	}
	out := make([]string, 0, len(args)+2)
	for index := 0; index < len(args); index++ {
		value := args[index]
		lower := strings.ToLower(value)
		switch {
		case lower == "--data-auth":
			continue
		case lower == "--auth-blob" || lower == "--auth-json":
			if index+1 < len(args) {
				index++
			}
			continue
		case strings.HasPrefix(lower, "--auth-blob=") || strings.HasPrefix(lower, "--auth-json="):
			continue
		default:
			out = append(out, value)
		}
	}
	return out, kind, nil
}

func scrubAuthEnvironment(items []string) []string {
	blocked := map[string]bool{}
	for _, key := range AuthSourceEnvKeys {
		blocked[strings.ToUpper(key)] = true
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		key, _, ok := strings.Cut(item, "=")
		if ok && blocked[strings.ToUpper(key)] {
			continue
		}
		out = append(out, item)
	}
	return out
}
