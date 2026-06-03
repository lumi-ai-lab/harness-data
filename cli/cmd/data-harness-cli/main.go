package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	dhcontext "harness-data/cli/internal/context"
	"harness-data/cli/internal/harness"
	idx "harness-data/cli/internal/index"
	"harness-data/cli/internal/posttool"
	"harness-data/cli/internal/retrieval"
	"harness-data/cli/internal/sessionstate"
	"harness-data/cli/internal/wikis"
)

func main() {
	if err := run(); err != nil {
		var exitErr exitCodeError
		if ok := asExitCodeError(err, &exitErr); ok {
			if !exitErr.Silent {
				fmt.Fprintln(os.Stderr, err)
			}
			os.Exit(exitErr.Code)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type exitCodeError struct {
	Code   int
	Err    error
	Silent bool
}

func (e exitCodeError) Error() string { return e.Err.Error() }

func asExitCodeError(err error, target *exitCodeError) bool {
	if e, ok := err.(exitCodeError); ok {
		*target = e
		return true
	}
	return false
}

func run() error {
	if len(os.Args) < 2 {
		return errors.New(usageText())
	}
	if os.Args[1] == "-h" || os.Args[1] == "--help" || os.Args[1] == "help" {
		printUsage()
		return nil
	}
	root, err := harness.FindRoot(rootStart())
	if err != nil {
		return fmt.Errorf("cannot find harness root: %w", err)
	}
	switch os.Args[1] {
	case "wikis":
		return runWikis(root, os.Args[2:])
	case "context":
		fs := flag.NewFlagSet("context", flag.ExitOnError)
		question := fs.String("question", "", "question")
		jsonOut := fs.Bool("json", false, "print json")
		format := fs.String("format", "text", "output format: text, json, claude-hook, codex-hook, or agent-hook")
		_ = fs.Parse(os.Args[2:])
		if *jsonOut {
			*format = "json"
		}
		switch *format {
		case "text", "json":
			if *question == "" {
				return fmt.Errorf("context requires --question")
			}
			response, err := dhcontext.Build(root, *question)
			if err != nil {
				return err
			}
			if *format == "json" {
				return printJSON(response)
			}
			for _, ref := range response.ContextFiles {
				fmt.Printf("%s\t%s\n", ref.Path, ref.Reason)
			}
		case "claude-hook", "codex-hook", "agent-hook":
			input, err := dhcontext.ReadHookStdin()
			if err != nil {
				return err
			}
			ok, output, err := dhcontext.RunClaudeHook(root, input)
			if err != nil {
				return err
			}
			if ok {
				return printCompactJSON(output)
			}
		default:
			return fmt.Errorf("unsupported context --format: %s", *format)
		}
	case "posttool":
		fs := flag.NewFlagSet("posttool", flag.ExitOnError)
		format := fs.String("format", "claude-hook", "output format: claude-hook, codex-hook, or agent-hook")
		_ = fs.Parse(os.Args[2:])
		if !isAgentHookFormat(*format) {
			return fmt.Errorf("unsupported posttool --format: %s", *format)
		}
		input, err := posttool.ReadHookStdin()
		if err != nil {
			return err
		}
		ok, output, err := posttool.RunClaudeHook(root, input)
		if err != nil {
			return err
		}
		if ok {
			return printCompactJSON(output)
		}
	case "inject-template":
		fs := flag.NewFlagSet("inject-template", flag.ExitOnError)
		_ = fs.Parse(os.Args[2:])
		if fs.NArg() != 0 {
			return fmt.Errorf("inject-template does not accept arguments")
		}
		fmt.Println("QDM_INJECT_TEMPLATE_SIGNAL emitted. Do not use this command stdout as the template. Wait for the PostToolUse hook to inject the selected template for the current Claude session.")
	case "stage":
		return runStage(os.Args[2:])
	case "show":
		fs := flag.NewFlagSet("show", flag.ExitOnError)
		jsonOut := fs.Bool("json", false, "print json")
		_ = fs.Parse(os.Args[2:])
		args := normalizeArgs(fs.Args(), jsonOut)
		if len(args) != 1 {
			return fmt.Errorf("show requires id or path")
		}
		indexes, err := idx.Build(root)
		if err != nil {
			return err
		}
		doc, ok := idx.FindByIDOrPath(indexes, args[0])
		if !ok {
			return fmt.Errorf("not found: %s", args[0])
		}
		if *jsonOut {
			return printJSON(doc)
		}
		fmt.Printf("%s\t%s\t%s\n", doc.ID, doc.Kind, doc.Path)
	default:
		return fmt.Errorf("unknown command: %s", os.Args[1])
	}
	return nil
}

func isAgentHookFormat(format string) bool {
	switch format {
	case "claude-hook", "codex-hook", "agent-hook":
		return true
	default:
		return false
	}
}

func printUsage() {
	fmt.Println(usageText())
}

func usageText() string {
	return "usage: data-harness-cli <wikis|context|stage|inject-template|posttool|show>"
}

func runStage(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: data-harness-cli stage <template>")
	}
	switch args[0] {
	case "template":
		fs := flag.NewFlagSet("stage template", flag.ExitOnError)
		_ = fs.Parse(args[1:])
		if fs.NArg() != 0 {
			return fmt.Errorf("stage template does not accept arguments")
		}
		fmt.Println("QDM_STAGE_TEMPLATE_SIGNAL emitted. Do not use this command stdout as the template. Wait for the PostToolUse hook to inject the selected template for the current session.")
	default:
		return fmt.Errorf("unknown stage command: %s", args[0])
	}
	return nil
}

func runWikis(root string, args []string) error {
	if len(args) < 1 {
		return exitCodeError{Code: 2, Err: fmt.Errorf("usage: data-harness-cli wikis <check-index-md|check-titles|check-frontmatter|check-aliases|check-covers|check-links|check-context|context-stats|recall-debug|templates|aliases|metric-duplicates|check-all|build-index|sync-index-md>")}
	}
	switch args[0] {
	case "check-index-md", "check-titles", "check-frontmatter", "check-aliases", "check-covers", "check-links":
		result, err := runSingleWikiCheck(root, args[0], args[1:])
		if err != nil {
			return exitCodeError{Code: 2, Err: err}
		}
		if result.TotalErrors > 0 {
			return exitCodeError{Code: 1, Err: fmt.Errorf("%s failed with %d error(s)", result.Check, result.TotalErrors), Silent: true}
		}
	case "check-context":
		result, err := runWikiCheckContext(root, args[1:])
		if err != nil {
			return exitCodeError{Code: 2, Err: err}
		}
		if result.TotalErrors > 0 {
			return exitCodeError{Code: 1, Err: fmt.Errorf("%s failed with %d error(s)", result.Check, result.TotalErrors), Silent: true}
		}
	case "context-stats":
		if err := runWikiContextStats(root, args[1:]); err != nil {
			return exitCodeError{Code: 2, Err: err}
		}
	case "recall-debug":
		if err := runWikiRecallDebug(root, args[1:]); err != nil {
			return exitCodeError{Code: 2, Err: err}
		}
	case "templates":
		code, err := runWikiTemplates(root, args[1:])
		if err != nil {
			return exitCodeError{Code: code, Err: err}
		}
	case "aliases":
		code, err := runWikiAliases(root, args[1:])
		if err != nil {
			return exitCodeError{Code: code, Err: err}
		}
	case "metric-duplicates":
		code, err := runWikiMetricDuplicates(root, args[1:])
		if err != nil {
			return exitCodeError{Code: code, Err: err}
		}
	case "check-all":
		results, err := runWikiCheckAll(root, args[1:])
		if err != nil {
			return exitCodeError{Code: 2, Err: err}
		}
		total := 0
		for _, result := range results {
			total += result.TotalErrors
		}
		if total > 0 {
			return exitCodeError{Code: 1, Err: fmt.Errorf("check-all failed with %d error(s)", total), Silent: true}
		}
	case "build-index":
		result, err := runWikiBuildIndex(root, args[1:])
		if err != nil {
			var checkFailed wikis.CheckFailedError
			if errors.As(err, &checkFailed) {
				return exitCodeError{Code: 1, Err: err}
			}
			return exitCodeError{Code: 2, Err: err}
		}
		_ = result
	case "sync-index-md":
		result, err := runWikiSyncIndexMD(root, args[1:])
		if err != nil {
			return exitCodeError{Code: 2, Err: err}
		}
		if result.CheckOnly && len(result.Outdated) > 0 {
			return exitCodeError{Code: 1, Err: fmt.Errorf("sync-index-md check failed with %d outdated file(s)", len(result.Outdated)), Silent: true}
		}
	default:
		return exitCodeError{Code: 2, Err: fmt.Errorf("unknown wikis command: %s", args[0])}
	}
	return nil
}

func runWikiTemplates(root string, args []string) (int, error) {
	if len(args) < 1 {
		return 2, fmt.Errorf("usage: data-harness-cli wikis templates <doctor|select-debug>")
	}
	switch args[0] {
	case "doctor":
		result, err := runWikiTemplatesDoctor(root, args[1:])
		if err != nil {
			return 2, err
		}
		if result.Status == "FAIL" {
			return 1, fmt.Errorf("templates doctor failed with %d error(s)", len(result.Errors))
		}
		return 0, nil
	case "select-debug":
		return 0, runWikiTemplatesSelectDebug(root, args[1:])
	default:
		return 2, fmt.Errorf("unknown wikis templates command: %s", args[0])
	}
}

func runWikiTemplatesDoctor(root string, args []string) (wikis.TemplateDoctorResult, error) {
	fs := flag.NewFlagSet("wikis templates doctor", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	out := fs.String("out", "", "suggested selection yaml output")
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return wikis.TemplateDoctorResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.TemplateDoctorResult{}, fmt.Errorf("templates doctor does not accept positional arguments")
	}
	result, err := wikis.BuildTemplateDoctor(root, *out)
	if err != nil {
		return wikis.TemplateDoctorResult{}, err
	}
	if *jsonOut {
		return result, printJSON(result)
	}
	printTemplatesDoctor(result)
	return result, nil
}

func runWikiTemplatesSelectDebug(root string, args []string) error {
	fs := flag.NewFlagSet("wikis templates select-debug", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	question := fs.String("question", "", "question")
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("templates select-debug does not accept positional arguments")
	}
	if *question == "" {
		return fmt.Errorf("templates select-debug requires --question")
	}
	index, err := wikis.LoadRuntimeIndex(root)
	if err != nil {
		return err
	}
	response, plan, err := dhcontext.BuildWithRuntimeIndex(root, *question, index)
	if err != nil {
		return err
	}
	result := recallDebugResult{
		Question:     *question,
		Matches:      dhcontext.RecallMatches(index, *question, 20),
		Plan:         recallDebugPlanFromWikiPlan(plan),
		ContextFiles: response.ContextFiles,
	}
	if *jsonOut {
		return printJSON(result)
	}
	printTemplatesSelectDebug(result)
	return nil
}

func runWikiMetricDuplicates(root string, args []string) (int, error) {
	if len(args) < 1 {
		return 2, fmt.Errorf("usage: data-harness-cli wikis metric-duplicates <report|export|lint|import>")
	}
	switch args[0] {
	case "report":
		return 0, runWikiMetricDuplicatesReport(root, args[1:])
	case "export":
		return 0, runWikiMetricDuplicatesExport(root, args[1:])
	case "lint":
		result, err := runWikiMetricDuplicatesLint(root, args[1:])
		if err != nil {
			return 2, err
		}
		if len(result.Errors) > 0 {
			return 1, fmt.Errorf("metric-duplicates lint failed with %d error(s)", len(result.Errors))
		}
		return 0, nil
	case "import":
		result, err := runWikiMetricDuplicatesImport(root, args[1:])
		if err != nil {
			return 2, err
		}
		if len(result.Lint.Errors) > 0 {
			return 1, fmt.Errorf("metric-duplicates import failed lint with %d error(s)", len(result.Lint.Errors))
		}
		return 0, nil
	default:
		return 2, fmt.Errorf("unknown wikis metric-duplicates command: %s", args[0])
	}
}

func runWikiMetricDuplicatesReport(root string, args []string) error {
	fs := flag.NewFlagSet("wikis metric-duplicates report", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("metric-duplicates report does not accept positional arguments")
	}
	report, err := wikis.BuildMetricDuplicatesReport(root)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printJSON(report)
	}
	printMetricDuplicatesReport(report)
	return nil
}

func runWikiMetricDuplicatesExport(root string, args []string) error {
	fs := flag.NewFlagSet("wikis metric-duplicates export", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	out := fs.String("out", "", "output file")
	format := fs.String("format", "lite", "output format: lite, full, or json")
	rootLabel := fs.String("root", "wikis", "wiki root label written to export metadata")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("metric-duplicates export does not accept positional arguments")
	}
	if *out == "" {
		return fmt.Errorf("metric-duplicates export requires --out")
	}
	switch *format {
	case "lite", "yaml", "yml":
		data, err := wikis.ExportMetricDuplicatesLite(root)
		if err != nil {
			return err
		}
		if len(data.Duplicates) == 0 {
			return skipEmptyMetricDuplicatesExport(*out)
		}
		return wikis.WriteMetricDuplicatesLiteYAML(*out, data)
	case "full":
		data, err := wikis.ExportMetricDuplicates(root, *rootLabel)
		if err != nil {
			return err
		}
		if len(data.Groups) == 0 {
			return skipEmptyMetricDuplicatesExport(*out)
		}
		return wikis.WriteMetricDuplicatesYAML(*out, data)
	case "json":
		data, err := wikis.ExportMetricDuplicates(root, *rootLabel)
		if err != nil {
			return err
		}
		if len(data.Groups) == 0 {
			return skipEmptyMetricDuplicatesExport(*out)
		}
		encoded, err := wikis.MarshalMetricDuplicatesJSON(data)
		if err != nil {
			return err
		}
		return os.WriteFile(*out, encoded, 0o644)
	default:
		return fmt.Errorf("unsupported metric-duplicates export --format: %s", *format)
	}
}

func skipEmptyMetricDuplicatesExport(out string) error {
	if err := os.Remove(out); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Printf("no metric duplicates found; no export generated: %s\n", out)
	return nil
}

func runWikiMetricDuplicatesLint(root string, args []string) (wikis.MetricDuplicatesLintResult, error) {
	fs := flag.NewFlagSet("wikis metric-duplicates lint", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	file := fs.String("file", "", "duplicate metrics yaml/json file")
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return wikis.MetricDuplicatesLintResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.MetricDuplicatesLintResult{}, fmt.Errorf("metric-duplicates lint does not accept positional arguments")
	}
	if *file == "" {
		return wikis.MetricDuplicatesLintResult{}, fmt.Errorf("metric-duplicates lint requires --file")
	}
	result, err := wikis.LintMetricDuplicatesFile(root, *file)
	if err != nil {
		return wikis.MetricDuplicatesLintResult{}, err
	}
	if *jsonOut {
		return result, printJSON(result)
	}
	printMetricDuplicatesLint(result)
	return result, nil
}

func runWikiMetricDuplicatesImport(root string, args []string) (wikis.MetricDuplicatesImportResult, error) {
	fs := flag.NewFlagSet("wikis metric-duplicates import", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	file := fs.String("file", "", "duplicate metrics yaml/json file")
	apply := fs.Bool("apply", false, "write changes")
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return wikis.MetricDuplicatesImportResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.MetricDuplicatesImportResult{}, fmt.Errorf("metric-duplicates import does not accept positional arguments")
	}
	if *file == "" {
		return wikis.MetricDuplicatesImportResult{}, fmt.Errorf("metric-duplicates import requires --file")
	}
	result, err := wikis.ImportMetricDuplicates(root, *file, *apply)
	if err != nil {
		return wikis.MetricDuplicatesImportResult{}, err
	}
	if *jsonOut {
		return result, printJSON(result)
	}
	printMetricDuplicatesImport(result)
	return result, nil
}

func runWikiAliases(root string, args []string) (int, error) {
	if len(args) < 1 {
		return 2, fmt.Errorf("usage: data-harness-cli wikis aliases <report|export|lint|quality|import>")
	}
	switch args[0] {
	case "report":
		return 0, runWikiAliasesReport(root, args[1:])
	case "export":
		return 0, runWikiAliasesExport(root, args[1:])
	case "lint":
		result, err := runWikiAliasesLint(root, args[1:])
		if err != nil {
			return 2, err
		}
		if len(result.Errors) > 0 {
			return 1, fmt.Errorf("aliases lint failed with %d error(s)", len(result.Errors))
		}
		return 0, nil
	case "quality":
		result, err := runWikiAliasesQuality(root, args[1:])
		if err != nil {
			return 2, err
		}
		if len(result.Errors) > 0 {
			return 1, fmt.Errorf("aliases quality failed with %d error(s)", len(result.Errors))
		}
		return 0, nil
	case "import":
		result, err := runWikiAliasesImport(root, args[1:])
		if err != nil {
			return 2, err
		}
		if len(result.Lint.Errors) > 0 {
			return 1, fmt.Errorf("aliases import failed lint with %d error(s)", len(result.Lint.Errors))
		}
		return 0, nil
	default:
		return 2, fmt.Errorf("unknown wikis aliases command: %s", args[0])
	}
}

func runWikiAliasesQuality(root string, args []string) (wikis.AliasesLintResult, error) {
	fs := flag.NewFlagSet("wikis aliases quality", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	file := fs.String("file", "", "aliases yaml/json file")
	minLength := fs.Int("min-length", 3, "minimum alias length in runes")
	maxLength := fs.Int("max-length", 40, "maximum alias length in runes")
	requireAliases := fs.Bool("require-aliases", false, "fail when an included alias section is empty")
	minSpecAliases := fs.Int("min-spec-aliases", 0, "minimum aliases required for each included spec")
	minComboPlaybookAliases := fs.Int("min-combo-playbook-aliases", 0, "minimum aliases required for each included combo playbook")
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return wikis.AliasesLintResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.AliasesLintResult{}, fmt.Errorf("aliases quality does not accept positional arguments")
	}
	if *file == "" {
		return wikis.AliasesLintResult{}, fmt.Errorf("aliases quality requires --file")
	}
	result, err := wikis.CheckAliasesQualityFile(root, *file, wikis.AliasesQualityOptions{
		MinAliasRunes:           *minLength,
		MaxAliasRunes:           *maxLength,
		RequireAliases:          *requireAliases,
		MinSpecAliases:          *minSpecAliases,
		MinComboPlaybookAliases: *minComboPlaybookAliases,
	})
	if err != nil {
		return wikis.AliasesLintResult{}, err
	}
	if *jsonOut {
		return result, printJSON(result)
	}
	printAliasesLint(result)
	return result, nil
}

func runWikiAliasesReport(root string, args []string) error {
	fs := flag.NewFlagSet("wikis aliases report", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("aliases report does not accept positional arguments")
	}
	report, err := wikis.BuildAliasesReport(root)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printJSON(report)
	}
	fmt.Printf("spec files: %d\n", report.SpecFiles)
	fmt.Printf("spec with aliases: %d\n", report.SpecWithAliases)
	fmt.Printf("spec with negative_aliases: %d\n\n", report.SpecWithNegativeAliases)
	fmt.Printf("playbook files: %d\n", report.PlaybookFiles)
	fmt.Printf("playbook with aliases: %d\n", report.PlaybookWithAliases)
	fmt.Printf("playbook with negative_aliases: %d\n\n", report.PlaybookWithNegativeAliases)
	fmt.Printf("duplicate aliases: %d\n", report.DuplicateAliases)
	fmt.Printf("label conflicts: %d\n", report.DuplicateLabels)
	fmt.Printf("placeholder short docs: %d\n", report.PlaceholderShortDocs)
	return nil
}

