---
description: Use QDM Harness context, playbooks, templates, and data CLI constraints for QDM analysis in WorkBuddy.
---

# QDM Harness for WorkBuddy

Use this skill together with the QDM Harness WorkBuddy hooks.

- Run commands from the Harness runtime workspace root.
- Read every `contextFiles` path injected by `UserPromptSubmit` before running data commands.
- On Windows WorkBuddy, use the Bash tool for `qdm-metric-cli auth describe` and `qdm-metric-cli analysis execute`; run them from the runtime root with a Bash path such as `./bin/qdm-metric-cli.exe` or `$QDM_METRIC_CLI` after `source config/qdm-cli-paths.env`.
- Do not run those gated QDM commands with the PowerShell tool. WorkBuddy 5.3.8's PowerShell sandbox does not return their stdout/stderr. If the hook reports `QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED`, retry once with the Bash tool and otherwise keep the command unchanged.
- Use only `qdm-metric-cli` for data queries. Do not call `qdm-cmr-cli`, `qdm-indicators-cli`, `qdm-sql-cli`, or `cas-cli`.
- Numeric values, rankings, comparisons, and thresholds must come from CLI output.
- Do not estimate missing values, fabricate evidence, or replace missing data with examples.
- Do not add, override, print, or persist `--data-auth`, `--auth-blob`, or `--auth-json`; the `PreToolUse` hook owns authorization injection.
- Do not call `data-harness-cli authz-exec` directly; it is an internal trusted broker that may only be introduced by `PreToolUse`.
- If `PreToolUse` denies a command, stop the data flow. Do not read authorization fixtures, retry with model-supplied credentials, or bypass the hook.
- When the user asks for current account data permissions or scopes, run `qdm-metric-cli auth describe`; permission claims must come only from that command's output.
- Deliver analysis, query results, reports, summaries, and diagnostic conclusions in the current conversation by default.
- Do not write final or intermediate results to files unless the user explicitly asks to export, save, or generate a file.
- Never read, open, guess, or use a template file directly. A selected template is valid only when the `PostToolUse` hook injects it after `bin/data-harness-cli stage template` or `inject-template` (Windows PowerShell: `.\\bin\\data-harness-cli.exe stage template`).
- If a hook reports `QDM_HARNESS_UNAVAILABLE` or `QDM_HARNESS_BLOCKED`, do not continue with data queries or guessed conclusions.
