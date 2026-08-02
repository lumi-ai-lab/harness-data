package authz

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestReadEnvelopeBindingAndCurrentValidation(t *testing.T) {
	fixture := newAuthzFixture(t)
	loadedConfig, err := LoadConfig(fixture.configPath)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := ReadEnvelope(loadedConfig, fixture.sessionID, WithNow(fixture.now))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Envelope.SessionID != fixture.sessionID || len(loaded.SHA256) != 64 || len(loaded.ContextFingerprint) != 64 {
		t.Fatalf("unexpected envelope: %#v", loaded)
	}
	binding := NewBinding(loaded)
	encoded, err := EncodeBinding(binding)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeBinding(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.SessionID != fixture.sessionID || decoded.RequestID != fixture.envelope.RequesterContext.RequestID {
		t.Fatalf("unexpected binding: %#v", decoded)
	}
	current, err := ValidateCurrent(loadedConfig, decoded, WithNow(fixture.now))
	if err != nil {
		t.Fatal(err)
	}
	if current.SHA256 != loaded.SHA256 {
		t.Fatalf("current digest %s != %s", current.SHA256, loaded.SHA256)
	}
	bound, err := Bind(loadedConfig, fixture.sessionID, WithNow(fixture.now))
	if err != nil {
		t.Fatal(err)
	}
	if bound.BindingBase64URL != encoded || bound.Summary.CanonicalUserID != "user-1" || bound.ContextFingerprint != loaded.ContextFingerprint {
		t.Fatalf("unexpected bind result: %#v", bound)
	}
}

func TestScopeIDsRemainOpaqueAndCaseSensitive(t *testing.T) {
	fixture := newAuthzFixture(t)
	fixture.envelope.RequesterContext.Authorization.Scope.ManageAreaIDs = []string{"CN 07", "cn07"}
	fixture.writeEnvelope(t, fixture.envelope)
	loaded, err := ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
	if err != nil {
		t.Fatal(err)
	}
	got := loaded.Envelope.RequesterContext.Authorization.Scope.ManageAreaIDs
	if len(got) != 2 || got[0] != "CN 07" || got[1] != "cn07" {
		t.Fatalf("scope IDs were normalized: %#v", got)
	}
}

func TestMetricCatalogMatchesApprovedIdentifiersExactly(t *testing.T) {
	fixture := newAuthzFixture(t)
	raw := []byte(`{"version":1,"generatedFrom":"qdm-metric-cli-v0.1.0-contract","metrics":{"saleAmt":{"supportedDimensions":["manageAreaId","categoryLevel1Id"],"dictionaryRefs":[{"queryType":1,"id":"metric-id-1","internalCode":"sale_amt_internal","names":["销售额","Sale Amount"]},{"queryType":2,"id":"metric-id-2","internalCode":"sale_amt_composite","names":["复合销售额"]}]}}}`)
	writeTestFile(t, fixture.catalogPath, raw, 0o600)
	catalog, err := LoadMetricCatalog(fixture.catalogPath, sha256Hex(raw))
	if err != nil {
		t.Fatal(err)
	}

	if !catalog.ApproveMetric("saleAmt") || catalog.ApproveMetric("SaleAmt") || catalog.ApproveMetric("saleCnt") {
		t.Fatal("metric approval was not exact and case-sensitive")
	}
	if match, ok := catalog.MatchID("metric-id-1", 1, true); !ok || match.Metric != "saleAmt" {
		t.Fatalf("approved dictionary ID did not resolve: %#v, %v", match, ok)
	}
	if _, ok := catalog.MatchID("metric-id-1", 2, true); ok {
		t.Fatal("dictionary ID resolved with the wrong required query type")
	}
	if match, ok := catalog.MatchID("metric-id-1", 2, false); !ok || match.Ref.QueryType != 1 {
		t.Fatalf("optional query type unexpectedly changed the match: %#v, %v", match, ok)
	}
	if match, ok := catalog.MatchInternal("sale_amt_internal"); !ok || match.Metric != "saleAmt" {
		t.Fatalf("approved internal code did not resolve: %#v, %v", match, ok)
	}
	if _, ok := catalog.MatchInternal("SALE_AMT_INTERNAL"); ok {
		t.Fatal("internal code matching was not case-sensitive")
	}
	if match, ok := catalog.MatchName("销售额", 1); !ok || match.Ref.ID != "metric-id-1" {
		t.Fatalf("approved name did not resolve: %#v, %v", match, ok)
	}
	if _, ok := catalog.MatchName("销售额", 2); ok {
		t.Fatal("dictionary name resolved with the wrong query type")
	}
	if _, ok := catalog.MatchName("sale amount", 1); ok {
		t.Fatal("dictionary name matching was not exact")
	}
	if !catalog.IDMatchesMetric("metric-id-2", "saleAmt", 2) ||
		catalog.IDMatchesMetric("metric-id-2", "saleCnt", 2) ||
		catalog.IDMatchesMetric("metric-id-2", "saleAmt", 1) {
		t.Fatal("dictionary ID to Metric matching was not exact")
	}
}

func TestSessionFileNameUsesExactRawBytesAndNeverScans(t *testing.T) {
	left, err := SessionFileName(" session ")
	if err != nil {
		t.Fatal(err)
	}
	right, err := SessionFileName("session")
	if err != nil {
		t.Fatal(err)
	}
	if left == right || !strings.HasSuffix(left, ".json") {
		t.Fatalf("session file names were normalized: %q %q", left, right)
	}
	rawFixture := newAuthzFixture(t)
	rawFixture.sessionID = " session "
	rawFixture.envelope.SessionID = rawFixture.sessionID
	rawFixture.writeEnvelope(t, rawFixture.envelope)
	loaded, err := ReadEnvelope(rawFixture.config, rawFixture.sessionID, WithNow(rawFixture.now))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Envelope.SessionID != rawFixture.sessionID {
		t.Fatalf("session ID was normalized: %q", loaded.Envelope.SessionID)
	}
	encoded, err := EncodeBinding(NewBinding(loaded))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeBinding(encoded)
	if err != nil || decoded.SessionID != rawFixture.sessionID {
		t.Fatalf("binding did not preserve the raw session ID: %#v, %v", decoded, err)
	}
	fixture := newAuthzFixture(t)
	expected, _ := SessionFileName(fixture.sessionID)
	if err := os.Remove(filepath.Join(fixture.contextDir, expected)); err != nil {
		t.Fatal(err)
	}
	writeTestJSON(t, filepath.Join(fixture.contextDir, "newest.json"), fixture.envelope, 0o600)
	_, err = ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeRequesterContextInvalid)
}

