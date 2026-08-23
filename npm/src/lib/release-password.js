import { askSecret } from "./prompt.js";

export async function collectReleaseArchivePassword(options = {}) {
  if (options._releaseArchivePassword) return options._releaseArchivePassword;
  const password = process.env.HARNESS_RELEASE_PASSWORD || "";
  if (password) return password;
  if (options.yes || !process.stdin.isTTY) {
    throw new Error("HARNESS_RELEASE_PASSWORD is required for non-interactive install and update");
  }
  const entered = await askSecret("请输入 Release ZIP 密码：", options);
  if (!entered) throw new Error("Release ZIP password is required");
  return entered;
}

export function releaseArchivePassword(options = {}) {
  const password = options._releaseArchivePassword || "";
  if (!password) throw new Error("Release ZIP password is required");
  return password;
}
