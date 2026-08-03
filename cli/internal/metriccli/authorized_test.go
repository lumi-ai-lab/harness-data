package metriccli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"harness-data/cli/internal/authz"
)

type wrapperFixture struct {
	root        string
	configPath  string
	controlPath string
	contextDir  string
	realCLIPath string
	catalogPath string
	sessionID   string
	now         time.Time
	ownerUID    uint32
	readerGID   uint32
	agentUID    uint32
	config      authz.Config
}

func newWrapperFixture(t *testing.T) *wrapperFixture {
	t.Helper()
	rawRoot := t.TempDir()
	root, err := filepath.EvalSymlinks(rawRoot)
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{
		"control", filepath.Join("requester-context", "workspace-1", "pi"), "private",
	} {
		if err := os.MkdirAll(filepath.Join(root, directory), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	contextDir := filepath.Join(root, "requester-context", "workspace-1", "pi")
	for _, directory := range []string{filepath.Join(root, "requester-context"), filepath.Dir(contextDir), contextDir} {
		if err := os.Chmod(directory, 0o710); err != nil {
			t.Fatal(err)
		}
	}
	ownerUID := currentTestUID()
	readerGID := currentTestGID()
	for _, directory := range []string{filepath.Join(root, "requester-context"), filepath.Dir(contextDir), contextDir} {
		setTestGroup(t, directory, readerGID)
	}

	fixture := &wrapperFixture{
		root:        root,
		configPath:  filepath.Join(root, "authz.json"),
		controlPath: filepath.Join(root, "control", "authz-state.json"),
		contextDir:  contextDir,
		realCLIPath: filepath.Join(root, "private", "qdm-metric-cli-v0.1.0"),
		catalogPath: filepath.Join(root, "approved-metrics-v1.json"),
		sessionID:   "acp-session-metric-cli",
		now:         time.Now().UTC().Truncate(time.Second),
		ownerUID:    ownerUID,
		readerGID:   readerGID,
		agentUID:    distinctWrapperTestUID(ownerUID),
	}
	fixture.writeRealCLI(t, "#!/bin/sh\nprintf 'argc=%s\\n' \"$#\"\nfor arg in \"$@\"; do printf 'arg=%s\\n' \"$arg\"; done\n")
	catalog := []byte(`{"version":1,"generatedFrom":"qdm-metric-cli-v0.1.0-contract","metrics":{"saleAmt":{"supportedDimensions":["manageAreaId","categoryLevel1Id"],"dictionaryRefs":[]}}}`)
	writeFile(t, fixture.catalogPath, catalog, 0o600)
	writeJSON(t, fixture.controlPath, authz.ControlState{
		Version: authz.CurrentVersion, Generation: 1, State: "enabled",
		UpdatedAt: fixture.now.Add(-time.Minute),
	}, 0o600)

	fixture.config = authz.Config{
		Version:                     authz.CurrentVersion,
		Mode:                        authz.ModeLumiMVPRequired,
		PiVersion:                   authz.RequiredPiVersion,
		AgentUID:                    &fixture.agentUID,
		RequesterContextDir:         fixture.contextDir,
		RequesterContextWorkspaceID: "workspace-1",
		RequesterContextAgentID:     "pi",
		RequesterContextOwnerUID:    &fixture.ownerUID,
		RequesterContextReaderGID:   &fixture.readerGID,
		MaxEnvelopeBytes:            64 << 10,
		MaxEnvelopeTTLSeconds:       1800,
		ClockSkewSeconds:            30,
		RealMetricCLI: authz.RealMetricCLIConfig{
			Path:           fixture.realCLIPath,
			Version:        "0.1.0",
			ArtifactSHA256: fileSHA256(fixture.realCLIPath),
		},
		ApprovedMetricCatalog: authz.ArtifactConfig{
			Path: fixture.catalogPath, SHA256: fileSHA256(fixture.catalogPath),
		},
		KillSwitch: authz.KillSwitchConfig{
			ControlPath: fixture.controlPath, PollMilliseconds: 100,
		},
		Limits: authz.LimitsConfig{
			MaxDateRangeDays: 31, MaxMetrics: 10, MaxDimensions: 10,
			DefaultPageSize: 200, MaxPageSize: 1000,
			DefaultMetadataLimit: 100, MaxMetadataLimit: 500,
			TimeoutSeconds: 2, MaxOutputBytes: 1 << 20,
		},
	}
	fixture.writeConfig(t)
	fixture.writeEnvelope(t, fixture.now.Add(10*time.Minute), "request-1")
	return fixture
}

func (fixture *wrapperFixture) writeConfig(t *testing.T) {
	t.Helper()
	writeJSON(t, fixture.configPath, fixture.config, 0o600)
}

func (fixture *wrapperFixture) writeRealCLI(t *testing.T, body string) {
	t.Helper()
	writeFile(t, fixture.realCLIPath, []byte(body), 0o700)
}

func (fixture *wrapperFixture) writeEnvelope(t *testing.T, expiresAt time.Time, requestID string) {
	t.Helper()
	scope := authz.Scope{
		ManageAreaIDs:     []string{"CN07", "CN08"},
		CategoryLevel1IDs: []string{"12", "13"},
	}
	envelope := authz.Envelope{
		Version:     authz.CurrentEnvelopeVersion,
		WorkspaceID: "workspace-1",
		AgentID:     "pi",
		SessionID:   fixture.sessionID,
		IssuedAt:    fixture.now.Add(-time.Minute),
		ExpiresAt:   expiresAt,
		RequesterContext: authz.RequesterContext{
			Version:        authz.CurrentRequesterContextVersion,
			RequestID:      requestID,
			PolicyRevision: "sha256:" + strings.Repeat("a", 64),
			Principal: authz.Principal{
				Channel: "wecom", BotID: "bot-1", CanonicalUserID: "user-1",
			},
			Audience: authz.Audience{ChatID: "chat-1", ChatType: "group"},
			Authorization: authz.Authorization{
				Capabilities: []string{authz.CapabilityMetricQuery},
				Claims:       authz.NewQDMScopeClaims(scope),
				Scope:        scope,
			},
		},
	}
	name, err := authz.SessionFileName(fixture.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(fixture.contextDir, name)
	writeJSON(t, path, envelope, 0o640)
	setTestGroup(t, path, fixture.readerGID)
}

func setTestGroup(t *testing.T, path string, expected uint32) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if currentTestFileGID(info) == expected {
		return
	}
	if err := os.Chown(path, -1, int(expected)); err != nil {
		t.Fatal(err)
	}
}

func (fixture *wrapperFixture) binding(t *testing.T) string {
	t.Helper()
	result, err := authz.Bind(
		fixture.config,
		fixture.sessionID,
		authz.WithNow(fixture.now),
		authz.WithAgentUID(fixture.agentUID),
	)
	if err != nil {
		t.Fatal(err)
	}
	return result.BindingBase64URL
}

func (fixture *wrapperFixture) catalog(t *testing.T) authz.MetricCatalog {
	t.Helper()
	catalog, err := authz.LoadMetricCatalog(
		fixture.config.ApprovedMetricCatalog.Path,
		fixture.config.ApprovedMetricCatalog.SHA256,
	)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func (fixture *wrapperFixture) run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var output strings.Builder
	err := runAuthorized(
		fixture.configPath,
		strings.TrimSpace(os.Getenv(bindingEnvironment)),
		&fixture.agentUID,
		args,
		strings.NewReader(""),
		&output,
		&output,
	)
	return output.String(), err
}

func distinctWrapperTestUID(owner uint32) uint32 {
	if owner == ^uint32(0) {
		return owner - 1
	}
	return owner + 1
}

func writeFile(t *testing.T, path string, content []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, content, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func writeJSON(t *testing.T, path string, value any, mode os.FileMode) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, data, mode)
}

func fileSHA256(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestRunRequiresAndValidatesBinding(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*wrapperFixture, *testing.T) string
		code   authz.Code
	}{
		{
			name: "missing",
			mutate: func(fixture *wrapperFixture, _ *testing.T) string {
				return ""
			},
			code: authz.CodeBindingMissing,
		},
		{
			name: "invalid",
			mutate: func(_ *wrapperFixture, _ *testing.T) string {
				return "not-a-binding"
			},
			code: authz.CodeBindingInvalid,
		},
		{
			name: "expired",
			mutate: func(fixture *wrapperFixture, t *testing.T) string {
				binding, err := authz.DecodeBinding(fixture.binding(t))
				if err != nil {
					t.Fatal(err)
				}
				binding.ExpiresAt = fixture.now.Add(-time.Minute)
				encoded, err := authz.EncodeBinding(binding)
				if err != nil {
					t.Fatal(err)
				}
				return encoded
			},
			code: authz.CodeRequesterContextExpired,
		},
		{
			name: "context mismatch",
			mutate: func(fixture *wrapperFixture, t *testing.T) string {
				encoded := fixture.binding(t)
				fixture.writeEnvelope(t, fixture.now.Add(10*time.Minute), "request-2")
				return encoded
			},
			code: authz.CodeBindingMismatch,
		},
		{
			name: "kill switch",
			mutate: func(fixture *wrapperFixture, t *testing.T) string {
				binding := fixture.binding(t)
				writeJSON(t, fixture.controlPath, authz.ControlState{
					Version: authz.CurrentVersion, Generation: 2, State: "disabled",
					UpdatedAt: fixture.now,
				}, 0o600)
				return binding
			},
			code: authz.CodeKillSwitchActive,
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newWrapperFixture(t)
			t.Setenv(bindingEnvironment, testCase.mutate(fixture, t))
			_, err := fixture.run(t, "version")
			if err == nil {
				t.Fatal("expected authorization failure")
			}
			if got := authz.ErrorCode(errors.Unwrap(err)); got != "" {
				t.Fatalf("unexpected wrapped authz code %s", got)
			}
			var exitErr *ExitError
			if !errors.As(err, &exitErr) || exitErr.Code != 77 {
				t.Fatalf("expected exit code 77, got %v", err)
			}
			if !strings.Contains(err.Error(), string(testCase.code)) {
				t.Fatalf("expected %s in %q", testCase.code, err)
			}
		})
	}
}

