import { existsSync, lstatSync, statSync } from "node:fs";
import path from "node:path";

export function fromSlash(value) {
  return path.sep === "\\" ? String(value).replaceAll("/", "\\") : String(value);
}

export function toSlash(value) {
  return String(value).replaceAll("\\", "/");
}

export function cleanRelPath(rel) {
  const trimmed = String(rel ?? "").trim();
  return toSlash(path.normalize(fromSlash(trimmed)));
}

export function pathJoinClean(base, elem) {
  const cleanedBase = cleanRelPath(base);
  if (cleanedBase === "" || cleanedBase === ".") return cleanRelPath(elem);
  return cleanRelPath(`${cleanedBase}/${elem}`);
}

export function exists(filePath) {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function lstatMode(filePath) {
  return lstatSync(filePath);
}

export function isAbsolutePath(value) {
  return path.isAbsolute(fromSlash(value));
}

export { existsSync };
