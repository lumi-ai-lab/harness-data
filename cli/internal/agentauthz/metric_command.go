package agentauthz

import (
	"fmt"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

type ShellDialect string

const (
	ShellBash       ShellDialect = "bash"
	ShellPowerShell ShellDialect = "powershell"
	ShellCMD        ShellDialect = "cmd"
)

// Windows PowerShell may invoke a quoted absolute path with `&`.
// This pattern is used only on Windows; Bash parsing remains unchanged.
var windowsMetricBinPattern = `(?:(?:[A-Za-z]:[/\\])|(?:\.\.?[/\\])|/)[^;|&'"\r\n]*[/\\]qdm-metric-cli(?:\.exe)?`

var metricBinPattern = `(?:\$\{QDM_METRIC_CLI(?::-[^}]*)?\}|\$QDM_METRIC_CLI|[A-Za-z]:[/\\](?:[^\s;|&'"]+[/\\])*qdm-metric-cli(?:\.exe)?|/(?:[^\s;|&'"]+/)*qdm-metric-cli(?:\.exe)?|(?:[^\s;|&'"]+[/\\])*qdm-metric-cli(?:\.exe)?)`

func IsMetricAnalysisExecute(command string) bool {
	return matchesMetricInvocation(command, `analysis\s+execute`)
}

func IsMetricAuthDescribe(command string) bool {
	return matchesMetricInvocation(command, `auth\s+describe`)
}

func IsMetricAuthzGatedCommand(command string) bool {
	return matchesMetricInvocation(command, metricAuthzSubcommandPattern)
}

func MetricInvocationCount(command string) int {
	return len(metricInvocationRegexp(metricAuthzSubcommandPattern).FindAllStringIndex(MaskQuotedAndHeredocRegions(command), -1))
}

func looksLikeGatedMetricCommand(command string) bool {
	marker := regexp.MustCompile(`(?i)(?:qdm-metric-cli(?:\.exe)?|%QDM_METRIC_CLI%|\$env:QDM_METRIC_CLI|\$\{?QDM_METRIC_CLI(?:\:-[^}]*)?\}?)`)
	subcommand := regexp.MustCompile(`(?i)` + metricAuthzSubcommandPattern)
	return marker.MatchString(command) && subcommand.MatchString(command)
}

const metricAuthzSubcommandPattern = `(?:analysis\s+(?:validate|preview|execute|total)|dim\s+values|auth\s+describe)`

func CommandHasModelAuthFlags(command string) bool {
	skeleton := MaskQuotedAndHeredocRegions(command)
	return regexp.MustCompile(`(?i)(?:^|\s)\\?--(?:data-auth|auth-blob|auth-json)\b`).MatchString(skeleton)
}

func matchesMetricInvocation(command, subcmd string) bool {
	if strings.TrimSpace(command) == "" {
		return false
	}
	skeleton := MaskQuotedAndHeredocRegions(command)
	return metricInvocationRegexp(subcmd).MatchString(skeleton)
}

func metricInvocationRegexp(subcmd string) *regexp.Regexp {
	binPattern := runtimeMetricBinPattern()
	return metricRegexp(`(?m)(?:^|[\n;|&]|\b(?:then|do|if|elif|else)\b)\s*` +
		`(?:cmd(?:\.exe)?\s+/(?:c|k)\s+)?` +
		`(?:(?:source|\.)\s+[^\s;|&]+\s*(?:&&\s*)?)*` +
		`(?:[A-Za-z_][\w]*=(?:'[^\n']*'|"[^\n"]*"|\S+)\s+)*` +
		`(?:'|")?` + binPattern + `(?:'|")?\s+` + subcmd + `\b`)
}

func runtimeMetricBinPattern() string {
	if runtime.GOOS == "windows" {
		return `(?:` + metricBinPattern + `|` + windowsMetricBinPattern + `)`
	}
	return metricBinPattern
}

func metricRegexp(pattern string) *regexp.Regexp {
	if runtime.GOOS == "windows" {
		return regexp.MustCompile(`(?i)` + pattern)
	}
	return regexp.MustCompile(pattern)
}

func MaskQuotedAndHeredocRegions(command string) string {
	if command == "" {
		return ""
	}
	chars := []rune(command)
	n := len(chars)
	i := 0
	spaceOut := func(from, to int) {
		for k := from; k < to && k < n; k++ {
			if chars[k] != '\n' && chars[k] != '\r' {
				chars[k] = ' '
			}
		}
	}
	isProtectedVarQuote := func(inner string) bool {
		return regexp.MustCompile(`^\$\{?QDM_METRIC_CLI(?::-[^}]*)?\}?$`).MatchString(strings.TrimSpace(inner))
	}
	isWindowsMetricCLIPath := func(inner string) bool {
		if runtime.GOOS != "windows" {
			return false
		}
		return regexp.MustCompile(`(?i)^(?:(?:[A-Za-z]:[/\\])|(?:\.\.?[/\\])|/)[^\r\n]*[/\\]qdm-metric-cli(?:\.exe)?$`).MatchString(strings.TrimSpace(inner))
	}

	for i < n {
		if chars[i] == '<' && i+1 < n && chars[i+1] == '<' {
			j := i + 2
			if j < n && chars[j] == '-' {
				j++
			}
			for j < n && isSpace(chars[j]) {
				j++
			}
			quote := rune(0)
			if j < n && (chars[j] == '\'' || chars[j] == '"') {
				quote = chars[j]
				j++
			}
			tagStart := j
			for j < n && isIdent(chars[j]) {
				j++
			}
			if j > tagStart {
				tag := string(chars[tagStart:j])
				if quote != 0 && j < n && chars[j] == quote {
					j++
				}
				bodyStart := j
				for bodyStart < n && chars[bodyStart] != '\n' {
					bodyStart++
				}
				if bodyStart < n {
					bodyStart++
				}
				k := bodyStart
				closed := false
				for k < n {
					if k == bodyStart || chars[k-1] == '\n' {
						t := k
						for t < n && chars[t] == '\t' {
							t++
						}
						if t+len([]rune(tag)) <= n && string(chars[t:t+len([]rune(tag))]) == tag {
							after := t + len([]rune(tag))
							if after >= n || chars[after] == '\n' || chars[after] == '\r' {
								spaceOut(bodyStart, t)
								i = after
								closed = true
								break
							}
						}
					}
					k++
				}
				if closed {
					continue
				}
				spaceOut(bodyStart, n)
				break
			}
		}

		if chars[i] == '\'' {
			j := i + 1
			for j < n && chars[j] != '\'' {
				j++
			}
			if j < n {
				inner := string(chars[i+1 : j])
				if !isProtectedVarQuote(inner) && !isWindowsMetricCLIPath(inner) {
					spaceOut(i+1, j)
				}
				i = j + 1
				continue
			}
			spaceOut(i+1, n)
			break
		}

		if chars[i] == '$' && i+1 < n && chars[i+1] == '\'' {
			j := i + 2
			for j < n {
				if chars[j] == '\\' && j+1 < n {
					j += 2
					continue
				}
				if chars[j] == '\'' {
					break
				}
				j++
			}
			if j < n {
				spaceOut(i+2, j)
				i = j + 1
				continue
			}
			spaceOut(i+2, n)
			break
		}

		if chars[i] == '"' {
			j := i + 1
			for j < n {
				if chars[j] == '\\' && j+1 < n {
					j += 2
					continue
				}
				if chars[j] == '"' {
					break
				}
				j++
			}
			if j < n {
				inner := string(chars[i+1 : j])
				if !isProtectedVarQuote(inner) && !isWindowsMetricCLIPath(inner) && !isCMDWrapperCommandQuote(chars, i) {
					spaceOut(i+1, j)
				}
				i = j + 1
				continue
			}
			spaceOut(i+1, n)
			break
		}
		i++
	}
	return string(chars)
}

func isCMDWrapperCommandQuote(chars []rune, quoteIndex int) bool {
	if runtime.GOOS != "windows" || quoteIndex <= 0 {
		return false
	}
	prefix := strings.TrimSpace(string(chars[:quoteIndex]))
	return regexp.MustCompile(`(?i)(?:^|[\n;|&])\s*cmd(?:\.exe)?\s+/(?:c|k)\s*$`).MatchString(prefix)
}

func RewriteMetricCliInvocation(command, metricCliPath string, dialect ...ShellDialect) string {
	if strings.TrimSpace(metricCliPath) == "" || command == "" {
		return command
	}
	quoted := shellQuote(metricCliPath, firstDialect(dialect))
	skeleton := MaskQuotedAndHeredocRegions(command)
	// In `cmd /c "qdm-metric-cli ..."`, the whole inner command is quoted
	// for CMD. Once the outer `cmd /c` prefix is sliced off, preserve that
	// quote pair so the executable token remains available for rewriting.
	if firstDialect(dialect) == ShellCMD && isCMDQuotedCommandSegment(command) {
		skeleton = command
	}
	binRe := metricRegexp(`(?:'|")?` + runtimeMetricBinPattern() + `(?:'|")?`)
	matches := binRe.FindAllStringIndex(skeleton, -1)
	if len(matches) == 0 {
		return command
	}
	var out strings.Builder
	last := 0
	invokeHereRe := metricRegexp(`^(?:'|")?` + runtimeMetricBinPattern() + `(?:'|")?\s+` + metricAuthzSubcommandPattern + `\b`)
	for _, match := range matches {
		if !invokeHereRe.MatchString(skeleton[match[0]:]) {
			continue
		}
		out.WriteString(command[last:match[0]])
		out.WriteString(quoted)
		last = match[1]
	}
	out.WriteString(command[last:])
	return out.String()
}

func StripAuthFlags(command string) string {
	return stripAuthFlagsWithSkeleton(command, MaskQuotedAndHeredocRegions(command))
}

func stripAuthFlagsWithSkeleton(command, skeleton string) string {
	// Bash treats an unquoted \--flag token as --flag. Strip both spellings so
	// model-supplied authorization cannot survive the runtime rewrite.
	re := regexp.MustCompile(`(?i)(?:^|\s)\\?--(?:data-auth\b|(?:auth-blob|auth-json)(?:\s*=\s*|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&]+))`)
	matches := re.FindAllStringIndex(skeleton, -1)
	if len(matches) == 0 {
		return strings.TrimSpace(command)
	}
	var out strings.Builder
	last := 0
	for _, match := range matches {
		out.WriteString(command[last:match[0]])
		last = match[1]
	}
	out.WriteString(command[last:])
	return strings.TrimSpace(out.String())
}

func InjectDataAuth(command, blob, metricCliPath string) (string, error) {
	if strings.TrimSpace(metricCliPath) == "" {
		cleaned := StripAuthFlags(command)
		return InsertFlagsBeforeShellTail(cleaned, " --data-auth --auth-blob "+ShellQuote(blob), "execute"), nil
	}
	return RewriteGatedMetricCommands(command, blob, metricCliPath)
}

func InjectAuthDescribeBlob(command, blob, metricCliPath string) (string, error) {
	if strings.TrimSpace(metricCliPath) == "" {
		cleaned := StripAuthFlags(command)
		return InsertFlagsBeforeShellTail(cleaned, " --auth-blob "+ShellQuote(blob), "describe"), nil
	}
	return RewriteGatedMetricCommands(command, blob, metricCliPath)
}

type metricInvocation struct {
	start int
	end   int
	kind  string
}

func RewriteGatedMetricCommands(command, blob, metricCliPath string, dialect ...ShellDialect) (string, error) {
	if strings.TrimSpace(metricCliPath) == "" {
		return "", fmt.Errorf("qdm-metric-cli path is empty")
	}
	activeDialect := firstDialect(dialect)
	if activeDialect == ShellCMD {
		if prefix, inner, ok := splitCMDWrapper(command); ok {
			rewrittenInner, err := RewriteGatedMetricCommands(inner, blob, metricCliPath, ShellCMD)
			if err != nil {
				return "", err
			}
			return prefix + `"` + rewrittenInner + `"`, nil
		}
	}
	invocations, err := findMetricInvocations(command)
	if err != nil {
		return "", err
	}
	if len(invocations) == 0 {
		return "", fmt.Errorf("no gated invocation found")
	}

	rewritten := command
	quotedCLI := shellQuote(metricCliPath, activeDialect)
	quotedBlob := shellQuote(blob, activeDialect)
	for index := len(invocations) - 1; index >= 0; index-- {
		invocation := invocations[index]
		segment := StripAuthFlags(command[invocation.start:invocation.end])
		segment = RewriteMetricCliInvocation(segment, metricCliPath, activeDialect)
		wrappedCMD := activeDialect == ShellCMD && strings.HasPrefix(segment, `"`) && strings.HasSuffix(segment, `"`)
		if wrappedCMD {
			segment = strings.TrimSuffix(segment, `"`)
		}
		if activeDialect == ShellPowerShell && !strings.HasPrefix(strings.TrimSpace(segment), "&") {
			segment = "& " + strings.TrimSpace(segment)
		}
		flags := " --auth-blob " + quotedBlob
		if invocation.kind == "analysis" || invocation.kind == "data" {
			flags = " --data-auth" + flags
		}
		replacement := strings.TrimRight(segment, " \t") + flags
		if wrappedCMD {
			replacement += `"`
		}
		trustedCLIStart := strings.HasPrefix(strings.TrimSpace(replacement), quotedCLI+" ")
		if activeDialect == ShellPowerShell {
			trustedCLIStart = trustedCLIStart || strings.HasPrefix(replacement, "& "+quotedCLI+" ")
		}
		if activeDialect == ShellCMD && isCMDWrapperText(replacement) {
			trustedCLIStart = strings.HasPrefix(strings.TrimSpace(replacement), "cmd /c "+quotedCLI+" ") ||
				strings.HasPrefix(strings.TrimSpace(replacement), "cmd /k "+quotedCLI+" ") ||
				strings.HasPrefix(strings.TrimSpace(replacement), "cmd.exe /c "+quotedCLI+" ") ||
				strings.HasPrefix(strings.TrimSpace(replacement), "cmd.exe /k "+quotedCLI+" ")
		}
		if activeDialect == ShellCMD && isCMDWrapperText(command) {
			trimmedReplacement := strings.TrimSpace(replacement)
			trustedCLIStart = trustedCLIStart || strings.HasPrefix(trimmedReplacement, quotedCLI+" ")
		}
		// For `cmd /c "qdm-metric-cli ..."`, the wrapper and its opening
		// quote are outside the invocation slice. The invocation itself still
		// starts at the trusted CLI token after RewriteMetricCliInvocation.
		if activeDialect == ShellCMD && isCMDWrapperText(command) {
			trimmedReplacement := strings.TrimSpace(replacement)
			trustedCLIStart = trustedCLIStart || strings.HasPrefix(trimmedReplacement, quotedCLI+" ") ||
				strings.HasPrefix(trimmedReplacement, `"`+quotedCLI+`" `)
		}
		if !trustedCLIStart {
			return "", fmt.Errorf("gated invocation did not bind the trusted CLI path")
		}
		if strings.Count(replacement, "--auth-blob") != 1 || !strings.Contains(replacement, "--auth-blob "+quotedBlob) || strings.Contains(replacement, "--auth-json") {
			return "", fmt.Errorf("gated invocation did not bind exactly one runtime blob")
		}
		dataAuthCount := strings.Count(replacement, "--data-auth")
		if ((invocation.kind == "analysis" || invocation.kind == "data") && dataAuthCount != 1) || (invocation.kind == "describe" && dataAuthCount != 0) {
			return "", fmt.Errorf("gated invocation has invalid data-auth flags")
		}
		rewritten = rewritten[:invocation.start] + replacement + rewritten[invocation.end:]
	}
	return rewritten, nil
}

func isCMDWrapperText(command string) bool {
	return regexp.MustCompile(`(?i)^\s*cmd(?:\.exe)?\s+/(?:c|k)\s+`).MatchString(command)
}

func splitCMDWrapper(command string) (prefix, inner string, ok bool) {
	match := regexp.MustCompile(`(?is)^(\s*cmd(?:\.exe)?\s+/(?:c|k)\s+)"(.*)"\s*$`).FindStringSubmatch(command)
	if match == nil {
		return "", "", false
	}
	return match[1], match[2], true
}

func isCMDQuotedCommandSegment(command string) bool {
	trimmed := strings.TrimSpace(command)
	return runtime.GOOS == "windows" && len(trimmed) >= 2 && strings.HasPrefix(trimmed, `"`) && strings.HasSuffix(trimmed, `"`)
}

func findMetricInvocations(command string) ([]metricInvocation, error) {
	skeleton := MaskQuotedAndHeredocRegions(command)
	invocations := []metricInvocation{}
	for _, candidate := range []struct {
		kind   string
		subcmd string
	}{
		{kind: "analysis", subcmd: `analysis\s+(?:validate|preview|execute|total)`},
		{kind: "data", subcmd: `dim\s+values`},
		{kind: "describe", subcmd: `auth\s+describe`},
	} {
		invocationRe := metricInvocationRegexp(candidate.subcmd)
		commandRe := metricRegexp(`(?:'|")?` + runtimeMetricBinPattern() + `(?:'|")?\s+` + candidate.subcmd + `\b`)
		for _, match := range invocationRe.FindAllStringIndex(skeleton, -1) {
			relative := commandRe.FindStringIndex(skeleton[match[0]:match[1]])
			if relative == nil {
				continue
			}
			start := match[0] + relative[0]
			subcommandEnd := match[0] + relative[1]
			end := metricInvocationEnd(skeleton, subcommandEnd)
			// `cmd /c "qdm-metric-cli ..."` wraps the complete inner
			invocations = append(invocations, metricInvocation{
				start: start,
				end:   end,
				kind:  candidate.kind,
			})
		}
	}
	sort.Slice(invocations, func(i, j int) bool { return invocations[i].start < invocations[j].start })
	for index := 1; index < len(invocations); index++ {
		if invocations[index-1].end > invocations[index].start {
			return nil, fmt.Errorf("overlapping gated invocations cannot be safely rewritten")
		}
	}
	return invocations, nil
}

func metricInvocationEnd(skeleton string, from int) int {
	tail := skeleton[from:]
	operator := regexp.MustCompile(`(?m)\s*(?:\|\||&&|[|;]|[0-9]*>|&>|\n)`).FindStringIndex(tail)
	if operator == nil {
		return len(skeleton)
	}
	return from + operator[0]
}

func InsertFlagsBeforeShellTail(command, flags, anchorWord string) string {
	skeleton := MaskQuotedAndHeredocRegions(command)
	subcmd := metricAuthzSubcommandPattern
	if anchorWord == "describe" {
		subcmd = `auth\s+describe`
	}
	inv := metricRegexp(`(?:'|")?` + runtimeMetricBinPattern() + `(?:'|")?\s+` + subcmd + `\b`).FindStringIndex(skeleton)
	fromAnchor := -1
	if inv != nil {
		if match := regexp.MustCompile(`(?i)` + subcmd).FindStringIndex(skeleton[inv[0]:inv[1]]); match != nil {
			fromAnchor = inv[0] + match[1]
		}
	}
	if fromAnchor < 0 {
		loc := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(anchorWord) + `\b`).FindStringIndex(command)
		if loc == nil {
			return command + flags
		}
		fromAnchor = loc[0]
	}
	tail := command[fromAnchor:]
	op := regexp.MustCompile(`\s(?:\||&&|;|2?>|1?>|&>)`).FindStringIndex(tail)
	if op == nil {
		return command + flags
	}
	abs := fromAnchor + op[0]
	return command[:abs] + flags + command[abs:]
}

func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func firstDialect(dialect []ShellDialect) ShellDialect {
	if len(dialect) > 0 && dialect[0] != "" {
		return dialect[0]
	}
	return ShellBash
}

func shellQuote(value string, dialect ShellDialect) string {
	switch dialect {
	case ShellCMD:
		return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	default:
		return ShellQuote(value)
	}
}

func isSpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r'
}

func isIdent(r rune) bool {
	return (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_'
}
