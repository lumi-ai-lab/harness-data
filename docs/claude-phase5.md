# Claude Phase 5 验收历史记录

记录日期：2026-08-29

> 历史归档。Claude 适配验证不属于当前 Codex Plugin 用户发布渠道；当前产品安装和发布方式见 `README.md`。

## 已完成的仓库级验证

- Claude 原生插件 manifest 已补齐：`.claude-plugin/plugin.json`，可通过 `claude plugin validate .agents/claude`。
- Claude hooks 已迁移到标准 `hooks/hooks.json`，命令使用 `${CLAUDE_PLUGIN_ROOT}/scripts/data-harness-cli`，不再依赖项目目录或构建机路径。
- host artifact 构建会绑定请求的 plugin version，并包含 artifact 内的 `scripts/data-harness-cli` wrapper。
- `node --test scripts/host-artifact.test.mjs scripts/verify-artifact.test.mjs` 已通过；测试会构建七宿主 artifact、执行 wrapper `--help`，并对 Claude wrapper 执行普通 prompt hook no-op。
- 新增 `scripts/build-claude-marketplace.mjs`，把通用 Claude artifact 展平为可直接被 Claude Code marketplace 发现和安装的原生目录，并补齐根目录 `.claude-plugin/plugin.json`、`hooks/hooks.json`、wrapper、vendor core 和 marketplace manifest。
- 已在真实 Claude CLI `2.1.251` 上用临时本地 marketplace 完成一次 discovery/install/enable/disable/enable smoke；由于当前 profile 未登录，尚未执行需要模型会话的 hook、报告、secret provider 和 reload 验收。

## 当前仍需真实 Claude Code 证据

以下项目不能由静态验证或 fixture 代替：

- marketplace/discovery、install、enablement；
- 真实 `CLAUDE_PROJECT_DIR`/workspace handoff；
- 生产 secret provider handoff；
- clean uninstall/reinstall、升级和回滚；
- reload/new-session 后 hooks、skills、session state 恢复；
- pluginRoot 只读、dataRoot 可写条件下的真实报告流程。

在真实 Claude profile 和可用 secret provider 到位前，不把本次仓库级补强或 `claude plugin validate` / artifact self-test 标记为 Phase 5 完成。
