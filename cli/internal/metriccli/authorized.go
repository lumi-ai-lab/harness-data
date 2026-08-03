package metriccli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"harness-data/cli/internal/authz"
)

const (
	bindingEnvironment = "HARNESS_AUTHZ_BINDING_V1"
	maxPayloadBytes    = 16 << 20
)

// ExitError preserves the real Metric CLI exit code for the thin authorized
// entry point.
type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string { return e.Err.Error() }
func (e *ExitError) Unwrap() error { return e.Err }

// ExitCode returns the process exit code for an authorization or child-process
// failure.
func ExitCode(err error) int {
	var exitErr *ExitError
	if errors.As(err, &exitErr) {
		return exitErr.Code
	}
	return 1
}

// Run authorizes one qdm-metric-cli invocation and forwards it to the pinned
// private binary. The public command never executes an unverified child.
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	return RunWithConfig(authz.DefaultConfigPath, args, stdin, stdout, stderr)
}

// RunWithConfig is the injectable form of Run used by deterministic tests and
// deployment wrappers that keep the authorization config outside the default
// system path.
func RunWithConfig(configPath string, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	return runAuthorized(configPath, strings.TrimSpace(os.Getenv(bindingEnvironment)), nil, args, stdin, stdout, stderr)
}

func runAuthorized(
	configPath string,
	encodedBinding string,
	agentUID *uint32,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) error {
	config, err := authz.LoadConfig(configPath)
	if err != nil {
		return deny(err)
	}
	if encodedBinding == "" {
		return denyCode(authz.CodeBindingMissing, "qdm-metric-cli requires a Harness authorization binding")
	}
	binding, err := authz.DecodeBinding(encodedBinding)
	if err != nil {
		return deny(err)
	}
	validateOptions := []authz.ReadOption{}
	if agentUID != nil {
		validateOptions = append(validateOptions, authz.WithAgentUID(*agentUID))
	}
	loaded, err := authz.ValidateCurrent(config, binding, validateOptions...)
	if err != nil {
		return deny(err)
	}
	if _, err := authz.VerifyArtifact(config.RealMetricCLI.Path, config.RealMetricCLI.ArtifactSHA256, true); err != nil {
		return deny(err)
	}
	catalog, err := authz.LoadMetricCatalog(
		config.ApprovedMetricCatalog.Path,
		config.ApprovedMetricCatalog.SHA256,
	)
	if err != nil {
		return deny(err)
	}

	forwarded, err := authorizeArgumentsWithLimits(
		args,
		loaded.Envelope.RequesterContext.Authorization.Scope,
		config.Limits,
		catalog,
	)
	if err != nil {
		return deny(err)
	}
	return execute(context.Background(), config, forwarded, stdin, stdout, stderr)
}

func deny(err error) error {
	if err == nil {
		return denyCode(authz.CodeConfigInvalid, "qdm-metric-cli authorization failed")
	}
	code := authz.ErrorCode(err)
	if code == "" {
		code = authz.CodeConfigInvalid
	}
	return denyCode(code, err.Error())
}

func denyCode(code authz.Code, message string) error {
	return &ExitError{Code: 77, Err: fmt.Errorf("qdm-metric-cli authorization denied (%s): %s", code, message)}
}

