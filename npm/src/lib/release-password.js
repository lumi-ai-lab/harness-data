export const RELEASE_ARCHIVE_PASSWORD = "qdm-dev";

export async function collectReleaseArchivePassword(options = {}) {
  if (options._releaseArchivePassword) return options._releaseArchivePassword;
  return RELEASE_ARCHIVE_PASSWORD;
}

export function releaseArchivePassword(options = {}) {
  const password = options._releaseArchivePassword || "";
  if (!password) throw new Error("Release ZIP password is required");
  return password;
}