func runWikiAliasesExport(root string, args []string) error {
	fs := flag.NewFlagSet("wikis aliases export", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	out := fs.String("out", "", "output file")
	format := fs.String("format", "lite", "output format: lite, full, yaml, json, or lite-json")
	include := fs.String("include", "spec,playbooks", "comma-separated targets: spec,playbooks")
	rootLabel := fs.String("root", "wikis", "wiki root label written to export metadata")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("aliases export does not accept positional arguments")
	}
	if *out == "" {
		return fmt.Errorf("aliases export requires --out")
	}
	switch *format {
	case "lite", "yaml", "yml":
		data, err := wikis.ExportAliasesLite(root, splitCSV(*include))
		if err != nil {
			return err
		}
		return wikis.WriteAliasesLiteYAML(*out, data)
	case "full":
		data, err := wikis.ExportAliases(root, splitCSV(*include))
		if err != nil {
			return err
		}
		data.Root = *rootLabel
		return wikis.WriteAliasesYAML(*out, data)
	case "json":
		data, err := wikis.ExportAliases(root, splitCSV(*include))
		if err != nil {
			return err
		}
		data.Root = *rootLabel
		encoded, err := wikis.MarshalAliasesJSON(data)
		if err != nil {
			return err
		}
		return os.WriteFile(*out, encoded, 0o644)
	case "lite-json":
		data, err := wikis.ExportAliasesLite(root, splitCSV(*include))
		if err != nil {
			return err
		}
		encoded, err := wikis.MarshalAliasesLiteJSON(data)
		if err != nil {
			return err
		}
		return os.WriteFile(*out, encoded, 0o644)
	default:
		return fmt.Errorf("unsupported aliases export --format: %s", *format)
	}
}