func execute(parent context.Context, config authz.Config, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	timeout := time.Duration(config.Limits.TimeoutSeconds) * time.Second
	ctx, cancel := context.WithTimeout(parent, timeout)
	killSwitchErrors := make(chan error, 1)
	watcherDone := make(chan struct{})
	go watchKillSwitch(ctx, config, cancel, killSwitchErrors, watcherDone)
	defer func() {
		cancel()
		<-watcherDone
	}()

	command := exec.CommandContext(ctx, config.RealMetricCLI.Path, args...)
	command.Stdin = stdin
	command.Env = metricEnvironmentForChild()
	output := newBoundedCapture(config.Limits.MaxOutputBytes)
	errorOutput := newBoundedCapture(config.Limits.MaxOutputBytes)
	command.Stdout = &output
	command.Stderr = &errorOutput
	if err := command.Run(); err != nil {
		select {
		case killSwitchErr := <-killSwitchErrors:
			return &ExitError{Code: 77, Err: killSwitchErr}
		default:
		}
		if _, writeErr := stderr.Write(errorOutput.Bytes()); writeErr != nil {
			return writeErr
		}
		if output.Overflowed() || errorOutput.Overflowed() {
			return &ExitError{Code: 77, Err: errors.New("qdm-metric-cli output exceeds the authorization limit")}
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &ExitError{Code: 124, Err: errors.New("qdm-metric-cli authorization execution timed out")}
		}
		var processErr *exec.ExitError
		if errors.As(err, &processErr) {
			return &ExitError{Code: processErr.ExitCode(), Err: err}
		}
		return err
	}
	select {
	case killSwitchErr := <-killSwitchErrors:
		return &ExitError{Code: 77, Err: killSwitchErr}
	default:
	}
	if _, err := stderr.Write(errorOutput.Bytes()); err != nil {
		return err
	}
	if output.Overflowed() || errorOutput.Overflowed() {
		return &ExitError{Code: 77, Err: errors.New("qdm-metric-cli output exceeds the authorization limit")}
	}
	_, err := stdout.Write(output.Bytes())
	return err
}

func watchKillSwitch(
	ctx context.Context,
	config authz.Config,
	cancel context.CancelFunc,
	errorsOut chan<- error,
	done chan<- struct{},
) {
	defer close(done)
	interval := time.Duration(config.KillSwitch.PollMilliseconds) * time.Millisecond
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			control, err := authz.ReadControl(config)
			if err == nil && control.Enabled() {
				continue
			}
			if err == nil {
				err = errors.New("qdm-metric-cli authorization kill switch became disabled")
			}
			select {
			case errorsOut <- err:
			default:
			}
			cancel()
			return
		}
	}
}

type boundedCapture struct {
	buffer     bytes.Buffer
	limit      int64
	overflowed bool
}

func newBoundedCapture(limit int64) boundedCapture {
	return boundedCapture{limit: limit}
}

func (capture *boundedCapture) Write(data []byte) (int, error) {
	if capture.limit <= 0 {
		capture.overflowed = len(data) > 0
		return len(data), nil
	}
	remaining := capture.limit - int64(capture.buffer.Len())
	if remaining > 0 {
		stored := int64(len(data))
		if stored > remaining {
			stored = remaining
		}
		_, _ = capture.buffer.Write(data[:stored])
	}
	if int64(len(data)) > remaining {
		capture.overflowed = true
	}
	return len(data), nil
}

func (capture *boundedCapture) Bytes() []byte {
	return capture.buffer.Bytes()
}

func (capture *boundedCapture) Overflowed() bool {
	return capture.overflowed
}

func metricEnvironmentForChild() []string {
	return []string{
		"HOME=/nonexistent",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"PATH=/usr/bin:/bin",
		"TZ=UTC",
	}
}

type authorizationScope struct {
	ManageAreaIDs     []string
	DCManageAreaIDs   []string
	CategoryLevel1IDs []string
}

// analysisAuthorizationRequestV010 mirrors the security-relevant JSON fields
// decoded by the pinned real Metric CLI v0.1.0.
type analysisAuthorizationRequestV010 struct {
	Metrics    []string                         `json:"metrics"`
	Time       analysisAuthorizationTimeV010    `json:"time"`
	Dimensions []string                         `json:"dimensions"`
	Filters    analysisAuthorizationFiltersV010 `json:"filters"`
	PageSize   *int                             `json:"pageSize,omitempty"`
}

type analysisAuthorizationTimeV010 struct {
	StartDate string `json:"startDate"`
	EndDate   string `json:"endDate"`
	Grain     string `json:"grain,omitempty"`
}

func (queryTime *analysisAuthorizationTimeV010) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return errors.New("analysis time must be an object")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return errors.New("analysis time must be an object")
	}
	for _, name := range []string{"startDate", "endDate", "grain"} {
		_, aliases := foldedJSONField(fields, name)
		if aliases > 1 {
			return fmt.Errorf("analysis time contains conflicting %s fields", name)
		}
	}
	type plainTime analysisAuthorizationTimeV010
	var decoded plainTime
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return errors.New("analysis time has an invalid shape")
	}
	*queryTime = analysisAuthorizationTimeV010(decoded)
	return nil
}

type analysisAuthorizationFiltersV010 map[string][]string

