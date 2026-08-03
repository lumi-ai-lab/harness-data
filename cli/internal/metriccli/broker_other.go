//go:build !linux

package metriccli

import (
	"errors"
	"net"
)

func currentEffectiveUID() uint32 {
	return 0
}

func peerEffectiveUID(*net.UnixConn) (uint32, error) {
	return 0, errors.New("trusted peer credentials require Linux")
}

func prepareBrokerSocketDirectory(string, uint32) error {
	return errors.New("qdm-metric-cli broker requires Linux")
}
