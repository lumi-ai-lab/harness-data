//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package metriccli

import "os"

func currentTestUID() uint32 {
	return uint32(os.Geteuid())
}
