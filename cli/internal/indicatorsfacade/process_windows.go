//go:build windows

package indicatorsfacade

import "os/exec"

func configureProcessGroup(command *exec.Cmd) {}

func killProcessGroup(command *exec.Cmd) {
	if command == nil || command.Process == nil {
		return
	}
	_ = command.Process.Kill()
}
