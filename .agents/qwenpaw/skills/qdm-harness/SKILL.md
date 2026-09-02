---
name: qdm-harness
description: Use the constrained QDM tools for authorized metric queries. QDM data access never goes through the shell, file tools, or officecli.
---

QDM data access uses exactly three tools: `qdm_query`, `qdm_scope_summary`, and
`get_current_time`. Never use the shell, file tools, officecli, or any other
capability to fetch QDM data, read channel authorization material, probe
credentials, or work around the three tools' authorization. Tools beyond the
three exist for non-QDM work the user explicitly requests (for example editing
Office documents with officecli in the workspace); they must never carry a QDM
data request.

`qdm_query` takes business arguments after `analysis execute`; it is not a shell or a general CLI.
Before executing the analysis, the plugin always re-reads the channel authorization and runs
`auth describe` to verify the account and `qdm.metric.query` capability. It also resolves
authorized management-area/category display names to IDs; unknown or ambiguous names fail closed.
Do not pass or probe authentication flags, Blob values, file paths, `help`, `version`, or
`health` through the QDM tools or their CLI. For ordinary metric queries, do not pass
`report_name`, `report_module`, playbook, template, or Excel/report fields; the public
`qdm_query` contract has no report arguments. A request to format or export data does not by
itself authorize a report lifecycle. Use only the ordinary query tool and return its result.

When `qdm_query` returns `QDM_AREA_OUTSIDE_DATA_SCOPE`, state that the requested management area is outside the user's authorized data scope. When it returns `QDM_CATEGORY_OUTSIDE_DATA_SCOPE`, state that the requested product category is outside the user's authorized data scope. `QDM_FILTER_OUTSIDE_DATA_SCOPE` has no identified dimension: use only the generic scope wording and never infer area/category from the user's prompt. `QDM_*_AUTH_SCOPE_EMPTY` means the corresponding authorization scope is empty or incomplete. Do not retry identical parameters or claim that multiple dimensions failed unless the tool explicitly reports them. For other `QDM_*` errors, do not infer "no permission" unless the code explicitly indicates authorization denial; do not reinterpret an error as empty data. After any permission, parameter-validation, or upstream error, do not repeat the exact same query in the same turn.

Report/template lifecycle is not part of the public QwenPaw query tool. It can only be entered
through a future trusted Harness context and must never be triggered by model-supplied fields.
