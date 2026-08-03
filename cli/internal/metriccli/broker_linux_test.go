//go:build linux

package metriccli

import (
	"net"
	"path/filepath"
	"testing"
)

func TestPeerEffectiveUIDUsesKernelCredentials(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "broker.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	clientReady := make(chan error, 1)
	go func() {
		connection, dialErr := net.DialUnix(
			"unix",
			nil,
			&net.UnixAddr{Name: socketPath, Net: "unix"},
		)
		if dialErr == nil {
			_ = connection.Close()
		}
		clientReady <- dialErr
	}()

	connection, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	peerUID, err := peerEffectiveUID(connection)
	if err != nil {
		t.Fatal(err)
	}
	if peerUID != currentTestUID() {
		t.Fatalf("peer UID = %d, want %d", peerUID, currentTestUID())
	}
	if err := <-clientReady; err != nil {
		t.Fatal(err)
	}
}
