package indicatorsfacade

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func testLimits() Limits {
	return Limits{
		MaxDateRangeDays: 31, MaxIndicators: 10, MaxDimensions: 10,
		DefaultPageSize: 200, MaxPageSize: 1000,
		DefaultMetadataLimit: 100, MaxMetadataLimit: 500,
		Timeout: 2 * time.Second, MaxOutputBytes: 2 << 20, PollInterval: 10 * time.Millisecond,
	}
}

func testCatalog() Catalog {
	entry := catalogIndicator{
		SupportedDimensions: []string{protectedAreaCode, protectedCategoryCode, "incDate"},
		DictionaryRefs:      []dictionaryRef{{QueryType: 2, ID: "dict-sale", InternalCode: "internal-sale", Names: []string{"销售额"}}},
	}
	match := catalogMatch{Indicator: "saleAmt", Ref: entry.DictionaryRefs[0]}
	return Catalog{
		Indicators: map[string]catalogIndicator{"saleAmt": entry},
		ByID:       map[string]catalogMatch{"dict-sale": match},
		ByInternal: map[string]catalogMatch{"internal-sale": match},
		ByName:     map[string]catalogMatch{"2\x00销售额": match},
	}
}

func testAuthorization() AuthorizationContext {
	return AuthorizationContext{
		ManageAreaIDs: []string{"CN08", "CN07"}, CategoryLevel1IDs: []string{"13", "12"},
	}
}

func TestAnalysisCanonicalAuthorization(t *testing.T) {
	o, err := parseOperation([]string{
		"analysis", "execute",
		"--start-date=2026-07-01", "--end-date", "2026-07-02",
		"--indicator", "saleAmt", "--agg-dim", "incDate",
		"--filter", "manageAreaId=CN07", "--filter", "storeId=S2,S1",
		"--other-filter", "storeTypeId=2", "--measure-filter", "saleAmt:>=:100.00",
		"--page-size", "20", "--curr-page=2", "--order-by", "saleAmt desc",
		"--single-page=true", "--ai", "--yoy=false", "--mom",
	}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	approved, err := authorizeAndRebuild(o, testAuthorization(), testCatalog())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-02",
		"--indicator", "saleAmt", "--agg-dim", "incDate",
		"--filter", "storeId=S2,S1",
		"--filter", "manageAreaId=CN07", "--filter", "categoryLevel1Id=12,13",
		"--other-filter", "storeTypeId=2", "--measure-filter", "saleAmt:>=:100",
		"--indicators-group", "1", "--store-collect-type", "1",
		"--page-size", "20", "--curr-page", "2", "--order-by", "saleAmt DESC",
		"--chart-type", "table", "--single-page", "--ai", "--mom",
	}
	if !reflect.DeepEqual(approved.CanonicalArgv, want) {
		t.Fatalf("canonical argv\n got: %#v\nwant: %#v", approved.CanonicalArgv, want)
	}
}

func TestAnalysisOmittedProtectedScopesInjectAllSorted(t *testing.T) {
	o, err := parseOperation([]string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt",
	}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	approved, err := authorizeAndRebuild(o, testAuthorization(), testCatalog())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(approved.EffectiveAreas, []string{"CN07", "CN08"}) || !reflect.DeepEqual(approved.EffectiveCategories, []string{"12", "13"}) {
		t.Fatalf("unexpected effective scopes: %#v %#v", approved.EffectiveAreas, approved.EffectiveCategories)
	}
}

