package metriccli

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"harness-data/cli/internal/authz"
)

const (
	brokerOperationRegister = "register"
	brokerOperationExecute  = "execute"
	maxBrokerRequestBytes   = 32 << 20
)

var brokerTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)

type brokerRequest struct {
	Operation        string   `json:"operation"`
	Token            string   `json:"token"`
	BindingBase64URL string   `json:"bindingBase64url,omitempty"`
	Args             []string `json:"args,omitempty"`
	StdinBase64      string   `json:"stdinBase64,omitempty"`
}

type brokerResponse struct {
	OK           bool   `json:"ok"`
	ExitCode     int    `json:"exitCode,omitempty"`
	StdoutBase64 string `json:"stdoutBase64,omitempty"`
	StderrBase64 string `json:"stderrBase64,omitempty"`
	Error        string `json:"error,omitempty"`
}

type registeredBrokerBinding struct {
	encoded   string
	expiresAt time.Time
}

type metricBroker struct {
	config authz.Config
	mu     sync.Mutex
	tokens map[string]registeredBrokerBinding
}

// ServeMetricBroker listens on socketPath and executes authorized Metric CLI
// requests. The broker is intentionally not a raw exec proxy: every execute
// request re-validates the binding, requester context, catalog, and CLI args.
func ServeMetricBroker(ctx context.Context, socketPath string, config authz.Config) error {
	if err := validateBrokerSocketPath(socketPath); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o750); err != nil {
		return err
	}
	if err := removeStaleSocket(socketPath); err != nil {
		return err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	_ = os.Chmod(socketPath, 0o660)

	broker := &metricBroker{config: config, tokens: map[string]registeredBrokerBinding{}}
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go broker.handle(conn)
	}
}

func RegisterMetricBrokerToken(socketPath, token, encodedBinding string) error {
	response, err := roundTripBroker(socketPath, brokerRequest{
		Operation:        brokerOperationRegister,
		Token:            token,
		BindingBase64URL: encodedBinding,
	})
	if err != nil {
		return err
	}
	if !response.OK {
		if response.Error == "" {
			response.Error = "metric broker token registration failed"
		}
		return errors.New(response.Error)
	}
	return nil
}

func runViaBroker(
	ctx context.Context,
	socketPath string,
	token string,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) error {
	if stringsTrimmedEmpty(socketPath) || stringsTrimmedEmpty(token) {
		return denyCode(authz.CodeBindingMissing, "qdm-metric-cli requires a Harness broker token")
	}
	input, err := io.ReadAll(io.LimitReader(stdin, maxPayloadBytes+1))
	if err != nil {
		return err
	}
	if len(input) > maxPayloadBytes {
		return &ExitError{Code: 77, Err: errors.New("qdm-metric-cli input exceeds the authorization limit")}
	}
	response, err := roundTripBrokerWithContext(ctx, socketPath, brokerRequest{
		Operation:   brokerOperationExecute,
		Token:       token,
		Args:        append([]string(nil), args...),
		StdinBase64: base64.StdEncoding.EncodeToString(input),
	})
	if err != nil {
		return err
	}
	if response.StdoutBase64 != "" {
		data, err := base64.StdEncoding.DecodeString(response.StdoutBase64)
		if err != nil {
			return err
		}
		if _, err := stdout.Write(data); err != nil {
			return err
		}
	}
	if response.StderrBase64 != "" {
		data, err := base64.StdEncoding.DecodeString(response.StderrBase64)
		if err != nil {
			return err
		}
		if _, err := stderr.Write(data); err != nil {
			return err
		}
	}
	if response.OK && response.ExitCode == 0 && response.Error == "" {
		return nil
	}
	code := response.ExitCode
	if code == 0 {
		code = 1
	}
	message := response.Error
	if message == "" {
		message = "metric broker execution failed"
	}
	return &ExitError{Code: code, Err: errors.New(message)}
}

func (broker *metricBroker) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	var request brokerRequest
	decoder := json.NewDecoder(io.LimitReader(conn, maxBrokerRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeBrokerResponse(conn, brokerResponse{OK: false, ExitCode: 77, Error: err.Error()})
		return
	}
	switch request.Operation {
	case brokerOperationRegister:
		writeBrokerResponse(conn, broker.register(request))
	case brokerOperationExecute:
		writeBrokerResponse(conn, broker.execute(request))
	default:
		writeBrokerResponse(conn, brokerResponse{OK: false, ExitCode: 77, Error: "unsupported metric broker operation"})
	}
}

