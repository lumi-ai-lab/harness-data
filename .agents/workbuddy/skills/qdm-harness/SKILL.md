---
description: Use QDM Harness context, playbooks, templates, and data CLI constraints for QDM analysis in WorkBuddy.
---

# QDM Harness for WorkBuddy

Use this skill together with the QDM Harness WorkBuddy hooks.

- Run commands from the Harness runtime workspace root.
- Read every `contextFiles` path injected by `UserPromptSubmit` before running data commands.
- In Bash, use `source config/qdm-cli-paths.env` before invoking QDM data CLIs. In Windows PowerShell, do not use `source`; invoke `.\\bin\\qdm-metric-cli.exe` from the runtime root.
- Use only `qdm-metric-cli` (`$QDM_METRIC_CLI` in Bash, `.\\bin\\qdm-metric-cli.exe` in PowerShell) for data queries. Do not call `qdm-cmr-cli`, `qdm-indicators-cli`, `qdm-sql-cli`, or `cas-cli`.
- Numeric values, rankings, comparisons, and thresholds must come from CLI output.
- Do not estimate missing values, fabricate evidence, or replace missing data with examples.
- Do not invent authentication or authorization flags.
- WorkBuddy support currently requires `authz.mode=off`. If a hook reports `QDM_HARNESS_AUTHZ_UNSUPPORTED`, stop the data flow.
- Deliver analysis, query results, reports, summaries, and diagnostic conclusions in the current conversation by default.
- Do not write final or intermediate results to files unless the user explicitly asks to export, save, or generate a file.
- Never read, open, guess, or use a template file directly. A selected template is valid only when the `PostToolUse` hook injects it after `bin/data-harness-cli stage template` or `inject-template` (Windows PowerShell: `.\\bin\\data-harness-cli.exe stage template`).
- If a hook reports `QDM_HARNESS_UNAVAILABLE` or `QDM_HARNESS_BLOCKED`, do not continue with data queries or guessed conclusions.
