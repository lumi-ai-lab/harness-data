import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function confirm(message, options = {}) {
  if (options.yes) return true;
  const suffix = options.defaultNo ? " [y/N] " : " [Y/n] ";
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(message + suffix)).trim().toLowerCase();
    if (!answer) return !options.defaultNo;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export async function chooseAgent(options = {}) {
  if (options.agent) return options.agent;
  if (options.yes) throw new Error("non-interactive install requires --agent claude|codex|both");
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Choose Agent: claude, codex, both [codex] ")).trim().toLowerCase();
    const value = answer || "codex";
    if (!["claude", "codex", "both"].includes(value)) throw new Error("agent must be claude, codex, or both");
    return value;
  } finally {
    rl.close();
  }
}
