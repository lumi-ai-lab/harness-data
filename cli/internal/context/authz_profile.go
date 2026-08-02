package context

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"harness-data/cli/internal/harness"
)

const lumiMVPProfile = "lumi-mvp-required"

var lumiMVPConstraints = []string{
	"authorization_binding_required_for_every_qdm_indicators_cli_call",
	"use_only_qdm_indicators_cli_facade",
	"do_not_use_cmr_sql_cas_report_payload_preview_total_biz_thresh_or_config_token_commands",
	"do_not_refresh_or_modify_runtime_credentials",
}

type installerProfileState struct {
	SchemaVersion int    `json:"schemaVersion"`
	Profile       string `json:"profile"`
}

func isLumiMVPRequiredRuntime(root string) bool {
	data, err := os.ReadFile(filepath.Join(root, ".harness", "installer-state.json"))
	if err != nil {
		return false
	}
	var state installerProfileState
	if err := json.Unmarshal(data, &state); err != nil {
		return false
	}
	return state.SchemaVersion == 3 && state.Profile == lumiMVPProfile
}

func applyLumiMVPConstraints(response harness.ContextResponse) harness.ContextResponse {
	const authorizedGuidance = "Authorization deployment: use only qdm-indicators-cli through the configured Facade. Every invocation requires the current request binding, and the Facade applies final area/category authorization. CMR, SQL, CAS refresh, report CLI paths, raw payload, preview/total, --biz-thresh, and config/token commands are disabled. Never refresh or modify runtime credentials."
	response.Instruction = strings.ReplaceAll(response.Instruction, localCredentialGuidance, authorizedGuidance)
	constraints := make([]string, 0, len(response.Constraints)+len(lumiMVPConstraints))
	for _, constraint := range response.Constraints {
		if strings.Contains(constraint, "QDM_CAS_CLI") || strings.Contains(constraint, "token expired") {
			continue
		}
		constraints = append(constraints, constraint)
	}
	constraints = append(constraints, lumiMVPConstraints...)
	response.Constraints = constraints
	return response
}
