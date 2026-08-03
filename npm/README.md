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

The `local-unrestricted` profile downloads and verifies the latest real
`qdm-metric-cli` GitHub Release. `--metric-cli-path` remains available as an
optional local executable override:

```bash
npx @lumi-ai-lab/harness-data install \
  --agent codex

# Optional local override:
npx @lumi-ai-lab/harness-data install \
  --agent codex \
  --metric-cli-path /absolute/path/to/qdm-metric-cli
```

The installer writes:

```bash
export QDM_METRIC_CLI="/absolute/runtime/path/bin/qdm-metric-cli"
```

Omitting `--profile` always selects `local-unrestricted`, including
non-interactive and `--yes` installations. Production authorization deployments
must explicitly select `pi-requester-authorized`.

The local-unrestricted profile does not configure credentials or requester
authorization. The `pi-requester-authorized` profile requires `--agent pi`; the Pi
extension binds each session to the current Lumi requester context. The public
CLI reaches the private runtime only through
`/run/harness-data/qdm-metric-cli.sock`; the broker authenticates the caller
with Linux `SO_PEERCRED`, requires the configured non-root `agentUid`, and
enforces the Harness scope against requester-context files owned by the
separate `requesterContextOwnerUid` and assigned to the configured
`requesterContextReaderGid`. It also requires exact configured Workspace and
`pi` Agent identities. This profile requires Linux and a root installation.
Start `harness-data-metric-broker.service` only after the root-owned,
Agent-readable, non-writable authorization config and its mounted runtime
inputs are ready. The configured requester-context path must end with
`<workspace-id>/pi`; its context root, Workspace directory, and Agent directory
must use exact mode `0710`, and envelope files exact mode `0640`, with the
configured publisher owner and reader group. `/etc/harness-data/authz.json`
and `killSwitch.controlPath` must likewise use exact mode `0640`, owner root,
and the configured reader group; the kill-switch parent directory must be
root-controlled and reader-group traversable, for example mode `0710`. The
release smoke runs the installed `data-harness-cli authz-bind` as the real
non-root Pi identity to enforce this deployment contract.

The accepted producer contract is Envelope v1 / RequesterContext v2 with the
exact `qdm.metric.query` capability and the Harness-owned
`authorization.claims["qdm.scope"]` schema v1. Harness enforces
`manageAreaIds`, `dcManageAreaIds`, and `categoryLevel1Ids` in flags and
structured analysis payloads. It also enforces every configured date, metric,
dimension, pagination, metadata, timeout, output, and kill-switch limit. See
the root README and `config/authz-config-v1.json.example` for the full
deployment contract.

Release approval is based on review of the exact `wikis` gitlink, the checked-in
Metric catalog, and the release PR. The Wikis copy and its allowlist manifest
are generated from that pinned commit during release and stored only in the
immutable runtime bundle. Generating and rechecking the manifest proves content
consistency; it does not independently grant business approval.

Supported local Agent templates are Claude Code, Codex, Pi, OpenClaw, and
Hermes. Non-Pi templates use only the ordinary Harness context and posttool
hooks and are not accepted by `pi-requester-authorized`.

Commands:

```text
harness-data install
harness-data update
harness-data doctor
harness-data version
```
