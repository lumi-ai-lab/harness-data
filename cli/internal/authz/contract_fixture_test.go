package authz

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestLumiEnvelopeV1RequesterContextV2ContractFixture(t *testing.T) {
	payload, err := os.ReadFile(filepath.Join("testdata", "lumi-envelope-v1-context-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	const fixtureSHA256 = "14106c8d6846f5520cdde2ca085714615ef0e99285258f1492f890ed578161e2"
	if got := sha256Hex(payload); got != fixtureSHA256 {
		t.Fatalf("fixture SHA-256 = %s, want producer output %s", got, fixtureSHA256)
	}

	fixture := newAuthzFixture(t)
	fixture.sessionID = "session-demo-001"
	fixture.now = time.Date(2026, 8, 3, 3, 1, 0, 0, time.UTC)
	fixture.writeRawEnvelope(t, payload)

	loaded, err := ReadEnvelope(fixture.config, fixture.sessionID, fixture.readOptions()...)
	if err != nil {
		t.Fatalf("ReadEnvelope(Lumi contract fixture) error = %v", err)
	}
	envelope := loaded.Envelope
	if envelope.Version != CurrentEnvelopeVersion {
		t.Fatalf("envelope version = %d, want %d", envelope.Version, CurrentEnvelopeVersion)
	}
	if envelope.RequesterContext.Version != CurrentRequesterContextVersion {
		t.Fatalf("requester context version = %d, want %d", envelope.RequesterContext.Version, CurrentRequesterContextVersion)
	}
	if envelope.WorkspaceID != "sandbox-workspace-demo" || envelope.AgentID != "pi" || envelope.SessionID != "session-demo-001" {
		t.Fatalf("envelope binding = %#v", envelope)
	}
	policyPayload, err := os.ReadFile(filepath.Join("testdata", "lumi-wecom-requesters-v2.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantPolicyRevision := "sha256:" + sha256Hex(policyPayload)
	if envelope.RequesterContext.PolicyRevision != wantPolicyRevision {
		t.Fatalf("policy revision = %s, want %s", envelope.RequesterContext.PolicyRevision, wantPolicyRevision)
	}

	wantCapabilities := []string{CapabilityMetricQuery}
	if !reflect.DeepEqual(envelope.RequesterContext.Authorization.Capabilities, wantCapabilities) {
		t.Fatalf("capabilities = %#v, want %#v", envelope.RequesterContext.Authorization.Capabilities, wantCapabilities)
	}
	scope := envelope.RequesterContext.Authorization.Scope
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
