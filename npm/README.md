# Harness Data npm installer

## Prerequisites

- **Node.js 18+**
- **Git** (on PATH)
- **tar** (on PATH; bundled with Git for Windows on Windows)
- **Windows only** — additional requirements:
  - **unzip** — not bundled with Git for Windows by default. Install via MSYS2 (`pacman -S unzip`) or copy from an MSYS2 installation into a PATH directory. The installer checks for `unzip` and will stop with `missing required command: unzip` if it is absent.
  - **Codex Agent only** — Windows supports Codex exclusively; other agents (Claude, Pi, OpenClaw, Hermes) are not available on Windows.
  - **Windows x64 + ARM64** are both supported.

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

The runtime is assembled from the `harness-data` runtime bundle, platform-specific CLI Release assets (`data-harness-cli`, `qdm-metric-cli`), `harness-data-wikis`, generated local config, selected Agent symlinks, and the WorkBuddy plugin package.

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `workbuddy`, `both`, and `all`. `both` remains Claude + Codex. Until the project-owned WorkBuddy desktop E2E matrix passes, `all` keeps its existing Claude + Codex + Pi + OpenClaw + Hermes semantics; choose `--agent workbuddy` explicitly.

On Windows, PR #28 currently limits installation to `codex`, which is auto-selected. Windows WorkBuddy support requires a follow-up compatibility implementation.

WorkBuddy requires version **5.3.5+**. The installer prepares a local Marketplace at `agents/.codebuddy-plugin/marketplace.json` whose `qdm-harness` plugin source is `agents/workbuddy`; it does not edit WorkBuddy settings or Marketplace registration. In WorkBuddy's plugin manager, choose **Add Marketplace**, select the runtime's `agents` directory, install and enable `qdm-harness@lumi-harness-data`, reload plugins, and start a new conversation in the Harness runtime workspace. Marketplace/package presence and plugin enablement are reported separately by `doctor`.

WorkBuddy currently supports `authz.mode=off` only. `--agent workbuddy --data-auth` is rejected because auth blob/data-permission injection is not implemented yet. Runtime incompatibilities and Hook failures are emitted as both model-visible `additionalContext` and host-visible `systemMessage`; WorkBuddy sessions never fall back to shared `unknown` state.
