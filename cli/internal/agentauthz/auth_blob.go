package agentauthz

import (
	"fmt"
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
)

type BlobSource string

const (
	BlobSourceEnv     BlobSource = "env"
	BlobSourceEnvFile BlobSource = "env_file"
	BlobSourceFile    BlobSource = "file"
)

type ResolvedBlob struct {
	Blob   string
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
		userID := localUserID(env, opts.Config)
		if userID == "" {
			return ResolvedBlob{}, fmt.Errorf("authz local blob requires HARNESS_AUTH_USER_ID or authz.dev_user_id")
		}
		return ResolvedBlob{Blob: blob, UserID: userID, Source: BlobSourceEnv}, nil
	}

	if path := strings.TrimSpace(env[EnvAuthBlobFile]); path != "" {
		blob, err := readBlobFile(opts.ProjectRoot, path)
		if err != nil {
			return ResolvedBlob{}, err
		}
		userID := localUserID(env, opts.Config)
		if userID == "" {
			return ResolvedBlob{}, fmt.Errorf("authz local blob requires HARNESS_AUTH_USER_ID or authz.dev_user_id")
		}
		return ResolvedBlob{Blob: blob, UserID: userID, Source: BlobSourceEnvFile}, nil
	}

	if path := strings.TrimSpace(opts.Config.BlobFile); path != "" {
		blob, err := readBlobFile(opts.ProjectRoot, path)
		if err != nil {
			return ResolvedBlob{}, err
		}
		userID := strings.TrimSpace(opts.Config.DevUserID)
		if userID == "" {
			return ResolvedBlob{}, fmt.Errorf("authz.blob_file requires authz.dev_user_id (no default principal)")
		}
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
	info, err := os.Lstat(absolute)
	if err != nil {
		return "", fmt.Errorf("auth blob file not found: %s", absolute)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", fmt.Errorf("auth blob file must be a regular file: %s", absolute)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		return "", fmt.Errorf("auth blob file permissions must be 0600: %s", absolute)
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return "", fmt.Errorf("auth blob file not found: %s", absolute)
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
