package main

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) {
	return 0, errors.New("read failed")
}

func TestAuthzHookInfrastructureErrorsExitWithBlockingCode(t *testing.T) {
	tests := []struct {
		name  string
		args  []string
		input io.Reader
	}{
		{name: "invalid arguments", input: bytes.NewBuffer(nil)},
		{name: "unsupported agent", args: []string{"--agent", "unknown"}, input: bytes.NewBufferString(`{}`)},
		{name: "stdin failure", args: []string{"--agent", "claude"}, input: failingReader{}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := runAuthzHook(t.TempDir(), test.args, test.input, io.Discard)
			var exitErr exitCodeError
			if !asExitCodeError(err, &exitErr) || exitErr.Code != 2 {
				t.Fatalf("expected blocking exit code 2, got %#v", err)
			}
		})
	}
}
