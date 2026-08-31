import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pluginRoot));

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function kernelCandidates(rel) {
  return [
    join(pluginRoot, "dist", "html-report-kernel", "src", rel),
    join(repoRoot, "packages", "html-report-kernel", "src", rel),
  ];
}

function runtimeCandidates(rel) {
  return [
    join(pluginRoot, "dist", "harness-runtime-node", "src", rel),
    join(repoRoot, "packages", "harness-runtime-node", "src", rel),
  ];
}

export function resolveKernelPath(rel) {
  const found = firstExisting(kernelCandidates(rel));
  if (!found) throw new Error(`html-report kernel module not found: ${rel}`);
  return found;
}

export function resolveRuntimePath(rel) {
  const found = firstExisting(runtimeCandidates(rel));
  if (!found) throw new Error(`harness runtime module not found: ${rel}`);
  return found;
}

export function kernelSource() {
  const kernel = resolveKernelPath("index.mjs");
  return kernel.includes(`${join("dist", "html-report-kernel")}`) ? "dist" : "packages";
}

export async function loadKernel(rel) {
  return import(pathToFileURL(resolveKernelPath(rel)).href);
}

export async function loadRuntime(rel) {
  return import(pathToFileURL(resolveRuntimePath(rel)).href);
}
