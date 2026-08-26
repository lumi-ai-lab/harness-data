import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";

const actions = new Set(["install", "doctor", "uninstall"]);

export async function qwenpawCommand(options = {}) {
  const action = String(options._?.[0] || "").toLowerCase();
  if (!actions.has(action)) throw new Error("usage: harness-data qwenpaw <install|doctor|uninstall> [options]");
  const runtime = path.resolve(options.runtime || options.dir || process.cwd());
  const source = path.resolve(options.source || path.join(runtime, "agents", "qwenpaw"));
  const script = path.join(source, "install-qwenpaw-plugin.py");
  if (!fs.existsSync(script)) throw new Error(`QwenPaw plugin source is missing: ${script}`);
  const python = options.qwenpawPython || "python";
  const args = [script, action, "--runtime", runtime, "--source", source];
  if (options.qwenpawWorkingDir) args.push("--qwenpaw-working-dir", options.qwenpawWorkingDir);
  if (options.agentId) args.push("--agent-id", options.agentId);
  if (options.agentConfig) args.push("--agent-config", options.agentConfig);
  if (action === "install") args.push("--user-id-display-mode", options.userIdDisplayMode || "off");
  const result = await run(python, args, { cwd: runtime });
  if (result.stdout.trim()) console.log(result.stdout.trim());
}
