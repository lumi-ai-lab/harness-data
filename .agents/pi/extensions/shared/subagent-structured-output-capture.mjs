/**
 * Fail-closed bridge for a validated domain tool to complete pi-subagents'
 * structured-output contract without asking the model to copy the same object
 * in a second turn.
 *
 * The runtime paths are parent-owned environment values. They are never
 * accepted from model tool arguments.
 */
import { lstatSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";

function canonicalAbsolute(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    isAbsolute(value) && resolve(value) === value;
}

function assertMissing(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("structured output capture already exists");
}

/** Validate the private runtime before any business artifact is written. */
export async function prepareStructuredOutputCapture(expectedSchema, env = process.env) {
  const schemaPath = env[STRUCTURED_OUTPUT_SCHEMA_ENV];
  const outputPath = env[STRUCTURED_OUTPUT_CAPTURE_ENV];
  if (!canonicalAbsolute(schemaPath) || !canonicalAbsolute(outputPath)) {
    throw new Error("pi-subagents structured output runtime paths are unavailable or non-canonical");
  }
  if (
    dirname(schemaPath) !== dirname(outputPath) ||
    basename(schemaPath) !== "schema.json" ||
    basename(outputPath) !== "output.json"
  ) {
    throw new Error("pi-subagents structured output runtime paths do not form one schema/capture pair");
  }
  const schemaStat = lstatSync(schemaPath);
  if (!schemaStat.isFile() || schemaStat.isSymbolicLink()) {
    throw new Error("pi-subagents structured output schema must be a regular file");
  }
  let actualSchema;
  try {
    actualSchema = JSON.parse(await readFile(schemaPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read pi-subagents structured output schema: ${error.message || error}`);
  }
  if (!isDeepStrictEqual(actualSchema, expectedSchema)) {
    throw new Error("pi-subagents structured output schema does not match the current child contract");
  }
  assertMissing(outputPath);
  return { schemaPath, outputPath };
}

/** Exclusively capture the already validated value; pi-subagents revalidates it on exit. */
export async function writeStructuredOutputCapture(runtime, value) {
  if (!runtime || !canonicalAbsolute(runtime.outputPath)) {
    throw new Error("structured output capture runtime is invalid");
  }
  await writeFile(runtime.outputPath, JSON.stringify(value), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return runtime.outputPath;
}
