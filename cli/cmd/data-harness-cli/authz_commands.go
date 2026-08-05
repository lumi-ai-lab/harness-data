package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"

	"harness-data/cli/internal/authz"
	"harness-data/cli/internal/metriccli"
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
	case "authz-metric-broker":
		return true, runAuthzMetricBroker(args, output)
	case "authz-metric-broker-register":
		return true, runAuthzMetricBrokerRegister(args, output, io.LimitReader(os.Stdin, 32<<10))
	default:
		return false, nil
	}
}

func runAuthzBind(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("authz-bind", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	sessionID := flags.String("session-id", "", "raw ACP session ID")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *sessionID == "" {
		return writeAuthzCommandFailure(output, nil, authz.CodeBindingInvalid, "authz-bind arguments are invalid")
	}
	config, err := authz.RuntimeConfig()
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
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		ready := false
		return writeAuthzCommandFailure(output, &ready, authz.CodeConfigInvalid, "authz-readiness arguments are invalid")
	}
	config, err := authz.RuntimeConfig()
	if err != nil {
		ready := false
		return writeAuthzError(output, &ready, err)
	}
	if _, err := authz.LoadBundledMetricCatalog(config.ApprovedMetricCatalog.Path); err != nil {
		ready := false
		return writeAuthzError(output, &ready, err)
	}
	return writeCommandJSON(output, map[string]any{
		"ready":     true,
		"mode":      config.Mode,
		"piVersion": config.PiVersion,
	})
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

func runAuthzMetricBroker(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("authz-metric-broker", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	socket := flags.String("socket", "", "Unix socket path for authorized Metric broker")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *socket == "" {
		return writeAuthzCommandFailure(output, nil, authz.CodeConfigInvalid, "authz-metric-broker arguments are invalid")
	}
	config, err := authz.RuntimeConfig()
	if err != nil {
		return writeAuthzError(output, nil, err)
	}
	return metriccli.ServeMetricBroker(context.Background(), *socket, config)
}

type authzMetricBrokerRegisterRequest struct {
	Token            string `json:"token"`
	BindingBase64URL string `json:"bindingBase64url"`
}

func runAuthzMetricBrokerRegister(args []string, output io.Writer, input io.Reader) error {
	flags := flag.NewFlagSet("authz-metric-broker-register", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	socket := flags.String("socket", "", "Unix socket path for authorized Metric broker")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *socket == "" {
		return writeAuthzCommandFailure(output, nil, authz.CodeConfigInvalid, "authz-metric-broker-register arguments are invalid")
	}
	var request authzMetricBrokerRegisterRequest
	decoder := json.NewDecoder(input)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return writeAuthzCommandFailure(output, nil, authz.CodeBindingInvalid, "authz-metric-broker-register input is invalid")
	}
	if err := metriccli.RegisterMetricBrokerToken(*socket, request.Token, request.BindingBase64URL); err != nil {
		return writeAuthzCommandFailure(output, nil, authz.CodeConfigInvalid, err.Error())
	}
	return writeCommandJSON(output, map[string]bool{"registered": true})
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
