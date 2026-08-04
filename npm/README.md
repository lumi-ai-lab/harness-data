# @lumi-ai-lab/harness-data

Harness Data runtime installer and updater.

The runtime contains the Harness helper and the Metric query entry point:

- `data-harness-cli`: builds and serves Harness Wikis context and posttool state.
- `qdm-metric-cli`: the authorized data-query CLI.
- `qdm-metric-cli-real`: the pinned upstream runtime installed in the private
  tools directory and invoked only after the public wrapper validates Lumi's
  requester JSON.

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

The local-unrestricted profile does not configure requester authorization. The
`pi-requester-authorized` profile requires `--agent pi`; the Pi extension binds
each session to the current Lumi requester JSON and the public CLI applies its
scope before invoking the pinned runtime from a private tools directory. In
secure Docker deployments, start `data-harness-cli authz-metric-broker` and set
`HARNESS_METRIC_BROKER_SOCKET` so Bash receives only a one-shot broker token
instead of `HARNESS_AUTHZ_BINDING_V1`. Use
`--private-tools-dir /opt/harness-data/private/bin` for Docker images that run
the Agent as a non-root user. If the Agent runs as root inside the container,
filesystem permissions alone do not hide the real CLI.

The accepted producer contract is Envelope v1 / RequesterContext v2 with the
exact `qdm.metric.query` capability and the Harness-owned
`authorization.claims["qdm.scope"]` schema v1. Harness enforces
`manageAreaIds`, `dcManageAreaIds`, and `categoryLevel1Ids` in flags and
structured analysis payloads and built-in execution limits. Missing, invalid,
or expired requester JSON fails closed. This MVP trusts the local Lumi JSON and
is not a production host-security boundary.

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
