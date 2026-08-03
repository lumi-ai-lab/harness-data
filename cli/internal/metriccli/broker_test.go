package metriccli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateBrokerRequestRejectsUnsupportedShapes(t *testing.T) {
	valid := brokerRequest{
		Version:   brokerProtocolVersion,
		Operation: "execute",
		Args:      []string{"version"},
		Binding:   "binding",
	}
	if err := validateBrokerRequest(valid); err != nil {
		t.Fatalf("valid broker request rejected: %v", err)
	}

	tests := map[string]brokerRequest{
		"version": {
			Version: brokerProtocolVersion + 1, Operation: "execute",
		},
		"operation": {
			Version: brokerProtocolVersion, Operation: "unknown",
		},
		"health payload": {
			Version: brokerProtocolVersion, Operation: "health", Binding: "unexpected",
		},
		"NUL argument": {
			Version: brokerProtocolVersion, Operation: "execute", Args: []string{"bad\x00arg"},
		},
		"raw payload file": {
			Version: brokerProtocolVersion, Operation: "execute",
			Args: []string{"analysis", "execute", "--payload", "/etc/shadow"},
		},
		"oversized stdin": {
			Version: brokerProtocolVersion, Operation: "execute",
			Stdin: bytes.Repeat([]byte("x"), maxBrokerStdinBytes+1),
		},
		"oversized binding": {
			Version: brokerProtocolVersion, Operation: "execute",
			Binding: strings.Repeat("x", maxBrokerBindingBytes+1),
		},
		"oversized aggregate arguments": {
			Version: brokerProtocolVersion, Operation: "execute",
			Args: []string{
				strings.Repeat("x", maxBrokerArgumentBytes),
				strings.Repeat("y", maxBrokerArgumentTotalBytes-maxBrokerArgumentBytes+1),
			},
		},
	}
	for name, request := range tests {
		t.Run(name, func(t *testing.T) {
			if err := validateBrokerRequest(request); err == nil {
				t.Fatal("expected broker request to be rejected")
			}
		})
	}
}

func TestInlineClientPayloadFileRemovesAgentPath(t *testing.T) {
	payloadPath := filepath.Join(t.TempDir(), "payload.json")
	payload := `{"metrics":["saleAmt"]}`
	if err := os.WriteFile(payloadPath, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	args, err := inlineClientPayloadFile([]string{
		"analysis", "execute", "--payload", payloadPath, "--format", "json",
	})
	if err != nil {
		t.Fatal(err)
	}
	if containsPayloadFileArgument(args) {
		t.Fatalf("inlined broker arguments still contain an Agent file path: %v", args)
	}
	if len(args) != 6 ||
		args[2] != "--payload-json" ||
		args[3] != payload ||
		args[4] != "--format" ||
		args[5] != "json" {
		t.Fatalf("unexpected inlined payload arguments: %v", args)
	}
}

func TestReadBoundedInputRejectsOversizedPayload(t *testing.T) {
	if _, err := readBoundedInput(strings.NewReader("12345"), 4); err == nil {
		t.Fatal("expected oversized broker stdin to be rejected")
	}
}

func TestDecodeBrokerMessageRejectsTrailingOrOversizedInput(t *testing.T) {
	for name, input := range map[string]string{
		"multiple values": `{"version":1}{"version":1}`,
		"unknown field":   `{"version":1,"unexpected":true}`,
		"oversized":       `{"version":1} `,
	} {
		t.Run(name, func(t *testing.T) {
			var request brokerRequest
			limit := int64(len(input))
			if name == "oversized" {
				limit--
			}
			if err := decodeBrokerMessage(strings.NewReader(input), limit, &request); err == nil {
				t.Fatal("expected broker message to be rejected")
			}
		})
	}
}

func TestBrokerRequestConcurrencyLimit(t *testing.T) {
	slots := make(chan struct{}, maxBrokerConcurrentRequests)
	for index := 0; index < maxBrokerConcurrentRequests; index++ {
		if !tryAcquireBrokerRequest(slots) {
			t.Fatalf("request slot %d was rejected before reaching the limit", index)
		}
	}
	if tryAcquireBrokerRequest(slots) {
		t.Fatal("request beyond the broker concurrency limit was accepted")
	}
	releaseBrokerRequest(slots)
	if !tryAcquireBrokerRequest(slots) {
		t.Fatal("released broker request slot was not reusable")
	}
}

func TestVerifyBrokerRuntimeRequiresReaderScopedConfig(t *testing.T) {
	fixture := newWrapperFixture(t)
	if err := verifyBrokerRuntime(fixture.configPath, fixture.ownerUID); err != nil {
		t.Fatalf("reader-scoped config was rejected: %v", err)
	}
	for _, mode := range []os.FileMode{0o600, 0o644} {
		if err := os.Chmod(fixture.configPath, mode); err != nil {
			t.Fatal(err)
		}
		if err := verifyBrokerRuntime(fixture.configPath, fixture.ownerUID); err == nil {
			t.Fatalf("config mode %04o was accepted", mode)
		}
	}
}
