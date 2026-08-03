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
	if config.RequesterContextReaderGID == nil {
		return FileSecurityOptions{}, fmt.Errorf("requester context reader group is not configured")
	}
	if *config.RequesterContextOwnerUID == agentUID {
		return FileSecurityOptions{}, fmt.Errorf("requester context owner must differ from the Agent UID")
	}
	return FileSecurityOptions{
		ExpectedOwnerUID: config.RequesterContextOwnerUID,
		ExpectedGroupGID: config.RequesterContextReaderGID,
	}, nil
}

func verifyRequesterContextDirectory(path string, security FileSecurityOptions, agentUID uint32) error {
	workspaceDir := filepath.Dir(path)
	contextRoot := filepath.Dir(workspaceDir)
	if err := verifyAncestorsNotControlledByAgent(filepath.Dir(contextRoot), agentUID); err != nil {
		return err
	}
	for _, directory := range []string{contextRoot, workspaceDir, path} {
		if err := VerifySecureDirectory(directory, security); err != nil {
			return err
		}
		info, err := os.Lstat(directory)
		if err != nil {
			return err
		}
		if permissions := info.Mode().Perm(); permissions != 0o710 {
			return fmt.Errorf("requester context directory %q mode is %04o, want 0710", directory, permissions)
		}
	}
	return nil
}

func verifyRequesterContextFile(info os.FileInfo, security FileSecurityOptions) error {
	if !info.Mode().IsRegular() {
		return fmt.Errorf("requester context file is not regular")
	}
	if err := checkOwner(info, expectedOwnerUID(security.ExpectedOwnerUID)); err != nil {
		return err
	}
	if err := checkGroup(info, security.ExpectedGroupGID); err != nil {
		return err
	}
	if permissions := info.Mode().Perm(); permissions != 0o640 {
		return fmt.Errorf("requester context file mode is %04o, want 0640", permissions)
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