func TestClockSkewDoesNotExtendEnvelopeExpiry(t *testing.T) {
	fixture := newAuthzFixture(t)
	fixture.envelope.IssuedAt = fixture.now.Add(-time.Minute)
	fixture.envelope.ExpiresAt = fixture.now.Add(-time.Second)
	fixture.writeEnvelope(t, fixture.envelope)
	_, err := ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeRequesterContextExpired)
}

func TestStrictEnvelopeValidationRejectsMalformedAndUnsafeInputs(t *testing.T) {
	tests := map[string]func(*testing.T, *authzFixture){
		"unknown field": func(t *testing.T, fixture *authzFixture) {
			raw, _ := json.Marshal(fixture.envelope)
			raw = append(raw[:len(raw)-1], []byte(`,"unknown":1}`)...)
			fixture.writeRawEnvelope(t, raw)
		},
		"duplicate key": func(t *testing.T, fixture *authzFixture) {
			raw, _ := json.Marshal(fixture.envelope)
			fixture.writeRawEnvelope(t, append([]byte(`{"version":1,`), raw[1:]...))
		},
		"trailing value": func(t *testing.T, fixture *authzFixture) {
			raw, _ := json.Marshal(fixture.envelope)
			fixture.writeRawEnvelope(t, append(raw, []byte(`{}`)...))
		},
		"session mismatch": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.SessionID = "different"
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"future issued": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.IssuedAt = fixture.now.Add(31 * time.Second)
			fixture.envelope.ExpiresAt = fixture.envelope.IssuedAt.Add(time.Minute)
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"expired": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.IssuedAt = fixture.now.Add(-time.Minute)
			fixture.envelope.ExpiresAt = fixture.now
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"ttl above 30 minutes": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.IssuedAt = fixture.now.Add(-time.Minute)
			fixture.envelope.ExpiresAt = fixture.envelope.IssuedAt.Add(30*time.Minute + time.Second)
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"capability missing": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.RequesterContext.Authorization.Capabilities = []string{"other"}
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"empty area scope": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.RequesterContext.Authorization.Scope.ManageAreaIDs = nil
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"comma in scope": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.RequesterContext.Authorization.Scope.ManageAreaIDs = []string{"CN07,CN08"}
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"control in scope": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.RequesterContext.Authorization.Scope.ManageAreaIDs = []string{"CN07\n"}
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"wildcard scope": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.RequesterContext.Authorization.Scope.ManageAreaIDs = []string{"*"}
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"duplicate scope": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.RequesterContext.Authorization.Scope.ManageAreaIDs = []string{"CN07", "CN07"}
			fixture.writeEnvelope(t, fixture.envelope)
		},
		"invalid DC scope": func(t *testing.T, fixture *authzFixture) {
			fixture.envelope.RequesterContext.Authorization.Scope.DCManageAreaIDs = []string{"CN07", "*"}
			fixture.writeEnvelope(t, fixture.envelope)
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			fixture := newAuthzFixture(t)
			mutate(t, fixture)
			_, err := ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
			if name == "expired" {
				assertAuthzCode(t, err, CodeRequesterContextExpired)
			} else if name == "capability missing" {
				assertAuthzCode(t, err, CodeCapabilityDenied)
			} else if name == "empty area scope" {
				assertAuthzCode(t, err, CodeScopeEmpty)
			} else {
				assertAuthzCode(t, err, CodeRequesterContextInvalid)
			}
		})
	}
}

