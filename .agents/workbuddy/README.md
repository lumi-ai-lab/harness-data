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
  -> html-report Phase A/continuation prompts return {} here
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

## HTML report Stage Runner (thin entry)

WorkBuddy drives the html-report pipeline through a thin entry that only forwards to the Stage Runner — it does not maintain a second state machine. The Runner is the single owner of Gate state (the `stage-gate` pipeline state file under the session directory); the thin entry only reads and displays it.

```bash
# All commands forward to scripts/html-report-stage-runner.mjs.
node agents/workbuddy/scripts/html-report-workbuddy.mjs start   --session <id> [--phase-a ui|agent] [--question <原问题>]
node agents/workbuddy/scripts/html-report-workbuddy.mjs status  --session <id> [--format text|json]
node agents/workbuddy/scripts/html-report-workbuddy.mjs advance --session <id>
node agents/workbuddy/scripts/html-report-workbuddy.mjs approve --session <id>   # pass a human gate (awaiting_approval)
node agents/workbuddy/scripts/html-report-workbuddy.mjs retry   --session <id> --task <cardId>
node agents/workbuddy/scripts/html-report-workbuddy.mjs cancel  --session <id>
node agents/workbuddy/scripts/html-report-workbuddy.mjs stop    --session <id>   # stop a phase-a qdm-metric-cli ui
```

- `start` defaults to `--phase-a ui`: it opens `qdm-metric-cli ui` (detached worker owns
  the CLI; auto-opens the browser) for the user to build cards and click **保存**, which
  writes `<session>/result.json`. `--question "<原问题>"` persists the original question
  to `<session>/debug/a-config-question.json` (backfilled into `userQuestion` when
  `result.json` omits it). This mirrors the PI html-report Phase A. Pass `--phase-a agent`
  to keep the previous model-parses-and-builds-`result.json` path instead.
- `qdm-metric-cli ui` is a `commandAdmin` command: it requires `QDM_AUTH_BLOB` granting
  both `qdm.metric.query` and `qdm.admin`. The local `config/dev-auth.blob` only grants
  query, so the UI fails with `AUTHORIZATION_FAILED` (code 77). Real runtimes inject auth
  via the host; for manual debugging here, `export QDM_AUTH_BLOB=<admin-capable blob>` before `start --phase-a ui`.
- WorkBuddy's JavaScript adapter automatically suppresses generic Harness wiki recall for html-report turns
  and same-session continuation prompts such as `继续`. This mirrors PI html-report's
  default fixed A_CONFIG path: the model opens `qdm-metric-cli ui` and waits for the
  user to save `<session>/result.json` instead of reading report specs/playbooks first.
- The first html-report prompt also starts the local Stage Runner and opens `qdm-metric-cli ui` automatically.
  After the user saves the configuration, the continuation hook supplies the Stage Runner advance instruction;
  raw child output is not returned to the parent session.
- `stop` terminates the detached `qdm-metric-cli ui` for the session (idempotent; no-op
  when no marker exists) to avoid orphan processes.
- `cancel` terminates registered report child process groups before pausing the current Gate;
  `stop` also terminates registered report children and pauses the Gate when a child is active.
- `status` shows the Runner's Gate state and highlights any human gate (`awaiting_approval`) that needs `approve`.
- `B2_WRITER` processes card writers with bounded parallelism. Default concurrency is `4`; set
  `HTML_REPORT_WRITER_CONCURRENCY=<1-8>` before running `advance` when local resources or child capacity need tuning.
- Run from the Harness runtime workspace root, or pass `--root <path>`.
- Install path is the plugin enable flow above: add the runtime `agents` directory as a Marketplace, install `qdm-harness@lumi-harness-data`, then the scripts (including this thin entry and the Runner) are available under `agents/workbuddy/scripts/`. Validate with `harness-data doctor --dir <runtime>`.

## Hooks

- `PreToolUse` matches macOS `Bash|execute_command`, calls `authz-hook --agent workbuddy`, and only permits gated QDM commands through `updatedInput.command`.
- `UserPromptSubmit` short-circuits html-report Phase A/continuation prompts in `scripts/harness-hook.mjs`; other prompts call `context --format workbuddy-hook` and inject the current `authzMode`.
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
