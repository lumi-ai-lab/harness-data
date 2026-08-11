package harness

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	ConfigRel      = "config/harness-config.yaml"
	PathsConfigRel = "config/harness-paths.yaml"
)

type Config struct {
	Paths PathsConfig
	CLI   CLIConfig
	Authz AuthzConfig
}

// AuthzConfig controls optional data-auth injection for qdm-metric-cli.
// mode defaults to off. When on, PI hooks force --data-auth --auth-blob.
type AuthzConfig struct {
	// Mode is "off" or "on". Empty means off.
	Mode string
	// BlobFile is a repo-relative or absolute path to an encrypted qdm1enc blob (dev/test only).
	BlobFile string
	// DevUserID is the principal for local blob/env resolution.
	// Required when using authz.blob_file; can also be set via HARNESS_AUTH_USER_ID.
	DevUserID string
	// AllowLocalBlob permits env/file blob sources. Default true for this MVP.
	AllowLocalBlob *bool
}

type PathResolver struct {
	Root  string
	Paths PathsConfig
}

type PathsConfig struct {
	Knowledge string
	Spec      string
	Routing   string
	Playbooks string
	Templates string
}

type CLIConfig struct {
	QDMMetricCLI string
}

func FindRoot(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if isRoot(dir) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", os.ErrNotExist
		}
		dir = parent
	}
}

func isRoot(dir string) bool {
	if exists(filepath.Join(dir, ConfigRel)) || exists(filepath.Join(dir, PathsConfigRel)) || exists(filepath.Join(dir, ".harness")) {
		return true
	}
	if exists(filepath.Join(dir, "cli", "cmd", "data-harness-cli", "main.go")) {
		return true
	}
	if exists(filepath.Join(dir, "metrics")) && exists(filepath.Join(dir, "reports")) && exists(filepath.Join(dir, "dims")) && exists(filepath.Join(dir, "rules")) {
		return true
	}
	for _, name := range []string{"spec", "routing", "playbooks"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil || !info.IsDir() {
			return false
		}
	}
	return true
}

func LoadPathsConfig(root string) (PathsConfig, error) {
	cfg, err := LoadConfig(root)
	return cfg.Paths, err
}

func LoadConfig(root string) (Config, error) {
	cfg := defaultConfig()
	path := filepath.Join(root, ConfigRel)
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return loadLegacyPathsConfig(root, defaultConfigForRoot(root))
		}
		return Config{}, err
	}
	defer file.Close()

	section := ""
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		raw := scanner.Text()
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		indent := len(raw) - len(strings.TrimLeft(raw, " "))
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return Config{}, fmt.Errorf("%s: unsupported line %q", ConfigRel, line)
		}
		key = strings.TrimSpace(key)
		value = cleanPathValue(value)
		if indent == 0 {
			if value != "" {
				return Config{}, fmt.Errorf("%s: unsupported top-level value %q", ConfigRel, line)
			}
			switch key {
			case "paths", "cli", "authz":
				section = key
			default:
				return Config{}, fmt.Errorf("%s: unsupported section %q", ConfigRel, key)
			}
			continue
		}
		switch section {
		case "paths":
			switch key {
			case "knowledge":
				cfg.Paths = pathsFromKnowledge(value)
			case "spec":
				cfg.Paths.Spec = value
			case "routing":
				cfg.Paths.Routing = value
			case "playbooks":
				cfg.Paths.Playbooks = value
			case "templates":
				cfg.Paths.Templates = value
			default:
				return Config{}, fmt.Errorf("%s: unsupported paths key %q", ConfigRel, key)
			}
		case "cli":
			switch key {
			case "qdm_metric_cli":
				cfg.CLI.QDMMetricCLI = value
			case "qdm_sql_cli", "qdm_cas_cli", "qdm_cmr_cli", "qdm_indicators_cli":
				// Removed legacy CLIs; ignore leftover keys so old workspaces still load.
			default:
				return Config{}, fmt.Errorf("%s: unsupported cli key %q", ConfigRel, key)
			}
		case "authz":
			switch key {
			case "mode":
				cfg.Authz.Mode = strings.ToLower(value)
			case "blob_file":
				cfg.Authz.BlobFile = value
			case "dev_user_id":
				cfg.Authz.DevUserID = value
			case "allow_local_blob":
				parsed, err := parseBoolConfig(value)
				if err != nil {
					return Config{}, fmt.Errorf("%s: authz.allow_local_blob: %w", ConfigRel, err)
				}
				cfg.Authz.AllowLocalBlob = &parsed
			default:
				return Config{}, fmt.Errorf("%s: unsupported authz key %q", ConfigRel, key)
			}
		default:
			return Config{}, fmt.Errorf("%s: key %q must be under a section", ConfigRel, key)
		}
	}
	if err := scanner.Err(); err != nil {
		return Config{}, err
	}
	if err := validatePathsConfig(ConfigRel, cfg.Paths); err != nil {
		return Config{}, err
	}
	normalizeAuthzConfig(&cfg.Authz)
	return cfg, nil
}

