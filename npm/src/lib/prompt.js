import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import { agentChoices, agentChoiceText } from "./config.js";
import { run } from "./exec.js";
import { warn } from "./log.js";

export async function confirm(message, options = {}) {
  if (options.yes) return true;
  const suffix = options.defaultNo ? " [y/N] " : " [Y/n] ";
  if (!process.stdin.isTTY) {
    const answer = (await shellRead(message + suffix)).toLowerCase();
    if (!answer) return !options.defaultNo;
    return answer === "y" || answer === "yes";
  }
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
  // Windows defaults to Codex but also supports an explicit WorkBuddy plugin.
  if (process.platform === "win32") {
    if (options.agent) {
      const value = String(options.agent).trim().toLowerCase();
      if (!agentChoices.includes(value)) throw new Error(`agent must be ${agentChoiceText}`);
      if (value === "codex" || value === "workbuddy") return value;
      warn(`Windows 当前支持 Codex 或显式 WorkBuddy，已忽略 --agent ${options.agent}`);
    }
    return "codex";
  }
  if (options.agent) {
    const value = String(options.agent).trim().toLowerCase();
    if (!agentChoices.includes(value)) throw new Error(`agent must be ${agentChoiceText}`);
    return value;
  }
  if (options.yes) return "all";
  if (!process.stdin.isTTY) {
    const answer = (await shellRead(`选择 Agent：${agentChoiceText} [all] `)).toLowerCase();
    const value = answer || "all";
    if (!agentChoices.includes(value)) throw new Error(`agent must be ${agentChoiceText}`);
    return value;
  }
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`选择 Agent：${agentChoiceText} [all] `)).trim().toLowerCase();
    const value = answer || "all";
    if (!agentChoices.includes(value)) throw new Error(`agent must be ${agentChoiceText}`);
    return value;
  } finally {
    rl.close();
  }
}

async function shellRead(prompt) {
  const escaped = prompt.replace(/'/g, "'\\''");
  const result = await run("bash", ["-c", `read -p '${escaped}' -r input && echo "$input"`], { stdio: ["inherit", "pipe", "inherit"] });
  return result.stdout.trim();
}

async function shellReadSecret(prompt) {
  const escaped = prompt.replace(/'/g, "'\\''");
  const result = await run("bash", ["-c", `read -s -p '${escaped}' -r input && echo "$input"`], { stdio: ["inherit", "pipe", "inherit"] });
  return result.stdout.trim();
}

export async function ask(message, options = {}) {
  if (options.value) return String(options.value);
  if (options.yes) throw new Error(`${message} is required`);
  if (!process.stdin.isTTY) return shellRead(`${message} `);
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
  if (!process.stdin.isTTY) return shellReadSecret(`${message} `);
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
