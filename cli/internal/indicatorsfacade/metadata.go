package indicatorsfacade

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

var (
	indicatorSearchKeys   = []string{"indicatorsCodeEn", "indicatorsName", "id", "indicatorsTypeName"}
	dimensionKeys         = []string{"dimUniqueCode", "dimName", "dimGroupId", "dimGroupName", "dimGroupCode", "parentDim"}
	dimensionValueKeys    = []string{"dimFieldId", "dimFieldValue"}
	dictionaryListKeys    = []string{"id", "indicatorsName", "shortName", "indicatorsCodeEn", "businessDefinition", "status", "statusName", "level", "levelName", "indicatorsBizName", "indicatorsTypeName", "pubStatus", "pubStatusName"}
	dictionaryDetailKeys  = []string{"id", "indicatorsName", "shortName", "indicatorsCode", "indicatorsCodeEn", "businessDefinition", "statisticalLogic", "status", "statusName", "level", "levelName", "indicatorsType", "indicatorsTypeName", "remarks"}
	dictionaryVersionKeys = []string{"id", "versionNum", "publishTime", "publishReason", "pubStatusName"}
	dictionaryChangeKeys  = []string{"id", "createdAt", "editDescription", "downReasonDesc"}
	dictionaryDictKeys    = []string{"id", "name", "type"}
	dictionaryStatusKeys  = []string{"value", "label", "id", "name"}
)

func projectMetadata(o operation, catalog Catalog, raw []byte, maxRows int) ([]byte, error) {
	if o.AI {
		return projectJSONL(o, catalog, raw, maxRows)
	}
	value, err := decodeAnyJSON(raw)
	if err != nil {
		return nil, metadataInvalid(err)
	}
	projected, err := projectJSONValue(o, catalog, value, maxRows)
	if err != nil {
		return nil, err
	}
	encoded, err := json.MarshalIndent(projected, "", "  ")
	if err != nil {
		return nil, metadataInvalid(err)
	}
	return append(encoded, '\n'), nil
}

func projectJSONL(o operation, catalog Catalog, raw []byte, maxRows int) ([]byte, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return []byte{}, nil
	}
	lines := bytes.Split(trimmed, []byte{'\n'})
	if len(lines) > maxRows {
		return nil, metadataInvalid(fmt.Errorf("metadata row limit exceeded"))
	}
	result := bytes.Buffer{}
	for _, line := range lines {
		if len(bytes.TrimSpace(line)) == 0 {
			return nil, metadataInvalid(fmt.Errorf("empty jsonl line"))
		}
		value, err := decodeAnyJSON(line)
		if err != nil {
			return nil, metadataInvalid(err)
		}
		row, ok := value.(map[string]any)
		if !ok {
			return nil, metadataInvalid(fmt.Errorf("jsonl row is not an object"))
		}
		projected, keep, err := projectRowForOperation(o, catalog, row)
		if err != nil {
			return nil, err
		}
		if !keep {
			continue
		}
		encoded, err := json.Marshal(projected)
		if err != nil {
			return nil, metadataInvalid(err)
		}
		result.Write(encoded)
		result.WriteByte('\n')
	}
	return result.Bytes(), nil
}

