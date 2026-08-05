package authz

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"harness-data/cli/internal/harness"
)

const (
	maxInstallerStateBytes int64 = 1 << 20
	maxCLIManifestBytes    int64 = 1 << 20
	maxHarnessConfigBytes  int64 = 1 << 20
	maxAgentConfigBytes    int64 = 1 << 20
)

var envExportPattern = regexp.MustCompile(`^export[\t ]+([A-Z0-9_]+)="([^"\r\n]*)"[\t ]*$`)

type installerState struct {
	LastInstallDir  string                     `json:"lastInstallDir"`
	UpdatedAt       string                     `json:"updatedAt"`
	SchemaVersion   int                        `json:"schemaVersion"`
	Profile         string                     `json:"profile"`
	Agent           string                     `json:"agent"`
	InstallMode     string                     `json:"installMode"`
	RuntimeTag      string                     `json:"runtimeTag"`
	LocalTools      map[string]json.RawMessage `json:"localTools"`
	Tools           map[string]installerTool   `json:"tools"`
	ManifestSHA256  string                     `json:"manifestSha256"`
	PackageVersion  string                     `json:"packageVersion"`
	ReleaseSet      installerReleaseSet        `json:"releaseSet"`
	AuthzConfigPath string                     `json:"authzConfigPath"`
	LastCheckAt     string                     `json:"lastCheckAt"`
}

type installerTool struct {
	Version     string `json:"version"`
	Asset       string `json:"asset"`
	SHA256      string `json:"sha256"`
	AssetSHA256 string `json:"assetSha256"`
	Destination string `json:"destination"`
}

type installerReleaseSet struct {
	Key                 string `json:"key"`
	Platform            string `json:"platform"`
	Version             string `json:"version"`
	SHA256              string `json:"sha256"`
	PublicMetricVersion string `json:"publicMetricVersion"`
	PublicMetricSHA256  string `json:"publicMetricSha256"`
	RealMetricVersion   string `json:"realMetricVersion"`
	RealMetricSHA256    string `json:"realMetricSha256"`
	CatalogSHA256       string `json:"catalogSha256"`
	AuthzSchemaVersion  int    `json:"authzSchemaVersion"`
	PiVersion           string `json:"piVersion"`
}

type releaseSetDigestInput struct {
	Platform            string `json:"platform"`
	Version             string `json:"version"`
	PublicMetricVersion string `json:"publicMetricVersion"`
	PublicMetricSHA256  string `json:"publicMetricSha256"`
	RealMetricVersion   string `json:"realMetricVersion"`
	RealMetricSHA256    string `json:"realMetricSha256"`
	CatalogSHA256       string `json:"catalogSha256"`
	AuthzSchemaVersion  int    `json:"authzSchemaVersion"`
	PiVersion           string `json:"piVersion"`
}

type piAgentSettings struct {
	EnableSkillCommands bool     `json:"enableSkillCommands"`
	Extensions          []string `json:"extensions"`
	Skills              []string `json:"skills"`
}

// CheckReadiness verifies the complete runtime authorization deployment. Its
// report deliberately omits all paths, digests, identities, and credentials.
func CheckReadiness(configPath string, options ReadinessOptions) (ReadinessReport, error) {
	_, report, err := LoadReadyConfig(configPath, options)
	return report, err
}

// LoadReadyConfig returns the exact immutable config value that passed the
// complete readiness check. Runtime callers must reuse this value rather than
// reopening the config after readiness and creating a check/use split.
func LoadReadyConfig(configPath string, options ReadinessOptions) (Config, ReadinessReport, error) {
	if configPath == "" {
		configPath = DefaultConfigPath
	}
	config, err := LoadConfig(configPath)
	if err != nil {
		return Config{}, ReadinessReport{}, err
	}
	report, err := checkReadyConfig(configPath, config, options)
	if err != nil {
		return Config{}, report, err
	}
	return config, report, nil
}

