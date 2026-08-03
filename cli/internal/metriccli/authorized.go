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

	forwarded, err := authorizeArguments(
		args,
		loaded.Envelope.RequesterContext.Authorization.Scope,
		config.Limits.MaxMetrics,
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
	defer cancel()

	command := exec.CommandContext(ctx, config.RealMetricCLI.Path, args...)
	command.Stdin = stdin
	command.Env = metricEnvironmentForChild()
	output := newBoundedCapture(config.Limits.MaxOutputBytes)
	errorOutput := newBoundedCapture(config.Limits.MaxOutputBytes)
	command.Stdout = &output
	command.Stderr = &errorOutput
	if err := command.Run(); err != nil {
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
	if _, err := stderr.Write(errorOutput.Bytes()); err != nil {
		return err
	}
	if output.Overflowed() || errorOutput.Overflowed() {
		return &ExitError{Code: 77, Err: errors.New("qdm-metric-cli output exceeds the authorization limit")}
	}
	_, err := stdout.Write(output.Bytes())
	return err
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
	CategoryLevel1IDs []string
}

// analysisAuthorizationRequestV010 mirrors the security-relevant JSON fields
// decoded by the pinned real Metric CLI v0.1.0.
type analysisAuthorizationRequestV010 struct {
	Metrics []string                         `json:"metrics"`
	Filters analysisAuthorizationFiltersV010 `json:"filters"`
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
		CategoryLevel1IDs: append([]string(nil), scope.CategoryLevel1IDs...),
	}
	switch args[0] {
	case "metric", "tag", "health", "version":
		return append([]string(nil), args...), nil
	case "wikis":
		return authorizeWikis(args, catalog)
	case "dim":
		if len(args) > 1 && args[1] == "search" {
			return authorizeDimensionSearch(args, catalog)
		}
		return append([]string(nil), args...), nil
	case "analysis":
		return authorizeAnalysis(args, authorizationScope, maxMetrics, catalog)
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

func authorizeDimensionSearch(args []string, catalog authz.MetricCatalog) ([]string, error) {
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
	return append([]string(nil), args...), nil
}

func authorizeAnalysis(args []string, scope authorizationScope, maxMetrics int64, catalog authz.MetricCatalog) ([]string, error) {
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
			maxMetrics,
			catalog,
		)
	}
	return authorizeAnalysisFlags(args, parsed, scope, maxMetrics, catalog)
}

func authorizeAnalysisPayload(
	command string,
	action string,
	parsed analysisArgumentsV010,
	scope authorizationScope,
	maxMetrics int64,
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
	normalized, err := authorizeAnalysisPayloadJSON(raw, scope, maxMetrics, catalog)
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

func authorizeAnalysisPayloadJSON(raw []byte, scope authorizationScope, maxMetrics int64, catalog authz.MetricCatalog) ([]byte, error) {
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
	_, filterAliases := foldedJSONField(fields, "filters")
	if filterAliases > 1 {
		return nil, errors.New(`analysis payload contains conflicting "filters" fields`)
	}

	var request analysisAuthorizationRequestV010
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, fmt.Errorf("analysis payload has an invalid request shape: %w", err)
	}
	if err := authorizeAnalysisRequest(&request, scope, maxMetrics, catalog); err != nil {
		return nil, err
	}

	deleteFoldedJSONFields(fields, "metrics")
	deleteFoldedJSONFields(fields, "filters")
	if metricsPresent {
		encodedMetrics, err := json.Marshal(request.Metrics)
		if err != nil {
			return nil, err
		}
		fields["metrics"] = encodedMetrics
	}
	encodedFilters, err := json.Marshal(request.Filters)
	if err != nil {
		return nil, err
	}
	fields["filters"] = encodedFilters
	return json.Marshal(fields)
}

func authorizeAnalysisRequest(request *analysisAuthorizationRequestV010, scope authorizationScope, maxMetrics int64, catalog authz.MetricCatalog) error {
	if maxMetrics > 0 && int64(len(request.Metrics)) > maxMetrics {
		return errors.New("analysis request contains too many metrics")
	}
	for _, metric := range request.Metrics {
		if strings.TrimSpace(metric) != metric || metric == "" || !catalog.ApproveMetric(metric) {
			return errors.New("analysis request contains an unauthorized metric")
		}
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
	if err := constrainFilter(filters, "manageAreaId", scope.ManageAreaIDs); err != nil {
		return err
	}
	if err := constrainExistingFilter(filters, "sapArea2Id", scope.ManageAreaIDs); err != nil {
		return err
	}
	if err := constrainFilter(filters, "categoryLevel1Id", scope.CategoryLevel1IDs); err != nil {
		return err
	}
	request.Filters = analysisAuthorizationFiltersV010(filters)
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
	maxMetrics int64,
	catalog authz.MetricCatalog,
) ([]string, error) {
	if maxMetrics > 0 && int64(len(parsed.Metrics)) > maxMetrics {
		return nil, errors.New("analysis request contains too many metrics")
	}
	for _, metric := range parsed.Metrics {
		if err := authorizeMetric("--metric", metric, catalog); err != nil {
			return nil, err
		}
	}

	areasPresent, categoriesPresent := false, false
	for _, filter := range parsed.Filters {
		if err := constrainFilterArgument(filter, scope, &areasPresent, &categoriesPresent); err != nil {
			return nil, err
		}
	}

	result := make([]string, 0, len(args)+4)
	result = append(result, args[0], args[1])
	if !areasPresent {
		if len(scope.ManageAreaIDs) == 0 {
			return nil, errors.New("requester authorization scope for manageAreaId is empty")
		}
		result = append(result, "--filter", "manageAreaId="+strings.Join(scope.ManageAreaIDs, ","))
	}
	if !categoriesPresent {
		if len(scope.CategoryLevel1IDs) == 0 {
			return nil, errors.New("requester authorization scope for categoryLevel1Id is empty")
		}
		result = append(result, "--filter", "categoryLevel1Id="+strings.Join(scope.CategoryLevel1IDs, ","))
	}
	result = append(result, args[2:]...)
	return result, nil
}

func authorizeMetric(flagName, value string, catalog authz.MetricCatalog) error {
	if strings.TrimSpace(value) != value || value == "" || !catalog.ApproveMetric(value) {
		return fmt.Errorf("%s contains an unauthorized metric", flagName)
	}
	return nil
}

func constrainFilterArgument(value string, scope authorizationScope, areasPresent, categoriesPresent *bool) error {
	dimension, rawValues, ok := strings.Cut(value, "=")
	if !ok || strings.TrimSpace(dimension) != dimension || dimension == "" || rawValues == "" {
		return fmt.Errorf("--filter must use dimension=value1,value2: %q", value)
	}
	if dimension != "manageAreaId" && dimension != "sapArea2Id" && dimension != "categoryLevel1Id" {
		return nil
	}
	authorized := scope.ManageAreaIDs
	present := areasPresent
	if dimension == "categoryLevel1Id" {
		authorized = scope.CategoryLevel1IDs
		present = categoriesPresent
	}
	allowed := make(map[string]struct{}, len(authorized))
	for _, item := range authorized {
		allowed[item] = struct{}{}
	}
	for _, item := range strings.Split(rawValues, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return fmt.Errorf("--filter %s contains an empty value", dimension)
		}
		if _, ok := allowed[item]; !ok {
			return fmt.Errorf("--filter %s contains an unauthorized value", dimension)
		}
	}
	if dimension != "sapArea2Id" {
		*present = true
	}
	return nil
}