func projectJSONValue(o operation, catalog Catalog, value any, maxRows int) (any, error) {
	switch o.Kind {
	case kindIndicatorSearch, kindDimSearch, kindDimValues, kindDictionaryVersions, kindDictionaryChange, kindDictionaryDict, kindDictionaryStatuses:
		rows, ok := value.([]any)
		if !ok || len(rows) > maxRows {
			return nil, metadataInvalid(fmt.Errorf("metadata response must be a bounded array"))
		}
		result := make([]any, 0, len(rows))
		for _, item := range rows {
			row, ok := item.(map[string]any)
			if !ok {
				return nil, metadataInvalid(fmt.Errorf("metadata row is not an object"))
			}
			projected, keep, err := projectRowForOperation(o, catalog, row)
			if err != nil {
				return nil, err
			}
			if keep {
				result = append(result, projected)
			}
		}
		return result, nil
	case kindDictionaryList:
		object, ok := value.(map[string]any)
		if !ok {
			return nil, metadataInvalid(fmt.Errorf("dictionary list response is not an object"))
		}
		rows, ok := object["records"].([]any)
		if !ok || len(rows) > maxRows {
			return nil, metadataInvalid(fmt.Errorf("dictionary records missing or over limit"))
		}
		projectedRows := make([]any, 0, len(rows))
		for _, item := range rows {
			row, ok := item.(map[string]any)
			if !ok {
				return nil, metadataInvalid(fmt.Errorf("dictionary record is not an object"))
			}
			projected, keep, err := projectRowForOperation(o, catalog, row)
			if err != nil {
				return nil, err
			}
			if keep {
				projectedRows = append(projectedRows, projected)
			}
		}
		return map[string]any{"total": len(projectedRows), "records": projectedRows}, nil
	case kindDictionaryDetail:
		row, ok := value.(map[string]any)
		if !ok {
			return nil, metadataInvalid(fmt.Errorf("dictionary detail is not an object"))
		}
		projected, keep, err := projectRowForOperation(o, catalog, row)
		if err != nil {
			return nil, err
		}
		if !keep {
			return nil, metadataInvalid(fmt.Errorf("dictionary detail does not match approved indicator"))
		}
		return projected, nil
	case kindDictionaryIDName:
		id, ok := extractResolvedID(value)
		if !ok || id != o.ID && !catalogIDMatchesApproved(catalog, id, o.ApprovedIndicator, o.QueryType) {
			return nil, metadataInvalid(fmt.Errorf("resolved dictionary id does not match catalog"))
		}
		return map[string]any{"id": id, "indicatorsCodeEn": o.ApprovedIndicator}, nil
	case kindWikis:
		return projectWiki(o, value)
	default:
		return nil, metadataInvalid(fmt.Errorf("unsupported metadata operation"))
	}
}

