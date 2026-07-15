import { run } from "./exec.js";
import { protocolFromUrl, runGitWithProtocol } from "./git-auth.js";

export async function runWikisGit(wikisDir, args, options = {}) {
  const remote = (await run("git", ["-C", wikisDir, "remote", "get-url", "origin"], { ...options, allowFailure: true })).stdout.trim();
  const protocol = protocolFromUrl(remote);
  if (!protocol) return run("git", ["-C", wikisDir, ...args], options);
  return runGitWithProtocol(protocol, ["-C", wikisDir, ...args], options);
}

export async function remoteDefaultRef(wikisDir, options = {}) {
  const result = await run("git", ["-C", wikisDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { ...options, allowFailure: true });
  const remoteRef = result.stdout.trim();
  if (!remoteRef) throw new Error("harness-data-wikis 无法确定远程默认分支");
  return remoteRef;
}

export async function forceSyncWikis(wikisDir, options = {}, syncOptions = {}) {
  if (!syncOptions.fetched) await runWikisGit(wikisDir, ["fetch", "origin"], options);
  const remoteRef = await remoteDefaultRef(wikisDir, options);
  const defaultBranch = remoteRef.replace(/^origin\//, "");

  // wikis 是安装器托管的只读副本。本地修改、未跟踪文件和本地提交均不保留。
  await run("git", ["-C", wikisDir, "reset", "--hard", "HEAD"], options);
  await run("git", ["-C", wikisDir, "clean", "-fd"], options);
  await run("git", ["-C", wikisDir, "checkout", "-B", defaultBranch, remoteRef], options);
  await run("git", ["-C", wikisDir, "reset", "--hard", remoteRef], options);
  await run("git", ["-C", wikisDir, "clean", "-fd"], options);

  const commit = (await run("git", ["-C", wikisDir, "rev-parse", "HEAD"], options)).stdout.trim();
  return { commit, remoteRef, defaultBranch };
}
