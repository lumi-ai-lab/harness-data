package frontmatter

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"harness-data/cli/internal/harness"
)

func ParseFile(root, rel string) (harness.Document, error) {
	path := filepath.Join(root, filepath.FromSlash(rel))
	file, err := os.Open(path)
	if err != nil {
		return harness.Document{}, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	if !scanner.Scan() || strings.TrimSpace(scanner.Text()) != "---" {
		return harness.Document{}, fmt.Errorf("%s: missing frontmatter", rel)
	}
	lines := []string{}
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "---" {
			doc := parseLines(lines)
			doc.Path = rel
			return doc, nil
		}
		lines = append(lines, line)
	}
	if err := scanner.Err(); err != nil {
		return harness.Document{}, err
	}
	return harness.Document{}, fmt.Errorf("%s: unterminated frontmatter", rel)
}

func parseLines(lines []string) harness.Document {
	var doc harness.Document
	var section string
	var child *harness.Child

	for _, raw := range lines {
		line := strings.TrimRight(raw, " \t")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if indent == 0 {
			child = nil
			if key, value, ok := splitKV(trimmed); ok {
				switch key {
				case "id":
					doc.ID = clean(value)
				case "kind":
					doc.Kind = clean(value)
				case "domain":
					doc.Domain = clean(value)
				case "title":
					doc.Title = clean(value)
				case "tags", "match", "context", "children":
					section = key
					if key == "tags" && strings.HasPrefix(strings.TrimSpace(value), "[") {
						doc.Tags = inlineArray(value)
					}
				default:
					section = key
				}
			}
			continue
		}

		if section == "tags" && strings.HasPrefix(trimmed, "- ") {
			doc.Tags = append(doc.Tags, clean(strings.TrimPrefix(trimmed, "- ")))
			continue
		}
		if section == "match" {
			if strings.HasPrefix(trimmed, "- ") {
				doc.Match.Keywords = append(doc.Match.Keywords, clean(strings.TrimPrefix(trimmed, "- ")))
			}
			continue
		}
		if section == "context" {
			if strings.HasPrefix(trimmed, "- ") {
				doc.Context.DefaultFiles = append(doc.Context.DefaultFiles, clean(strings.TrimPrefix(trimmed, "- ")))
			}
			continue
		}
		if section == "children" {
			if strings.HasPrefix(trimmed, "- ") {
				item := strings.TrimPrefix(trimmed, "- ")
				if key, value, ok := splitKV(item); ok && key == "path" {
					doc.Children = append(doc.Children, harness.Child{Path: clean(value)})
					child = &doc.Children[len(doc.Children)-1]
				} else if child != nil {
					child.Keywords = append(child.Keywords, clean(item))
				}
				continue
			}
		}
	}
	return doc
}

func splitKV(s string) (string, string, bool) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]), true
}

func clean(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"'`)
	return s
}

func inlineArray(s string) []string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(strings.TrimSuffix(s, "]"), "[")
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, clean(part))
	}
	return out
}