func (filters *analysisAuthorizationFiltersV010) UnmarshalJSON(raw []byte) error {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		*filters = nil
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return errors.New("analysis filters must be an object")
	}
	result := make(analysisAuthorizationFiltersV010, len(fields))
	for dimension, encodedValues := range fields {
		if bytes.Equal(bytes.TrimSpace(encodedValues), []byte("null")) {
			return fmt.Errorf("analysis filter %s must be an array", dimension)
		}
		var values []string
		if err := json.Unmarshal(encodedValues, &values); err != nil {
			return fmt.Errorf("analysis filter %s must be an array", dimension)
		}
		result[dimension] = values
	}
	*filters = result
	return nil
}

func requireDoubleHyphenFlags(args []string) error {
	for _, argument := range args {
		if argument == "-" || !strings.HasPrefix(argument, "-") {
			continue
		}
		if argument == "--" ||
			(strings.HasPrefix(argument, "--") && len(argument) > 2 && argument[2] != '-') {
			continue
		}
		return fmt.Errorf(
			"qdm-metric-cli flags must use the double-hyphen form: %q",
			argument,
		)
	}
	return nil
}

func authorizeArguments(args []string, scope authz.Scope, maxMetrics int64, catalog authz.MetricCatalog) ([]string, error) {
	return authorizeArgumentsWithLimits(args, scope, authz.LimitsConfig{MaxMetrics: maxMetrics}, catalog)
}

func authorizeArgumentsWithLimits(args []string, scope authz.Scope, limits authz.LimitsConfig, catalog authz.MetricCatalog) ([]string, error) {
	if len(args) == 0 {
		return nil, errors.New("qdm-metric-cli command is required")
	}
	if err := requireDoubleHyphenFlags(args[1:]); err != nil {
		return nil, err
	}
	if err := rejectRuntimeEndpointOverrides(args[1:]); err != nil {
		return nil, err
	}
	authorizationScope := authorizationScope{
		ManageAreaIDs:     append([]string(nil), scope.ManageAreaIDs...),
		DCManageAreaIDs:   append([]string(nil), scope.DCManageAreaIDs...),
		CategoryLevel1IDs: append([]string(nil), scope.CategoryLevel1IDs...),
	}
	switch args[0] {
	case "metric":
		return authorizeMetricCommand(args, limits)
	case "tag", "health", "version":
		return append([]string(nil), args...), nil
	case "wikis":
		return authorizeWikis(args, catalog)
	case "dim":
		if len(args) > 1 && args[1] == "search" {
			return authorizeDimensionSearch(args, limits, catalog)
		}
		if len(args) > 1 && args[1] == "values" {
			return authorizeDimensionValues(args, limits)
		}
		return nil, errors.New("unsupported qdm-metric-cli dim subcommand")
	case "analysis":
		return authorizeAnalysis(args, authorizationScope, limits, catalog)
	case "registry", "doris":
		return nil, errors.New("administrative qdm-metric-cli commands are not available to an Agent")
	default:
		return nil, fmt.Errorf("unsupported qdm-metric-cli command %q", args[0])
	}
}

func rejectRuntimeEndpointOverrides(args []string) error {
	for index := 0; index < len(args); index++ {
		argument := args[index]
		switch {
		case argument == "--payload" || strings.HasPrefix(argument, "--payload="):
			return errors.New("--payload file input is unavailable through the trusted broker; use --payload-json")
		case argument == "--socket":
			if index+1 >= len(args) {
				return errors.New("--socket requires a value")
			}
			if args[index+1] != "" {
				return errors.New("qdm-metric-cli socket overrides are not available to an Agent")
			}
			index++
		case strings.HasPrefix(argument, "--socket="):
			if strings.TrimPrefix(argument, "--socket=") != "" {
				return errors.New("qdm-metric-cli socket overrides are not available to an Agent")
			}
		}
	}
	return nil
}

func authorizeWikis(args []string, catalog authz.MetricCatalog) ([]string, error) {
	parsed, err := parseWikisArgumentsV010(args[1:])
	if errors.Is(err, flag.ErrHelp) {
		return append([]string(nil), args...), nil
	}
	if err != nil {
		return nil, err
	}
	if parsed.Output != "data" && parsed.Output != "envelope" {
		return nil, errors.New("wikis --output must be data or envelope")
	}
	code := strings.TrimSpace(parsed.Code)
	if code != "" {
		if err := authorizeMetric("--code", code, catalog); err != nil {
			return nil, err
		}
	}
	return append([]string(nil), args...), nil
}

