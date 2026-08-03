package metriccli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"harness-data/cli/internal/authz"
)

const (
	DefaultBrokerSocketPath     = "/run/harness-data/qdm-metric-cli.sock"
	brokerProtocolVersion       = 1
	maxBrokerRequestBytes       = 128 << 20
	maxBrokerStdinBytes         = 16 << 20
	maxBrokerArguments          = 256
	maxBrokerArgumentBytes      = maxPayloadBytes
	maxBrokerArgumentTotalBytes = maxPayloadBytes + (1 << 20)
	maxBrokerBindingBytes       = 16 << 10
	maxBrokerConcurrentRequests = 8
)

type brokerRequest struct {
	Version   int      `json:"version"`
	Operation string   `json:"operation"`
	Args      []string `json:"args,omitempty"`
	Binding   string   `json:"binding,omitempty"`
	Stdin     []byte   `json:"stdin,omitempty"`
}

type brokerResponse struct {
	Version  int    `json:"version"`
	ExitCode int    `json:"exitCode"`
	Stdout   []byte `json:"stdout,omitempty"`
	Stderr   []byte `json:"stderr,omitempty"`
	Message  string `json:"message,omitempty"`
}

type brokerOptions struct {
	expectedServiceUID *uint32
}

// RunClient submits one authorized invocation to the trusted local broker.
// The public Agent process never opens the authorization config or private CLI.
func RunClient(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	return runClientWithSocket(DefaultBrokerSocketPath, "execute", args, stdin, stdout, stderr)
}

// CheckBroker verifies that the trusted local broker is accepting requests and
// can still validate its protected runtime artifacts.
func CheckBroker(stdout, stderr io.Writer) error {
	return runClientWithSocket(DefaultBrokerSocketPath, "health", nil, strings.NewReader(""), stdout, stderr)
}

func runClientWithSocket(
	socketPath string,
	operation string,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) error {
	input, err := readBoundedInput(stdin, maxBrokerStdinBytes)
	if err != nil {
		return &ExitError{Code: 77, Err: err}
	}
	forwardedArgs := append([]string(nil), args...)
	if operation == "execute" {
		forwardedArgs, err = inlineClientPayloadFile(forwardedArgs)
		if err != nil {
			return &ExitError{Code: 77, Err: err}
		}
	}
	request := brokerRequest{
		Version:   brokerProtocolVersion,
		Operation: operation,
		Args:      forwardedArgs,
		Stdin:     input,
	}
	if operation == "execute" {
		request.Binding = strings.TrimSpace(os.Getenv(bindingEnvironment))
	}
	if err := validateBrokerRequest(request); err != nil {
		return &ExitError{Code: 77, Err: err}
	}
	encodedRequest, err := json.Marshal(request)
	if err != nil {
		return &ExitError{Code: 77, Err: fmt.Errorf("qdm-metric-cli broker request is invalid: %w", err)}
	}
	encodedRequest = append(encodedRequest, '\n')
	if len(encodedRequest) > maxBrokerRequestBytes {
		return &ExitError{Code: 77, Err: errors.New("qdm-metric-cli broker request exceeds its limit")}
	}

	dialer := net.Dialer{Timeout: 3 * time.Second}
	connection, err := dialer.Dial("unix", socketPath)
	if err != nil {
		return &ExitError{Code: 77, Err: fmt.Errorf("qdm-metric-cli broker is unavailable: %w", err)}
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(10 * time.Minute))

	written, err := connection.Write(encodedRequest)
	if err == nil && written != len(encodedRequest) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return &ExitError{Code: 77, Err: fmt.Errorf("qdm-metric-cli broker request failed: %w", err)}
	}
	if unixConnection, ok := connection.(*net.UnixConn); ok {
		_ = unixConnection.CloseWrite()
	}

	var response brokerResponse
	if err := decodeBrokerMessage(connection, (2<<30)+maxBrokerRequestBytes, &response); err != nil {
		return &ExitError{Code: 77, Err: fmt.Errorf("qdm-metric-cli broker response is invalid: %w", err)}
	}
	if response.Version != brokerProtocolVersion || response.ExitCode < 0 || response.ExitCode > 255 {
		return &ExitError{Code: 77, Err: errors.New("qdm-metric-cli broker response is invalid")}
	}
	if len(response.Stdout) > 0 {
		if _, err := stdout.Write(response.Stdout); err != nil {
			return err
		}
	}
	if len(response.Stderr) > 0 {
		if _, err := stderr.Write(response.Stderr); err != nil {
			return err
		}
	}
	if response.ExitCode == 0 {
		return nil
	}
	message := strings.TrimSpace(response.Message)
	if message == "" {
		message = fmt.Sprintf("qdm-metric-cli broker exited with status %d", response.ExitCode)
	}
	return &ExitError{Code: response.ExitCode, Err: errors.New(message)}
}

