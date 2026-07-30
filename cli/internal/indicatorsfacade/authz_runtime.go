package indicatorsfacade

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"harness-data/cli/internal/authz"
)

const BindingEnvironmentVariable = "HARNESS_AUTHZ_BINDING_V1"

const operationalAuditSinkPath = "/proc/1/fd/2"

type authzGuard struct {
	config            authz.Config
	binding           authz.Binding
	mu                sync.Mutex
	controlGeneration uint64
}

func (g *authzGuard) Initial(ctx context.Context) (AuthorizationContext, error) {
	if err := ctx.Err(); err != nil {
		return AuthorizationContext{}, err
	}
	loaded, err := authz.ValidateCurrent(g.config, g.binding)
	if err != nil {
		return AuthorizationContext{}, mapAuthzError(err)
	}
	g.mu.Lock()
	g.controlGeneration = loaded.ControlGeneration
	g.mu.Unlock()
	envelope := loaded.Envelope
	requester := envelope.RequesterContext
	return AuthorizationContext{
		WorkspaceID:       envelope.WorkspaceID,
		AgentID:           envelope.AgentID,
		SessionID:         envelope.SessionID,
		RequestID:         requester.RequestID,
		BotID:             requester.Principal.BotID,
		CanonicalUserID:   requester.Principal.CanonicalUserID,
		PolicyRevision:    requester.PolicyRevision,
		EnvelopeSHA256:    loaded.SHA256,
		CatalogSHA256:     g.config.ApprovedIndicatorCatalog.SHA256,
		ArtifactSHA256:    g.config.RealIndicatorsCLI.ArtifactSHA256,
		ManageAreaIDs:     append([]string(nil), requester.Authorization.Scope.ManageAreaIDs...),
		CategoryLevel1IDs: append([]string(nil), requester.Authorization.Scope.CategoryLevel1IDs...),
	}, nil
}

func (g *authzGuard) Revalidate(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return deny(CodeRequesterContextExpired, "请求已取消或权限上下文失效", err)
	}
	loaded, err := authz.ValidateCurrent(g.config, g.binding)
	if err != nil {
		return mapAuthzError(err)
	}
	g.mu.Lock()
	expectedGeneration := g.controlGeneration
	g.mu.Unlock()
	if expectedGeneration == 0 || loaded.ControlGeneration != expectedGeneration {
		return deny(CodeKillSwitchActive, "数据查询已被运维开关停用", nil)
	}
	return nil
}