func TestAnalysisRejectsOverreachWithoutClipping(t *testing.T) {
	o, err := parseOperation([]string{
		"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt",
		"--filter", "manageAreaId=CN07,CN99",
	}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	_, err = authorizeAndRebuild(o, testAuthorization(), testCatalog())
	assertCode(t, err, CodeScopeOverreach)
}

func TestProtectedScopeMatchingIsExactAndAllOverreachIsDenied(t *testing.T) {
	for name, requested := range map[string]string{
		"case mismatch": "cn07",
		"all overreach": "CN99",
	} {
		t.Run(name, func(t *testing.T) {
			o, err := parseOperation([]string{
				"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01",
				"--indicator", "saleAmt", "--filter", "manageAreaId=" + requested,
			}, testLimits())
			if err != nil {
				t.Fatal(err)
			}
			_, err = authorizeAndRebuild(o, testAuthorization(), testCatalog())
			assertCode(t, err, CodeScopeOverreach)
		})
	}
}

func TestEveryIndicatorMustBeApprovedAndSupportBothProtectedDimensions(t *testing.T) {
	approved := catalogIndicator{SupportedDimensions: []string{protectedAreaCode, protectedCategoryCode}}
	unsupported := catalogIndicator{SupportedDimensions: []string{protectedAreaCode}}
	catalog := Catalog{Indicators: map[string]catalogIndicator{
		"saleAmt": approved,
		"profit":  unsupported,
	}}
	for name, test := range map[string]struct {
		indicator string
		expected  ErrorCode
	}{
		"unapproved second indicator":  {indicator: "unknown", expected: CodeIndicatorNotApproved},
		"unsupported second indicator": {indicator: "profit", expected: CodeIndicatorScopeUnsupported},
	} {
		t.Run(name, func(t *testing.T) {
			o, err := parseOperation([]string{
				"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01",
				"--indicator", "saleAmt", "--indicator", test.indicator,
			}, testLimits())
			if err != nil {
				t.Fatal(err)
			}
			_, err = authorizeAndRebuild(o, testAuthorization(), catalog)
			assertCode(t, err, test.expected)
		})
	}
}

func TestParserDeniesAmbiguousAndUnsupportedSyntax(t *testing.T) {
	base := []string{"analysis", "execute", "--start-date", "2026-07-01", "--end-date", "2026-07-01", "--indicator", "saleAmt"}
	tests := map[string][]string{
		"payload":                    appendCopy(base, "--payload", "x.json"),
		"payload json":               appendCopy(base, "--payload-json", "{}"),
		"business threshold":         appendCopy(base, "--biz-thresh"),
		"duplicate scalar":           appendCopy(base, "--page-size", "1", "--page-size", "2"),
		"duplicate indicator":        appendCopy(base, "--indicator", "saleAmt"),
		"protected other":            appendCopy(base, "--other-filter", "manageAreaId=CN07"),
		"protected lookalike":        appendCopy(base, "--filter", "MANAGEAREAID=CN07"),
		"false single page":          appendCopy(base, "--single-page=false"),
		"unknown order field":        appendCopy(base, "--order-by", "profitAmt DESC"),
		"unknown measure indicator":  appendCopy(base, "--measure-filter", "profitAmt:>=:1"),
		"duplicate protected filter": appendCopy(base, "--filter", "manageAreaId=CN07", "--filter", "manageAreaId=CN08"),
		"duplicate ids":              appendCopy(base, "--filter", "manageAreaId=CN07,CN07"),
		"empty id":                   appendCopy(base, "--filter", "manageAreaId=CN07,"),
		"wildcard":                   appendCopy(base, "--filter", "manageAreaId=*"),
		"preview":                    {"analysis", "preview", "--payload", "x"},
		"report":                     {"report", "list"},
		"config":                     {"config", "set-token", "secret"},
		"metadata full":              {"indicator", "search", "--full"},
		"dictionary removed":         {"dictionary", "list", "--status", "1"},
	}
	for name, args := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := parseOperation(args, testLimits())
			assertCode(t, err, CodeCLISyntaxDenied)
		})
	}
}

func TestMetadataCatalogMappingsArePrevalidated(t *testing.T) {
	tests := []struct {
		args []string
		want operationKind
	}{
		{[]string{"wikis", "--code", "saleAmt"}, kindWikis},
		{[]string{"dictionary", "detail", "--id", "dict-sale", "--query-type", "2"}, kindDictionaryDetail},
		{[]string{"dictionary", "versions", "--id", "dict-sale", "--ai"}, kindDictionaryVersions},
		{[]string{"dictionary", "change-log", "--code", "internal-sale"}, kindDictionaryChange},
		{[]string{"dictionary", "id-by-name", "--name", "销售额"}, kindDictionaryIDName},
	}
	for _, test := range tests {
		o, err := parseOperation(test.args, testLimits())
		if err != nil {
			t.Fatal(err)
		}
		approved, err := authorizeAndRebuild(o, testAuthorization(), testCatalog())
		if err != nil {
			t.Fatal(err)
		}
		if approved.Kind != test.want || approved.ApprovedIndicator != "saleAmt" {
			t.Fatalf("unexpected approval: %#v", approved)
		}
	}
	o, err := parseOperation([]string{"dictionary", "detail", "--id", "dict-sale", "--query-type", "1"}, testLimits())
	if err != nil {
		t.Fatal(err)
	}
	_, err = authorizeAndRebuild(o, testAuthorization(), testCatalog())
	assertCode(t, err, CodeIndicatorNotApproved)
}

