# Harness Data

Harness Data supplies governed Wikis context to coding Agents and uses
`qdm-metric-cli` as its only data-query entry point.

## Runtime

The installed runtime contains:

- `bin/data-harness-cli`: Wikis indexing, context selection, template staging,
  and posttool state.
- `bin/qdm-metric-cli`: Metric discovery, dimension discovery, validation,
  preview, and execution.
- `config/harness-config.yaml`: Harness paths and the `qdm_metric_cli` path.
- `config/qdm-cli-paths.env`: exports only `QDM_METRIC_CLI`.
- `agents/*`: ordinary context/posttool integrations for Claude Code, Codex,
  Qwen Code, Pi, OpenClaw, and Hermes.

The runtime does not install or configure any other data CLI. It has no CAS
credential flow, token refresh command, Indicators facade, requester
authorization binding, or authorization hook.

## Install

```bash
npx @lumi-ai-lab/harness-data install \
  --profile local-unrestricted \
  --agent codex \
  --metric-cli-path /absolute/path/to/qdm-metric-cli
```

For non-interactive installation, pass `--profile`, `--agent`, and
`--metric-cli-path` explicitly. A `lumi-mvp-required` build must also pass its
approved Wikis source:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile lumi-mvp-required \
  --agent qwen \
  --metric-cli-path /absolute/path/to/qdm-metric-cli \
  --wikis-source /absolute/path/to/approved-wikis
```

## Agent Hooks

Claude Code, Codex, and Qwen Code call:

```bash
bin/data-harness-cli context --format agent-hook
bin/data-harness-cli posttool --format agent-hook
```

Pi loads `.pi/extensions/qdm-harness/index.ts` and uses the same context and
posttool contracts. OpenClaw and Hermes use their project plugin/skill
templates. No Agent template installs a `PreToolUse` authorization hook.

## Data Queries

Load the generated path:

```bash
source config/qdm-cli-paths.env
"$QDM_METRIC_CLI" metric search --keyword 销售额
"$QDM_METRIC_CLI" wikis --code saleAmt
"$QDM_METRIC_CLI" dim search --metric saleAmt
"$QDM_METRIC_CLI" dim values --code storeId --keyword 南山 --limit 20
"$QDM_METRIC_CLI" analysis execute \
  --start-date 2026-07-27 \
  --end-date 2026-07-27 \
  --metric saleAmt \
  --agg-dim bizDate
```

Numeric values used in answers must come from `qdm-metric-cli`; Agents must not
fall back to another CLI or direct SQL.

## Development

```bash
go test ./cli/...
npm test --prefix npm -- --test-concurrency=1
node --test .agents/pi/extensions/qdm-harness/test/*.test.mjs
```
