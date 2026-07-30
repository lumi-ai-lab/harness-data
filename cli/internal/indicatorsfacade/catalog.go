package indicatorsfacade

import "harness-data/cli/internal/authz"

type catalogIndicator = authz.CatalogIndicator
type dictionaryRef = authz.CatalogDictionaryRef
type catalogMatch = authz.CatalogMatch
type Catalog = authz.IndicatorCatalog

func loadCatalog(path, expectedSHA256 string) (Catalog, error) {
	catalog, err := authz.LoadIndicatorCatalog(path, expectedSHA256)
	if err != nil {
		return Catalog{}, deny(CodeArtifactIntegrityFailed, "指标目录无效", err)
	}
	return catalog, nil
}
