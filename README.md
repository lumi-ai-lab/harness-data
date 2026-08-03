# Harness Data

Harness Data supplies governed Wikis context to coding Agents and uses
`qdm-metric-cli` as its only data-query entry point.

## Runtime

The installed runtime contains:

- `bin/data-harness-cli`: Wikis indexing, context selection, template staging,
  and posttool state.
- `bin/qdm-metric-cli`: the authorized Metric discovery, dimension discovery,
  validation, preview, and execution entry point.
- private `qdm-metric-cli-real`: the pinned upstream Metric runtime stored in a
  root-only `0700` directory as a root-only `0500` executable.
- root-only broker executable: a SHA-verified copy of the public broker binary
  stored at `/opt/harness-data/broker/qdm-metric-cli` with directory mode
  `0700` and executable mode `0500`; systemd never starts the Agent-visible
  runtime copy as root.
- `config/harness-config.yaml`: Harness paths and the `qdm_metric_cli` path.
- `config/qdm-cli-paths.env`: exports only `QDM_METRIC_CLI`.
- `agents/*`: context/posttool integrations. The Lumi profile uses only the Pi
  extension for requester authorization binding.

The runtime does not install or configure any legacy data CLI or token flow.
In `lumi-mvp-required`, the Pi extension binds each ACP session to the current
Lumi requester envelope. The public `qdm-metric-cli` sends the invocation over
the fixed `/run/harness-data/qdm-metric-cli.sock` Unix socket. A root-owned
broker authenticates the caller with Linux `SO_PEERCRED`, requires the
configured non-root `agentUid`, revalidates requester-context files owned by
the separate `requesterContextOwnerUid` and assigned to the configured reader
group, requires the configured Workspace and `pi` Agent identities, applies the
Harness scope, and only then executes the private Metric runtime. The Agent UID
cannot modify requester envelopes or traverse, read, or execute the private
runtime and its embedded credential.

## Install

The `lumi-mvp-required` profile downloads the platform-specific authorized
`qdm-metric-cli` and its private `qdm-metric-cli-real` runtime pinned by the
runtime manifest. This protected profile requires Linux, root installation,
and the installed `harness-data-metric-broker.service`; deployment must provide
root-owned, Agent-readable, non-writable `/etc/harness-data/authz.json` with
deployment-resolved UID/GID values, then start the service after
requester-context and kill-switch paths are mounted. The relevant config
fragment is:

```json
{
  "agentUid": "<resolved-pi-uid>",
  "requesterContextDir": "/run/lumi/requester-context/<workspace-id>/pi",
  "requesterContextWorkspaceId": "<workspace-id>",
  "requesterContextAgentId": "pi",
  "requesterContextOwnerUid": "<resolved-lumi-publisher-uid>",
  "requesterContextReaderGid": "<resolved-reader-group-gid>"
}
```

Angle-bracket values are deployment placeholders; UID/GID values must be
replaced with unquoted JSON integers in the generated configuration.

`agentUid` is the effective UID of Pi and the public CLI client.
`requesterContextOwnerUid` is a different, trusted Lumi publisher UID. The
Agent must not run as root. `requesterContextReaderGid` is a dedicated group
granted to Pi; numeric IDs are resolved by deployment and are not baked into
the binaries. Every ancestor of `requesterContextDir` must be outside Agent
control and must not be group/world writable. The configured context root,
Workspace directory, and Agent directory must all be owned by the publisher
UID and reader GID with exact mode `0710`; envelope files must have the same
owner/group and exact mode `0640`. The configured path must end with
`<requesterContextWorkspaceId>/pi`.

The base64url/JCS binding is intentionally not a signature. Re-encoding it or
invoking `authz-bind` does not grant authority because both `authz-bind` and
the root broker re-open the owner-validated envelope, and the broker also
authenticates the caller UID.

The `local-unrestricted` profile downloads the latest real `qdm-metric-cli`
release from GitHub, verifies its published archive checksum, and installs it
as the only local data-query CLI. An explicit executable can override that
download with `--metric-cli-path`:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile local-unrestricted \
  --agent codex

# Optional local override:
npx @lumi-ai-lab/harness-data install \
  --profile local-unrestricted \
  --agent codex \
  --metric-cli-path /absolute/path/to/qdm-metric-cli
```

For non-interactive installation, pass `--profile` and `--agent` explicitly.
The `lumi-mvp-required` profile requires `--agent pi` and an approved Wikis
source:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile lumi-mvp-required \
  --agent pi \
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

Every upstream archive must also publish a matching `.sha256` file. Each
Harness release downloads the authorization-reviewed `v0.1.0` private Metric
CLI, computes its extracted binary SHA256, and pins the exact version, release
URLs, archive SHA256 values, and binary SHA256 values in the immutable runtime
manifest. Release-set binary digests are stored per platform under
`releaseSets.<key>.platforms.<platform>`; the platform identifier is included
in that platform's release-set digest and persisted installer state. The
installer rejects a release-set for another platform or a public/private Metric
binary that does not match the selected platform entry. As with the earlier
CMR, Indicators, SQL, and CAS CLIs, the installer then downloads the private
Metric CLI directly from its own GitHub Release and verifies the extracted
binary before installation. The private archive is held only in a temporary
`0700` installer cache and deleted after extraction; it is never retained in
the Agent-visible runtime cache. Harness-owned release archives continue to
publish both `.sha256` and `.binary.sha256` files.
Because the source repository is private, installation requires
`gh auth login`, `GITHUB_TOKEN`, or `--github-token` with read access unless
`--metric-cli-path` is used.

## Agent Hooks

Claude Code and Codex call:

```bash
bin/data-harness-cli context --format agent-hook
bin/data-harness-cli posttool --format agent-hook
```

Pi loads `.pi/extensions/qdm-harness/index.ts` and uses the same context and
posttool contracts. OpenClaw and Hermes use their project plugin/skill
templates. Only Pi is supported by `lumi-mvp-required`; Claude Code, Codex,
OpenClaw, and Hermes remain local-unrestricted context/posttool integrations.

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
