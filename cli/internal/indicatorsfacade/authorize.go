package indicatorsfacade

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

func authorizeAndRebuild(o operation, authorization AuthorizationContext, catalog Catalog) (operation, error) {
	areas, err := validateAuthorizedScope(authorization.ManageAreaIDs, "区域")
	if err != nil {
		return operation{}, err
	}
	categories, err := validateAuthorizedScope(authorization.CategoryLevel1IDs, "品类")
	if err != nil {
		return operation{}, err
	}

	if o.Kind == kindAnalysis {
		for _, indicator := range o.Indicators {
			entry, approved := catalog.Indicators[indicator]
			if !approved {
				return operation{}, deny(CodeIndicatorNotApproved, "查询包含未批准指标", nil)
			}
			if !containsExact(entry.SupportedDimensions, protectedAreaCode) || !containsExact(entry.SupportedDimensions, protectedCategoryCode) {
				return operation{}, deny(CodeIndicatorScopeUnsupported, "指标不支持完整权限维度", nil)
			}
		}
		var requestedAreas, requestedCategories []string
		for _, filter := range o.Filters {
			switch filter.Code {
			case protectedAreaCode:
				requestedAreas = filter.IDs
			case protectedCategoryCode:
				requestedCategories = filter.IDs
			}
		}
		o.EffectiveAreas, err = effectiveScope(areas, requestedAreas)
		if err != nil {
			return operation{}, err
		}
		o.EffectiveCategories, err = effectiveScope(categories, requestedCategories)
		if err != nil {
			return operation{}, err
		}
		o.CanonicalArgv = canonicalAnalysisArgv(o)
		return o, nil
	}

	switch o.Kind {
	case kindWikis:
		if !catalog.ApproveIndicator(o.Code) {
			return operation{}, deny(CodeIndicatorNotApproved, "指标未被批准", nil)
		}
		o.ApprovedIndicator = o.Code
	case kindDimValues:
		if strings.EqualFold(o.Code, protectedAreaCode) && o.Code != protectedAreaCode ||
			strings.EqualFold(o.Code, protectedCategoryCode) && o.Code != protectedCategoryCode {
			return operation{}, syntax("保护维度 code 大小写必须完全匹配")
		}
	case kindDictionaryDetail:
		match, ok := catalog.MatchID(o.ID, o.QueryType, true)
		if !ok {
			return operation{}, deny(CodeIndicatorNotApproved, "dictionary id 未被批准或 queryType 不匹配", nil)
		}
		o.ApprovedIndicator = match.Indicator
	case kindDictionaryVersions:
		match, ok := catalog.MatchID(o.ID, 0, false)
		if !ok {
			return operation{}, deny(CodeIndicatorNotApproved, "dictionary id 未被批准", nil)
		}
		o.ApprovedIndicator = match.Indicator
	case kindDictionaryChange:
		match, ok := catalog.MatchInternal(o.Code)
		if !ok {
			return operation{}, deny(CodeIndicatorNotApproved, "dictionary internal code 未被批准", nil)
		}
		o.ApprovedIndicator = match.Indicator
	case kindDictionaryIDName:
		match, ok := catalog.MatchName(o.Name, o.QueryType)
		if !ok {
			return operation{}, deny(CodeIndicatorNotApproved, "dictionary name 未被批准或映射不唯一", nil)
		}
		o.ApprovedIndicator = match.Indicator
	}
	o.EffectiveAreas = append([]string(nil), areas...)
	o.EffectiveCategories = append([]string(nil), categories...)
	o.CanonicalArgv = canonicalMetadataArgv(o)
	return o, nil
}

