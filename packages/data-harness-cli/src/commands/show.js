import { ExitError } from "../lib/exit.js";
import { parseFlags } from "../lib/flags.js";
import { printJSON } from "../lib/json-out.js";
import { loadCorpus } from "../lib/wikis/parse.js";
import { loadIndex, loadRuntimeIndex } from "../lib/wikis/index.js";

export async function runShow(root, args, io = process) {
  const parsed = parseFlags(args, { json: { type: "boolean", default: false } });
  const rest = parsed.rest.filter((arg) => {
    if (arg === "--json") {
      parsed.values.json = true;
      return false;
    }
    return true;
  });
  if (rest.length !== 1) throw new ExitError("show requires id or path");
  const doc = findShowDocument(root, rest[0]);
  if (!doc) throw new ExitError(`not found: ${rest[0]}`);
  if (parsed.values.json) {
    printJSON(doc.payload, io.stdout);
    return;
  }
  io.stdout.write(`${doc.id}\t${doc.kind}\t${doc.path}\n`);
}

export function findShowDocument(root, key) {
  try {
    const index = loadIndex(root);
    for (const doc of index.docs || []) {
      if (showKeyMatches(doc.id, doc.path, key)) {
        return { id: doc.id, kind: doc.kind, path: doc.path, payload: doc };
      }
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  try {
    const runtime = loadRuntimeIndex(root);
    for (const doc of Object.values(runtime.docsByPath || {})) {
      const id = String(doc.path || "").replace(/\.md$/, "");
      if (showKeyMatches(id, doc.path, key)) {
        return { id, kind: doc.kind, path: doc.path, payload: doc };
      }
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const { corpus } = loadCorpus(root);
  for (const doc of corpus.docs) {
    if (showKeyMatches(doc.id, doc.path, key)) {
      return { id: doc.id, kind: doc.kind, path: doc.path, payload: doc };
    }
  }
  return null;
}

function showKeyMatches(id, logicalPath, key) {
  return showKeyCandidates(key).some((candidate) => candidate === id || candidate === logicalPath);
}

function showKeyCandidates(key) {
  const cleaned = String(key || "").trim().replaceAll("\\", "/");
  if (!cleaned || cleaned === ".") return [];
  const candidates = [cleaned];
  for (const prefix of ["./", "wikis/"]) {
    if (cleaned.startsWith(prefix)) candidates.push(cleaned.slice(prefix.length));
  }
  return [...new Set(candidates)];
}
