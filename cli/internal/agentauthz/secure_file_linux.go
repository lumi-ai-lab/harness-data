//go:build linux

package agentauthz

import (
	"os"
	"path/filepath"
	"syscall"
)

// Open every path component with O_NOFOLLOW, then keep the returned descriptor
// for stat and read so a path replacement cannot redirect the credential.
func openCredentialFile(path string) (*os.File, error) {
	path = filepath.Clean(path)
	dir, base := filepath.Split(path)
	start := "."
	if filepath.IsAbs(path) {
		start = string(filepath.Separator)
		dir = filepath.Clean(dir)
	} else {
		dir = filepath.Clean(dir)
	}
	fd, err := syscall.Open(start, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	closeDir := true
	defer func() {
		if closeDir {
			_ = syscall.Close(fd)
		}
	}()
	rel, err := filepath.Rel(start, dir)
	if err != nil {
		return nil, err
	}
	if rel != "." {
		for _, component := range splitPathComponents(rel) {
			next, openErr := syscall.Openat(fd, component, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
			if openErr != nil {
				return nil, openErr
			}
			_ = syscall.Close(fd)
			fd = next
		}
	}
	fileFD, err := syscall.Openat(fd, base, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	closeDir = false
	_ = syscall.Close(fd)
	return os.NewFile(uintptr(fileFD), path), nil
}

func splitPathComponents(path string) []string {
	components := make([]string, 0, 4)
	for path != "." && path != "" {
		base := filepath.Base(path)
		if base != "." && base != "" {
			components = append([]string{base}, components...)
		}
		path = filepath.Dir(path)
	}
	return components
}
