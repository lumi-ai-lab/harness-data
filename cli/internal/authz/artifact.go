package authz

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
)

// VerifyArtifact hashes the exact safely opened regular file and compares it
// with the deployment-pinned lowercase SHA-256 digest.
func VerifyArtifact(path, expectedSHA string, requireExecutable bool) (ArtifactInfo, error) {
	if err := validateAbsoluteCleanPath(path); err != nil || !lowercaseSHA256Pattern.MatchString(expectedSHA) {
		return ArtifactInfo{}, authzError(CodeArtifactIntegrityFailed, "artifact verification parameters are invalid", err)
	}
	file, info, err := openRegularFile(path)
	if err != nil {
		return ArtifactInfo{}, authzError(CodeArtifactIntegrityFailed, "artifact cannot be read safely", err)
	}
	defer file.Close()
	if requireExecutable && info.Mode().Perm()&0o111 == 0 {
		return ArtifactInfo{}, authzError(CodeArtifactIntegrityFailed, "artifact is not executable", nil)
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return ArtifactInfo{}, authzError(CodeArtifactIntegrityFailed, "artifact cannot be hashed", err)
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expectedSHA {
		return ArtifactInfo{}, authzError(CodeArtifactIntegrityFailed, "artifact digest does not match", nil)
	}
	return ArtifactInfo{SHA256: actual, Size: size}, nil
}
