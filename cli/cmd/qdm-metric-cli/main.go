package main

import (
	"fmt"
	"os"

	"harness-data/cli/internal/metriccli"
)

func main() {
	if err := metriccli.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(metriccli.ExitCode(err))
	}
}
