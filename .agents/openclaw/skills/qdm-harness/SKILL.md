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
- Do not write final results or intermediate analysis results to files unless the user explicitly asks to export, save, or generate a file.
- Do not read or use template files directly unless the Harness flow requests its platform-specific stage/inject command and the hook injects the template.
- If CMR or Indicators token is invalid, use the configured `cas-cli` credential flow; do not start QR login from an automated hook.
