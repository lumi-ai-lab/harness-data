import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";

const SIGNAL =
  "QDM_INJECT_TEMPLATE_SIGNAL emitted. Do not use this command stdout as the template. Wait for the PostToolUse hook to inject the selected template for the current agent session.";

export function runInjectTemplate(args, io = process) {
  const { rest } = parseFlags(args, {});
  if (rest.length !== 0) {
    throw new ExitError("inject-template does not accept arguments");
  }
  io.stdout.write(`${SIGNAL}\n`);
}
