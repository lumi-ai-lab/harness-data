import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";

const SIGNAL =
  "QDM_STAGE_TEMPLATE_SIGNAL emitted. Do not use this command stdout as the template. Wait for the PostToolUse hook to inject the selected template for the current session.";

export function runStage(args, io = process) {
  if (args.length < 1) {
    throw new ExitError("usage: data-harness-cli stage <template>");
  }
  if (args[0] !== "template") {
    throw new ExitError(`unknown stage command: ${args[0]}`);
  }
  const { rest } = parseFlags(args.slice(1), {});
  if (rest.length !== 0) {
    throw new ExitError("stage template does not accept arguments");
  }
  io.stdout.write(`${SIGNAL}\n`);
}
