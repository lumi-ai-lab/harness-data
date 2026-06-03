import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8"));
  return pkg.version;
}
