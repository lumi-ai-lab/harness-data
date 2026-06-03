package wikis

type Kind string

const (
	KindSpec          Kind = "spec"
	KindSpecIndex     Kind = "spec_index"
	KindPlaybook      Kind = "playbook"
	KindPlaybookIndex Kind = "playbook_index"
	KindTemplate      Kind = "template"
	KindTemplateIndex Kind = "template_index"
)

type SpecType string

const (
	SpecTypeMetric  SpecType = "metric"
	SpecTypeConcept SpecType = "concept"
)

type Document struct {
	ID              string      `json:"id"`
	Path            string      `json:"path"`
	PhysicalRel     string      `json:"-"`
	Kind            Kind        `json:"kind"`
	Domain          string      `json:"domain"`
	Title           string      `json:"title"`
	Name            string      `json:"name,omitempty"`
	Label           string      `json:"label,omitempty"`
	Aliases         []string    `json:"aliases,omitempty"`
	NegativeAliases []string    `json:"negativeAliases,omitempty"`
	Covers          []string    `json:"covers,omitempty"`
	IsIndex         bool        `json:"isIndex"`
	HasFrontmatter  bool        `json:"-"`
	SpecType        SpecType    `json:"specType,omitempty"`
	Playbook        PlaybookRef `json:"playbook,omitempty"`
	Template        TemplateRef `json:"template,omitempty"`
}

type PlaybookRef struct {
	IsSingle     bool                      `json:"isSingle,omitempty"`
	IsCombo      bool                      `json:"isCombo,omitempty"`
	SpecPath     string                    `json:"specPath,omitempty"`
	TemplatePath string                    `json:"templatePath,omitempty"`
	Intents      map[string]PlaybookIntent `json:"intents,omitempty"`
}

type TemplateRef struct {
	PlaybookPath string `json:"playbookPath,omitempty"`
	IsReport     bool   `json:"isReport,omitempty"`
}

type PlaybookIntent struct {
	Aliases []string `json:"aliases,omitempty"`
}

type Frontmatter struct {
	Present bool
	Fields  map[string]any
}

type CheckError struct {
	Check   string `json:"check"`
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Target  string `json:"target,omitempty"`
	Value   string `json:"value,omitempty"`
	Other   string `json:"other,omitempty"`
}

type CheckResult struct {
	Check        string       `json:"check"`
	OK           bool         `json:"ok"`
	TotalErrors  int          `json:"totalErrors"`
	ShownErrors  int          `json:"shownErrors"`
	HiddenErrors int          `json:"hiddenErrors"`
	Truncated    bool         `json:"truncated"`
	Errors       []CheckError `json:"errors"`
}

type CheckOptions struct {
	MaxErrors int
	FailFast  bool
}

type Corpus struct {
	Root      string
	Docs      []Document
	ByPath    map[string]*Document
	SpecPaths map[string]bool
}

type Index struct {
	Meta   IndexMeta    `json:"meta"`
	Docs   []Document   `json:"docs"`
	Recall []RecallItem `json:"recall"`
}

type RuntimeIndex struct {
	Meta              IndexMeta                  `json:"meta"`
	DocsByPath        map[string]RuntimeDocument `json:"docsByPath"`
	Recall            []RuntimeRecallItem        `json:"recall"`
	TemplateSelection []TemplateSelectionRule    `json:"templateSelection,omitempty"`
}

type RuntimeDocument struct {
	Path     string       `json:"path"`
	Kind     Kind         `json:"kind"`
	Domain   string       `json:"domain,omitempty"`
	SpecType SpecType     `json:"specType,omitempty"`
	Playbook *PlaybookRef `json:"playbook,omitempty"`
	Covers   []string     `json:"covers,omitempty"`
}

type RuntimeRecallItem struct {
	Term       string `json:"term"`
	TargetPath string `json:"targetPath"`
}

type TemplateSelectionPolicy struct {
	Version   int                     `json:"version"`
	Templates []TemplateSelectionRule `json:"templates"`
}

type TemplateSelectionRule struct {
	ID       string   `json:"id"`
	Playbook string   `json:"playbook"`
	Template string   `json:"template"`
	Type     string   `json:"type"`
	Domain   string   `json:"domain,omitempty"`
	Covers   []string `json:"covers,omitempty"`
	Intents  []string `json:"intents,omitempty"`
	Priority int      `json:"priority,omitempty"`
}

type IndexMeta struct {
	Version       int               `json:"version"`
	GeneratedAt   string            `json:"generatedAt"`
	Root          string            `json:"root"`
	Paths         map[string]string `json:"paths"`
	ChecksSkipped bool              `json:"checksSkipped"`
}

type RecallItem struct {
	Term        string `json:"term"`
	TargetPath  string `json:"targetPath"`
	SourceField string `json:"sourceField"`
	Rule        string `json:"rule"`
}

type BuildIndexResult struct {
	Path               string `json:"path"`
	RuntimePath        string `json:"runtimePath"`
	ChecksSkipped      bool   `json:"checksSkipped"`
	DocCount           int    `json:"docCount"`
	RecallCount        int    `json:"recallCount"`
	RuntimeDocCount    int    `json:"runtimeDocCount"`
	RuntimeRecallCount int    `json:"runtimeRecallCount"`
}
