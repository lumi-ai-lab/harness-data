---
name: qdm-harness
description: Discover QDM metric codes, dimensions, and filter values, then run authorized qdm-metric-cli queries. Use when the injected Harness context is mode free, or when a QDM question does not already name a metric code.
---

# QDM Harness: metric discovery and queries (Codex CLI)

Data access uses `qdm-metric-cli`. Run it from the harness-data runtime workspace
root as `bin/qdm-metric-cli` (`bin/qdm-metric-cli.exe` on Windows); do not rely on
`source` or shell environment variables.

The injected Harness context states the mode. In `mode: free` no metric was
recalled, so discover the metric yourself instead of asking the user for a code.

## 1. Find the metric code

```bash
bin/qdm-metric-cli metric search --keyword 销售额
bin/qdm-metric-cli metric search --keyword saleAmt --exact
```

Use the returned `code` for `wikis --code` and `analysis --metric`. Other useful
fields: `name`, `calculationType`, `defaultStatisticPolicy`, `unit`, `valueType`.

## 2. Read the metric semantics

```bash
bin/qdm-metric-cli wikis --code saleAmt --output envelope
```

Decide from `data.metric`, `data.capabilities`, and `data.dimensions`:

- `supportedDimensions` — legal `--agg-dim` and `--filter` keys
- `supportedStatisticPolicies` — `SUMMARY` and/or `SALES_STORE_DAY_AVG`
- `defaultStatisticPolicy` — use it when the user did not choose one

Never use the legacy `indicator`, `visualization`, `dimUniqueCode`, `supportDim`,
or `indicatorsCodeEn` fields.

## 3. Resolve dimensions and filter values

```bash
bin/qdm-metric-cli dim search --metric saleAmt --keyword 门店
bin/qdm-metric-cli dim values --code storeId --keyword 上海 --limit 20
```

- `code` is what `--agg-dim`, the left side of `--filter`, and `dim values --code` take.
- Filter values must be IDs returned by `dim values` — never a display name and
  never an unverified code.
- The metric's `supportedDimensions` still wins over anything `dim search` returns.
- Warehouse dimension codes include `dcId`, `dcCityId`, `dcManageAreaId`, `dcSapArea2Id`.
- `incDate`, `incMonth`, `incYear`, `collectStore`, `storeFlagId`, `storeTypeId`,
  and `warehouseId` are not valid Registry codes.

## 4. Query

```bash
bin/qdm-metric-cli analysis execute \
  --start-date 2026-07-29 \
  --end-date 2026-07-29 \
  --metric saleAmt \
  --agg-dim bizDate \
  --statistic-policy SUMMARY \
  --format json \
  --output envelope
```

Common parameters:

| Parameter | Meaning |
| --- | --- |
| `--start-date` / `--end-date` | `YYYY-MM-DD` range |
| `--metric` | Registry metric code, repeatable |
| `--agg-dim` | Registry dimension code, repeatable |
| `--filter` | `dimensionCode=id1,id2`, repeatable |
| `--other-filter` | registered preset filter, `filterCode=id1,id2` |
| `--measure-filter` | `metricCode:operator:value` |
| `--statistic-policy` | must be supported by the metric |
| `--order-by` | e.g. `"saleAmt DESC"` |
| `--time-grain` | `DAY`, `WEEK`, or `MONTH` |
| `--page-size` / `--curr-page` / `--single-page` | paging |
| `--yoy` / `--mom` | add YoY or MoM; requires at least one `--agg-dim` |
| `--format` / `--output` | `json` or `jsonl`; `data` or `envelope` |

Validate a complex dimension combination before trusting it:

```bash
bin/qdm-metric-cli analysis validate <same business parameters> --output envelope
```

`DIMENSION_NOT_FOUND`, `METRIC_NOT_FOUND`, or `INVALID_REQUEST` means the command
is not a valid example to reuse. Do not use `--column-agg-dim`,
`--store-collect-type`, `--indicators-group`, `--ai`, or any retired `*-cli`.

## 5. Authorization

The Codex `PreToolUse` authz hook injects `--data-auth --auth-blob` for
`analysis execute` and `auth describe`. Write business parameters only: never add,
remove, or override `--data-auth` / `--auth-blob` / `--auth-json`, and never pass a
CLI path or secret file to work around the hook.

Answer permission questions from this command only:

```bash
bin/qdm-metric-cli auth describe
```

`auth describe` accepts neither `--output` nor `--format` and always prints JSON.
When authz is on and a query succeeded, disclose the applicable account data scope
from `auth describe` in the user-facing answer; `analysis execute` does not echo
injected scope filters, so never infer "no scope filter" from the command line.

## 6. Time expressions

Relative dates ("昨天", "上个月") must be resolved through the time policy spec
whose absolute path the injected Harness context carries under `time_policy`.
Do not invent date ranges, and do not reuse a date from an earlier turn blindly.

## Rules

- Numbers, rankings, comparisons, and growth rates come from CLI output only.
- Never estimate, interpolate, or fabricate a missing value.
- Distinguish permission denial, empty data, invalid parameters, and upstream
  errors; never retry an identical failed command in the same turn.
- Deliver results in the conversation; do not write them to files unless the user
  asks to export.
- Do not read or apply templates from this skill. Report-mode staging goes through
  the plugin-owned tool flow, not through shell commands.
- The full CLI handbook and the knowledge index live under the injected
  `resourceRoot`, at `resources/wikis/rules/qdm-metric-cli/spec.md` and
  `resources/wikis/index.md`. Read them when this skill does not cover a case.