func checkReadyConfig(configPath string, config Config, options ReadinessOptions) (ReadinessReport, error) {
	report := ReadinessReport{Mode: config.Mode, PiVersion: config.PiVersion}
	if err := config.RequireEnforcing(); err != nil {
		return report, err
	}
	paths, err := resolveReadinessPaths(options)
	if err != nil {
		return report, err
	}
	security := FileSecurityOptions{ExpectedOwnerUID: options.ExpectedOwnerUID}
	agentUID := *config.AgentUID
	if options.AgentUID != nil {
		agentUID = *options.AgentUID
	}
	requesterContextSecurity, err := requesterContextSecurity(config, agentUID)
	if err != nil {
		return report, authzError(CodeConfigInvalid, "requester context trust boundary is invalid", err)
	}

	if err := VerifySecureRegularFile(configPath, security); err != nil {
		return report, authzError(CodeConfigInvalid, "authorization config ownership or permissions are invalid", err)
	}
	if err := verifyCriticalRuntimeDirectories(paths, configPath, config, security); err != nil {
		return report, err
	}
	agentPath := options.AgentPath
	if agentPath == "" {
		agentPath = os.Getenv("PATH")
	}
	if pathListContainsDirectory(agentPath, filepath.Dir(config.RealMetricCLI.Path)) {
		return report, authzError(CodeConfigInvalid, "private Metric CLI directory must not be in PATH", nil)
	}
	state, err := readAndValidateInstallerState(paths.installerState, paths.cliManifest, paths.runtimeRoot, paths.publicMetricCLI, configPath, config, security)
	if err != nil {
		return report, err
	}
	if err := verifySelectedAgentDeployment(paths.runtimeRoot, state.Agent, security); err != nil {
		return report, err
	}
	if err := verifyMetricRuntimeConfig(paths, state, security); err != nil {
		return report, err
	}
	if err := verifyRequesterContextDirectory(config.RequesterContextDir, requesterContextSecurity, agentUID); err != nil {
		return report, authzError(CodeConfigInvalid, "requester context directory ownership or permissions are invalid", err)
	}
	realArtifact, err := VerifyArtifact(config.RealMetricCLI.Path, config.RealMetricCLI.ArtifactSHA256, true)
	if err != nil {
		return report, err
	}
	if same, err := sameRegularFile(paths.publicMetricCLI, config.RealMetricCLI.Path); err != nil || same {
		return report, authzError(CodeArtifactIntegrityFailed, "public Metric CLI and real Metric CLI are not safely separated", err)
	}
	if err := VerifySecureRegularFile(config.RealMetricCLI.Path, FileSecurityOptions{
		ExpectedOwnerUID:  options.ExpectedOwnerUID,
		RequireExecutable: true,
		Private:           true,
	}); err != nil {
		return report, authzError(CodeArtifactIntegrityFailed, "real Metric CLI ownership or permissions are invalid", err)
	}
	if err := VerifySecureDirectory(filepath.Dir(config.RealMetricCLI.Path), FileSecurityOptions{
		ExpectedOwnerUID: options.ExpectedOwnerUID,
		Private:          true,
	}); err != nil {
		return report, authzError(CodeArtifactIntegrityFailed, "real Metric CLI directory ownership or permissions are invalid", err)
	}
	if _, err := VerifyArtifact(config.ApprovedMetricCatalog.Path, config.ApprovedMetricCatalog.SHA256, false); err != nil {
		return report, err
	}
	if _, err := LoadMetricCatalog(config.ApprovedMetricCatalog.Path, config.ApprovedMetricCatalog.SHA256); err != nil {
		return report, err
	}
	if err := VerifySecureRegularFile(config.ApprovedMetricCatalog.Path, security); err != nil {
		return report, authzError(CodeArtifactIntegrityFailed, "approved metric catalog ownership or permissions are invalid", err)
	}
	if err := validateAgentVisiblePATH(agentPath, paths.publicMetricCLI, config.RealMetricCLI.ArtifactSHA256, realArtifact.Size); err != nil {
		return report, authzError(CodeConfigInvalid, "Agent-visible PATH exposes a forbidden data CLI", err)
	}
	agentEnvironment := options.AgentEnvironment
	if agentEnvironment == nil {
		agentEnvironment = os.Environ()
	}
	if err := validateAgentCLIEnvironment(agentEnvironment, paths.publicMetricCLI); err != nil {
		return report, authzError(CodeConfigInvalid, "Agent-visible data CLI environment is invalid", err)
	}
	if err := VerifySecureDirectory(filepath.Dir(config.KillSwitch.ControlPath), security); err != nil {
		return report, authzError(CodeKillSwitchActive, "authorization control directory ownership or permissions are invalid", err)
	}
	if err := VerifySecureRegularFile(config.KillSwitch.ControlPath, security); err != nil {
		return report, authzError(CodeKillSwitchActive, "authorization control ownership or permissions are invalid", err)
	}
	control, err := ReadControl(config)
	if err != nil {
		return report, err
	}
	report.ControlGeneration = control.Generation
	report.ControlUpdatedAt = control.UpdatedAt.UTC()
	if !control.Enabled() {
		return report, authzError(CodeKillSwitchActive, "authorization kill switch is disabled", nil)
	}
	report.Ready = true
	return report, nil
}

