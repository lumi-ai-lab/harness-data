# Harness Data npm installer

Install a Harness Data runtime in the current directory:

```bash
npx @lumi-ai-lab/harness-data install
```

Install into an explicit runtime directory:

```bash
npx @lumi-ai-lab/harness-data install --dir /path/to/runtime
```

The `local-unrestricted` profile installs only `data-harness-cli` and the real
`qdm-metric-cli`. By default, the installer downloads the latest platform
archive from `pengmide/qdm-metric-cli`, requires and verifies its published
`.sha256`, installs it as `bin/qdm-metric-cli`, and removes the Metric archive
from `.bootstrap-cache`.

Authenticated `gh` or `GITHUB_TOKEN` Release downloads are preferred, with an
unauthenticated fallback for public assets:

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install \
  --profile local-unrestricted
```

Use an existing local executable instead of downloading Metric CLI:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile local-unrestricted \
  --metric-cli-path /absolute/path/to/qdm-metric-cli
```

For non-interactive installation, pass `--profile` explicitly. With `--yes`,
omitting `--agent` silently selects `all`; use `--agent` to select one
integration.

Update an existing runtime interactively:

```bash
npx @lumi-ai-lab/harness-data update
```

Diagnose a runtime:

```bash
npx @lumi-ai-lab/harness-data doctor
```

The immutable Lumi profile must be selected explicitly and accepts only Wikis
content that exactly matches the business-approved file allowlist shipped in
the materialized runtime bundle:

```bash
npx @lumi-ai-lab/harness-data install \
  --profile lumi-mvp-required \
  --agent pi \
  --wikis-source /path/to/approved-lumi-wikis
```

This profile never falls back to cloning the mutable/full Wikis repository.
At image build time `doctor` reports runtime-only mounts and credentials as
pending; at runtime it invokes `data-harness-cli authz-readiness` and fails if
the complete authorization deployment is not ready.

The runtime is assembled from the `harness-data` runtime bundle,
platform-specific Helper and Metric CLI Release assets, `harness-data-wikis`,
generated local config, Wikis indexes, and selected Agent symlinks. The local
profile does not create `.qdm-auth` or retain the legacy CMR, Indicators, SQL,
or CAS CLIs.

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `both`, and `all`; the default is `all`. `both` installs Claude + Codex, while `all` installs Claude + Codex + Pi + OpenClaw + Hermes.
