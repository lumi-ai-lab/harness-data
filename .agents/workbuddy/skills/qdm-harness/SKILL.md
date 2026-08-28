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
- Never supply or alter `--data-auth`, `--auth-blob`, or `--auth-json`; the WorkBuddy `PreToolUse` hook owns these flags. When the injected `authzMode` is `on`, the hook binds the required authorization; when it is `off`, the hook does not inject authorization flags.
- On macOS and Windows, run QDM data commands through Bash (`Bash` or a Bash-backed `execute_command`), not PowerShell. If the auth hook denies a command, stop the data flow and report the denial without exposing credential values.
- When `authzMode=on`, the runtime dynamically injects only scope dimensions applicable to the requested metric's supported dimensions and filters; it does not inject every scope dimension on every query. Obtain the account data scope (`sapArea2Id`, `dcSapArea2Id`, and `categoryLevel1Id`) from `qdm-metric-cli auth describe` before the first user-facing answer based on metric results. Cache it for the current session, disclose the applicable scope whenever reporting permission-scoped numbers, and never describe those numbers as unrestricted totals.
- When `authzMode=off`, do not call `auth describe` solely for a permission-scope notice, and do not add such a notice. When the user asks about permissions, answer only from `auth describe` output and never guess authorization scopes.
- Deliver analysis, query results, reports, summaries, and diagnostic conclusions in the current conversation by default.
- Do not write final or intermediate results to files unless the user explicitly asks to export, save, or generate a file.
- Never read, open, guess, or use a template file directly. A selected template is valid only when the `PostToolUse` hook injects it after `bin/data-harness-cli stage template` or `inject-template` (Windows PowerShell: `.\\bin\\data-harness-cli.exe stage template`).
- If a hook denies a command or reports `QDM_HARNESS_UNAVAILABLE` or `QDM_HARNESS_BLOCKED`, stop the affected data flow and briefly report the failure without quoting credential material or local credential paths.

## html-report

生成 html-report 时，遵循专门的技能 `.agents/workbuddy/skills/html-report/SKILL.md`
（默认阶段 A 打开 `qdm-metric-cli ui` 让用户搭卡保存 result.json，对齐 PI 流水线；
`--phase-a agent` 可动态切回本会话构建 result.json）。本处不再重复流程细节，避免与
专门技能分叉；命令仍从仓库根运行。
