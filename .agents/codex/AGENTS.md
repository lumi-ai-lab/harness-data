# QDM Harness Agent Instructions

Read `README.md` before running QDM data commands.

- Always run from the harness-data runtime workspace root.
- Invoke `qdm-metric-cli` from the workspace `bin/` directory: `bin/qdm-metric-cli` on Linux/macOS, `bin/qdm-metric-cli.exe` on Windows. Do not rely on `source` or shell environment variables.
- Numeric values, rankings, comparisons, and thresholds must come from CLI output.
- Do not estimate missing values or replace missing data with examples.
- Deliver Harness analysis results, query results, reports, summaries, and diagnostic conclusions directly in the conversation by default.
- Do not write final results or intermediate analysis results to files unless the user explicitly asks to export, save, or generate a file.
- Do not read or use template files directly unless `bin/data-harness-cli inject-template` has been requested by the harness flow and the hook injects the template.
- Data queries use only `qdm-metric-cli`. Do not call `qdm-cmr-cli`, `qdm-indicators-cli`, `qdm-sql-cli`, or `cas-cli`.
- Do not invent or pass `--data-auth`, `--auth-blob`, or `--auth-json`; the Codex PreToolUse authz hook injects authorization for `qdm-metric-cli analysis execute` and `qdm-metric-cli auth describe`.
- When the user asks about their current data permissions or scopes, run `qdm-metric-cli auth describe`; the Codex PreToolUse authz hook supplies the required authorization.
