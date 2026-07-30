package indicatorsfacade

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCatalogStrictValidationAndDigest(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "catalog.json")
	raw := []byte(`{
  "version": 1,
  "generatedFrom": "qdm-indicators-cli-v0.0.4-contract",
  "indicators": {
    "saleAmt": {
      "supportedDimensions": ["manageAreaId", "categoryLevel1Id"],
      "dictionaryRefs": [{"queryType": 2, "id": "dict-sale", "internalCode": "internal-sale", "names": ["销售额"]}]
    }
  }
}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	catalog, err := loadCatalog(path, hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	if !catalog.ApproveIndicator("saleAmt") {
		t.Fatal("saleAmt not approved")
	}
	if _, err := loadCatalog(path, strings.Repeat("0", 64)); CodeOf(err) != CodeArtifactIntegrityFailed {
		t.Fatalf("digest mismatch = %v", err)
	}

	duplicatePath := filepath.Join(directory, "duplicate.json")
	duplicate := []byte(`{"version":1,"version":1,"generatedFrom":"qdm-indicators-cli-v0.0.4-contract","indicators":{}}`)
	if err := os.WriteFile(duplicatePath, duplicate, 0o600); err != nil {
		t.Fatal(err)
	}
	duplicateDigest := sha256.Sum256(duplicate)
	_, err = loadCatalog(duplicatePath, hex.EncodeToString(duplicateDigest[:]))
	assertCode(t, err, CodeArtifactIntegrityFailed)
}

func TestProtectedDimensionMetadataProjectionJSON(t *testing.T) {
	o := operation{Kind: kindDimValues, Code: protectedAreaCode, EffectiveAreas: []string{"CN07"}}
	raw := []byte(`[
  {"dimFieldId":"CN07","dimFieldValue":"华东","secret":"keep-out"},
  {"dimFieldId":"CN99","dimFieldValue":"无权区域","secret":"leak"}
]`)
	output, err := projectMetadata(o, testCatalog(), raw, 10)
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(output, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["dimFieldId"] != "CN07" || rows[0]["secret"] != nil {
		t.Fatalf("unexpected projection: %s", output)
	}
}

func TestProtectedDimensionMetadataProjectionJSONL(t *testing.T) {
	o := operation{Kind: kindDimValues, Code: protectedCategoryCode, EffectiveCategories: []string{"12"}, AI: true}
	raw := []byte("{\"dimFieldId\":\"12\",\"dimFieldValue\":\"食品\",\"secret\":\"x\"}\n" +
		"{\"dimFieldId\":\"99\",\"dimFieldValue\":\"未授权\"}\n")
	output, err := projectMetadata(o, testCatalog(), raw, 10)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) != 1 || strings.Contains(lines[0], "secret") || strings.Contains(lines[0], "99") {
		t.Fatalf("unexpected JSONL projection: %q", output)
	}
}

func TestDimSearchDropsMixedUnauthorizedProtectedValues(t *testing.T) {
	o := operation{
		Kind: kindDimSearch, EffectiveAreas: []string{"CN07"}, EffectiveCategories: []string{"12"},
	}
	output, err := projectMetadata(o, testCatalog(), []byte(`[
  {"dimUniqueCode":"manageAreaId","dimName":"区域","dimFieldId":"CN07","dimFieldValue":"华东"},
  {"dimUniqueCode":"manageAreaId","dimName":"区域","dimFieldId":"CN99","dimFieldValue":"越权区域"},
  {"dimUniqueCode":"storeTypeId","dimName":"门店类型"}
]`), 10)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(output), "CN99") || strings.Contains(string(output), "dimField") || strings.Count(string(output), "manageAreaId") != 1 {
		t.Fatalf("mixed protected values were not safely filtered: %s", output)
	}
}

func TestIndicatorAndDictionaryProjectionUseApprovedCatalog(t *testing.T) {
	indicatorOutput, err := projectMetadata(operation{Kind: kindIndicatorSearch}, testCatalog(), []byte(`[
  {"indicatorsCodeEn":"saleAmt","indicatorsName":"销售额","ownerName":"Alice"},
  {"indicatorsCodeEn":"profitAmt","indicatorsName":"利润","ownerName":"Bob"}
]`), 10)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(indicatorOutput), "profitAmt") || strings.Contains(string(indicatorOutput), "ownerName") {
		t.Fatalf("indicator projection leaked data: %s", indicatorOutput)
	}

	detail := operation{Kind: kindDictionaryDetail, ID: "dict-sale", ApprovedIndicator: "saleAmt"}
	detailOutput, err := projectMetadata(detail, testCatalog(), []byte(`{
  "id":"dict-sale","indicatorsCodeEn":"saleAmt","indicatorsName":"销售额",
  "technicalOwnerName":"Alice","businessOwnerName":"Bob","statisticalLogic":"sum(x)"
}`), 10)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(detailOutput), "Owner") || !strings.Contains(string(detailOutput), "statisticalLogic") {
		t.Fatalf("dictionary projection is unsafe or incomplete: %s", detailOutput)
	}
}

func TestDictionaryListRejectsUnknownIDMapping(t *testing.T) {
	o := operation{Kind: kindDictionaryList, QueryType: 2}
	_, err := projectMetadata(o, testCatalog(), []byte(`{"total":1,"records":[{"id":"unknown","indicatorsCodeEn":"saleAmt"}]}`), 10)
	assertCode(t, err, CodeMetadataOutputInvalid)
}

func TestDictionaryIDByNameRejectsConflictingResolvedIDs(t *testing.T) {
	o := operation{Kind: kindDictionaryIDName, QueryType: 2, Name: "销售额", ApprovedIndicator: "saleAmt"}
	_, err := projectMetadata(o, testCatalog(), []byte(`{"id":"dict-sale","indicatorId":"different"}`), 10)
	assertCode(t, err, CodeMetadataOutputInvalid)

	output, err := projectMetadata(o, testCatalog(), []byte(`{"id":"dict-sale","indicatorId":"dict-sale"}`), 10)
	if err != nil {
		t.Fatal(err)
	}
	var projected map[string]any
	if err := json.Unmarshal(output, &projected); err != nil {
		t.Fatal(err)
	}
	if projected["id"] != "dict-sale" || projected["indicatorsCodeEn"] != "saleAmt" || len(projected) != 2 {
		t.Fatalf("unexpected projection: %s", output)
	}
}

func TestMetadataMalformedOrAmbiguousOutputFailsClosed(t *testing.T) {
	tests := [][]byte{
		[]byte(`[{"dimFieldValue":"missing id"}]`),
		[]byte(`[{"dimFieldId":"CN07","dimFieldId":"CN99"}]`),
		[]byte(`[{"dimFieldId":"CN07"}] trailing`),
		[]byte(`{"dimFieldId":"CN07"}`),
	}
	for _, raw := range tests {
		_, err := projectMetadata(operation{Kind: kindDimValues, Code: protectedAreaCode, EffectiveAreas: []string{"CN07"}}, testCatalog(), raw, 10)
		assertCode(t, err, CodeMetadataOutputInvalid)
	}
}

func TestMetadataRejectsExcessiveJSONNesting(t *testing.T) {
	raw := []byte(strings.Repeat("[", maxJSONNestingDepth+2) + "0" + strings.Repeat("]", maxJSONNestingDepth+2))
	_, err := projectMetadata(operation{Kind: kindDimValues, Code: protectedAreaCode, EffectiveAreas: []string{"CN07"}}, testCatalog(), raw, 10)
	assertCode(t, err, CodeMetadataOutputInvalid)
}

func TestMetadataRejectsNumericIdentifiersAndEmptyStableProjections(t *testing.T) {
	_, err := projectMetadata(
		operation{Kind: kindDimValues, Code: protectedCategoryCode, EffectiveCategories: []string{"12"}},
		testCatalog(), []byte(`[{"dimFieldId":12,"dimFieldValue":"食品"}]`), 10,
	)
	assertCode(t, err, CodeMetadataOutputInvalid)

	for _, kind := range []operationKind{kindDictionaryVersions, kindDictionaryChange, kindDictionaryDict, kindDictionaryStatuses} {
		_, err := projectMetadata(operation{Kind: kind}, testCatalog(), []byte(`[{}]`), 10)
		assertCode(t, err, CodeMetadataOutputInvalid)
	}
}
