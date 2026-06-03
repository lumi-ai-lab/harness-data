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
	if !casCredentialsConfigured(root) {
		return app + " token invalid; CAS credentials are not configured, so hook did not start QR login"
	}
	token, err := fetchCASToken(root, cfg.QDMCasCLI, app)
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

func fetchCASToken(root, casCLI, app string) (string, error) {
	out, err := runShortCommand(root, 45*time.Second, casCLI, "token", "--timeout", "40s", "--app", app)
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
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = root
	cmd.Env = os.Environ()
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

func casCredentialsConfigured(root string) bool {
	path, err := casConfigPath(root)
	if err != nil {
		return false
	}
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
	if dir := strings.TrimSpace(os.Getenv("QDM_CAS_CONFIG_DIR")); dir != "" {
		return filepath.Join(dir, "config.json"), nil
	}
	if workspace := strings.TrimSpace(os.Getenv("LUMI_WORKSPACE_PATH")); workspace != "" {
		return filepath.Join(workspace, ".qdm-auth", "cas", "config.json"), nil
	}
	if root != "" {
		path := filepath.Join(root, ".qdm-auth", "cas", "config.json")
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".cas-cli", "config.json"), nil
}