func TestRunAuthorizedRequiresConfiguredAgentPeerUID(t *testing.T) {
	fixture := newWrapperFixture(t)
	binding := fixture.binding(t)

	for name, peerUID := range map[string]uint32{
		"requester context writer": fixture.ownerUID,
		"unrelated local user":     distinctWrapperTestUID(fixture.agentUID),
		"root":                     0,
	} {
		t.Run(name, func(t *testing.T) {
			var output strings.Builder
			err := runAuthorized(
				fixture.configPath,
				binding,
				&peerUID,
				[]string{"version"},
				strings.NewReader(""),
				&output,
				&output,
			)
			if err == nil || !strings.Contains(err.Error(), string(authz.CodeRequesterContextInvalid)) {
				t.Fatalf("expected requester-context denial for peer UID %d, got %v", peerUID, err)
			}
		})
	}
}

func TestDirectAuthorizedRuntimeCannotReplaceBrokerPeerAuthentication(t *testing.T) {
	fixture := newWrapperFixture(t)
	t.Setenv(bindingEnvironment, fixture.binding(t))
	var output strings.Builder
	err := RunWithConfig(
		fixture.configPath,
		[]string{"version"},
		strings.NewReader(""),
		&output,
		&output,
	)
	if err == nil || !strings.Contains(err.Error(), string(authz.CodeRequesterContextInvalid)) {
		t.Fatalf("expected direct runtime caller to be rejected, got %v", err)
	}
}

