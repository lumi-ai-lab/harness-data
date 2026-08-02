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

Repair generated Agent integrations and their link/junctions:

```bash
npx @lumi-ai-lab/harness-data doctor --fix --agent codex
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

The runtime is assembled from immutable Agent templates, platform-specific CLI
Release assets, `harness-data-wikis`, generated local config, and CAS
credentials. The installer renders selected integrations into
`.harness/generated/agents/*`; `.codex`, `.claude`, `.pi`, `.openclaw`, and
`.hermes` point to those generated directories. Runtime updates always
reconcile them and leave byte-identical Hook definitions untouched.

On native Windows, declarative Hooks call the downloaded
`data-harness-cli.exe` through an absolute `commandWindows`; programmatic
adapters use executable + argv with `shell:false`. No Python or Git Bash is
required for the Codex/Claude Hook path. The installer generates both
`config/qdm-cli-paths.env` and `config/qdm-cli-paths.ps1`.

When a Codex Hook definition is first generated or materially changes, run
`/hooks` in Codex to review and trust it. The installer never edits the Codex
trust store.

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `both`, and `all`; the default is `all`. `both` installs Claude + Codex, while `all` installs Claude + Codex + Pi + OpenClaw + Hermes.