func pathListContainsDirectory(pathList, target string) bool {
	target = filepath.Clean(target)
	for _, entry := range filepath.SplitList(pathList) {
		if entry == "" {
			continue
		}
		absolute, err := filepath.Abs(entry)
		if err == nil && filepath.Clean(absolute) == target {
			return true
		}
	}
	return false
}

func validateAgentVisiblePATH(pathList, publicMetricCLI, realMetricSHA string, realMetricSize int64) error {
	if pathList == "" {
		return fmt.Errorf("PATH is empty")
	}
	seenDirectories := make(map[string]struct{})
	publicMetricCLIFound := false
	for _, entry := range filepath.SplitList(pathList) {
		if entry == "" || !filepath.IsAbs(entry) || filepath.Clean(entry) != entry {
			return fmt.Errorf("PATH contains an empty, relative, or unclean directory")
		}
		if _, duplicate := seenDirectories[entry]; duplicate {
			continue
		}
		seenDirectories[entry] = struct{}{}
		entries, err := os.ReadDir(entry)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("cannot inspect PATH directory: %w", err)
		}
		for _, candidate := range entries {
			candidatePath := filepath.Join(entry, candidate.Name())
			info, err := os.Stat(candidatePath)
			if err != nil {
				if os.IsNotExist(err) {
					continue
				}
				return fmt.Errorf("cannot inspect PATH entry: %w", err)
			}
			if !info.Mode().IsRegular() || !isExecutableMode(info.Mode(), candidate.Name()) {
				continue
			}
			name := candidate.Name()
			if runtime.GOOS == "windows" {
				name = strings.TrimSuffix(strings.ToLower(name), ".exe")
			}
			switch name {
			case "qdm-cmr-cli", "qdm-sql-cli", "cas-cli":
				return fmt.Errorf("forbidden CLI %q is executable", candidate.Name())
			case "qdm-metric-cli":
				same, sameErr := sameRegularFile(candidatePath, publicMetricCLI)
				if sameErr != nil || !same {
					return fmt.Errorf("a Metric CLI other than the public Metric CLI is executable")
				}
				publicMetricCLIFound = true
			}
			if info.Size() == realMetricSize {
				digest, digestErr := digestVisibleFile(candidatePath)
				if digestErr != nil {
					return fmt.Errorf("cannot hash PATH executable: %w", digestErr)
				}
				if digest == realMetricSHA {
					return fmt.Errorf("a copy of the private Metric CLI is executable from PATH")
				}
			}
		}
	}
	if !publicMetricCLIFound {
		return fmt.Errorf("the public Metric CLI is not executable from PATH")
	}
	return nil
}

