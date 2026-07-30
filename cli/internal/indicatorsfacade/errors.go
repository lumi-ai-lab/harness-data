package indicatorsfacade

import (
	"errors"
	"fmt"
)

// ErrorCode is a stable, user-safe reason for denying an invocation.
type ErrorCode string

const (
	CodeAuthzConfigInvalid        ErrorCode = "authz_config_invalid"
	CodeAuthzBindingMissing       ErrorCode = "authz_binding_missing"
	CodeAuthzBindingMismatch      ErrorCode = "authz_binding_mismatch"
	CodeRequesterContextInvalid   ErrorCode = "requester_context_invalid"
	CodeRequesterContextExpired   ErrorCode = "requester_context_expired"
	CodeCapabilityDenied          ErrorCode = "capability_denied"
	CodeScopeEmpty                ErrorCode = "scope_empty"
	CodeScopeOverreach            ErrorCode = "scope_overreach"
	CodeIndicatorNotApproved      ErrorCode = "indicator_not_approved"
	CodeIndicatorScopeUnsupported ErrorCode = "indicator_scope_unsupported"
	CodeCLISyntaxDenied           ErrorCode = "cli_syntax_denied"
	CodeArtifactIntegrityFailed   ErrorCode = "artifact_integrity_failed"
	CodeMetadataOutputInvalid     ErrorCode = "metadata_output_invalid"
	CodeExecutionLimitExceeded    ErrorCode = "execution_limit_exceeded"
	CodeKillSwitchActive          ErrorCode = "kill_switch_active"
	CodeRealCLIExecutionFailed    ErrorCode = "real_cli_execution_failed"
)

// Error deliberately keeps the user-facing message separate from the cause.
// Callers must never print Cause directly in an Agent-visible response.
type Error struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Message == "" {
		return string(e.Code)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Cause }

func deny(code ErrorCode, message string, cause error) error {
	return &Error{Code: code, Message: message, Cause: cause}
}

func CodeOf(err error) ErrorCode {
	var facadeErr *Error
	if errors.As(err, &facadeErr) {
		return facadeErr.Code
	}
	return CodeAuthzConfigInvalid
}
