package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"harness-data/cli/internal/authz"
)

const (
	authzConfigPath = "/etc/harness-data/authz.json"
	catalogPath     = "/etc/harness-data/approved-metrics-v1.json"
	fixtureRoot     = "/var/lib/harness-data/release-smoke"
)

type installerTool struct {
	Version     string `json:"version"`
	SHA256      string `json:"sha256"`
	Destination string `json:"destination"`
}

type installerState struct {
	Profile string                   `json:"profile"`
	Tools   map[string]installerTool `json:"tools"`
}

func main() {
	runtimeRoot := flag.String("runtime", "", "installed Harness runtime root")
	agentUIDValue := flag.Uint64("agent-uid", 0, "unprivileged Agent UID")
	flag.Parse()

	if flag.NArg() != 0 || *runtimeRoot == "" || *agentUIDValue == 0 || *agentUIDValue > math.MaxUint32 {
		exit(errors.New("--runtime and a nonzero uint32 --agent-uid are required"))
	}
	binding, err := buildFixture(filepath.Clean(*runtimeRoot), uint32(*agentUIDValue), time.Now().UTC())
	if err != nil {
		exit(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(binding); err != nil {
		exit(err)
	}
}

func buildFixture(runtimeRoot string, agentUID uint32, now time.Time) (authz.BindResult, error) {
	if !filepath.IsAbs(runtimeRoot) {
		return authz.BindResult{}, errors.New("runtime path must be absolute")
	}
	if os.Geteuid() != 0 {
		return authz.BindResult{}, errors.New("release smoke fixture must run as root")
	}

	var state installerState
	statePath := filepath.Join(runtimeRoot, ".harness", "installer-state.json")
	if err := decodeInstallerState(statePath, &state); err != nil {
		return authz.BindResult{}, fmt.Errorf("read installer state: %w", err)
	}
	if state.Profile != authz.ModeLumiMVPRequired {
		return authz.BindResult{}, fmt.Errorf("unexpected installer profile %q", state.Profile)
	}
	realMetric, ok := state.Tools["qdm-metric-cli-real"]
	if !ok {
		return authz.BindResult{}, errors.New("installer state is missing qdm-metric-cli-real")
	}
	realMetricPath := filepath.Clean(realMetric.Destination)
	if !filepath.IsAbs(realMetricPath) {
		return authz.BindResult{}, errors.New("real Metric CLI path must be absolute")
	}
	realMetricSHA256, err := fileSHA256(realMetricPath)
	if err != nil {
		return authz.BindResult{}, fmt.Errorf("digest real Metric CLI: %w", err)
	}
	if realMetric.SHA256 != realMetricSHA256 {
		return authz.BindResult{}, errors.New("real Metric CLI digest does not match installer state")
	}
	catalogSHA256, err := fileSHA256(catalogPath)
	if err != nil {
		return authz.BindResult{}, fmt.Errorf("digest approved Metric catalog: %w", err)
	}

	contextDir := filepath.Join(fixtureRoot, "requester-context")
	controlDir := filepath.Join(fixtureRoot, "control")
	controlPath := filepath.Join(controlDir, "authz-state.json")
	for _, directory := range []struct {
		path string
		mode os.FileMode
	}{
		{fixtureRoot, 0o755},
		{contextDir, 0o711},
		{controlDir, 0o700},
		{filepath.Dir(authzConfigPath), 0o755},
	} {
		if err := ensureRootDirectory(directory.path, directory.mode); err != nil {
			return authz.BindResult{}, err
		}
	}

	config := authz.Config{
		Version:                  authz.CurrentVersion,
		Mode:                     authz.ModeLumiMVPRequired,
		PiVersion:                authz.RequiredPiVersion,
		AgentUID:                 &agentUID,
		RequesterContextDir:      contextDir,
		RequesterContextOwnerUID: rootUID(),
		MaxEnvelopeBytes:         64 << 10,
		MaxEnvelopeTTLSeconds:    1800,
		ClockSkewSeconds:         30,
		RealMetricCLI: authz.RealMetricCLIConfig{
			Path:           realMetricPath,
			Version:        strings.TrimPrefix(realMetric.Version, "v"),
			ArtifactSHA256: realMetricSHA256,
		},
		ApprovedMetricCatalog: authz.ArtifactConfig{
			Path:   catalogPath,
			SHA256: catalogSHA256,
		},
		KillSwitch: authz.KillSwitchConfig{
			ControlPath:      controlPath,
			PollMilliseconds: 100,
		},
		Limits: authz.LimitsConfig{
			MaxDateRangeDays:     31,
			MaxMetrics:           10,
			MaxDimensions:        10,
			DefaultPageSize:      200,
			MaxPageSize:          1000,
			DefaultMetadataLimit: 100,
			MaxMetadataLimit:     500,
			TimeoutSeconds:       30,
			MaxOutputBytes:       2 << 20,
		},
	}
	if err := config.Validate(); err != nil {
		return authz.BindResult{}, err
	}
	if err := writeRootJSON(authzConfigPath, config, 0o600); err != nil {
		return authz.BindResult{}, err
	}
	if err := writeRootJSON(controlPath, authz.ControlState{
		Version:    authz.CurrentVersion,
		Generation: 1,
		State:      "enabled",
		UpdatedAt:  now.Add(-time.Minute),
	}, 0o600); err != nil {
		return authz.BindResult{}, err
	}

	sessionID := "release-smoke-session"
	envelope := authz.Envelope{
		Version:     authz.CurrentVersion,
		WorkspaceID: "release-smoke-workspace",
		AgentID:     "release-smoke-agent",
		SessionID:   sessionID,
		IssuedAt:    now.Add(-time.Minute),
		ExpiresAt:   now.Add(10 * time.Minute),
		RequesterContext: authz.RequesterContext{
			Version:        authz.CurrentVersion,
			RequestID:      "release-smoke-request",
			PolicyRevision: "sha256:" + strings.Repeat("a", 64),
			Principal: authz.Principal{
				Channel:         "wecom",
				BotID:           "release-smoke-bot",
				CanonicalUserID: "release-smoke-user",
				DisplayName:     "Release Smoke",
			},
			Audience: authz.Audience{
				ChatID:   "release-smoke-chat",
				ChatType: "group",
			},
			Authorization: authz.Authorization{
				Capabilities: []string{authz.CapabilityMetricQuery},
				Scope: authz.Scope{
					ManageAreaIDs:     []string{"CN07"},
					DCManageAreaIDs:   []string{"CN07"},
					CategoryLevel1IDs: []string{"12"},
				},
			},
		},
	}
	envelopeName, err := authz.SessionFileName(sessionID)
	if err != nil {
		return authz.BindResult{}, err
	}
	if err := writeRootJSON(filepath.Join(contextDir, envelopeName), envelope, 0o644); err != nil {
		return authz.BindResult{}, err
	}
	return authz.Bind(config, sessionID, authz.WithAgentUID(agentUID), authz.WithNow(now))
}

func rootUID() *uint32 {
	uid := uint32(0)
	return &uid
}

func ensureRootDirectory(path string, mode os.FileMode) error {
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("fixture path is not a regular directory: %s", path)
	}
	if err := os.Chown(path, 0, 0); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}

func writeRootJSON(path string, value any, mode os.FileMode) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".release-smoke-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chown(temporaryPath, 0, 0); err != nil {
		return err
	}
	if err := os.Chmod(temporaryPath, mode); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func decodeInstallerState(path string, target any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains multiple values")
		}
		return err
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

func exit(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
