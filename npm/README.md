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

Enable metric **data-auth** (authz) during install — writes `authz.mode: on`, copies the local-test encrypted blob, and uses local blob sources (env vars or config file) for authorization:

```bash
GITHUB_TOKEN=... npx @lumi-ai-lab/harness-data install --data-auth
```

The shipped `config/fixtures/local-test-auth.blob` is used as local fallback (`dev_user_id: local-test-user`). For the Codex App or terminal scenario, admins can distribute a real encrypted blob file to each user outside the workspace and users bind it with `HARNESS_AUTH_BLOB_FILE` + `HARNESS_AUTH_USER_ID`; keep `authz.allow_local_blob: true` for this mode. Codex uses `PreToolUse` hook to inject auth; the hook reads the local blob and rewrites gated `qdm-metric-cli` commands directly. When `authz.mode=on`, ordinary Codex Bash commands are rewritten by the hook to unset auth source env (`HARNESS_AUTH_BLOB`, `HARNESS_AUTH_BLOB_FILE`, `HARNESS_AUTH_USER_ID`, `LUMI_REQUESTER_CONTEXT_DIR`) before execution. `LUMI_REQUESTER_CONTEXT_DIR` is no longer read but is still scrubbed for legacy safety. When authz is off, the hook passes every Bash command through unchanged.

Without a GitHub token, the installer interactively asks for a local absolute path to `qdm-metric-cli` and `harness-data-wikis`. Data queries use only `qdm-metric-cli` (`qdm-cmr-cli` / `qdm-indicators-cli` / `qdm-sql-cli` / `cas-cli` are no longer installed).

Update an existing runtime interactively:

```bash
npx @lumi-ai-lab/harness-data update
```

Diagnose a runtime:

```bash
npx @lumi-ai-lab/harness-data doctor
```

The runtime is assembled from the `harness-data` runtime bundle, platform-specific CLI Release assets (`data-harness-cli`, `qdm-metric-cli`), `harness-data-wikis`, generated local config, and selected Agent symlinks.

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `both`, and `all`; the default is `all`. `both` installs Claude + Codex, while `all` installs Claude + Codex + Pi + OpenClaw + Hermes.
