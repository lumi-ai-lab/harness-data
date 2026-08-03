//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package authz

import (
	"io/fs"
	"os"
	"syscall"
)

func fileOwnerUID(info fs.FileInfo) (uint32, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return stat.Uid, true
}

func fileGroupGID(info fs.FileInfo) (uint32, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return stat.Gid, true
}

func currentProcessOwnerUID() uint32 {
	return uint32(os.Geteuid())
}

func fileOwnershipSupported() bool { return true }