func projectRowForOperation(o operation, catalog Catalog, row map[string]any) (map[string]any, bool, error) {
	switch o.Kind {
	case kindIndicatorSearch:
		code, ok := requiredText(row, "indicatorsCodeEn")
		if !ok {
			return nil, false, metadataInvalid(fmt.Errorf("indicator code missing"))
		}
		if !catalog.ApproveIndicator(code) {
			return nil, false, nil
		}
		projected, err := projectScalarMap(row, indicatorSearchKeys)
		return projected, true, wrapMetadata(err)
	case kindDimSearch:
		code, ok := requiredText(row, "dimUniqueCode")
		if !ok {
			return nil, false, metadataInvalid(fmt.Errorf("dimension code missing"))
		}
		idValue, hasID := row["dimFieldId"]
		_, hasValue := row["dimFieldValue"]
		if hasValue && !hasID {
			return nil, false, metadataInvalid(fmt.Errorf("dimension value record is missing its id"))
		}
		if hasID {
			id, valid := scalarText(idValue)
			if !valid || id == "" || id != strings.TrimSpace(id) {
				return nil, false, metadataInvalid(fmt.Errorf("dimension value id is unsafe"))
			}
			if code == protectedAreaCode && !containsExact(o.EffectiveAreas, id) ||
				code == protectedCategoryCode && !containsExact(o.EffectiveCategories, id) {
				return nil, false, nil
			}
		}
		projected, err := projectScalarMap(row, dimensionKeys)
		return projected, true, wrapMetadata(err)
	case kindDimValues:
		id, ok := requiredText(row, "dimFieldId")
		if !ok || id != strings.TrimSpace(id) {
			return nil, false, metadataInvalid(fmt.Errorf("dimension value id missing or unsafe"))
		}
		if o.Code == protectedAreaCode && !containsExact(o.EffectiveAreas, id) ||
			o.Code == protectedCategoryCode && !containsExact(o.EffectiveCategories, id) {
			return nil, false, nil
		}
		projected, err := projectScalarMap(row, dimensionValueKeys)
		return projected, true, wrapMetadata(err)
	case kindDictionaryList:
		code, ok := requiredText(row, "indicatorsCodeEn")
		if !ok {
			return nil, false, metadataInvalid(fmt.Errorf("dictionary indicator code missing"))
		}
		if !catalog.ApproveIndicator(code) {
			return nil, false, nil
		}
		id, ok := requiredText(row, "id")
		if !ok || !catalog.IDMatchesIndicator(id, code, o.QueryType) {
			return nil, false, metadataInvalid(fmt.Errorf("dictionary id mapping is not approved"))
		}
		projected, err := projectScalarMap(row, dictionaryListKeys)
		return projected, true, wrapMetadata(err)
	case kindDictionaryDetail:
		code, ok := requiredText(row, "indicatorsCodeEn")
		if !ok || code != o.ApprovedIndicator {
			return nil, false, nil
		}
		id, ok := requiredText(row, "id")
		if !ok || id != o.ID {
			return nil, false, metadataInvalid(fmt.Errorf("dictionary detail id mismatch"))
		}
		if internal, exists := row["indicatorsCode"]; exists {
			internalText, ok := scalarText(internal)
			match, approved := catalog.MatchInternal(internalText)
			if !ok || !approved || match.Indicator != o.ApprovedIndicator || match.Ref.ID != o.ID {
				return nil, false, metadataInvalid(fmt.Errorf("dictionary internal code mapping mismatch"))
			}
		}
		projected, err := projectScalarMap(row, dictionaryDetailKeys)
		return projected, true, wrapMetadata(err)
	case kindDictionaryVersions:
		if _, ok := requiredText(row, "id"); !ok {
			return nil, false, metadataInvalid(fmt.Errorf("dictionary version id missing"))
		}
		projected, err := projectScalarMap(row, dictionaryVersionKeys)
		return projected, true, wrapMetadata(err)
	case kindDictionaryChange:
		if _, ok := requiredText(row, "id"); !ok {
			return nil, false, metadataInvalid(fmt.Errorf("dictionary change id missing"))
		}
		projected, err := projectScalarMap(row, dictionaryChangeKeys)
		return projected, true, wrapMetadata(err)
	case kindDictionaryDict:
		if _, ok := requiredText(row, "id"); !ok {
			return nil, false, metadataInvalid(fmt.Errorf("dictionary entry id missing"))
		}
		if _, ok := requiredText(row, "name"); !ok {
			return nil, false, metadataInvalid(fmt.Errorf("dictionary entry name missing"))
		}
		projected, err := projectScalarMap(row, dictionaryDictKeys)
		return projected, true, wrapMetadata(err)
	case kindDictionaryStatuses:
		if _, idOK := requiredText(row, "id"); !idOK {
			if _, valueOK := requiredText(row, "value"); !valueOK {
				return nil, false, metadataInvalid(fmt.Errorf("dictionary status id missing"))
			}
		}
		if _, nameOK := requiredText(row, "name"); !nameOK {
			if _, labelOK := requiredText(row, "label"); !labelOK {
				return nil, false, metadataInvalid(fmt.Errorf("dictionary status label missing"))
			}
		}
		projected, err := projectScalarMap(row, dictionaryStatusKeys)
		return projected, true, wrapMetadata(err)
	default:
		return nil, false, metadataInvalid(fmt.Errorf("unexpected jsonl operation"))
	}
}

