package agentauthz

import (
	"regexp"
	"strings"
)

var powerShellMetricExecutablePattern = `(?:"[^"\r\n]*qdm-metric-cli(?:\.exe)?"|'[^'\r\n]*qdm-metric-cli(?:\.exe)?'|\$env:QDM_METRIC_CLI|(?:[A-Za-z]:)?(?:\.{0,2}[\\/])?(?:[^\s;|&'"` + "`" + `]+[\\/])*qdm-metric-cli(?:\.exe)?|qdm-metric-cli(?:\.exe)?)`

func IsPowerShellMetricAnalysisExecute(command string) bool {
	return powerShellInvocationRegexp(`analysis\s+execute`).MatchString(MaskPowerShellRegions(command))
}

func IsPowerShellMetricAuthDescribe(command string) bool {
	return powerShellInvocationRegexp(`auth\s+describe`).MatchString(MaskPowerShellRegions(command))
}

func IsPowerShellMetricAuthzGatedCommand(command string) bool {
	return IsPowerShellMetricAnalysisExecute(command) || IsPowerShellMetricAuthDescribe(command)
}

func PowerShellMetricInvocationCount(command string) int {
	re := powerShellInvocationRegexp(`(?:analysis\s+execute|auth\s+describe)`)
	return len(re.FindAllStringIndex(MaskPowerShellRegions(command), -1))
}

func PowerShellCommandHasModelAuthFlags(command string) bool {
	skeleton := MaskPowerShellRegions(command)
	return regexp.MustCompile(`(?i)(?:^|\s)--(?:data-auth|auth-blob|auth-json)\b`).MatchString(skeleton)
}

func powerShellInvocationRegexp(subcommand string) *regexp.Regexp {
	return regexp.MustCompile(`(?im)(?:^|[\r\n;|]|&&)\s*(?:\$[A-Za-z_][\w]*\s*=\s*)?(?:&\s*)?` + powerShellMetricExecutablePattern + `\s+` + subcommand + `\b`)
}

func RewritePowerShellMetricCLIInvocation(command, metricCLIPath string) string {
	if strings.TrimSpace(command) == "" || strings.TrimSpace(metricCLIPath) == "" {
		return command
	}
	return rewritePowerShellMetricCLIExecutable(command, PowerShellQuote(metricCLIPath))
}

func RewritePowerShellMetricCLIToBroker(command, brokerPath, agent string) string {
	if strings.TrimSpace(command) == "" || strings.TrimSpace(brokerPath) == "" {
		return command
	}
	cleaned := StripPowerShellAuthFlags(command)
	replacement := PowerShellQuote(brokerPath) + " authz-exec --agent " + PowerShellQuote(agent) + " --"
	return rewritePowerShellMetricCLIExecutable(cleaned, replacement)
}

func rewritePowerShellMetricCLIExecutable(command, replacement string) string {
	skeleton := MaskPowerShellRegions(command)
	re := regexp.MustCompile(`(?im)(?:^|[\r\n;|]|&&)(\s*)(?:\$[A-Za-z_][\w]*\s*=\s*)?(&\s*)?(` + powerShellMetricExecutablePattern + `)(\s+)(?:analysis\s+execute|auth\s+describe)\b`)
	matches := re.FindAllStringSubmatchIndex(skeleton, -1)
	if len(matches) == 0 {
		return command
	}
	var out strings.Builder
	last := 0
	for _, match := range matches {
		execStart, execEnd := match[6], match[7]
		ampStart := match[4]
		out.WriteString(command[last:execStart])
		if ampStart < 0 {
			out.WriteString("& ")
		}
		out.WriteString(replacement)
		last = execEnd
	}
	out.WriteString(command[last:])
	return out.String()
}

// WrapPowerShellHostOutput keeps native-process output in memory and re-emits
// it through PowerShell. WorkBuddy 5.3.8's sandbox result path otherwise keeps
// only the native exit code for some updatedInput commands.
func WrapPowerShellHostOutput(command string) string {
	if strings.TrimSpace(command) == "" {
		return command
	}
	return "& { $__qdmHarnessOutput = & { " + command +
		" } 2>&1; $__qdmHarnessExitCode = $LASTEXITCODE; " +
		"$__qdmHarnessOutput | ForEach-Object { $_ }; " +
		"if ($__qdmHarnessExitCode -ne 0) { exit $__qdmHarnessExitCode } }"
}