func TestAuthorizeAnalysisScopeAndPayload(t *testing.T) {
	fixture := newWrapperFixture(t)
	scope := authorizationScope{
		ManageAreaIDs:     []string{"CN07", "CN08"},
		CategoryLevel1IDs: []string{"12", "13"},
	}
	catalog := fixture.catalog(t)
	authzScope := authz.Scope{
		ManageAreaIDs: scope.ManageAreaIDs, CategoryLevel1IDs: scope.CategoryLevel1IDs,
	}

	t.Run("injects missing protected filters", func(t *testing.T) {
		args, err := authorizeArguments(
			[]string{"analysis", "validate", "--payload-json", `{"metrics":["saleAmt"]}`},
			authzScope,
			10,
			catalog,
		)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(strings.Join(args, " "), `"manageAreaId":["CN07","CN08"]`) ||
			!strings.Contains(strings.Join(args, " "), `"categoryLevel1Id":["12","13"]`) {
			t.Fatalf("protected filters were not injected: %v", args)
		}
	})

	t.Run("rejects payload file form before the root broker reads it", func(t *testing.T) {
		payloadPath := filepath.Join(fixture.root, "request.json")
		writeFile(t, payloadPath, []byte(`{"metrics":["saleAmt"]}`), 0o600)
		_, err := authorizeArguments(
			[]string{"analysis", "validate", "--payload=" + payloadPath},
			authzScope,
			10,
			catalog,
		)
		if err == nil || !strings.Contains(err.Error(), "--payload file input is unavailable") {
			t.Fatalf("payload file input was accepted: %v", err)
		}
	})

	t.Run("rejects unauthorized protected values", func(t *testing.T) {
		_, err := authorizeArguments(
			[]string{"analysis", "validate", "--filter", "manageAreaId=CN99"},
			authzScope,
			10,
			catalog,
		)
		if err == nil || !strings.Contains(err.Error(), "unauthorized") {
			t.Fatalf("expected unauthorized filter error, got %v", err)
		}
	})

	t.Run("rejects an unauthorized sap area and retains the management-area guard", func(t *testing.T) {
		_, err := authorizeArguments(
			[]string{"analysis", "validate", "--filter", "sapArea2Id=CN99"},
			authzScope,
			10,
			catalog,
		)
		if err == nil || !strings.Contains(err.Error(), "sapArea2Id contains an unauthorized value") {
			t.Fatalf("expected unauthorized sap area error, got %v", err)
		}

		args, err := authorizeArguments(
			[]string{"analysis", "validate", "--filter", "sapArea2Id=CN07"},
			authzScope,
			10,
			catalog,
		)
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, "--filter sapArea2Id=CN07") ||
			!strings.Contains(joined, "--filter manageAreaId=CN07,CN08") {
			t.Fatalf("authorized sap area did not retain the management-area guard: %q", joined)
		}
	})

	t.Run("rejects too many metrics", func(t *testing.T) {
		_, err := authorizeArguments(
			[]string{"analysis", "validate", "--metric", "saleAmt", "--metric", "saleAmt"},
			authzScope,
			1,
			catalog,
		)
		if err == nil || !strings.Contains(err.Error(), "too many metrics") {
			t.Fatalf("expected metric limit error, got %v", err)
		}
	})

	t.Run("rejects an unapproved metric", func(t *testing.T) {
		_, err := authorizeArguments(
			[]string{"analysis", "validate", "--metric", "saleCnt"},
			authzScope,
			10,
			catalog,
		)
		if err == nil || !strings.Contains(err.Error(), "unauthorized metric") {
			t.Fatalf("expected unauthorized metric error, got %v", err)
		}
	})
}

