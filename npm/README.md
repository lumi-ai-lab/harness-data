# @lumi-ai-lab/harness-data

Harness Data runtime installer and updater.

The runtime contains two executables:

- `data-harness-cli`: builds and serves Harness Wikis context and posttool state.
- `qdm-metric-cli`: the only data-query CLI.

Install with an explicit local `qdm-metric-cli` executable:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile local-unrestricted \
  --agent codex \
  --metric-cli-path /absolute/path/to/qdm-metric-cli
```

The installer writes:

```bash
export QDM_METRIC_CLI="/absolute/runtime/path/bin/qdm-metric-cli"
```

It does not install or configure CMR, Indicators, SQL, CAS, tokens, credentials,
authorization facades, or authorization hooks.

Supported Agent templates are Claude Code, Codex, Qwen Code, Pi, OpenClaw, and
Hermes. Agent templates use only the ordinary Harness context and posttool
hooks.

Commands:

```text
harness-data install
harness-data update
harness-data doctor
harness-data version
```