func StripPowerShellAuthFlags(command string) string {
	return stripAuthFlagsWithSkeleton(command, MaskPowerShellRegions(command))
}

func InjectPowerShellDataAuth(command, blob, metricCLIPath string) string {
	cleaned := StripPowerShellAuthFlags(command)
	cleaned = RewritePowerShellMetricCLIInvocation(cleaned, metricCLIPath)
	return insertPowerShellFlags(cleaned, " --data-auth --auth-blob "+PowerShellQuote(blob), "execute")
}

func InjectPowerShellAuthDescribeBlob(command, blob, metricCLIPath string) string {
	cleaned := StripPowerShellAuthFlags(command)
	cleaned = RewritePowerShellMetricCLIInvocation(cleaned, metricCLIPath)
	return insertPowerShellFlags(cleaned, " --auth-blob "+PowerShellQuote(blob), "describe")
}

func insertPowerShellFlags(command, flags, anchorWord string) string {
	skeleton := MaskPowerShellRegions(command)
	subcommand := `analysis\s+execute`
	if anchorWord == "describe" {
		subcommand = `auth\s+describe`
	}
	invocation := powerShellInvocationRegexp(subcommand).FindStringIndex(skeleton)
	if invocation == nil {
		return command
	}
	segment := strings.ToLower(skeleton[invocation[0]:invocation[1]])
	relativeAnchor := strings.LastIndex(segment, strings.ToLower(anchorWord))
	if relativeAnchor < 0 {
		return command
	}
	anchorEnd := invocation[0] + relativeAnchor + len(anchorWord)
	tail := skeleton[anchorEnd:]
	op := regexp.MustCompile(`\s(?:\||&&|;|2?>|1?>|&>)`).FindStringIndex(tail)
	if op == nil {
		return command + flags
	}
	position := anchorEnd + op[0]
	return command[:position] + flags + command[position:]
}

func PowerShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func MaskPowerShellRegions(command string) string {
	if command == "" {
		return ""
	}
	masked := []byte(command)
	space := func(from, to int) {
		for i := from; i < to && i < len(masked); i++ {
			if masked[i] != '\r' && masked[i] != '\n' {
				masked[i] = ' '
			}
		}
	}
	for i := 0; i < len(command); {
		if i+2 < len(command) && command[i] == '@' && (command[i+1] == '\'' || command[i+1] == '"') && (command[i+2] == '\r' || command[i+2] == '\n') {
			quote := command[i+1]
			endMarker := string([]byte{'\n', quote, '@'})
			end := strings.Index(command[i+2:], endMarker)
			if end < 0 {
				space(i, len(command))
				break
			}
			end += i + 2 + len(endMarker)
			space(i, end)
			i = end
			continue
		}
		if command[i] == '#' {
			end := strings.IndexByte(command[i:], '\n')
			if end < 0 {
				space(i, len(command))
				break
			}
			space(i, i+end)
			i += end
			continue
		}
		if command[i] == '\'' || command[i] == '"' {
			quote := command[i]
			j := i + 1
			for j < len(command) {
				if quote == '\'' && command[j] == '\'' && j+1 < len(command) && command[j+1] == '\'' {
					j += 2
					continue
				}
				if quote == '"' && command[j] == '`' && j+1 < len(command) {
					j += 2
					continue
				}
				if command[j] == quote {
					break
				}
				j++
			}
			if j >= len(command) {
				space(i+1, len(command))
				break
			}
			if !isPowerShellMetricExecutable(command[i+1 : j]) {
				space(i+1, j)
			}
			i = j + 1
			continue
		}
		i++
	}
	return string(masked)
}

func isPowerShellMetricExecutable(value string) bool {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	lower := strings.ToLower(value)
	if lower == "$env:qdm_metric_cli" {
		return true
	}
	parts := strings.Split(lower, "/")
	base := parts[len(parts)-1]
	return base == "qdm-metric-cli" || base == "qdm-metric-cli.exe"
}
