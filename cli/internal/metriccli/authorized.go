package metriccli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"harness-data/cli/internal/authz"
)

const (
	bindingEnvironment = "HARNESS_AUTHZ_BINDING_V1"
	metricEnvironment  = "QDM_METRIC_CLI"
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
	config, err := authz.LoadConfig(configPath)
	if err != nil {
		return deny(err)
	}
	encoded := strings.TrimSpace(os.Getenv(bindingEnvironment))
	if encoded == "" {
		return denyCode(authz.CodeBindingMissing, "qdm-metric-cli requires a Harness authorization binding")
	}
	binding, err := authz.DecodeBinding(encoded)
	if err != nil {
		return deny(err)
	}
	loaded, err := authz.ValidateCurrent(config, binding)
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
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &ExitError{Code: 124, Err: errors.New("qdm-metric-cli authorization execution timed out")}
		}
		var processErr *exec.ExitError
		if errors.As(err, &processErr) {
			return &ExitError{Code: processErr.ExitCode(), Err: err}
		}
		return err
	}
	if int64(output.Len()) > config.Limits.MaxOutputBytes {
		return &ExitError{Code: 77, Err: errors.New("qdm-metric-cli output exceeds the authorization limit")}
	}
	_, err := stdout.Write(output.Bytes())
	return err
}

func metricEnvironmentForChild() []string {
	environment := make([]string, 0, len(os.Environ())+2)
	for _, entry := range os.Environ() {
		name, _, ok := strings.Cut(entry, "=")
		if name == metricEnvironment || name == "QDM_CMR_CLI" || name == "QDM_SQL_CLI" ||
			name == "QDM_CAS_CLI" || name == "QDM_CAS_CONFIG_DIR" {
			continue
		}
		if ok {
			environment = append(environment, entry)
		}
	}
	environment = append(environment, bindingEnvironment+"="+os.Getenv(bindingEnvironment))
	return environment
}

type authorizationScope struct {
	ManageAreaIDs     []string
	CategoryLevel1IDs []string
}