func readBoundedInput(input io.Reader, limit int64) ([]byte, error) {
	if input == nil {
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(input, limit+1))
	if err != nil {
		return nil, fmt.Errorf("qdm-metric-cli stdin cannot be read: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, errors.New("qdm-metric-cli stdin exceeds the broker limit")
	}
	return data, nil
}

func decodeBrokerMessage(input io.Reader, limit int64, target any) error {
	limited := &io.LimitedReader{R: input, N: limit + 1}
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("qdm-metric-cli broker message contains multiple JSON values")
		}
		return err
	}
	if limited.N == 0 {
		return errors.New("qdm-metric-cli broker message exceeds its limit")
	}
	return nil
}

func validateBrokerRequest(request brokerRequest) error {
	if request.Version != brokerProtocolVersion {
		return errors.New("qdm-metric-cli broker protocol version is unsupported")
	}
	switch request.Operation {
	case "health":
		if len(request.Args) != 0 || request.Binding != "" || len(request.Stdin) != 0 {
			return errors.New("qdm-metric-cli broker health request is invalid")
		}
	case "execute":
		if len(request.Args) > maxBrokerArguments {
			return errors.New("qdm-metric-cli broker received too many arguments")
		}
		if len(request.Binding) > maxBrokerBindingBytes {
			return errors.New("qdm-metric-cli broker binding exceeds its limit")
		}
		totalArgumentBytes := 0
		for _, argument := range request.Args {
			if len(argument) > maxBrokerArgumentBytes || strings.ContainsRune(argument, 0) {
				return errors.New("qdm-metric-cli broker received an invalid argument")
			}
			totalArgumentBytes += len(argument)
			if totalArgumentBytes > maxBrokerArgumentTotalBytes {
				return errors.New("qdm-metric-cli broker arguments exceed their limit")
			}
		}
		if containsPayloadFileArgument(request.Args) {
			return errors.New("qdm-metric-cli broker requires file payloads to be inlined by the public client")
		}
		if len(request.Stdin) > maxBrokerStdinBytes {
			return errors.New("qdm-metric-cli broker stdin exceeds its limit")
		}
	default:
		return errors.New("qdm-metric-cli broker operation is unsupported")
	}
	return nil
}

