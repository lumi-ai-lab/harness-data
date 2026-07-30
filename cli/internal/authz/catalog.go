package authz

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	maxIndicatorCatalogBytes = 4 << 20
	maxCatalogCodeBytes      = 256
	maxCatalogNameBytes      = 512
	catalogGeneratedFrom     = "qdm-indicators-cli-v0.0.4-contract"
	protectedAreaCode        = "manageAreaId"
	protectedCategoryCode    = "categoryLevel1Id"
)

type indicatorCatalogFile struct {
	Version       int                         `json:"version"`
	GeneratedFrom string                      `json:"generatedFrom"`
	Indicators    map[string]CatalogIndicator `json:"indicators"`
}

// CatalogIndicator is one business-approved indicator contract.
type CatalogIndicator struct {
	SupportedDimensions []string               `json:"supportedDimensions"`
	DictionaryRefs      []CatalogDictionaryRef `json:"dictionaryRefs"`
}

// CatalogDictionaryRef maps an approved dictionary identifier back to one
// approved indicator without relying on mutable online metadata.
type CatalogDictionaryRef struct {
	QueryType    int      `json:"queryType"`
	ID           string   `json:"id"`
	InternalCode string   `json:"internalCode"`
	Names        []string `json:"names"`
}

// CatalogMatch is the unique result of a dictionary lookup.
type CatalogMatch struct {
	Indicator string
	Ref       CatalogDictionaryRef
}

// IndicatorCatalog is the validated, digest-pinned V1 indicator catalog used
// by both readiness and the runtime Facade.
type IndicatorCatalog struct {
	Indicators map[string]CatalogIndicator
	ByID       map[string]CatalogMatch
	ByInternal map[string]CatalogMatch
	ByName     map[string]CatalogMatch
}

// LoadIndicatorCatalog verifies the exact file digest and parses the complete
// catalog contract. A matching digest alone is not sufficient for readiness.
func LoadIndicatorCatalog(path, expectedSHA256 string) (IndicatorCatalog, error) {
	invalid := func(message string, err error) (IndicatorCatalog, error) {
		return IndicatorCatalog{}, authzError(CodeArtifactIntegrityFailed, message, err)
	}
	if err := validateAbsoluteCleanPath(path); err != nil || !lowercaseSHA256Pattern.MatchString(expectedSHA256) {
		return invalid("approved indicator catalog parameters are invalid", err)
	}
	raw, _, err := readRegularFile(path, maxIndicatorCatalogBytes)
	if err != nil {
		return invalid("approved indicator catalog cannot be read safely", err)
	}
	if sha256Hex(raw) != expectedSHA256 {
		return invalid("approved indicator catalog digest does not match", nil)
	}
	var document indicatorCatalogFile
	if err := decodeStrictJSON(raw, &document); err != nil {
		return invalid("approved indicator catalog format is invalid", err)
	}
	if document.Version != CurrentVersion || document.GeneratedFrom != catalogGeneratedFrom || len(document.Indicators) == 0 {
		return invalid("approved indicator catalog version is invalid", nil)
	}

	catalog := IndicatorCatalog{
		Indicators: document.Indicators,
		ByID:       make(map[string]CatalogMatch),
		ByInternal: make(map[string]CatalogMatch),
		ByName:     make(map[string]CatalogMatch),
	}
	for code, indicator := range document.Indicators {
		if err := validateCatalogCode(code); err != nil {
			return invalid("approved indicator catalog contains an invalid indicator code", err)
		}
		dimensions := make(map[string]struct{}, len(indicator.SupportedDimensions))
		for _, dimension := range indicator.SupportedDimensions {
			if err := validateCatalogCode(dimension); err != nil {
				return invalid("approved indicator catalog contains an invalid dimension", err)
			}
			if _, duplicate := dimensions[dimension]; duplicate {
				return invalid("approved indicator catalog contains a duplicate dimension", nil)
			}
			dimensions[dimension] = struct{}{}
		}
		if _, ok := dimensions[protectedAreaCode]; !ok {
			return invalid("approved indicator catalog omits a protected dimension", nil)
		}
		if _, ok := dimensions[protectedCategoryCode]; !ok {
			return invalid("approved indicator catalog omits a protected dimension", nil)
		}

		for _, ref := range indicator.DictionaryRefs {
			if ref.QueryType != 1 && ref.QueryType != 2 {
				return invalid("approved indicator catalog contains an invalid query type", nil)
			}
			if err := validateCatalogCode(ref.ID); err != nil {
				return invalid("approved indicator catalog contains an invalid dictionary id", err)
			}
			if err := validateCatalogCode(ref.InternalCode); err != nil {
				return invalid("approved indicator catalog contains an invalid internal code", err)
			}
			match := CatalogMatch{Indicator: code, Ref: ref}
			if _, duplicate := catalog.ByID[ref.ID]; duplicate {
				return invalid("approved indicator catalog dictionary id is not unique", nil)
			}
			catalog.ByID[ref.ID] = match
			if _, duplicate := catalog.ByInternal[ref.InternalCode]; duplicate {
				return invalid("approved indicator catalog internal code is not unique", nil)
			}
			catalog.ByInternal[ref.InternalCode] = match
			if len(ref.Names) == 0 {
				return invalid("approved indicator catalog dictionary name is empty", nil)
			}
			localNames := make(map[string]struct{}, len(ref.Names))
			for _, name := range ref.Names {
				if name != strings.TrimSpace(name) || validateCatalogText(name, maxCatalogNameBytes, false) != nil {
					return invalid("approved indicator catalog contains an invalid dictionary name", nil)
				}
				if _, duplicate := localNames[name]; duplicate {
					return invalid("approved indicator catalog contains a duplicate dictionary name", nil)
				}
				localNames[name] = struct{}{}
				key := catalogNameKey(ref.QueryType, name)
				if _, duplicate := catalog.ByName[key]; duplicate {
					return invalid("approved indicator catalog dictionary name mapping is not unique", nil)
				}
				catalog.ByName[key] = match
			}
		}
	}
	return catalog, nil
}

func (catalog IndicatorCatalog) ApproveIndicator(code string) bool {
	_, ok := catalog.Indicators[code]
	return ok
}

func (catalog IndicatorCatalog) MatchID(id string, queryType int, requireQueryType bool) (CatalogMatch, bool) {
	match, ok := catalog.ByID[id]
	if !ok || requireQueryType && match.Ref.QueryType != queryType {
		return CatalogMatch{}, false
	}
	return match, true
}

func (catalog IndicatorCatalog) MatchInternal(code string) (CatalogMatch, bool) {
	match, ok := catalog.ByInternal[code]
	return match, ok
}

func (catalog IndicatorCatalog) MatchName(name string, queryType int) (CatalogMatch, bool) {
	match, ok := catalog.ByName[catalogNameKey(queryType, name)]
	return match, ok
}

func (catalog IndicatorCatalog) IDMatchesIndicator(id, indicator string, queryType int) bool {
	match, ok := catalog.MatchID(id, queryType, true)
	return ok && match.Indicator == indicator
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
