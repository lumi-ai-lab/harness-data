# @lumi-ai-lab/harness-data

Harness Data runtime installer and updater.

The runtime contains the Harness helper and the Metric query entry point:

- `data-harness-cli`: builds and serves Harness Wikis context and posttool state.
- `qdm-metric-cli`: the authorized data-query CLI.
- private `qdm-metric-cli-real`: the pinned upstream runtime held behind the
  Linux root-owned Metric broker. Its directory is mode `0700` and executable
  is mode `0500`, so the Agent UID cannot read or execute its embedded
  credential.
- root-only broker executable: a SHA-verified broker copy at
  `/opt/harness-data/broker/qdm-metric-cli`, also protected by `0700`/`0500`.
  The systemd service does not execute the Agent-visible runtime binary as
  root.

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
authorization. The `lumi-mvp-required` profile requires `--agent pi`; the Pi
extension binds each session to the current Lumi requester context. The public
CLI reaches the private runtime only through
`/run/harness-data/qdm-metric-cli.sock`; the broker authenticates the caller
with Linux `SO_PEERCRED`, requires the configured non-root `agentUid`, and
enforces the Harness scope against requester-context files owned by the
separate `requesterContextOwnerUid`. This profile requires Linux and a root
installation. Start `harness-data-metric-broker.service` only after the
root-owned, Agent-readable, non-writable authorization config and its mounted
runtime inputs are ready. The requester-context directory must be searchable
but not listable or writable by the Agent (`0711` or `0710`), and envelope
files must be readable but not writable by it (`0644` or `0640`).

Supported local Agent templates are Claude Code, Codex, Pi, OpenClaw, and
Hermes. Non-Pi templates use only the ordinary Harness context and posttool
hooks and are not accepted by `lumi-mvp-required`.

Commands:

```text
harness-data install
harness-data update
harness-data doctor
harness-data version
```
