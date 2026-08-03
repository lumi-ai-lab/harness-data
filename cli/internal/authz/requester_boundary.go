package authz

import (
	"fmt"
	"os"
	"path/filepath"
)

func requesterContextSecurity(config Config, agentUID uint32) (FileSecurityOptions, error) {
	if !fileOwnershipSupported() {
		return FileSecurityOptions{}, fmt.Errorf("requester context ownership cannot be enforced on this platform")
	}
	if agentUID == 0 {
		return FileSecurityOptions{}, fmt.Errorf("the Agent must not run as root")
	}
	if config.AgentUID == nil {
		return FileSecurityOptions{}, fmt.Errorf("the Agent UID is not configured")
	}
	if *config.AgentUID != agentUID {
		return FileSecurityOptions{}, fmt.Errorf("the caller UID does not match the configured Agent UID")
	}
	if config.RequesterContextOwnerUID == nil {
		return FileSecurityOptions{}, fmt.Errorf("requester context owner is not configured")
	}
	if *config.RequesterContextOwnerUID == agentUID {
		return FileSecurityOptions{}, fmt.Errorf("requester context owner must differ from the Agent UID")
	}
	return FileSecurityOptions{ExpectedOwnerUID: config.RequesterContextOwnerUID}, nil
}

func verifyRequesterContextDirectory(path string, security FileSecurityOptions, agentUID uint32) error {
	if err := verifyAncestorsNotControlledByAgent(filepath.Dir(path), agentUID); err != nil {
		return err
	}
	if err := VerifySecureDirectory(path, security); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	permissions := info.Mode().Perm()
	if permissions&0o066 != 0 {
		return fmt.Errorf("requester context directory must not be listable or writable by non-owners")
	}
	if permissions&0o011 == 0 {
		return fmt.Errorf("requester context directory is not searchable by the Agent")
	}
	return nil
}

func verifyRequesterContextFile(path string, security FileSecurityOptions) error {
	if err := VerifySecureRegularFile(path, security); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	permissions := info.Mode().Perm()
	if permissions&0o044 == 0 {
		return fmt.Errorf("requester context file is not readable by a non-owner")
	}
	if permissions&0o111 != 0 {
		return fmt.Errorf("requester context file must not be executable")
	}
	return nil
}

func verifyAncestorsNotControlledByAgent(path string, agentUID uint32) error {
	current := filepath.Clean(path)
	for {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("requester context parent is not a safe directory")
		}
		owner, available := fileOwnerUID(info)
		if !available {
			return fmt.Errorf("requester context parent ownership is unavailable")
		}
		if owner == agentUID {
			return fmt.Errorf("requester context parent is controlled by the Agent")
		}
		if info.Mode().Perm()&0o022 != 0 && info.Mode()&os.ModeSticky == 0 {
			return fmt.Errorf("requester context parent is group or world writable")
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}