func validateAgentCLIEnvironment(environment []string, publicMetricCLI string) error {
	const metricCLIEnv = "QDM_METRIC_CLI"
	forbidden := map[string]struct{}{
		"QDM_CMR_CLI":        {},
		"QDM_SQL_CLI":        {},
		"QDM_CAS_CLI":        {},
		"QDM_CAS_CONFIG_DIR": {},
	}
	values := make(map[string]string, len(forbidden)+1)
	for _, entry := range environment {
		name, value, ok := strings.Cut(entry, "=")
		if !ok && entry == metricCLIEnv {
			name = entry
		}
		if name != metricCLIEnv {
			if _, tracked := forbidden[name]; !tracked {
				continue
			}
		}
		if _, duplicate := values[name]; duplicate {
			return fmt.Errorf("environment contains duplicate %s", name)
		}
		values[name] = value
	}
	if values[metricCLIEnv] != publicMetricCLI {
		return fmt.Errorf("%s must point to the public Metric CLI", metricCLIEnv)
	}
	for name := range forbidden {
		if values[name] != "" {
			return fmt.Errorf("forbidden environment variable %s is non-empty", name)
		}
	}
	return nil
}

func isExecutableMode(mode fs.FileMode, name string) bool {
	if runtime.GOOS == "windows" {
		return strings.HasSuffix(strings.ToLower(name), ".exe")
	}
	return mode.Perm()&0o111 != 0
}

func digestVisibleFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

type readinessPaths struct {
	runtimeRoot         string
	installerState      string
	cliManifest         string
	publicMetricCLI     string
	publicRealMetricCLI string
	harnessConfig       string
	cliPathsEnv         string
}

func resolveReadinessPaths(options ReadinessOptions) (readinessPaths, error) {
	root := options.RuntimeRoot
	if root == "" {
		return readinessPaths{}, authzError(CodeConfigInvalid, "Harness runtime root is required for authorization readiness", nil)
	}
	if err := validateAbsoluteCleanPath(root); err != nil {
		return readinessPaths{}, authzError(CodeConfigInvalid, "Harness runtime root is invalid", err)
	}
	resolved := readinessPaths{
		runtimeRoot:         root,
		installerState:      options.InstallerStatePath,
		cliManifest:         filepath.Join(root, "bootstrap", "cli-manifest.json"),
		publicMetricCLI:     options.PublicMetricCLIPath,
		publicRealMetricCLI: filepath.Join(root, "bin", executableName("qdm-metric-cli-real")),
		harnessConfig:       options.HarnessConfigPath,
		cliPathsEnv:         options.CLIPathsEnvPath,
	}
	if resolved.installerState == "" {
		resolved.installerState = filepath.Join(root, ".harness", "installer-state.json")
	}
	if resolved.publicMetricCLI == "" {
		resolved.publicMetricCLI = filepath.Join(root, "bin", "qdm-metric-cli")
	}
	if resolved.harnessConfig == "" {
		resolved.harnessConfig = filepath.Join(root, harness.ConfigRel)
	}
	if resolved.cliPathsEnv == "" {
		resolved.cliPathsEnv = filepath.Join(root, "config", "qdm-cli-paths.env")
	}
	for _, path := range []string{resolved.installerState, resolved.cliManifest, resolved.publicMetricCLI, resolved.publicRealMetricCLI, resolved.harnessConfig, resolved.cliPathsEnv} {
		if err := validateAbsoluteCleanPath(path); err != nil {
			return readinessPaths{}, authzError(CodeConfigInvalid, "Harness runtime readiness path is invalid", err)
		}
	}
	return resolved, nil
}

