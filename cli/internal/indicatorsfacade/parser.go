package indicatorsfacade

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxArgumentBytes = 4096
	maxCodeBytes     = 256
	maxKeywordBytes  = 512
)

type flagKind uint8

const (
	flagScalar flagKind = iota
	flagRepeatable
	flagBool
)

type parsedFlags map[string][]string

func parseOperation(args []string, limits Limits) (operation, error) {
	if err := limits.validate(); err != nil {
		return operation{}, err
	}
	if len(args) == 0 {
		return operation{}, syntax("缺少命令")
	}
	for _, arg := range args {
		if err := safeText(arg, maxArgumentBytes, false); err != nil {
			return operation{}, syntax("参数包含控制字符或超过长度限制")
		}
	}

	switch args[0] {
	case "analysis":
		if len(args) < 2 || args[1] != "execute" {
			return operation{}, syntax("只允许 analysis execute")
		}
		return parseAnalysis(args[2:], limits)
	case "indicator":
		if len(args) < 2 || args[1] != "search" {
			return operation{}, syntax("只允许 indicator search")
		}
		return parseSimpleSearch(kindIndicatorSearch, args[2:])
	case "dim":
		if len(args) < 2 {
			return operation{}, syntax("缺少 dim 子命令")
		}
		switch args[1] {
		case "search":
			return parseSimpleSearch(kindDimSearch, args[2:])
		case "values":
			return parseDimValues(args[2:], limits)
		default:
			return operation{}, syntax("dim 子命令尚未适配")
		}
	case "wikis":
		return parseWikis(args[1:])
	case "dictionary":
		return parseDictionary(args[1:], limits)
	default:
		return operation{}, syntax("命令尚未适配")
	}
}

