package authz

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const maxConfigBytes int64 = 1 << 20

var (
	lowercaseSHA256Pattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	metricCLIVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
)

// LoadConfig reads and strictly validates an authorization config. An empty
// path selects DefaultConfigPath.
func LoadConfig(path string) (Config, error) {
	if path == "" {
		path = DefaultConfigPath
	}
	if !filepath.IsAbs(path) {
		return Config{}, authzError(CodeConfigInvalid, "authorization config path must be absolute", nil)
	}
	data, _, err := readRegularFile(path, maxConfigBytes)
	if err != nil {
		return Config{}, authzError(CodeConfigInvalid, "authorization config cannot be read safely", err)
	}
	var config Config
	if err := decodeStrictJSON(data, &config); err != nil {
		return Config{}, authzError(CodeConfigInvalid, "authorization config is invalid", err)
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

// Validate checks the complete V1 config schema and all value relationships.
func (config Config) Validate() error {
	invalid := func(message string) error {
		return authzError(CodeConfigInvalid, message, nil)
	}
	if config.Version != CurrentVersion {
		return invalid("authorization config version must be 1")
	}
	if config.Mode != ModePiRequesterAuthorized && config.Mode != ModeDisabledDeny {
		return invalid("authorization config mode is unsupported")
	}
	if config.PiVersion != RequiredPiVersion {
		return invalid("authorization config Pi version is unsupported")
	}
	for name, value := range map[string]string{
		"requesterContextDir":        config.RequesterContextDir,
		"realMetricCli.path":         config.RealMetricCLI.Path,
		"approvedMetricCatalog.path": config.ApprovedMetricCatalog.Path,
	} {
		if err := validateAbsoluteCleanPath(value); err != nil {
			return invalid(fmt.Sprintf("authorization config %s is invalid", name))
		}
	}
	if config.RequesterContextAgentID != "pi" {
		return invalid("authorization config requesterContextAgentId must be pi")
	}
	if !metricCLIVersionPattern.MatchString(config.RealMetricCLI.Version) {
		return invalid("real Metric CLI version must be a valid semver")
	}
	if config.MaxEnvelopeBytes <= 0 || config.MaxEnvelopeBytes > 16<<20 {
		return invalid("maxEnvelopeBytes is outside the supported range")
	}
	if config.MaxEnvelopeTTLSeconds <= 0 || config.MaxEnvelopeTTLSeconds > 1800 {
		return invalid("maxEnvelopeTtlSeconds must be between 1 and 1800")
	}
	if config.ClockSkewSeconds < 0 || config.ClockSkewSeconds > config.MaxEnvelopeTTLSeconds {
		return invalid("clockSkewSeconds is outside the supported range")
	}
	limits := config.Limits
	positive := map[string]int64{
		"limits.maxDateRangeDays":     limits.MaxDateRangeDays,
		"limits.maxMetrics":           limits.MaxMetrics,
		"limits.maxDimensions":        limits.MaxDimensions,
		"limits.defaultPageSize":      limits.DefaultPageSize,
		"limits.maxPageSize":          limits.MaxPageSize,
		"limits.defaultMetadataLimit": limits.DefaultMetadataLimit,
		"limits.maxMetadataLimit":     limits.MaxMetadataLimit,
		"limits.timeoutSeconds":       limits.TimeoutSeconds,
		"limits.maxOutputBytes":       limits.MaxOutputBytes,
	}
	for name, value := range positive {
		if value <= 0 {
			return invalid(name + " must be positive")
		}
	}
	if limits.DefaultPageSize > limits.MaxPageSize {
		return invalid("limits.defaultPageSize exceeds maxPageSize")
	}
	if limits.DefaultMetadataLimit > limits.MaxMetadataLimit {
		return invalid("limits.defaultMetadataLimit exceeds maxMetadataLimit")
	}
	if limits.MaxDateRangeDays > 3660 || limits.MaxMetrics > 1000 || limits.MaxDimensions > 1000 ||
		limits.MaxPageSize > 1_000_000 || limits.MaxMetadataLimit > 1_000_000 ||
		limits.TimeoutSeconds > 3600 || limits.MaxOutputBytes > 1<<30 {
		return invalid("authorization execution limits exceed supported safety bounds")
	}
	return nil
}

// RuntimeConfig builds the lightweight authorization settings from the
// installed runtime and Lumi's per-agent requester-context directory. No
// deployment-owned authorization file, UID/GID, or fixed filesystem mode is
// required.
func RuntimeConfig() (Config, error) {
	executable, err := os.Executable()
	if err != nil {
		return Config{}, authzError(CodeConfigInvalid, "authorization runtime cannot resolve its executable", err)
	}
	contextDir := strings.TrimSpace(os.Getenv("LUMI_REQUESTER_CONTEXT_DIR"))
	if contextDir == "" {
		return Config{}, authzError(CodeConfigInvalid, "LUMI_REQUESTER_CONTEXT_DIR is required", nil)
	}
	root, err := findRuntimeRoot(executable)
	if err != nil {
		return Config{}, authzError(CodeConfigInvalid, "authorization runtime root cannot be resolved", err)
	}
	config := ConfigForRuntime(root, contextDir)
	applyRuntimeInstallerState(root, &config)
	return config, nil
}

// ConfigForRuntime is the deterministic form used by tests and embedded
// launchers.
func ConfigForRuntime(root, contextDir string) Config {
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	return Config{
		Version:                     CurrentVersion,
		Mode:                        ModePiRequesterAuthorized,
		PiVersion:                   RequiredPiVersion,
		RequesterContextDir:         filepath.Clean(contextDir),
		RequesterContextWorkspaceID: "",
		RequesterContextAgentID:     "pi",
		MaxEnvelopeBytes:            64 << 10,
		MaxEnvelopeTTLSeconds:       1800,
		ClockSkewSeconds:            30,
		RealMetricCLI: RealMetricCLIConfig{
			Path:    filepath.Join(root, ".harness", "private", "bin", "qdm-metric-cli-real"+suffix),
			Version: "0.1.0",
		},
		ApprovedMetricCatalog: ArtifactConfig{
			Path: filepath.Join(root, "bootstrap", "approved-metrics-v1.json"),
		},
		Limits: LimitsConfig{
			MaxDateRangeDays: 31, MaxMetrics: 10, MaxDimensions: 10,
			DefaultPageSize: 200, MaxPageSize: 1000,
			DefaultMetadataLimit: 100, MaxMetadataLimit: 500,
			TimeoutSeconds: 30, MaxOutputBytes: 2 << 20,
		},
	}
}

func applyRuntimeInstallerState(root string, config *Config) {
	state, err := readRuntimeInstallerState(filepath.Join(root, ".harness", "installer-state.json"))
	if err != nil || state.Profile != ModePiRequesterAuthorized {
		return
	}
	if tool, ok := state.Tools["qdm-metric-cli-real"]; ok && validateAbsoluteCleanPath(tool.Destination) == nil {
		config.RealMetricCLI.Path = tool.Destination
	}
	if version := strings.TrimPrefix(state.ReleaseSet.RealMetricVersion, "v"); metricCLIVersionPattern.MatchString(version) {
		config.RealMetricCLI.Version = version
	}
	if lowercaseSHA256Pattern.MatchString(state.ReleaseSet.RealMetricSHA256) {
		config.RealMetricCLI.ArtifactSHA256 = state.ReleaseSet.RealMetricSHA256
	}
	if lowercaseSHA256Pattern.MatchString(state.ReleaseSet.CatalogSHA256) {
		config.ApprovedMetricCatalog.SHA256 = state.ReleaseSet.CatalogSHA256
	}
}

func readRuntimeInstallerState(path string) (installerState, error) {
	data, _, err := readRegularFile(path, maxInstallerStateBytes)
	if err != nil {
		return installerState{}, err
	}
	var state installerState
	if err := json.Unmarshal(data, &state); err != nil {
		return installerState{}, err
	}
	return state, nil
}

func findRuntimeRoot(executable string) (string, error) {
	current := filepath.Dir(filepath.Clean(executable))
	for range 8 {
		catalog := filepath.Join(current, "bootstrap", "approved-metrics-v1.json")
		if info, err := os.Stat(catalog); err == nil && info.Mode().IsRegular() {
			return current, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return "", fmt.Errorf("installed runtime marker bootstrap/approved-metrics-v1.json was not found")
}

// RequireEnforcing rejects static deny-only configurations.
func (config Config) RequireEnforcing() error {
	if err := config.Validate(); err != nil {
		return err
	}
	if config.Mode != ModePiRequesterAuthorized {
		return authzError(CodeKillSwitchActive, "authorization is disabled", nil)
	}
	return nil
}

func validateAbsoluteCleanPath(value string) error {
	if value == "" || strings.ContainsRune(value, 0) || !filepath.IsAbs(value) {
		return fmt.Errorf("path must be a non-empty absolute path")
	}
	if filepath.Clean(value) != value {
		return fmt.Errorf("path must already be clean")
	}
	return nil
}

func validateRequesterContextPathSegment(value string) error {
	if err := validateRequiredWireString(value); err != nil {
		return err
	}
	if value == "." || value == ".." || strings.ContainsAny(value, "/\\") || filepath.Base(value) != value {
		return fmt.Errorf("value must be one safe path segment")
	}
	return nil
}
