package harness

type Child struct {
	Path     string   `json:"path"`
	Keywords []string `json:"keywords,omitempty"`
}

type ContextInfo struct {
	DefaultFiles []string `json:"default_files,omitempty"`
}

type Document struct {
	ID       string      `json:"id"`
	Kind     string      `json:"kind"`
	Domain   string      `json:"domain"`
	Title    string      `json:"title"`
	Path     string      `json:"path"`
	Tags     []string    `json:"tags,omitempty"`
	Match    MatchInfo   `json:"match"`
	Context  ContextInfo `json:"context,omitempty"`
	Children []Child     `json:"children,omitempty"`
}

type MatchInfo struct {
	Keywords []string `json:"keywords,omitempty"`
}

type FileRef struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type ContextResponse struct {
	Question     string    `json:"question"`
	ContextFiles []FileRef `json:"contextFiles"`
	Instruction  string    `json:"instruction"`
	Constraints  []string  `json:"constraints"`
}

type IndexFile struct {
	GeneratedAt string              `json:"generatedAt"`
	Root        string              `json:"root"`
	Files       []Document          `json:"files"`
	ByDomain    map[string][]string `json:"byDomain"`
	ByKeyword   map[string][]string `json:"byKeyword"`
	ByID        map[string]string   `json:"byId"`
}
