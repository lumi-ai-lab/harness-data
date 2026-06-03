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
}

type PathResolver struct {
	Root  string
	Paths PathsConfig
}

type PathsConfig struct {
	Spec      string
	Routing   string
	Playbooks string
	Templates string
}

type CLIConfig struct {
	QDMCmrCLI        string
	QDMIndicatorsCLI string
	QDMCasCLI        string
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
			return loadLegacyPathsConfig(root, cfg)
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
			case "paths", "cli":
				section = key
			default:
				return Config{}, fmt.Errorf("%s: unsupported section %q", ConfigRel, key)
			}
			continue
		}
		switch section {
		case "paths":
			switch key {
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
			case "qdm_cmr_cli":
				cfg.CLI.QDMCmrCLI = value
			case "qdm_indicators_cli":
				cfg.CLI.QDMIndicatorsCLI = value
			case "qdm_cas_cli":
				cfg.CLI.QDMCasCLI = value
			default:
				return Config{}, fmt.Errorf("%s: unsupported cli key %q", ConfigRel, key)
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
	return cfg, nil
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
	for _, prefix := range []string{"spec", "routing", "playbooks", "templates"} {
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
	return rel == "spec" ||
		rel == "routing" ||
		rel == "playbooks" ||
		rel == "templates" ||
		strings.HasPrefix(rel, "spec/") ||
		strings.HasPrefix(rel, "routing/") ||
		strings.HasPrefix(rel, "playbooks/") ||
		strings.HasPrefix(rel, "templates/")
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
	}
}

func pathsFromKnowledge(knowledge string) PathsConfig {
	knowledge = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(knowledge))))
	if knowledge == "" || knowledge == "." {
		return PathsConfig{Spec: "spec", Playbooks: "playbooks", Templates: "templates"}
	}
	return PathsConfig{
		Spec:      knowledge + "/spec",
		Playbooks: knowledge + "/playbooks",
		Templates: knowledge + "/templates",
	}
}

func validatePathsConfig(source string, cfg PathsConfig) error {
	for name, rel := range map[string]string{
		"spec":      cfg.Spec,
		"playbooks": cfg.Playbooks,
		"templates": cfg.Templates,
	} {
		if rel == "" {
			return fmt.Errorf("%s: paths.%s must not be empty", source, name)
		}
		if filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, "../") || strings.Contains(rel, "/../") {
			return fmt.Errorf("%s: paths.%s must be a repository-relative path", source, name)
		}
	}
	if cfg.Routing != "" && (filepath.IsAbs(cfg.Routing) || cfg.Routing == ".." || strings.HasPrefix(cfg.Routing, "../") || strings.Contains(cfg.Routing, "/../")) {
		return fmt.Errorf("%s: paths.routing must be a repository-relative path", source)
	}
	return nil
}

func splitLogicalRel(rel string) (string, string, bool) {
	for _, prefix := range []string{"spec", "routing", "playbooks", "templates"} {
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
	default:
		return ""
	}
}

func isConfiguredPhysicalRel(rel string, cfg PathsConfig) bool {
	for _, prefix := range []string{"spec", "routing", "playbooks", "templates"} {
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
