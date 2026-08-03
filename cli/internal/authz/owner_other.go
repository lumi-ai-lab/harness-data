//go:build !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package authz

import "io/fs"

func fileOwnerUID(fs.FileInfo) (uint32, bool) { return 0, false }

func currentProcessOwnerUID() uint32 { return 0 }

func fileOwnershipSupported() bool { return false }
