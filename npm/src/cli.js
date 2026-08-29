import { installCommand } from "./commands/install.js";
import { migrateCommand } from "./commands/migrate.js";
import { updateCommand } from "./commands/update.js";
import { doctorCommand } from "./commands/doctor.js";
import { pathsCommand } from "./commands/paths.js";
import { reportCommand } from "./commands/report.js";
import { setupCommand } from "./commands/setup.js";
import { versionCommand } from "./commands/version.js";
import { qwenpawCommand } from "./commands/qwenpaw.js";

const commands = new Set(["install", "update", "setup", "doctor", "paths", "report", "migrate", "version", "qwenpaw"]);

function parse(argv) {
  const args = argv.slice(2);
  const unknown = Boolean(args[0] && !commands.has(args[0]));
  const command = commands.has(args[0]) ? args.shift() : "help";
  const options = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (["yes", "skipWikisCheck", "check", "json", "dataAuth", "noAuth", "skipMetricCli", "downloadMetricCli"].includes(key)) {
      options[key] = inline === undefined ? true : inline !== "false";
    } else {
      options[key] = inline ?? args[++i];
    }
  }
  return { command, options, unknown };
}

export async function main(argv) {
  const { command, options, unknown } = parse(argv);
  if (command === "install") return installCommand(options);
  if (command === "update") return updateCommand(options);
  if (command === "setup") return setupCommand(options);
  if (command === "doctor") return doctorCommand(options);
  if (command === "paths") return pathsCommand(options);
  if (command === "report") return reportCommand(options);
  if (command === "migrate") return migrateCommand(options);
  if (command === "version") return versionCommand(options);
  if (command === "qwenpaw") return qwenpawCommand(options);
  console.log(`Usage: harness-data <install|update|setup|doctor|paths|report|migrate|version> [options]

Commands:
  install  Install a Harness Data runtime in the current directory
  update   Interactively check and apply runtime, CLI, and wikis updates
  setup    Configure dataRoot, metric-cli, secret reference, and install manifest
  doctor   Diagnose runtime or structured Root Context
  paths    Print structured Root Context roots (use --json for machine output)
  report   Run the explicit html-report lifecycle for a host session
  migrate  Check or copy a legacy install --dir runtime into the dual-root data model
  version  Print installer, repository, wikis, and manifest versions
  qwenpaw  Install, diagnose, or remove the QwenPaw QDM plugin

QwenPaw:
  harness-data qwenpaw <install|doctor|uninstall> [options]

Install options:
  --dir PATH                         Runtime directory (default: current directory)
  --agent NAME                       claude, codex, pi, openclaw, hermes, workbuddy, both, or all
  --release-source SOURCE            auto, gitee, or github (default: auto)
  --github-token TOKEN               GitHub token for private Release assets
  --auth-blob BLOB                   Auth blob string (qdm1enc...); default: interactive prompt
  --auth-user-id ID                  dev_user_id for authz; default: interactive prompt
  --data-auth                        Use built-in local-test fixture blob (dev/test shortcut)
  --no-auth                          Install without authz (requires password)
  --auth-off-password PASSWORD       Password for --no-auth (default: interactive prompt)

Root Context options (setup/doctor/paths/report):
  --context-file PATH                Structured Root Context JSON
  --plugin-root PATH                 Read-only plugin/runtime root
  --data-root PATH                   Persistent non-secret data root
  --secret-root PATH                 Secret reference root
  --workspace-root PATH              Current project root (optional for read-only commands)
  --state-root PATH                  Explicit state root (default: dataRoot/state)
  --secret-ref VALUE                 file path or {kind, ...} reference
  --session-id ID                    Stable host session identifier
  --metric-cli PATH                  Existing qdm-metric-cli executable for setup
  --skip-metric-cli                  Record setup without installing metric-cli
  --download-metric-cli              Download metric-cli from the plugin manifest

Report options:
  report <start|status|advance|approve|retry|cancel|stop> --session ID
  --runner PATH                      html-report runner override
  --phase-a ui|agent                 Phase A mode for report start
  --question TEXT                    Original report question
  --task ID                          Card/task id for retry
  --format text|json                 Runner output format

Migration options:
  migrate --check --from PATH --to PATH --workspace-root PATH [--plugin-root PATH] [--secret-root PATH] [--host HOST] [--json]
  migrate --from PATH --to PATH --workspace-root PATH [--plugin-root PATH] [--secret-root PATH] [--host HOST] [--json]
  --from PATH                        Existing install --dir runtime (absolute path)
  --to PATH                          New persistent dataRoot (absolute path)
  --workspace-root PATH              Explicit project workspace for state identity
  --plugin-root PATH                 Current plugin/runtime root; never inferred from the legacy runtime
  --secret-root PATH                 Required when legacy authz is enabled

Compatibility:
  harness-data <install|update|doctor|migrate|version> [options]

Environment:
  HARNESS_RELEASE_SOURCE             Release source: auto, gitee, or github

Release ZIP password is built in; install and update need no password setup.`);
  if (unknown) process.exitCode = 1;
}
