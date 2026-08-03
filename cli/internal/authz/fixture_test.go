package authz

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type authzFixture struct {
	root               string
	configPath         string
	installerStatePath string
	cliManifestPath    string
	contextDir         string
	controlPath        string
	realCLIPath        string
	publicMetricPath   string
	dataHarnessPath    string
	catalogPath        string
	harnessConfigPath  string
	cliPathsEnvPath    string
	config             Config
	now                time.Time
	ownerUID           uint32
	readerGID          uint32
	agentUID           uint32
	sessionID          string
	installerAgent     string
	envelope           Envelope
}

func newAuthzFixture(t *testing.T) *authzFixture {
	t.Helper()
	rawRoot := t.TempDir()
	root, err := filepath.EvalSymlinks(rawRoot)
	if err != nil {
		t.Fatal(err)
	}
	contextRoot := filepath.Join(root, "requester-context")
	contextDir := filepath.Join(contextRoot, "workspace-1", "pi")
	for _, directory := range []string{
		filepath.Join(root, ".harness"),
		filepath.Join(root, "agents"),
		filepath.Join(root, "bin"),
		filepath.Join(root, "bootstrap"),
		filepath.Join(root, "config"),
		contextRoot,
		filepath.Join(root, "private"),
		filepath.Join(root, "secrets"),
		filepath.Join(root, "control"),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(contextDir, 0o710); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(contextDir, 0o710); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{contextRoot, filepath.Dir(contextDir)} {
		if err := os.Chmod(directory, 0o710); err != nil {
			t.Fatal(err)
		}
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	ownerUID, available := fileOwnerUID(rootInfo)
	if !available {
		ownerUID = 0
	}

	fixture := &authzFixture{
		root:               root,
		configPath:         filepath.Join(root, "authz.json"),
		installerStatePath: filepath.Join(root, ".harness", "installer-state.json"),
		cliManifestPath:    filepath.Join(root, "bootstrap", "cli-manifest.json"),
		contextDir:         contextDir,
		controlPath:        filepath.Join(root, "control", "authz-state.json"),
		realCLIPath:        filepath.Join(root, "private", "qdm-metric-cli-v0.1.0"),
		publicMetricPath:   filepath.Join(root, "bin", "qdm-metric-cli"),
		dataHarnessPath:    filepath.Join(root, "bin", executableName("data-harness-cli")),
		catalogPath:        filepath.Join(root, "approved-metrics-v1.json"),
		harnessConfigPath:  filepath.Join(root, "config", "harness-config.yaml"),
		cliPathsEnvPath:    filepath.Join(root, "config", "qdm-cli-paths.env"),
		now:                time.Date(2026, 7, 30, 4, 0, 0, 0, time.UTC),
		ownerUID:           ownerUID,
		readerGID:          currentTestGroupGID(rootInfo),
		agentUID:           distinctTestUID(ownerUID),
		sessionID:          "acp-session-原始值",
		installerAgent:     "pi",
	}
	for _, directory := range []string{contextRoot, filepath.Dir(fixture.contextDir), fixture.contextDir} {
		fixture.setContextGroup(t, directory)
	}
	controlDirectory := filepath.Dir(fixture.controlPath)
	if err := os.Chmod(controlDirectory, 0o710); err != nil {
		t.Fatal(err)
	}
	fixture.setContextGroup(t, controlDirectory)

	writeTestFile(t, fixture.realCLIPath, []byte("#!/bin/sh\nexit 0\n"), 0o700)
	writeTestFile(t, fixture.publicMetricPath, []byte("#!/bin/sh\nexit 17\n"), 0o700)
	writeTestFile(t, fixture.dataHarnessPath, []byte("#!/bin/sh\nexit 23\n"), 0o700)
	writeTestFile(t, fixture.cliManifestPath, []byte("{\"schemaVersion\":3,\"profile\":\"pi-requester-authorized\"}\n"), 0o600)
	catalogData := []byte(`{"version":1,"generatedFrom":"qdm-metric-cli-v0.1.0-contract","metrics":{"saleAmt":{"supportedDimensions":["manageAreaId","categoryLevel1Id"],"dictionaryRefs":[]}}}`)
	writeTestFile(t, fixture.catalogPath, catalogData, 0o600)
	writeTestJSON(t, fixture.controlPath, ControlState{
		Version: CurrentVersion, Generation: 7, State: "enabled", UpdatedAt: fixture.now.Add(-time.Minute),
	}, 0o640)
	fixture.setContextGroup(t, fixture.controlPath)

	fixture.config = Config{
		Version:                     CurrentVersion,
		Mode:                        ModePiRequesterAuthorized,
		PiVersion:                   RequiredPiVersion,
		AgentUID:                    &fixture.agentUID,
		RequesterContextDir:         fixture.contextDir,
		RequesterContextWorkspaceID: "workspace-1",
		RequesterContextAgentID:     "pi",
		RequesterContextOwnerUID:    &fixture.ownerUID,
		RequesterContextReaderGID:   &fixture.readerGID,
		MaxEnvelopeBytes:            64 << 10,
		MaxEnvelopeTTLSeconds:       1800,
		ClockSkewSeconds:            30,
		RealMetricCLI: RealMetricCLIConfig{
			Path:           fixture.realCLIPath,
			Version:        "0.1.7",
			ArtifactSHA256: sha256Hex([]byte("#!/bin/sh\nexit 0\n")),
		},
		ApprovedMetricCatalog: ArtifactConfig{
			Path: fixture.catalogPath, SHA256: sha256Hex(catalogData),
		},
		KillSwitch: KillSwitchConfig{ControlPath: fixture.controlPath, PollMilliseconds: 1000},
		Limits: LimitsConfig{
			MaxDateRangeDays: 31, MaxMetrics: 10, MaxDimensions: 10,
			DefaultPageSize: 200, MaxPageSize: 1000,
			DefaultMetadataLimit: 100, MaxMetadataLimit: 500,
			TimeoutSeconds: 120, MaxOutputBytes: 2 << 20,
		},
	}
	fixture.writeConfig(t)

	writeTestFile(t, fixture.harnessConfigPath, []byte(
		"paths:\n  knowledge: wikis\n\ncli:\n  qdm_metric_cli: "+fixture.publicMetricPath+"\n",
	), 0o600)
	writeTestFile(t, fixture.cliPathsEnvPath, []byte(
		"export QDM_METRIC_CLI=\""+fixture.publicMetricPath+"\"\n",
	), 0o600)
	fixture.writeInstallerState(t)

	scope := Scope{
		ManageAreaIDs: []string{"CN07", "CN08"}, DCManageAreaIDs: []string{"CN07"},
		CategoryLevel1IDs: []string{"12", "13"},
	}
	fixture.envelope = Envelope{
		Version:     CurrentEnvelopeVersion,
		WorkspaceID: "workspace-1",
		AgentID:     "pi",
		SessionID:   fixture.sessionID,
		IssuedAt:    fixture.now.Add(-time.Minute),
		ExpiresAt:   fixture.now.Add(29 * time.Minute),
		RequesterContext: RequesterContext{
			Version:        CurrentRequesterContextVersion,
			RequestID:      "request-1",
			PolicyRevision: "sha256:" + string(make([]byte, 0)),
			Principal: Principal{
				Channel: "wecom", BotID: "bot-1", CanonicalUserID: "user-1", DisplayName: "用户一",
			},
			Audience: Audience{ChatID: "chat-1", ChatType: "group"},
			Authorization: Authorization{
				Capabilities: []string{CapabilityMetricQuery},
				Claims:       NewQDMScopeClaims(scope),
				Scope:        scope,
			},
		},
	}
	fixture.envelope.RequesterContext.PolicyRevision = "sha256:" + repeatTestString("a", 64)
	fixture.writeEnvelope(t, fixture.envelope)
	return fixture
}

func (fixture *authzFixture) readinessOptions() ReadinessOptions {
	owner := fixture.ownerUID
	agent := fixture.agentUID
	return ReadinessOptions{
		ExpectedOwnerUID: &owner,
		AgentUID:         &agent,
		RuntimeRoot:      fixture.root,
		AgentPath:        filepath.Join(fixture.root, "bin"),
		AgentEnvironment: []string{"QDM_METRIC_CLI=" + fixture.publicMetricPath},
		Now:              fixture.now,
	}
}

func (fixture *authzFixture) writeEnvelope(t *testing.T, envelope Envelope) string {
	t.Helper()
	name, err := SessionFileName(fixture.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(fixture.contextDir, name)
	writeTestJSON(t, path, envelope, 0o640)
	fixture.setContextGroup(t, path)
	return path
}

func (fixture *authzFixture) writeConfig(t *testing.T) {
	t.Helper()
	writeTestJSON(t, fixture.configPath, fixture.config, 0o640)
	fixture.setContextGroup(t, fixture.configPath)
}

func (fixture *authzFixture) replaceScope(scope Scope) {
	fixture.envelope.RequesterContext.Authorization.Scope = scope
	fixture.envelope.RequesterContext.Authorization.Claims = NewQDMScopeClaims(scope)
}

func (fixture *authzFixture) readOptions() []ReadOption {
	return []ReadOption{WithNow(fixture.now), WithAgentUID(fixture.agentUID)}
}

func distinctTestUID(owner uint32) uint32 {
	if owner == ^uint32(0) {
		return owner - 1
	}
	return owner + 1
}

func currentTestGroupGID(info os.FileInfo) uint32 {
	gid, available := fileGroupGID(info)
	if !available {
		return 1
	}
	if gid == 0 {
		return 1
	}
	return gid
}

func (fixture *authzFixture) setContextGroup(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if gid, available := fileGroupGID(info); available && gid == fixture.readerGID {
		return
	}
	if err := os.Chown(path, -1, int(fixture.readerGID)); err != nil {
		t.Fatal(err)
	}
}

func (fixture *authzFixture) setRequesterContextScope(t *testing.T, workspaceID string) {
	t.Helper()
	fixture.contextDir = filepath.Join(fixture.root, "requester-context", workspaceID, "pi")
	if err := os.MkdirAll(fixture.contextDir, 0o710); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(fixture.contextDir, 0o710); err != nil {
		t.Fatal(err)
	}
	workspaceDir := filepath.Dir(fixture.contextDir)
	if err := os.Chmod(workspaceDir, 0o710); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{filepath.Dir(workspaceDir), workspaceDir, fixture.contextDir} {
		fixture.setContextGroup(t, directory)
	}
	fixture.config.RequesterContextDir = fixture.contextDir
	fixture.config.RequesterContextWorkspaceID = workspaceID
}

func (fixture *authzFixture) writeInstallerState(t *testing.T) {
	t.Helper()
	fixture.writeAgentDeployment(t)
	manifestData, err := os.ReadFile(fixture.cliManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	release := installerReleaseSet{
		Key:                 "pi-requester-v1",
		Platform:            currentPlatformKey(),
		Version:             "pi-requester-v1",
		PublicMetricVersion: "1.0.0",
		PublicMetricSHA256:  sha256Hex([]byte("#!/bin/sh\nexit 17\n")),
		RealMetricVersion:   "v" + fixture.config.RealMetricCLI.Version,
		RealMetricSHA256:    fixture.config.RealMetricCLI.ArtifactSHA256,
		CatalogSHA256:       fixture.config.ApprovedMetricCatalog.SHA256,
		AuthzSchemaVersion:  CurrentVersion,
		PiVersion:           RequiredPiVersion,
	}
	digest, err := installerReleaseSetDigest(release)
	if err != nil {
		t.Fatal(err)
	}
	release.SHA256 = digest
	state := installerState{
		LastInstallDir: fixture.root,
		UpdatedAt:      fixture.now.Add(-time.Minute).Format(time.RFC3339Nano),
		SchemaVersion:  3,
		Profile:        ModePiRequesterAuthorized,
		Agent:          fixture.installerAgent,
		InstallMode:    "github-token",
		RuntimeTag:     "v1.0.0",
		LocalTools:     map[string]json.RawMessage{},
		Tools: map[string]installerTool{
			"qdm-metric-cli": {
				Version: release.PublicMetricVersion, Asset: "qdm-metric-cli.tar.gz", SHA256: release.PublicMetricSHA256,
				AssetSHA256: repeatTestString("1", 64), Destination: fixture.publicMetricPath,
			},
			"qdm-metric-cli-real": {
				Version: release.RealMetricVersion, Asset: "qdm-metric-cli.tar.gz", SHA256: release.RealMetricSHA256,
				AssetSHA256: repeatTestString("2", 64), Destination: fixture.realCLIPath,
			},
			"data-harness-cli": {
				Version: "v1.0.0", Asset: "data-harness-cli.tar.gz", SHA256: sha256Hex([]byte("#!/bin/sh\nexit 23\n")),
				AssetSHA256: repeatTestString("3", 64), Destination: fixture.dataHarnessPath,
			},
		},
		ManifestSHA256:  sha256Hex(manifestData),
		PackageVersion:  "0.0.27",
		ReleaseSet:      release,
		AuthzConfigPath: fixture.configPath,
		LastCheckAt:     fixture.now.Format(time.RFC3339Nano),
	}
	writeTestJSON(t, fixture.installerStatePath, state, 0o600)
}

func (fixture *authzFixture) writeAgentDeployment(t *testing.T) {
	t.Helper()
	for _, agent := range []string{"pi", "claude", "codex", "openclaw"} {
		if err := os.RemoveAll(filepath.Join(fixture.root, "."+agent)); err != nil {
			t.Fatal(err)
		}
	}
	source := filepath.Join(fixture.root, "agents", "pi")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	writeTestJSON(t, filepath.Join(source, "settings.json"), piAgentSettings{
		EnableSkillCommands: true,
		Extensions:          []string{".pi/extensions/qdm-harness/index.ts"},
		Skills:              []string{".pi/skills"},
	}, 0o600)
	writeTestFile(t, filepath.Join(source, "extensions", "qdm-harness", "index.ts"), []byte("export {};\n"), 0o600)
	if err := os.Symlink(filepath.Join("agents", "pi"), filepath.Join(fixture.root, ".pi")); err != nil {
		t.Fatal(err)
	}
}

func writeTestJSON(t *testing.T, path string, value any, mode os.FileMode) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path, data, mode)
}

func writeTestFile(t *testing.T, path string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func repeatTestString(value string, count int) string {
	result := ""
	for range count {
		result += value
	}
	return result
}
