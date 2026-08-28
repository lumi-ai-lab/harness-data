import { ask, askSecret } from "./prompt.js";

export function assertAuthBlobFormat(blob) {
  const value = String(blob || "").trim();
  if (!value) throw new Error("auth blob is required");
  if (!value.startsWith("qdm1enc.")) throw new Error("auth blob must start with qdm1enc.");
  return value;
}

export function assertAuthUserId(userId) {
  const value = String(userId || "").trim();
  if (!value) throw new Error("dev_user_id is required");
  return value;
}

export async function collectInstallAuth(options = {}) {
  if (Object.hasOwn(options, "noAuth")) {
    throw new Error("--no-auth has been removed; install requires authorization");
  }
  if (Object.hasOwn(options, "authOffPassword")) {
    throw new Error("--auth-off-password has been removed");
  }
  if (Object.hasOwn(options, "admin")) {
    throw new Error("--admin is not supported; use --dev");
  }
  if (options.dev) {
    const password = String(options.devPassword || "").trim();
    if (!password && options.yes) throw new Error("--dev-password is required when --yes is set");
    return { mode: "dev", password: password || await askSecret("请输入 qdm-metric-cli dev 密码：", options) };
  }

  if (options.dataAuth) return { mode: "data-auth" };

  const rawBlob = options.authBlob || process.env.HARNESS_AUTH_BLOB || "";
  const blobContent = assertAuthBlobFormat(
    rawBlob || (options.yes ? "" : await askSecret("请输入权限 BLOB（加密 JSON，qdm1enc...）：", options))
  );

  const rawUserId = options.authUserId || process.env.HARNESS_AUTH_USER_ID || "";
  const devUserId = assertAuthUserId(
    rawUserId || (options.yes ? "" : await ask("请输入 dev_user_id：", options))
  );

  return { mode: "auth-blob", blobContent, devUserId };
}
