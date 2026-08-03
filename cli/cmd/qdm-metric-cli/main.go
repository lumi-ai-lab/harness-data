package main

import (
	"fmt"
	"os"

	"harness-data/cli/internal/metriccli"
)

func main() {
	var err error
	switch {
	case len(os.Args) == 2 && os.Args[1] == "broker-serve":
		err = metriccli.ServeBroker()
	case len(os.Args) == 2 && os.Args[1] == "broker-health":
		err = metriccli.CheckBroker(os.Stdout, os.Stderr)
	default:
		err = metriccli.RunClient(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(metriccli.ExitCode(err))
	}
}
