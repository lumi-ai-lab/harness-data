# @lumi-ai-lab/harness-data

Harness Data runtime installer and updater.

The runtime contains the Harness helper and the Metric query entry point:

- `data-harness-cli`: builds and serves Harness Wikis context and posttool state.
- `qdm-metric-cli`: the authorized data-query CLI.
- private `qdm-metric-cli-real`: the pinned upstream runtime used by the
  `lumi-mvp-required` entry point.

The `local-unrestricted` profile requires an explicit real `qdm-metric-cli`
executable. This prevents a local installation from receiving the
authorization-only wrapper without the private runtime it needs:

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

The local-unrestricted profile does not configure credentials or requester
authorization. The `lumi-mvp-required` profile binds each Agent session to the
current Lumi requester context and lets only the authorized `qdm-metric-cli`
entry point reach the private runtime.

Supported Agent templates are Claude Code, Codex, Qwen Code, Pi, OpenClaw, and
Hermes. Agent templates use only the ordinary Harness context and posttool
hooks.

Use `--agent lumi` to enable Pi, Claude Code, and Codex together for a Lumi
workspace without creating the other Agent links.

Commands:

```text
harness-data install
harness-data update
harness-data doctor
harness-data version
```
