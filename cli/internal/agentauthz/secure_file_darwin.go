//go:build darwin

package agentauthz

import (
	"os"
	"path/filepath"
	"syscall"
)

func openCredentialFile(path string) (*os.File, error) {
	path = filepath.Clean(path)
	dir, base := filepath.Split(path)
	dirInfo, err := os.Lstat(filepath.Clean(dir))
	if err != nil || dirInfo.Mode()&os.ModeSymlink != 0 || !dirInfo.IsDir() {
		return nil, syscall.ELOOP
	}
	root, err := os.OpenRoot(filepath.Clean(dir))
	if err != nil {
		return nil, err
	}
	defer root.Close()
	openedInfo, err := root.Stat(".")
	if err != nil || !os.SameFile(dirInfo, openedInfo) {
		return nil, syscall.ELOOP
	}
	targetInfo, err := root.Lstat(base)
	if err != nil || targetInfo.Mode()&os.ModeSymlink != 0 || !targetInfo.Mode().IsRegular() {
		return nil, syscall.ELOOP
	}
	file, err := root.Open(base)
	if err != nil {
		return nil, err
	}
	openedTarget, err := file.Stat()
	if err != nil || !os.SameFile(targetInfo, openedTarget) {
		_ = file.Close()
		return nil, syscall.ELOOP
	}
	return file, nil
}
