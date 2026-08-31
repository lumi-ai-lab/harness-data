import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";
import { printJSON } from "../lib/json-out.js";

export function runPaths(context, args, io = process) {
  const parsed = parseFlags(args, { json: { type: "boolean", default: false } });
  if (parsed.rest.length) throw new ExitError("paths does not accept positional arguments", { code: 2 });
  if (!context) throw new ExitError("QDM_CONTEXT_INVALID: paths requires a structured Root Context", { code: 2 });
  if (parsed.values.json) {
    printJSON(context, io.stdout);
    return;
  }
  for (const [name, value] of Object.entries(context)) {
    if (name === "capabilities") {
      io.stdout.write(`${name}\t${JSON.stringify(value)}\n`);
    } else if (name === "secretRef") {
      io.stdout.write(`${name}\t${value ? JSON.stringify(value) : ""}\n`);
    } else {
      io.stdout.write(`${name}\t${value ?? ""}\n`);
    }
  }
}
