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

Enable metric **data-auth** (authz) during install — writes `authz.mode: on`, copies the local-test encrypted blob, and keeps Host `_auth` as the preferred source when present:

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install --data-auth
```

This is separate from the `auth` subcommand (CAS username/password for SQL). Without Lumi/Host, the shipped `config/fixtures/local-test-auth.blob` is used as fallback (`dev_user_id: local-test-user`).

Without a GitHub token, the installer interactively asks for local absolute paths to `cas-cli`, `qdm-metric-cli`, `qdm-sql-cli`, and `harness-data-wikis`. CAS username and password are always collected interactively. Data queries use only `qdm-metric-cli` (`qdm-cmr-cli` / `qdm-indicators-cli` are no longer installed).

Update an existing runtime interactively:

```bash
npx @lumi-ai-lab/harness-data update
```

Reconfigure CAS credentials after an account/password change or after `.qdm-auth` was deleted:

```bash
npx @lumi-ai-lab/harness-data auth --dir /path/to/runtime
```

The command recreates `.qdm-auth/cas`, stores the new encrypted CAS credentials, refreshes the SQL token via `cas-cli token --app rtp`, and validates it. Metric CLI uses auth-blob / data-auth (no CAS set-token).

Diagnose a runtime:

```bash
npx @lumi-ai-lab/harness-data doctor
```

The runtime is assembled from the `harness-data` runtime bundle, platform-specific CLI Release assets, `harness-data-wikis`, generated local config, CAS credentials, and selected Agent symlinks. SQL CLI tokens are fetched through `cas-cli token --app rtp`.

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `both`, and `all`; the default is `all`. `both` installs Claude + Codex, while `all` installs Claude + Codex + Pi + OpenClaw + Hermes.
