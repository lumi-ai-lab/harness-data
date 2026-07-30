package authz

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"unicode/utf8"
)

var jsonUnmarshalerType = reflect.TypeOf((*json.Unmarshaler)(nil)).Elem()

func decodeStrictJSON(data []byte, target any) error {
	if len(bytes.TrimSpace(data)) == 0 {
		return fmt.Errorf("JSON document is empty")
	}
	if !utf8.Valid(data) {
		return fmt.Errorf("JSON document is not valid UTF-8")
	}
	if err := rejectDuplicateJSONKeys(data); err != nil {
		return err
	}
	if err := rejectInexactJSONFields(data, target); err != nil {
		return err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode strict JSON: %w", err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return err
	}
	return nil
}

func rejectInexactJSONFields(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	targetType := reflect.TypeOf(target)
	if targetType == nil || targetType.Kind() != reflect.Pointer {
		return fmt.Errorf("strict JSON target must be a pointer")
	}
	return validateJSONFieldShape(value, targetType.Elem(), "$")
}

func validateJSONFieldShape(value any, targetType reflect.Type, path string) error {
	for targetType.Kind() == reflect.Pointer {
		targetType = targetType.Elem()
	}
	if reflect.PointerTo(targetType).Implements(jsonUnmarshalerType) || targetType.Implements(jsonUnmarshalerType) {
		return nil
	}
	if value == nil {
		return nil
	}
	switch targetType.Kind() {
	case reflect.Struct:
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		fields := make(map[string]reflect.Type)
		for index := 0; index < targetType.NumField(); index++ {
			field := targetType.Field(index)
			if !field.IsExported() {
				continue
			}
			name := strings.Split(field.Tag.Get("json"), ",")[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = field.Name
			}
			fields[name] = field.Type
		}
		for name, child := range object {
			fieldType, exists := fields[name]
			if !exists {
				return fmt.Errorf("unknown JSON field %q at %s", name, path)
			}
			if err := validateJSONFieldShape(child, fieldType, path+"."+name); err != nil {
				return err
			}
		}
	case reflect.Slice, reflect.Array:
		array, ok := value.([]any)
		if !ok {
			return nil
		}
		for index, child := range array {
			if err := validateJSONFieldShape(child, targetType.Elem(), fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
		}
	case reflect.Map:
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		for name, child := range object {
			if err := validateJSONFieldShape(child, targetType.Elem(), path+"."+name); err != nil {
				return err
			}
		}
	}
	return nil
}

func rejectDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := scanJSONValue(decoder, "$", 0); err != nil {
		return err
	}
	if err := requireJSONTokenEOF(decoder); err != nil {
		return err
	}
	return nil
}

const maxJSONNestingDepth = 64

func scanJSONValue(decoder *json.Decoder, path string, depth int) error {
	if depth > maxJSONNestingDepth {
		return fmt.Errorf("JSON nesting exceeds %d levels", maxJSONNestingDepth)
	}
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("decode JSON token at %s: %w", path, err)
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}

	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("decode JSON object key at %s: %w", path, err)
			}
			key, ok := keyToken.(string)
			if !ok {
				return fmt.Errorf("JSON object key at %s is not a string", path)
			}
			if _, exists := seen[key]; exists {
				return fmt.Errorf("duplicate JSON key %q at %s", key, path)
			}
			seen[key] = struct{}{}
			if err := scanJSONValue(decoder, path+"."+key, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("close JSON object at %s: %w", path, err)
		}
		if end != json.Delim('}') {
			return fmt.Errorf("invalid JSON object terminator at %s", path)
		}
	case '[':
		index := 0
		for decoder.More() {
			if err := scanJSONValue(decoder, fmt.Sprintf("%s[%d]", path, index), depth+1); err != nil {
				return err
			}
			index++
		}
		end, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("close JSON array at %s: %w", path, err)
		}
		if end != json.Delim(']') {
			return fmt.Errorf("invalid JSON array terminator at %s", path)
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q at %s", delim, path)
	}
	return nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return fmt.Errorf("JSON document contains a trailing value")
	}
	return fmt.Errorf("JSON document contains trailing data: %w", err)
}

func requireJSONTokenEOF(decoder *json.Decoder) error {
	_, err := decoder.Token()
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return fmt.Errorf("JSON document contains a trailing value")
	}
	return fmt.Errorf("JSON document contains trailing data: %w", err)
}