func runWikiAliasesLint(root string, args []string) (wikis.AliasesLintResult, error) {
	fs := flag.NewFlagSet("wikis aliases lint", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	file := fs.String("file", "", "aliases yaml/json file")
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return wikis.AliasesLintResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.AliasesLintResult{}, fmt.Errorf("aliases lint does not accept positional arguments")
	}
	if *file == "" {
		return wikis.AliasesLintResult{}, fmt.Errorf("aliases lint requires --file")
	}
	result, err := wikis.LintAliasesFile(root, *file)
	if err != nil {
		return wikis.AliasesLintResult{}, err
	}
	if *jsonOut {
		return result, printJSON(result)
	}
	printAliasesLint(result)
	return result, nil
}

func runWikiAliasesImport(root string, args []string) (wikis.AliasesImportResult, error) {
	fs := flag.NewFlagSet("wikis aliases import", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	file := fs.String("file", "", "aliases yaml/json file")
	apply := fs.Bool("apply", false, "write changes")
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return wikis.AliasesImportResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.AliasesImportResult{}, fmt.Errorf("aliases import does not accept positional arguments")
	}
	if *file == "" {
		return wikis.AliasesImportResult{}, fmt.Errorf("aliases import requires --file")
	}
	result, err := wikis.ImportAliases(root, *file, *apply)
	if err != nil {
		return wikis.AliasesImportResult{}, err
	}
	if *jsonOut {
		return result, printJSON(result)
	}
	printAliasesImport(result)
	return result, nil
}

