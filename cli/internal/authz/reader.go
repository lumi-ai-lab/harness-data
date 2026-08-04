package authz

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gowebpki/jcs"
)

var policyRevisionPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type readSettings struct {
	now time.Time
}

// ReadOption customizes deterministic time validation in tests and callers.
type ReadOption func(*readSettings)

// WithNow fixes the current time used for envelope and binding validation.
func WithNow(now time.Time) ReadOption {
	return func(settings *readSettings) {
		settings.now = now
	}
}

// WithAgentUID is a no-op compatibility option. Lightweight authorization no
// longer treats a process UID as part of the requester contract.
func WithAgentUID(uid uint32) ReadOption {
	return func(settings *readSettings) {}
}

func resolveReadSettings(options []ReadOption) readSettings {
	settings := readSettings{
		now: time.Now().UTC(),
	}
	for _, option := range options {
		if option != nil {
			option(&settings)
		}
	}
	if settings.now.IsZero() {
		settings.now = time.Now().UTC()
	} else {
		settings.now = settings.now.UTC()
	}
	return settings
}

// SessionFileName returns the only permitted Lumi file name for the exact raw
// ACP session ID bytes.
func SessionFileName(sessionID string) (string, error) {
	if sessionID == "" {
		return "", authzError(CodeRequesterContextInvalid, "ACP session ID is required", nil)
	}
	if !utf8.ValidString(sessionID) || strings.ContainsRune(sessionID, 0) {
		return "", authzError(CodeRequesterContextInvalid, "ACP session ID is invalid", nil)
	}
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:]) + ".json", nil
}

// ReadEnvelope opens exactly sha256(raw session ID).json, strictly validates
// it, and returns its raw-file digest and canonical requester fingerprint.
func ReadEnvelope(config Config, sessionID string, options ...ReadOption) (LoadedEnvelope, error) {
	if err := config.Validate(); err != nil {
		return LoadedEnvelope{}, err
	}
	filename, err := SessionFileName(sessionID)
	if err != nil {
		return LoadedEnvelope{}, err
	}
	settings := resolveReadSettings(options)
	path := filepath.Join(config.RequesterContextDir, filename)
	data, info, err := readRegularFile(path, config.MaxEnvelopeBytes)
	if err != nil {
		return LoadedEnvelope{}, authzError(CodeRequesterContextInvalid, "requester context file cannot be read safely", err)
	}
	if !info.Mode().IsRegular() {
		return LoadedEnvelope{}, authzError(CodeRequesterContextInvalid, "requester context file is not regular", nil)
	}
	var envelope Envelope
	if err := decodeStrictJSON(data, &envelope); err != nil {
		return LoadedEnvelope{}, authzError(CodeRequesterContextInvalid, "requester context envelope is invalid", err)
	}
	if err := validateEnvelope(config, &envelope, sessionID, settings.now); err != nil {
		return LoadedEnvelope{}, err
	}
	fingerprint, err := ContextFingerprint(envelope.RequesterContext)
	if err != nil {
		return LoadedEnvelope{}, err
	}
	return LoadedEnvelope{
		Envelope:           envelope,
		SHA256:             sha256Hex(data),
		ContextFingerprint: fingerprint,
	}, nil
}

func validateEnvelope(config Config, envelope *Envelope, expectedSessionID string, now time.Time) error {
	invalid := func(message string) error {
		return authzError(CodeRequesterContextInvalid, message, nil)
	}
	if envelope.Version != CurrentEnvelopeVersion {
		return invalid("requester context envelope version must be 1")
	}
	if envelope.SessionID != expectedSessionID {
		return invalid("requester context session does not match")
	}
	if envelope.AgentID != config.RequesterContextAgentID {
		return invalid("requester context envelope agentId does not match")
	}
	if err := validateRequiredWireString(envelope.WorkspaceID); err != nil {
		return invalid("requester context envelope workspaceId is invalid")
	}
	// sessionId is an opaque ACP identifier. It must be compared and hashed
	// byte-for-byte; leading or trailing whitespace is data, not normalization.
	if _, err := SessionFileName(envelope.SessionID); err != nil {
		return invalid("requester context envelope sessionId is invalid")
	}
	if envelope.IssuedAt.IsZero() || envelope.ExpiresAt.IsZero() {
		return invalid("requester context envelope timestamps are required")
	}
	maxTTL := time.Duration(config.MaxEnvelopeTTLSeconds) * time.Second
	if maxTTL > 30*time.Minute {
		maxTTL = 30 * time.Minute
	}
	ttl := envelope.ExpiresAt.Sub(envelope.IssuedAt)
	if ttl <= 0 || ttl > maxTTL {
		return invalid("requester context envelope TTL is invalid")
	}
	skew := time.Duration(config.ClockSkewSeconds) * time.Second
	if envelope.IssuedAt.After(now.Add(skew)) {
		return invalid("requester context envelope was issued in the future")
	}
	if !now.Before(envelope.ExpiresAt) {
		return authzError(CodeRequesterContextExpired, "requester context envelope has expired", nil)
	}
	return validateRequesterContext(&envelope.RequesterContext)
}

