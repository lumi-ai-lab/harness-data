# Harness Data npm installer

## Prerequisites

- **Node.js 18+**
- **Git** (on PATH)
- **tar** (on PATH; bundled with Git for Windows on Windows)
- **Windows only** — additional requirements:
  - **unzip** — not bundled with Git for Windows by default. Install via MSYS2 (`pacman -S unzip`) or copy from an MSYS2 installation into a PATH directory. The installer checks for `unzip` and will stop with `missing required command: unzip` if it is absent.
  - **Codex by default** — Windows defaults to Codex; explicitly selecting `--agent workbuddy` is also supported. Other agents (Claude, Pi, OpenClaw, Hermes) are not available on Windows.
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

Metric authorization is enabled by default. Interactive install securely prompts for the encrypted Blob:

```bash
npx @lumi-ai-lab/harness-data install
```

For non-interactive installs, pass `--auth-blob` explicitly:

```bash
npx @lumi-ai-lab/harness-data install \
  --auth-blob 'qdm1enc...' --yes
```

Non-interactive installs must pass `--auth-blob` explicitly. The user-provided Blob is atomically stored at `config/dev-auth.blob` with mode `0600`; no credential fixture is shipped.

For the Codex App or terminal scenario, admins can distribute a real encrypted Blob file to each user outside the workspace and users bind it with `HARNESS_AUTH_BLOB_FILE`; keep `authz.allow_local_blob: true` for this mode. The legacy `HARNESS_AUTH_USER_ID` is host metadata only and is not a qdm authorization input. Codex uses `PreToolUse` hook to inject auth; the hook reads the local Blob and rewrites gated `qdm-metric-cli` commands directly. When `authz.mode=on`, ordinary Codex Bash commands are rewritten to unset auth source env before execution.

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

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `workbuddy`, `both`, and `all`. `both` remains Claude + Codex. Until the project-owned WorkBuddy desktop E2E matrix passes, `all` keeps its existing Claude + Codex + Pi + OpenClaw + Hermes semantics; choose `--agent workbuddy` explicitly. On Windows, only `codex` is available and is auto-selected.

WorkBuddy auth requires Desktop **5.3.11+** with embedded CodeBuddy CLI **2.115.0+**. The installer prepares a local Marketplace at `agents/.codebuddy-plugin/marketplace.json` whose `qdm-harness` plugin source is `agents/workbuddy`; it does not edit WorkBuddy settings or Marketplace registration. In WorkBuddy's plugin manager, choose **Add Marketplace**, select the runtime's `agents` directory, install and enable `qdm-harness@lumi-harness-data`, reload plugins, and start a new conversation in the Harness runtime workspace. Marketplace/package presence, plugin enablement, runtime versions, and auth source are reported separately by `doctor`.

On macOS and Windows, `authz.mode=on` is enforced by a fail-closed `PreToolUse` hook. For managed macOS credentials, set `HARNESS_AUTH_BLOB_FILE` with `launchctl`, keep the Blob outside the workspace with mode `0600`, restart WorkBuddy, and run `doctor`. A legacy `HARNESS_AUTH_USER_ID` may remain as host metadata but is not used for qdm authorization. Windows QDM data commands must use Bash; gated PowerShell commands are denied before credentials are read. Direct injection places the encrypted Blob in `updatedInput.command`, so this mode is limited to local validation or controlled pilots until a credential-isolated integration is available.
