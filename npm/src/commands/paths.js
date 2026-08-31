import { publicRootContext, resolveRootContext } from "../lib/root-context.js";

export function pathsCommand(options = {}, io = process) {
  const context = resolveRootContext(options, { env: io.env || process.env, requirePluginRoot: false });
  const report = {
    ...publicRootContext(context),
    roots: {
      pluginRoot: context.pluginRoot,
      resourceRoot: context.resourceRoot,
      dataRoot: context.dataRoot,
      secretRoot: context.secretRoot,
      workspaceRoot: context.workspaceRoot,
      stateRoot: context.stateRoot,
      workspacePolicyPath: context.workspacePolicyPath,
    },
  };
  const output = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : Object.entries(report.roots).map(([name, value]) => `${name}\t${value || ""}`).join("\n") + "\n";
  (io.stdout || process.stdout).write(output);
  return report;
}
