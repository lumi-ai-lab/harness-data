package authz

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxMetricCatalogBytes = 4 << 20
	maxCatalogCodeBytes   = 256
	maxCatalogNameBytes   = 512
	catalogGeneratedFrom  = "qdm-metric-cli-v0.1.0-contract"
	protectedAreaCode     = "manageAreaId"
	protectedCategoryCode = "categoryLevel1Id"
)

type metricCatalogFile struct {
	Version       int                      `json:"version"`
	GeneratedFrom string                   `json:"generatedFrom"`
	Metrics       map[string]CatalogMetric `json:"metrics"`
}

// CatalogMetric is one business-approved metric contract.
type CatalogMetric struct {
	SupportedDimensions []string               `json:"supportedDimensions"`
	DictionaryRefs      []CatalogDictionaryRef `json:"dictionaryRefs"`
}

// CatalogDictionaryRef maps an approved dictionary identifier back to one
// approved metric without relying on mutable online metadata.
type CatalogDictionaryRef struct {
	QueryType    int      `json:"queryType"`
	ID           string   `json:"id"`
	InternalCode string   `json:"internalCode"`
	Names        []string `json:"names"`
}

// CatalogMatch is the unique result of a dictionary lookup.
type CatalogMatch struct {
	Metric string
	Ref    CatalogDictionaryRef
}

// MetricCatalog is the validated, digest-pinned V1 metric catalog used
// by both readiness and the runtime public Metric CLI.
type MetricCatalog struct {
	Metrics    map[string]CatalogMetric
	ByID       map[string]CatalogMatch
	ByInternal map[string]CatalogMatch
	ByName     map[string]CatalogMatch
}

// LoadMetricCatalog verifies the exact file digest and parses the complete
// catalog contract. A matching digest alone is not sufficient for readiness.
func LoadMetricCatalog(path, expectedSHA256 string) (MetricCatalog, error) {
	invalid := func(message string, err error) (MetricCatalog, error) {
		return MetricCatalog{}, authzError(CodeArtifactIntegrityFailed, message, err)
	}
	if err := validateAbsoluteCleanPath(path); err != nil || !lowercaseSHA256Pattern.MatchString(expectedSHA256) {
		return invalid("approved metric catalog parameters are invalid", err)
	}
	raw, _, err := readRegularFile(path, maxMetricCatalogBytes)
	if err != nil {
		return invalid("approved metric catalog cannot be read safely", err)
	}
	if sha256Hex(raw) != expectedSHA256 {
		return invalid("approved metric catalog digest does not match", nil)
	}
	var document metricCatalogFile
	if err := decodeStrictJSON(raw, &document); err != nil {
		return invalid("approved metric catalog format is invalid", err)
	}
	if document.Version != CurrentVersion || document.GeneratedFrom != catalogGeneratedFrom || len(document.Metrics) == 0 {
		return invalid("approved metric catalog version is invalid", nil)
	}

	catalog := MetricCatalog{
		Metrics:    document.Metrics,
		ByID:       make(map[string]CatalogMatch),
		ByInternal: make(map[string]CatalogMatch),
		ByName:     make(map[string]CatalogMatch),
	}
	for code, metric := range document.Metrics {
		if err := validateCatalogCode(code); err != nil {
			return invalid("approved metric catalog contains an invalid metric code", err)
		}
		dimensions := make(map[string]struct{}, len(metric.SupportedDimensions))
		for _, dimension := range metric.SupportedDimensions {
			if err := validateCatalogCode(dimension); err != nil {
				return invalid("approved metric catalog contains an invalid dimension", err)
			}
			if _, duplicate := dimensions[dimension]; duplicate {
				return invalid("approved metric catalog contains a duplicate dimension", nil)
			}
			dimensions[dimension] = struct{}{}
		}
		if _, ok := dimensions[protectedAreaCode]; !ok {
			return invalid("approved metric catalog omits a protected dimension", nil)
		}
		if _, ok := dimensions[protectedCategoryCode]; !ok {
			return invalid("approved metric catalog omits a protected dimension", nil)
		}

		for _, ref := range metric.DictionaryRefs {
			if ref.QueryType != 1 && ref.QueryType != 2 {
				return invalid("approved metric catalog contains an invalid query type", nil)
			}
			if err := validateCatalogCode(ref.ID); err != nil {
				return invalid("approved metric catalog contains an invalid dictionary id", err)
			}
			if err := validateCatalogCode(ref.InternalCode); err != nil {
				return invalid("approved metric catalog contains an invalid internal code", err)
			}
			match := CatalogMatch{Metric: code, Ref: ref}
			if _, duplicate := catalog.ByID[ref.ID]; duplicate {
				return invalid("approved metric catalog dictionary id is not unique", nil)
			}
			catalog.ByID[ref.ID] = match
			if _, duplicate := catalog.ByInternal[ref.InternalCode]; duplicate {
				return invalid("approved metric catalog internal code is not unique", nil)
			}
			catalog.ByInternal[ref.InternalCode] = match
			if len(ref.Names) == 0 {
				return invalid("approved metric catalog dictionary name is empty", nil)
			}
			localNames := make(map[string]struct{}, len(ref.Names))
			for _, name := range ref.Names {
				if name != strings.TrimSpace(name) || validateCatalogText(name, maxCatalogNameBytes, false) != nil {
					return invalid("approved metric catalog contains an invalid dictionary name", nil)
				}
				if _, duplicate := localNames[name]; duplicate {
					return invalid("approved metric catalog contains a duplicate dictionary name", nil)
				}
				localNames[name] = struct{}{}
				key := catalogNameKey(ref.QueryType, name)
				if _, duplicate := catalog.ByName[key]; duplicate {
					return invalid("approved metric catalog dictionary name mapping is not unique", nil)
				}
				catalog.ByName[key] = match
			}
		}
	}
	return catalog, nil
}

func (catalog MetricCatalog) ApproveMetric(code string) bool {
	_, ok := catalog.Metrics[code]
	return ok
}

func (catalog MetricCatalog) MatchID(id string, queryType int, requireQueryType bool) (CatalogMatch, bool) {
	match, ok := catalog.ByID[id]
	if !ok || requireQueryType && match.Ref.QueryType != queryType {
		return CatalogMatch{}, false
	}
	return match, true
}

func (catalog MetricCatalog) MatchInternal(code string) (CatalogMatch, bool) {
	match, ok := catalog.ByInternal[code]
	return match, ok
}

func (catalog MetricCatalog) MatchName(name string, queryType int) (CatalogMatch, bool) {
	match, ok := catalog.ByName[catalogNameKey(queryType, name)]
	return match, ok
}

func (catalog MetricCatalog) IDMatchesMetric(id, metric string, queryType int) bool {
	match, ok := catalog.MatchID(id, queryType, true)
	return ok && match.Metric == metric
}

func catalogNameKey(queryType int, name string) string {
	return fmt.Sprintf("%d\x00%s", queryType, name)
}

func validateCatalogCode(value string) error {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsAny(value, ",=:") {
		return fmt.Errorf("invalid code")
	}
	return validateCatalogText(value, maxCatalogCodeBytes, false)
}

func validateCatalogText(value string, maxBytes int, allowEmpty bool) error {
	if (!allowEmpty && value == "") || len(value) > maxBytes || !utf8.ValidString(value) {
		return fmt.Errorf("invalid text")
	}
	for _, r := range value {
		if r == 0 || unicode.IsControl(r) {
			return fmt.Errorf("control character")
		}
	}
	return nil
}
