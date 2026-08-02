package authz

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func openRegularFile(path string) (*os.File, fs.FileInfo, error) {
	if err := rejectSymlinkPathComponents(path); err != nil {
		return nil, nil, err
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	if before.Mode()&os.ModeSymlink != 0 {
		return nil, nil, fmt.Errorf("path is a symbolic link")
	}
	if !before.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("path is not a regular file")
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	after, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, nil, err
	}
	if !after.Mode().IsRegular() || !os.SameFile(before, after) {
		_ = file.Close()
		return nil, nil, fmt.Errorf("file changed while opening")
	}
	return file, after, nil
}

// rejectSymlinkPathComponents prevents an otherwise regular final file from
// being reached through a symlinked parent directory. All deployment paths are
// absolute and fixed, so following a parent alias is never required.
func rejectSymlinkPathComponents(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fmt.Errorf("path must be absolute and clean")
	}
	volume := filepath.VolumeName(path)
	remainder := strings.TrimPrefix(path, volume)
	current := volume + string(filepath.Separator)
	for _, component := range strings.FieldsFunc(remainder, func(r rune) bool {
		return r == '/' || r == '\\'
	}) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			if allowedDarwinSystemSymlink(current) {
				continue
			}
			return fmt.Errorf("path contains a symbolic link")
		}
	}
	return nil
}

func allowedDarwinSystemSymlink(path string) bool {
	if runtime.GOOS != "darwin" || path != "/etc" {
		return false
	}
	target, err := os.Readlink(path)
	return err == nil && target == "private/etc"
}

func readRegularFile(path string, maxBytes int64) ([]byte, fs.FileInfo, error) {
	if maxBytes <= 0 {
		return nil, nil, fmt.Errorf("maximum file size must be positive")
	}
	file, info, err := openRegularFile(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	if info.Size() > maxBytes {
		return nil, nil, fmt.Errorf("file exceeds maximum size")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, nil, fmt.Errorf("file exceeds maximum size")
	}
	return data, info, nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
