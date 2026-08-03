#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const generatedFrom = "qdm-metric-cli-v0.1.0-contract";
const protectedDimensions = ["manageAreaId", "categoryLevel1Id"];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--registry-release" && argument !== "--output") {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!options.registryRelease) {
    throw new Error("--registry-release is required");
  }
  return options;
}

function validateCode(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[,=:]/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

export function generateApprovedMetricCatalog(release) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("registry release must be an object");
  }
  if (!release.metrics || typeof release.metrics !== "object" || Array.isArray(release.metrics)) {
    throw new Error("registry release metrics must be an object");
  }
  const effectiveDimensions = release.compiled?.effectiveDimensions;
  if (
    effectiveDimensions !== undefined &&
    (!effectiveDimensions ||
      typeof effectiveDimensions !== "object" ||
      Array.isArray(effectiveDimensions))
  ) {
    throw new Error("registry release compiled effectiveDimensions must be an object");
  }

  const metrics = {};
  for (const code of Object.keys(release.metrics).sort()) {
    validateCode(code, "metric code");
    const metric = release.metrics[code];
    if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
      throw new Error(`metric ${code} must be an object`);
    }
    if (metric.code !== code) {
      throw new Error(`metric ${code} code does not match its registry key`);
    }
    if (metric.status !== "published") {
      continue;
    }
    const supportedDimensions =
      metric.supportedDimensions ?? effectiveDimensions?.[code];
    if (!Array.isArray(supportedDimensions)) {
      throw new Error(`metric ${code} supportedDimensions must be an array`);
    }

    const dimensions = [];
    const seen = new Set();
    for (const dimension of supportedDimensions) {
      validateCode(dimension, `metric ${code} dimension`);
      if (seen.has(dimension)) {
        throw new Error(`metric ${code} contains duplicate dimension ${dimension}`);
      }
      seen.add(dimension);
      dimensions.push(dimension);
    }
    if (!protectedDimensions.every((dimension) => seen.has(dimension))) {
      continue;
    }

    metrics[code] = {
      supportedDimensions: dimensions,
      dictionaryRefs: []
    };
  }

  if (Object.keys(metrics).length === 0) {
    throw new Error("registry release contains no metrics compatible with the authorization scope");
  }
  return {
    version: 1,
    generatedFrom,
    metrics
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const registryPath = path.resolve(options.registryRelease);
  const outputPath = path.resolve(
    options.output ||
      path.join(path.dirname(fileURLToPath(import.meta.url)), "approved-metrics-v1.json")
  );
  const release = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const catalog = generateApprovedMetricCatalog(release);
  fs.writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`);
  process.stderr.write(
    `generated ${Object.keys(catalog.metrics).length} approved metrics from ${registryPath}\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
