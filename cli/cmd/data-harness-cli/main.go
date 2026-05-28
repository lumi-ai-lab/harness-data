package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	dhcontext "harness-data/cli/internal/context"
	"harness-data/cli/internal/harness"
	idx "harness-data/cli/internal/index"
	"harness-data/cli/internal/posttool"
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
		return fmt.Errorf("usage: data-harness-cli <wikis|context|inject-template|posttool|show>")
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
		format := fs.String("format", "text", "output format: text, json, or claude-hook")
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
		case "claude-hook":
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
		format := fs.String("format", "claude-hook", "output format: claude-hook")
		_ = fs.Parse(os.Args[2:])
		if *format != "claude-hook" {
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
		sessionID := os.Getenv("CLAUDE_SESSION_ID")
		if sessionID == "" {
			sessionID = "unknown"
		}
		message, _, _, err := posttool.InjectTemplate(root, sessionID)
		if err != nil {
			return err
		}
		fmt.Print(message)
		if !strings.HasSuffix(message, "\n") {
			fmt.Println()
		}
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

func runWikis(root string, args []string) error {
	if len(args) < 1 {
		return exitCodeError{Code: 2, Err: fmt.Errorf("usage: data-harness-cli wikis <check-index-md|check-titles|check-frontmatter|check-aliases|check-covers|check-links|check-all|build-index>")}
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
	default:
		return exitCodeError{Code: 2, Err: fmt.Errorf("unknown wikis command: %s", args[0])}
	}
	return nil
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
		return result, printJSON(result)
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
		return results, printJSON(map[string]any{"ok": checkResultsOK(results), "results": results, "totalErrors": totalCheckErrors(results)})
	}
	for _, result := range results {
		printCheckResult(result)
	}
	return results, nil
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
