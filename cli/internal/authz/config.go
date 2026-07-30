package authz

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

const maxConfigBytes int64 = 1 << 20

var lowercaseSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

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
	if config.Mode != ModeLumiMVPRequired && config.Mode != ModeDisabledDeny {
		return invalid("authorization config mode is unsupported")
	}
	if config.PiVersion != RequiredPiVersion {
		return invalid("authorization config Pi version is unsupported")
	}
	for name, value := range map[string]string{
		"requesterContextDir":           config.RequesterContextDir,
		"realIndicatorsCli.path":        config.RealIndicatorsCLI.Path,
		"realIndicatorsCli.configDir":   config.RealIndicatorsCLI.ConfigDir,
		"approvedIndicatorCatalog.path": config.ApprovedIndicatorCatalog.Path,
		"killSwitch.controlPath":        config.KillSwitch.ControlPath,
	} {
		if err := validateAbsoluteCleanPath(value); err != nil {
			return invalid(fmt.Sprintf("authorization config %s is invalid", name))
		}
	}
	if config.RealIndicatorsCLI.Version != "0.0.4" {
		return invalid("real Indicators CLI version must be 0.0.4")
	}
	if !lowercaseSHA256Pattern.MatchString(config.RealIndicatorsCLI.ArtifactSHA256) {
		return invalid("real Indicators CLI artifactSha256 is invalid")
	}
	if !lowercaseSHA256Pattern.MatchString(config.ApprovedIndicatorCatalog.SHA256) {
		return invalid("approved indicator catalog sha256 is invalid")
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
	if config.KillSwitch.PollMilliseconds <= 0 || config.KillSwitch.PollMilliseconds > 60_000 {
		return invalid("killSwitch.pollMilliseconds is outside the supported range")
	}
	limits := config.Limits
	positive := map[string]int64{
		"limits.maxDateRangeDays":     limits.MaxDateRangeDays,
		"limits.maxIndicators":        limits.MaxIndicators,
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
	if limits.MaxDateRangeDays > 3660 || limits.MaxIndicators > 1000 || limits.MaxDimensions > 1000 ||
		limits.MaxPageSize > 1_000_000 || limits.MaxMetadataLimit > 1_000_000 ||
		limits.TimeoutSeconds > 3600 || limits.MaxOutputBytes > 1<<30 {
		return invalid("authorization execution limits exceed supported safety bounds")
	}
	return nil
}

// RequireEnforcing rejects static deny-only configurations.
func (config Config) RequireEnforcing() error {
	if err := config.Validate(); err != nil {
		return err
	}
	if config.Mode != ModeLumiMVPRequired {
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
