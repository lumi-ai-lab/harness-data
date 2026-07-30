package indicatorsfacade

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sync/atomic"
	"time"
)

var fallbackDecisionSequence atomic.Uint64

// Run validates a single invocation, executes the pinned real CLI and returns
// output only after metadata projection and final authorization revalidation.
func Run(ctx context.Context, args []string, config RunnerConfig, dependencies Dependencies) (result Result, returnErr error) {
	started := time.Now()
	decisionID := dependencies.DecisionID
	if decisionID == "" {
		decisionID = NewDecisionID()
	}
	result.DecisionID = decisionID
	operationName := "unknown"
	authorization := AuthorizationContext{}
	parsedOperation := operation{}
	approvedOperation := operation{}
	canonicalArgv := []string(nil)
	execution := childResult{}
	returnedOutputBytes := 0
	defer func() {
		errorCode := ""
		if returnErr != nil {
			errorCode = string(CodeOf(returnErr))
		}
		auditErr := writeAudit(dependencies.Audit, auditRecord{
			DecisionID: decisionID,
			Timestamp:  now(dependencies).UTC().Format(time.RFC3339Nano),
			Decision:   decisionFor(returnErr),
			ErrorCode:  errorCode,
			Mode:       "lumi-mvp-required", Operation: operationName,
			WorkspaceID: authorization.WorkspaceID, AgentID: authorization.AgentID,
			SessionHash: shortHash(authorization.SessionID), RequestHash: shortHash(authorization.RequestID),
			PrincipalHash:               shortHash(authorization.BotID + "\x00" + authorization.CanonicalUserID),
			PolicyRevision:              authorization.PolicyRevision,
			EnvelopeDigestPrefix:        digestPrefix(authorization.EnvelopeSHA256),
			CatalogDigest:               authorization.CatalogSHA256,
			ArtifactDigest:              authorization.ArtifactSHA256,
			CanonicalArgvDigest:         argvDigest(canonicalArgv),
			IndicatorCodes:              auditIndicatorCodes(parsedOperation, approvedOperation),
			RequestedAreaCount:          requestedScopeCount(parsedOperation, protectedAreaCode),
			RequestedCategoryCount:      requestedScopeCount(parsedOperation, protectedCategoryCode),
			EffectiveAreaCount:          len(approvedOperation.EffectiveAreas),
			EffectiveCategoryCount:      len(approvedOperation.EffectiveCategories),
			RealCLIExitCode:             execution.exitCode,
			TimedOut:                    execution.timedOut,
			Truncated:                   execution.truncated,
			RealCLIDurationMilliseconds: execution.durationMilliseconds,
			DurationMilliseconds:        time.Since(started).Milliseconds(),
			OutputBytes:                 execution.outputBytes,
			ReturnedOutputBytes:         returnedOutputBytes,
		})
		if auditErr != nil {
			result.Stdout = nil
			returnErr = deny(CodeAuthzConfigInvalid, "运维审计通道不可用", auditErr)
		}
	}()

	if err := validateRunnerConfig(config); err != nil {
		return result, err
	}
	if dependencies.Guard == nil || dependencies.VerifyFile == nil {
		return result, deny(CodeAuthzConfigInvalid, "Facade 运行时依赖未配置", nil)
	}
	var err error
	authorization, err = dependencies.Guard.Initial(ctx)
	if err != nil {
		return result, normalizeGuardError(err)
	}
	if authorization.CatalogSHA256 != config.CatalogSHA256 {
		return result, deny(CodeArtifactIntegrityFailed, "权限配置与指标目录摘要不一致", nil)
	}
	if authorization.ArtifactSHA256 != config.ArtifactSHA256 {
		return result, deny(CodeArtifactIntegrityFailed, "权限配置与真实 CLI 摘要不一致", nil)
	}
	catalog, err := loadCatalog(config.CatalogPath, config.CatalogSHA256)
	if err != nil {
		return result, err
	}
	if err := dependencies.VerifyFile(config.RealCLIPath, config.ArtifactSHA256, true); err != nil {
		return result, deny(CodeArtifactIntegrityFailed, "真实 CLI 完整性校验失败", err)
	}
	parsed, err := parseOperation(args, config.Limits)
	if err != nil {
		return result, err
	}
	parsedOperation = parsed
	operationName = string(parsed.Kind)
	approved, err := authorizeAndRebuild(parsed, authorization, catalog)
	if err != nil {
		return result, err
	}
	approvedOperation = approved
	canonicalArgv = approved.CanonicalArgv
	if err := dependencies.Guard.Revalidate(ctx); err != nil {
		return result, normalizeGuardError(err)
	}
	execution, err = executeRealCLI(ctx, config, canonicalArgv, dependencies.Guard)
	if err != nil {
		return result, normalizeGuardError(err)
	}
	output := execution.stdout
	if approved.metadata() {
		output, err = projectMetadata(approved, catalog, output, config.Limits.MaxMetadataLimit)
		if err != nil {
			return result, err
		}
	}
	if int64(len(output)) > config.Limits.MaxOutputBytes {
		execution.truncated = true
		return result, deny(CodeExecutionLimitExceeded, "投影后的输出超过部署限额", nil)
	}
	if err := dependencies.Guard.Revalidate(ctx); err != nil {
		return result, normalizeGuardError(err)
	}
	result.Stdout = output
	returnedOutputBytes = len(output)
	return result, nil
}