func authorizeMetricCommand(args []string, limits authz.LimitsConfig) ([]string, error) {
	if len(args) < 2 || args[1] != "search" {
		return nil, errors.New("unsupported qdm-metric-cli metric subcommand")
	}
	parsed, err := parseMetricSearchArgumentsV010(args[2:])
	if errors.Is(err, flag.ErrHelp) {
		return append([]string(nil), args...), nil
	}
	if err != nil {
		return nil, err
	}
	return enforceMetadataLimit(args, parsed.Limit, parsed.Visited["limit"], limits)
}

func authorizeDimensionSearch(args []string, limits authz.LimitsConfig, catalog authz.MetricCatalog) ([]string, error) {
	parsed, err := parseDimensionSearchArgumentsV010(args[2:])
	if errors.Is(err, flag.ErrHelp) {
		return append([]string(nil), args...), nil
	}
	if err != nil {
		return nil, err
	}
	if parsed.Format != "json" && parsed.Format != "jsonl" {
		return nil, errors.New("dim search --format must be json or jsonl")
	}
	if parsed.Output != "data" && parsed.Output != "envelope" {
		return nil, errors.New("dim search --output must be data or envelope")
	}
	metric := strings.TrimSpace(parsed.Metric)
	if metric != "" {
		if err := authorizeMetric("--metric", metric, catalog); err != nil {
			return nil, err
		}
	}
	return enforceMetadataLimit(args, parsed.Limit, parsed.Visited["limit"], limits)
}

func authorizeDimensionValues(args []string, limits authz.LimitsConfig) ([]string, error) {
	parsed, err := parseDimensionValuesArgumentsV010(args[2:])
	if errors.Is(err, flag.ErrHelp) {
		return append([]string(nil), args...), nil
	}
	if err != nil {
		return nil, err
	}
	if parsed.Code == "" {
		return nil, errors.New("dim values --code is required")
	}
	if isProtectedDimension(parsed.Code) {
		return nil, fmt.Errorf("dim values for protected dimension %s is unavailable through the trusted broker", parsed.Code)
	}
	return enforceMetadataLimit(args, parsed.Limit, parsed.Visited["limit"], limits)
}

func enforceMetadataLimit(args []string, requested int, supplied bool, limits authz.LimitsConfig) ([]string, error) {
	if supplied {
		if requested < 1 || limits.MaxMetadataLimit > 0 && int64(requested) > limits.MaxMetadataLimit {
			return nil, errors.New("metadata --limit exceeds the authorization limit")
		}
		return append([]string(nil), args...), nil
	}
	if limits.DefaultMetadataLimit <= 0 {
		return append([]string(nil), args...), nil
	}
	if limits.MaxMetadataLimit > 0 && limits.DefaultMetadataLimit > limits.MaxMetadataLimit {
		return nil, errors.New("default metadata limit exceeds the authorization limit")
	}
	result := append([]string(nil), args...)
	return append(result, "--limit", fmt.Sprintf("%d", limits.DefaultMetadataLimit)), nil
}

func authorizeAnalysis(args []string, scope authorizationScope, limits authz.LimitsConfig, catalog authz.MetricCatalog) ([]string, error) {
	if len(args) < 2 {
		return nil, errors.New("qdm-metric-cli analysis subcommand is required")
	}
	switch args[1] {
	case "validate", "preview", "execute", "total":
	default:
		return nil, fmt.Errorf("unsupported qdm-metric-cli analysis subcommand %q", args[1])
	}

	parsed, err := parseAnalysisArgumentsV010(args[2:])
	if errors.Is(err, flag.ErrHelp) {
		return append([]string(nil), args...), nil
	}
	if err != nil {
		return nil, err
	}
	if parsed.Format != "json" && parsed.Format != "jsonl" {
		return nil, errors.New("analysis --format must be json or jsonl")
	}
	if parsed.Output != "data" && parsed.Output != "envelope" {
		return nil, errors.New("analysis --output must be data or envelope")
	}
	payloadMode := parsed.Payload != "" || parsed.PayloadJSON != ""
	if payloadMode {
		return authorizeAnalysisPayload(
			args[0],
			args[1],
			parsed,
			scope,
			limits,
			catalog,
		)
	}
	return authorizeAnalysisFlags(args, parsed, scope, limits, catalog)
}

