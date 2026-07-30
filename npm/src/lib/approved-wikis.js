import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function validSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRelativeFile(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  if (value !== path.posix.normalize(value) || value === "." || value.startsWith("../")) return false;
  return !value.split("/").includes(".git");
}

export function parseApprovedWikisManifest(raw) {
  let document;
  try {
    document = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  } catch (error) {
    throw new Error(`approved Wikis content manifest is not valid JSON: ${error.message}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).sort().join(",") !== "files,version" || document.version !== 1 || !Array.isArray(document.files)) {
    throw new Error("approved Wikis content manifest must use the exact version 1 schema");
  }
  if (document.files.length === 0 || document.files.length > 10000) {
    throw new Error("approved Wikis content manifest has an invalid file count");
  }
  const files = [];
  const seen = new Set();
  for (const entry of document.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "path,sha256" ||
        !validRelativeFile(entry.path) || !validSha256(entry.sha256)) {
      throw new Error("approved Wikis content manifest contains an invalid file entry");
    }
    if (seen.has(entry.path)) throw new Error(`approved Wikis content manifest repeats ${entry.path}`);
    seen.add(entry.path);
    files.push({ path: entry.path, sha256: entry.sha256 });
  }
  const ordered = [...files].sort((left, right) => compareCodeUnits(left.path, right.path));
  if (files.some((entry, index) => entry.path !== ordered[index].path)) {
    throw new Error("approved Wikis content manifest files must be sorted by path");
  }
  for (const required of ["index.md", "metrics/", "reports/", "dims/", "rules/"]) {
    const present = required.endsWith("/")
      ? files.some((entry) => entry.path.startsWith(required))
      : files.some((entry) => entry.path === required);
    if (!present) throw new Error(`approved Wikis content manifest is missing ${required}`);
  }
  return { version: 1, files };
}

function listSourceFiles(root, directory = root, files = []) {
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`approved Wikis content contains a symlink: ${absolute}`);
    if (info.isDirectory()) {
      if (name === ".git") throw new Error("approved Wikis content must not include Git metadata");
      listSourceFiles(root, absolute, files);
      continue;
    }
    if (!info.isFile() || info.size > 4 * 1024 * 1024) {
      throw new Error(`approved Wikis content contains an unsafe file: ${absolute}`);
    }
    files.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return files;
}

export function verifyApprovedWikisSource(source, manifestFile, expectedManifestSha256) {
  const root = path.resolve(source);
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("approved Wikis source must be a regular directory");
  }
  const rawManifest = fs.readFileSync(manifestFile);
  const manifestSha256 = sha256(rawManifest);
  if (!validSha256(expectedManifestSha256) || manifestSha256 !== expectedManifestSha256) {
    throw new Error("approved Wikis content manifest sha256 does not match the release contract");
  }
  const manifest = parseApprovedWikisManifest(rawManifest);
  const actualFiles = listSourceFiles(root).sort(compareCodeUnits);
  const expectedFiles = manifest.files.map((entry) => entry.path);
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error("approved Wikis source file set does not match its allowlist manifest");
  }
  for (const entry of manifest.files) {
    const actual = sha256(fs.readFileSync(path.join(root, ...entry.path.split("/"))));
    if (actual !== entry.sha256) throw new Error(`approved Wikis source digest does not match for ${entry.path}`);
  }
  return { manifest, manifestSha256, source: root };
}
