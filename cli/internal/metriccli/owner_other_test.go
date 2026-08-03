//go:build !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package metriccli

func currentTestUID() uint32 {
	return 0
}
