import { installCommand } from "./commands/install.js";
import { updateCommand } from "./commands/update.js";
import { doctorCommand } from "./commands/doctor.js";
import { versionCommand } from "./commands/version.js";

const commands = new Set(["install", "update", "doctor", "version"]);

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
    if (["yes", "skipWikisCheck", "check", "json"].includes(key)) {
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
  if (command === "doctor") return doctorCommand(options);
  if (command === "version") return versionCommand(options);
  console.log(`Usage: harness-data <install|update|doctor|version> [options]

Commands:
  install  Install a Harness Data runtime in the current directory
  update   Interactively check and apply runtime, CLI, and wikis updates
  doctor   Diagnose workspace CLI, config, auth, index, and Agent hooks
  version  Print installer, repository, wikis, and manifest versions

Install options:
  --dir PATH                         Runtime directory (default: current directory)
  --agent NAME                       claude, codex, pi, openclaw, hermes, both, or all
  --github-token TOKEN               GitHub token for private Release assets`);
  if (unknown) process.exitCode = 1;
}
