import { askSecret } from "./prompt.js";

// There is intentionally no production default. The archive password is a
// release credential and must be supplied by the caller or entered privately.
export const RELEASE_ARCHIVE_PASSWORD = "";

export async function collectReleaseArchivePassword(options = {}) {
  const configured = options._releaseArchivePassword
    || options.releaseArchivePassword
    || (options.env || process.env).HARNESS_RELEASE_ARCHIVE_PASSWORD
    || "";
  if (configured) return String(configured);
  if (options.noArchivePasswordPrompt || options.yes) {
    throw new Error("Release ZIP password is required; use --release-archive-password or HARNESS_RELEASE_ARCHIVE_PASSWORD");
  }
  return askSecret("请输入加密 Release ZIP 解压密码：", options);
}

export function releaseArchivePassword(options = {}) {
  const password = options._releaseArchivePassword
    || options.releaseArchivePassword
    || (options.env || process.env).HARNESS_RELEASE_ARCHIVE_PASSWORD
    || "";
  if (!password) throw new Error("Release ZIP password is required");
  return String(password);
}
