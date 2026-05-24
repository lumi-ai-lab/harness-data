package frontmatter

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"harness-data/cli/internal/harness"
)

var validKinds = map[string]bool{
	"spec": true, "spec_index": true, "routing": true, "playbook": true, "playbook_index": true,
}

var validDomains = map[string]bool{
	"common": true, "business": true, "store": true, "member": true, "financial": true,
}

func ValidateDocuments(root string, docs []harness.Document) []string {
	var errs []string
	ids := map[string]string{}
	for _, doc := range docs {
		if doc.ID == "" {
			errs = append(errs, fmt.Sprintf("%s: missing id", doc.Path))
		} else if existing, ok := ids[doc.ID]; ok {
			errs = append(errs, fmt.Sprintf("%s: duplicate id %q also used by %s", doc.Path, doc.ID, existing))
		} else {
			ids[doc.ID] = doc.Path
		}
		if !validKinds[doc.Kind] {
			errs = append(errs, fmt.Sprintf("%s: invalid kind %q", doc.Path, doc.Kind))
		}
		if !validDomains[doc.Domain] {
			errs = append(errs, fmt.Sprintf("%s: invalid domain %q", doc.Path, doc.Domain))
		}
		for _, ref := range doc.Context.DefaultFiles {
			if !exists(root, ref) {
				errs = append(errs, fmt.Sprintf("%s: missing context.default_files reference %s", doc.Path, ref))
			}
		}
		for _, child := range doc.Children {
			if !exists(root, child.Path) {
				errs = append(errs, fmt.Sprintf("%s: missing children.path reference %s", doc.Path, child.Path))
			}
		}
		if doc.Kind == "playbook" && !hasTag(doc.Tags, "supplemental") && doc.Template == "" {
			errs = append(errs, fmt.Sprintf("%s: playbook missing template", doc.Path))
		}
		if doc.Kind == "playbook_index" && doc.Template != "" {
			errs = append(errs, fmt.Sprintf("%s: playbook_index must not declare template", doc.Path))
		}
		if doc.Template != "" {
			if !strings.HasPrefix(doc.Template, "templates/") {
				errs = append(errs, fmt.Sprintf("%s: template must be under templates/: %s", doc.Path, doc.Template))
			}
			if !exists(root, doc.Template) {
				errs = append(errs, fmt.Sprintf("%s: missing template reference %s", doc.Path, doc.Template))
			}
		}
	}
	return errs
}

func exists(root, rel string) bool {
	info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
	return err == nil && !info.IsDir()
}

func hasTag(tags []string, want string) bool {
	for _, tag := range tags {
		if tag == want {
			return true
		}
	}
	return false
}
