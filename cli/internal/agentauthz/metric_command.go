package agentauthz

import (
	"regexp"
	"strings"
)

var metricBinPattern = `(?:\$\{QDM_METRIC_CLI(?::-[^}]*)?\}|\$QDM_METRIC_CLI|[A-Za-z]:[\\/](?:[^\s;|&'"]+[\\/])*qdm-metric-cli(?:\.exe)?|/(?:[^\s;|&'"]+/)*qdm-metric-cli(?:\.exe)?|(?:[^\s;|&'"]+[\\/])*qdm-metric-cli(?:\.exe)?)`

func IsMetricAnalysisExecute(command string) bool {
	return matchesMetricInvocation(command, `analysis\s+execute`)
}

func IsMetricAuthDescribe(command string) bool {
	return matchesMetricInvocation(command, `auth\s+describe`)
}

func IsMetricAuthzGatedCommand(command string) bool {
	return IsMetricAnalysisExecute(command) || IsMetricAuthDescribe(command)
}

func MetricInvocationCount(command string) int {
	return len(metricInvocationRegexp(`(?:analysis\s+execute|auth\s+describe)`).FindAllStringIndex(MaskQuotedAndHeredocRegions(command), -1))
}

func looksLikeGatedMetricCommand(command string) bool {
	marker := regexp.MustCompile(`(?i)(?:qdm-metric-cli(?:\.exe)?|%QDM_METRIC_CLI%|\$env:QDM_METRIC_CLI|\$\{?QDM_METRIC_CLI(?:\:-[^}]*)?\}?)`)
	subcommand := regexp.MustCompile(`(?i)(?:analysis\s+execute|auth\s+describe)`)
	return marker.MatchString(command) && subcommand.MatchString(command)
}

func CommandHasModelAuthFlags(command string) bool {
	skeleton := MaskQuotedAndHeredocRegions(command)
	return regexp.MustCompile(`(?:^|\s)--(?:data-auth|auth-blob|auth-json)\b`).MatchString(skeleton)
}

func matchesMetricInvocation(command, subcmd string) bool {
	if strings.TrimSpace(command) == "" {
		return false
	}
	skeleton := MaskQuotedAndHeredocRegions(command)
	return metricInvocationRegexp(subcmd).MatchString(skeleton)
}

func metricInvocationRegexp(subcmd string) *regexp.Regexp {
	return regexp.MustCompile(`(?m)(?:^|[\n;|&]|\b(?:then|do|if|elif|else)\b)\s*` +
		`(?:(?:source|\.)\s+[^\s;|&]+\s*(?:&&\s*)?)*` +
		`(?:[A-Za-z_][\w]*=(?:'[^\n']*'|"[^\n"]*"|\S+)\s+)*` +
		`(?:'|")?` + metricBinPattern + `(?:'|")?\s+` + subcmd + `\b`)
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
				if !isProtectedVarQuote(string(chars[i+1 : j])) {
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
				if !isProtectedVarQuote(string(chars[i+1 : j])) {
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

func RewriteMetricCliInvocation(command, metricCliPath string) string {
	if strings.TrimSpace(metricCliPath) == "" || command == "" {
		return command
	}
	return rewriteMetricCLIExecutable(command, ShellQuote(metricCliPath))
}

func RewriteMetricCLIToBroker(command, brokerPath, agent string) string {
	if strings.TrimSpace(brokerPath) == "" || command == "" {
		return command
	}
	cleaned := StripAuthFlags(command)
	replacement := ShellQuote(brokerPath) + " authz-exec --agent " + ShellQuote(agent) + " --"
	return rewriteMetricCLIExecutable(cleaned, replacement)
}

func rewriteMetricCLIExecutable(command, replacement string) string {
	skeleton := MaskQuotedAndHeredocRegions(command)
	binRe := regexp.MustCompile(`(?:'|")?` + metricBinPattern + `(?:'|")?`)
	matches := binRe.FindAllStringIndex(skeleton, -1)
	if len(matches) == 0 {
		return command
	}
	var out strings.Builder
	last := 0
	invokeHereRe := regexp.MustCompile(`^(?:'|")?` + metricBinPattern + `(?:'|")?\s+(?:analysis\s+execute|auth\s+describe)\b`)
	for _, match := range matches {
		if !invokeHereRe.MatchString(skeleton[match[0]:]) {
			continue
		}
		out.WriteString(command[last:match[0]])
		out.WriteString(replacement)
		last = match[1]
	}
	out.WriteString(command[last:])
	return out.String()
}

func StripAuthFlags(command string) string {
	return stripAuthFlagsWithSkeleton(command, MaskQuotedAndHeredocRegions(command))
}

func stripAuthFlagsWithSkeleton(command, skeleton string) string {
	re := regexp.MustCompile(`(?i)(?:^|\s)--(?:data-auth\b|(?:auth-blob|auth-json)(?:\s*=\s*|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&]+))`)
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

func InjectDataAuth(command, blob, metricCliPath string) string {
	cleaned := StripAuthFlags(command)
	if metricCliPath != "" {
		cleaned = RewriteMetricCliInvocation(cleaned, metricCliPath)
	}
	flags := " --data-auth --auth-blob " + ShellQuote(blob)
	return InsertFlagsBeforeShellTail(cleaned, flags, "execute")
}

func InjectAuthDescribeBlob(command, blob, metricCliPath string) string {
	cleaned := StripAuthFlags(command)
	if metricCliPath != "" {
		cleaned = RewriteMetricCliInvocation(cleaned, metricCliPath)
	}
	flags := " --auth-blob " + ShellQuote(blob)
	return InsertFlagsBeforeShellTail(cleaned, flags, "describe")
}

func InsertFlagsBeforeShellTail(command, flags, anchorWord string) string {
	skeleton := MaskQuotedAndHeredocRegions(command)
	subcmd := `analysis\s+execute`
	if anchorWord == "describe" {
		subcmd = `auth\s+describe`
	}
	inv := regexp.MustCompile(`(?i)(?:'|")?` + metricBinPattern + `(?:'|")?\s+` + subcmd + `\b`).FindStringIndex(skeleton)
	fromAnchor := -1
	if inv != nil {
		lower := strings.ToLower(skeleton[inv[0]:inv[1]])
		rel := strings.LastIndex(lower, strings.ToLower(anchorWord))
		if rel >= 0 {
			fromAnchor = inv[0] + rel
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

func isSpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r'
}

func isIdent(r rune) bool {
	return (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_'
}