func runWikiBuildIndex(root string, args []string) (wikis.BuildIndexResult, error) {
	fs := flag.NewFlagSet("wikis build-index", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "print json")
	skipChecks := fs.Bool("skip-checks", false, "skip check-all before building")
	if err := fs.Parse(args); err != nil {
		return wikis.BuildIndexResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.BuildIndexResult{}, fmt.Errorf("build-index does not accept positional arguments")
	}
	if *skipChecks {
		fmt.Fprintln(os.Stderr, "warning: building wikis index with --skip-checks; only hard reliability blockers will be enforced")
	}
	result, err := wikis.BuildIndex(root, *skipChecks)
	if err != nil {
		return wikis.BuildIndexResult{}, err
	}
	if *jsonOut {
		return result, printJSON(result)
	}
	fmt.Printf("built %s docs=%d recall=%d runtime=%s runtimeDocs=%d checksSkipped=%v\n", result.Path, result.DocCount, result.RecallCount, result.RuntimePath, result.RuntimeDocCount, result.ChecksSkipped)
	return result, nil
}

func runWikiSyncIndexMD(root string, args []string) (wikis.SyncIndexMDResult, error) {
	fs := flag.NewFlagSet("wikis sync-index-md", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "print json")
	checkOnly := fs.Bool("check", false, "check whether generated index.md blocks are up to date without writing")
	if err := fs.Parse(args); err != nil {
		return wikis.SyncIndexMDResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.SyncIndexMDResult{}, fmt.Errorf("sync-index-md does not accept positional arguments")
	}
	result, err := wikis.SyncIndexMD(root, *checkOnly)
	if err != nil {
		return wikis.SyncIndexMDResult{}, err
	}
	if *jsonOut {
		return result, printJSON(result)
	}
	if *checkOnly {
		if len(result.Outdated) == 0 {
			fmt.Printf("sync-index-md ok scanned=%d\n", result.Scanned)
			return result, nil
		}
		fmt.Printf("sync-index-md outdated: total=%d scanned=%d\n", len(result.Outdated), result.Scanned)
		for _, file := range result.Outdated {
			fmt.Printf("%s\toutdated\n", file)
		}
		fmt.Println("run: bin/data-harness-cli wikis sync-index-md")
		return result, nil
	}
	fmt.Printf("sync-index-md updated scanned=%d changed=%d created=%d\n", result.Scanned, len(result.Changed), len(result.Created))
	for _, file := range result.Changed {
		fmt.Printf("%s\tchanged\n", file)
	}
	for _, file := range result.Created {
		fmt.Printf("%s\tcreated\n", file)
	}
	return result, nil
}