func parseAnalysis(args []string, limits Limits) (operation, error) {
	spec := map[string]flagKind{
		"start-date": flagScalar, "end-date": flagScalar,
		"indicator": flagRepeatable, "agg-dim": flagRepeatable,
		"column-agg-dim": flagRepeatable, "filter": flagRepeatable,
		"other-filter": flagRepeatable, "measure-filter": flagRepeatable,
		"indicators-group": flagScalar, "store-collect-type": flagScalar,
		"page-size": flagScalar, "curr-page": flagScalar,
		"order-by": flagScalar, "chart-type": flagScalar,
		"single-page": flagBool, "ai": flagBool, "yoy": flagBool, "mom": flagBool,
	}
	flags, err := parseLongFlags(args, spec)
	if err != nil {
		return operation{}, err
	}
	o := operation{
		Kind: kindAnalysis, IndicatorsGroup: 1, StoreCollectType: 1,
		PageSize: limits.DefaultPageSize, CurrentPage: 1,
	}
	if o.StartDate, err = requiredScalar(flags, "start-date"); err != nil {
		return operation{}, err
	}
	if o.EndDate, err = requiredScalar(flags, "end-date"); err != nil {
		return operation{}, err
	}
	if err := validateDateRange(o.StartDate, o.EndDate, limits.MaxDateRangeDays); err != nil {
		return operation{}, err
	}
	o.Indicators = append([]string(nil), flags["indicator"]...)
	if len(o.Indicators) == 0 {
		return operation{}, syntax("至少需要一个 --indicator")
	}
	if len(o.Indicators) > limits.MaxIndicators {
		return operation{}, limit("指标数量超过部署上限")
	}
	if err := validateUniqueCodes(o.Indicators, "indicator"); err != nil {
		return operation{}, err
	}
	o.AggDims = append([]string(nil), flags["agg-dim"]...)
	o.ColumnAggDims = append([]string(nil), flags["column-agg-dim"]...)
	if len(o.AggDims)+len(o.ColumnAggDims) > limits.MaxDimensions {
		return operation{}, limit("聚合维度数量超过部署上限")
	}
	if err := validateUniqueCodes(o.AggDims, "agg-dim"); err != nil {
		return operation{}, err
	}
	if err := validateUniqueCodes(o.ColumnAggDims, "column-agg-dim"); err != nil {
		return operation{}, err
	}
	dimSeen := map[string]struct{}{}
	for _, code := range o.AggDims {
		dimSeen[code] = struct{}{}
	}
	for _, code := range o.ColumnAggDims {
		if _, exists := dimSeen[code]; exists {
			return operation{}, syntax("同一维度不能同时作为行、列聚合维度")
		}
	}

	filterCodes := map[string]struct{}{}
	for _, raw := range flags["filter"] {
		filter, err := parseFilter(raw, false)
		if err != nil {
			return operation{}, err
		}
		if _, exists := filterCodes[filter.Code]; exists {
			return operation{}, syntax("同一 filter code 不能重复")
		}
		filterCodes[filter.Code] = struct{}{}
		o.Filters = append(o.Filters, filter)
	}
	for _, raw := range flags["other-filter"] {
		filter, err := parseFilter(raw, true)
		if err != nil {
			return operation{}, err
		}
		if _, exists := filterCodes[filter.Code]; exists {
			return operation{}, syntax("同一 filter code 不能重复")
		}
		filterCodes[filter.Code] = struct{}{}
		o.OtherFilters = append(o.OtherFilters, filter)
	}

	measureSeen := map[string]struct{}{}
	indicatorSet := stringSet(o.Indicators)
	for _, raw := range flags["measure-filter"] {
		measure, err := parseMeasureFilter(raw, indicatorSet)
		if err != nil {
			return operation{}, err
		}
		key := measure.Indicator + "\x00" + measure.Operator + "\x00" + measure.Value
		if _, exists := measureSeen[key]; exists {
			return operation{}, syntax("measure-filter 不能完全重复")
		}
		measureSeen[key] = struct{}{}
		o.MeasureFilters = append(o.MeasureFilters, measure)
	}

	if value, ok := optionalScalar(flags, "indicators-group"); ok {
		o.IndicatorsGroup, err = enumInt(value, "indicators-group", 1, 2)
		if err != nil {
			return operation{}, err
		}
	}
	if value, ok := optionalScalar(flags, "store-collect-type"); ok {
		o.StoreCollectType, err = enumInt(value, "store-collect-type", 1, 2)
		if err != nil {
			return operation{}, err
		}
	}
	if value, ok := optionalScalar(flags, "page-size"); ok {
		o.PageSize, err = positiveInt(value, "page-size", limits.MaxPageSize)
		if err != nil {
			return operation{}, err
		}
	}
	if value, ok := optionalScalar(flags, "curr-page"); ok {
		o.CurrentPage, err = positiveInt(value, "curr-page", math.MaxInt32)
		if err != nil {
			return operation{}, err
		}
	}
	if value, ok := optionalScalar(flags, "chart-type"); ok && value != "table" {
		return operation{}, syntax("--chart-type 只允许 table")
	}
	if value, ok := optionalScalar(flags, "single-page"); ok && value != "true" {
		return operation{}, syntax("--single-page=false 在授权模式中不可用")
	}
	o.AI = boolValue(flags, "ai")
	o.YOY = boolValue(flags, "yoy")
	o.MOM = boolValue(flags, "mom")
	if value, ok := optionalScalar(flags, "order-by"); ok {
		parts := strings.Fields(value)
		if len(parts) != 2 || (strings.ToUpper(parts[1]) != "ASC" && strings.ToUpper(parts[1]) != "DESC") {
			return operation{}, syntax("--order-by 必须是一个输出字段加 ASC 或 DESC")
		}
		allowedOutputs := stringSet(append(append(append([]string{}, o.Indicators...), o.AggDims...), o.ColumnAggDims...))
		if _, ok := allowedOutputs[parts[0]]; !ok {
			return operation{}, syntax("--order-by 字段不属于本次输出")
		}
		o.OrderByField = parts[0]
		o.OrderByDirection = strings.ToUpper(parts[1])
	}
	return o, nil
}

