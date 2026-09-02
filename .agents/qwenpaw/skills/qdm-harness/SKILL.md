---
name: qdm-harness
description: Use the constrained QDM tools for authorized metric queries.
---

Use only `qdm_query`, `qdm_scope_summary`, and `get_current_time` for QDM data.
`qdm_query` takes business arguments after `analysis execute`; it is not a shell or a general CLI.
Before executing the analysis, the plugin always re-reads the channel authorization and runs
`auth describe` to verify the account and `qdm.metric.query` capability. It also resolves
authorized management-area/category display names to IDs; unknown or ambiguous names fail closed.
Use the exact dimension codes returned by `qdm_scope_summary`: authz-v2 management-area scope is
usually `sapArea2Id` (legacy credentials may expose `manageAreaId`). Never substitute one for the
other. Reuse the same authorized dimension code in both `filters` and `agg_dims`.
Canonical metric wording: `19点前来客数` / `19 点前来客数` / `19点前客数` means
`bf19CustNum`, not the full-day `custNum`. Treat the common typo `时段折损率` as
`时段折扣率`, metric code `hourDiscountRate`. Both metrics support `SUMMARY`
and store-day average (`SALES_STORE_DAY_AVG`); `bf19CustNum` defaults to
store-day average and `hourDiscountRate` defaults to `SUMMARY`, unless the user
explicitly asks for a different supported policy. Do not claim either metric
is unsupported.
Do not provide, request, or probe authentication flags, Blob values, file paths, `help`, `version`, or `health`.
For ordinary metric queries, do not pass `report_name`, `report_module`, playbook,
template, or Excel/report fields; the public `qdm_query` contract has no report
arguments. A request to format or export data does not by itself authorize a
report lifecycle. Use only the ordinary query tool and return its result.

When `qdm_query` returns `QDM_AREA_OUTSIDE_DATA_SCOPE`, state that the requested management area is outside the user's authorized data scope. When it returns `QDM_CATEGORY_OUTSIDE_DATA_SCOPE`, state that the requested product category is outside the user's authorized data scope. `QDM_FILTER_OUTSIDE_DATA_SCOPE` has no identified dimension: use only the generic scope wording and never infer area/category from the user's prompt. `QDM_*_AUTH_SCOPE_EMPTY` means the corresponding authorization scope is empty or incomplete. Do not retry identical parameters or claim that multiple dimensions failed unless the tool explicitly reports them. For other `QDM_*` errors, do not infer “no permission” unless the code explicitly indicates authorization denial; do not reinterpret an error as empty data. After any permission, parameter-validation, or upstream error, do not repeat the exact same query in the same turn.

Report/template lifecycle is not part of the public QwenPaw query tool. It can only be entered
through a future trusted Harness context and must never be triggered by model-supplied fields.