func verifyCriticalRuntimeDirectories(paths readinessPaths, configPath string, config Config, security FileSecurityOptions) error {
	directories := []string{
		paths.runtimeRoot,
		filepath.Join(paths.runtimeRoot, ".harness"),
		filepath.Join(paths.runtimeRoot, "config"),
		filepath.Join(paths.runtimeRoot, "bootstrap"),
		filepath.Join(paths.runtimeRoot, "bin"),
		filepath.Dir(paths.installerState),
		filepath.Dir(paths.cliManifest),
		filepath.Dir(paths.publicMetricCLI),
		filepath.Dir(paths.harnessConfig),
		filepath.Dir(paths.cliPathsEnv),
		filepath.Dir(configPath),
		filepath.Dir(config.RealMetricCLI.Path),
		filepath.Dir(config.ApprovedMetricCatalog.Path),
		filepath.Dir(config.KillSwitch.ControlPath),
	}
	seen := make(map[string]struct{}, len(directories))
	for _, directory := range directories {
		if _, ok := seen[directory]; ok {
			continue
		}
		seen[directory] = struct{}{}
		if err := VerifySecureDirectory(directory, security); err != nil {
			return authzError(CodeConfigInvalid, "security-critical runtime directory ownership or permissions are invalid", err)
		}
	}
	return nil
}

func readAndValidateInstallerState(path, manifestPath, runtimeRoot, publicMetricCLI, configPath string, config Config, security FileSecurityOptions) (installerState, error) {
	invalid := func(message string, err error) (installerState, error) {
		return installerState{}, authzError(CodeConfigInvalid, message, err)
	}
	data, _, err := readRegularFile(path, maxInstallerStateBytes)
	if err != nil {
		return invalid("installer state cannot be read safely", err)
	}
	if err := VerifySecureRegularFile(path, security); err != nil {
		return invalid("installer state ownership or permissions are invalid", err)
	}
	var state installerState
	if err := decodeInstallerStateJSON(data, &state); err != nil {
		return invalid("installer state is invalid", err)
	}
	if state.SchemaVersion != 4 || state.Profile != ModePiRequesterAuthorized || state.Agent != "pi" {
		return invalid("installer state profile is inconsistent", nil)
	}
	updatedAt, updatedErr := time.Parse(time.RFC3339Nano, state.UpdatedAt)
	lastCheckAt, checkedErr := time.Parse(time.RFC3339Nano, state.LastCheckAt)
	if state.LastInstallDir != runtimeRoot || state.InstallMode != "github-token" ||
		validateRequiredWireString(state.RuntimeTag) != nil || len(state.LocalTools) != 0 ||
		!lowercaseSHA256Pattern.MatchString(state.ManifestSHA256) ||
		validateRequiredWireString(state.PackageVersion) != nil ||
		updatedErr != nil || updatedAt.IsZero() || checkedErr != nil || lastCheckAt.IsZero() {
		return invalid("installer state metadata is inconsistent", firstNonNil(updatedErr, checkedErr))
	}
	if state.AuthzConfigPath != "" && state.AuthzConfigPath != configPath {
		return invalid("installer state authorization config path is inconsistent", nil)
	}
	manifestData, _, err := readRegularFile(manifestPath, maxCLIManifestBytes)
	if err != nil {
		return invalid("runtime CLI manifest cannot be read safely", err)
	}
	if err := VerifySecureRegularFile(manifestPath, security); err != nil {
		return invalid("runtime CLI manifest ownership or permissions are invalid", err)
	}
	if sha256Hex(manifestData) != state.ManifestSHA256 {
		return invalid("runtime CLI manifest digest is inconsistent", nil)
	}
	if len(state.Tools) != 3 {
		return invalid("installer state contains an unexpected tool set", nil)
	}
	release := state.ReleaseSet
	if err := validateRequiredWireString(release.Key); err != nil ||
		release.Platform != currentPlatformKey() ||
		validateRequiredWireString(release.Version) != nil ||
		validateRequiredWireString(release.PublicMetricVersion) != nil ||
		!lowercaseSHA256Pattern.MatchString(release.SHA256) ||
		!lowercaseSHA256Pattern.MatchString(release.PublicMetricSHA256) ||
		release.RealMetricVersion != "v"+config.RealMetricCLI.Version ||
		release.RealMetricSHA256 != config.RealMetricCLI.ArtifactSHA256 ||
		release.CatalogSHA256 != config.ApprovedMetricCatalog.SHA256 ||
		release.AuthzSchemaVersion != config.Version ||
		release.PiVersion != config.PiVersion {
		return invalid("installer release-set is inconsistent", err)
	}
	expectedReleaseDigest, err := installerReleaseSetDigest(release)
	if err != nil || expectedReleaseDigest != release.SHA256 {
		return invalid("installer release-set digest is inconsistent", err)
	}
	publicMetricTool, ok := state.Tools["qdm-metric-cli"]
	if !ok || !validInstallerTool(publicMetricTool) || publicMetricTool.Version != release.PublicMetricVersion || publicMetricTool.SHA256 != release.PublicMetricSHA256 || publicMetricTool.Destination != publicMetricCLI {
		return invalid("installed Metric CLI state is inconsistent", nil)
	}
	real, ok := state.Tools["qdm-metric-cli-real"]
	if !ok || !validInstallerTool(real) || real.Version != release.RealMetricVersion || real.SHA256 != release.RealMetricSHA256 || real.Destination != config.RealMetricCLI.Path {
		return invalid("installed real Metric CLI state is inconsistent", nil)
	}
	helper, ok := state.Tools["data-harness-cli"]
	helperPath := filepath.Join(runtimeRoot, "bin", executableName("data-harness-cli"))
	if !ok || !validInstallerTool(helper) || helper.Destination != helperPath {
		return invalid("installed Harness helper state is inconsistent", nil)
	}
	return state, nil
}

