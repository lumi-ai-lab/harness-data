package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"harness-data/cli/internal/indicatorsfacade"
)

func main() {
	decisionID := indicatorsfacade.NewDecisionID()
	runner, dependencies, err := indicatorsfacade.LoadSystemRuntime()
	if err != nil {
		if audit, auditErr := indicatorsfacade.OpenOperationalAuditSink(); auditErr == nil {
			indicatorsfacade.AuditPreflightDeny(audit, decisionID, err)
			_ = audit.Close()
		}
		printDenied(err, decisionID)
		os.Exit(1)
	}
	dependencies.DecisionID = decisionID
	ctx, stop := signal.NotifyContext(context.Background(), terminationSignals()...)
	defer stop()
	result, err := indicatorsfacade.Run(ctx, os.Args[1:], runner, dependencies)
	if err != nil {
		printDenied(err, decisionID)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(result.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "real_cli_execution_failed: 无法返回受控查询结果 (decisionId=%s)\n", decisionID)
		os.Exit(1)
	}
}

func printDenied(err error, decisionID string) {
	code := indicatorsfacade.CodeOf(err)
	message := "请求被授权护栏拒绝"
	if facadeErr, ok := err.(*indicatorsfacade.Error); ok && facadeErr.Message != "" {
		message = facadeErr.Message
	}
	fmt.Fprintf(os.Stderr, "%s: %s (decisionId=%s)\n", code, message, decisionID)
}