func authorizeAnalysisPayload(
	command string,
	action string,
	parsed analysisArgumentsV010,
	scope authorizationScope,
	limits authz.LimitsConfig,
	catalog authz.MetricCatalog,
) ([]string, error) {
	for _, name := range []string{
		"start-date", "end-date", "time-grain", "statistic-policy", "order-by",
		"scope-json", "curr-page", "page-no", "page-size", "metric", "agg-dim",
		"filter", "other-filter", "measure-filter",
	} {
		if parsed.Visited[name] {
			return nil, fmt.Errorf("payload input cannot be combined with --%s", name)
		}
	}
	raw := []byte(parsed.PayloadJSON)
	if len(raw) == 0 || len(raw) > maxPayloadBytes {
		return nil, errors.New("analysis payload is empty or too large")
	}
	normalized, err := authorizeAnalysisPayloadJSON(raw, scope, limits, catalog)
	if err != nil {
		return nil, err
	}

	result := []string{command, action, "--payload-json", string(normalized)}
	result = appendStringFlagIfVisited(result, parsed.Visited, "socket", parsed.Socket)
	result = appendDurationFlagIfVisited(result, parsed.Visited, "timeout", parsed.Timeout)
	result = appendStringFlagIfVisited(result, parsed.Visited, "request-id", parsed.RequestID)
	result = appendBoolFlagIfVisited(result, parsed.Visited, "single-page", parsed.SinglePage)
	result = appendBoolFlagIfVisited(result, parsed.Visited, "yoy", parsed.YOY)
	result = appendBoolFlagIfVisited(result, parsed.Visited, "mom", parsed.MOM)
	result = appendBoolFlagIfVisited(result, parsed.Visited, "biz-thresh", parsed.BizThreshold)
	result = appendStringFlagIfVisited(result, parsed.Visited, "format", parsed.Format)
	result = appendStringFlagIfVisited(result, parsed.Visited, "output", parsed.Output)
	return result, nil
}

func authorizeAnalysisPayloadJSON(raw []byte, scope authorizationScope, limits authz.LimitsConfig, catalog authz.MetricCatalog) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, errors.New("analysis payload must be a JSON object")
	}
	// Fail closed on ambiguous protected aliases. The real v0.1.0 decoder uses
	// encoding/json's last-match behavior, which is unsafe for authorization.
	metricsPresent, metricsAliases := foldedJSONField(fields, "metrics")
	if metricsAliases > 1 {
		return nil, errors.New(`analysis payload contains conflicting "metrics" fields`)
	}
	dimensionsPresent, dimensionsAliases := foldedJSONField(fields, "dimensions")
	if dimensionsAliases > 1 {
		return nil, errors.New(`analysis payload contains conflicting "dimensions" fields`)
	}
	timePresent, timeAliases := foldedJSONField(fields, "time")
	if timeAliases > 1 {
		return nil, errors.New(`analysis payload contains conflicting "time" fields`)
	}
	pageSizePresent, pageSizeAliases := foldedJSONField(fields, "pageSize")
	if pageSizeAliases > 1 {
		return nil, errors.New(`analysis payload contains conflicting "pageSize" fields`)
	}
	if pageSizePresent {
		for key, value := range fields {
			if strings.EqualFold(key, "pageSize") && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return nil, errors.New("analysis pageSize must be an integer")
			}
		}
	}
	_, filterAliases := foldedJSONField(fields, "filters")
	if filterAliases > 1 {
		return nil, errors.New(`analysis payload contains conflicting "filters" fields`)
	}

	var request analysisAuthorizationRequestV010
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, fmt.Errorf("analysis payload has an invalid request shape: %w", err)
	}
	if err := authorizeAnalysisRequest(&request, scope, limits, catalog); err != nil {
		return nil, err
	}

	deleteFoldedJSONFields(fields, "metrics")
	deleteFoldedJSONFields(fields, "dimensions")
	deleteFoldedJSONFields(fields, "time")
	deleteFoldedJSONFields(fields, "pageSize")
	deleteFoldedJSONFields(fields, "filters")
	if metricsPresent {
		encodedMetrics, err := json.Marshal(request.Metrics)
		if err != nil {
			return nil, err
		}
		fields["metrics"] = encodedMetrics
	}
	if dimensionsPresent {
		encodedDimensions, err := json.Marshal(request.Dimensions)
		if err != nil {
			return nil, err
		}
		fields["dimensions"] = encodedDimensions
	}
	if timePresent {
		encodedTime, err := json.Marshal(request.Time)
		if err != nil {
			return nil, err
		}
		fields["time"] = encodedTime
	}
	if request.PageSize != nil {
		encodedPageSize, err := json.Marshal(*request.PageSize)
		if err != nil {
			return nil, err
		}
		fields["pageSize"] = encodedPageSize
	}
	encodedFilters, err := json.Marshal(request.Filters)
	if err != nil {
		return nil, err
	}
	fields["filters"] = encodedFilters
	return json.Marshal(fields)
}

