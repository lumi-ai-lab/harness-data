---
name: qdm-harness
description: Use the QwenPaw Shell Hook path for authorized QDM metric queries.
---

QDM data access uses QwenPaw's `execute_shell_command` tool to invoke the
trusted `qdm-metric-cli` command. The Shell Hook obtains the current requester's
authorization from Runtime MCP and rewrites only an authorized QDM command.
Never use file tools, officecli, environment variables, session history, or
user-provided authorization material to fetch QDM data or work around the Hook.
Tools beyond this path exist for non-QDM work the user explicitly requests; they
must never carry a QDM data request.

Generate one `qdm-metric-cli analysis execute` command per user query. Always use
`--measures-json`; a single metric is represented as an array containing one
Measure, and a batch is represented as one array containing all Measures. Do not
generate multiple QDM Shell calls for one batch. Keep the Measure order,
measure-level filters, shared date range, output dimensions, and top-level
filters exactly as requested and supported by the handbook.

Do not pass or probe Blob values, secret files, CLI paths, environment variables,
or authentication flags. Do not use the old `--metric` form for Shell Hook
queries. Do not estimate data, perform a second calculation across metrics, or
manually replace IDs returned by the CLI. The CLI result is authoritative.

For a permission or scope question, use `qdm_scope_summary` or the authorized
`qdm-metric-cli auth describe` Shell command. The returned scope is authoritative
only for the current inbound request.

When the QDM CLI returns `QDM_AREA_OUTSIDE_DATA_SCOPE`, state that the requested management area is outside the user's authorized data scope. When it returns `QDM_CATEGORY_OUTSIDE_DATA_SCOPE`, state that the requested product category is outside the user's authorized data scope. `QDM_FILTER_OUTSIDE_DATA_SCOPE` has no identified dimension: use only the generic scope wording and never infer area/category from the user's prompt. `QDM_*_AUTH_SCOPE_EMPTY` means the corresponding authorization scope is empty or incomplete. Do not retry identical parameters or claim that multiple dimensions failed unless the CLI explicitly reports them. For other `QDM_*` errors, do not infer "no permission" unless the code explicitly indicates authorization denial; do not reinterpret an error as empty data. After any permission, parameter-validation, or upstream error, do not repeat the exact same query in the same turn.

Distinguish permission denial, no data, invalid parameters, and upstream query
errors. Do not retry the same failed command with identical parameters.

Report mode is separate from ordinary QwenPaw Shell queries. When the injected
Harness context explicitly says `mode: report`, collect the report data through
`execute_shell_command` first, then call the plugin-owned `qdm_report_stage`
tool without arguments to inject the selected template into the current
session. The plugin resolves the report, module, template, and state root from
the current session and trusted Root Context. Never pass `report_name`,
`report_module`, stage names, template paths, workspace paths, or authorization
values. Never call
`data-harness-cli stage template` or `inject-template` through Shell, never
construct a plugin or instance-root CLI path, and never pass authorization
parameters to the report-stage tool. In `single`, `multi_single`, and `free`
mode, do not call `qdm_report_stage` and do not use templates.
