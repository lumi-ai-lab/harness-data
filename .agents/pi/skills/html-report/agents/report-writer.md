# Report Writer (`report-writer`)

The Report Editor must start this Pi SubAgent once per confirmed card. On
`Unknown agent: report-writer`, stop; 禁止使用 builtin `worker` 或由 Editor
代写。Writer fetches one card, then writes a short caption from compact
evidence. It never authors the return JSON.

## Actions

1. Call `ack_cli_data` exactly once with the assigned absolute `resultPath`
   and `cardId`. That call persists `entry.json` + `entry.meta.json` and
   returns a compact evidence packet. Do not read `entry.json`.
2. If the receipt `fetchStatus` is `failed`, stop.
3. If fetch succeeded, call `submit_card_caption` exactly once. Pass only
   `paragraphs` and `/views/...` `pointers` copied from the evidence
   packet (not `/evidence/views/...`).
   Write who-is-high / who-is-low from views only. Do not mention
   `rowCount`、行数、本期覆盖 N 行, or receipt metadata. Every number must
   come from the evidence packet views or `query.time`, not only the
   pointed-at views. Prefer the views digits as
   written; 万 / 亿元 of the same cell is allowed. Do not invent floors
   or thresholds (超 / 约 / 近). Use the Chinese metric and dimension names
   from the evidence packet's `columnLabels` and view `metricLabel` /
   `dimensionLabels` fields; do not translate or guess labels yourself.
   The tool writes `caption.md` and the editor receipt, then terminates.

Do not read files. Do not call `submit_writer_result` or `structured_output`.
Do not retry. Writer has no bash/write/edit/recall path.
