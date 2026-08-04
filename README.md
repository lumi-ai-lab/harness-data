# Harness Data

Harness Data supplies governed Wikis context to coding Agents and uses
`qdm-metric-cli` as its only data-query entry point.

## Runtime

The installed runtime contains:

- `bin/data-harness-cli`: Wikis indexing, context selection, template staging,
  and posttool state.
- `bin/qdm-metric-cli`: the authorized Metric discovery, dimension discovery,
  validation, preview, and execution entry point.
- `bin/qdm-metric-cli-real`: the pinned upstream Metric runtime invoked by the
  lightweight authorization wrapper.
- `config/harness-config.yaml`: Harness paths and the `qdm_metric_cli` path.
- `config/qdm-cli-paths.env`: exports only `QDM_METRIC_CLI`.
- `agents/*`: context/posttool integrations. The Pi requester authorization profile uses only the Pi
  extension for requester authorization binding.

The runtime does not install or configure any legacy data CLI or token flow.
In `pi-requester-authorized`, the Pi extension binds each ACP session to the
current Lumi requester envelope. The public `qdm-metric-cli` reopens that JSON,
applies the Harness scope, and directly executes the pinned Metric runtime.
This MVP intentionally trusts the JSON supplied by Lumi and does not establish
a local UID/GID or filesystem ownership trust boundary.

## Install

The `pi-requester-authorized` profile downloads both pinned Metric binaries into
the runtime and requires only `--agent pi`. Installation runs as an ordinary
user on every platform represented in the release manifest. There is no
`/etc/harness-data/authz.json`, root install, systemd service, fixed UID/GID, or
deployment-managed requester-context directory. Lumi automatically supplies
`LUMI_REQUESTER_CONTEXT_DIR` to Pi.

The base64url/JCS binding correlates a tool call with the current session JSON;
it is not a signature. Missing, replaced, malformed, or expired JSON fails
closed. Because the Agent can potentially modify a locally readable file, this
profile is intended for validation of filtering behavior rather than as a
production host-security boundary.

## Requester Authorization Contract

Harness accepts File Envelope v1 containing RequesterContext v2. The context
must include the exact `qdm.metric.query` capability and a Harness-owned
`authorization.claims["qdm.scope"]` object with `schemaVersion: 1`:

```json
{
  "schemaVersion": 1,
  "manageAreaIds": ["CN07"],
  "dcManageAreaIds": ["DC07"],
  "categoryLevel1Ids": ["12"]
}
```

The wrapper maps protected query dimensions to claims as follows:

| Query dimension | Authorized claim |
| --- | --- |
| `manageAreaId`, `sapArea2Id` | `manageAreaIds` |
| `dcManageAreaId` | `dcManageAreaIds` |
| `categoryLevel1Id` | `categoryLevel1Ids` |

The same mapping is applied to ordinary CLI flags, `--other-filter`, and
structured analysis JSON. When a supported protected filter is absent, the
wrapper injects an applicable authorized scope. A request is rejected when no
authorized protected scope applies to every selected metric. Protected
dimension value enumeration is unavailable through `dim values`, because
Metric CLI v0.1.0 cannot constrain that metadata call by requester scope.

Built-in execution limits are enforced before or during the real CLI process:
31 days, 10 metrics, 10 dimensions, page size 200/1000, metadata limit 100/500,
30 seconds, and 2 MiB of captured output.

The `local-unrestricted` profile downloads the latest real `qdm-metric-cli`
release from GitHub, verifies its published archive checksum, and installs it
as the only local data-query CLI. An explicit executable can override that
download with `--metric-cli-path`:

```bash
npx @lumi-ai-lab/harness-data install \
  --agent codex

# Optional local override:
npx @lumi-ai-lab/harness-data install \
  --agent codex \
  --metric-cli-path /absolute/path/to/qdm-metric-cli
```

Omitting `--profile` always selects `local-unrestricted`, including
non-interactive and `--yes` installations. Production authorization deployments
must explicitly pass `--profile pi-requester-authorized`; pass `--agent` as well
when the selected Agent must be deterministic.
The `pi-requester-authorized` profile requires `--agent pi` and installs the
release-pinned Wikis embedded in its runtime bundle:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile pi-requester-authorized \
  --agent pi
```

## Release Contract

Release approval is attached to reviewed source inputs, not to three
pre-generated repository artifacts. The repository does not require the old
`bootstrap/approved-indicators-v1.json`, `bootstrap/approved-lumi-wikis/`, or
`bootstrap/approved-lumi-wikis-manifest.json` inputs. Instead, reviewers approve
the exact `wikis` gitlink commit, the checked-in
`bootstrap/approved-metrics-v1.json` generated from the trusted Metric Registry,
and the release PR through the repository's required business approval.

The release workflow verifies that the checked-out Wikis submodule matches the
reviewed gitlink, generates a content manifest from that pinned tree, and
immediately verifies the tree against the generated manifest. This proves
artifact consistency and reproducibility; it is not an independent business
approval. Materialization then writes these immutable outputs into the runtime
bundle:

- `bootstrap/approved-lumi-wikis/`
- `bootstrap/approved-lumi-wikis-manifest.json`
- `bootstrap/approved-metrics-v1.json`

The installer and `doctor` verify the Wikis allowlist and Metric catalog SHA
again. Any source review or required-approver policy remains a repository and
release-process gate outside that digest consistency check.

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
templates. Only Pi is supported by `pi-requester-authorized`; Claude Code, Codex,
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
npm install --prefix /tmp/pi-runtime @earendil-works/pi-coding-agent@0.83.0
QDM_PI_RUNTIME_MODULE=/tmp/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js \
  node --test .agents/pi/extensions/qdm-harness/test/*.test.mjs
```
