import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./exec.js";

export const gitUrls = {
  ssh: {
    repo: "git@github.com:lumi-ai-lab/harness-data.git",
    wikis: "git@github.com:lumi-ai-lab/harness-data-wikis.git"
  },
  https: {
    repo: "https://github.com/lumi-ai-lab/harness-data.git",
    wikis: "https://github.com/lumi-ai-lab/harness-data-wikis.git"
  }
};

const protocols = new Set(["auto", "ssh", "https"]);

export function normalizeGitProtocol(value = "auto") {
  if (!protocols.has(value)) throw new Error("--git-protocol must be one of: auto, ssh, https");
  return value;
}

export function protocolFromUrl(url = "") {
  if (url.startsWith("git@") || url.startsWith("ssh://")) return "ssh";
  if (url.startsWith("https://")) return "https";
  return "";
}

export async function repoUrl(workspace) {
  const result = await run("git", ["remote", "get-url", "origin"], { cwd: workspace, allowFailure: true });
  return result.stdout.trim();
}

export async function repoProtocol(workspace) {
  return protocolFromUrl(await repoUrl(workspace));
}

function httpsFailureMessage() {
  return [
    "HTTPS access to the private GitHub repositories failed.",
    "Fix by configuring a GitHub SSH key, running gh auth login, enabling Git Credential Manager,",
    "or passing --github-token TOKEN."
  ].join(" ");
}

function tokenEnvName(options = {}) {
  return options.githubToken || process.env.GITHUB_TOKEN || "";
}

async function withHttpsAuthEnv(options, callback) {
  const token = tokenEnvName(options);
  if (!token) return callback({ GIT_TERMINAL_PROMPT: "0" });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-git-"));
  const askpass = path.join(dir, "askpass.sh");
  fs.writeFileSync(askpass, [
    "#!/bin/sh",
    "case \"$1\" in",
    "*Username*) printf '%s\\n' x-access-token ;;",
    "*Password*) printf '%s\\n' \"$GITHUB_TOKEN_VALUE\" ;;",
    "*) printf '\\n' ;;",
    "esac",
    ""
  ].join("\n"), { mode: 0o700 });

  try {
    return await callback({
      GIT_ASKPASS: askpass,
      GITHUB_TOKEN_VALUE: token,
      GIT_TERMINAL_PROMPT: "0"
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runGitWithProtocol(protocol, commandArgs, options = {}) {
  if (protocol === "https") {
    return withHttpsAuthEnv(options, (env) => run("git", commandArgs, { ...options, env: { ...(options.env || {}), ...env } }));
  }
  const env = {
    ...(options.env || {}),
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
  };
  return run("git", commandArgs, { ...options, env });
}

async function canAccess(protocol, url, options) {
  const result = await runGitWithProtocol(protocol, ["ls-remote", url, "HEAD"], { ...options, allowFailure: true });
  return result.code === 0;
}

export async function resolveInstallProtocol(options = {}) {
  const requested = normalizeGitProtocol(options.gitProtocol);
  if (requested === "ssh") {
    if (await canAccess("ssh", gitUrls.ssh.wikis, options)) return "ssh";
    throw new Error("SSH access to the private GitHub repositories failed. Configure a GitHub SSH key or retry with --git-protocol https.");
  }
  if (requested === "https") {
    if (await canAccess("https", gitUrls.https.wikis, options)) return "https";
    throw new Error(httpsFailureMessage());
  }
  if (await canAccess("ssh", gitUrls.ssh.wikis, options)) return "ssh";
  console.warn("SSH unavailable, falling back to HTTPS");
  if (await canAccess("https", gitUrls.https.wikis, options)) return "https";
  throw new Error(httpsFailureMessage());
}

export async function syncWikisSubmodule(workspace, protocol, options = {}) {
  await run("git", ["config", "submodule.wikis.url", gitUrls[protocol].wikis], { cwd: workspace, stdio: options.stdio || "inherit" });
  await run("git", ["submodule", "sync", "wikis"], { cwd: workspace, stdio: options.stdio || "inherit" });
}
