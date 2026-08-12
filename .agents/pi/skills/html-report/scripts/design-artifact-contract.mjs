/** Fixed paths and fingerprints for the two B5 visual acceptance screenshots. */
import { access, lstat, readFile, stat } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import { sha256Text } from "./report-content-binding.mjs";

export const DESIGN_SCREENSHOT_SPECS = Object.freeze([
  Object.freeze({ id: "desktop", viewport: "1440,1000", filename: "desktop-1440x1000.png" }),
  Object.freeze({ id: "mobile", viewport: "390,844", filename: "mobile-390x844.png" }),
]);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function screenshotSpecsForSession(sessionDir) {
  const reportDir = join(resolve(sessionDir), "report");
  return DESIGN_SCREENSHOT_SPECS.map((spec) => ({
    ...spec,
    path: join(reportDir, "screenshots", spec.filename),
  }));
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngViewport(data) {
  if (!Buffer.isBuffer(data) || data.length < 45 ||
      !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return null;
  let offset = 8;
  let ihdr = null;
  const idat = [];
  let ended = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) return null;
    const type = data.subarray(offset + 4, offset + 8);
    const typeName = type.toString("ascii");
    const body = data.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = data.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([type, body])) !== declaredCrc) return null;
    if (!ihdr && typeName !== "IHDR") return null;
    if (typeName === "IHDR") {
      if (ihdr || length !== 13) return null;
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (typeName === "IDAT") {
      idat.push(body);
    } else if (typeName === "IEND") {
      if (length !== 0 || end !== data.length) return null;
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended || !ihdr || !idat.length || ihdr.width <= 0 || ihdr.height <= 0 ||
      ihdr.bitDepth !== 8 || ihdr.compression !== 0 || ihdr.filter !== 0 || ihdr.interlace !== 0) return null;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) return null;
  try {
    const pixels = inflateSync(Buffer.concat(idat));
    if (pixels.length !== ihdr.height * (1 + ihdr.width * channels)) return null;
  } catch {
    return null;
  }
  return { width: ihdr.width, height: ihdr.height };
}

export async function validateVisualCheck(sessionDir, visual, html) {
  const abs = resolve(sessionDir);
  const expectedHtmlPath = join(abs, "report", "report.html");
  const errors = [];
  if (!visual || typeof visual !== "object" || Array.isArray(visual)) {
    return ["visual-check.json must contain an object document"];
  }
  if (visual.producer !== "capture-report.mjs") errors.push("visual-check.json producer must be capture-report.mjs");
  if (visual.htmlPath !== expectedHtmlPath) errors.push("visual-check.json htmlPath must be the current fixed report.html");
  if (visual.htmlSha256 !== sha256Text(html)) errors.push("visual-check.json is not bound to the current report.html");
  try {
    const htmlStat = await lstat(expectedHtmlPath);
    if (htmlStat.isSymbolicLink() || !htmlStat.isFile()) {
      errors.push("report.html must be a regular non-symlink file in the current session");
    }
  } catch {
    errors.push("missing current fixed report.html");
  }

  const screenshots = Array.isArray(visual.screenshots) ? visual.screenshots : [];
  if (screenshots.length !== DESIGN_SCREENSHOT_SPECS.length) {
    errors.push("visual-check.json screenshots must contain exactly desktop and mobile");
  }
  const expected = screenshotSpecsForSession(abs);
  for (let index = 0; index < expected.length; index += 1) {
    const spec = expected[index];
    const shot = screenshots[index];
    if (!shot || shot.id !== spec.id) {
      errors.push(`visual-check.json screenshot ${index + 1} must be ${spec.id}`);
      continue;
    }
    if (shot.viewport !== spec.viewport) errors.push(`${spec.id} screenshot viewport must be ${spec.viewport}`);
    if (shot.path !== spec.path) errors.push(`${spec.id} screenshot path must be ${spec.path}`);
    if (!(await exists(spec.path))) {
      errors.push(`missing ${spec.id} report screenshot`);
      continue;
    }
    const linkStat = await lstat(spec.path);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      errors.push(`${spec.id} screenshot must be a regular non-symlink file`);
      continue;
    }
    const [data, fileStat] = await Promise.all([readFile(spec.path), stat(spec.path)]);
    if (!Number.isSafeInteger(shot.bytes) || shot.bytes !== fileStat.size || shot.bytes <= 0) {
      errors.push(`${spec.id} screenshot byte count mismatch`);
    }
    if (shot.sha256 !== sha256Text(data)) errors.push(`${spec.id} screenshot fingerprint mismatch`);
    const viewport = pngViewport(data);
    const [width, height] = spec.viewport.split(",").map(Number);
    if (!viewport || viewport.width !== width || viewport.height < height) {
      errors.push(`${spec.id} full-page screenshot PNG must use viewport width ${width} and height at least ${height}`);
    }
  }
  return errors;
}

export function validateStampedDesignResult(sessionDir, designResult, visual, visualText, html) {
  const abs = resolve(sessionDir);
  const reportDir = join(abs, "report");
  const errors = [];
  if (!designResult || typeof designResult !== "object" || Array.isArray(designResult)) {
    return ["design-result.json must contain an object document"];
  }
  if (designResult.producer !== "finalize-design.mjs" || designResult.status !== "pass") {
    errors.push("design-result.json must be a finalized pass stamp");
  }
  if (designResult.htmlPath !== join(reportDir, "report.html") || designResult.htmlSha256 !== sha256Text(html)) {
    errors.push("design-result.json is not bound to the current fixed report.html");
  }
  if (designResult.visualCheckPath !== join(reportDir, "visual-check.json") ||
      designResult.visualCheckSha256 !== sha256Text(visualText)) {
    errors.push("design-result.json is not bound to the current visual-check.json");
  }
  if (JSON.stringify(designResult.screenshots) !== JSON.stringify(visual?.screenshots)) {
    errors.push("design-result.json screenshots must exactly match visual-check.json");
  }
  const viewportKeys = designResult.viewports && typeof designResult.viewports === "object"
    ? Object.keys(designResult.viewports).sort()
    : [];
  if (viewportKeys.join(",") !== "desktop,mobile" ||
      designResult.viewports?.desktop?.pass !== true ||
      designResult.viewports?.mobile?.pass !== true) {
    errors.push("design-result.json must stamp exactly desktop/mobile visual pass");
  }
  return errors;
}