func projectWiki(o operation, value any) (any, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, metadataInvalid(fmt.Errorf("wiki response is not an object"))
	}
	indicator, ok := object["indicator"].(map[string]any)
	if !ok {
		return nil, metadataInvalid(fmt.Errorf("wiki indicator missing"))
	}
	code, ok := requiredText(indicator, "indicatorsCodeEn")
	if !ok || code != o.ApprovedIndicator {
		return nil, metadataInvalid(fmt.Errorf("wiki indicator mismatch"))
	}
	projectedIndicator, err := projectScalarMap(indicator, []string{"id", "indicatorsName", "indicatorsCodeEn", "shortName", "businessDefinition", "statisticalLogic", "level", "levelName", "status", "statusName", "pubStatus", "pubStatusName", "indicatorsBizName", "indicatorsTypeName"})
	if err != nil {
		return nil, metadataInvalid(err)
	}
	result := map[string]any{"indicator": projectedIndicator}
	if visual, exists := object["visualization"]; exists {
		visualMap, ok := visual.(map[string]any)
		if !ok {
			return nil, metadataInvalid(fmt.Errorf("wiki visualization is not an object"))
		}
		projected := map[string]any{}
		for _, key := range []string{"bizId", "bizName", "id", "indicatorsName", "indicatorsCodeEn", "supportDimCount", "supportDailyAverage", "supportSummary"} {
			if value, exists := visualMap[key]; exists {
				if !isScalar(value) {
					return nil, metadataInvalid(fmt.Errorf("wiki visualization field is not scalar"))
				}
				projected[key] = value
			}
		}
		if support, exists := visualMap["supportDim"]; exists {
			values, ok := support.([]any)
			if !ok {
				return nil, metadataInvalid(fmt.Errorf("wiki supportDim is not an array"))
			}
			clean := make([]string, 0, len(values))
			for _, value := range values {
				text, ok := scalarText(value)
				if !ok || safeCode(text) != nil {
					return nil, metadataInvalid(fmt.Errorf("wiki supportDim contains invalid value"))
				}
				clean = append(clean, text)
			}
			projected["supportDim"] = clean
		}
		result["visualization"] = projected
	}
	if dimensions, exists := object["supportedDimensions"]; exists {
		rows, ok := dimensions.([]any)
		if !ok || len(rows) > 1024 {
			return nil, metadataInvalid(fmt.Errorf("wiki supportedDimensions invalid"))
		}
		projectedRows := make([]any, 0, len(rows))
		for _, item := range rows {
			row, ok := item.(map[string]any)
			if !ok {
				return nil, metadataInvalid(fmt.Errorf("wiki dimension is not an object"))
			}
			if _, ok := requiredText(row, "dimUniqueCode"); !ok {
				return nil, metadataInvalid(fmt.Errorf("wiki dimension code missing"))
			}
			projected, err := projectScalarMap(row, dimensionKeys)
			if err != nil {
				return nil, metadataInvalid(err)
			}
			projectedRows = append(projectedRows, projected)
		}
		result["supportedDimensions"] = projectedRows
	}
	return result, nil
}

func projectScalarMap(row map[string]any, keys []string) (map[string]any, error) {
	projected := map[string]any{}
	for _, key := range keys {
		value, exists := row[key]
		if !exists {
			continue
		}
		if !isScalar(value) {
			return nil, fmt.Errorf("field %s is not scalar", key)
		}
		projected[key] = value
	}
	return projected, nil
}

func isScalar(value any) bool {
	switch value.(type) {
	case nil, string, bool, json.Number:
		return true
	default:
		return false
	}
}

func requiredText(row map[string]any, key string) (string, bool) {
	value, exists := row[key]
	if !exists {
		return "", false
	}
	text, ok := value.(string)
	return text, ok && text != ""
}

func scalarText(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

func extractResolvedID(value any) (string, bool) {
	if text, ok := scalarText(value); ok {
		return text, text != ""
	}
	object, ok := value.(map[string]any)
	if !ok {
		return "", false
	}
	id, hasID := requiredText(object, "id")
	indicatorID, hasIndicatorID := requiredText(object, "indicatorId")
	if hasID && hasIndicatorID {
		if id != indicatorID {
			return "", false
		}
		return id, true
	}
	if hasID {
		return id, true
	}
	if hasIndicatorID {
		return indicatorID, true
	}
	return "", false
}

func catalogIDMatchesApproved(catalog Catalog, id, indicator string, queryType int) bool {
	match, ok := catalog.MatchID(id, queryType, true)
	return ok && match.Indicator == indicator
}

func metadataInvalid(cause error) error {
	return deny(CodeMetadataOutputInvalid, "元数据返回格式无效", cause)
}

func wrapMetadata(err error) error {
	if err == nil {
		return nil
	}
	return metadataInvalid(err)
}