func TestEnvelopeSymlinkAndOversizeFailClosed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires platform privileges")
	}
	fixture := newAuthzFixture(t)
	name, _ := SessionFileName(fixture.sessionID)
	path := filepath.Join(fixture.contextDir, name)
	target := filepath.Join(fixture.root, "envelope-target.json")
	raw, _ := json.Marshal(fixture.envelope)
	writeTestFile(t, target, raw, 0o600)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	_, err := ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeRequesterContextInvalid)

	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	fixture.config.MaxEnvelopeBytes = 16
	fixture.writeEnvelope(t, fixture.envelope)
	_, err = ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeRequesterContextInvalid)
}

func TestBindingRejectsNoncanonicalUnknownAndStaleValues(t *testing.T) {
	fixture := newAuthzFixture(t)
	loaded, err := ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
	if err != nil {
		t.Fatal(err)
	}
	binding := NewBinding(loaded)
	canonical, err := CanonicalBindingJSON(binding)
	if err != nil {
		t.Fatal(err)
	}
	noncanonical := base64.RawURLEncoding.EncodeToString(append([]byte(" "), canonical...))
	_, err = DecodeBinding(noncanonical)
	assertAuthzCode(t, err, CodeBindingInvalid)
	unknownRaw := append(append([]byte(nil), canonical[:len(canonical)-1]...), []byte(`,"unknown":1}`)...)
	_, err = DecodeBinding(base64.RawURLEncoding.EncodeToString(unknownRaw))
	assertAuthzCode(t, err, CodeBindingInvalid)

	binding.RequestID = "another-request"
	_, err = ValidateCurrent(fixture.config, binding, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeBindingMismatch)
	binding = NewBinding(loaded)
	binding.ExpiresAt = fixture.now
	_, err = ValidateCurrent(fixture.config, binding, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeRequesterContextExpired)
}

func TestCurrentValidationObservesReplacementCleanupAndKillSwitch(t *testing.T) {
	fixture := newAuthzFixture(t)
	loaded, err := ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
	if err != nil {
		t.Fatal(err)
	}
	binding := NewBinding(loaded)

	replacement := fixture.envelope
	replacement.RequesterContext.RequestID = "request-2"
	fixture.writeEnvelope(t, replacement)
	_, err = ValidateCurrent(fixture.config, binding, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeBindingMismatch)

	fixture.writeEnvelope(t, fixture.envelope)
	name, _ := SessionFileName(fixture.sessionID)
	if err := os.Remove(filepath.Join(fixture.contextDir, name)); err != nil {
		t.Fatal(err)
	}
	_, err = ValidateCurrent(fixture.config, binding, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeRequesterContextInvalid)

	fixture.writeEnvelope(t, fixture.envelope)
	writeTestJSON(t, fixture.controlPath, ControlState{Version: 1, Generation: 8, State: "disabled", UpdatedAt: fixture.now}, 0o600)
	_, err = ValidateCurrent(fixture.config, binding, WithNow(fixture.now))
	assertAuthzCode(t, err, CodeKillSwitchActive)
}

