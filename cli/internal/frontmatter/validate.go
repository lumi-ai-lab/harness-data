package frontmatter

import (
	"fmt"
	"os"
	"strings"

	"harness-data/cli/internal/harness"
)

var validKinds = map[string]bool{
	"spec": true, "spec_index": true, "routing": true, "playbook": true, "playbook_index": true,
}

var validDomains = map[string]bool{
	"common": true, "business": true, "store": true, "store-manager": true, "member": true, "financial": true,
	"purchase": true, "store-area": true, "warehouse": true,
}

func ValidateDocuments(root string, docs []harness.Document) []string {
	var errs []string
	resolver, err := harness.NewPathResolver(root)
	if err != nil {
		return []string{err.Error()}
	}
	ids := map[string]string{}
	for _, doc := range docs {
		if doc.ID == "" {
			errs = append(errs, fmt.Sprintf("%s: missing id", doc.Path))
		} else if existing, ok := ids[doc.Kind+"\x00"+doc.ID]; ok {
			errs = append(errs, fmt.Sprintf("%s: duplicate id %q also used by %s", doc.Path, doc.ID, existing))
		} else {
			ids[doc.Kind+"\x00"+doc.ID] = doc.Path
		}
		if !validKinds[doc.Kind] {
			errs = append(errs, fmt.Sprintf("%s: invalid kind %q", doc.Path, doc.Kind))
		}
		if !validDomains[doc.Domain] {
			errs = append(errs, fmt.Sprintf("%s: invalid domain %q", doc.Path, doc.Domain))
		}
		for _, ref := range doc.Context.DefaultFiles {
			if !exists(resolver, ref) {
				errs = append(errs, fmt.Sprintf("%s: missing context.default_files reference %s", doc.Path, ref))
			}
		}
		for _, child := range doc.Children {
			if !exists(resolver, child.Path) {
				errs = append(errs, fmt.Sprintf("%s: missing children.path reference %s", doc.Path, child.Path))
			}
		}
		if doc.Kind == "playbook" && !hasTag(doc.Tags, "supplemental") && hasTag(doc.Tags, "template-report") && doc.Template == "" {
			errs = append(errs, fmt.Sprintf("%s: playbook missing template", doc.Path))
		}
		if doc.Kind == "playbook_index" && doc.Template != "" {
			errs = append(errs, fmt.Sprintf("%s: playbook_index must not declare template", doc.Path))
		}
		if doc.Template != "" {
			if !isTemplateLogicalPath(doc.Template) {
				errs = append(errs, fmt.Sprintf("%s: template must use templates/... or reports/.../template.md: %s", doc.Path, doc.Template))
			}
			if !exists(resolver, doc.Template) {
				errs = append(errs, fmt.Sprintf("%s: missing template reference %s", doc.Path, doc.Template))
			}
		}
	}
	return errs
}

func exists(resolver harness.PathResolver, rel string) bool {
	info, err := os.Stat(resolver.Resolve(rel))
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

func isTemplateLogicalPath(logical string) bool {
	return strings.HasPrefix(logical, "templates/") ||
		(strings.HasPrefix(logical, "reports/") && strings.HasSuffix(logical, "/template.md"))
}
