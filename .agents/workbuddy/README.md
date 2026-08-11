# QDM Harness WorkBuddy Plugin

This package connects WorkBuddy 5.3.8+ to the existing Harness runtime through native plugin hooks.

## Runtime flow

```text
UserPromptSubmit / PreToolUse / PostToolUse
        -> scripts/harness-hook.mjs
        -> data-harness-cli context/posttool/authz-hook
        -> (authorized QDM commands only) data-harness-cli authz-exec
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
- `PreToolUse` matches `Bash|PowerShell|execute_command` and calls `authz-hook --agent workbuddy`. For authz-on gated QDM commands, Bash is replaced with a trusted `authz-exec` broker command while PowerShell is denied with `QDM_AUTHZ_POWERSHELL_HOST_UNSUPPORTED`; authz-off remains a no-op.
- `PostToolUse` matches `Bash|PowerShell|execute_command`, normalizes the tool name to `Bash`, and calls `posttool --format workbuddy-hook`.
- Outside a Harness workspace, all hooks return an empty object and do not alter normal WorkBuddy behavior.
- Adapter and CLI failures return the same safety message through model-visible `additionalContext` and host-visible `systemMessage`, so failures are explicit without guessing data or templates.
- WorkBuddy requires a stable `session_id`; its namespaced session key is stored under a collision-resistant SHA-256 filename and never falls back to shared `unknown` state.

## Authorization

When `authz.mode=on`, `qdm-metric-cli analysis execute` and `qdm-metric-cli auth describe` must use WorkBuddy's Bash tool. The execution-time hook removes model-supplied authorization flags and replaces the Bash invocation with the trusted `data-harness-cli authz-exec --agent workbuddy -- ...` broker. The broker resolves the configured Local Blob internally, launches the real metric CLI, and scrubs authorization-source environment variables from the child process. The blob is never placed in WorkBuddy's `updatedInput`, context, or Harness session state. Missing or invalid authorization denies the gated command.

WorkBuddy 5.3.8's sandboxed PowerShell/ConPTY path does not return command stdout/stderr. Gated QDM commands submitted to PowerShell therefore fail closed before credentials are resolved and instruct the model to retry with Bash. The plugin does not disable WorkBuddy's sandbox or set `dangerouslyDisableSandbox`.

The model must not invoke `authz-exec` directly. Windows WorkBuddy 5.3.8 passed the fix2 real-host regression matrix for stdout/stderr delivery, command replacement, deny zero side effects, and session/history redaction. Production installation may therefore explicitly select `--agent workbuddy --data-auth`; `doctor` still verifies the host contract, minimum client version, plugin package, authorization source, and user binding.

## Manual transport smoke

```bash
printf '%s' '{"session_id":"workbuddy-debug","prompt":"销售额最近怎么样？","cwd":"'"$PWD"'"}' \
  | CODEBUDDY_PROJECT_DIR="$PWD" \
    node agents/workbuddy/scripts/harness-hook.mjs context

printf '%s' '{"session_id":"workbuddy-debug","tool_name":"Bash","tool_input":{"command":"bin/data-harness-cli stage template"},"cwd":"'"$PWD"'"}' \
  | CODEBUDDY_PROJECT_DIR="$PWD" \
    node agents/workbuddy/scripts/harness-hook.mjs posttool

printf '%s' '{"session_id":"workbuddy-debug","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"./bin/qdm-metric-cli.exe auth describe --resolve-labels=false"},"cwd":"'"$PWD"'"}' \
  | CODEBUDDY_PROJECT_DIR="$PWD" \
    node agents/workbuddy/scripts/harness-hook.mjs authz
```
