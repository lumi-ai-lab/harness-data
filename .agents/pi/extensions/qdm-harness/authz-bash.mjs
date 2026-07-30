import { join } from "node:path";

export const AUTHZ_BINDING_ENV = "HARNESS_AUTHZ_BINDING_V1";

const FORBIDDEN_QDM_ENV = [
  "QDM_CMR_CLI",
  "QDM_SQL_CLI",
  "QDM_CAS_CLI",
  "QDM_CAS_CONFIG_DIR",
];

function invocationCwd(ctx, fallback) {
  return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : fallback;
}

export function registerAuthzBashOverride(pi, options) {
  const { createBashTool, stateStore } = options;
  const fallbackCwd = options.cwd || process.cwd();
  const publicFacade = join(options.projectRoot, "bin", "qdm-indicators-cli");
  const prototype = createBashTool(fallbackCwd);

  pi.registerTool({
    ...prototype,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Consume before constructing the per-invocation tool. No process-global
      // "current binding" exists, so concurrent calls cannot overwrite it.
      const bindingBase64url = stateStore.consumeToolCall(toolCallId);
      const tool = createBashTool(invocationCwd(ctx, fallbackCwd), {
        spawnHook: ({ command, cwd, env }) => {
          const childEnv = { ...env };
          childEnv.QDM_INDICATORS_CLI = publicFacade;
          for (const name of FORBIDDEN_QDM_ENV) delete childEnv[name];
          if (bindingBase64url) childEnv[AUTHZ_BINDING_ENV] = bindingBase64url;
          else delete childEnv[AUTHZ_BINDING_ENV];
          return { command, cwd, env: childEnv };
        },
      });

      try {
        return await tool.execute(toolCallId, params, signal, onUpdate);
      } finally {
        stateStore.clearToolCall(toolCallId);
      }
    },
  });
}
