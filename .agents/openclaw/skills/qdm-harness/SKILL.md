---
description: Use QDM Harness context, playbooks, templates, and data CLI constraints for QDM analysis questions.
---

# QDM Harness Agent Instructions

Read `README.md` before running QDM data commands.

- Always run from the harness-data runtime workspace root.
- Use `source config/qdm-cli-paths.env` before invoking QDM data CLIs from shell snippets.
- Prefer configured env path: `$QDM_METRIC_CLI` (do not guess bare binary names off PATH). Data queries use only `qdm-metric-cli`; do not call `qdm-cmr-cli`, `qdm-indicators-cli`, `qdm-sql-cli`, or `cas-cli`.
- For metric queries use `"$QDM_METRIC_CLI" analysis execute ...`. When authz mode is on, the runtime hook injects `--data-auth --auth-blob`; do not invent, omit, or override auth flags.
- When authz mode is on, after every successful metric query the user-facing answer MUST disclose the account data scope (manageAreaId + categoryLevel1Id) from `"$QDM_METRIC_CLI" auth describe`. `analysis execute` meta does not echo injected scope filters—do not infer "no category filter" from the command line. Cache scope in-session; do not guess. Numbers under data-auth are permission-scoped, not unrestricted totals. When authz mode is off, do not add a permission-scope notice.
- When the user asks what permissions they have, answer only from `auth describe` output (hook injects `--auth-blob` when authz is on). Do not guess manageAreaId or categoryLevel1Id scopes.
- Numeric values, rankings, comparisons, and thresholds must come from CLI output.
- Do not estimate missing values or replace missing data with examples.
- Deliver Harness analysis results, query results, reports, summaries, and diagnostic conclusions directly in the conversation by default.
- Do not write final results or intermediate analysis results to files unless the user explicitly asks to export, save, or generate a file.
- Do not read or use template files directly unless `bin/data-harness-cli inject-template` has been requested by the harness flow and the hook injects the template.