func TestConfigAndControlStrictJSON(t *testing.T) {
	fixture := newAuthzFixture(t)
	configRaw, err := os.ReadFile(fixture.configPath)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, fixture.configPath, append(configRaw[:len(configRaw)-1], []byte(`,"unknown":1}`)...), 0o600)
	_, err = LoadConfig(fixture.configPath)
	assertAuthzCode(t, err, CodeConfigInvalid)

	fixture = newAuthzFixture(t)
	controlRaw := []byte(`{"version":1,"generation":7,"state":"enabled","updatedAt":"2026-07-30T03:59:00Z","state":"disabled"}`)
	writeTestFile(t, fixture.controlPath, controlRaw, 0o600)
	_, err = ReadControl(fixture.config)
	assertAuthzCode(t, err, CodeKillSwitchActive)
}

func TestReadinessValidatesProfileReleaseSetPathsAndSecrets(t *testing.T) {
	fixture := newAuthzFixture(t)
	report, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
	if err != nil || !report.Ready || report.ControlGeneration != 7 {
		t.Fatalf("readiness = %#v, %v", report, err)
	}

	t.Run("authorized agents", func(t *testing.T) {
		for _, agent := range []string{"pi", "claude", "codex", "qwen"} {
			t.Run(agent, func(t *testing.T) {
				fixture := newAuthzFixture(t)
				fixture.installerAgent = agent
				fixture.writeInstallerState(t)
				report, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
				if err != nil || !report.Ready {
					t.Fatalf("readiness = %#v, %v", report, err)
				}
			})
		}
		fixture := newAuthzFixture(t)
		fixture.installerAgent = "openclaw"
		fixture.writeInstallerState(t)
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("selected Agent deployment", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		if err := os.Remove(filepath.Join(fixture.root, ".pi")); err != nil {
			t.Fatal(err)
		}
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)

		fixture = newAuthzFixture(t)
		if err := os.Remove(filepath.Join(fixture.root, "agents", "pi", "settings.json")); err != nil {
			t.Fatal(err)
		}
		_, err = CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)

		fixture = newAuthzFixture(t)
		if err := os.Remove(filepath.Join(fixture.root, ".pi")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join("agents", "claude"), filepath.Join(fixture.root, ".pi")); err != nil {
			t.Fatal(err)
		}
		_, err = CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)

		fixture = newAuthzFixture(t)
		writeTestFile(t, filepath.Join(fixture.root, "agents", "pi", "settings.json"), []byte("{}\n"), 0o600)
		_, err = CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})

	t.Run("public metric CLI digest", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		writeTestFile(t, fixture.publicMetricPath, []byte("tampered"), 0o700)
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeArtifactIntegrityFailed)
	})
	t.Run("forbidden CLI config", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		writeTestFile(t, fixture.harnessConfigPath, []byte(
			"paths:\n  knowledge: wikis\ncli:\n  qdm_metric_cli: "+fixture.publicMetricPath+"\n  qdm_cmr_cli: /tmp/cmr\n",
		), 0o600)
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("installer unknown field", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		raw, _ := os.ReadFile(fixture.installerStatePath)
		writeTestFile(t, fixture.installerStatePath, append(raw[:len(raw)-1], []byte(`,"unknown":1}`)...), 0o600)
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("manifest raw digest", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		raw, err := os.ReadFile(fixture.cliManifestPath)
		if err != nil {
			t.Fatal(err)
		}
		writeTestFile(t, fixture.cliManifestPath, append(raw, '\n'), 0o600)
		_, err = CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("manifest mode", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		if err := os.Chmod(fixture.cliManifestPath, 0o622); err != nil {
			t.Fatal(err)
		}
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("manifest size", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		writeTestFile(t, fixture.cliManifestPath, bytes.Repeat([]byte("x"), int(maxCLIManifestBytes)+1), 0o600)
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("security-critical runtime directory mode", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Unix permission bits are required")
		}
		for _, relative := range []string{".harness", "config", "bootstrap", "bin", "private"} {
			t.Run(relative, func(t *testing.T) {
				fixture := newAuthzFixture(t)
				if err := os.Chmod(filepath.Join(fixture.root, relative), 0o770); err != nil {
					t.Fatal(err)
				}
				_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
				assertAuthzCode(t, err, CodeConfigInvalid)
			})
		}
	})
	t.Run("requester context directory must remain private", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Unix permission bits are required")
		}
		fixture := newAuthzFixture(t)
		if err := os.Chmod(fixture.contextDir, 0o755); err != nil {
			t.Fatal(err)
		}
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("security-critical runtime directory symlink", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlink creation requires platform privileges")
		}
		fixture := newAuthzFixture(t)
		original := filepath.Join(fixture.root, "bootstrap")
		target := filepath.Join(fixture.root, "bootstrap-real")
		if err := os.Rename(original, target); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, original); err != nil {
			t.Fatal(err)
		}
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("catalog semantics", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		raw := []byte(`{"version":1,"generatedFrom":"qdm-metric-cli-v0.1.0-contract","metrics":{"saleAmt":{"supportedDimensions":["manageAreaId"],"dictionaryRefs":[]}}}`)
		writeTestFile(t, fixture.catalogPath, raw, 0o600)
		fixture.config.ApprovedMetricCatalog.SHA256 = sha256Hex(raw)
		writeTestJSON(t, fixture.configPath, fixture.config, 0o600)
		fixture.writeInstallerState(t)
		_, err := CheckReadiness(fixture.configPath, fixture.readinessOptions())
		assertAuthzCode(t, err, CodeArtifactIntegrityFailed)
	})
	t.Run("forbidden CLI anywhere in PATH", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		visible := filepath.Join(fixture.root, "visible-tools")
		writeTestFile(t, filepath.Join(visible, executableName("qdm-sql-cli")), []byte("#!/bin/sh\nexit 0\n"), 0o700)
		options := fixture.readinessOptions()
		options.AgentPath = filepath.Join(fixture.root, "bin") + string(os.PathListSeparator) + visible
		_, err := CheckReadiness(fixture.configPath, options)
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("broken PATH symlink is not executable", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlink creation requires platform privileges")
		}
		fixture := newAuthzFixture(t)
		visible := filepath.Join(fixture.root, "visible-tools")
		if err := os.MkdirAll(visible, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(visible, "missing-target"), filepath.Join(visible, "stale-tool")); err != nil {
			t.Fatal(err)
		}
		options := fixture.readinessOptions()
		options.AgentPath = filepath.Join(fixture.root, "bin") + string(os.PathListSeparator) + visible
		report, err := CheckReadiness(fixture.configPath, options)
		if err != nil || !report.Ready {
			t.Fatalf("readiness with broken PATH symlink = %#v, %v", report, err)
		}
	})
	t.Run("renamed private Metric copy anywhere in PATH", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		visible := filepath.Join(fixture.root, "visible-tools")
		raw, err := os.ReadFile(fixture.realCLIPath)
		if err != nil {
			t.Fatal(err)
		}
		writeTestFile(t, filepath.Join(visible, executableName("query-helper")), raw, 0o700)
		options := fixture.readinessOptions()
		options.AgentPath = filepath.Join(fixture.root, "bin") + string(os.PathListSeparator) + visible
		_, err = CheckReadiness(fixture.configPath, options)
		assertAuthzCode(t, err, CodeConfigInvalid)
	})
	t.Run("actual Agent Metric CLI environment", func(t *testing.T) {
		for name, environment := range map[string][]string{
			"missing": nil,
			"empty":   {"QDM_METRIC_CLI="},
			"wrong":   {"QDM_METRIC_CLI=/tmp/raw-qdm-metric-cli"},
		} {
			t.Run(name, func(t *testing.T) {
				fixture := newAuthzFixture(t)
				options := fixture.readinessOptions()
				if environment == nil {
					options.AgentEnvironment = []string{}
				} else {
					options.AgentEnvironment = environment
				}
				_, err := CheckReadiness(fixture.configPath, options)
				assertAuthzCode(t, err, CodeConfigInvalid)
			})
		}
	})
	t.Run("forbidden Agent CLI environment", func(t *testing.T) {
		for _, name := range []string{"QDM_CMR_CLI", "QDM_SQL_CLI", "QDM_CAS_CLI", "QDM_CAS_CONFIG_DIR"} {
			t.Run(name, func(t *testing.T) {
				fixture := newAuthzFixture(t)
				options := fixture.readinessOptions()
				options.AgentEnvironment = append(options.AgentEnvironment, name+"=/tmp/forbidden")
				_, err := CheckReadiness(fixture.configPath, options)
				assertAuthzCode(t, err, CodeConfigInvalid)
			})
		}
	})
	t.Run("empty forbidden Agent CLI environment is accepted", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		options := fixture.readinessOptions()
		for _, name := range []string{"QDM_CMR_CLI", "QDM_SQL_CLI", "QDM_CAS_CLI", "QDM_CAS_CONFIG_DIR"} {
			options.AgentEnvironment = append(options.AgentEnvironment, name+"=")
		}
		report, err := CheckReadiness(fixture.configPath, options)
		if err != nil || !report.Ready {
			t.Fatalf("readiness with empty forbidden environment = %#v, %v", report, err)
		}
	})
	t.Run("runtime defaults to the process environment", func(t *testing.T) {
		fixture := newAuthzFixture(t)
		t.Setenv("QDM_METRIC_CLI", fixture.publicMetricPath)
		for _, name := range []string{"QDM_CMR_CLI", "QDM_SQL_CLI", "QDM_CAS_CLI", "QDM_CAS_CONFIG_DIR"} {
			t.Setenv(name, "")
		}
		options := fixture.readinessOptions()
		options.AgentEnvironment = nil
		report, err := CheckReadiness(fixture.configPath, options)
		if err != nil || !report.Ready {
			t.Fatalf("readiness with process environment = %#v, %v", report, err)
		}
	})
}

