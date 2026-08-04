import { delimiter, join } from "node:path";

export const AUTHZ_BINDING_ENV = "HARNESS_AUTHZ_BINDING_V1";

const FORBIDDEN_QDM_ENV = [
  "QDM_CMR_CLI",
  "QDM_SQL_CLI",
  "QDM_CAS_CLI",
  "QDM_CAS_CONFIG_DIR",
];

// The authz scope enforcement (manageAreaId / sapArea2Id / dcManageAreaId /
// categoryLevel1Id, including the sapArea2Id→manageAreaIds mapping) lives in
// the qdm-metric-cli wrapper (cli/internal/metriccli/authorized.go), which
// execs qdm-metric-cli-real only after validation. An agent that invokes
// qdm-metric-cli-real directly bypasses every scope check, so a requester
// can read data for areas/categories outside their authorization. Block direct
// invocations and force the agent to re-issue via the qdm-metric-cli wrapper.
const FORBIDDEN_REAL_BINARY = "qdm-metric-cli-real";
const FORBIDDEN_AUTHZ_BIND = "authz-bind";
const FORBIDDEN_REAL_MESSAGE =
  "直接调用 " +
  FORBIDDEN_REAL_BINARY +
  " 被禁止：它绕过 requester 权限校验（scope enforcement 在 qdm-metric-cli 包装器内，exec real 前先校验）。" +
  "请改用 qdm-metric-cli 包装器发起同样的查询（例如 bin/qdm-metric-cli 或 $QDM_METRIC_CLI），" +
  "可先 qdm-metric-cli --help 确认子命令与参数。";
const FORBIDDEN_AUTHZ_BIND_MESSAGE =
  "直接调用 authz-bind 被禁止：它会暴露可执行授权 binding material。" +
  "请求者授权由 Pi 扩展在模型上下文外自动绑定；请直接使用 qdm-metric-cli 包装器查询。";

export function buildRejectedCommand(message) {
  return "printf '%s\\n' " + JSON.stringify(message) + " 1>&2; exit 9";
}

export function commandReferencesRealBinary(params) {
  const commandText = String(params?.command ?? "");
  const blob = commandText || JSON.stringify(params ?? {});
  return blob.includes(FORBIDDEN_REAL_BINARY);
}

export function commandReferencesAuthzBind(params) {
  const commandText = String(params?.command ?? "");
  const blob = commandText || JSON.stringify(params ?? {});
  return blob.includes(FORBIDDEN_AUTHZ_BIND);
}

function invocationCwd(ctx, fallback) {
  return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : fallback;
}

export function registerAuthzBashOverride(pi, options) {
  const { createBashTool, stateStore } = options;
  const fallbackCwd = options.cwd || process.cwd();
  const publicBinDir = join(options.projectRoot, "bin");
  const publicMetricCLI = join(options.projectRoot, "bin", "qdm-metric-cli");
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
          const pathEntries = String(childEnv.PATH || "")
            .split(delimiter)
            .filter((entry) => entry && entry !== publicBinDir);
          childEnv.PATH = [publicBinDir, ...pathEntries].join(delimiter);
          childEnv.QDM_METRIC_CLI = publicMetricCLI;
          for (const name of FORBIDDEN_QDM_ENV) delete childEnv[name];
          if (bindingBase64url) childEnv[AUTHZ_BINDING_ENV] = bindingBase64url;
          else delete childEnv[AUTHZ_BINDING_ENV];
          return { command, cwd, env: childEnv };
        },
      });

      // Block direct qdm-metric-cli-real invocation so the agent cannot bypass
      // the qdm-metric-cli wrapper's scope enforcement. Fail closed.
      if (commandReferencesRealBinary(params)) {
        try {
          return await tool.execute(
            toolCallId,
            { ...params, command: buildRejectedCommand(FORBIDDEN_REAL_MESSAGE) },
            signal,
            onUpdate,
          );
        } finally {
          stateStore.clearToolCall(toolCallId);
        }
      }

      // authz-bind is an extension-internal operation. If the model invokes it
      // through Bash, its stdout can enter the transcript and leak executable
      // binding material. Fail closed and keep binding injection out of model
      // context.
      if (commandReferencesAuthzBind(params)) {
        try {
          return await tool.execute(
            toolCallId,
            { ...params, command: buildRejectedCommand(FORBIDDEN_AUTHZ_BIND_MESSAGE) },
            signal,
            onUpdate,
          );
        } finally {
          stateStore.clearToolCall(toolCallId);
        }
      }

      try {
        return await tool.execute(toolCallId, params, signal, onUpdate);
      } finally {
        stateStore.clearToolCall(toolCallId);
      }
    },
  });
}
