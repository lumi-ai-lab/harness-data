# QDM Harness WorkBuddy Plugin

This package connects WorkBuddy 5.3.5+ to the existing Harness runtime through native plugin hooks. Auth command rewriting requires WorkBuddy 5.3.11+ with embedded CodeBuddy CLI 2.115.0+.

## Runtime flow

```text
PreToolUse
  -> scripts/harness-hook.mjs authz
  -> data-harness-cli authz-hook --agent workbuddy
  -> shared authz core

UserPromptSubmit
  -> scripts/harness-hook.mjs context
  -> data-harness-cli context --format workbuddy-hook
  -> shared context/session core

PostToolUse
  -> scripts/harness-hook.mjs posttool
  -> data-harness-cli posttool --format workbuddy-hook
  -> shared session/template core
```

The JavaScript adapter only normalizes WorkBuddy transport fields and tool names. Wikis recall, plan selection, session state, and template injection remain in the Go CLI.

## Enable locally

1. Install or update the Harness runtime so the plugin is available as `agents/workbuddy` and its local Marketplace manifest as `agents/.codebuddy-plugin/marketplace.json`.
2. In WorkBuddy's plugin management UI, choose **Add Marketplace** and select the runtime's `agents` directory (not `agents/workbuddy`).
3. Install and enable `qdm-harness@lumi-harness-data`, reload plugins, and start a new conversation in the Harness runtime workspace.
4. Run `harness-data doctor --dir <runtime>` to validate the package and inspect enablement across user/project/local settings.

CLI equivalent when the `codebuddy` command is available:

```bash
codebuddy plugin marketplace add "<runtime>/agents"
codebuddy plugin install qdm-harness@lumi-harness-data --scope user
```

The npm installer deliberately does not edit WorkBuddy settings or Marketplace registration automatically. Preparing the Marketplace and enabling its plugin in WorkBuddy are separate operations.

## Hooks

- `PreToolUse` matches macOS `Bash|execute_command`, calls `authz-hook --agent workbuddy`, and only permits gated QDM commands through `updatedInput.command`.
- `UserPromptSubmit` calls `context --format workbuddy-hook` and injects the current `authzMode`.
- `PostToolUse` matches `Bash|PowerShell|execute_command`, normalizes the tool name to `Bash`, and calls `posttool --format workbuddy-hook`.
- Outside a Harness workspace, all hooks return an empty object and do not alter normal WorkBuddy behavior.
- Context/PostToolUse failures return model-visible `additionalContext` and host-visible `systemMessage`; auth failures return an explicit `permissionDecision=deny` reason and exit with status `2` so hosts that cannot enforce the JSON decision still fail closed.
- WorkBuddy requires a stable `session_id`; its namespaced session key is stored under a collision-resistant SHA-256 filename and never falls back to shared `unknown` state.

## macOS auth

`authz.mode=on` gates only `qdm-metric-cli analysis execute` and `qdm-metric-cli auth describe`. The hook removes model-provided auth flags, binds the runtime encrypted Blob, fixes the CLI path, and scrubs auth source environment variables before execution.

For managed distribution, keep the Blob outside the workspace with mode `0600`, inject its path and user id into the GUI session, then restart WorkBuddy:

```bash
install -m 600 qdm-auth.blob "$HOME/.qdm/auth/qdm-auth.blob"
launchctl setenv HARNESS_AUTH_BLOB_FILE "$HOME/.qdm/auth/qdm-auth.blob"
launchctl setenv HARNESS_AUTH_USER_ID "<user-id>"
```

PowerShell auth rewriting is not supported in this milestone. M1/M2 expose the Blob in `updatedInput.command`; use only for local validation or controlled pilots until a Keychain/Broker integration removes it from command text.

## Manual transport smoke

```bash
printf '%s' '{"session_id":"workbuddy-debug","prompt":"销售额最近怎么样？","cwd":"'"$PWD"'"}' \
  | CODEBUDDY_PROJECT_DIR="$PWD" \
    node agents/workbuddy/scripts/harness-hook.mjs context

printf '%s' '{"session_id":"workbuddy-debug","tool_name":"Bash","tool_input":{"command":"bin/data-harness-cli stage template"},"cwd":"'"$PWD"'"}' \
  | CODEBUDDY_PROJECT_DIR="$PWD" \
    node agents/workbuddy/scripts/harness-hook.mjs posttool

printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"qdm-metric-cli auth describe"},"cwd":"'"$PWD"'"}' \
  | CODEBUDDY_PROJECT_DIR="$PWD" WORKBUDDY_APP_PATH="/Applications/WorkBuddy.app" \
    node agents/workbuddy/scripts/harness-hook.mjs authz
```
