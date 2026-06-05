package context

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"harness-data/cli/internal/harness"
	"harness-data/cli/internal/sessionstate"
)

type casConfig struct {
	CAS struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"cas"`
}

type casConfigLocation struct {
	Dir  string
	Path string
}

func preflightAuth(root string, plan WikiPlan) []string {
	apps := appsForPlan(plan)
	if len(apps) == 0 {
		return nil
	}
	cfg, err := harness.LoadConfig(root)
	if err != nil {
		return []string{"auth preflight skipped: " + err.Error()}
	}
	var notes []string
	for _, app := range apps {
		note := preflightAppAuth(root, cfg.CLI, app)
		if note != "" {
			notes = append(notes, note)
		}
	}
	return notes
}

func appsForPlan(plan WikiPlan) []string {
	seen := map[string]bool{}
	var apps []string
	add := func(app string) {
		if app == "" || seen[app] {
			return
		}
		seen[app] = true
		apps = append(apps, app)
	}
	paths := []string{plan.SelectedPlaybook}
	for _, playbook := range plan.SelectedPlaybooks {
		paths = append(paths, playbook.Path)
	}
	for _, path := range paths {
		switch {
		case strings.Contains(path, "/cmr/") || strings.HasPrefix(path, "playbooks/cmr/") || strings.HasPrefix(path, "spec/cmr/"):
			add("cmr")
		case strings.Contains(path, "/idx/") || strings.HasPrefix(path, "playbooks/idx/") || strings.HasPrefix(path, "spec/idx/"):
			add("indicators")
		}
	}
	for _, candidate := range plan.Candidates {
		switch {
		case strings.Contains(candidate.Path, "/cmr/") || strings.HasPrefix(candidate.Path, "playbooks/cmr/") || strings.HasPrefix(candidate.Path, "spec/cmr/"):
			add("cmr")
		case strings.Contains(candidate.Path, "/idx/") || strings.HasPrefix(candidate.Path, "playbooks/idx/") || strings.HasPrefix(candidate.Path, "spec/idx/"):
			add("indicators")
		}
	}
	if plan.Mode == sessionstate.ModeFree {
		return nil
	}
	return apps
}

func preflightAppAuth(root string, cfg harness.CLIConfig, app string) string {
	targetCLI := targetCLIForApp(cfg, app)
	if targetCLI == "" {
		return app + " token preflight skipped: target CLI path is not configured"
	}
	ok, err := checkTargetToken(root, targetCLI)
	if err == nil && ok {
		return app + " token valid"
	}
	if cfg.QDMCasCLI == "" {
		return app + " token invalid and qdm_cas_cli is not configured"
	}
	location, err := casConfigLocationForRoot(root)
	if err != nil {
		return fmt.Sprintf("%s token invalid; CAS config path could not be resolved: %v", app, err)
	}
	if !casCredentialsConfiguredAt(location.Path) {
		return fmt.Sprintf("%s token invalid; CAS credentials are not configured at %s, so hook did not start QR login", app, location.Path)
	}
	token, err := fetchCASToken(root, cfg.QDMCasCLI, app, location.Dir)
	if err != nil {
		return fmt.Sprintf("%s token refresh failed: %v", app, err)
	}
	if err := setTargetToken(root, targetCLI, token); err != nil {
		return fmt.Sprintf("%s token refresh fetched token but set-token failed: %v", app, err)
	}
	ok, err = checkTargetToken(root, targetCLI)
	if err != nil {
		return fmt.Sprintf("%s token refreshed; check-token failed after refresh: %v", app, err)
	}
	if !ok {
		return app + " token refresh completed but target CLI still reports invalid token"
	}
	return app + " token refreshed through CAS credentials"
}

func targetCLIForApp(cfg harness.CLIConfig, app string) string {
	switch app {
	case "cmr":
		return cfg.QDMCmrCLI
	case "indicators":
		return cfg.QDMIndicatorsCLI
	default:
		return ""
	}
}

func checkTargetToken(root, cli string) (bool, error) {
	out, err := runShortCommand(root, 10*time.Second, cli, "config", "check-token")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(out) == "true", nil
}

func fetchCASToken(root, casCLI, app, casConfigDir string) (string, error) {
	out, err := runShortCommandWithEnv(root, 45*time.Second, map[string]string{
		"QDM_CAS_CONFIG_DIR": casConfigDir,
	}, casCLI, "token", "--timeout", "40s", "--app", app)
	if err != nil {
		return "", err
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for i, line := range lines {
		if strings.TrimSpace(line) == "Bearer Token:" && i+1 < len(lines) {
			token := strings.TrimSpace(lines[i+1])
			if token != "" {
				return token, nil
			}
		}
	}
	for i := len(lines) - 1; i >= 0; i-- {
		token := strings.TrimSpace(lines[i])
		if token != "" && !strings.Contains(token, ":") && !strings.Contains(token, " ") {
			return token, nil
		}
	}
	return "", fmt.Errorf("CAS token output did not include a bearer token")
}

func setTargetToken(root, cli, token string) error {
	_, err := runShortCommand(root, 10*time.Second, cli, "config", "set-token", token)
	return err
}

func runShortCommand(root string, timeout time.Duration, name string, args ...string) (string, error) {
	return runShortCommandWithEnv(root, timeout, nil, name, args...)
}

func runShortCommandWithEnv(root string, timeout time.Duration, env map[string]string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = root
	cmd.Env = commandEnv(env)
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if ctx.Err() == context.DeadlineExceeded {
		return text, fmt.Errorf("command timed out")
	}
	if err != nil {
		if text != "" {
			return text, fmt.Errorf("%w: %s", err, text)
		}
		return text, err
	}
	return text, nil
}

func commandEnv(overrides map[string]string) []string {
	if len(overrides) == 0 {
		return os.Environ()
	}
	env := os.Environ()
	out := make([]string, 0, len(env)+len(overrides))
	for _, item := range env {
		key, _, ok := strings.Cut(item, "=")
		if ok {
			if _, overridden := overrides[key]; overridden {
				continue
			}
		}
		out = append(out, item)
	}
	for key, value := range overrides {
		out = append(out, key+"="+value)
	}
	return out
}

func casCredentialsConfigured(root string) bool {
	location, err := casConfigLocationForRoot(root)
	if err != nil {
		return false
	}
	return casCredentialsConfiguredAt(location.Path)
}

func casCredentialsConfiguredAt(path string) bool {
	body, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var cfg casConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		return false
	}
	return strings.TrimSpace(cfg.CAS.Username) != "" && cfg.CAS.Password != ""
}

func casConfigPath(root string) (string, error) {
	location, err := casConfigLocationForRoot(root)
	if err != nil {
		return "", err
	}
	return location.Path, nil
}

func casConfigLocationForRoot(root string) (casConfigLocation, error) {
	if dir := strings.TrimSpace(os.Getenv("QDM_CAS_CONFIG_DIR")); dir != "" {
		return casConfigLocation{Dir: dir, Path: filepath.Join(dir, "config.json")}, nil
	}
	if workspace := strings.TrimSpace(os.Getenv("LUMI_WORKSPACE_PATH")); workspace != "" {
		dir := filepath.Join(workspace, ".qdm-auth", "cas")
		return casConfigLocation{Dir: dir, Path: filepath.Join(dir, "config.json")}, nil
	}
	if root != "" {
		dir := filepath.Join(root, ".qdm-auth", "cas")
		path := filepath.Join(dir, "config.json")
		if _, err := os.Stat(path); err == nil {
			return casConfigLocation{Dir: dir, Path: path}, nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return casConfigLocation{}, err
	}
	dir := filepath.Join(home, ".cas-cli")
	return casConfigLocation{Dir: dir, Path: filepath.Join(dir, "config.json")}, nil
}
