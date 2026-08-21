import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { download } from "./manifest.js";
import { run } from "./exec.js";

export const wikisReleaseSource = "gitee-encrypted";
export const wikisReleaseBaseUrl = "https://gitee.com/git_pengmd/harness-release/releases/download";

const encryptionMagic = Buffer.from("QDMWIK1\0");
// 此密钥只避免公开 Release 中的 Wikis 可被直接浏览，不是访问控制。
const encryptionKey = Buffer.from("9mpI8QlIfrfsgnmWo127wHT2dTlTXXO4L934MOTFknU=", "base64");
const requiredDirectories = ["metrics", "reports", "dims", "rules"];

export function encryptedWikisAssetName(tag) {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag || "")) {
    throw new Error(`invalid runtime release tag for Wikis: ${tag || "missing"}`);
  }
  return `harness-data-wikis-${tag}.tar.gz.enc`;
}

export function wikisReleaseUrl(tag, asset, options = {}) {
  const base = (options.wikisReleaseBaseUrl || wikisReleaseBaseUrl).replace(/\/$/, "");
  const releaseTag = options.giteeReleaseTag || tag;
  return `${base}/${encodeURIComponent(releaseTag)}/${encodeURIComponent(asset)}`;
}

export function validateWikisDirectory(source) {
  if (!fs.existsSync(path.join(source, "index.md"))) throw new Error(`harness-data-wikis missing index.md: ${source}`);
  for (const dir of requiredDirectories) {
    if (!fs.existsSync(path.join(source, dir))) throw new Error(`harness-data-wikis missing ${dir}/: ${source}`);
  }
}

function readExpectedSha256(file, asset) {
  const match = fs.readFileSync(file, "utf8").trim().match(/^([a-fA-F0-9]{64})(?:\s+\*?[^\s]+)?$/);
  if (!match) throw new Error(`invalid Wikis sha256 file: ${asset}.sha256`);
  return match[1].toLowerCase();
}

function assertSafeArchiveEntries(listing) {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("Wikis archive is empty");
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (normalized.startsWith("/") || parts.includes("..") || !normalized.startsWith("wikis/")) {
      throw new Error(`unsafe Wikis archive entry: ${entry}`);
    }
  }
}

function assertSafeArchiveTypes(listing) {
  for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
    if (!["-", "d"].includes(entry[0])) {
      throw new Error(`Wikis archive contains unsupported entry type: ${entry}`);
    }
  }
}

function assertNoLinks(root) {
  for (const name of fs.readdirSync(root)) {
    const entry = path.join(root, name);
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error(`Wikis archive contains unsupported symbolic link: ${name}`);
    if (stat.isDirectory()) assertNoLinks(entry);
  }
}

function replaceWikisDirectory(runtimeDir, stagedWikis) {
  const target = path.join(runtimeDir, "wikis");
  const backup = fs.mkdtempSync(path.join(runtimeDir, ".install-backup-wikis-"));
  fs.rmSync(backup, { recursive: true, force: true });
  let replaced = false;
  try {
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(stagedWikis, target);
    replaced = true;
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (replaced) fs.rmSync(target, { recursive: true, force: true });
    if (fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

export async function installEncryptedWikis(runtimeDir, tag, options = {}) {
  const asset = encryptedWikisAssetName(tag);
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, ".install-wikis-"));
  const encrypted = path.join(tempDir, asset);
  const shaFile = `${encrypted}.sha256`;
  const archive = path.join(tempDir, `harness-data-wikis-${tag}.tar.gz`);
  const extracted = path.join(tempDir, "extracted");
  try {
    await download(wikisReleaseUrl(tag, asset, options), encrypted, { "User-Agent": "harness-data-installer" }, {
      ...options,
      progressLabel: asset,
    });
    await download(wikisReleaseUrl(tag, `${asset}.sha256`, options), shaFile, { "User-Agent": "harness-data-installer" }, options);
    const expectedSha256 = readExpectedSha256(shaFile, asset);
    const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(encrypted)).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error("Wikis encrypted asset sha256 mismatch");

    const payload = fs.readFileSync(encrypted);
    const headerSize = encryptionMagic.length + 12 + 16;
    if (payload.length <= headerSize || !payload.subarray(0, encryptionMagic.length).equals(encryptionMagic)) {
      throw new Error("Wikis encrypted asset has invalid magic");
    }
    const iv = payload.subarray(encryptionMagic.length, encryptionMagic.length + 12);
    const authTag = payload.subarray(encryptionMagic.length + 12, headerSize);
    const ciphertext = payload.subarray(headerSize);
    let plaintext;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error("Wikis encrypted asset failed AES-GCM authentication");
    }
    fs.writeFileSync(archive, plaintext, { mode: 0o600 });

    const listing = await run("tar", ["-tzf", archive]);
    assertSafeArchiveEntries(listing.stdout);
    const verboseListing = await run("tar", ["-tvzf", archive]);
    assertSafeArchiveTypes(verboseListing.stdout);
    fs.mkdirSync(extracted);
    await run("tar", ["-xzf", archive, "-C", extracted]);
    const stagedWikis = path.join(extracted, "wikis");
    if (!fs.existsSync(stagedWikis)) throw new Error("Wikis archive missing wikis/");
    assertNoLinks(stagedWikis);
    validateWikisDirectory(stagedWikis);
    replaceWikisDirectory(runtimeDir, stagedWikis);
    return { source: wikisReleaseSource, tag, asset, sha256: actualSha256 };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
