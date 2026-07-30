package authz

import (
	"bytes"
	"encoding/base64"
	"strings"
	"time"
)

const maxEncodedBindingBytes = 16 << 10

// NewBinding creates the minimal V1 reference to one validated Lumi envelope.
func NewBinding(loaded LoadedEnvelope) Binding {
	return Binding{
		Version:        CurrentVersion,
		SessionID:      loaded.Envelope.SessionID,
		RequestID:      loaded.Envelope.RequesterContext.RequestID,
		EnvelopeSHA256: loaded.SHA256,
		ExpiresAt:      loaded.Envelope.ExpiresAt.UTC(),
	}
}

// CanonicalBindingJSON validates and encodes a binding using RFC 8785/JCS.
func CanonicalBindingJSON(binding Binding) ([]byte, error) {
	if err := validateBinding(binding, time.Time{}); err != nil {
		return nil, err
	}
	canonical, err := canonicalJSON(binding)
	if err != nil {
		return nil, authzError(CodeBindingInvalid, "authorization binding cannot be canonicalized", err)
	}
	return canonical, nil
}

// EncodeBinding returns unpadded base64url(JCS(binding)).
func EncodeBinding(binding Binding) (string, error) {
	canonical, err := CanonicalBindingJSON(binding)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(canonical), nil
}

// DecodeBinding strictly decodes the canonical transport form. Alternate
// base64 spellings and semantically equivalent but non-JCS JSON are rejected.
func DecodeBinding(encoded string) (Binding, error) {
	invalid := func(message string, err error) (Binding, error) {
		return Binding{}, authzError(CodeBindingInvalid, message, err)
	}
	if encoded == "" {
		return invalid("authorization binding is missing", nil)
	}
	if len(encoded) > maxEncodedBindingBytes || strings.Contains(encoded, "=") {
		return invalid("authorization binding encoding is invalid", nil)
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return invalid("authorization binding encoding is invalid", err)
	}
	if base64.RawURLEncoding.EncodeToString(raw) != encoded {
		return invalid("authorization binding encoding is noncanonical", nil)
	}
	var binding Binding
	if err := decodeStrictJSON(raw, &binding); err != nil {
		return invalid("authorization binding JSON is invalid", err)
	}
	canonical, err := CanonicalBindingJSON(binding)
	if err != nil {
		return Binding{}, err
	}
	if !bytes.Equal(raw, canonical) {
		return invalid("authorization binding JSON is noncanonical", nil)
	}
	return binding, nil
}

func validateBinding(binding Binding, now time.Time) error {
	invalid := func(message string) error {
		return authzError(CodeBindingInvalid, message, nil)
	}
	if binding.Version != CurrentVersion {
		return invalid("authorization binding version must be 1")
	}
	if _, err := SessionFileName(binding.SessionID); err != nil {
		return invalid("authorization binding sessionId is invalid")
	}
	if err := validateRequiredWireString(binding.RequestID); err != nil {
		return invalid("authorization binding requestId is invalid")
	}
	if !lowercaseSHA256Pattern.MatchString(binding.EnvelopeSHA256) {
		return invalid("authorization binding envelopeSha256 is invalid")
	}
	if binding.ExpiresAt.IsZero() {
		return invalid("authorization binding expiresAt is required")
	}
	if !now.IsZero() && !now.Before(binding.ExpiresAt) {
		return authzError(CodeRequesterContextExpired, "authorization binding has expired", nil)
	}
	return nil
}

// ValidateCurrent checks the binding, dynamic control state, and the current
// authoritative Lumi file on every invocation.
func ValidateCurrent(config Config, binding Binding, options ...ReadOption) (LoadedEnvelope, error) {
	if err := config.RequireEnforcing(); err != nil {
		return LoadedEnvelope{}, err
	}
	settings := resolveReadSettings(options)
	if err := validateBinding(binding, settings.now); err != nil {
		return LoadedEnvelope{}, err
	}
	control, err := ReadControl(config)
	if err != nil {
		return LoadedEnvelope{}, err
	}
	if !control.Enabled() {
		return LoadedEnvelope{}, authzError(CodeKillSwitchActive, "authorization kill switch is disabled", nil)
	}
	loaded, err := ReadEnvelope(config, binding.SessionID, WithNow(settings.now))
	if err != nil {
		return LoadedEnvelope{}, err
	}
	if binding.SessionID != loaded.Envelope.SessionID ||
		binding.RequestID != loaded.Envelope.RequesterContext.RequestID ||
		binding.EnvelopeSHA256 != loaded.SHA256 ||
		!binding.ExpiresAt.Equal(loaded.Envelope.ExpiresAt) {
		return LoadedEnvelope{}, authzError(CodeBindingMismatch, "authorization binding does not match the current requester context", nil)
	}
	loaded.ControlGeneration = control.Generation
	return loaded, nil
}

// Bind reads and validates the current request, then returns only the private
// binding and an intentionally redacted model-visible summary.
func Bind(config Config, sessionID string, options ...ReadOption) (BindResult, error) {
	if err := config.RequireEnforcing(); err != nil {
		return BindResult{}, err
	}
	control, err := ReadControl(config)
	if err != nil {
		return BindResult{}, err
	}
	if !control.Enabled() {
		return BindResult{}, authzError(CodeKillSwitchActive, "authorization kill switch is disabled", nil)
	}
	loaded, err := ReadEnvelope(config, sessionID, options...)
	if err != nil {
		return BindResult{}, err
	}
	binding := NewBinding(loaded)
	encoded, err := EncodeBinding(binding)
	if err != nil {
		return BindResult{}, err
	}
	context := loaded.Envelope.RequesterContext
	return BindResult{
		Binding:          binding,
		BindingBase64URL: encoded,
		Summary: Summary{
			Channel:           context.Principal.Channel,
			BotID:             context.Principal.BotID,
			CanonicalUserID:   context.Principal.CanonicalUserID,
			ManageAreaIDs:     append([]string(nil), context.Authorization.Scope.ManageAreaIDs...),
			CategoryLevel1IDs: append([]string(nil), context.Authorization.Scope.CategoryLevel1IDs...),
		},
		ContextFingerprint: loaded.ContextFingerprint,
		IssuedAt:           loaded.Envelope.IssuedAt.UTC(),
	}, nil
}
