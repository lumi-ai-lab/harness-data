package main

import (
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"

	"harness-data/cli/internal/authz"
)

type authzCommandErrorBody struct {
	Code    authz.Code `json:"code"`
	Message string     `json:"message"`
}

type authzCommandFailure struct {
	Ready *bool                 `json:"ready,omitempty"`
	Error authzCommandErrorBody `json:"error"`
}

type authzCatalogValidation struct {
	Valid bool `json:"valid"`
}

func runRootIndependentAuthzCommand(command string, args []string, output io.Writer) (bool, error) {
	switch command {
	case "authz-bind":
		return true, runAuthzBind(args, output)
	case "authz-readiness":
		return true, runAuthzReadiness(args, output)
	case "authz-validate-catalog":
		return true, runAuthzValidateCatalog(args, output)
	default:
		return false, nil
	}
}

func runAuthzBind(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("authz-bind", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	sessionID := flags.String("session-id", "", "raw ACP session ID")
	configPath := flags.String("config", authz.DefaultConfigPath, "authorization config path")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *sessionID == "" {
		return writeAuthzCommandFailure(output, nil, authz.CodeBindingInvalid, "authz-bind arguments are invalid")
	}
	config, err := authz.LoadConfig(*configPath)
	if err != nil {
		return writeAuthzError(output, nil, err)
	}
	result, err := authz.Bind(config, *sessionID)
	if err != nil {
		return writeAuthzError(output, nil, err)
	}
	return writeCommandJSON(output, result)
}

func runAuthzReadiness(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("authz-readiness", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", authz.DefaultConfigPath, "authorization config path")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		ready := false
		return writeAuthzCommandFailure(output, &ready, authz.CodeConfigInvalid, "authz-readiness arguments are invalid")
	}
	executable, executableErr := os.Executable()
	if executableErr != nil {
		ready := false
		return writeAuthzCommandFailure(output, &ready, authz.CodeConfigInvalid, "data-harness-cli runtime path cannot be resolved")
	}
	runtimeRoot := filepath.Dir(filepath.Dir(executable))
	report, err := authz.CheckReadiness(*configPath, authz.ReadinessOptions{RuntimeRoot: runtimeRoot})
	if err != nil {
		ready := false
		return writeAuthzError(output, &ready, err)
	}
	return writeCommandJSON(output, report)
}

func runAuthzValidateCatalog(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("authz-validate-catalog", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	catalogPath := flags.String("path", "", "approved metric catalog path")
	catalogSHA256 := flags.String("sha256", "", "approved metric catalog sha256")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *catalogPath == "" || *catalogSHA256 == "" {
		return writeAuthzCommandFailure(output, nil, authz.CodeArtifactIntegrityFailed, "authz-validate-catalog arguments are invalid")
	}
	if _, err := authz.LoadMetricCatalog(*catalogPath, *catalogSHA256); err != nil {
		return writeAuthzError(output, nil, err)
	}
	return writeCommandJSON(output, authzCatalogValidation{Valid: true})
}

func writeAuthzError(output io.Writer, ready *bool, err error) error {
	code := authz.ErrorCode(err)
	if code == "" {
		code = authz.CodeConfigInvalid
	}
	message := "authorization command failed"
	var typed *authz.Error
	if errors.As(err, &typed) && typed.Message != "" {
		message = typed.Message
	}
	return writeAuthzCommandFailure(output, ready, code, message)
}

func writeAuthzCommandFailure(output io.Writer, ready *bool, code authz.Code, message string) error {
	failure := authzCommandFailure{
		Ready: ready,
		Error: authzCommandErrorBody{Code: code, Message: message},
	}
	if err := writeCommandJSON(output, failure); err != nil {
		return err
	}
	return exitCodeError{Code: 1, Err: errors.New("authorization command failed"), Silent: true}
}

func writeCommandJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}
