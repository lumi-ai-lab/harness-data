---
description: Use QDM Harness context, playbooks, templates, and data CLI constraints for QDM analysis questions.
---

# QDM Harness Agent Instructions

Read `README.md` before running QDM data commands.

- Always run from the harness-data runtime workspace root.
- Use `source config/qdm-cli-paths.env` before invoking QDM data CLIs from shell snippets.
- Numeric values, rankings, comparisons, and thresholds must come from CLI output.
- Do not estimate missing values or replace missing data with examples.
- Deliver Harness analysis results, query results, reports, summaries, and diagnostic conclusions directly in the conversation by default.
- Use appropriate Emoji in responses to make the output livelier and less rigid, while keeping the analysis professional.
- Do not write final results or intermediate analysis results to files unless the user explicitly asks to export, save, or generate a file.
- Do not read or use template files directly unless `bin/data-harness-cli inject-template` has been requested by the harness flow and the hook injects the template.
- When `config/qdm-cli-paths.env` exposes only `QDM_METRIC_CLI`, the runtime is the `lumi-mvp-required` profile: use only that public Facade and never call CMR, SQL, CAS, report, raw-payload, preview/total, business-threshold, config/token, `auth`, or `update` paths. Credentials are deployment-owned and must not be refreshed by the Agent.
- In a `local-unrestricted` runtime only, an invalid CMR or Indicators token may use the configured `qdm-metric-cli` credential flow; do not start QR login from an automated hook.