func validateAuthorizedScope(values []string, dimension string) ([]string, error) {
	if len(values) == 0 {
		return nil, deny(CodeScopeEmpty, dimension+"授权范围为空", nil)
	}
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if safeScopeID(value) != nil || value == "*" {
			return nil, deny(CodeRequesterContextInvalid, dimension+"授权范围无效", nil)
		}
		if _, duplicate := seen[value]; duplicate {
			return nil, deny(CodeRequesterContextInvalid, dimension+"授权范围包含重复值", nil)
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func effectiveScope(authorized, requested []string) ([]string, error) {
	if len(requested) == 0 {
		result := append([]string(nil), authorized...)
		sort.Strings(result)
		return result, nil
	}
	authorizedSet := stringSet(authorized)
	for _, value := range requested {
		if _, ok := authorizedSet[value]; !ok {
			return nil, deny(CodeScopeOverreach, "请求范围超出当前用户权限", nil)
		}
	}
	result := append([]string(nil), requested...)
	sort.Strings(result)
	return result, nil
}

func canonicalAnalysisArgv(o operation) []string {
	argv := []string{"analysis", "execute", "--start-date", o.StartDate, "--end-date", o.EndDate}
	for _, value := range o.Indicators {
		argv = append(argv, "--indicator", value)
	}
	for _, value := range o.AggDims {
		argv = append(argv, "--agg-dim", value)
	}
	for _, value := range o.ColumnAggDims {
		argv = append(argv, "--column-agg-dim", value)
	}
	for _, filter := range o.Filters {
		if filter.Code == protectedAreaCode || filter.Code == protectedCategoryCode {
			continue
		}
		argv = append(argv, "--filter", filter.Code+"="+strings.Join(filter.IDs, ","))
	}
	argv = append(argv,
		"--filter", protectedAreaCode+"="+strings.Join(o.EffectiveAreas, ","),
		"--filter", protectedCategoryCode+"="+strings.Join(o.EffectiveCategories, ","),
	)
	for _, filter := range o.OtherFilters {
		argv = append(argv, "--other-filter", filter.Code+"="+strings.Join(filter.IDs, ","))
	}
	for _, filter := range o.MeasureFilters {
		argv = append(argv, "--measure-filter", filter.Indicator+":"+filter.Operator+":"+filter.Value)
	}
	argv = append(argv,
		"--indicators-group", strconv.Itoa(o.IndicatorsGroup),
		"--store-collect-type", strconv.Itoa(o.StoreCollectType),
		"--page-size", strconv.Itoa(o.PageSize),
		"--curr-page", strconv.Itoa(o.CurrentPage),
	)
	if o.OrderByField != "" {
		argv = append(argv, "--order-by", o.OrderByField+" "+o.OrderByDirection)
	}
	argv = append(argv, "--chart-type", "table", "--single-page")
	if o.AI {
		argv = append(argv, "--ai")
	}
	if o.YOY {
		argv = append(argv, "--yoy")
	}
	if o.MOM {
		argv = append(argv, "--mom")
	}
	return argv
}

func canonicalMetadataArgv(o operation) []string {
	var argv []string
	switch o.Kind {
	case kindIndicatorSearch:
		argv = []string{"indicator", "search"}
		argv = appendOptional(argv, "--keyword", o.Keyword)
	case kindDimSearch:
		argv = []string{"dim", "search"}
		argv = appendOptional(argv, "--keyword", o.Keyword)
	case kindDimValues:
		argv = []string{"dim", "values", "--code", o.Code}
		argv = appendOptional(argv, "--keyword", o.Keyword)
		argv = append(argv, "--limit", strconv.Itoa(o.Limit))
	case kindWikis:
		argv = []string{"wikis", "--code", o.Code}
	case kindDictionaryList:
		argv = []string{"dictionary", "list"}
		argv = appendOptional(argv, "--keyword", o.Keyword)
		argv = append(argv, "--page", strconv.Itoa(o.Page), "--limit", strconv.Itoa(o.Limit), "--query-type", strconv.Itoa(o.QueryType))
	case kindDictionaryDetail:
		argv = []string{"dictionary", "detail", "--id", o.ID, "--query-type", strconv.Itoa(o.QueryType)}
	case kindDictionaryVersions:
		argv = []string{"dictionary", "versions", "--id", o.ID}
	case kindDictionaryChange:
		argv = []string{"dictionary", "change-log", "--code", o.Code}
	case kindDictionaryIDName:
		argv = []string{"dictionary", "id-by-name", "--name", o.Name, "--query-type", strconv.Itoa(o.QueryType)}
	case kindDictionaryDict:
		argv = []string{"dictionary", "dict", "--type", strconv.Itoa(o.DictType)}
	case kindDictionaryStatuses:
		argv = []string{"dictionary", "statuses"}
	default:
		panic(fmt.Sprintf("unsupported metadata operation %q", o.Kind))
	}
	if o.AI {
		argv = append(argv, "--ai")
	}
	return argv
}

func appendOptional(argv []string, flag, value string) []string {
	if value == "" {
		return argv
	}
	return append(argv, flag, value)
}

func containsExact(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
