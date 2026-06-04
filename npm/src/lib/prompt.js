import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";

const agentChoices = ["claude", "codex", "pi", "all"];

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
    if (!agentChoices.includes(value)) throw new Error("agent must be claude, codex, pi, or all");
    return value;
  }
  if (options.yes) return "all";
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Choose Agent: claude, codex, pi, all [all] ")).trim().toLowerCase();
    const value = answer || "all";
    if (!agentChoices.includes(value)) throw new Error("agent must be claude, codex, pi, or all");
    return value;
  } finally {
    rl.close();
  }
}

export async function ask(message, options = {}) {
  if (options.value) return String(options.value);
  if (options.yes) throw new Error(`${message} is required`);
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(`${message} `)).trim();
  } finally {
    rl.close();
  }
}

export async function askSecret(message, options = {}) {
  if (options.value) return String(options.value);
  if (options.yes) throw new Error(`${message} is required`);
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  output.write(`${message} `);
  const rl = readline.createInterface({ input, output: muted, terminal: true });
  try {
    const answer = (await rl.question("")).trim();
    output.write("\n");
    return answer;
  } finally {
    rl.close();
  }
}
