package authz

const maxControlBytes int64 = 64 << 10

// ReadControl strictly reads the host-owned V1 kill-switch document. A valid
// disabled state is returned to the caller; missing or malformed state fails.
func ReadControl(config Config) (ControlState, error) {
	if err := config.Validate(); err != nil {
		return ControlState{}, err
	}
	data, _, err := readRegularFile(config.KillSwitch.ControlPath, maxControlBytes)
	if err != nil {
		return ControlState{}, authzError(CodeKillSwitchActive, "authorization control state cannot be read safely", err)
	}
	var state ControlState
	if err := decodeStrictJSON(data, &state); err != nil {
		return ControlState{}, authzError(CodeKillSwitchActive, "authorization control state is invalid", err)
	}
	if state.Version != CurrentVersion || state.Generation == 0 || state.UpdatedAt.IsZero() {
		return ControlState{}, authzError(CodeKillSwitchActive, "authorization control state is invalid", nil)
	}
	if state.State != "enabled" && state.State != "disabled" {
		return ControlState{}, authzError(CodeKillSwitchActive, "authorization control state is invalid", nil)
	}
	return state, nil
}