func verifySelectedAgentDeployment(runtimeRoot, agent string, security FileSecurityOptions) error {
	if agent != "pi" {
		return authzError(CodeConfigInvalid, "selected Agent deployment is unsupported", nil)
	}
	source := filepath.Join(runtimeRoot, "agents", "pi")
	target := filepath.Join(runtimeRoot, ".pi")
	if err := VerifySecureDirectory(filepath.Join(runtimeRoot, "agents"), security); err != nil {
		return authzError(CodeConfigInvalid, "Agent template root ownership or permissions are invalid", err)
	}
	if err := VerifySecureDirectory(source, security); err != nil {
		return authzError(CodeConfigInvalid, "selected Agent template ownership or permissions are invalid", err)
	}
	targetInfo, err := os.Lstat(target)
	if err != nil || targetInfo.Mode()&os.ModeSymlink == 0 {
		return authzError(CodeConfigInvalid, "selected Agent deployment link is missing or invalid", err)
	}
	resolvedSource, sourceErr := filepath.EvalSymlinks(source)
	resolvedTarget, targetErr := filepath.EvalSymlinks(target)
	if sourceErr != nil || targetErr != nil || filepath.Clean(resolvedSource) != filepath.Clean(resolvedTarget) {
		return authzError(
			CodeConfigInvalid,
			"selected Agent deployment link does not resolve to its template",
			firstNonNil(sourceErr, targetErr),
		)
	}
	for _, relative := range []string{"settings.json", filepath.Join("extensions", "qdm-harness", "index.ts")} {
		path := filepath.Join(source, relative)
		if err := VerifySecureRegularFile(path, security); err != nil {
			return authzError(CodeConfigInvalid, "selected Agent deployment is incomplete or insecure", err)
		}
	}
	if err := validateSelectedAgentConfig(source); err != nil {
		return authzError(CodeConfigInvalid, "selected Agent authorization Hook config is invalid", err)
	}
	return nil
}