func normalizeAuthzConfig(cfg *AuthzConfig) {
	if cfg == nil {
		return
	}
	if strings.TrimSpace(cfg.Mode) == "" {
		cfg.Mode = "off"
	} else {
		cfg.Mode = strings.ToLower(strings.TrimSpace(cfg.Mode))
	}
	// DevUserID stays empty unless explicitly configured — no default principal.
	cfg.DevUserID = strings.TrimSpace(cfg.DevUserID)
}

func loadLegacyPathsConfig(root string, cfg Config) (Config, error) {
	path := filepath.Join(root, PathsConfigRel)
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return Config{}, err
	}
	defer file.Close()

	knowledge := "."
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(key) != "knowledge" {
			return Config{}, fmt.Errorf("%s: unsupported line %q", PathsConfigRel, line)
		}
		knowledge = cleanPathValue(value)
	}
	if err := scanner.Err(); err != nil {
		return Config{}, err
	}
	if knowledge == "" {
		return Config{}, fmt.Errorf("%s: knowledge must not be empty", PathsConfigRel)
	}
	cfg.Paths = pathsFromKnowledge(knowledge)
	if err := validatePathsConfig(PathsConfigRel, cfg.Paths); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func NewPathResolver(root string) (PathResolver, error) {
	cfg, err := LoadPathsConfig(root)
	if err != nil {
		return PathResolver{}, err
	}
	return PathResolver{Root: root, Paths: cfg}, nil
}

func NewPathResolverWithPaths(root string, cfg PathsConfig) (PathResolver, error) {
	if err := validatePathsConfig("runtime index", cfg); err != nil {
		return PathResolver{}, err
	}
	return PathResolver{Root: root, Paths: cfg}, nil
}

func (r PathResolver) Resolve(rel string) string {
	return filepath.Join(r.Root, filepath.FromSlash(r.ResolveRel(rel)))
}

func (r PathResolver) ResolveRel(rel string) string {
	rel = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(rel))))
	if rel == "." || rel == "" {
		return "."
	}
	if rel == "index.md" && r.Paths.Knowledge != "" {
		knowledge := cleanRelPath(r.Paths.Knowledge)
		if knowledge != "." && knowledge != "" {
			return knowledge + "/index.md"
		}
	}
	if isConfiguredPhysicalRel(rel, r.Paths) {
		return rel
	}
	prefix, rest, ok := splitLogicalRel(rel)
	if !ok {
		return rel
	}
	base := pathForPrefix(r.Paths, prefix)
	if base == "." || base == "" {
		return rel
	}
	if rest == "" {
		return base
	}
	return base + "/" + rest
}

func (r PathResolver) KnowledgePath(name string) string {
	return r.Resolve(name)
}

func (r PathResolver) LogicalRel(rel string) string {
	rel = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(rel))))
	if r.Paths.Knowledge != "" && rel == pathJoinClean(r.Paths.Knowledge, "index.md") {
		return "index.md"
	}
	for _, prefix := range logicalPrefixes() {
		base := pathForPrefix(r.Paths, prefix)
		if base == "." || base == "" {
			continue
		}
		if rel == base {
			return prefix
		}
		if strings.HasPrefix(rel, base+"/") {
			return prefix + "/" + strings.TrimPrefix(rel, base+"/")
		}
	}
	return rel
}

func IsKnowledgeLogicalRel(rel string) bool {
	return isKnowledgeLogicalRel(rel)
}

func isKnowledgeLogicalRel(rel string) bool {
	if rel == "index.md" {
		return true
	}
	for _, prefix := range logicalPrefixes() {
		if rel == prefix || strings.HasPrefix(rel, prefix+"/") {
			return true
		}
	}
	return false
}