// LoadSystemRuntime loads only fixed, root-owned runtime inputs. It performs a
// full readiness check on every facade invocation before accepting Agent argv.
func LoadSystemRuntime() (RunnerConfig, Dependencies, error) {
	executable, err := os.Executable()
	if err != nil {
		return RunnerConfig{}, Dependencies{}, deny(CodeAuthzConfigInvalid, "Facade 运行路径无法解析", err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return RunnerConfig{}, Dependencies{}, deny(CodeAuthzConfigInvalid, "Facade 运行路径无法解析", err)
	}
	runtimeRoot := filepath.Dir(filepath.Dir(filepath.Clean(executable)))
	config, _, err := authz.LoadReadyConfig(authz.DefaultConfigPath, authz.ReadinessOptions{RuntimeRoot: runtimeRoot})
	if err != nil {
		return RunnerConfig{}, Dependencies{}, mapAuthzError(err)
	}
	if err := config.RequireEnforcing(); err != nil {
		return RunnerConfig{}, Dependencies{}, mapAuthzError(err)
	}
	encoded := os.Getenv(BindingEnvironmentVariable)
	if encoded == "" {
		return RunnerConfig{}, Dependencies{}, deny(CodeAuthzBindingMissing, "缺少当前请求的权限绑定", nil)
	}
	binding, err := authz.DecodeBinding(encoded)
	if err != nil {
		return RunnerConfig{}, Dependencies{}, mapAuthzError(err)
	}
	limits, err := limitsFromAuthz(config)
	if err != nil {
		return RunnerConfig{}, Dependencies{}, err
	}
	runner := RunnerConfig{
		RealCLIPath:      config.RealIndicatorsCLI.Path,
		RealCLIConfigDir: config.RealIndicatorsCLI.ConfigDir,
		WorkingDirectory: filepath.Dir(config.RealIndicatorsCLI.Path),
		CatalogPath:      config.ApprovedIndicatorCatalog.Path,
		CatalogSHA256:    config.ApprovedIndicatorCatalog.SHA256,
		ArtifactSHA256:   config.RealIndicatorsCLI.ArtifactSHA256,
		Limits:           limits,
	}
	guard := &authzGuard{config: config, binding: binding}
	dependencies := Dependencies{
		Guard: guard,
		VerifyFile: func(path, expectedSHA256 string, executable bool) error {
			_, verifyErr := authz.VerifyArtifact(path, expectedSHA256, executable)
			return verifyErr
		},
	}
	audit, err := OpenOperationalAuditSink()
	if err != nil {
		return RunnerConfig{}, Dependencies{}, err
	}
	dependencies.Audit = audit
	return runner, dependencies, nil
}

// OpenOperationalAuditSink writes directly to the Docker supervisor's stderr
// rather than this Bash child's stderr, which is returned to the Agent. Lumi
// authorization is Linux-container-only and fails closed if that sink is not
// available.
func OpenOperationalAuditSink() (*os.File, error) {
	file, err := os.OpenFile(operationalAuditSinkPath, os.O_WRONLY, 0)
	if err != nil {
		return nil, deny(CodeAuthzConfigInvalid, "运维审计通道不可用", err)
	}
	return file, nil
}

func limitsFromAuthz(config authz.Config) (Limits, error) {
	values := []int64{
		config.Limits.MaxDateRangeDays,
		config.Limits.MaxIndicators,
		config.Limits.MaxDimensions,
		config.Limits.DefaultPageSize,
		config.Limits.MaxPageSize,
		config.Limits.DefaultMetadataLimit,
		config.Limits.MaxMetadataLimit,
	}
	for _, value := range values {
		if value <= 0 || uint64(value) > uint64(math.MaxInt) {
			return Limits{}, deny(CodeAuthzConfigInvalid, "授权部署限额超出当前平台范围", nil)
		}
	}
	return Limits{
		MaxDateRangeDays:     int(config.Limits.MaxDateRangeDays),
		MaxIndicators:        int(config.Limits.MaxIndicators),
		MaxDimensions:        int(config.Limits.MaxDimensions),
		DefaultPageSize:      int(config.Limits.DefaultPageSize),
		MaxPageSize:          int(config.Limits.MaxPageSize),
		DefaultMetadataLimit: int(config.Limits.DefaultMetadataLimit),
		MaxMetadataLimit:     int(config.Limits.MaxMetadataLimit),
		Timeout:              time.Duration(config.Limits.TimeoutSeconds) * time.Second,
		MaxOutputBytes:       config.Limits.MaxOutputBytes,
		PollInterval:         time.Duration(config.KillSwitch.PollMilliseconds) * time.Millisecond,
	}, nil
}

func mapAuthzError(err error) error {
	if err == nil {
		return nil
	}
	var code ErrorCode
	switch authz.ErrorCode(err) {
	case authz.CodeConfigInvalid:
		code = CodeAuthzConfigInvalid
	case authz.CodeBindingMissing:
		code = CodeAuthzBindingMissing
	case authz.CodeBindingInvalid, authz.CodeBindingMismatch:
		code = CodeAuthzBindingMismatch
	case authz.CodeRequesterContextInvalid:
		code = CodeRequesterContextInvalid
	case authz.CodeRequesterContextExpired:
		code = CodeRequesterContextExpired
	case authz.CodeCapabilityDenied:
		code = CodeCapabilityDenied
	case authz.CodeScopeEmpty:
		code = CodeScopeEmpty
	case authz.CodeArtifactIntegrityFailed:
		code = CodeArtifactIntegrityFailed
	case authz.CodeKillSwitchActive:
		code = CodeKillSwitchActive
	default:
		return deny(CodeAuthzBindingMismatch, "权限上下文失效", err)
	}
	message := map[ErrorCode]string{
		CodeAuthzConfigInvalid:      "授权配置无效",
		CodeAuthzBindingMissing:     "缺少当前请求的权限绑定",
		CodeAuthzBindingMismatch:    "权限绑定与当前请求不匹配",
		CodeRequesterContextInvalid: "权限上下文无效",
		CodeRequesterContextExpired: "权限上下文已失效",
		CodeCapabilityDenied:        "当前用户没有指标查询权限",
		CodeScopeEmpty:              "当前用户的数据范围为空",
		CodeArtifactIntegrityFailed: "授权发布物完整性校验失败",
		CodeKillSwitchActive:        "数据查询已被运维开关停用",
	}[code]
	if message == "" {
		message = fmt.Sprintf("授权校验失败（%s）", code)
	}
	return deny(code, message, err)
}
