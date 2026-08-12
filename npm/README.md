# Harness Data npm installer

## Prerequisites

- **Node.js 18+**
- **Git** (on PATH)
- **tar** (on PATH; bundled with Git for Windows on Windows)
- **Windows only** — additional requirements:
  - **unzip** — not bundled with Git for Windows by default. Install via MSYS2 (`pacman -S unzip`) or copy from an MSYS2 installation into a PATH directory. The installer checks for `unzip` and will stop with `missing required command: unzip` if it is absent.
  - **Codex Agent only** — Windows supports Codex exclusively; other agents (Claude, Pi, OpenClaw, Hermes, WorkBuddy) are not available on Windows.
  - **No-auth mode** — Windows Codex authorization adaptation is tracked separately. Until it lands, install with `--no-auth`; the installer rejects an auth-enabled Windows install instead of creating a runtime whose authorization hook cannot execute safely.
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

Metric **data-auth** is enabled by default. Interactive install prompts for the encrypted Blob and `dev_user_id`:

```bash
npx @lumi-ai-lab/harness-data install
```

For non-interactive installs, pass flags or environment variables:

```bash
npx @lumi-ai-lab/harness-data install \
  --auth-blob 'qdm1enc...' --auth-user-id 'your-user-id' --yes

HARNESS_AUTH_BLOB='qdm1enc...' HARNESS_AUTH_USER_ID='your-user-id' \
npx @lumi-ai-lab/harness-data install --yes
```

Install without auth only after password validation:

```bash
npx @lumi-ai-lab/harness-data install --no-auth
npx @lumi-ai-lab/harness-data install --no-auth \
  --auth-off-password 'qdmzt@2026' --yes
```

Use the built-in fixture for development and testing:

```bash
npx @lumi-ai-lab/harness-data install --data-auth
```

The same auth parameters support `--agent workbuddy` on macOS. WorkBuddy auth is rejected on other platforms; use `--no-auth` there because M1/M2 command rewriting uses POSIX Shell syntax. User-provided Blobs and the fixture working copy are stored at `config/dev-auth.blob` with mode `0600`.

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

`--agent` supports `claude`, `codex`, `pi`, `openclaw`, `hermes`, `workbuddy`, `both`, and `all`. `both` remains Claude + Codex. Until the project-owned WorkBuddy desktop E2E matrix passes, `all` keeps its existing Claude + Codex + Pi + OpenClaw + Hermes semantics; choose `--agent workbuddy` explicitly. On Windows, only `codex` is available and is auto-selected.

WorkBuddy auth requires Desktop **5.3.11+** with embedded CodeBuddy CLI **2.115.0+**. The installer prepares a local Marketplace at `agents/.codebuddy-plugin/marketplace.json` whose `qdm-harness` plugin source is `agents/workbuddy`; it does not edit WorkBuddy settings or Marketplace registration. In WorkBuddy's plugin manager, choose **Add Marketplace**, select the runtime's `agents` directory, install and enable `qdm-harness@lumi-harness-data`, reload plugins, and start a new conversation in the Harness runtime workspace. Marketplace/package presence, plugin enablement, runtime versions, and auth source are reported separately by `doctor`.

On macOS, `authz.mode=on` is enforced by a fail-closed `PreToolUse` hook for `Bash|execute_command`. For managed credentials, set `HARNESS_AUTH_BLOB_FILE` and `HARNESS_AUTH_USER_ID` with `launchctl`, keep the Blob outside the workspace with mode `0600`, restart WorkBuddy, and run `doctor`. PowerShell auth rewriting is not supported. M1/M2 place the encrypted Blob in `updatedInput.command`, so this mode is limited to local validation or controlled pilots until Keychain/Broker support is available.
