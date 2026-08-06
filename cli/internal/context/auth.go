package context

// preflightAuth previously refreshed qdm-sql-cli tokens via cas-cli.
// Both CLIs are retired; metric access uses auth-blob / data-auth only.
func preflightAuth(_ string, _ WikiPlan) []string {
	return nil
}
