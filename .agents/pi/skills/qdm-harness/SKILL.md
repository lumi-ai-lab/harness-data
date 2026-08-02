---
description: Use QDM Harness context, playbooks, templates, and data CLI constraints for QDM analysis questions.
---

# QDM Harness Agent Instructions

Read `README.md` before running QDM data commands.

- Always run from the harness-data runtime workspace root.
- Load the platform environment before invoking QDM data CLIs: POSIX uses `source config/qdm-cli-paths.env`; PowerShell uses `. .\config\qdm-cli-paths.ps1`.
- On Windows, translate POSIX-only command examples from Wikis: use `& $env:QDM_*` for configured CLIs and `.\bin\<name>.exe` for workspace binaries; never execute `source`, `$QDM_*`, or `./bin/...` literally.
- Numeric values, rankings, comparisons, and thresholds must come from CLI output.
- Do not estimate missing values or replace missing data with examples.
- Deliver Harness analysis results, query results, reports, summaries, and diagnostic conclusions directly in the conversation by default.
- Use appropriate Emoji in responses to make the output livelier and less rigid, while keeping the analysis professional.
- Do not write final results or intermediate analysis results to files unless the user explicitly asks to export, save, or generate a file.
- Do not read or use template files directly unless the Harness flow requests its platform-specific stage/inject command and the hook injects the template.
- When the platform environment config exposes only `QDM_INDICATORS_CLI`, the runtime is the `lumi-mvp-required` profile: use only that public Facade and never call CMR, SQL, CAS, report, raw-payload, preview/total, business-threshold, config/token, `auth`, or `update` paths. Credentials are deployment-owned and must not be refreshed by the Agent.
- In a `local-unrestricted` runtime only, an invalid CMR or Indicators token may use the configured `cas-cli` credential flow; do not start QR login from an automated hook.