func inlineClientPayloadFile(args []string) ([]string, error) {
	payloadIndex := -1
	payloadValueIndex := -1
	payloadPath := ""
	payloadJSONPresent := false
	for index := 0; index < len(args); index++ {
		argument := args[index]
		switch {
		case argument == "--payload":
			if payloadIndex >= 0 {
				return nil, errors.New("analysis payload file may be specified only once")
			}
			if index+1 >= len(args) {
				return nil, errors.New("--payload requires a value")
			}
			payloadIndex = index
			payloadValueIndex = index + 1
			payloadPath = args[index+1]
			index++
		case strings.HasPrefix(argument, "--payload="):
			if payloadIndex >= 0 {
				return nil, errors.New("analysis payload file may be specified only once")
			}
			payloadIndex = index
			payloadValueIndex = index
			payloadPath = strings.TrimPrefix(argument, "--payload=")
		case argument == "--payload-json" || strings.HasPrefix(argument, "--payload-json="):
			payloadJSONPresent = true
			if argument == "--payload-json" && index+1 < len(args) {
				index++
			}
		}
	}
	if payloadIndex < 0 {
		return args, nil
	}
	if payloadJSONPresent {
		return nil, errors.New("analysis payload input cannot be combined")
	}
	if payloadPath == "" {
		return nil, errors.New("--payload requires a non-empty file path")
	}
	file, err := os.Open(filepath.Clean(payloadPath))
	if err != nil {
		return nil, fmt.Errorf("analysis payload cannot be read by the Agent: %w", err)
	}
	defer file.Close()
	raw, err := readBoundedInput(file, maxPayloadBytes)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, errors.New("analysis payload is empty")
	}

	result := make([]string, 0, len(args)+1)
	for index := 0; index < len(args); index++ {
		if index == payloadIndex {
			result = append(result, "--payload-json", string(raw))
			if payloadValueIndex == payloadIndex+1 {
				index++
			}
			continue
		}
		result = append(result, args[index])
	}
	return result, nil
}

func containsPayloadFileArgument(args []string) bool {
	for _, argument := range args {
		if argument == "--payload" || strings.HasPrefix(argument, "--payload=") {
			return true
		}
	}
	return false
}

// ServeBroker runs the root-owned Unix-socket authorization broker.
func ServeBroker() error {
	return serveBroker(authz.DefaultConfigPath, DefaultBrokerSocketPath, brokerOptions{})
}

