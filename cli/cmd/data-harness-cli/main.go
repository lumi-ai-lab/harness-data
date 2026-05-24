package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	dhcontext "harness-data/cli/internal/context"
	"harness-data/cli/internal/frontmatter"
	"harness-data/cli/internal/harness"
	idx "harness-data/cli/internal/index"
	"harness-data/cli/internal/posttool"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: data-harness-cli <build-index|context|inject-template|posttool|validate|show>")
	}
	root, err := harness.FindRoot(rootStart())
	if err != nil {
		return fmt.Errorf("cannot find harness root: %w", err)
	}
	switch os.Args[1] {
	case "build-index":
		fs := flag.NewFlagSet("build-index", flag.ExitOnError)
		jsonOut := fs.Bool("json", false, "print json")
		_ = fs.Parse(os.Args[2:])
		result, err := idx.Build(root)
		if err != nil {
			return err
		}
		if *jsonOut {
			return printJSON(result)
		}
		fmt.Println("built .harness/index/spec-index.json")
		fmt.Println("built .harness/index/routing-index.json")
		fmt.Println("built .harness/index/playbook-index.json")
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
		fmt.Println("QDM_INJECT_TEMPLATE")
	case "validate":
		fs := flag.NewFlagSet("validate", flag.ExitOnError)
		jsonOut := fs.Bool("json", false, "print json")
		_ = fs.Parse(os.Args[2:])
		docs, err := idx.AllDocuments(root)
		if err != nil {
			return err
		}
		errs := frontmatter.ValidateDocuments(root, docs)
		if *jsonOut {
			return printJSON(map[string]any{"ok": len(errs) == 0, "errors": errs})
		}
		if len(errs) > 0 {
			for _, msg := range errs {
				fmt.Println(msg)
			}
			return fmt.Errorf("validation failed")
		}
		fmt.Println("validation ok")
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
