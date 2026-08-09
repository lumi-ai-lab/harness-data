# QDM Harness WorkBuddy Plugin

This package connects WorkBuddy 5.3.5+ to the existing Harness runtime through native plugin hooks.

## Runtime flow

```text
UserPromptSubmit / PostToolUse
        -> scripts/harness-hook.mjs
        -> data-harness-cli --format workbuddy-hook
        -> Harness context/session/template core
        -> hookSpecificOutput.additionalContext
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

- `UserPromptSubmit` calls `context --format workbuddy-hook`.
- `PostToolUse` matches `Bash|PowerShell|execute_command`, normalizes the tool name to `Bash`, and calls `posttool --format workbuddy-hook`.
- Outside a Harness workspace, both hooks return an empty object and do not alter normal WorkBuddy behavior.
- Adapter and CLI failures return the same safety message through model-visible `additionalContext` and host-visible `systemMessage`, so failures are explicit without guessing data or templates.
- WorkBuddy requires a stable `session_id`; its namespaced session key is stored under a collision-resistant SHA-256 filename and never falls back to shared `unknown` state.

## Current limitation

WorkBuddy support currently requires `authz.mode=off`. Data-permission/auth-blob injection is not implemented. Do not use `--agent workbuddy` together with installer `--data-auth`.

## Manual transport smoke

```bash
printf '%s' '{"session_id":"workbuddy-debug","prompt":"销售额最近怎么样？","cwd":"'"$PWD"'"}' \
  | CODEBUDDY_PROJECT_DIR="$PWD" \
    node agents/workbuddy/scripts/harness-hook.mjs context

printf '%s' '{"session_id":"workbuddy-debug","tool_name":"Bash","tool_input":{"command":"bin/data-harness-cli stage template"},"cwd":"'"$PWD"'"}' \
  | CODEBUDDY_PROJECT_DIR="$PWD" \
    node agents/workbuddy/scripts/harness-hook.mjs posttool
```
