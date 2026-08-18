//go:build windows

package agentauthz

import (
	"os"
	"path/filepath"
	"syscall"
)

const windowsCredentialOpenFlags = syscall.FILE_FLAG_OPEN_REPARSE_POINT | syscall.FILE_FLAG_BACKUP_SEMANTICS

func openCredentialFile(path string) (*os.File, error) {
	path = filepath.Clean(path)
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		h, attrs, err := openWindowsPath(dir)
		if err != nil {
			return nil, err
		}
		_ = syscall.CloseHandle(h)
		if attrs&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 || attrs&syscall.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return nil, syscall.ELOOP
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
	}
	h, attrs, err := openWindowsPath(path)
	if err != nil {
		return nil, err
	}
	if attrs&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = syscall.CloseHandle(h)
		return nil, syscall.ELOOP
	}
	return os.NewFile(uintptr(h), path), nil
}

func openWindowsPath(path string) (syscall.Handle, uint32, error) {
	h, err := syscall.CreateFile(
		syscall.StringToUTF16Ptr(path),
		syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		windowsCredentialOpenFlags,
		0,
	)
	if err != nil {
		return 0, 0, err
	}
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &info); err != nil {
		_ = syscall.CloseHandle(h)
		return 0, 0, err
	}
	return h, info.FileAttributes, nil
}