func serveBroker(configPath, socketPath string, options brokerOptions) error {
	expectedServiceUID := uint32(0)
	if options.expectedServiceUID != nil {
		expectedServiceUID = *options.expectedServiceUID
	}
	if currentEffectiveUID() != expectedServiceUID {
		return fmt.Errorf("qdm-metric-cli broker must run as UID %d", expectedServiceUID)
	}
	if err := verifyBrokerRuntime(configPath, expectedServiceUID); err != nil {
		return err
	}
	if err := prepareBrokerSocketDirectory(socketPath, expectedServiceUID); err != nil {
		return err
	}
	config, err := authz.LoadConfig(configPath)
	if err != nil {
		return err
	}
	if info, err := os.Lstat(socketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return errors.New("qdm-metric-cli broker socket path is occupied by a non-socket")
		}
		if err := os.Remove(socketPath); err != nil {
			return fmt.Errorf("qdm-metric-cli broker stale socket cannot be removed: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		return fmt.Errorf("qdm-metric-cli broker cannot listen: %w", err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	if err := os.Chown(socketPath, int(*config.AgentUID), -1); err != nil {
		return fmt.Errorf("qdm-metric-cli broker socket owner cannot be set: %w", err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		return fmt.Errorf("qdm-metric-cli broker socket permissions cannot be set: %w", err)
	}

	requestSlots := make(chan struct{}, maxBrokerConcurrentRequests)
	for {
		connection, err := listener.AcceptUnix()
		if err != nil {
			return fmt.Errorf("qdm-metric-cli broker accept failed: %w", err)
		}
		if !tryAcquireBrokerRequest(requestSlots) {
			_ = connection.Close()
			continue
		}
		go func() {
			defer releaseBrokerRequest(requestSlots)
			handleBrokerConnection(configPath, connection, expectedServiceUID)
		}()
	}
}

func tryAcquireBrokerRequest(slots chan struct{}) bool {
	select {
	case slots <- struct{}{}:
		return true
	default:
		return false
	}
}

func releaseBrokerRequest(slots chan struct{}) {
	<-slots
}

func verifyBrokerRuntime(configPath string, expectedServiceUID uint32) error {
	owner := expectedServiceUID
	security := authz.FileSecurityOptions{ExpectedOwnerUID: &owner}
	if err := authz.VerifySecureRegularFile(configPath, security); err != nil {
		return fmt.Errorf("qdm-metric-cli broker authorization config is insecure: %w", err)
	}
	config, err := authz.LoadConfig(configPath)
	if err != nil {
		return err
	}
	readerSecurity := authz.FileSecurityOptions{
		ExpectedOwnerUID: &owner,
		ExpectedGroupGID: config.RequesterContextReaderGID,
		ExpectedMode:     0o640,
	}
	if err := authz.VerifySecureRegularFile(configPath, readerSecurity); err != nil {
		return fmt.Errorf("qdm-metric-cli broker authorization config reader boundary is insecure: %w", err)
	}
	controlDirectorySecurity := readerSecurity
	controlDirectorySecurity.ExpectedMode = 0o710
	if err := authz.VerifySecureDirectory(filepath.Dir(config.KillSwitch.ControlPath), controlDirectorySecurity); err != nil {
		return fmt.Errorf("qdm-metric-cli broker authorization control directory is insecure: %w", err)
	}
	if err := authz.VerifySecureRegularFile(config.KillSwitch.ControlPath, readerSecurity); err != nil {
		return fmt.Errorf("qdm-metric-cli broker authorization control file is insecure: %w", err)
	}
	privateSecurity := authz.FileSecurityOptions{ExpectedOwnerUID: &owner, Private: true}
	if err := authz.VerifySecureDirectory(filepath.Dir(config.RealMetricCLI.Path), privateSecurity); err != nil {
		return fmt.Errorf("qdm-metric-cli broker private directory is insecure: %w", err)
	}
	if err := authz.VerifySecureRegularFile(config.RealMetricCLI.Path, authz.FileSecurityOptions{
		ExpectedOwnerUID:  &owner,
		RequireExecutable: true,
		Private:           true,
	}); err != nil {
		return fmt.Errorf("qdm-metric-cli broker private executable is insecure: %w", err)
	}
	if _, err := authz.VerifyArtifact(config.RealMetricCLI.Path, config.RealMetricCLI.ArtifactSHA256, true); err != nil {
		return err
	}
	return nil
}

func handleBrokerConnection(configPath string, connection *net.UnixConn, expectedServiceUID uint32) {
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))

	peerUID, err := peerEffectiveUID(connection)
	if err != nil {
		writeBrokerResponse(connection, brokerResponse{
			Version: brokerProtocolVersion, ExitCode: 77,
			Message: "qdm-metric-cli broker cannot authenticate its caller",
		})
		return
	}
	var request brokerRequest
	if err := decodeBrokerMessage(connection, maxBrokerRequestBytes, &request); err != nil {
		writeBrokerResponse(connection, brokerResponse{
			Version: brokerProtocolVersion, ExitCode: 77,
			Message: "qdm-metric-cli broker request is invalid",
		})
		return
	}
	if err := validateBrokerRequest(request); err != nil {
		writeBrokerResponse(connection, brokerResponse{
			Version: brokerProtocolVersion, ExitCode: 77, Message: err.Error(),
		})
		return
	}
	_ = connection.SetDeadline(time.Now().Add(10 * time.Minute))

	if request.Operation == "health" {
		err := verifyBrokerRuntime(configPath, expectedServiceUID)
		response := brokerResponse{Version: brokerProtocolVersion}
		if err != nil {
			response.ExitCode = 77
			response.Message = "qdm-metric-cli broker runtime is not ready"
		}
		writeBrokerResponse(connection, response)
		return
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	err = runAuthorized(
		configPath,
		request.Binding,
		&peerUID,
		request.Args,
		bytes.NewReader(request.Stdin),
		&stdout,
		&stderr,
	)
	response := brokerResponse{
		Version: brokerProtocolVersion,
		Stdout:  stdout.Bytes(),
		Stderr:  stderr.Bytes(),
	}
	if err != nil {
		response.ExitCode = ExitCode(err)
		response.Message = err.Error()
	}
	writeBrokerResponse(connection, response)
}

func writeBrokerResponse(connection net.Conn, response brokerResponse) {
	_ = connection.SetWriteDeadline(time.Now().Add(30 * time.Second))
	_ = json.NewEncoder(connection).Encode(response)
}