func authorizeArguments(args []string, scope authz.Scope, maxMetrics int64, catalog authz.MetricCatalog) ([]string, error) {
	if len(args) == 0 {
		return nil, errors.New("qdm-metric-cli command is required")
	}
	authorizationScope := authorizationScope{
		ManageAreaIDs:     append([]string(nil), scope.ManageAreaIDs...),
		CategoryLevel1IDs: append([]string(nil), scope.CategoryLevel1IDs...),
	}
	switch args[0] {
	case "metric", "tag", "health", "version":
		return append([]string(nil), args...), nil
	case "wikis":
		return authorizeMetricFlag(args, "--code", catalog)
	case "dim":
		if len(args) > 1 && args[1] == "search" {
			return authorizeMetricFlag(args, "--metric", catalog)
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

func authorizeAnalysis(args []string, scope authorizationScope, maxMetrics int64, catalog authz.MetricCatalog) ([]string, error) {
	if len(args) < 2 {
		return nil, errors.New("qdm-metric-cli analysis subcommand is required")
	}
	switch args[1] {
	case "validate", "preview", "execute", "total":
	default:
		return nil, fmt.Errorf("unsupported qdm-metric-cli analysis subcommand %q", args[1])
	}

	payloadIndex, payloadJSONIndex := -1, -1
	for index := 2; index < len(args); index++ {
		switch args[index] {
		case "--payload":
			payloadIndex = index
		case "--payload-json":
			payloadJSONIndex = index
		default:
			if strings.HasPrefix(args[index], "--payload=") {
				payloadIndex = index
			}
			if strings.HasPrefix(args[index], "--payload-json=") {
				payloadJSONIndex = index
			}
		}
	}
	if payloadIndex >= 0 && payloadJSONIndex >= 0 {
		return nil, errors.New("analysis payload input cannot be combined")
	}
	if payloadIndex >= 0 || payloadJSONIndex >= 0 {
		return authorizeAnalysisPayload(args, payloadIndex, payloadJSONIndex, scope, maxMetrics, catalog)
	}
	return authorizeAnalysisFlags(args, scope, maxMetrics, catalog)
}

func authorizeAnalysisPayload(args []string, payloadIndex, payloadJSONIndex int, scope authorizationScope, maxMetrics int64, catalog authz.MetricCatalog) ([]string, error) {
	index := payloadIndex
	prefix := "--payload"
	if payloadJSONIndex >= 0 {
		index = payloadJSONIndex
		prefix = "--payload-json"
	}
	var raw []byte
	if strings.HasPrefix(args[index], prefix+"=") {
		value := strings.TrimPrefix(args[index], prefix+"=")
		if prefix == "--payload" {
			var err error
			raw, err = os.ReadFile(filepath.Clean(value))
			if err != nil {
				return nil, fmt.Errorf("analysis payload cannot be read: %w", err)
			}
		} else {
			raw = []byte(value)
		}
	} else {
		if index+1 >= len(args) {
			return nil, fmt.Errorf("%s requires a value", prefix)
		}
		if prefix == "--payload" {
			var err error
			raw, err = os.ReadFile(filepath.Clean(args[index+1]))
			if err != nil {
				return nil, fmt.Errorf("analysis payload cannot be read: %w", err)
			}
		} else {
			raw = []byte(args[index+1])
		}
	}
	if len(raw) == 0 || len(raw) > maxPayloadBytes {
		return nil, errors.New("analysis payload is empty or too large")
	}
	var request map[string]any
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, fmt.Errorf("analysis payload must be a JSON object: %w", err)
	}
	if err := authorizeRequestObject(request, scope, maxMetrics, catalog); err != nil {
		return nil, err
	}
	normalized, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(args)+1)
	for position := 0; position < len(args); position++ {
		if position == index {
			result = append(result, "--payload-json", string(normalized))
			if !strings.Contains(args[position], "=") {
				position++
			}
			continue
		}
		result = append(result, args[position])
	}
	return result, nil
}

func authorizeRequestObject(request map[string]any, scope authorizationScope, maxMetrics int64, catalog authz.MetricCatalog) error {
	metrics, ok := request["metrics"].([]any)
	if ok && maxMetrics > 0 && int64(len(metrics)) > maxMetrics {
		return errors.New("analysis request contains too many metrics")
	}
	for _, rawMetric := range metrics {
		metric, ok := rawMetric.(string)
		if !ok || strings.TrimSpace(metric) != metric || metric == "" || !catalog.ApproveMetric(metric) {
			return errors.New("analysis request contains an unauthorized metric")
		}
	}
	filters, err := filtersFromObject(request["filters"])
	if err != nil {
		return err
	}
	if err := constrainFilter(filters, "manageAreaId", scope.ManageAreaIDs); err != nil {
		return err
	}
	if err := constrainExistingFilter(filters, "sapArea2Id", scope.ManageAreaIDs); err != nil {
		return err
	}
	if err := constrainFilter(filters, "categoryLevel1Id", scope.CategoryLevel1IDs); err != nil {
		return err
	}
	request["filters"] = filters
	return nil
}

func filtersFromObject(value any) (map[string][]string, error) {
	if value == nil {
		return map[string][]string{}, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("analysis filters must be an object")
	}
	filters := make(map[string][]string, len(object))
	for dimension, rawValues := range object {
		values, ok := rawValues.([]any)
		if !ok {
			return nil, fmt.Errorf("analysis filter %s must be an array", dimension)
		}
		for _, rawValue := range values {
			value, ok := rawValue.(string)
			if !ok || strings.TrimSpace(value) != value || value == "" || strings.ContainsAny(value, ",*") {
				return nil, fmt.Errorf("analysis filter %s contains an invalid value", dimension)
			}
			filters[dimension] = append(filters[dimension], value)
		}
	}
	return filters, nil
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

func authorizeAnalysisFlags(args []string, scope authorizationScope, maxMetrics int64, catalog authz.MetricCatalog) ([]string, error) {
	result := append([]string(nil), args...)
	metrics := int64(0)
	areasPresent, categoriesPresent := false, false
	for index := 2; index < len(result); index++ {
		argument := result[index]
		if argument == "--metric" {
			if index+1 >= len(result) {
				return nil, errors.New("--metric requires a value")
			}
			if err := authorizeMetric(argument, result[index+1], catalog); err != nil {
				return nil, err
			}
			metrics++
			index++
			continue
		}
		if strings.HasPrefix(argument, "--metric=") {
			if err := authorizeMetric("--metric", strings.TrimPrefix(argument, "--metric="), catalog); err != nil {
				return nil, err
			}
			metrics++
			continue
		}
		if argument == "--filter" {
			if index+1 >= len(result) {
				return nil, errors.New("--filter requires a value")
			}
			if err := constrainFilterArgument(result[index+1], scope, &areasPresent, &categoriesPresent); err != nil {
				return nil, err
			}
			index++
			continue
		}
		if strings.HasPrefix(argument, "--filter=") {
			if err := constrainFilterArgument(strings.TrimPrefix(argument, "--filter="), scope, &areasPresent, &categoriesPresent); err != nil {
				return nil, err
			}
		}
	}
	if maxMetrics > 0 && metrics > maxMetrics {
		return nil, errors.New("analysis request contains too many metrics")
	}
	if !areasPresent {
		result = append(result, "--filter", "manageAreaId="+strings.Join(scope.ManageAreaIDs, ","))
	}
	if !categoriesPresent {
		result = append(result, "--filter", "categoryLevel1Id="+strings.Join(scope.CategoryLevel1IDs, ","))
	}
	return result, nil
}

func authorizeMetricFlag(args []string, flagName string, catalog authz.MetricCatalog) ([]string, error) {
	result := append([]string(nil), args...)
	for index := 1; index < len(result); index++ {
		switch {
		case result[index] == flagName:
			if index+1 >= len(result) {
				return nil, fmt.Errorf("%s requires a value", flagName)
			}
			if err := authorizeMetric(flagName, result[index+1], catalog); err != nil {
				return nil, err
			}
			index++
		case strings.HasPrefix(result[index], flagName+"="):
			if err := authorizeMetric(flagName, strings.TrimPrefix(result[index], flagName+"="), catalog); err != nil {
				return nil, err
			}
		}
	}
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
