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

Without Lumi/Host, the shipped `config/fixtures/local-test-auth.blob` is used as fallback (`dev_user_id: local-test-user`).

Without a GitHub token, the installer interactively asks for a local absolute path to `qdm-metric-cli` and `harness-data-wikis`. Data queries use only `qdm-metric-cli` (`qdm-cmr-cli` / `qdm-indicators-cli` / `qdm-sql-cli` / `cas-cli` are no longer installed).

Update an existing runtime interactively:

```bash
npx @lumi-ai-lab/harness-data update
```

Diagnose a runtime:

```bash
npx @lumi-ai-lab/harness-data doctor
```

The runtime is assembled from the `harness-data` runtime bundle, platform-specific CLI Release assets (`data-harness-cli`, `qdm-metric-cli`), `harness-data-wikis`, generated local config, selected Agent symlinks, and the WorkBuddy plugin package.

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `workbuddy`, `both`, and `all`. `both` remains Claude + Codex. Until the project-owned WorkBuddy desktop E2E matrix passes, `all` keeps its existing Claude + Codex + Pi + OpenClaw + Hermes semantics; choose `--agent workbuddy` explicitly.

WorkBuddy requires version **5.3.5+**. The installer prepares a local Marketplace at `agents/.codebuddy-plugin/marketplace.json` whose `qdm-harness` plugin source is `agents/workbuddy`; it does not edit WorkBuddy settings or Marketplace registration. In WorkBuddy's plugin manager, choose **Add Marketplace**, select the runtime's `agents` directory, install and enable `qdm-harness@lumi-harness-data`, reload plugins, and start a new conversation in the Harness runtime workspace. Marketplace/package presence and plugin enablement are reported separately by `doctor`.

WorkBuddy currently supports `authz.mode=off` only. `--agent workbuddy --data-auth` is rejected because auth blob/data-permission injection is not implemented yet. Runtime incompatibilities and Hook failures are emitted as both model-visible `additionalContext` and host-visible `systemMessage`; WorkBuddy sessions never fall back to shared `unknown` state.
