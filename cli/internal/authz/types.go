// Package authz implements the strict Lumi requester-context contract used by
// Harness authorization adapters and the Indicators facade.
package authz

import (
	"errors"
	"time"
)

const (
	DefaultConfigPath = "/etc/harness-data/authz.json"
	CurrentVersion    = 1
	RequiredPiVersion = "0.81.1"

	ModeLumiMVPRequired = "lumi-mvp-required"
	ModeDisabledDeny    = "disabled-deny"

	CapabilityIndicatorsQuery = "qdm.indicators.query"
)

// Error codes are stable machine-readable authorization failure categories.
type Code string

const (
	CodeConfigInvalid           Code = "authz_config_invalid"
	CodeBindingMissing          Code = "authz_binding_missing"
	CodeBindingInvalid          Code = "authz_binding_invalid"
	CodeBindingMismatch         Code = "authz_binding_mismatch"
	CodeRequesterContextInvalid Code = "requester_context_invalid"
	CodeRequesterContextExpired Code = "requester_context_expired"
	CodeCapabilityDenied        Code = "capability_denied"
	CodeScopeEmpty              Code = "scope_empty"
	CodeArtifactIntegrityFailed Code = "artifact_integrity_failed"
	CodeKillSwitchActive        Code = "kill_switch_active"
)

// Error wraps an authorization error without changing its stable code.
type Error struct {
	Code    Code
	Message string
	Err     error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return e.Message
	}
	if e.Err != nil {
		return e.Err.Error()
	}
	return string(e.Code)
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func authzError(code Code, message string, err error) error {
	return &Error{Code: code, Message: message, Err: err}
}

