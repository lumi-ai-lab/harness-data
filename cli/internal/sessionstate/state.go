package sessionstate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	ModeSingle = "single"
	ModeFree   = "free"
	ModeMulti  = "multi_single"
	ModeReport = "report"

	ModeTemplateReport = ModeReport
	ModeFreeAnalysis   = ModeFree
)

type PlaybookCandidate struct {
	Path     string `json:"path"`
	Template string `json:"template"`
	Domain   string `json:"domain,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

type File struct {
	SessionID          string              `json:"session_id"`
	Mode               string              `json:"mode,omitempty"`
	Prompt             string              `json:"prompt,omitempty"`
	StartedAt          string              `json:"started_at,omitempty"`
	SelectedPlaybook   string              `json:"selected_playbook,omitempty"`
	SelectedTemplate   string              `json:"selected_template,omitempty"`
	Reason             string              `json:"reason,omitempty"`
	SelectedPlaybooks  []PlaybookCandidate `json:"selected_playbooks,omitempty"`
	PlaybookCandidates []PlaybookCandidate `json:"playbook_candidates,omitempty"`
	Composite          *CompositeSelection `json:"composite,omitempty"`
	TemplateInjected   bool                `json:"template_injected"`
	Reports            map[string]*Report  `json:"reports"`
}

type CompositeSelection struct {
	Type    string   `json:"type"`
	Metrics []string `json:"metrics,omitempty"`
	Domain  string   `json:"domain,omitempty"`
}

type Report struct {
	RecordedModules  []string `json:"recorded_modules"`
	TemplateInjected bool     `json:"template_injected"`
}

func Load(root, sessionID string) (File, error) {
	path := Path(root, sessionID)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return File{SessionID: sessionID, Reports: map[string]*Report{}}, nil
		}
		return File{}, err
	}
	var state File
	if err := json.Unmarshal(data, &state); err != nil {
		return File{SessionID: sessionID, Reports: map[string]*Report{}}, nil
	}
	if state.SessionID == "" {
		state.SessionID = sessionID
	}
	if state.Reports == nil {
		state.Reports = map[string]*Report{}
	}
	return state, nil
}

func Save(root, sessionID string, state File) error {
	if state.SessionID == "" {
		state.SessionID = sessionID
	}
	dir := Dir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temp, err := os.CreateTemp(dir, ".tmp-*.json")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		_ = os.Remove(tempName)
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	return os.Rename(tempName, Path(root, sessionID))
}

func Dir(root string) string {
	return filepath.Join(root, ".harness", "state", "business-report")
}

func DiagnosticsDir(root string) string {
	return filepath.Join(root, ".harness", "state", "diagnostics")
}

func Path(root, sessionID string) string {
	return filepath.Join(Dir(root), SafeSessionID(sessionID)+".json")
}

const maxPlainSessionIDLength = 120

var unsafeSessionIDPattern = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

func SafeSessionID(sessionID string) string {
	if sessionID == "" {
		return "unknown"
	}
	if len(sessionID) <= maxPlainSessionIDLength &&
		!unsafeSessionIDPattern.MatchString(sessionID) &&
		!isWindowsReservedFilename(sessionID) {
		return sessionID
	}

	digest := sha256.Sum256([]byte(sessionID))
	// The '~' marker cannot occur in an unchanged plain session ID, so hashed
	// names cannot collide with a caller-provided safe ID that resembles a hash.
	return "sha256~" + hex.EncodeToString(digest[:])
}

func isWindowsReservedFilename(name string) bool {
	base := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CLOCK$":
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) {
		return base[3] >= '1' && base[3] <= '9'
	}
	return false
}