func cleanPathValue(value string) string {
	value = strings.TrimSpace(value)
	if idx := strings.Index(value, "#"); idx >= 0 {
		value = strings.TrimSpace(value[:idx])
	}
	return strings.Trim(value, `"'`)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func defaultConfig() Config {
	return Config{
		Paths: pathsFromKnowledge("."),
		Authz: AuthzConfig{
			Mode: "off",
		},
	}
}

func parseBoolConfig(value string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "yes", "1", "on":
		return true, nil
	case "false", "no", "0", "off":
		return false, nil
	default:
		return false, fmt.Errorf("must be true or false, got %q", value)
	}
}

// AuthzEnabled reports whether data-auth injection is active.
func (c AuthzConfig) AuthzEnabled() bool {
	return strings.EqualFold(strings.TrimSpace(c.Mode), "on")
}

// LocalBlobAllowed reports whether env/file fallback is allowed.
// Default true when unset (dev-friendly); explicit false disables.
func (c AuthzConfig) LocalBlobAllowed() bool {
	if c.AllowLocalBlob == nil {
		return true
	}
	return *c.AllowLocalBlob
}

func defaultConfigForRoot(root string) Config {
	cfg := defaultConfig()
	if exists(filepath.Join(root, "wikis", "spec")) ||
		exists(filepath.Join(root, "wikis", "playbooks")) ||
		exists(filepath.Join(root, "wikis", "metrics")) ||
		exists(filepath.Join(root, "wikis", "reports")) {
		cfg.Paths = pathsFromKnowledge("wikis")
	}
	return cfg
}

func pathsFromKnowledge(knowledge string) PathsConfig {
	knowledge = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(knowledge))))
	if knowledge == "" || knowledge == "." {
		return PathsConfig{Knowledge: ".", Spec: "spec", Playbooks: "playbooks", Templates: "templates"}
	}
	return PathsConfig{
		Knowledge: knowledge,
		Spec:      knowledge + "/spec",
		Playbooks: knowledge + "/playbooks",
		Templates: knowledge + "/templates",
	}
}

func validatePathsConfig(source string, cfg PathsConfig) error {
	if cfg.Knowledge != "" && invalidRelPath(cfg.Knowledge) {
		return fmt.Errorf("%s: paths.knowledge must be a repository-relative path", source)
	}
	for name, rel := range map[string]string{
		"spec":      cfg.Spec,
		"playbooks": cfg.Playbooks,
		"templates": cfg.Templates,
	} {
		if rel == "" {
			return fmt.Errorf("%s: paths.%s must not be empty", source, name)
		}
		if invalidRelPath(rel) {
			return fmt.Errorf("%s: paths.%s must be a repository-relative path", source, name)
		}
	}
	if cfg.Routing != "" && invalidRelPath(cfg.Routing) {
		return fmt.Errorf("%s: paths.routing must be a repository-relative path", source)
	}
	return nil
}

func splitLogicalRel(rel string) (string, string, bool) {
	for _, prefix := range logicalPrefixes() {
		if rel == prefix {
			return prefix, "", true
		}
		if strings.HasPrefix(rel, prefix+"/") {
			return prefix, strings.TrimPrefix(rel, prefix+"/"), true
		}
	}
	return "", "", false
}

func pathForPrefix(cfg PathsConfig, prefix string) string {
	switch prefix {
	case "spec":
		return cleanRelPath(cfg.Spec)
	case "routing":
		return cleanRelPath(cfg.Routing)
	case "playbooks":
		return cleanRelPath(cfg.Playbooks)
	case "templates":
		return cleanRelPath(cfg.Templates)
	case "metrics", "reports", "dims", "rules":
		if strings.TrimSpace(cfg.Knowledge) == "" {
			return ""
		}
		return pathJoinClean(cfg.Knowledge, prefix)
	default:
		return ""
	}
}

func isConfiguredPhysicalRel(rel string, cfg PathsConfig) bool {
	for _, prefix := range logicalPrefixes() {
		base := pathForPrefix(cfg, prefix)
		if base != "." && base != "" && (rel == base || strings.HasPrefix(rel, base+"/")) {
			return true
		}
	}
	return false
}

func cleanRelPath(rel string) string {
	return filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(rel))))
}

func invalidRelPath(rel string) bool {
	rel = cleanRelPath(rel)
	return filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, "../") || strings.Contains(rel, "/../")
}

func logicalPrefixes() []string {
	return []string{"spec", "routing", "playbooks", "templates", "metrics", "reports", "dims", "rules"}
}

func pathJoinClean(base, elem string) string {
	base = cleanRelPath(base)
	if base == "" || base == "." {
		return cleanRelPath(elem)
	}
	return cleanRelPath(base + "/" + elem)
}