func parseSimpleSearch(kind operationKind, args []string) (operation, error) {
	flags, err := parseLongFlags(args, map[string]flagKind{"keyword": flagScalar, "ai": flagBool})
	if err != nil {
		return operation{}, err
	}
	o := operation{Kind: kind, AI: boolValue(flags, "ai")}
	if value, ok := optionalScalar(flags, "keyword"); ok {
		if err := safeText(value, maxKeywordBytes, true); err != nil {
			return operation{}, syntax("--keyword 无效")
		}
		o.Keyword = value
	}
	return o, nil
}

func parseDimValues(args []string, limits Limits) (operation, error) {
	flags, err := parseLongFlags(args, map[string]flagKind{
		"code": flagScalar, "keyword": flagScalar, "limit": flagScalar, "ai": flagBool,
	})
	if err != nil {
		return operation{}, err
	}
	o := operation{Kind: kindDimValues, Limit: limits.DefaultMetadataLimit, AI: boolValue(flags, "ai")}
	if o.Code, err = requiredScalar(flags, "code"); err != nil {
		return operation{}, err
	}
	if err := safeCode(o.Code); err != nil {
		return operation{}, syntax("--code 无效")
	}
	if value, ok := optionalScalar(flags, "keyword"); ok {
		if err := safeText(value, maxKeywordBytes, true); err != nil {
			return operation{}, syntax("--keyword 无效")
		}
		o.Keyword = value
	}
	if value, ok := optionalScalar(flags, "limit"); ok {
		o.Limit, err = positiveInt(value, "limit", limits.MaxMetadataLimit)
		if err != nil {
			return operation{}, err
		}
	}
	return o, nil
}

func parseWikis(args []string) (operation, error) {
	flags, err := parseLongFlags(args, map[string]flagKind{"code": flagScalar})
	if err != nil {
		return operation{}, err
	}
	code, err := requiredScalar(flags, "code")
	if err != nil {
		return operation{}, err
	}
	if err := safeCode(code); err != nil {
		return operation{}, syntax("--code 无效")
	}
	return operation{Kind: kindWikis, Code: code}, nil
}

func parseDictionary(args []string, limits Limits) (operation, error) {
	if len(args) == 0 {
		return operation{}, syntax("缺少 dictionary 子命令")
	}
	kind := operationKind("")
	spec := map[string]flagKind{}
	switch args[0] {
	case "list":
		kind = kindDictionaryList
		spec = map[string]flagKind{"keyword": flagScalar, "page": flagScalar, "limit": flagScalar, "query-type": flagScalar, "ai": flagBool}
	case "detail":
		kind = kindDictionaryDetail
		spec = map[string]flagKind{"id": flagScalar, "query-type": flagScalar}
	case "versions":
		kind = kindDictionaryVersions
		spec = map[string]flagKind{"id": flagScalar, "ai": flagBool}
	case "change-log":
		kind = kindDictionaryChange
		spec = map[string]flagKind{"code": flagScalar, "ai": flagBool}
	case "id-by-name":
		kind = kindDictionaryIDName
		spec = map[string]flagKind{"name": flagScalar, "query-type": flagScalar}
	case "dict":
		kind = kindDictionaryDict
		spec = map[string]flagKind{"type": flagScalar, "ai": flagBool}
	case "statuses":
		kind = kindDictionaryStatuses
		spec = map[string]flagKind{"ai": flagBool}
	default:
		return operation{}, syntax("dictionary 子命令尚未适配")
	}
	flags, err := parseLongFlags(args[1:], spec)
	if err != nil {
		return operation{}, err
	}
	o := operation{Kind: kind, Page: 1, Limit: limits.DefaultMetadataLimit, QueryType: 2, AI: boolValue(flags, "ai")}
	if value, ok := optionalScalar(flags, "keyword"); ok {
		if err := safeText(value, maxKeywordBytes, true); err != nil {
			return operation{}, syntax("--keyword 无效")
		}
		o.Keyword = value
	}
	if value, ok := optionalScalar(flags, "page"); ok {
		o.Page, err = positiveInt(value, "page", limits.MaxMetadataLimit)
		if err != nil {
			return operation{}, err
		}
	}
	if value, ok := optionalScalar(flags, "limit"); ok {
		o.Limit, err = positiveInt(value, "limit", limits.MaxMetadataLimit)
		if err != nil {
			return operation{}, err
		}
	}
	if value, ok := optionalScalar(flags, "query-type"); ok {
		o.QueryType, err = enumInt(value, "query-type", 1, 2)
		if err != nil {
			return operation{}, err
		}
	}
	switch kind {
	case kindDictionaryDetail, kindDictionaryVersions:
		o.ID, err = requiredScalar(flags, "id")
		if err != nil {
			return operation{}, err
		}
		if err := safeCode(o.ID); err != nil {
			return operation{}, syntax("--id 无效")
		}
	case kindDictionaryChange:
		o.Code, err = requiredScalar(flags, "code")
		if err != nil {
			return operation{}, err
		}
		if err := safeCode(o.Code); err != nil {
			return operation{}, syntax("--code 无效")
		}
	case kindDictionaryIDName:
		o.Name, err = requiredScalar(flags, "name")
		if err != nil {
			return operation{}, err
		}
		if err := safeText(o.Name, maxKeywordBytes, false); err != nil {
			return operation{}, syntax("--name 无效")
		}
	case kindDictionaryDict:
		value, requiredErr := requiredScalar(flags, "type")
		if requiredErr != nil {
			return operation{}, requiredErr
		}
		o.DictType, err = enumInt(value, "type", 1, 2, 3, 4, 5, 6)
		if err != nil {
			return operation{}, err
		}
	}
	return o, nil
}