func validateSelectedAgentConfig(source string) error {
	data, _, err := readRegularFile(filepath.Join(source, "settings.json"), maxAgentConfigBytes)
	if err != nil {
		return err
	}
	var settings piAgentSettings
	if err := decodeStrictJSON(data, &settings); err != nil {
		return err
	}
	if !settings.EnableSkillCommands ||
		len(settings.Extensions) != 1 || settings.Extensions[0] != ".pi/extensions/qdm-harness/index.ts" ||
		len(settings.Skills) != 1 || settings.Skills[0] != ".pi/skills" {
		return fmt.Errorf("Pi extension settings do not match the authorization contract")
	}
	return nil
}

func validInstallerTool(tool installerTool) bool {
	return validateRequiredWireString(tool.Version) == nil &&
		validateRequiredWireString(tool.Asset) == nil &&
		lowercaseSHA256Pattern.MatchString(tool.SHA256) &&
		lowercaseSHA256Pattern.MatchString(tool.AssetSHA256) &&
		validateAbsoluteCleanPath(tool.Destination) == nil
}

func executableName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func firstNonNil(errors ...error) error {
	for _, err := range errors {
		if err != nil {
			return err
		}
	}
	return nil
}

func decodeInstallerStateJSON(data []byte, target *installerState) error {
	return decodeStrictJSON(data, target)
}

