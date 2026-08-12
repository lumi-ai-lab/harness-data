package agentauthz

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"harness-data/cli/internal/harness"
)

const testBlob = "qdm1enc.testblob"

func TestResolveAuthBlobLocalFallbackDisabled(t *testing.T) {
	allow := false
	_, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: t.TempDir(),
		Config: harness.AuthzConfig{
			AllowLocalBlob: &allow,
		},
		Env: map[string]string{
			EnvAuthBlob:   testBlob,
			EnvAuthUserID: "local-user",
		},
	})
	if err == nil {
		t.Fatal("expected local fallback disabled error")
	}
}

func TestResolveAuthBlobReadsEnvBlob(t *testing.T) {
	resolved, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: t.TempDir(),
		Config:      harness.AuthzConfig{},
		Env: map[string]string{
			EnvAuthBlob:   testBlob,
			EnvAuthUserID: "env-user",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Source != BlobSourceEnv || resolved.Blob != testBlob || resolved.UserID != "env-user" {
		t.Fatalf("unexpected resolved env blob: %+v", resolved)
	}
}

func TestResolveAuthBlobReadsEnvBlobFile(t *testing.T) {
	root := t.TempDir()
	blobPath := filepath.Join(root, "admin-auth.blob")
	if err := os.WriteFile(blobPath, []byte(testBlob+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: root,
		Config:      harness.AuthzConfig{},
		Env: map[string]string{
			EnvAuthBlobFile: blobPath,
			EnvAuthUserID:   "env-user",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Source != BlobSourceEnvFile || resolved.Blob != testBlob || resolved.UserID != "env-user" {
		t.Fatalf("unexpected resolved env-file blob: %+v", resolved)
	}
}

func TestResolveAuthBlobReadsConfiguredFile(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "dev-auth.blob"), []byte(testBlob+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: root,
		Config: harness.AuthzConfig{
			BlobFile:  "config/dev-auth.blob",
			DevUserID: "local-user",
		},
		Env: map[string]string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Source != BlobSourceFile || resolved.Blob != testBlob || resolved.UserID != "local-user" {
		t.Fatalf("unexpected configured blob: %+v", resolved)
	}
}

func TestResolveAuthBlobEnvBlobPrioritizedOverConfigFile(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "dev-auth.blob"), []byte("qdm1enc.fileblob\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolved, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: root,
		Config: harness.AuthzConfig{
			BlobFile:  "config/dev-auth.blob",
			DevUserID: "file-user",
		},
		Env: map[string]string{
			EnvAuthBlob:   testBlob,
			EnvAuthUserID: "env-user",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Source != BlobSourceEnv || resolved.Blob != testBlob || resolved.UserID != "env-user" {
		t.Fatalf("expected env blob to take priority: %+v", resolved)
	}
}

func TestResolveAuthBlobNoBlobAvailable(t *testing.T) {
	_, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: t.TempDir(),
		Config:      harness.AuthzConfig{},
		Env:         map[string]string{},
	})
	if err == nil {
		t.Fatal("expected no blob available error")
	}
}

func TestResolveAuthBlobRejectsGroupReadableFile(t *testing.T) {
	root := t.TempDir()
	blobPath := filepath.Join(root, "admin-auth.blob")
	if err := os.WriteFile(blobPath, []byte(testBlob+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := ResolveAuthBlob(ResolveOptions{
		ProjectRoot: root,
		Config:      harness.AuthzConfig{},
		Env: map[string]string{
			EnvAuthBlobFile: blobPath,
			EnvAuthUserID:   "env-user",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "permissions must be 0600") {
		t.Fatalf("expected insecure permission error, got %v", err)
	}
}