func authorizeAnalysisRequest(request *analysisAuthorizationRequestV010, scope authorizationScope, limits authz.LimitsConfig, catalog authz.MetricCatalog) error {
	if limits.MaxMetrics > 0 && int64(len(request.Metrics)) > limits.MaxMetrics {
		return errors.New("analysis request contains too many metrics")
	}
	for _, metric := range request.Metrics {
		if strings.TrimSpace(metric) != metric || metric == "" || !catalog.ApproveMetric(metric) {
			return errors.New("analysis request contains an unauthorized metric")
		}
	}
	if len(request.Metrics) == 0 {
		return errors.New("analysis request requires at least one metric")
	}
	if limits.MaxDimensions > 0 && int64(len(request.Dimensions)) > limits.MaxDimensions {
		return errors.New("analysis request contains too many dimensions")
	}
	for _, dimension := range request.Dimensions {
		if strings.TrimSpace(dimension) != dimension || dimension == "" {
			return errors.New("analysis request contains an invalid dimension")
		}
		if !allMetricsSupportDimension(request.Metrics, dimension, catalog) {
			return fmt.Errorf("analysis dimension %s is not supported by every selected metric", dimension)
		}
	}
	if err := validateDateRange(request.Time.StartDate, request.Time.EndDate, limits.MaxDateRangeDays); err != nil {
		return err
	}
	if request.PageSize == nil {
		if limits.DefaultPageSize > 0 {
			pageSize := int(limits.DefaultPageSize)
			request.PageSize = &pageSize
		}
	} else if *request.PageSize < 1 || limits.MaxPageSize > 0 && int64(*request.PageSize) > limits.MaxPageSize {
		return errors.New("analysis pageSize exceeds the authorization limit")
	}
	if request.Filters == nil {
		request.Filters = analysisAuthorizationFiltersV010{}
	}
	for dimension, values := range request.Filters {
		for _, value := range values {
			if strings.TrimSpace(value) != value || value == "" || strings.ContainsAny(value, ",*") {
				return fmt.Errorf("analysis filter %s contains an invalid value", dimension)
			}
		}
	}
	filters := map[string][]string(request.Filters)
	if err := authorizeProtectedFilters(request.Metrics, request.Dimensions, filters, scope, catalog); err != nil {
		return err
	}
	request.Filters = analysisAuthorizationFiltersV010(filters)
	return nil
}

type protectedScopeGroup struct {
	dimensions []string
	authorized []string
}

func protectedScopeGroups(scope authorizationScope) []protectedScopeGroup {
	return []protectedScopeGroup{
		{dimensions: []string{"manageAreaId"}, authorized: scope.ManageAreaIDs},
		{dimensions: []string{"dcManageAreaId", "sapArea2Id"}, authorized: scope.DCManageAreaIDs},
		{dimensions: []string{"categoryLevel1Id"}, authorized: scope.CategoryLevel1IDs},
	}
}

func allMetricsSupportDimension(metrics []string, dimension string, catalog authz.MetricCatalog) bool {
	if len(metrics) == 0 {
		return false
	}
	for _, metric := range metrics {
		if !catalog.MetricSupportsDimension(metric, dimension) {
			return false
		}
	}
	return true
}

