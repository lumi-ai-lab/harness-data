//go:build !windows

package main

import (
	"os"
	"syscall"
	"testing"
)

func TestTerminationSignalsCoverShellAndContainerShutdown(t *testing.T) {
	want := []os.Signal{os.Interrupt, syscall.SIGHUP, syscall.SIGTERM}
	got := terminationSignals()
	for _, expected := range want {
		found := false
		for _, actual := range got {
			if actual == expected {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("termination signal %v is not handled: %v", expected, got)
		}
	}
}
