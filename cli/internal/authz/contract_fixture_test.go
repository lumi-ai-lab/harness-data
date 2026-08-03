package authz

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type lumiContractEnvelope struct {
	Version          int                          `json:"version"`
	WorkspaceID      string                       `json:"workspaceId"`
	AgentID          string                       `json:"agentId"`
	SessionID        string                       `json:"sessionId"`
	IssuedAt         time.Time                    `json:"issuedAt"`
	ExpiresAt        time.Time                    `json:"expiresAt"`
	RequesterContext lumiContractRequesterContext `json:"requesterContext"`
}

type lumiContractRequesterContext struct {
	Version        int                       `json:"version"`
	RequestID      string                    `json:"requestId"`
	PolicyRevision string                    `json:"policyRevision"`
	Principal      Principal                 `json:"principal"`
	Audience       Audience                  `json:"audience"`
	Authorization  lumiContractAuthorization `json:"authorization"`
}

type lumiContractAuthorization struct {
	Capabilities []string                   `json:"capabilities"`
	Claims       map[string]json.RawMessage `json:"claims"`
}

type lumiQDMContractScope struct {
	SchemaVersion     int      `json:"schemaVersion"`
	ManageAreaIDs     []string `json:"manageAreaIds"`
	DCManageAreaIDs   []string `json:"dcManageAreaIds"`
	CategoryLevel1IDs []string `json:"categoryLevel1Ids"`
}

func TestLumiEnvelopeV1RequesterContextV2ContractFixture(t *testing.T) {
	payload, err := os.ReadFile(filepath.Join("testdata", "lumi-envelope-v1-context-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	const fixtureSHA256 = "99084e1f5fc77ad44e3bc5137744d1743e4fbdd532f795e2f7fbe73679018e18"
	if got := sha256Hex(payload); got != fixtureSHA256 {
		t.Fatalf("fixture SHA-256 = %s, want producer output %s", got, fixtureSHA256)
	}

	var envelope lumiContractEnvelope
	if err := decodeStrictJSON(payload, &envelope); err != nil {
		t.Fatalf("decode Lumi contract fixture: %v", err)
	}
	if envelope.Version != 1 {
		t.Fatalf("envelope version = %d, want 1", envelope.Version)
	}
	if envelope.RequesterContext.Version != 2 {
		t.Fatalf("requester context version = %d, want 2", envelope.RequesterContext.Version)
	}
	if envelope.WorkspaceID != "sandbox-workspace-demo" || envelope.AgentID != "pi" || envelope.SessionID != "session-demo-001" {
		t.Fatalf("envelope binding = %#v", envelope)
	}

	wantCapabilities := []string{"qdm.cmr.query", "qdm.indicators.query"}
	if !reflect.DeepEqual(envelope.RequesterContext.Authorization.Capabilities, wantCapabilities) {
		t.Fatalf("capabilities = %#v, want %#v", envelope.RequesterContext.Authorization.Capabilities, wantCapabilities)
	}
	claims := envelope.RequesterContext.Authorization.Claims
	if len(claims) != 1 {
		t.Fatalf("claims = %#v, want only qdm.scope", claims)
	}
	payload, ok := claims["qdm.scope"]
	if !ok {
		t.Fatal("qdm.scope claim is missing")
	}

	var scope lumiQDMContractScope
	if err := decodeStrictJSON(payload, &scope); err != nil {
		t.Fatalf("decode qdm.scope claim: %v", err)
	}
	if scope.SchemaVersion != 1 {
		t.Fatalf("qdm.scope schema version = %d, want 1", scope.SchemaVersion)
	}
	assertContractIDs(t, "manageAreaIds", scope.ManageAreaIDs, []string{"area-demo"})
	assertContractIDs(t, "dcManageAreaIds", scope.DCManageAreaIDs, []string{"dc-area-demo"})
	assertContractIDs(t, "categoryLevel1Ids", scope.CategoryLevel1IDs, []string{"category-demo"})
}

func assertContractIDs(t *testing.T, name string, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s = %#v, want %#v", name, got, want)
	}
}
