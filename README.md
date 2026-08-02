# Harness Data

Harness Data supplies governed Wikis context to coding Agents and uses
`qdm-metric-cli` as its only data-query entry point.

## Runtime

The installed runtime contains:

- `bin/data-harness-cli`: Wikis indexing, context selection, template staging,
  and posttool state.
- `bin/qdm-metric-cli`: the authorized Metric discovery, dimension discovery,
  validation, preview, and execution entry point.
- private `qdm-metric-cli-real`: the pinned upstream Metric runtime used only
  behind the authorized entry point in `lumi-mvp-required`.
- `config/harness-config.yaml`: Harness paths and the `qdm_metric_cli` path.
- `config/qdm-cli-paths.env`: exports only `QDM_METRIC_CLI`.
- `agents/*`: context/posttool integrations. The Lumi profile additionally
  installs requester authorization binding for Claude Code, Codex, Qwen Code,
  and Pi.

The runtime does not install or configure any legacy data CLI or token flow.
In `lumi-mvp-required`, the Agent Hook binds each ACP session to the current
Lumi requester envelope, and `qdm-metric-cli` revalidates that binding before
forwarding a constrained request to the private Metric runtime.

## Install

The `lumi-mvp-required` profile downloads the platform-specific authorized
`qdm-metric-cli` and its private `qdm-metric-cli-real` runtime pinned by the
runtime manifest. The `local-unrestricted` profile requires an explicit
`--metric-cli-path` so it never installs the authorization-only wrapper without
its private runtime:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile local-unrestricted \
  --agent codex \
  --metric-cli-path /absolute/path/to/qdm-metric-cli
```

For non-interactive installation, pass `--profile` and `--agent` explicitly.
Use `--agent lumi` to enable the Lumi workspace combination of Pi, Claude Code,
and Codex without enabling Qwen Code, OpenClaw, or Hermes.
A `lumi-mvp-required` build must also pass its approved Wikis source:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile lumi-mvp-required \
  --agent lumi \
  --metric-cli-path /absolute/path/to/qdm-metric-cli \
  --wikis-source /absolute/path/to/approved-wikis
```

## Release Contract

Production runtime manifests pin both the authorized Harness
`qdm-metric-cli` entry point and the private upstream `qdm-metric-cli` runtime
to semantic versions, and verify archive and extracted-binary SHA256 values.
The private upstream release must provide these assets:

```text
qdm-metric-cli-vX.Y.Z-darwin-arm64.tar.gz
qdm-metric-cli-vX.Y.Z-darwin-amd64.tar.gz
qdm-metric-cli-vX.Y.Z-linux-amd64.tar.gz
qdm-metric-cli-vX.Y.Z-windows-amd64.zip
```

Every archive must also publish matching `.sha256` and `.binary.sha256` files.
Harness release packaging stops before publication if any required asset is
missing or has an invalid checksum. Because the source repository is private,
released installation requires `gh auth login`, `GITHUB_TOKEN`, or
`--github-token` with read access unless `--metric-cli-path` is used.

## Agent Hooks

Claude Code, Codex, and Qwen Code call:

```bash
bin/data-harness-cli context --format agent-hook
bin/data-harness-cli posttool --format agent-hook
```

Pi loads `.pi/extensions/qdm-harness/index.ts` and uses the same context and
posttool contracts. OpenClaw and Hermes use their project plugin/skill
templates. The Lumi Claude Code, Codex, and Qwen Code templates install
`UserPromptSubmit` and `PreToolUse` authorization hooks. Pi uses the
extension's per-tool-call authorization path. Local-unrestricted keeps the
ordinary context/posttool behavior without requester authorization.

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
