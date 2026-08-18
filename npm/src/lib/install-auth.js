import { AUTH_OFF_PASSWORD } from "./config.js";
import { ask, askSecret } from "./prompt.js";

export function assertAuthBlobFormat(blob) {
  const value = String(blob || "").trim();
  if (!value) throw new Error("auth blob is required; use --no-auth to skip");
  if (!value.startsWith("qdm1enc.")) throw new Error("auth blob must start with qdm1enc.");
  return value;
}

export function assertAuthUserId(userId) {
  const value = String(userId || "").trim();
  if (!value) throw new Error("dev_user_id is required; use --no-auth to skip");
  return value;
}

export async function collectInstallAuth(options = {}) {
  if (options.noAuth) {
    const password = options.authOffPassword
      || (options.yes ? "" : await askSecret("请输入关闭权限密码：", options));
    if (password !== AUTH_OFF_PASSWORD) throw new Error("关闭权限密码错误，安装中止");
    return { mode: "no-auth" };
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
