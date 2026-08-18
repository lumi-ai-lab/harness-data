import { askSecret } from "./prompt.js";

export const MAX_AUTH_BLOB_BYTES = 64 * 1024;

export function assertAuthBlobFormat(blob) {
  const value = String(blob || "").trim();
  if (!value) throw new Error("auth blob is required; pass --auth-blob or use the interactive prompt");
  if (Buffer.byteLength(value, "utf8") > MAX_AUTH_BLOB_BYTES) throw new Error("auth blob is too large");
  if (/\s/u.test(value)) throw new Error("auth blob must not contain whitespace");
  if (!value.startsWith("qdm1enc.")) throw new Error("auth blob must start with qdm1enc.");
  return value;
}

export async function collectInstallAuth(options = {}) {
  for (const [key, flag] of [["noAuth", "--no-auth"], ["authOffPassword", "--auth-off-password"], ["dataAuth", "--data-auth"], ["authUserId", "--auth-user-id"]]) {
    if (Object.hasOwn(options, key)) throw new Error(`${flag} is no longer supported; use --auth-blob`);
  }
  const rawBlob = typeof options.authBlob === "string" ? options.authBlob : "";
  if (!rawBlob && (options.yes || !process.stdin.isTTY)) {
    throw new Error("non-interactive install requires explicit --auth-blob");
  }
  const blobContent = assertAuthBlobFormat(rawBlob || await askSecret("请输入权限 BLOB（加密 JSON，qdm1enc...）：", options));
  return { mode: "auth-blob", blobContent };
}