func validateRunnerConfig(config RunnerConfig) error {
	if err := config.Limits.validate(); err != nil {
		return err
	}
	if !filepath.IsAbs(config.RealCLIPath) || !filepath.IsAbs(config.RealCLIConfigDir) ||
		!filepath.IsAbs(config.WorkingDirectory) || !filepath.IsAbs(config.CatalogPath) ||
		!isLowerSHA256(config.CatalogSHA256) || !isLowerSHA256(config.ArtifactSHA256) {
		return deny(CodeAuthzConfigInvalid, "Facade 路径或摘要配置无效", nil)
	}
	if filepath.Clean(config.RealCLIPath) == filepath.Clean(config.CatalogPath) {
		return deny(CodeAuthzConfigInvalid, "真实 CLI 与指标目录路径冲突", nil)
	}
	return nil
}

func isLowerSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

func normalizeGuardError(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := err.(*Error); ok {
		return err
	}
	return deny(CodeAuthzBindingMismatch, "权限上下文失效", err)
}

type auditRecord struct {
	DecisionID                  string   `json:"decisionId"`
	Timestamp                   string   `json:"timestamp"`
	Decision                    string   `json:"decision"`
	ErrorCode                   string   `json:"errorCode,omitempty"`
	Mode                        string   `json:"authorizationMode"`
	Operation                   string   `json:"operation"`
	WorkspaceID                 string   `json:"workspaceId,omitempty"`
	AgentID                     string   `json:"agentId,omitempty"`
	SessionHash                 string   `json:"sessionHash,omitempty"`
	RequestHash                 string   `json:"requestIdHash,omitempty"`
	PrincipalHash               string   `json:"principalHash,omitempty"`
	PolicyRevision              string   `json:"policyRevision,omitempty"`
	EnvelopeDigestPrefix        string   `json:"envelopeDigestPrefix,omitempty"`
	CatalogDigest               string   `json:"catalogDigest,omitempty"`
	ArtifactDigest              string   `json:"artifactDigest,omitempty"`
	CanonicalArgvDigest         string   `json:"canonicalArgvDigest,omitempty"`
	IndicatorCodes              []string `json:"indicatorCodes,omitempty"`
	RequestedAreaCount          int      `json:"requestedAreaCount"`
	RequestedCategoryCount      int      `json:"requestedCategoryCount"`
	EffectiveAreaCount          int      `json:"effectiveAreaCount"`
	EffectiveCategoryCount      int      `json:"effectiveCategoryCount"`
	RealCLIExitCode             *int     `json:"realCliExitCode,omitempty"`
	TimedOut                    bool     `json:"timedOut"`
	Truncated                   bool     `json:"truncated"`
	RealCLIDurationMilliseconds int64    `json:"realCliDurationMilliseconds"`
	DurationMilliseconds        int64    `json:"durationMilliseconds"`
	OutputBytes                 int      `json:"outputBytes"`
	ReturnedOutputBytes         int      `json:"returnedOutputBytes"`
}

func writeAudit(writer io.Writer, record auditRecord) error {
	if writer == nil {
		return fmt.Errorf("audit writer is not configured")
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(writer, "HARNESS_AUTHZ_AUDIT %s\n", encoded)
	return err
}

func NewDecisionID() string {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err == nil {
		return hex.EncodeToString(random)
	}
	return fmt.Sprintf("fallback-%d-%d", time.Now().UnixNano(), fallbackDecisionSequence.Add(1))
}

// AuditPreflightDeny records failures that happen while loading the fixed
// system runtime, before Run can construct its normal deferred audit record.
func AuditPreflightDeny(writer io.Writer, decisionID string, err error) {
	_ = writeAudit(writer, auditRecord{
		DecisionID: decisionID,
		Timestamp:  time.Now().UTC().Format(time.RFC3339Nano),
		Decision:   "deny",
		ErrorCode:  string(CodeOf(err)),
		Mode:       "lumi-mvp-required",
		Operation:  "preflight",
	})
}

func shortHash(value string) string {
	if value == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:12])
}

func argvDigest(argv []string) string {
	if len(argv) == 0 {
		return ""
	}
	hash := sha256.New()
	for _, arg := range argv {
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(arg))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func digestPrefix(value string) string {
	if len(value) < 12 {
		return ""
	}
	return value[:12]
}

func decisionFor(err error) string {
	if err == nil {
		return "allow"
	}
	return "deny"
}

func now(dependencies Dependencies) time.Time {
	if dependencies.Now != nil {
		return dependencies.Now()
	}
	return time.Now()
}

func requestedScopeCount(candidate operation, code string) int {
	for _, filter := range candidate.Filters {
		if filter.Code == code {
			return len(filter.IDs)
		}
	}
	return 0
}

func auditIndicatorCodes(parsed, approved operation) []string {
	if len(parsed.Indicators) > 0 {
		return append([]string(nil), parsed.Indicators...)
	}
	if approved.ApprovedIndicator != "" {
		return []string{approved.ApprovedIndicator}
	}
	return nil
}
