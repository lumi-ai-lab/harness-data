package agentauthz

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"harness-data/cli/internal/harness"
)

const (
	EnvAuthBlob            = "HARNESS_AUTH_BLOB"
	EnvAuthBlobFile        = "HARNESS_AUTH_BLOB_FILE"
	EnvAuthUserID          = "HARNESS_AUTH_USER_ID"
	EnvRequesterContextDir = "LUMI_REQUESTER_CONTEXT_DIR"
	EncryptedBlobPrefix    = "qdm1enc."
	MaxCredentialBytes     = 1 << 20
)

type BlobSource string

const (
	BlobSourceEnv     BlobSource = "env"
	BlobSourceEnvFile BlobSource = "env_file"
	BlobSourceFile    BlobSource = "file"
)

type ResolvedBlob struct {
	Blob string
	// UserID is retained for compatibility with callers that inspect the
	// resolved source. It is never passed to qdm or used for authorization.
	UserID string
	Source BlobSource
}

type ResolveOptions struct {
	ProjectRoot string
	Config      harness.AuthzConfig
	Env         map[string]string
}

func ResolveAuthBlob(opts ResolveOptions) (ResolvedBlob, error) {
	env := opts.Env
	if env == nil {
		env = environMap()
	}

	if !opts.Config.LocalBlobAllowed() {
		return ResolvedBlob{}, fmt.Errorf("authz mode is on but local blob fallback is disabled (allow_local_blob=false)")
	}

	if blob := strings.TrimSpace(env[EnvAuthBlob]); blob != "" {
		if !IsEncryptedBlob(blob) {
			return ResolvedBlob{}, fmt.Errorf("HARNESS_AUTH_BLOB must be an encrypted qdm1enc blob")
		}
		return ResolvedBlob{Blob: blob, UserID: localUserID(env, opts.Config), Source: BlobSourceEnv}, nil
	}

	if path := strings.TrimSpace(env[EnvAuthBlobFile]); path != "" {
		blob, err := readBlobFile(opts.ProjectRoot, path)
		if err != nil {
			return ResolvedBlob{}, err
		}
		return ResolvedBlob{Blob: blob, UserID: localUserID(env, opts.Config), Source: BlobSourceEnvFile}, nil
	}

	if path := strings.TrimSpace(opts.Config.BlobFile); path != "" {
		blob, err := readBlobFile(opts.ProjectRoot, path)
		if err != nil {
			return ResolvedBlob{}, err
		}
		userID := strings.TrimSpace(opts.Config.DevUserID)
		return ResolvedBlob{Blob: blob, UserID: userID, Source: BlobSourceFile}, nil
	}

	return ResolvedBlob{}, fmt.Errorf("authz mode is on but no encrypted blob is available (HARNESS_AUTH_BLOB, HARNESS_AUTH_BLOB_FILE, or authz.blob_file)")
}

func IsEncryptedBlob(value string) bool {
	return strings.HasPrefix(strings.TrimSpace(value), EncryptedBlobPrefix)
}

func localUserID(env map[string]string, cfg harness.AuthzConfig) string {
	if userID := strings.TrimSpace(env[EnvAuthUserID]); userID != "" {
		return userID
	}
	return strings.TrimSpace(cfg.DevUserID)
}

func readBlobFile(projectRoot, pathValue string) (string, error) {
	pathValue = strings.TrimSpace(pathValue)
	if pathValue == "" {
		return "", fmt.Errorf("auth blob file path is empty")
	}
	absolute := pathValue
	if !filepath.IsAbs(absolute) {
		absolute = filepath.Join(projectRoot, filepath.FromSlash(pathValue))
	}
	file, err := openCredentialFile(absolute)
	if err != nil {
		return "", fmt.Errorf("auth blob file unavailable: %s", absolute)
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() {
		return "", fmt.Errorf("auth blob file must be a regular file: %s", absolute)
	}
	if runtime.GOOS != "windows" && before.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("auth blob file permissions must be 0600: %s", absolute)
	}
	if before.Size() > MaxCredentialBytes {
		return "", fmt.Errorf("auth blob file exceeds maximum size: %s", absolute)
	}
	data, err := io.ReadAll(io.LimitReader(file, MaxCredentialBytes+1))
	if err != nil {
		return "", fmt.Errorf("auth blob file unavailable: %s", absolute)
	}
	if len(data) > MaxCredentialBytes {
		return "", fmt.Errorf("auth blob file exceeds maximum size: %s", absolute)
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || before.Mode() != after.Mode() || !before.ModTime().Equal(after.ModTime()) {
		return "", fmt.Errorf("auth blob file changed while reading: %s", absolute)
	}
	blob := strings.TrimSpace(string(data))
	if blob == "" {
		return "", fmt.Errorf("auth blob file is empty: %s", absolute)
	}
	if !IsEncryptedBlob(blob) {
		return "", fmt.Errorf("auth blob file must contain a qdm1enc blob: %s", absolute)
	}
	return blob, nil
}

func environMap() map[string]string {
	out := map[string]string{}
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			out[key] = value
		}
	}
	return out
}