func TestAuthorizeMetricEqualsFormsAndPayloadFilters(t *testing.T) {
	fixture := newWrapperFixture(t)
	catalog := fixture.catalog(t)
	scope := authz.Scope{
		ManageAreaIDs:     []string{"CN07", "CN08"},
		CategoryLevel1IDs: []string{"12", "13"},
	}

	for name, args := range map[string][]string{
		"wikis code":       {"wikis", "--code=saleAmt"},
		"dimension metric": {"dim", "search", "--metric=saleAmt"},
		"analysis metric": {
			"analysis", "validate", "--metric=saleAmt",
			"--filter=manageAreaId=CN07", "--filter=categoryLevel1Id=12",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := authorizeArguments(args, scope, 10, catalog); err != nil {
				t.Fatalf("approved equals-form argument was rejected: %v", err)
			}
		})
	}

	for name, args := range map[string][]string{
		"wikis code":       {"wikis", "--code=saleCnt"},
		"dimension metric": {"dim", "search", "--metric=saleCnt"},
		"analysis metric":  {"analysis", "validate", "--metric=saleCnt"},
		"empty metric":     {"analysis", "validate", "--metric="},
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			if _, err := authorizeArguments(args, scope, 10, catalog); err == nil ||
				!strings.Contains(err.Error(), "unauthorized metric") {
				t.Fatalf("unauthorized equals-form argument was not rejected: %v", err)
			}
		})
	}

	t.Run("accepts authorized payload filter subsets", func(t *testing.T) {
		args, err := authorizeArguments([]string{
			"analysis", "validate", "--payload-json",
			`{"metrics":["saleAmt"],"filters":{"manageAreaId":["CN07"],"categoryLevel1Id":["13"]}}`,
		}, scope, 10, catalog)
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(args, " ")
		if !strings.Contains(joined, `"manageAreaId":["CN07"]`) ||
			!strings.Contains(joined, `"categoryLevel1Id":["13"]`) {
			t.Fatalf("authorized payload filters changed unexpectedly: %v", args)
		}
	})

	for name, payload := range map[string]string{
		"non-object filters": `{"metrics":["saleAmt"],"filters":[]}`,
		"non-array values":   `{"metrics":["saleAmt"],"filters":{"manageAreaId":"CN07"}}`,
		"null filter values": `{"metrics":["saleAmt"],"filters":{"manageAreaId":null}}`,
		"wildcard value":     `{"metrics":["saleAmt"],"filters":{"manageAreaId":["*"]}}`,
		"unauthorized value": `{"metrics":["saleAmt"],"filters":{"manageAreaId":["CN99"]}}`,
		"null request":       `null`,
	} {
		t.Run("rejects payload "+name, func(t *testing.T) {
			if _, err := authorizeArguments(
				[]string{"analysis", "validate", "--payload-json", payload},
				scope,
				10,
				catalog,
			); err == nil {
				t.Fatalf("invalid payload filter was accepted: %s", payload)
			}
		})
	}
}

