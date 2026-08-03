//go:build !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package metriccli

import "io/fs"

func currentTestUID() uint32 {
	return 0
}

func currentTestGID() uint32 { return 1 }

func currentTestFileGID(fs.FileInfo) uint32 { return 1 }
