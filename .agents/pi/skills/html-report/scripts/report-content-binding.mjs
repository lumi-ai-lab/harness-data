/** Deterministic bindings between report.md, render-manifest.json and compiled HTML. */
import { createHash } from "node:crypto";
import { extractTitle, markdownToHtml } from "./render-report.mjs";

export function sha256Text(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(String(value), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

export function extractFullTableMarkers(markdown) {
  const markers = [];
  const pattern = /<!--\s*html-report:(full-table|full-explore-table)\s+(card|task)="([^"]+)"\s+rows="(\d+)"\s*-->/g;
  for (const match of String(markdown).matchAll(pattern)) {
    const kind = match[1];
    const owner = match[2];
    if ((kind === "full-table" && owner !== "card") ||
        (kind === "full-explore-table" && owner !== "task")) continue;
    markers.push(kind === "full-table"
      ? { kind, cardId: match[3], rows: Number(match[4]) }
      : { kind, taskId: match[3], rows: Number(match[4]) });
  }
  return markers;
}

export function expectedFullTableMarkers(manifest) {
  const markers = [];
  for (const card of Array.isArray(manifest?.cards) ? manifest.cards : []) {
    if (card?.status !== "ok") continue;
    markers.push({ kind: "full-table", cardId: String(card.cardId || ""), rows: card.sourceRows });
  }
  for (const task of Array.isArray(manifest?.tasks) ? manifest.tasks : []) {
    if (task?.status !== "ok" || task?.mode !== "new_query") continue;
    markers.push({ kind: "full-explore-table", taskId: String(task.taskId || ""), rows: task.sourceRows });
  }
  return markers;
}

export function markerComment(marker) {
  return marker.kind === "full-explore-table"
    ? `<!-- html-report:full-explore-table task="${marker.taskId}" rows="${marker.rows}" -->`
    : `<!-- html-report:full-table card="${marker.cardId}" rows="${marker.rows}" -->`;
}

export function compileContentBinding(markdown) {
  const body = `<article class="report-content" data-html-report-content="immutable">\n${markdownToHtml(markdown)}\n</article>`;
  const contentSha256 = sha256Text(body);
  const content = [
    `<!-- html-report:content-start sha256="${contentSha256}" -->`,
    body,
    "<!-- html-report:content-end -->",
    "",
  ].join("\n");
  return {
    title: extractTitle(markdown),
    body,
    content,
    markdownSha256: sha256Text(markdown),
    contentSha256,
    contentFileSha256: sha256Text(content),
    fullTableMarkers: extractFullTableMarkers(markdown),
  };
}

export function validateReportManifestBinding(markdown, manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["report/render-manifest.json must contain an object document"];
  }
  if (manifest.producer !== "assemble-report.mjs") {
    errors.push("report/render-manifest.json producer must be assemble-report.mjs");
  }
  if (manifest.reportSha256 !== sha256Text(markdown)) {
    errors.push("report/render-manifest.json reportSha256 does not match report/report.md");
  }
  const actual = extractFullTableMarkers(markdown);
  const expected = expectedFullTableMarkers(manifest);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push("report full-table markers do not exactly match render-manifest.json");
  }
  return errors;
}

export function validateDesignInputBinding(input, binding, { sessionDir, markdownPath, contentPath } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["report/design-input.json must contain an object document"];
  }
  if (input.producer !== "compile-report-content.mjs") {
    errors.push("report/design-input.json producer must be compile-report-content.mjs");
  }
  if (sessionDir && input.sessionDir !== sessionDir) errors.push("report/design-input.json sessionDir mismatch");
  if (markdownPath && input.markdownPath !== markdownPath) errors.push("report/design-input.json markdownPath mismatch");
  if (contentPath && input.contentPath !== contentPath) errors.push("report/design-input.json contentPath mismatch");
  for (const key of ["title", "markdownSha256", "contentSha256", "contentFileSha256"]) {
    if (input[key] !== binding[key]) errors.push(`report/design-input.json ${key} mismatch`);
  }
  if (JSON.stringify(input.fullTableMarkers) !== JSON.stringify(binding.fullTableMarkers)) {
    errors.push("report/design-input.json fullTableMarkers mismatch");
  }
  return errors;
}