func TestShippedAuthorizedAgentConfigsMatchReadinessContract(t *testing.T) {
	repositoryRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	for _, agent := range []string{"pi", "claude", "codex", "qwen"} {
		t.Run(agent, func(t *testing.T) {
			source := filepath.Join(repositoryRoot, ".agents", agent)
			if err := validateSelectedAgentConfig(source, agent); err != nil {
				t.Fatalf("shipped %s config is invalid: %v", agent, err)
			}
		})
	}
}

func TestParentDirectorySymlinkIsRejected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires platform privileges")
	}
	fixture := newAuthzFixture(t)
	realDirectory := filepath.Join(fixture.root, "real-parent")
	if err := os.Mkdir(realDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	realPath := filepath.Join(realDirectory, "artifact")
	writeTestFile(t, realPath, []byte("artifact"), 0o700)
	linkDirectory := filepath.Join(fixture.root, "linked-parent")
	if err := os.Symlink(realDirectory, linkDirectory); err != nil {
		t.Fatal(err)
	}
	_, err := VerifyArtifact(filepath.Join(linkDirectory, "artifact"), sha256Hex([]byte("artifact")), true)
	assertAuthzCode(t, err, CodeArtifactIntegrityFailed)
}

func (fixture *authzFixture) writeRawEnvelope(t *testing.T, raw []byte) {
	t.Helper()
	name, err := SessionFileName(fixture.sessionID)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(fixture.contextDir, name), raw, 0o600)
}

func assertAuthzCode(t *testing.T, err error, expected Code) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got nil", expected)
	}
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != expected {
		t.Fatalf("error = %v, code = %s, want %s", err, ErrorCode(err), expected)
	}
}

func TestCanonicalBindingJSONHasNoAlternateWhitespace(t *testing.T) {
	fixture := newAuthzFixture(t)
	loaded, err := ReadEnvelope(fixture.config, fixture.sessionID, WithNow(fixture.now))
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalBindingJSON(NewBinding(loaded))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.ContainsAny(canonical, " \n\t") {
		t.Fatalf("binding is not compact JCS: %q", canonical)
	}
}