func parseLongFlags(args []string, spec map[string]flagKind) (parsedFlags, error) {
	result := parsedFlags{}
	for i := 0; i < len(args); i++ {
		token := args[i]
		if token == "--" || !strings.HasPrefix(token, "--") || token == "--" {
			return nil, syntax("不允许位置参数或短 flag")
		}
		body := strings.TrimPrefix(token, "--")
		name, value, hasEquals := strings.Cut(body, "=")
		kind, allowed := spec[name]
		if !allowed || name == "" {
			return nil, syntax("包含未适配的 flag")
		}
		if kind == flagBool {
			if !hasEquals {
				value = "true"
			} else if value != "true" && value != "false" {
				return nil, syntax("布尔 flag 只接受 true 或 false")
			}
		} else {
			if !hasEquals {
				if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
					return nil, syntax("flag 缺少值")
				}
				i++
				value = args[i]
			}
			if value == "" {
				return nil, syntax("flag 值不能为空")
			}
		}
		if kind != flagRepeatable && len(result[name]) != 0 {
			return nil, syntax("scalar flag 不能重复")
		}
		result[name] = append(result[name], value)
	}
	return result, nil
}

func requiredScalar(flags parsedFlags, name string) (string, error) {
	value, ok := optionalScalar(flags, name)
	if !ok || value == "" {
		return "", syntax("缺少必填 --" + name)
	}
	return value, nil
}

func optionalScalar(flags parsedFlags, name string) (string, bool) {
	values := flags[name]
	if len(values) == 0 {
		return "", false
	}
	return values[0], true
}

func boolValue(flags parsedFlags, name string) bool {
	value, ok := optionalScalar(flags, name)
	return ok && value == "true"
}

