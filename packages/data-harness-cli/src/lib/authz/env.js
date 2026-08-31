import { AUTH_SOURCE_ENV_KEYS } from "./constants.js";

export function environMap(env = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value != null) out[key] = String(value);
  }
  return out;
}

export function authSourceEnvPresent(env) {
  const map = env || environMap();
  return AUTH_SOURCE_ENV_KEYS.some((key) => String(map[key] || "").trim() !== "");
}

export function scrubAuthSourceEnvCommand(command) {
  return `unset ${AUTH_SOURCE_ENV_KEYS.join(" ")}; ${command}`;
}

export function scrubAuthSourceEnvPowerShellCommand(command) {
  const paths = AUTH_SOURCE_ENV_KEYS.map((key) => `Env:${key}`);
  return `Remove-Item ${paths.join(",")} -ErrorAction SilentlyContinue; ${command}`;
}
