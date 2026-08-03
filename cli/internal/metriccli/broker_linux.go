//go:build linux

package metriccli

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"

	"harness-data/cli/internal/authz"
)

func currentEffectiveUID() uint32 {
	return uint32(os.Geteuid())
}

func peerEffectiveUID(connection *net.UnixConn) (uint32, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return 0, err
	}
	var (
		credentials *syscall.Ucred
		socketErr   error
	)
	if err := raw.Control(func(fd uintptr) {
		credentials, socketErr = syscall.GetsockoptUcred(
			int(fd),
			syscall.SOL_SOCKET,
			syscall.SO_PEERCRED,
		)
	}); err != nil {
		return 0, err
	}
	if socketErr != nil {
		return 0, socketErr
	}
	if credentials == nil || credentials.Uid == ^uint32(0) {
		return 0, fmt.Errorf("Unix peer credentials are unavailable")
	}
	return credentials.Uid, nil
}

func prepareBrokerSocketDirectory(socketPath string, expectedOwnerUID uint32) error {
	if !filepath.IsAbs(socketPath) || filepath.Clean(socketPath) != socketPath {
		return fmt.Errorf("qdm-metric-cli broker socket path must be absolute and clean")
	}
	directory := filepath.Dir(socketPath)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	owner := expectedOwnerUID
	if err := authz.VerifySecureDirectory(directory, authz.FileSecurityOptions{ExpectedOwnerUID: &owner}); err != nil {
		return fmt.Errorf("qdm-metric-cli broker socket directory is insecure: %w", err)
	}
	return nil
}