func TestAuthorizePayloadCanonicalizesProtectedFields(t *testing.T) {
	fixture := newWrapperFixture(t)
	catalog := fixture.catalog(t)
	scope := authz.Scope{
		ManageAreaIDs:     []string{"CN07", "CN08"},
		CategoryLevel1IDs: []string{"12", "13"},
	}

	for _, field := range []string{"Metrics", "METRICS", "mEtRiCs"} {
		t.Run("rejects unauthorized "+field, func(t *testing.T) {
			payload := `{"` + field + `":["saleCnt"]}`
			_, err := authorizeArguments([]string{
				"analysis", "validate", "--payload-json", payload,
			}, scope, 10, catalog)
			if err == nil || !strings.Contains(err.Error(), "unauthorized metric") {
				t.Fatalf("payload field %q bypassed metric authorization: %v", field, err)
			}
		})
	}

	t.Run("enforces metric limit through a case variant", func(t *testing.T) {
		_, err := authorizeArguments([]string{
			"analysis", "validate", "--payload-json",
			`{"Metrics":["saleAmt","saleAmt"]}`,
		}, scope, 1, catalog)
		if err == nil || !strings.Contains(err.Error(), "too many metrics") {
			t.Fatalf("case-variant metrics bypassed the metric limit: %v", err)
		}
	})

	for _, field := range []string{"Filters", "FILTERS", "fIlTeRs"} {
		t.Run("rejects unauthorized "+field, func(t *testing.T) {
			payload := `{"metrics":["saleAmt"],"` + field +
				`":{"manageAreaId":["CN99"],"categoryLevel1Id":["999"]}}`
			_, err := authorizeArguments([]string{
				"analysis", "validate", "--payload-json", payload,
			}, scope, 10, catalog)
			if err == nil || !strings.Contains(err.Error(), "unauthorized value") {
				t.Fatalf("payload field %q bypassed filter authorization: %v", field, err)
			}
		})
	}

	t.Run("preserves unrelated fields and emits canonical protected fields", func(t *testing.T) {
		args, err := authorizeArguments([]string{
			"analysis", "validate", "--payload-json",
			`{
				"Metrics":["saleAmt"],
				"Filters":{
					"manageAreaId":["CN07"],
					"categoryLevel1Id":["12"]
				},
				"extension":{"trace":"kept"}
			}`,
		}, scope, 10, catalog)
		if err != nil {
			t.Fatal(err)
		}
		if len(args) != 4 || args[2] != "--payload-json" {
			t.Fatalf("payload was not normalized to --payload-json: %v", args)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal([]byte(args[3]), &fields); err != nil {
			t.Fatalf("normalized payload is invalid JSON: %v", err)
		}
		for key := range fields {
			if (strings.EqualFold(key, "metrics") && key != "metrics") ||
				(strings.EqualFold(key, "filters") && key != "filters") {
				t.Fatalf("normalized payload retained a protected field alias %q: %s", key, args[3])
			}
		}
		if string(fields["metrics"]) != `["saleAmt"]` ||
			!strings.Contains(string(fields["filters"]), `"manageAreaId":["CN07"]`) ||
			!strings.Contains(string(fields["filters"]), `"categoryLevel1Id":["12"]`) ||
			string(fields["extension"]) != `{"trace":"kept"}` {
			t.Fatalf("normalized payload changed protected or unrelated fields: %s", args[3])
		}
	})

	for _, payload := range []string{
		`{"metrics":["saleAmt"],"Metrics":["saleAmt"]}`,
		`{"filters":{},"Filters":{}}`,
	} {
		t.Run("rejects conflicting protected aliases", func(t *testing.T) {
			_, err := authorizeArguments([]string{
				"analysis", "validate", "--payload-json", payload,
			}, scope, 10, catalog)
			if err == nil || !strings.Contains(err.Error(), "conflicting") {
				t.Fatalf("conflicting protected aliases were accepted: %v", err)
			}
		})
	}
}

func TestAuthorizeRequiresDoubleHyphenFlagForms(t *testing.T) {
	fixture := newWrapperFixture(t)
	catalog := fixture.catalog(t)
	scope := authz.Scope{
		ManageAreaIDs:     []string{"CN07", "CN08"},
		CategoryLevel1IDs: []string{"12", "13"},
	}

	for name, args := range map[string][]string{
		"wikis separated code": {
			"wikis", "-code", "saleAmt",
		},
		"wikis equals code": {
			"wikis", "-code=saleAmt",
		},
		"dimension metric": {
			"dim", "search", "-metric", "saleAmt",
		},
		"analysis metric": {
			"analysis", "validate", "-metric=saleAmt",
		},
		"analysis filter": {
			"analysis", "validate", "-filter", "manageAreaId=CN07",
		},
		"analysis payload": {
			"analysis", "validate", "-payload-json", `{"metrics":["saleAmt"]}`,
		},
		"analysis unrelated flag": {
			"analysis", "validate", "-timeout=5s",
		},
		"single-hyphen help": {
			"wikis", "-h",
		},
		"pass-through command flag": {
			"metric", "search", "-keyword=sale",
		},
		"triple-hyphen flag": {
			"wikis", "---code=saleAmt",
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := authorizeArguments(args, scope, 10, catalog)
			if err == nil || !strings.Contains(err.Error(), "double-hyphen form") {
				t.Fatalf("non-double-hyphen flag was not rejected: %v", err)
			}
		})
	}

	t.Run("rejects an ambiguous separated flag value", func(t *testing.T) {
		_, err := authorizeArguments([]string{
			"analysis", "validate",
			"--metric", "saleAmt",
			"--request-id", "-metric=saleCnt",
		}, scope, 10, catalog)
		if err == nil || !strings.Contains(err.Error(), "double-hyphen form") {
			t.Fatalf("ambiguous single-hyphen value token was not rejected: %v", err)
		}
	})

	t.Run("accepts a leading-hyphen value in equals form", func(t *testing.T) {
		args, err := authorizeArguments([]string{
			"analysis", "validate",
			"--metric", "saleAmt",
			"--request-id=-metric=saleCnt",
		}, scope, 10, catalog)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parseAnalysisArgumentsV010(args[2:])
		if err != nil {
			t.Fatal(err)
		}
		if parsed.RequestID != "-metric=saleCnt" {
			t.Fatalf("request ID=%q", parsed.RequestID)
		}
	})

	t.Run("denies before executing the real CLI", func(t *testing.T) {
		t.Setenv(bindingEnvironment, fixture.binding(t))
		output, err := fixture.run(
			t,
			"analysis", "validate",
			"--metric", "saleAmt",
			"-filter", "manageAreaId=CN99",
		)
		if err == nil || !strings.Contains(err.Error(), "double-hyphen form") {
			t.Fatalf("expected wrapper authorization denial, got output=%q err=%v", output, err)
		}
		if output != "" {
			t.Fatalf("real Metric CLI was executed for a denied request: %q", output)
		}
	})
}