func authorizeProtectedFilters(
	metrics []string,
	dimensions []string,
	filters map[string][]string,
	scope authorizationScope,
	catalog authz.MetricCatalog,
) error {
	requestedDimensions := make(map[string]struct{}, len(dimensions)+len(filters))
	for _, dimension := range dimensions {
		requestedDimensions[dimension] = struct{}{}
	}
	for dimension := range filters {
		requestedDimensions[dimension] = struct{}{}
	}

	applied := false
	for _, group := range protectedScopeGroups(scope) {
		requestedProtected := make([]string, 0, len(group.dimensions))
		for _, dimension := range group.dimensions {
			if _, requested := requestedDimensions[dimension]; requested {
				requestedProtected = append(requestedProtected, dimension)
			}
		}
		if len(requestedProtected) > 0 {
			for _, dimension := range requestedProtected {
				if !allMetricsSupportDimension(metrics, dimension, catalog) {
					return fmt.Errorf("analysis protected dimension %s is not supported by every selected metric", dimension)
				}
				if err := constrainFilter(filters, dimension, group.authorized); err != nil {
					return err
				}
				applied = true
			}
			continue
		}

		if len(group.authorized) == 0 {
			continue
		}
		for _, candidate := range group.dimensions {
			if !allMetricsSupportDimension(metrics, candidate, catalog) {
				continue
			}
			filters[candidate] = append([]string(nil), group.authorized...)
			applied = true
			break
		}
	}
	if !applied {
		return errors.New("requester authorization scope does not cover every selected metric")
	}
	return nil
}

func foldedJSONField(fields map[string]json.RawMessage, name string) (bool, int) {
	count := 0
	for key := range fields {
		if strings.EqualFold(key, name) {
			count++
		}
	}
	return count > 0, count
}

func deleteFoldedJSONFields(fields map[string]json.RawMessage, name string) {
	for key := range fields {
		if strings.EqualFold(key, name) {
			delete(fields, key)
		}
	}
}

func constrainFilter(filters map[string][]string, dimension string, authorized []string) error {
	if len(authorized) == 0 {
		return fmt.Errorf("requester authorization scope for %s is empty", dimension)
	}
	allowed := make(map[string]struct{}, len(authorized))
	for _, value := range authorized {
		allowed[value] = struct{}{}
	}
	values, exists := filters[dimension]
	if !exists || len(values) == 0 {
		filters[dimension] = append([]string(nil), authorized...)
		return nil
	}
	for _, value := range values {
		if _, ok := allowed[value]; !ok {
			return fmt.Errorf("analysis filter %s contains an unauthorized value", dimension)
		}
	}
	return nil
}

func constrainExistingFilter(filters map[string][]string, dimension string, authorized []string) error {
	values, exists := filters[dimension]
	if !exists || len(values) == 0 {
		return nil
	}
	allowed := make(map[string]struct{}, len(authorized))
	for _, value := range authorized {
		allowed[value] = struct{}{}
	}
	for _, value := range values {
		if _, ok := allowed[value]; !ok {
			return fmt.Errorf("analysis filter %s contains an unauthorized value", dimension)
		}
	}
	return nil
}

