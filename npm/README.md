# Harness Data npm installer

Install a Harness Data runtime in the current directory:

```bash
npx @lumi-ai-lab/harness-data install
```

Install into an explicit runtime directory:

```bash
npx @lumi-ai-lab/harness-data install --dir /path/to/runtime
```

Use a GitHub token for private Release assets:

```bash
npx @lumi-ai-lab/harness-data install --github-token ...
```

or:

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install
```

Without a GitHub token, the installer interactively asks for local absolute paths to `cas-cli`, `qdm-indicators-cli`, `qdm-cmr-cli`, `qdm-sql-cli`, and `harness-data-wikis`. CAS username and password are always collected interactively.

Update an existing runtime interactively:

```bash
npx @lumi-ai-lab/harness-data update
```

Reconfigure CAS credentials after an account/password change or after `.qdm-auth` was deleted:

```bash
npx @lumi-ai-lab/harness-data auth --dir /path/to/runtime
```

The command recreates `.qdm-auth/cas`, stores the new encrypted CAS credentials, refreshes the CMR, Indicators, and SQL tokens, and validates all three tokens.

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

The runtime is assembled from the `harness-data` runtime bundle, platform-specific CLI Release assets, `harness-data-wikis`, generated local config, CAS credentials, and selected Agent symlinks. SQL CLI tokens are fetched through `cas-cli token --app rtp`.

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `both`, and `all`; the default is `all`. `both` installs Claude + Codex, while `all` installs Claude + Codex + Pi + OpenClaw + Hermes.