func TestAuthorizeFlagSetCompatibilityV010(t *testing.T) {
	fixture := newWrapperFixture(t)
	catalog := fixture.catalog(t)
	scope := authz.Scope{
		ManageAreaIDs:     []string{"CN07", "CN08"},
		CategoryLevel1IDs: []string{"12", "13"},
	}

	t.Run("does not treat ordinary flag values as protected filters", func(t *testing.T) {
		args, err := authorizeArguments([]string{
			"analysis", "validate",
			"--start-date", "2026-08-01",
			"--end-date", "2026-08-01",
			"--metric", "saleAmt",
			"--request-id=-filter=manageAreaId=CN07",
		}, scope, 10, catalog)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parseAnalysisArgumentsV010(args[2:])
		if err != nil {
			t.Fatalf("forwarded arguments do not match v0.1.0 parsing: %v", err)
		}
		filters := parseFilterArgumentsForTest(t, parsed.Filters)
		assertFilterValuesForTest(t, filters, "manageAreaId", []string{"CN07", "CN08"})
		assertFilterValuesForTest(t, filters, "categoryLevel1Id", []string{"12", "13"})
		if parsed.RequestID != "-filter=manageAreaId=CN07" {
			t.Fatalf("ordinary flag values changed unexpectedly: %+v", parsed)
		}
	})

	t.Run("does not treat an ordinary flag value as payload input", func(t *testing.T) {
		args, err := authorizeArguments([]string{
			"analysis", "validate",
			"--metric", "saleAmt",
			`--request-id=-payload-json={"metrics":["saleCnt"]}`,
		}, scope, 10, catalog)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parseAnalysisArgumentsV010(args[2:])
		if err != nil {
			t.Fatal(err)
		}
		if parsed.Payload != "" || parsed.PayloadJSON != "" {
			t.Fatalf("ordinary flag value became payload input: %+v", parsed)
		}
		filters := parseFilterArgumentsForTest(t, parsed.Filters)
		assertFilterValuesForTest(t, filters, "manageAreaId", []string{"CN07", "CN08"})
		assertFilterValuesForTest(t, filters, "categoryLevel1Id", []string{"12", "13"})
	})

	t.Run("injects scope before a trailing terminator", func(t *testing.T) {
		args, err := authorizeArguments([]string{
			"analysis", "validate",
			"--start-date", "2026-08-01",
			"--end-date", "2026-08-01",
			"--metric", "saleAmt",
			"--",
		}, scope, 10, catalog)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parseAnalysisArgumentsV010(args[2:])
		if err != nil {
			t.Fatalf("scope was injected after the terminator: %v; args=%v", err, args)
		}
		filters := parseFilterArgumentsForTest(t, parsed.Filters)
		assertFilterValuesForTest(t, filters, "manageAreaId", []string{"CN07", "CN08"})
		assertFilterValuesForTest(t, filters, "categoryLevel1Id", []string{"12", "13"})
	})

	for name, args := range map[string][]string{
		"wikis final code": {
			"wikis", "--code", "saleCnt", "--code=saleAmt",
		},
		"dimension final metric": {
			"dim", "search", "--metric", "saleCnt", "--metric=saleAmt",
		},
	} {
		t.Run("authorizes "+name, func(t *testing.T) {
			if _, err := authorizeArguments(args, scope, 10, catalog); err != nil {
				t.Fatalf("final approved scalar value was rejected: %v", err)
			}
		})
	}

	t.Run("rejects repeated payload files", func(t *testing.T) {
		first := filepath.Join(fixture.root, "first.json")
		second := filepath.Join(fixture.root, "second.json")
		writeFile(t, first, []byte(`{"metrics":["saleCnt"]}`), 0o600)
		writeFile(t, second, []byte(`{"metrics":["saleAmt"]}`), 0o600)

		_, err := authorizeArguments([]string{
			"analysis", "validate",
			"--payload", first,
			"--payload", second,
		}, scope, 10, catalog)
		if err == nil || !strings.Contains(err.Error(), "--payload file input is unavailable") {
			t.Fatalf("payload file input was accepted: %v", err)
		}
	})

	t.Run("rejects an empty payload file flag combined with payload JSON", func(t *testing.T) {
		_, err := authorizeArguments([]string{
			"analysis", "validate",
			"--payload=",
			"--payload-json", `{"metrics":["saleAmt"]}`,
		}, scope, 10, catalog)
		if err == nil || !strings.Contains(err.Error(), "--payload file input is unavailable") {
			t.Fatalf("payload file flag was accepted: %v", err)
		}
	})

	t.Run("preserves allowed payload flags by their final values", func(t *testing.T) {
		args, err := authorizeArguments([]string{
			"analysis", "execute",
			"--payload-json", `{"metrics":["saleAmt"]}`,
			"--request-id=-metric=saleCnt",
			"--timeout", "5s",
			"--single-page=false",
			"--yoy=false",
			"--mom=true",
			"--biz-thresh=false",
			"--format", "json",
			"--output", "envelope",
		}, scope, 10, catalog)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parseAnalysisArgumentsV010(args[2:])
		if err != nil {
			t.Fatalf("canonical payload arguments do not parse: %v", err)
		}
		if parsed.RequestID != "-metric=saleCnt" ||
			parsed.Timeout != 5*time.Second ||
			parsed.SinglePage ||
			parsed.YOY ||
			!parsed.MOM ||
			parsed.BizThreshold ||
			parsed.Format != "json" ||
			parsed.Output != "envelope" {
			t.Fatalf("allowed payload flags changed: %+v", parsed)
		}
		for _, name := range []string{
			"request-id", "timeout", "single-page",
			"yoy", "mom", "biz-thresh", "format", "output",
		} {
			if !parsed.Visited[name] {
				t.Fatalf("canonical payload omitted visited flag %s: %v", name, args)
			}
		}
		assertCanonicalPayloadArgumentsForTest(t, args, scope)
	})

	t.Run("rejects runtime socket overrides for every command family", func(t *testing.T) {
		for name, args := range map[string][]string{
			"metric":    {"metric", "search", "--socket=/tmp/agent.sock"},
			"wikis":     {"wikis", "--socket", "/tmp/agent.sock"},
			"dimension": {"dim", "search", "--socket=/tmp/agent.sock"},
			"analysis":  {"analysis", "execute", "--socket", "/tmp/agent.sock"},
		} {
			t.Run(name, func(t *testing.T) {
				_, err := authorizeArguments(args, scope, 10, catalog)
				if err == nil || !strings.Contains(err.Error(), "socket overrides") {
					t.Fatalf("runtime socket override was accepted: %v", err)
				}
			})
		}
	})

	t.Run("rejects payload files even when payload JSON is also present", func(t *testing.T) {
		payloadPath := filepath.Join(fixture.root, "request.json")
		writeFile(t, payloadPath, []byte(`{"metrics":["saleAmt"]}`), 0o600)
		_, err := authorizeArguments([]string{
			"analysis", "validate",
			"--payload", payloadPath,
			"--payload-json", `{"metrics":["saleAmt"]}`,
		}, scope, 10, catalog)
		if err == nil || !strings.Contains(err.Error(), "--payload file input is unavailable") {
			t.Fatalf("payload file input was accepted: %v", err)
		}
	})
}