func parseFilter(raw string, other bool) (filterValue, error) {
	code, list, ok := strings.Cut(raw, "=")
	if !ok || code == "" || list == "" || strings.Contains(list, "=") {
		return filterValue{}, syntax("filter 必须是 code=id1,id2")
	}
	if err := safeCode(code); err != nil {
		return filterValue{}, syntax("filter code 无效")
	}
	if strings.EqualFold(code, protectedAreaCode) && code != protectedAreaCode ||
		strings.EqualFold(code, protectedCategoryCode) && code != protectedCategoryCode {
		return filterValue{}, syntax("保护维度 code 大小写必须完全匹配")
	}
	if other && (strings.EqualFold(code, protectedAreaCode) || strings.EqualFold(code, protectedCategoryCode)) {
		return filterValue{}, syntax("保护维度不能出现在 --other-filter")
	}
	ids := strings.Split(list, ",")
	seen := map[string]struct{}{}
	for index, id := range ids {
		id = strings.TrimSpace(id)
		if err := safeScopeID(id); err != nil || id == "*" {
			return filterValue{}, syntax("filter ID 无效")
		}
		if _, exists := seen[id]; exists {
			return filterValue{}, syntax("filter ID 不能重复")
		}
		seen[id] = struct{}{}
		ids[index] = id
	}
	return filterValue{Code: code, IDs: ids}, nil
}

func parseMeasureFilter(raw string, indicators map[string]struct{}) (measureFilter, error) {
	parts := strings.SplitN(raw, ":", 3)
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return measureFilter{}, syntax("measure-filter 必须是 indicator:operator:value")
	}
	if _, ok := indicators[parts[0]]; !ok {
		return measureFilter{}, syntax("measure-filter 指标不属于本次查询")
	}
	switch parts[1] {
	case "<", "<=", "=", ">", ">=":
	default:
		return measureFilter{}, syntax("measure-filter operator 未获允许")
	}
	number, err := strconv.ParseFloat(parts[2], 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return measureFilter{}, syntax("measure-filter value 必须是有限数值")
	}
	canonical := strconv.FormatFloat(number, 'g', -1, 64)
	return measureFilter{Indicator: parts[0], Operator: parts[1], Value: canonical}, nil
}

func validateDateRange(startText, endText string, maxDays int) error {
	start, err := time.Parse("2006-01-02", startText)
	if err != nil || start.Format("2006-01-02") != startText {
		return syntax("--start-date 必须是 YYYY-MM-DD")
	}
	end, err := time.Parse("2006-01-02", endText)
	if err != nil || end.Format("2006-01-02") != endText {
		return syntax("--end-date 必须是 YYYY-MM-DD")
	}
	if end.Before(start) {
		return syntax("--end-date 不能早于 --start-date")
	}
	days := int(end.Sub(start).Hours()/24) + 1
	if days > maxDays {
		return limit("查询日期跨度超过部署上限")
	}
	return nil
}

func validateUniqueCodes(values []string, name string) error {
	seen := map[string]struct{}{}
	for _, value := range values {
		if err := safeCode(value); err != nil {
			return syntax("--" + name + " 值无效")
		}
		if _, exists := seen[value]; exists {
			return syntax("--" + name + " 值不能重复")
		}
		seen[value] = struct{}{}
	}
	return nil
}

func safeCode(value string) error {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsAny(value, ",=:") {
		return fmt.Errorf("invalid code")
	}
	return safeText(value, maxCodeBytes, false)
}

func safeScopeID(value string) error {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsRune(value, ',') {
		return fmt.Errorf("invalid scope id")
	}
	return safeText(value, maxCodeBytes, false)
}

func safeText(value string, maxBytes int, allowEmpty bool) error {
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

func enumInt(value, name string, allowed ...int) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || strconv.Itoa(parsed) != value {
		return 0, syntax("--" + name + " 值无效")
	}
	for _, candidate := range allowed {
		if parsed == candidate {
			return parsed, nil
		}
	}
	return 0, syntax("--" + name + " 值未获允许")
}

func positiveInt(value, name string, maximum int) (int, error) {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 || parsed > maximum || strconv.Itoa(parsed) != value {
		return 0, limit("--" + name + " 超出部署限额")
	}
	return parsed, nil
}

func stringSet(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}

func syntax(message string) error { return deny(CodeCLISyntaxDenied, message, nil) }
func limit(message string) error  { return deny(CodeExecutionLimitExceeded, message, nil) }
