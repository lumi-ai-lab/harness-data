import fs from "node:fs";
import path from "node:path";
import { findWorkspaceDir } from "../lib/paths.js";
import { packageVersion } from "../lib/package.js";
import { binaryName } from "../lib/platform.js";
import { blank, header, ok, step } from "../lib/log.js";
import { configureCasAuthentication, configureTokens } from "./install.js";

const requiredBinaries = ["cas-cli", "qdm-cmr-cli", "qdm-indicators-cli", "qdm-sql-cli"];

function validateAuthRuntime(runtimeDir) {
  if (!fs.existsSync(runtimeDir)) throw new Error(`runtime directory does not exist: ${runtimeDir}`);
  for (const name of requiredBinaries) {
    const file = path.join(runtimeDir, "bin", binaryName(name));
    if (!fs.existsSync(file)) throw new Error(`runtime CLI is missing: ${file}`);
  }
}

export async function authCommand(options = {}) {
  const runtimeDir = findWorkspaceDir(options.dir);
  validateAuthRuntime(runtimeDir);
  header("Harness Data 认证配置", packageVersion(), [`运行目录：${runtimeDir}`]);

  step(1, 2, "配置 CAS 凭证");
  const casDir = await configureCasAuthentication(runtimeDir, options);
  blank();

  step(2, 2, "刷新并校验访问 Token");
  await configureTokens(runtimeDir, casDir);
  blank();

  ok("CAS 认证配置完成");
  return { runtimeDir, casDir };
}
