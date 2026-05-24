package index

import "harness-data/cli/internal/harness"

func FindByIDOrPath(indexes BuildResult, key string) (harness.Document, bool) {
	for _, group := range []harness.IndexFile{indexes.Spec, indexes.Routing, indexes.Playbook} {
		for _, doc := range group.Files {
			if doc.ID == key || doc.Path == key {
				return doc, true
			}
		}
	}
	return harness.Document{}, false
}
