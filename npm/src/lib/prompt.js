import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const agentChoices = ["claude", "codex", "pi", "both", "all"];

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
  if (options.agent) {
    const value = String(options.agent).trim().toLowerCase();
    if (!agentChoices.includes(value)) throw new Error("agent must be claude, codex, pi, both, or all");
    return value;
  }
  if (options.yes) throw new Error("non-interactive install requires --agent claude|codex|pi|both|all");
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Choose Agent: claude, codex, pi, both, all [codex] ")).trim().toLowerCase();
    const value = answer || "codex";
    if (!agentChoices.includes(value)) throw new Error("agent must be claude, codex, pi, both, or all");
    return value;
  } finally {
    rl.close();
  }
}
