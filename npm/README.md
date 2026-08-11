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

The shipped `config/fixtures/local-test-auth.blob` is used as local fallback (`dev_user_id: local-test-user`). For Codex App or terminal scenarios, admins can distribute a real encrypted blob file outside the workspace and bind it with `HARNESS_AUTH_BLOB_FILE` + `HARNESS_AUTH_USER_ID`; keep `authz.allow_local_blob: true` for this mode. Codex uses `PreToolUse` to inject auth through the shared Go core. WorkBuddy uses the same classification core but replaces gated commands with an internal `authz-exec` broker, so the blob does not enter WorkBuddy `updatedInput` or conversation history. With authz off, hooks leave shell commands unchanged.

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

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `workbuddy`, `both`, and `all`. `both` remains Claude + Codex. `all` keeps its existing Claude + Codex + Pi + OpenClaw + Hermes semantics; choose `--agent workbuddy` explicitly.

On Windows, Codex remains the default; pass `--agent workbuddy` explicitly to install the WorkBuddy plugin package.

WorkBuddy requires version **5.3.8+**, the validated Windows host-contract baseline. The installer prepares a local Marketplace at `agents/.codebuddy-plugin/marketplace.json` whose `qdm-harness` plugin source is `agents/workbuddy`; it does not edit WorkBuddy settings or Marketplace registration. In WorkBuddy's plugin manager, choose **Add Marketplace**, select the runtime's `agents` directory, install and enable `qdm-harness@lumi-harness-data`, reload plugins, and start a new conversation in the Harness runtime workspace. Marketplace/package presence and plugin enablement are reported separately by `doctor`.

WorkBuddy's repository implementation supports `authz.mode=off/on`. On Windows WorkBuddy, gated `qdm-metric-cli auth describe` and `analysis execute` commands must use the Bash tool. Its `PreToolUse` hook calls `authz-hook --agent workbuddy`, strips model-supplied authorization flags, and replaces supported Bash commands with the trusted `data-harness-cli authz-exec` broker. The broker resolves the configured Local Blob internally; authorization material is rejected if it appears in `updatedInput`. PowerShell gated commands fail closed with `QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED` before credentials are resolved. Missing credentials or hook failures also deny execution. Context/PostToolUse failures remain visible through `additionalContext` and `systemMessage`; WorkBuddy sessions never fall back to shared `unknown` state.

Production installation may explicitly use `--agent workbuddy --data-auth` with Windows WorkBuddy 5.3.8+. The fix2 real-client regression matrix validated stdout/stderr delivery through Bash, secret-free broker replacement, PowerShell deny zero side effects, and session/history redaction. `doctor` continues to report the host-contract result and fails clients below 5.3.8. The implementation does not disable WorkBuddy's sandbox.