func authorizeAnalysisFlags(
	args []string,
	parsed analysisArgumentsV010,
	scope authorizationScope,
	limits authz.LimitsConfig,
	catalog authz.MetricCatalog,
) ([]string, error) {
	if limits.MaxMetrics > 0 && int64(len(parsed.Metrics)) > limits.MaxMetrics {
		return nil, errors.New("analysis request contains too many metrics")
	}
	for _, metric := range parsed.Metrics {
		if err := authorizeMetric("--metric", metric, catalog); err != nil {
			return nil, err
		}
	}
	if len(parsed.Metrics) == 0 {
		return nil, errors.New("analysis request requires at least one metric")
	}
	if limits.MaxDimensions > 0 && int64(len(parsed.Dimensions)) > limits.MaxDimensions {
		return nil, errors.New("analysis request contains too many dimensions")
	}
	if err := validateDateRange(parsed.StartDate, parsed.EndDate, limits.MaxDateRangeDays); err != nil {
		return nil, err
	}
	if parsed.Visited["page-size"] {
		if parsed.PageSize < 1 || limits.MaxPageSize > 0 && int64(parsed.PageSize) > limits.MaxPageSize {
			return nil, errors.New("analysis --page-size exceeds the authorization limit")
		}
	}
	for _, dimension := range parsed.Dimensions {
		if strings.TrimSpace(dimension) != dimension || dimension == "" ||
			!allMetricsSupportDimension(parsed.Metrics, dimension, catalog) {
			return nil, fmt.Errorf("analysis dimension %s is not supported by every selected metric", dimension)
		}
	}

	protectedFilters := map[string][]string{}
	for _, filter := range append(append([]string(nil), parsed.Filters...), parsed.OtherFilters...) {
		dimension, values, err := parseFilterArgument(filter)
		if err != nil {
			return nil, err
		}
		if !isProtectedDimension(dimension) {
			continue
		}
		protectedFilters[dimension] = append(protectedFilters[dimension], values...)
	}
	if err := authorizeProtectedFilters(parsed.Metrics, parsed.Dimensions, protectedFilters, scope, catalog); err != nil {
		return nil, err
	}

	result := make([]string, 0, len(args)+len(protectedFilters)*2)
	result = append(result, args[0], args[1])
	if !parsed.Visited["page-size"] && limits.DefaultPageSize > 0 {
		result = append(result, "--page-size", fmt.Sprintf("%d", limits.DefaultPageSize))
	}
	for _, dimension := range []string{"manageAreaId", "dcManageAreaId", "sapArea2Id", "categoryLevel1Id"} {
		if _, supplied := requestedFilterDimension(parsed.Filters, parsed.OtherFilters, dimension); supplied {
			continue
		}
		if values := protectedFilters[dimension]; len(values) > 0 {
			result = append(result, "--filter", dimension+"="+strings.Join(values, ","))
		}
	}
	result = append(result, args[2:]...)
	return result, nil
}

func validateDateRange(startDate, endDate string, maxDays int64) error {
	if startDate == "" && endDate == "" {
		return nil
	}
	if startDate == "" || endDate == "" {
		return errors.New("analysis date range requires both startDate and endDate")
	}
	start, err := time.Parse(time.DateOnly, startDate)
	if err != nil || start.Format(time.DateOnly) != startDate {
		return errors.New("analysis startDate must use YYYY-MM-DD")
	}
	end, err := time.Parse(time.DateOnly, endDate)
	if err != nil || end.Format(time.DateOnly) != endDate {
		return errors.New("analysis endDate must use YYYY-MM-DD")
	}
	if end.Before(start) {
		return errors.New("analysis date range endDate precedes startDate")
	}
	days := int64(end.Sub(start)/(24*time.Hour)) + 1
	if maxDays > 0 && days > maxDays {
		return errors.New("analysis date range exceeds the authorization limit")
	}
	return nil
}

func authorizeMetric(flagName, value string, catalog authz.MetricCatalog) error {
	if strings.TrimSpace(value) != value || value == "" || !catalog.ApproveMetric(value) {
		return fmt.Errorf("%s contains an unauthorized metric", flagName)
	}
	return nil
}

func parseFilterArgument(value string) (string, []string, error) {
	dimension, rawValues, ok := strings.Cut(value, "=")
	if !ok || strings.TrimSpace(dimension) != dimension || dimension == "" || rawValues == "" {
		return "", nil, fmt.Errorf("--filter must use dimension=value1,value2: %q", value)
	}
	values := strings.Split(rawValues, ",")
	result := make([]string, 0, len(values))
	for _, item := range values {
		item = strings.TrimSpace(item)
		if item == "" {
			return "", nil, fmt.Errorf("--filter %s contains an empty value", dimension)
		}
		result = append(result, item)
	}
	return dimension, result, nil
}

func isProtectedDimension(dimension string) bool {
	for _, group := range protectedScopeGroups(authorizationScope{}) {
		for _, protected := range group.dimensions {
			if dimension == protected {
				return true
			}
		}
	}
	return false
}

func requestedFilterDimension(filters, otherFilters []string, dimension string) ([]string, bool) {
	for _, filter := range append(append([]string(nil), filters...), otherFilters...) {
		parsedDimension, values, err := parseFilterArgument(filter)
		if err == nil && parsedDimension == dimension {
			return values, true
		}
	}
	return nil, false
}
