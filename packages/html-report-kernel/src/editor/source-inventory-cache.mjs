/**
 * Packageable persistence contract for the B2.5 Editor source inventory.
 *
 * This intentionally lives in the report kernel rather than a PI skill
 * adapter: the persisted document is a deterministic session artifact and
 * must be available from every packaged runtime that executes research
 * evidence preparation.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Keep the on-disk envelope backward compatible with existing PI sessions.
export const EDITOR_SOURCE_INVENTORY_CACHE_VERSION = 1;
export const EDITOR_SOURCE_INVENTORY_CACHE_PRODUCER = "editor-plan-contract.mjs";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sourceInventoryPathFor(resultPath) {
  const absoluteResultPath = resolve(String(resultPath || ""));
  return {
    resultPath: absoluteResultPath,
    sourceInventoryPath: join(dirname(absoluteResultPath), "debug", "editor-planner", "source-inventory.json"),
  };
}

function confirmedResultSnapshot(resultPath) {
  const raw = readFileSync(resultPath, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`result.json must contain valid JSON: ${error.message || error}`);
  }
  if (!isPlainObject(value) || value.status !== "confirmed" || !Array.isArray(value.cards) || !value.cards.length) {
    throw new Error("result.json must be confirmed and contain a non-empty cards[]");
  }
  return { sha256: sha256Text(raw) };
}

function atomicWriteJsonSync(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/** Persist the source-fields inventory with a fingerprint of its result.json. */
export function persistEditorSourceInventory(resultPath, inventory) {
  const paths = sourceInventoryPathFor(resultPath);
  const result = confirmedResultSnapshot(paths.resultPath);
  if (!isPlainObject(inventory) || inventory.mode !== "source_fields" || !Array.isArray(inventory.sources)) {
    throw new Error("source inventory must be a source_fields document with sources[]");
  }
  const document = {
    version: EDITOR_SOURCE_INVENTORY_CACHE_VERSION,
    producer: EDITOR_SOURCE_INVENTORY_CACHE_PRODUCER,
    kind: "source_inventory",
    resultPath: paths.resultPath,
    resultSha256: result.sha256,
    inventory,
  };
  atomicWriteJsonSync(paths.sourceInventoryPath, document);
  return paths.sourceInventoryPath;
}