func (broker *metricBroker) register(request brokerRequest) brokerResponse {
	if !brokerTokenPattern.MatchString(request.Token) {
		return brokerResponse{OK: false, ExitCode: 77, Error: "metric broker token is invalid"}
	}
	binding, err := authz.DecodeBinding(request.BindingBase64URL)
	if err != nil {
		return brokerResponse{OK: false, ExitCode: 77, Error: deny(err).Error()}
	}
	if !time.Now().UTC().Before(binding.ExpiresAt) {
		return brokerResponse{OK: false, ExitCode: 77, Error: "metric broker binding has expired"}
	}
	broker.mu.Lock()
	defer broker.mu.Unlock()
	broker.expireLocked(time.Now().UTC())
	broker.tokens[request.Token] = registeredBrokerBinding{
		encoded:   request.BindingBase64URL,
		expiresAt: binding.ExpiresAt.UTC(),
	}
	return brokerResponse{OK: true}
}

func (broker *metricBroker) execute(request brokerRequest) brokerResponse {
	if !brokerTokenPattern.MatchString(request.Token) {
		return brokerResponse{OK: false, ExitCode: 77, Error: "metric broker token is invalid"}
	}
	broker.mu.Lock()
	broker.expireLocked(time.Now().UTC())
	registered, ok := broker.tokens[request.Token]
	delete(broker.tokens, request.Token)
	broker.mu.Unlock()
	if !ok {
		return brokerResponse{OK: false, ExitCode: 77, Error: "metric broker token is missing or already consumed"}
	}
	input, err := base64.StdEncoding.DecodeString(request.StdinBase64)
	if err != nil {
		return brokerResponse{OK: false, ExitCode: 77, Error: "metric broker stdin is invalid"}
	}
	var output bytes.Buffer
	var errorOutput bytes.Buffer
	err = runAuthorized(
		broker.config,
		registered.encoded,
		append([]string(nil), request.Args...),
		bytes.NewReader(input),
		&output,
		&errorOutput,
	)
	if err != nil {
		return brokerResponse{
			OK:           false,
			ExitCode:     ExitCode(err),
			StdoutBase64: base64.StdEncoding.EncodeToString(output.Bytes()),
			StderrBase64: base64.StdEncoding.EncodeToString(errorOutput.Bytes()),
			Error:        err.Error(),
		}
	}
	return brokerResponse{
		OK:           true,
		StdoutBase64: base64.StdEncoding.EncodeToString(output.Bytes()),
		StderrBase64: base64.StdEncoding.EncodeToString(errorOutput.Bytes()),
	}
}

func (broker *metricBroker) expireLocked(now time.Time) {
	for token, binding := range broker.tokens {
		if !now.Before(binding.expiresAt) {
			delete(broker.tokens, token)
		}
	}
}

func roundTripBroker(socketPath string, request brokerRequest) (brokerResponse, error) {
	return roundTripBrokerWithContext(context.Background(), socketPath, request)
}

func roundTripBrokerWithContext(ctx context.Context, socketPath string, request brokerRequest) (brokerResponse, error) {
	if err := validateBrokerSocketPath(socketPath); err != nil {
		return brokerResponse{}, err
	}
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return brokerResponse{}, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return brokerResponse{}, err
	}
	var response brokerResponse
	decoder := json.NewDecoder(io.LimitReader(conn, maxBrokerRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		return brokerResponse{}, err
	}
	return response, nil
}

func writeBrokerResponse(output io.Writer, response brokerResponse) {
	_ = json.NewEncoder(output).Encode(response)
}

func validateBrokerSocketPath(socketPath string) error {
	if stringsTrimmedEmpty(socketPath) {
		return errors.New("metric broker socket path is required")
	}
	clean := filepath.Clean(socketPath)
	if !filepath.IsAbs(socketPath) || clean != socketPath {
		return fmt.Errorf("metric broker socket path must be a clean absolute path: %s", socketPath)
	}
	return nil
}

func removeStaleSocket(socketPath string) error {
	info, err := os.Lstat(socketPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("metric broker socket path already exists and is not a socket: %s", socketPath)
	}
	return os.Remove(socketPath)
}

func stringsTrimmedEmpty(value string) bool {
	return value == "" || value != strings.TrimSpace(value)
}
