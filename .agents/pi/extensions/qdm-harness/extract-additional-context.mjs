import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8").trim();
if (!input) process.exit(0);

try {
  const payload = JSON.parse(input);
  const context = payload?.hookSpecificOutput?.additionalContext;
  if (typeof context === "string" && context.trim()) {
    process.stdout.write(`\n${context.trim()}\n`);
  }
} catch {
  process.stdout.write(input);
}