func runWikiCheckContext(root string, args []string) (wikis.CheckResult, error) {
	const checkName = "check-context"
	fs := flag.NewFlagSet("wikis "+checkName, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "print json")
	maxErrors := fs.Int("max-errors", 100, "maximum errors to print")
	failFast := fs.Bool("fail-fast", false, "stop after first oversized context")
	maxFiles := fs.Int("max-files", 10, "maximum allowed contextFiles per recall term")
	if err := fs.Parse(args); err != nil {
		return wikis.CheckResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.CheckResult{}, fmt.Errorf("%s does not accept positional arguments", checkName)
	}
	if *maxFiles < 0 {
		return wikis.CheckResult{}, fmt.Errorf("--max-files must be >= 0")
	}
	index, err := wikis.LoadRuntimeIndex(root)
	if err != nil {
		return wikis.CheckResult{}, err
	}
	seen := map[string]bool{}
	var errs []wikis.CheckError
	for _, item := range index.Recall {
		if item.Term == "" || item.TargetPath == "" {
			continue
		}
		key := item.Term + "\x00" + item.TargetPath
		if seen[key] {
			continue
		}
		seen[key] = true
		response, plan, err := dhcontext.BuildWithRuntimeIndex(root, item.Term, index)
		if err != nil {
			return wikis.CheckResult{}, err
		}
		count := len(response.ContextFiles)
		if count <= *maxFiles {
			continue
		}
		errs = append(errs, wikis.CheckError{
			Check:   checkName,
			Path:    item.TargetPath,
			Code:    "context_files_exceeded",
			Message: fmt.Sprintf("contextFiles exceeds max-files: got %d > %d", count, *maxFiles),
			Target:  "term",
			Value:   item.Term,
			Other:   fmt.Sprintf("mode=%s", plan.Mode),
		})
		if *failFast {
			break
		}
	}
	result := makeCLICheckResult(checkName, errs, wikis.CheckOptions{MaxErrors: *maxErrors})
	if *jsonOut {
		return result, printJSON(checkJSONEnvelope([]wikis.CheckResult{result}))
	}
	printCheckResult(result)
	return result, nil
}

type contextStatsResult struct {
	Total        int                  `json:"total"`
	Min          int                  `json:"min"`
	P50          int                  `json:"p50"`
	P90          int                  `json:"p90"`
	P95          int                  `json:"p95"`
	P99          int                  `json:"p99"`
	Max          int                  `json:"max"`
	Distribution []contextStatsBucket `json:"distribution"`
	Top          []contextStatsEntry  `json:"top"`
}

type contextStatsBucket struct {
	ContextFiles int `json:"contextFiles"`
	Count        int `json:"count"`
}

type contextStatsEntry struct {
	Term         string `json:"term"`
	TargetPath   string `json:"targetPath"`
	Mode         string `json:"mode"`
	ContextFiles int    `json:"contextFiles"`
}

func runWikiContextStats(root string, args []string) error {
	fs := flag.NewFlagSet("wikis context-stats", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "print json")
	topN := fs.Int("top", 20, "number of largest context entries to print")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("context-stats does not accept positional arguments")
	}
	if *topN < 0 {
		return fmt.Errorf("--top must be >= 0")
	}
	index, err := wikis.LoadRuntimeIndex(root)
	if err != nil {
		return err
	}
	stats, err := buildContextStats(root, index, *topN)
	if err != nil {
		return err
	}
	if *jsonOut {
		return printJSON(stats)
	}
	printContextStats(stats)
	return nil
}

func buildContextStats(root string, index wikis.RuntimeIndex, topN int) (contextStatsResult, error) {
	seen := map[string]bool{}
	var entries []contextStatsEntry
	distribution := map[int]int{}
	for _, item := range index.Recall {
		if item.Term == "" || item.TargetPath == "" {
			continue
		}
		key := item.Term + "\x00" + item.TargetPath
		if seen[key] {
			continue
		}
		seen[key] = true
		response, plan, err := dhcontext.BuildWithRuntimeIndex(root, item.Term, index)
		if err != nil {
			return contextStatsResult{}, err
		}
		count := len(response.ContextFiles)
		distribution[count]++
		entries = append(entries, contextStatsEntry{
			Term:         item.Term,
			TargetPath:   item.TargetPath,
			Mode:         plan.Mode,
			ContextFiles: count,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].ContextFiles != entries[j].ContextFiles {
			return entries[i].ContextFiles > entries[j].ContextFiles
		}
		if entries[i].TargetPath != entries[j].TargetPath {
			return entries[i].TargetPath < entries[j].TargetPath
		}
		return entries[i].Term < entries[j].Term
	})
	counts := make([]int, 0, len(entries))
	for _, entry := range entries {
		counts = append(counts, entry.ContextFiles)
	}
	sort.Ints(counts)
	var buckets []contextStatsBucket
	for _, count := range sortedIntKeys(distribution) {
		buckets = append(buckets, contextStatsBucket{ContextFiles: count, Count: distribution[count]})
	}
	top := entries
	if len(top) > topN {
		top = top[:topN]
	}
	result := contextStatsResult{Distribution: buckets, Top: top}
	if len(counts) == 0 {
		return result, nil
	}
	result.Total = len(counts)
	result.Min = counts[0]
	result.P50 = percentileNearestRank(counts, 50)
	result.P90 = percentileNearestRank(counts, 90)
	result.P95 = percentileNearestRank(counts, 95)
	result.P99 = percentileNearestRank(counts, 99)
	result.Max = counts[len(counts)-1]
	return result, nil
}