func TestMetricChildEnvironmentIsFixedAndCredentialFree(t *testing.T) {
	t.Setenv(bindingEnvironment, "binding-secret")
	t.Setenv("QDM_CAS_CONFIG_DIR", "/root/secret")
	t.Setenv("HTTPS_PROXY", "http://root-proxy")

	got := metricEnvironmentForChild()
	want := []string{
		"HOME=/nonexistent",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"PATH=/usr/bin:/bin",
		"TZ=UTC",
	}
	if len(got) != len(want) {
		t.Fatalf("child environment = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("child environment = %v, want %v", got, want)
		}
	}
}

func parseFilterArgumentsForTest(t *testing.T, arguments []string) map[string][]string {
	t.Helper()
	result := map[string][]string{}
	for _, argument := range arguments {
		dimension, rawValues, ok := strings.Cut(argument, "=")
		if !ok {
			t.Fatalf("invalid forwarded filter argument %q", argument)
		}
		result[dimension] = append(result[dimension], strings.Split(rawValues, ",")...)
	}
	return result
}

func assertFilterValuesForTest(t *testing.T, filters map[string][]string, dimension string, expected []string) {
	t.Helper()
	actual := filters[dimension]
	if len(actual) != len(expected) {
		t.Fatalf("%s values=%v, want %v", dimension, actual, expected)
	}
	for index := range expected {
		if actual[index] != expected[index] {
			t.Fatalf("%s values=%v, want %v", dimension, actual, expected)
		}
	}
}