func TestV004AllowlistedMetadataGrammarAndCanonicalArguments(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{"indicator search", []string{"indicator", "search", "--keyword=销售", "--ai=true"}, []string{"indicator", "search", "--keyword", "销售", "--ai"}},
		{"dim search", []string{"dim", "search", "--keyword", "区域", "--ai"}, []string{"dim", "search", "--keyword", "区域", "--ai"}},
		{"dim values", []string{"dim", "values", "--code=manageAreaId", "--keyword", "华东", "--limit", "7", "--ai"}, []string{"dim", "values", "--code", "manageAreaId", "--keyword", "华东", "--limit", "7", "--ai"}},
		{"wikis", []string{"wikis", "--code=saleAmt"}, []string{"wikis", "--code", "saleAmt"}},
		{"dictionary list", []string{"dictionary", "list", "--keyword", "销售", "--page=2", "--limit", "5", "--query-type", "2", "--ai"}, []string{"dictionary", "list", "--keyword", "销售", "--page", "2", "--limit", "5", "--query-type", "2", "--ai"}},
		{"dictionary detail", []string{"dictionary", "detail", "--id=dict-sale", "--query-type", "2"}, []string{"dictionary", "detail", "--id", "dict-sale", "--query-type", "2"}},
		{"dictionary versions", []string{"dictionary", "versions", "--id", "dict-sale", "--ai"}, []string{"dictionary", "versions", "--id", "dict-sale", "--ai"}},
		{"dictionary change log", []string{"dictionary", "change-log", "--code", "internal-sale", "--ai=true"}, []string{"dictionary", "change-log", "--code", "internal-sale", "--ai"}},
		{"dictionary id by name", []string{"dictionary", "id-by-name", "--name", "销售额", "--query-type=2"}, []string{"dictionary", "id-by-name", "--name", "销售额", "--query-type", "2"}},
		{"dictionary dict", []string{"dictionary", "dict", "--type=6", "--ai"}, []string{"dictionary", "dict", "--type", "6", "--ai"}},
		{"dictionary statuses", []string{"dictionary", "statuses", "--ai=false"}, []string{"dictionary", "statuses"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			o, err := parseOperation(test.args, testLimits())
			if err != nil {
				t.Fatal(err)
			}
			approved, err := authorizeAndRebuild(o, testAuthorization(), testCatalog())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(approved.CanonicalArgv, test.want) {
				t.Fatalf("canonical argv\n got: %#v\nwant: %#v", approved.CanonicalArgv, test.want)
			}
		})
	}
}

func TestV004MetadataFullAndRemovedListFiltersAreAlwaysDenied(t *testing.T) {
	metadata := [][]string{
		{"indicator", "search"},
		{"dim", "search"},
		{"dim", "values", "--code", "manageAreaId"},
		{"wikis", "--code", "saleAmt"},
		{"dictionary", "list"},
		{"dictionary", "detail", "--id", "dict-sale"},
		{"dictionary", "versions", "--id", "dict-sale"},
		{"dictionary", "change-log", "--code", "internal-sale"},
		{"dictionary", "id-by-name", "--name", "销售额"},
		{"dictionary", "dict", "--type", "1"},
		{"dictionary", "statuses"},
	}
	for _, base := range metadata {
		args := appendCopy(base, "--full")
		if _, err := parseOperation(args, testLimits()); CodeOf(err) != CodeCLISyntaxDenied {
			t.Fatalf("%v with --full error = %v", base, err)
		}
	}
	for _, flag := range []string{"--status", "--level", "--biz-id", "--report-id", "--menu-id", "--sort"} {
		_, err := parseOperation([]string{"dictionary", "list", flag, "x"}, testLimits())
		assertCode(t, err, CodeCLISyntaxDenied)
	}
}

func appendCopy(base []string, values ...string) []string {
	result := append([]string(nil), base...)
	return append(result, values...)
}

func assertCode(t *testing.T, err error, expected ErrorCode) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got nil", expected)
	}
	var facadeErr *Error
	if !errors.As(err, &facadeErr) || facadeErr.Code != expected {
		t.Fatalf("error = %v, code = %s, want %s", err, CodeOf(err), expected)
	}
}