func installerReleaseSetDigest(release installerReleaseSet) (string, error) {
	input := releaseSetDigestInput{
		Platform:            release.Platform,
		Version:             release.Version,
		PublicMetricVersion: release.PublicMetricVersion,
		PublicMetricSHA256:  release.PublicMetricSHA256,
		RealMetricVersion:   release.RealMetricVersion,
		RealMetricSHA256:    release.RealMetricSHA256,
		CatalogSHA256:       release.CatalogSHA256,
		AuthzSchemaVersion:  release.AuthzSchemaVersion,
		PiVersion:           release.PiVersion,
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func currentPlatformKey() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

func verifyMetricRuntimeConfig(paths readinessPaths, state installerState, security FileSecurityOptions) error {
	release := state.ReleaseSet
	if _, err := os.Lstat(paths.publicRealMetricCLI); err == nil || !os.IsNotExist(err) {
		return authzError(CodeConfigInvalid, "private Metric CLI is present in the authorized runtime bin directory", err)
	}
	if _, err := VerifyArtifact(paths.publicMetricCLI, release.PublicMetricSHA256, true); err != nil {
		return err
	}
	if err := VerifySecureRegularFile(paths.publicMetricCLI, FileSecurityOptions{
		ExpectedOwnerUID:  security.ExpectedOwnerUID,
		RequireExecutable: true,
	}); err != nil {
		return authzError(CodeArtifactIntegrityFailed, "Metric CLI ownership or permissions are invalid", err)
	}
	for _, directory := range []string{
		filepath.Dir(paths.publicMetricCLI), filepath.Dir(state.Tools["data-harness-cli"].Destination),
	} {
		if err := VerifySecureDirectory(directory, security); err != nil {
			return authzError(CodeConfigInvalid, "Harness executable directory ownership or permissions are invalid", err)
		}
	}
	helper := state.Tools["data-harness-cli"]
	if _, err := VerifyArtifact(helper.Destination, helper.SHA256, true); err != nil {
		return err
	}
	if err := VerifySecureRegularFile(helper.Destination, FileSecurityOptions{
		ExpectedOwnerUID: security.ExpectedOwnerUID, RequireExecutable: true,
	}); err != nil {
		return authzError(CodeArtifactIntegrityFailed, "Harness helper ownership or permissions are invalid", err)
	}
	if err := VerifySecureRegularFile(paths.harnessConfig, security); err != nil {
		return authzError(CodeConfigInvalid, "Harness config ownership or permissions are invalid", err)
	}
	rootConfig, err := harness.LoadConfig(paths.runtimeRoot)
	if err != nil || rootConfig.CLI.QDMMetricCLI != paths.publicMetricCLI {
		return authzError(CodeConfigInvalid, "Harness CLI config does not select only the public Metric CLI", err)
	}
	if err := VerifySecureRegularFile(paths.cliPathsEnv, security); err != nil {
		return authzError(CodeConfigInvalid, "Harness CLI environment config ownership or permissions are invalid", err)
	}
	if err := validateCLIPathsEnv(paths.cliPathsEnv, paths.publicMetricCLI); err != nil {
		return authzError(CodeConfigInvalid, "Harness CLI environment config does not select only the public Metric CLI", err)
	}
	for _, name := range []string{"qdm-cmr-cli", "qdm-sql-cli", "cas-cli"} {
		path := filepath.Join(paths.runtimeRoot, "bin", executableName(name))
		if _, err := os.Lstat(path); err == nil || !os.IsNotExist(err) {
			return authzError(CodeConfigInvalid, "forbidden data CLI is present in the authorized runtime", err)
		}
	}
	return nil
}

func validateCLIPathsEnv(path, expectedMetricCLI string) error {
	data, _, err := readRegularFile(path, maxHarnessConfigBytes)
	if err != nil {
		return err
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	values := make(map[string]string)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		matches := envExportPattern.FindStringSubmatch(line)
		if len(matches) != 3 {
			return fmt.Errorf("unsupported environment config line")
		}
		if _, duplicate := values[matches[1]]; duplicate {
			return fmt.Errorf("duplicate environment config key")
		}
		values[matches[1]] = matches[2]
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if len(values) != 1 || values["QDM_METRIC_CLI"] != expectedMetricCLI {
		return fmt.Errorf("environment config path mismatch")
	}
	return nil
}

// VerifySecureRegularFile checks an absolute, clean, nonsymlink regular file,
// root ownership by default, and deployment-safe mode bits.
func VerifySecureRegularFile(path string, options FileSecurityOptions) error {
	if err := validateAbsoluteCleanPath(path); err != nil {
		return err
	}
	file, info, err := openRegularFile(path)
	if err != nil {
		return err
	}
	_ = file.Close()
	if options.RequireExecutable && info.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("file is not executable")
	}
	if err := checkOwner(info, expectedOwnerUID(options.ExpectedOwnerUID)); err != nil {
		return err
	}
	if err := checkGroup(info, options.ExpectedGroupGID); err != nil {
		return err
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("file is group or world writable")
	}
	if options.Private && info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("private file is accessible by group or world")
	}
	return nil
}

// VerifySecureDirectory applies the corresponding owner/mode checks to an
// absolute, clean, nonsymlink directory.
func VerifySecureDirectory(path string, options FileSecurityOptions) error {
	if err := validateAbsoluteCleanPath(path); err != nil {
		return err
	}
	if err := rejectSymlinkPathComponents(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("path is not a safe directory")
	}
	if err := checkOwner(info, expectedOwnerUID(options.ExpectedOwnerUID)); err != nil {
		return err
	}
	if err := checkGroup(info, options.ExpectedGroupGID); err != nil {
		return err
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("directory is group or world writable")
	}
	if options.Private && info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("private directory is accessible by group or world")
	}
	return nil
}

func expectedOwnerUID(configured *uint32) uint32 {
	if configured == nil {
		return 0
	}
	return *configured
}

func checkOwner(info fs.FileInfo, expected uint32) error {
	owner, available := fileOwnerUID(info)
	if available && owner != expected {
		return fmt.Errorf("owner does not match")
	}
	return nil
}

func checkGroup(info fs.FileInfo, expected *uint32) error {
	if expected == nil {
		return nil
	}
	group, available := fileGroupGID(info)
	if !available {
		return fmt.Errorf("group ownership is unavailable")
	}
	if group != *expected {
		return fmt.Errorf("group does not match")
	}
	return nil
}

func sameRegularFile(leftPath, rightPath string) (bool, error) {
	left, err := os.Stat(leftPath)
	if err != nil {
		return false, err
	}
	right, err := os.Stat(rightPath)
	if err != nil {
		return false, err
	}
	return os.SameFile(left, right), nil
}
