---
description: Use QDM Harness context, playbooks, templates, and data CLI constraints for QDM analysis questions.
---

# QDM Harness Agent Instructions

Read `README.md` before running QDM data commands.

- Always run from the harness-data repository root.
- Use `source config/qdm-cli-paths.env` before invoking QDM data CLIs from shell snippets.
- Numeric values, rankings, comparisons, and thresholds must come from CLI output.
- Do not estimate missing values or replace missing data with examples.
- Do not write report files unless the user explicitly asks for an exported file.
- Do not read or use `wikis/templates/` unless `bin/data-harness-cli inject-template` has been requested by the harness flow and the hook injects the template.
- If CMR or Indicators token is invalid, use the configured `cas-cli` credential flow; do not start QR login from an automated hook.
