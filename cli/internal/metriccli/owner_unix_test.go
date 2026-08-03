//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package metriccli

import (
	"io/fs"
	"os"
	"syscall"
)

func currentTestUID() uint32 {
	return uint32(os.Geteuid())
}

func currentTestGID() uint32 {
	gid := uint32(os.Getegid())
	if gid == 0 {
		return 1
	}
	return gid
}

func currentTestFileGID(info fs.FileInfo) uint32 {
	return info.Sys().(*syscall.Stat_t).Gid
}
