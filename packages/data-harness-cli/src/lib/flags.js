import { ExitError } from "./exit.js";

/**
 * Minimal Go-flag compatible parser: --name, --name=value, --bool.
 *
 * @param {string[]} args
 * @param {Record<string, { type: "string" | "boolean" | "number", default: string | boolean | number }>} spec
 * @returns {{ values: Record<string, string | boolean>, rest: string[] }}
 */
export function parseFlags(args, spec) {
  /** @type {Record<string, string | boolean>} */
  const values = {};
  for (const [name, def] of Object.entries(spec)) {
    values[name] = def.default;
  }
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      throw new ExitError("help", { code: 0 });
    }
    if (!arg.startsWith("-") || arg === "-") {
      rest.push(arg);
      continue;
    }
    const raw = arg.replace(/^--?/, "");
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : null;
    const def = spec[name];
    if (!def) {
      throw new ExitError(`flag provided but not defined: -${name}`, { code: 2 });
    }
    if (def.type === "boolean") {
      if (inline == null) {
        values[name] = true;
      } else {
        values[name] = parseBoolFlag(inline, name);
      }
      continue;
    }
    const rawValue = inline != null ? inline : args[i + 1];
    if (inline == null) {
      if (rawValue == null || String(rawValue).startsWith("-")) {
        throw new ExitError(`flag needs an argument: -${name}`, { code: 2 });
      }
      i += 1;
    }
    if (def.type === "number") {
      const parsed = Number(rawValue);
      if (!Number.isInteger(parsed)) {
        throw new ExitError(`invalid value ${JSON.stringify(rawValue)} for -${name}`, { code: 2 });
      }
      values[name] = parsed;
      continue;
    }
    values[name] = rawValue;
  }
  return { values, rest };
}

function parseBoolFlag(value, name) {
  switch (String(value).toLowerCase()) {
    case "1":
    case "t":
    case "true":
      return true;
    case "0":
    case "f":
    case "false":
      return false;
    default:
      throw new ExitError(`invalid boolean value ${JSON.stringify(value)} for -${name}`, { code: 2 });
  }
}
