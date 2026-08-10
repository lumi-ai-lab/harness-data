package sessionstate

import (
	"strings"
	"testing"
)

func TestSafeSessionIDPreservesCommonIDs(t *testing.T) {
	for _, sessionID := range []string{
		"550e8400-e29b-41d4-a716-446655440000",
		"session_01.example",
		"unknown",
	} {
		if got := SafeSessionID(sessionID); got != sessionID {
			t.Fatalf("SafeSessionID(%q) = %q", sessionID, got)
		}
	}
}

func TestSafeSessionIDHashesUnsafeAndAmbiguousIDs(t *testing.T) {
	unsafe := SafeSessionID("workbuddy:foo")
	lookalike := SafeSessionID("workbuddy_foo")
	if unsafe == lookalike {
		t.Fatalf("unsafe and plain IDs collided at %q", unsafe)
	}
	if !strings.HasPrefix(unsafe, "sha256~") || len(unsafe) != len("sha256~")+64 {
		t.Fatalf("unexpected hashed ID %q", unsafe)
	}
	if got := SafeSessionID("workbuddy:foo"); got != unsafe {
		t.Fatalf("hash is not deterministic: %q != %q", got, unsafe)
	}

	for _, sessionID := range []string{
		"abc:def",
		"a/b",
		strings.Repeat("a", maxPlainSessionIDLength+1),
		"CON",
		"com1.json",
	} {
		if got := SafeSessionID(sessionID); !strings.HasPrefix(got, "sha256~") {
			t.Errorf("SafeSessionID(%q) = %q, want hashed filename", sessionID, got)
		}
	}
}

func TestSafeSessionIDHashedMarkerCannotCollideWithPlainInput(t *testing.T) {
	hashed := SafeSessionID("a/b")
	if got := SafeSessionID(hashed); got == hashed {
		t.Fatalf("hash-like caller input must be re-hashed, got %q", got)
	}
}