func sortedIntKeys(values map[int]int) []int {
	keys := make([]int, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Ints(keys)
	return keys
}

func percentileNearestRank(sorted []int, percentile int) int {
	if len(sorted) == 0 {
		return 0
	}
	rank := (percentile*len(sorted) + 99) / 100
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

func printContextStats(stats contextStatsResult) {
	fmt.Printf("context-stats total=%d min=%d p50=%d p90=%d p95=%d p99=%d max=%d\n", stats.Total, stats.Min, stats.P50, stats.P90, stats.P95, stats.P99, stats.Max)
	fmt.Println()
	fmt.Println("contextFiles\tcount")
	for _, bucket := range stats.Distribution {
		fmt.Printf("%d\t%d\n", bucket.ContextFiles, bucket.Count)
	}
	if len(stats.Top) == 0 {
		return
	}
	fmt.Println()
	fmt.Println("top contextFiles:")
	for _, entry := range stats.Top {
		fmt.Printf("%d\t%s\t%s\tmode=%s\n", entry.ContextFiles, entry.Term, entry.TargetPath, entry.Mode)
	}
}

type recallDebugResult struct {
	Question           string            `json:"question"`
	NormalizedQuestion string            `json:"normalizedQuestion"`
	QueryBigrams       []string          `json:"queryBigrams"`
	QueryTrigrams      []string          `json:"queryTrigrams"`
	Matches            []retrieval.Match `json:"matches"`
	Plan               recallDebugPlan   `json:"plan"`
	ContextFiles       []harness.FileRef `json:"contextFiles"`
}

type recallDebugPlan struct {
	Mode              string                                `json:"mode"`
	SelectedPlaybook  string                                `json:"selectedPlaybook,omitempty"`
	SelectedPlaybooks []sessionstate.PlaybookCandidate      `json:"selectedPlaybooks,omitempty"`
	SelectedTemplate  string                                `json:"selectedTemplate,omitempty"`
	Reason            string                                `json:"reason,omitempty"`
	Candidates        any                                   `json:"candidates,omitempty"`
	TemplateSelection dhcontext.TemplateSelectionDiagnostic `json:"templateSelection,omitempty"`
}

func runWikiRecallDebug(root string, args []string) error {
	fs := flag.NewFlagSet("wikis recall-debug", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	question := fs.String("question", "", "question")
	topN := fs.Int("top", 20, "number of matches to print; 0 means all")
	jsonOut := fs.Bool("json", false, "print json")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("recall-debug does not accept positional arguments")
	}
	if *question == "" {
		return fmt.Errorf("recall-debug requires --question")
	}
	if *topN < 0 {
		return fmt.Errorf("--top must be >= 0")
	}
	index, err := wikis.LoadRuntimeIndex(root)
	if err != nil {
		return err
	}
	response, plan, err := dhcontext.BuildWithRuntimeIndex(root, *question, index)
	if err != nil {
		return err
	}
	normalizedQuestion := retrieval.NormalizeChinese(*question)
	result := recallDebugResult{
		Question:           *question,
		NormalizedQuestion: normalizedQuestion,
		QueryBigrams:       retrieval.Ngrams(normalizedQuestion, 2),
		QueryTrigrams:      retrieval.Ngrams(normalizedQuestion, 3),
		Matches:            dhcontext.RecallMatches(index, *question, *topN),
		Plan:               recallDebugPlanFromWikiPlan(plan),
		ContextFiles:       response.ContextFiles,
	}
	if *jsonOut {
		return printJSON(result)
	}
	printRecallDebug(result)
	return nil
}

func recallDebugPlanFromWikiPlan(plan dhcontext.WikiPlan) recallDebugPlan {
	var candidates any
	if len(plan.Candidates) > 0 {
		candidates = plan.Candidates
	}
	return recallDebugPlan{
		Mode:              plan.Mode,
		SelectedPlaybook:  plan.SelectedPlaybook,
		SelectedPlaybooks: plan.SelectedPlaybooks,
		SelectedTemplate:  plan.SelectedTemplate,
		Reason:            plan.Reason,
		Candidates:        candidates,
		TemplateSelection: plan.TemplateSelection,
	}
}

func printRecallDebug(result recallDebugResult) {
	fmt.Printf("question: %s\n", result.Question)
	fmt.Printf("normalizedQuestion: %s\n", result.NormalizedQuestion)
	fmt.Printf("queryBigrams: %s\n", strings.Join(result.QueryBigrams, ", "))
	fmt.Printf("queryTrigrams: %s\n", strings.Join(result.QueryTrigrams, ", "))
	fmt.Println()
	if len(result.Matches) == 0 {
		fmt.Println("top matches: none")
	} else {
		fmt.Println("top matches:")
		for i, match := range result.Matches {
			fmt.Printf("%d.\t%.2f\t%s\t%s\t%s\n", i+1, match.Score, match.MatchType, match.Term, match.TargetPath)
			fmt.Printf("\tbigrams=%s trigrams=%s\n", strings.Join(match.MatchedBigrams, ", "), strings.Join(match.MatchedTrigrams, ", "))
		}
	}
	fmt.Println()
	fmt.Println("final plan:")
	fmt.Printf("mode=%s\n", result.Plan.Mode)
	if result.Plan.SelectedPlaybook != "" {
		fmt.Printf("selectedPlaybook=%s\n", result.Plan.SelectedPlaybook)
	}
	if len(result.Plan.SelectedPlaybooks) > 0 {
		var paths []string
		for _, playbook := range result.Plan.SelectedPlaybooks {
			paths = append(paths, playbook.Path)
		}
		fmt.Printf("selectedPlaybooks=%s\n", strings.Join(paths, ", "))
	}
	if result.Plan.SelectedTemplate != "" {
		fmt.Printf("selectedTemplate=%s\n", result.Plan.SelectedTemplate)
	}
	if result.Plan.Reason != "" {
		fmt.Printf("reason=%s\n", result.Plan.Reason)
	}
	if result.Plan.TemplateSelection.Status != "" {
		fmt.Printf("templateSelection=%s reason=%s\n", result.Plan.TemplateSelection.Status, result.Plan.TemplateSelection.Reason)
		for _, candidate := range result.Plan.TemplateSelection.Candidates {
			fmt.Printf("templateCandidate score=%d priority=%d template=%s playbook=%s covers=%s intents=%s\n", candidate.Score, candidate.Priority, candidate.Template, candidate.Playbook, strings.Join(candidate.MatchedCovers, ","), strings.Join(candidate.MatchedIntents, ","))
		}
	}
	fmt.Println("contextFiles:")
	for _, ref := range result.ContextFiles {
		fmt.Printf("%s\t%s\n", ref.Path, ref.Reason)
	}
}

func printTemplatesDoctor(result wikis.TemplateDoctorResult) {
	fmt.Printf("templates doctor: %s\n", result.Status)
	fmt.Printf("selection: %s\n", result.SelectionPath)
	fmt.Printf("rules: %d\n", len(result.Rules))
	for _, err := range result.Errors {
		fmt.Printf("FAIL\t%s\n", err)
	}
	for _, warning := range result.Warnings {
		fmt.Printf("WARN\t%s\n", warning)
	}
	if len(result.Suggestions) > 0 {
		fmt.Printf("suggestions: %d\n", len(result.Suggestions))
		for _, rule := range result.Suggestions {
			fmt.Printf("suggest\t%s\t%s\t%s\n", rule.ID, rule.Playbook, rule.Template)
		}
	}
	if result.SuggestionWritten {
		fmt.Printf("wrote %s\n", result.SuggestionPath)
	}
}

func printTemplatesSelectDebug(result recallDebugResult) {
	fmt.Printf("question: %s\n", result.Question)
	fmt.Printf("mode: %s\n", result.Plan.Mode)
	if result.Plan.SelectedPlaybook != "" {
		fmt.Printf("selectedPlaybook: %s\n", result.Plan.SelectedPlaybook)
	}
	if result.Plan.SelectedTemplate != "" {
		fmt.Printf("selectedTemplate: %s\n", result.Plan.SelectedTemplate)
	}
	selection := result.Plan.TemplateSelection
	if selection.Status == "" {
		fmt.Println("templateSelection: none")
	} else {
		fmt.Printf("templateSelection: %s reason=%s\n", selection.Status, selection.Reason)
	}
	for _, candidate := range selection.Candidates {
		fmt.Printf("candidate score=%d priority=%d template=%s playbook=%s covers=%s intents=%s\n", candidate.Score, candidate.Priority, candidate.Template, candidate.Playbook, strings.Join(candidate.MatchedCovers, ","), strings.Join(candidate.MatchedIntents, ","))
	}
	fmt.Println("contextFiles:")
	for _, ref := range result.ContextFiles {
		fmt.Printf("%s\t%s\n", ref.Path, ref.Reason)
	}
}

func runSingleWikiCheck(root, name string, args []string) (wikis.CheckResult, error) {
	fs := flag.NewFlagSet("wikis "+name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "print json")
	maxErrors := fs.Int("max-errors", 100, "maximum errors to print")
	failFast := fs.Bool("fail-fast", false, "stop after first failing check")
	if err := fs.Parse(args); err != nil {
		return wikis.CheckResult{}, err
	}
	if fs.NArg() != 0 {
		return wikis.CheckResult{}, fmt.Errorf("%s does not accept positional arguments", name)
	}
	result, err := wikis.RunCheck(root, name, wikis.CheckOptions{MaxErrors: *maxErrors, FailFast: *failFast})
	if err != nil {
		return wikis.CheckResult{}, err
	}
	if *jsonOut {
		return result, printJSON(checkJSONEnvelope([]wikis.CheckResult{result}))
	}
	printCheckResult(result)
	return result, nil
}

func runWikiCheckAll(root string, args []string) ([]wikis.CheckResult, error) {
	fs := flag.NewFlagSet("wikis check-all", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	jsonOut := fs.Bool("json", false, "print json")
	maxErrors := fs.Int("max-errors", 500, "maximum errors to print per check-all")
	failFast := fs.Bool("fail-fast", false, "stop after first failing check")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() != 0 {
		return nil, fmt.Errorf("check-all does not accept positional arguments")
	}
	results, err := wikis.RunAllChecks(root, wikis.CheckOptions{MaxErrors: *maxErrors, FailFast: *failFast})
	if err != nil {
		return nil, err
	}
	if *jsonOut {
		return results, printJSON(checkJSONEnvelope(results))
	}
	for _, result := range results {
		printCheckResult(result)
	}
	return results, nil
}

type checkOutput struct {
	OK          bool                `json:"ok"`
	TotalErrors int                 `json:"totalErrors"`
	Results     []wikis.CheckResult `json:"results"`
}

func checkJSONEnvelope(results []wikis.CheckResult) checkOutput {
	return checkOutput{
		OK:          checkResultsOK(results),
		TotalErrors: totalCheckErrors(results),
		Results:     results,
	}
}

func checkResultsOK(results []wikis.CheckResult) bool {
	return totalCheckErrors(results) == 0
}

func totalCheckErrors(results []wikis.CheckResult) int {
	total := 0
	for _, result := range results {
		total += result.TotalErrors
	}
	return total
}

func makeCLICheckResult(name string, errs []wikis.CheckError, opts wikis.CheckOptions) wikis.CheckResult {
	limit := opts.MaxErrors
	if limit <= 0 {
		limit = 100
	}
	shown := errs
	if len(shown) > limit {
		shown = shown[:limit]
	}
	if shown == nil {
		shown = []wikis.CheckError{}
	}
	return wikis.CheckResult{
		Check:        name,
		OK:           len(errs) == 0,
		TotalErrors:  len(errs),
		ShownErrors:  len(shown),
		HiddenErrors: len(errs) - len(shown),
		Truncated:    len(errs) > len(shown),
		Errors:       shown,
	}
}

func printCheckResult(result wikis.CheckResult) {
	if result.TotalErrors == 0 {
		fmt.Printf("%s ok\n", result.Check)
		return
	}
	fmt.Printf("%s failed: total=%d shown=%d hidden=%d truncated=%v\n", result.Check, result.TotalErrors, result.ShownErrors, result.HiddenErrors, result.Truncated)
	for _, err := range result.Errors {
		fmt.Printf("%s\t%s\t%s", err.Path, err.Code, err.Message)
		if err.Target != "" {
			fmt.Printf("\ttarget=%s", err.Target)
		}
		if err.Value != "" {
			fmt.Printf("\tvalue=%s", err.Value)
		}
		if err.Other != "" {
			fmt.Printf("\tother=%s", err.Other)
		}
		fmt.Println()
	}
}

func printAliasesLint(result wikis.AliasesLintResult) {
	for _, issue := range result.Errors {
		fmt.Printf("ERROR %s", issue.Code)
		printAliasesIssue(issue)
	}
	for _, issue := range result.Warnings {
		fmt.Printf("WARN %s", issue.Code)
		printAliasesIssue(issue)
	}
	if len(result.Errors) == 0 && len(result.Warnings) == 0 {
		fmt.Println("aliases lint ok")
	}
}

func printMetricDuplicatesReport(report wikis.MetricDuplicatesReport) {
	fmt.Printf("metric files scanned: %d\n", report.MetricFilesScanned)
	fmt.Printf("duplicate label groups: %d\n", report.DuplicateLabelGroups)
	fmt.Printf("duplicate chinese name groups: %d\n", report.DuplicateChineseGroups)
	fmt.Printf("duplicate code groups: %d\n", report.DuplicateCodeGroups)
	fmt.Printf("duplicate name groups: %d\n", report.DuplicateNameGroups)
	fmt.Printf("duplicate basename groups: %d\n", report.DuplicateBasenameGroups)
	fmt.Printf("cross-system duplicate groups: %d\n", report.CrossSystemGroups)
	fmt.Println()
	for _, group := range report.Groups {
		if group.Severity == "error" {
			fmt.Printf("ERROR cross-system duplicate:\n")
		} else {
			fmt.Printf("WARN duplicate %s:\n", group.MatchType)
		}
		if group.Label != "" {
			fmt.Printf("  label: %s\n", group.Label)
		}
		if group.Value != "" && group.Value != group.Label {
			fmt.Printf("  value: %s\n", group.Value)
		}
		fmt.Println("  files:")
		for _, file := range group.Files {
			fmt.Printf("    - %s\n", file.Path)
		}
		fmt.Println()
	}
}

func printMetricDuplicatesLint(result wikis.MetricDuplicatesLintResult) {
	for _, issue := range result.Errors {
		fmt.Printf("ERROR %s", issue.Code)
		printMetricDuplicatesIssue(issue)
	}
	for _, issue := range result.Warnings {
		fmt.Printf("WARN %s", issue.Code)
		printMetricDuplicatesIssue(issue)
	}
	if len(result.Errors) == 0 && len(result.Warnings) == 0 {
		fmt.Println("metric-duplicates lint ok")
	}
}

func printMetricDuplicatesIssue(issue wikis.MetricDuplicatesLintIssue) {
	if issue.Group != "" {
		fmt.Printf("\tgroup=%s", issue.Group)
	}
	if issue.Field != "" {
		fmt.Printf("\tfield=%s", issue.Field)
	}
	if issue.Value != "" {
		fmt.Printf("\tvalue=%s", issue.Value)
	}
	fmt.Printf("\t%s\n", issue.Message)
}

func printMetricDuplicatesImport(result wikis.MetricDuplicatesImportResult) {
	if len(result.Lint.Errors) > 0 {
		printMetricDuplicatesLint(result.Lint)
		return
	}
	if result.Applied {
		fmt.Println("APPLIED")
		fmt.Println()
		fmt.Printf("groups applied: %d\n", result.GroupsScanned)
		fmt.Printf("updated files: %d\n", result.FilesToUpdate)
		fmt.Printf("canonical marks: %d\n", result.CanonicalMarks)
		fmt.Printf("deprecated marks: %d\n", result.DeprecatedMarks)
		fmt.Printf("merge_later marks: %d\n", result.MergeLaterMarks)
		return
	}
	fmt.Println("DRY RUN")
	fmt.Println()
	for _, change := range result.Changes {
		fmt.Printf("GROUP %s\n", change.Group)
		fmt.Printf("  update:\n")
		fmt.Printf("    %s\n", change.Path)
		for _, key := range []string{"canonical_status", "canonical_group", "canonical_target", "canonical_reason"} {
			if value := change.Fields[key]; value != "" {
				fmt.Printf("      %s: %s\n", key, value)
			}
		}
		fmt.Println()
	}
	fmt.Println("SUMMARY")
	fmt.Printf("  groups scanned: %d\n", result.GroupsScanned)
	fmt.Printf("  files to update: %d\n", result.FilesToUpdate)
	fmt.Printf("  canonical marks: %d\n", result.CanonicalMarks)
	fmt.Printf("  deprecated marks: %d\n", result.DeprecatedMarks)
	fmt.Printf("  merge_later marks: %d\n", result.MergeLaterMarks)
	fmt.Println()
	fmt.Println("No files were changed. Re-run with --apply to write changes.")
}

func printAliasesIssue(issue wikis.AliasesLintIssue) {
	if issue.Item != "" {
		fmt.Printf("\titem=%s", issue.Item)
	}
	if issue.Field != "" {
		fmt.Printf("\tfield=%s", issue.Field)
	}
	if issue.Value != "" {
		fmt.Printf("\tvalue=%s", issue.Value)
	}
	fmt.Printf("\t%s\n", issue.Message)
}

func printAliasesImport(result wikis.AliasesImportResult) {
	if len(result.Lint.Errors) > 0 {
		printAliasesLint(result.Lint)
		return
	}
	if result.Applied {
		fmt.Println("APPLIED")
		fmt.Println()
		fmt.Printf("updated files: %d\n", result.FilesToUpdate)
		fmt.Printf("aliases added: %d\n", result.AliasesAdded)
		fmt.Printf("negative_aliases added: %d\n", result.NegativeAliasesAdded)
		return
	}
	fmt.Println("DRY RUN")
	fmt.Println()
	for _, change := range result.Changes {
		fmt.Printf("UPDATE %s\n", change.Path)
		printAliasDiff("aliases", change.AliasesAdded, change.AliasesRemoved)
		printAliasDiff("negative_aliases", change.NegativeAliasesAdded, change.NegativeAliasesRemoved)
		fmt.Println()
	}
	fmt.Println("SUMMARY")
	fmt.Printf("  files scanned: %d\n", result.FilesScanned)
	fmt.Printf("  files to update: %d\n", result.FilesToUpdate)
	fmt.Printf("  aliases added: %d\n", result.AliasesAdded)
	fmt.Printf("  negative_aliases added: %d\n", result.NegativeAliasesAdded)
	fmt.Println()
	fmt.Println("No files were changed. Re-run with --apply to write changes.")
}

func printAliasDiff(name string, added, removed []string) {
	if len(added) == 0 && len(removed) == 0 {
		return
	}
	fmt.Printf("  %s:\n", name)
	for _, value := range added {
		fmt.Printf("    + %s\n", value)
	}
	for _, value := range removed {
		fmt.Printf("    - %s\n", value)
	}
}

func splitCSV(value string) []string {
	var out []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func rootStart() string {
	if projectDir := os.Getenv("CLAUDE_PROJECT_DIR"); projectDir != "" {
		return projectDir
	}
	return "."
}

func normalizeArgs(args []string, jsonOut *bool) []string {
	var out []string
	for _, arg := range args {
		if arg == "--json" {
			*jsonOut = true
			continue
		}
		out = append(out, arg)
	}
	return out
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func printCompactJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}