func assertCanonicalPayloadArgumentsForTest(t *testing.T, args []string, scope authz.Scope) {
	t.Helper()
	parsed, err := parseAnalysisArgumentsV010(args[2:])
	if err != nil {
		t.Fatalf("canonical payload arguments do not match v0.1.0 parsing: %v; args=%v", err, args)
	}
	if parsed.Payload != "" || parsed.PayloadJSON == "" {
		t.Fatalf("payload was not reduced to one inline source: %+v", parsed)
	}
	var request analysisAuthorizationRequestV010
	if err := json.Unmarshal([]byte(parsed.PayloadJSON), &request); err != nil {
		t.Fatalf("canonical payload JSON is invalid: %v", err)
	}
	assertFilterValuesForTest(t, request.Filters, "manageAreaId", scope.ManageAreaIDs)
	assertFilterValuesForTest(t, request.Filters, "categoryLevel1Id", scope.CategoryLevel1IDs)
}

func TestRunRejectsAdministrativeCommandsAndPreservesChildStatus(t *testing.T) {
	fixture := newWrapperFixture(t)
	t.Setenv(bindingEnvironment, fixture.binding(t))

	for _, command := range []string{"registry", "doris"} {
		_, err := fixture.run(t, command)
		if err == nil || !strings.Contains(err.Error(), "not available") {
			t.Fatalf("expected %s to be denied, got %v", command, err)
		}
	}

	output, err := fixture.run(t, "version")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "arg=version") {
		t.Fatalf("authorized command did not reach real Metric CLI: %q", output)
	}

	fixture.writeRealCLI(t, "#!/bin/sh\nexit 9\n")
	fixture.config.RealMetricCLI.ArtifactSHA256 = fileSHA256(fixture.realCLIPath)
	fixture.writeConfig(t)
	output, err = fixture.run(t, "version")
	if output != "" {
		t.Fatalf("unexpected output from failed child: %q", output)
	}
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 9 {
		t.Fatalf("expected child exit code 9, got %v", err)
	}
}

func TestRunEnforcesOutputLimitAndTimeout(t *testing.T) {
	t.Run("stdout", func(t *testing.T) {
		fixture := newWrapperFixture(t)
		t.Setenv(bindingEnvironment, fixture.binding(t))
		fixture.config.Limits.MaxOutputBytes = 1
		fixture.writeConfig(t)
		_, err := fixture.run(t, "version")
		var exitErr *ExitError
		if !errors.As(err, &exitErr) || exitErr.Code != 77 ||
			!strings.Contains(err.Error(), "output exceeds") {
			t.Fatalf("expected output limit failure, got %v", err)
		}
	})

	t.Run("stderr", func(t *testing.T) {
		fixture := newWrapperFixture(t)
		fixture.writeRealCLI(t, "#!/bin/sh\nprintf 'xx' >&2\n")
		fixture.config.RealMetricCLI.ArtifactSHA256 = fileSHA256(fixture.realCLIPath)
		fixture.config.Limits.MaxOutputBytes = 1
		fixture.writeConfig(t)
		t.Setenv(bindingEnvironment, fixture.binding(t))
		output, err := fixture.run(t, "version")
		var exitErr *ExitError
		if !errors.As(err, &exitErr) || exitErr.Code != 77 ||
			!strings.Contains(err.Error(), "output exceeds") {
			t.Fatalf("expected stderr limit failure, got output=%q err=%v", output, err)
		}
		if output != "x" {
			t.Fatalf("bounded stderr output = %q, want %q", output, "x")
		}
	})

	t.Run("timeout", func(t *testing.T) {
		fixture := newWrapperFixture(t)
		fixture.writeRealCLI(t, "#!/bin/sh\nsleep 2\n")
		fixture.config.RealMetricCLI.ArtifactSHA256 = fileSHA256(fixture.realCLIPath)
		fixture.config.Limits.TimeoutSeconds = 1
		fixture.writeConfig(t)
		t.Setenv(bindingEnvironment, fixture.binding(t))
		started := time.Now()
		_, err := fixture.run(t, "version")
		if time.Since(started) > 3*time.Second {
			t.Fatal("timeout did not terminate the child promptly")
		}
		var exitErr *ExitError
		if !errors.As(err, &exitErr) || exitErr.Code != 124 {
			t.Fatalf("expected timeout exit code 124, got %v", err)
		}
	})
}