// ErrorCode returns the stable code attached to err, if any.
func ErrorCode(err error) Code {
	var target *Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

// Config is the root-owned authorization runtime configuration.
type Config struct {
	Version                  int                     `json:"version"`
	Mode                     string                  `json:"mode"`
	PiVersion                string                  `json:"piVersion"`
	RequesterContextDir      string                  `json:"requesterContextDir"`
	MaxEnvelopeBytes         int64                   `json:"maxEnvelopeBytes"`
	MaxEnvelopeTTLSeconds    int64                   `json:"maxEnvelopeTtlSeconds"`
	ClockSkewSeconds         int64                   `json:"clockSkewSeconds"`
	RealIndicatorsCLI        RealIndicatorsCLIConfig `json:"realIndicatorsCli"`
	ApprovedIndicatorCatalog ArtifactConfig          `json:"approvedIndicatorCatalog"`
	KillSwitch               KillSwitchConfig        `json:"killSwitch"`
	Limits                   LimitsConfig            `json:"limits"`
}

type RealIndicatorsCLIConfig struct {
	Path           string `json:"path"`
	Version        string `json:"version"`
	ArtifactSHA256 string `json:"artifactSha256"`
	ConfigDir      string `json:"configDir"`
}

type ArtifactConfig struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type KillSwitchConfig struct {
	ControlPath      string `json:"controlPath"`
	PollMilliseconds int64  `json:"pollMilliseconds"`
}

type LimitsConfig struct {
	MaxDateRangeDays     int64 `json:"maxDateRangeDays"`
	MaxIndicators        int64 `json:"maxIndicators"`
	MaxDimensions        int64 `json:"maxDimensions"`
	DefaultPageSize      int64 `json:"defaultPageSize"`
	MaxPageSize          int64 `json:"maxPageSize"`
	DefaultMetadataLimit int64 `json:"defaultMetadataLimit"`
	MaxMetadataLimit     int64 `json:"maxMetadataLimit"`
	TimeoutSeconds       int64 `json:"timeoutSeconds"`
	MaxOutputBytes       int64 `json:"maxOutputBytes"`
}

// RequesterContext mirrors Lumi RequesterContext V1 exactly.
type RequesterContext struct {
	Version        int           `json:"version"`
	RequestID      string        `json:"requestId"`
	PolicyRevision string        `json:"policyRevision"`
	Principal      Principal     `json:"principal"`
	Audience       Audience      `json:"audience"`
	Authorization  Authorization `json:"authorization"`
}

type Principal struct {
	Channel         string `json:"channel"`
	BotID           string `json:"botId"`
	CanonicalUserID string `json:"canonicalUserId"`
	DisplayName     string `json:"displayName"`
}

type Audience struct {
	ChatID   string `json:"chatId"`
	ChatType string `json:"chatType"`
}

type Authorization struct {
	Capabilities []string `json:"capabilities"`
	Scope        Scope    `json:"scope"`
}

type Scope struct {
	ManageAreaIDs     []string `json:"manageAreaIds"`
	CategoryLevel1IDs []string `json:"categoryLevel1Ids"`
}

// Envelope is the exact Lumi session file payload.
type Envelope struct {
	Version          int              `json:"version"`
	WorkspaceID      string           `json:"workspaceId"`
	AgentID          string           `json:"agentId"`
	SessionID        string           `json:"sessionId"`
	IssuedAt         time.Time        `json:"issuedAt"`
	ExpiresAt        time.Time        `json:"expiresAt"`
	RequesterContext RequesterContext `json:"requesterContext"`
}

// LoadedEnvelope contains only the validated typed envelope and stable
// digests. Raw envelope bytes and paths are intentionally not exposed.
type LoadedEnvelope struct {
	Envelope           Envelope
	SHA256             string
	ContextFingerprint string
	ControlGeneration  uint64
}

// Binding is HarnessAuthzBinding V1.
type Binding struct {
	Version        int       `json:"version"`
	SessionID      string    `json:"sessionId"`
	RequestID      string    `json:"requestId"`
	EnvelopeSHA256 string    `json:"envelopeSha256"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

// Summary is the intentionally limited model-visible authorization summary.
type Summary struct {
	Channel           string   `json:"channel"`
	BotID             string   `json:"botId"`
	CanonicalUserID   string   `json:"canonicalUserId"`
	ManageAreaIDs     []string `json:"manageAreaIds"`
	CategoryLevel1IDs []string `json:"categoryLevel1Ids"`
}

// BindResult is returned by the authz-bind helper. It does not contain the raw
// requester envelope, context file path, chat ID, display name, or credentials.
type BindResult struct {
	Binding            Binding   `json:"binding"`
	BindingBase64URL   string    `json:"bindingBase64url"`
	Summary            Summary   `json:"summary"`
	ContextFingerprint string    `json:"contextFingerprint"`
	IssuedAt           time.Time `json:"issuedAt"`
}

// ControlState is the host-owned dynamic authorization control document.
type ControlState struct {
	Version    int       `json:"version"`
	Generation uint64    `json:"generation"`
	State      string    `json:"state"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

func (state ControlState) Enabled() bool { return state.State == "enabled" }

// ArtifactInfo is returned after digesting the exact regular file opened.
type ArtifactInfo struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type ReadinessOptions struct {
	// ExpectedOwnerUID defaults to 0 on platforms that expose Unix ownership.
	// Tests may set it to the current temporary-file owner.
	ExpectedOwnerUID   *uint32
	RuntimeRoot        string
	InstallerStatePath string
	PublicFacadePath   string
	HarnessConfigPath  string
	CLIPathsEnvPath    string
	// AgentPath overrides PATH for deterministic tests. Runtime callers leave
	// it empty so readiness audits the actual Agent-visible PATH.
	AgentPath string
	// AgentEnvironment overrides the process environment for deterministic
	// tests. A nil slice audits os.Environ at runtime; an explicitly empty slice
	// represents an Agent with no environment variables.
	AgentEnvironment []string
	Now              time.Time
}

// FileSecurityOptions controls reusable owner/mode checks. A nil owner means
// root (UID 0) on platforms that expose Unix ownership.
type FileSecurityOptions struct {
	ExpectedOwnerUID  *uint32
	RequireExecutable bool
	Private           bool
}

type ReadinessReport struct {
	Ready             bool      `json:"ready"`
	Mode              string    `json:"mode"`
	PiVersion         string    `json:"piVersion"`
	ControlGeneration uint64    `json:"controlGeneration"`
	ControlUpdatedAt  time.Time `json:"controlUpdatedAt"`
}