func validateRequesterContext(context *RequesterContext) error {
	invalid := func(message string) error {
		return authzError(CodeRequesterContextInvalid, message, nil)
	}
	if context.Version != CurrentRequesterContextVersion {
		return invalid("requester context version must be 2")
	}
	if context.Principal.Channel != "wecom" {
		return invalid("requester principal channel must be wecom")
	}
	if !policyRevisionPattern.MatchString(context.PolicyRevision) {
		return invalid("requester policyRevision is invalid")
	}
	for name, value := range map[string]string{
		"requestId":       context.RequestID,
		"botId":           context.Principal.BotID,
		"canonicalUserId": context.Principal.CanonicalUserID,
		"chatId":          context.Audience.ChatID,
	} {
		if err := validateRequiredWireString(value); err != nil {
			return invalid("requester context " + name + " is invalid")
		}
	}
	for _, optional := range []string{context.Principal.DisplayName, context.Audience.ChatType} {
		if err := validateOptionalWireString(optional); err != nil {
			return invalid("requester context optional identity field is invalid")
		}
	}

	hasMetricCapability := false
	seenCapabilities := make(map[string]struct{}, len(context.Authorization.Capabilities))
	for _, capability := range context.Authorization.Capabilities {
		if err := validateRequiredWireString(capability); err != nil {
			return invalid("requester capability is invalid")
		}
		if _, exists := seenCapabilities[capability]; exists {
			return invalid("requester context contains a duplicate capability")
		}
		seenCapabilities[capability] = struct{}{}
		if capability == CapabilityMetricQuery {
			hasMetricCapability = true
		}
	}
	if !hasMetricCapability {
		return authzError(CodeCapabilityDenied, "requester lacks Metric query capability", nil)
	}
	claimPayload, ok := context.Authorization.Claims[ClaimNamespaceQDMScope]
	if !ok {
		return invalid("requester context qdm.scope claim is missing")
	}
	var claim QDMScopeClaim
	if err := decodeStrictJSON(claimPayload, &claim); err != nil {
		return authzError(CodeRequesterContextInvalid, "requester context qdm.scope claim is invalid", err)
	}
	if claim.SchemaVersion != CurrentQDMScopeSchemaVersion {
		return invalid("requester context qdm.scope schema version must be 1")
	}
	if err := validateScopeValues(claim.ManageAreaIDs); err != nil {
		return err
	}
	if err := validateScopeValues(claim.DCManageAreaIDs); err != nil {
		return err
	}
	if err := validateScopeValues(claim.CategoryLevel1IDs); err != nil {
		return err
	}
	if len(claim.ManageAreaIDs) == 0 && len(claim.DCManageAreaIDs) == 0 && len(claim.CategoryLevel1IDs) == 0 {
		return authzError(CodeScopeEmpty, "requester authorization scope is empty", nil)
	}
	context.Authorization.Scope = Scope{
		ManageAreaIDs:     append([]string(nil), claim.ManageAreaIDs...),
		DCManageAreaIDs:   append([]string(nil), claim.DCManageAreaIDs...),
		CategoryLevel1IDs: append([]string(nil), claim.CategoryLevel1IDs...),
	}
	return nil
}

func validateScopeValues(values []string) error {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if err := validateRequiredWireString(value); err != nil || strings.ContainsAny(value, ",*") {
			return authzError(CodeRequesterContextInvalid, "requester authorization scope contains an invalid ID", err)
		}
		if _, exists := seen[value]; exists {
			return authzError(CodeRequesterContextInvalid, "requester authorization scope contains a duplicate ID", nil)
		}
		seen[value] = struct{}{}
	}
	return nil
}

func validateRequiredWireString(value string) error {
	if value == "" || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return fmt.Errorf("value must be a non-empty trimmed UTF-8 string")
	}
	return validateOptionalWireString(value)
}

func validateOptionalWireString(value string) error {
	if !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
		return fmt.Errorf("value is not valid UTF-8")
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return fmt.Errorf("value contains a control character")
		}
	}
	return nil
}

// ContextFingerprint returns SHA-256(JCS(typed RequesterContext V2)).
func ContextFingerprint(context RequesterContext) (string, error) {
	if err := validateRequesterContext(&context); err != nil {
		return "", err
	}
	canonical, err := canonicalJSON(context)
	if err != nil {
		return "", authzError(CodeRequesterContextInvalid, "requester context cannot be canonicalized", err)
	}
	return sha256Hex(canonical), nil
}

func canonicalJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return jcs.Transform(encoded)
}
